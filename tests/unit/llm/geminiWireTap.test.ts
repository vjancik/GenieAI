import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatGoogle } from "@langchain/google/node";
import pino from "pino";
import { GeminiWireTap, installGeminiWireTap } from "../../../src/infrastructure/llm/debug/GeminiWireTap.ts";

const logger = pino({ level: "silent" });

const STREAM_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse";

const HELLO = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}]}\r\n\r\n';
const WORLD_STOP =
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":" world"}]},"finishReason":"STOP"}]}\r\n\r\n';

/** A streaming response that delivers each string as its own network chunk. */
function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" }, ...init });
}

function geminiRequest(body: unknown): Request {
    return new Request(STREAM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": "secret-key-value" },
        body: JSON.stringify(body),
    });
}

let directory: string;
let tempRoot: string;

beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "gemini-wire-tap-"));
    // A nested folder that doesn't exist yet, to verify the tap creates it.
    directory = path.join(tempRoot, "logs", "geminiWireTap");
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

async function captureFiles(): Promise<string[]> {
    return readdir(directory).catch(() => []);
}

describe("GeminiWireTap", () => {
    test("passes non-Gemini requests straight through without writing anything", async () => {
        const upstream = new Response("ok");
        const tap = new GeminiWireTap(async () => upstream, directory, logger);

        const response = await tap.fetch("https://example.com/");
        await tap.whenIdle();

        expect(response).toBe(upstream);
        expect(await captureFiles()).toEqual([]);
    });

    test("passes the body through unchanged and writes one labeled, redacted capture file", async () => {
        const tap = new GeminiWireTap(async () => sseResponse([HELLO, WORLD_STOP]), directory, logger);

        const response = await tap.fetch(geminiRequest({ contents: [{ parts: [{ inlineData: "A".repeat(5000) }] }] }));
        const body = await response.text();
        await tap.whenIdle();

        expect(body).toBe(HELLO + WORLD_STOP);
        const files = await captureFiles();
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f]{12}_gemini-test_OK\.log$/);

        const content = await readFile(path.join(directory, files[0] ?? ""), "utf8");
        expect(content).not.toContain("secret-key-value");
        expect(content).toContain("x-goog-api-key: [redacted]");
        expect(content).toContain("…(5000 chars)");
        expect(content).toContain(`=== RAW RESPONSE BODY (verbatim) ===\n${HELLO}${WORLD_STOP}`);
        expect(content).toContain('"finishReason": "STOP"');
    });

    test("labels the capture when the adapter drops an unterminated final event", async () => {
        const originalFetch = globalThis.fetch;
        // TYPE COERCION: the fake omits `preconnect`, which the tap only forwards.
        globalThis.fetch = (async (input: Request | string | URL) => {
            const url = input instanceof Request ? input.url : input.toString();
            // Anything else (e.g. LangSmith, if tracing is enabled in the environment) gets a quiet 404.
            return url.includes(":streamGenerateContent")
                ? sseResponse([HELLO, WORLD_STOP.slice(0, -2)])
                : new Response(null, { status: 404 });
        }) as unknown as typeof fetch;
        try {
            const tap = installGeminiWireTap(directory, logger);
            const model = new ChatGoogle({ model: "gemini-test", apiKey: "key", maxRetries: 0 });

            let text = "";
            for await (const chunk of await model.stream("hi")) text += chunk.text;
            await tap.whenIdle();

            // Documents the adapter behavior the label exists for: " world" and STOP never reach LangChain.
            expect(text).toBe("Hello");
            expect(await captureFiles()).toEqual([
                expect.stringMatching(/_gemini-test_ADAPTER-DROPPED-FINAL-EVENT\.log$/),
            ]);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("records a failed fetch and rethrows the original error", async () => {
        const failure = new TypeError("socket closed");
        const tap = new GeminiWireTap(
            async () => {
                throw failure;
            },
            directory,
            logger,
        );

        await expect(tap.fetch(geminiRequest({}))).rejects.toBe(failure);
        await tap.whenIdle();

        const files = await captureFiles();
        expect(files).toEqual([expect.stringMatching(/_FETCH-FAILED\.log$/)]);
        expect(await readFile(path.join(directory, files[0] ?? ""), "utf8")).toContain("socket closed");
    });

    test("labels a body the consumer cancelled", async () => {
        const tap = new GeminiWireTap(async () => sseResponse([HELLO, WORLD_STOP]), directory, logger);

        const response = await tap.fetch(geminiRequest({}));
        const reader = response.body?.getReader();
        await reader?.read();
        await reader?.cancel("done early");
        await tap.whenIdle();

        expect(await captureFiles()).toEqual([expect.stringMatching(/_CANCELLED\.log$/)]);
    });

    test("labels a stream that errors mid-read and propagates the error to the consumer", async () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(HELLO));
            },
            pull(controller) {
                controller.error(new Error("connection reset"));
            },
        });
        const tap = new GeminiWireTap(async () => new Response(body), directory, logger);

        const response = await tap.fetch(geminiRequest({}));
        await expect(response.text()).rejects.toThrow("connection reset");
        await tap.whenIdle();

        expect(await captureFiles()).toEqual([expect.stringMatching(/_STREAM-ERROR\.log$/)]);
    });

    test("keeps error responses readable for the adapter and labels them by status", async () => {
        const errorBody = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } });
        const tap = new GeminiWireTap(
            async () => new Response(errorBody, { status: 429, statusText: "Too Many Requests" }),
            directory,
            logger,
        );

        const response = await tap.fetch(geminiRequest({}));

        expect(response.status).toBe(429);
        expect(response.statusText).toBe("Too Many Requests");
        expect(await response.text()).toBe(errorBody);
        await tap.whenIdle();
        expect(await captureFiles()).toEqual([expect.stringMatching(/_HTTP-429\.log$/)]);
    });
});
