import { appendFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUIDv7 } from "bun";
import type { Logger } from "../../../application/types/Logger.ts";
import { analyzeGeminiCapture, type BodyOutcome } from "./geminiWireAnalysis.ts";

/** The subset of `fetch` the tap wraps; Bun-specific init options pass through untouched at runtime. */
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Gemini generate endpoints; capture group 1 is the model name. Everything else is passed straight through. */
const GEMINI_GENERATE_URL =
    /generativelanguage\.googleapis\.com\/.+\/models\/([^/:]+):(?:streamGenerateContent|generateContent)/;

/** Request strings longer than this (inline base64 media, thought signatures) are shortened in capture files. */
const MAX_REQUEST_STRING_CHARS = 300;

/** Chars of the raw body end repeated, JSON-escaped, in the summary so trailing `\r\n`s are visible. */
const TAIL_CHARS = 300;

const SECRET_HEADERS = new Set(["x-goog-api-key", "authorization"]);

/**
 * One capture file, written through an ordered queue so appends land in arrival order without
 * the response stream ever waiting on disk.
 *
 * The file starts under an `IN-PROGRESS` name and is renamed to its labels once the capture ends.
 * A file that stays `IN-PROGRESS` means the consumer stopped reading without cancelling the body,
 * or the process died mid-stream. Write failures are logged once and never reach the tapped request.
 */
class CaptureFile {
    private filePath: string;
    private queue: Promise<void> = Promise.resolve();
    private failed = false;
    private finished = false;
    private readonly settledResolvers = Promise.withResolvers<void>();

    /** Resolves once the capture has been finished and renamed (or writing failed). */
    readonly settled = this.settledResolvers.promise;

    constructor(
        private readonly directory: string,
        private readonly baseName: string,
        private readonly logger: Logger,
    ) {
        this.filePath = path.join(directory, `${baseName}_IN-PROGRESS.log`);
        // Created per capture rather than once at startup, so the folder being deleted while running is harmless.
        this.enqueue(() => mkdir(directory, { recursive: true }));
    }

    append(content: string | Uint8Array): void {
        this.enqueue(() => appendFile(this.filePath, content));
    }

    /**
     * Renames the file to carry its labels. Only the first call counts: a cancel racing a pending
     * read can end the same body twice.
     */
    finish(labels: readonly string[]): void {
        if (this.finished) return;
        this.finished = true;
        const finalPath = path.join(this.directory, `${this.baseName}_${labels.join("+")}.log`);
        this.enqueue(async () => {
            await rename(this.filePath, finalPath);
            this.filePath = finalPath;
        });
        void this.queue.then(this.settledResolvers.resolve);
    }

    private enqueue(operation: () => Promise<unknown>): void {
        this.queue = this.queue.then(async () => {
            if (this.failed) return;
            try {
                await operation();
            } catch (err) {
                this.failed = true;
                this.logger.warn({ err, path: this.filePath }, "Gemini wire tap could not write capture file");
            }
        });
    }
}

/** Everything the body tap needs to finish a capture once the body ends. */
interface BodyTapContext {
    capture: CaptureFile;
    status: number;
    isSse: boolean;
    /** `performance.now()` when the request was sent. */
    startedMs: number;
    logger: Logger;
}

/**
 * TEMPORARY DIAGNOSTIC: a `fetch` wrapper that writes every Gemini generate request and its raw
 * response body to its own file, before `@langchain/google` parses the SSE stream, so responses the
 * adapter mishandles can be told apart from ones Google or the transport actually cut short.
 *
 * File names are `<timestamp>_<id>_<model>_<labels>.log`; see `geminiWireAnalysis.ts` for the labels.
 * Response bodies are passed through byte-for-byte.
 */
export class GeminiWireTap {
    private readonly pendingCaptures = new Set<Promise<void>>();

    constructor(
        private readonly baseFetch: FetchFn,
        private readonly directory: string,
        private readonly logger: Logger,
    ) {}

    /** Drop-in replacement for `fetch`. */
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
        const url = input instanceof Request ? input.url : input.toString();
        const model = GEMINI_GENERATE_URL.exec(url)?.[1];
        if (model === undefined) return this.baseFetch(input, init);

        const startedAt = new Date();
        const startedMs = performance.now();
        const baseName = [
            startedAt.toISOString().replace(/[:.]/g, "-"),
            randomUUIDv7().slice(-12),
            model.replace(/[^\w.-]/g, "_"),
        ].join("_");
        const capture = new CaptureFile(this.directory, baseName, this.logger);
        this.track(capture);

        const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
        capture.append(
            formatSection("GEMINI WIRE TAP", `started at: ${startedAt.toISOString()}\nurl: ${url}\n`) +
                formatSection("REQUEST HEADERS", formatHeaders(headers, true)) +
                formatSection(
                    `REQUEST BODY (strings over ${MAX_REQUEST_STRING_CHARS} chars shortened)`,
                    await readRequestBody(input, init),
                ),
        );

        let response: Response;
        try {
            response = await this.baseFetch(input, init);
        } catch (err) {
            capture.append(
                formatSection(
                    "FETCH FAILED",
                    `after: ${Math.round(performance.now() - startedMs)} ms\n${formatError(err)}\n`,
                ),
            );
            capture.finish(["FETCH-FAILED"]);
            throw err;
        }

        const responseSection = formatSection(
            `RESPONSE ${response.status} ${response.statusText} (headers after ${Math.round(performance.now() - startedMs)} ms)`,
            formatHeaders(response.headers, false),
        );
        // Not a formatSection: the raw body follows verbatim, with no trailing newline added after it.
        capture.append(`${responseSection}=== RAW RESPONSE BODY (verbatim) ===\n`);

        const context: BodyTapContext = {
            capture,
            status: response.status,
            isSse: url.includes("alt=sse"),
            startedMs,
            logger: this.logger,
        };
        if (!response.body) {
            finishCapture(context, "", [], "done");
            return response;
        }

        return new Response(tapBody(response.body, context), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }

    /**
     * Resolves once every capture started so far has been written and renamed.
     * Captures whose bodies are still being read (or were abandoned) keep it pending.
     */
    async whenIdle(): Promise<void> {
        await Promise.all(this.pendingCaptures);
    }

    private track(capture: CaptureFile): void {
        this.pendingCaptures.add(capture.settled);
        void capture.settled.then(() => this.pendingCaptures.delete(capture.settled));
    }
}

/**
 * Replaces `globalThis.fetch` with a {@link GeminiWireTap}. `@langchain/google` resolves `fetch`
 * from the global scope on every request, so no model construction needs to change.
 *
 * @param directory - Folder capture files are written to; created on demand
 * @param logger - Receives the tap's own write failures, not the captured traffic
 * @returns The installed tap
 */
export function installGeminiWireTap(directory: string, logger: Logger): GeminiWireTap {
    const originalFetch = globalThis.fetch;
    const tap = new GeminiWireTap(originalFetch, directory, logger);
    globalThis.fetch = Object.assign(tap.fetch.bind(tap), {
        // The fetch being wrapped may itself be a wrapper (e.g. Sentry's) without Bun's `preconnect`.
        preconnect: (...args: Parameters<typeof fetch.preconnect>) => originalFetch.preconnect?.(...args),
    });
    return tap;
}

/**
 * Wraps a response body so every chunk is appended to the capture as it passes through unchanged,
 * and the capture is finished however reading ends: cleanly, with an error, or by cancellation.
 */
function tapBody(body: ReadableStream<Uint8Array>, context: BodyTapContext): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const chunkTimings: string[] = [];
    let raw = "";

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            let result: Awaited<ReturnType<typeof reader.read>>;
            try {
                result = await reader.read();
            } catch (err) {
                finishCapture(context, raw + decoder.decode(), chunkTimings, "error", err);
                controller.error(err);
                return;
            }

            if (result.done) {
                finishCapture(context, raw + decoder.decode(), chunkTimings, "done");
                controller.close();
                return;
            }

            raw += decoder.decode(result.value, { stream: true });
            chunkTimings.push(`+${Math.round(performance.now() - context.startedMs)} ms  ${result.value.byteLength} B`);
            context.capture.append(result.value);
            controller.enqueue(result.value);
        },
        async cancel(reason) {
            finishCapture(context, raw + decoder.decode(), chunkTimings, "cancelled", reason);
            await reader.cancel(reason);
        },
    });
}

/** Appends the summary and chunk timings, then renames the capture after its labels. Never throws. */
function finishCapture(
    context: BodyTapContext,
    raw: string,
    chunkTimings: readonly string[],
    outcome: BodyOutcome,
    reason?: unknown,
): void {
    try {
        const analysis = analyzeGeminiCapture({ status: context.status, isSse: context.isSse, raw, outcome });
        const summary = {
            labels: analysis.labels,
            outcome,
            ...(reason !== undefined && { reason: formatError(reason) }),
            httpStatus: context.status,
            finishReason: analysis.finishReason,
            eventCount: analysis.eventCount,
            lastEventTerminated: analysis.lastEventTerminated,
            textChars: analysis.textChars,
            thoughtChars: analysis.thoughtChars,
            anomalies: analysis.anomalies,
            bodyChars: raw.length,
            chunks: chunkTimings.length,
            elapsedMs: Math.round(performance.now() - context.startedMs),
            tail: raw.slice(-TAIL_CHARS),
        };
        context.capture.append(
            "\n\n" +
                formatSection("SUMMARY", `${JSON.stringify(summary, null, 2)}\n`) +
                formatSection("CHUNK TIMINGS (since request start)", `${chunkTimings.join("\n")}\n`),
        );
        context.capture.finish(analysis.labels);
    } catch (err) {
        context.logger.warn({ err }, "Gemini wire tap could not summarize capture");
        context.capture.finish(["TAP-FAILED"]);
    }
}

/** Reads the request body without consuming it, pretty-printed with long strings shortened. */
async function readRequestBody(input: string | URL | Request, init: RequestInit | undefined): Promise<string> {
    let text: string;
    try {
        text = input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "";
    } catch (err) {
        return `(unreadable: ${formatError(err)})\n`;
    }
    try {
        return `${JSON.stringify(JSON.parse(text), shortenLongStrings, 2)}\n`;
    } catch {
        return `${shortenLongStrings("", text)}\n`;
    }
}

/** `JSON.stringify` replacer that keeps multi-megabyte inline media out of capture files. */
function shortenLongStrings(_key: string, value: unknown): unknown {
    return typeof value === "string" && value.length > MAX_REQUEST_STRING_CHARS
        ? `${value.slice(0, MAX_REQUEST_STRING_CHARS)}…(${value.length} chars)`
        : value;
}

function formatHeaders(headers: Headers, redactSecrets: boolean): string {
    let text = "";
    headers.forEach((value, name) => {
        text += `${name}: ${redactSecrets && SECRET_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value}\n`;
    });
    return text;
}

function formatSection(title: string, body: string): string {
    return `=== ${title} ===\n${body}\n`;
}

function formatError(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const cause = error.cause === undefined ? "" : `\ncause: ${formatError(error.cause)}`;
    return `${error.stack ?? `${error.name}: ${error.message}`}${cause}`;
}
