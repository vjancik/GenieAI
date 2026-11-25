import type { File as GenaiFile, GoogleGenAIOptions, UploadFileConfig } from "@google/genai";
import { GoogleGenAI } from "@google/genai";
import { type RetryOptions, retriesNote, retryWithBackoff } from "../../application/services/retryWithBackoff.ts";
import { AppError, GeminiUploadHttpError } from "../../domain/errors/AppError.ts";

const GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com";
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB — matches SDK default

/** Retry policy for transient upload failures: 3 retries, waiting 1 s, 2 s and 4 s. */
const UPLOAD_RETRY_OPTIONS: RetryOptions = { maxRetries: 3, initialDelayMs: 1000 };

export interface UploadStreamConfig extends Pick<UploadFileConfig, "name" | "mimeType" | "displayName"> {
    /** Total byte length of the stream — required by the resumable upload protocol. */
    byteLength: number;
}

/**
 * True when a failed upload response may succeed if the same request is sent again: request
 * timeout (408) and server errors (5xx). Other client errors are final for the request, and a
 * rejected or rate-limited API key (401, 402, 403, 429) in particular must surface immediately
 * so that the caller can rotate to another key instead of waiting out the backoff.
 */
function isRetryableUploadStatus(status: number): boolean {
    return status === 408 || status >= 500;
}

/**
 * Thrown when an upload chunk is answered with an OK response that lacks the
 * `x-goog-upload-status` header, i.e. the server did not acknowledge the chunk. Retryable.
 */
class UploadNotAcknowledgedError extends AppError {
    constructor(message: string) {
        super("GEMINI_UPLOAD_FAILED", message);
    }
}

/** True for an upload failure worth sending the same request again (see {@link isRetryableUploadStatus}). */
function isRetryableUploadError(err: unknown): boolean {
    if (err instanceof UploadNotAcknowledgedError) return true;
    return err instanceof GeminiUploadHttpError && isRetryableUploadStatus(err.status);
}

// Implementation methods were hoisted to module level for easier testing

/**
 * Step 1 of the resumable upload protocol: POST to the Files API to create a
 * session. Returns the `x-goog-upload-url` for the actual data transfer.
 */
export async function initiateResumableUpload(apiKey: string, config: UploadStreamConfig): Promise<string> {
    const fileMetadata: Record<string, string | undefined> = {
        mimeType: config.mimeType,
        displayName: config.displayName,
    };

    // Normalise name: SDK requires "files/<id>" prefix
    if (config.name) {
        fileMetadata.name = config.name.startsWith("files/") ? config.name : `files/${config.name}`;
    }

    const url = `${GEMINI_UPLOAD_BASE}/upload/v1beta/files?key=${apiKey}`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(config.byteLength),
            "X-Goog-Upload-Header-Content-Type": config.mimeType ?? "application/octet-stream",
        },
        body: JSON.stringify({ file: fileMetadata }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new GeminiUploadHttpError(
            `Gemini resumable upload initiation failed (${response.status}): ${body}`,
            response.status,
            body,
        );
    }

    const uploadUrl = response.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
        throw new AppError(
            "GEMINI_UPLOAD_FAILED",
            "Gemini did not return x-goog-upload-url in resumable upload initiation response",
        );
    }

    return uploadUrl;
}

/**
 * Single-request upload for files at or below {@link UPLOAD_CHUNK_SIZE}.
 *
 * Skips the resumable protocol entirely. Buffers the stream into a `Uint8Array`
 * first (safe under 8 MB) so the body can be retried with exponential backoff
 * on transient failures (see {@link isRetryableUploadStatus}).
 *
 * @param retryOptions - Retry policy for transient failures; overridable for tests
 * @throws {GeminiUploadHttpError} immediately on a non-retryable response, or once the retries
 *         for a retryable one are used up
 */
export async function uploadStreamSingleRequest(
    apiKey: string,
    stream: ReadableStream<Uint8Array>,
    config: UploadStreamConfig,
    retryOptions: RetryOptions = UPLOAD_RETRY_OPTIONS,
): Promise<GenaiFile> {
    const fileMetadata: Record<string, string | undefined> = {
        mimeType: config.mimeType,
        displayName: config.displayName,
    };

    if (config.name) {
        fileMetadata.name = config.name.startsWith("files/") ? config.name : `files/${config.name}`;
    }

    const metadataJson = JSON.stringify({ file: fileMetadata });
    const boundary = "gemini_upload_boundary";

    // Buffer the full stream so the body can be resent on retry.
    const fileBytes = await new Response(stream).arrayBuffer();

    // Multipart body: metadata part + file bytes part, matching the single-request
    // upload format expected by the Files API.
    const nl = "\r\n";
    const metadataPart =
        `--${boundary}${nl}` + `Content-Type: application/json; charset=UTF-8${nl}${nl}` + `${metadataJson}${nl}`;
    const filePart = `--${boundary}${nl}` + `Content-Type: ${config.mimeType ?? "application/octet-stream"}${nl}${nl}`;
    const closing = `${nl}--${boundary}--`;

    const metadataPartBytes = new TextEncoder().encode(metadataPart);
    const filePartBytes = new TextEncoder().encode(filePart);
    const closingBytes = new TextEncoder().encode(closing);

    const body = new Uint8Array(
        metadataPartBytes.byteLength + filePartBytes.byteLength + fileBytes.byteLength + closingBytes.byteLength,
    );
    let offset = 0;
    body.set(metadataPartBytes, offset);
    offset += metadataPartBytes.byteLength;
    body.set(filePartBytes, offset);
    offset += filePartBytes.byteLength;
    body.set(new Uint8Array(fileBytes), offset);
    offset += fileBytes.byteLength;
    body.set(closingBytes, offset);

    const url = `${GEMINI_UPLOAD_BASE}/upload/v1beta/files?key=${apiKey}`;

    const send = async (retry: number) => {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": `multipart/related; boundary=${boundary}`,
                "X-Goog-Upload-Protocol": "multipart",
            },
            body,
        });

        if (response.ok) {
            // TYPE COERCION: the Files API answers a successful upload with the File resource under `file`
            const fileResource = (await response.json()) as { file: GenaiFile };
            return fileResource.file;
        }

        const text = await response.text();
        throw new GeminiUploadHttpError(
            `Gemini File API single request upload failed (${response.status})${retriesNote(retry)}: ${text}`,
            response.status,
            text,
        );
    };

    return retryWithBackoff(send, retryOptions, { isRetryable: isRetryableUploadError });
}

/**
 * Step 2 of the resumable upload protocol: read the stream in 8 MB chunks and
 * POST each to the upload session URL with exponential-backoff retry.
 *
 * @param retryOptions - Retry policy for transient chunk failures; overridable for tests
 * @throws {GeminiUploadHttpError} when a chunk is answered with a non-OK response that is not
 *         worth retrying (see {@link isRetryableUploadStatus}) or that outlasts the retries
 */
export async function uploadStreamChunked(
    stream: ReadableStream<Uint8Array>,
    uploadUrl: string,
    retryOptions: RetryOptions = UPLOAD_RETRY_OPTIONS,
): Promise<GenaiFile> {
    const reader = stream.getReader();
    // Pre-allocate one fixed 8 MB buffer reused across all chunks.
    const buffer = new Uint8Array(UPLOAD_CHUNK_SIZE);
    let filled = 0; // bytes written into buffer for the current chunk
    let offset = 0; // total bytes confirmed sent (for X-Goog-Upload-Offset)
    let streamDone = false;
    // Carries bytes from a stream read that overflowed the current chunk boundary.
    let leftover: Uint8Array | null = null;
    let lastResponse: Response | null = null;

    while (!streamDone || filled > 0) {
        // Fill buffer up to UPLOAD_CHUNK_SIZE, consuming leftover first then the stream.
        while (!streamDone && filled < UPLOAD_CHUNK_SIZE) {
            let incoming: Uint8Array | null;
            if (leftover !== null) {
                incoming = leftover;
            } else {
                const result = await reader.read();
                incoming = result.done ? null : result.value;
            }
            leftover = null;

            if (incoming === null) {
                streamDone = true;
                break;
            }

            // Skip zero-length chunks — some stream implementations (e.g. Bun's native
            // byte stream) may emit empty reads before signalling done at EOF.
            if (incoming.length === 0) continue;

            const space = UPLOAD_CHUNK_SIZE - filled;
            if (incoming.length <= space) {
                buffer.set(incoming, filled);
                filled += incoming.length;
            } else {
                // Incoming overflows — copy what fits, stash the rest for next chunk.
                buffer.set(incoming.subarray(0, space), filled);
                filled += space;
                leftover = incoming.subarray(space);
                break;
            }
        }

        if (filled === 0) break;

        const chunkSize = filled;
        filled = 0;
        const isLastChunk = streamDone && leftover === null;
        const uploadCommand = isLastChunk ? "upload, finalize" : "upload";

        const sendChunk = async (retry: number) => {
            const response = await fetch(uploadUrl, {
                method: "POST",
                headers: {
                    "Content-Length": String(chunkSize),
                    "X-Goog-Upload-Command": uploadCommand,
                    "X-Goog-Upload-Offset": String(offset),
                },
                body: buffer.subarray(0, chunkSize),
            });

            // x-goog-upload-status presence signals the server acknowledged the chunk
            if (response.headers.get("x-goog-upload-status")) return response;

            const attemptContext = `${retriesNote(retry)} at offset ${offset}`;
            if (response.ok) {
                throw new UploadNotAcknowledgedError(
                    `Gemini chunk upload failed${attemptContext}: the response lacks x-goog-upload-status`,
                );
            }
            const body = await response.text();
            throw new GeminiUploadHttpError(
                `Gemini chunk upload failed (${response.status})${attemptContext}: ${body}`,
                response.status,
                body,
            );
        };

        const chunkResponse = await retryWithBackoff(sendChunk, retryOptions, { isRetryable: isRetryableUploadError });

        lastResponse = chunkResponse;
        offset += chunkSize;

        if (chunkResponse.headers.get("x-goog-upload-status") !== "active") break;
    }

    if (!lastResponse) {
        throw new AppError("GEMINI_UPLOAD_FAILED", "Gemini stream upload failed: the stream had no content to upload");
    }
    if (!lastResponse.ok) {
        const body = await lastResponse.text();
        throw new GeminiUploadHttpError(
            `Gemini stream upload failed (${lastResponse.status}): ${body}`,
            lastResponse.status,
            body,
        );
    }

    // The final response body contains the completed File resource JSON
    const fileResource = (await lastResponse.json()) as { file: GenaiFile };
    return fileResource.file;
}

/**
 * Extends {@link GoogleGenAI} with a stream-based file upload method.
 *
 * The upstream SDK only accepts a file path or `Blob` for uploads. This subclass
 * adds `uploadStream()`, which drives the same Google resumable-upload protocol
 * directly via `fetch`, without buffering the entire file in memory first.
 *
 * All other `GoogleGenAI` functionality is unaffected — this class passes
 * through construction options unchanged.
 */
export class GoogleGenAIWithStreamingUpload extends GoogleGenAI {
    private readonly geminiApiKey: string;

    constructor(options: GoogleGenAIOptions & { apiKey: string }) {
        super(options);
        this.geminiApiKey = options.apiKey;
    }

    /**
     * Uploads a `ReadableStream<Uint8Array>` to the Gemini Files API using the
     * resumable upload protocol, without buffering the stream into memory.
     *
     * @param stream - The readable byte stream to upload.
     * @param config - Upload metadata including the required `byteLength`.
     * @returns Resolves to the completed `File` resource from Gemini.
     */
    async uploadStream(stream: ReadableStream<Uint8Array>, config: UploadStreamConfig): Promise<GenaiFile> {
        if (config.byteLength <= UPLOAD_CHUNK_SIZE) {
            return uploadStreamSingleRequest(this.geminiApiKey, stream, config);
        }
        const uploadUrl = await initiateResumableUpload(this.geminiApiKey, config);
        return uploadStreamChunked(stream, uploadUrl);
    }
}
