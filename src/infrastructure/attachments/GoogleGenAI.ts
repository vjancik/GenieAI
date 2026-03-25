import type { File as GenaiFile, GoogleGenAIOptions, UploadFileConfig } from "@google/genai";
import { GoogleGenAI } from "@google/genai";

const GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com";
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB — matches SDK default
const MAX_RETRY_COUNT = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const DELAY_MULTIPLIER = 2;

export interface UploadStreamConfig extends Pick<UploadFileConfig, "name" | "mimeType" | "displayName"> {
    /** Total byte length of the stream — required by the resumable upload protocol. */
    byteLength: number;
}

// Implementation methods were hoisted to module level for easier mocking

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
        throw new Error(`Gemini resumable upload initiation failed (${response.status}): ${body}`);
    }

    const uploadUrl = response.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
        throw new Error("Gemini did not return x-goog-upload-url in resumable upload initiation response");
    }

    return uploadUrl;
}

/**
 * Single-request upload for files at or below {@link UPLOAD_CHUNK_SIZE}.
 *
 * Skips the resumable protocol entirely — no session initiation, no upload
 * command/offset headers. The file body is streamed inline via `duplex: "half"`
 * with no intermediate buffer.
 */
export async function uploadStreamSingleShot(
    apiKey: string,
    stream: ReadableStream<Uint8Array>,
    config: UploadStreamConfig,
): Promise<GenaiFile> {
    const fileMetadata: Record<string, string | undefined> = {
        mimeType: config.mimeType,
        displayName: config.displayName,
    };

    if (config.name) {
        fileMetadata.name = config.name.startsWith("files/") ? config.name : `files/${config.name}`;
    }

    const url = `${GEMINI_UPLOAD_BASE}/upload/v1beta/files?key=${apiKey}`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": config.mimeType ?? "application/octet-stream",
            "X-Goog-Upload-Header-Content-Length": String(config.byteLength),
            "X-Goog-Upload-Header-Content-Type": config.mimeType ?? "application/octet-stream",
            "Content-Length": String(config.byteLength),
        },
        body: stream,
        duplex: "half",
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Gemini single-shot upload failed (${response.status}): ${body}`);
    }

    const fileResource = (await response.json()) as { file: GenaiFile };
    return fileResource.file;
}

/**
 * Step 2 of the resumable upload protocol: read the stream in 8 MB chunks and
 * POST each to the upload session URL with exponential-backoff retry.
 */
export async function uploadStreamChunked(stream: ReadableStream<Uint8Array>, uploadUrl: string): Promise<GenaiFile> {
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

        let retryCount = 0;
        let delayMs = INITIAL_RETRY_DELAY_MS;
        let chunkResponse: Response | null = null;

        while (retryCount <= MAX_RETRY_COUNT) {
            chunkResponse = await fetch(uploadUrl, {
                method: "POST",
                headers: {
                    "Content-Length": String(chunkSize),
                    "X-Goog-Upload-Command": uploadCommand,
                    "X-Goog-Upload-Offset": String(offset),
                },
                body: buffer.subarray(0, chunkSize),
            });

            // x-goog-upload-status presence signals the server acknowledged the chunk
            if (chunkResponse.headers.get("x-goog-upload-status")) break;

            retryCount++;
            if (retryCount > MAX_RETRY_COUNT) {
                throw new Error(`Gemini chunk upload failed after ${MAX_RETRY_COUNT} retries at offset ${offset}`);
            }
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            delayMs *= DELAY_MULTIPLIER;
        }

        lastResponse = chunkResponse;
        offset += chunkSize;

        if (chunkResponse?.headers.get("x-goog-upload-status") !== "active") break;
    }

    if (!lastResponse?.ok) {
        const body = await lastResponse?.text();
        throw new Error(`Gemini stream upload failed (${lastResponse?.status}): ${body}`);
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
            return uploadStreamSingleShot(this.geminiApiKey, stream, config);
        }
        const uploadUrl = await initiateResumableUpload(this.geminiApiKey, config);
        return uploadStreamChunked(stream, uploadUrl);
    }
}
