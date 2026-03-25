import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { UploadStreamConfig } from "../../../src/infrastructure/attachments/GoogleGenAI.ts";
import {
    initiateResumableUpload,
    uploadStreamChunked,
    uploadStreamSingleShot,
} from "../../../src/infrastructure/attachments/GoogleGenAI.ts";

const CHUNK_SIZE = 8 * 1024 * 1024; // must match UPLOAD_CHUNK_SIZE in source
const UPLOAD_SESSION_URL = "https://upload.googleapis.com/session/abc123";
const FILE_RESOURCE = { name: "files/test123", uri: "https://example.com/files/test123" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a ReadableStream that emits the provided chunks in order. */
function makeStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(chunks[i++]!);
            } else {
                controller.close();
            }
        },
    });
}

/** Returns a Uint8Array of `length` bytes all set to `value` (default 0xAB). */
function bytes(length: number, value = 0xab): Uint8Array {
    return new Uint8Array(length).fill(value);
}

/** Builds a minimal Response with the given headers and optional JSON body. */
function makeResponse(headers: Record<string, string>, body: unknown = null, status = 200): Response {
    return new Response(body !== null ? JSON.stringify(body) : null, { status, headers });
}

const initiationResponse = () => makeResponse({ "x-goog-upload-url": UPLOAD_SESSION_URL });
const activeChunkResponse = () => makeResponse({ "x-goog-upload-status": "active" });
const finalChunkResponse = () => makeResponse({ "x-goog-upload-status": "final" }, { file: FILE_RESOURCE });

const BASE_CONFIG: UploadStreamConfig = {
    name: "files/test123",
    mimeType: "image/png",
    displayName: "test.png",
    byteLength: 0,
};

type CapturedCall = {
    url: string;
    headers: Record<string, string>;
    /** Snapshot of the binary body (copied before the shared buffer is reused), or null. */
    body: Uint8Array | null;
    /** Raw body as received — use for non-binary bodies like JSON strings. */
    rawBody: unknown;
};

/** Installs a fetch spy that captures calls and serves queued responses. */
function mockFetch(responses: Response[]): CapturedCall[] {
    let i = 0;
    const calls: CapturedCall[] = [];

    // TYPE COERCION: Bun's fetch type includes a `preconnect` property not present in test doubles
    spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const headers = Object.fromEntries(new Headers(init?.headers as Record<string, string>).entries());
        const rawBody = init?.body;
        const body = rawBody instanceof Uint8Array ? rawBody.slice() : null;
        calls.push({ url, headers, body, rawBody });
        return responses[i++] ?? new Response("unexpected fetch call", { status: 500 });
    }) as unknown as typeof fetch);

    return calls;
}

// Capture setTimeout before any test mutations so afterEach can always restore it.
const originalSetTimeout = globalThis.setTimeout;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initiateResumableUpload", () => {
    test("POSTs to the correct URL with required headers", async () => {
        const calls = mockFetch([initiationResponse()]);

        await initiateResumableUpload("my-api-key", { ...BASE_CONFIG, byteLength: 512 });

        expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/upload/v1beta/files?key=my-api-key");
        expect(calls[0]!.headers["x-goog-upload-protocol"]).toBe("resumable");
        expect(calls[0]!.headers["x-goog-upload-command"]).toBe("start");
        expect(calls[0]!.headers["x-goog-upload-header-content-length"]).toBe("512");
        expect(calls[0]!.headers["x-goog-upload-header-content-type"]).toBe("image/png");
    });

    test("returns the upload URL from x-goog-upload-url header", async () => {
        mockFetch([initiationResponse()]);

        const url = await initiateResumableUpload("key", BASE_CONFIG);

        expect(url).toBe(UPLOAD_SESSION_URL);
    });

    test("normalises name without 'files/' prefix", async () => {
        const calls = mockFetch([initiationResponse()]);

        await initiateResumableUpload("key", { ...BASE_CONFIG, name: "my-uuid", byteLength: 10 });

        const body = JSON.parse(calls[0]!.rawBody as string) as { file: { name: string } };
        expect(body.file.name).toBe("files/my-uuid");
    });

    test("throws when response is not ok", async () => {
        mockFetch([new Response("Not Found", { status: 404 })]);

        await expect(initiateResumableUpload("key", BASE_CONFIG)).rejects.toThrow(
            "Gemini resumable upload initiation failed (404)",
        );
    });

    test("throws when x-goog-upload-url header is missing", async () => {
        mockFetch([makeResponse({})]);

        await expect(initiateResumableUpload("key", BASE_CONFIG)).rejects.toThrow(
            "Gemini did not return x-goog-upload-url",
        );
    });
});

describe("uploadStreamChunked", () => {
    beforeEach(() => {
        // Suppress retry delays
        // TYPE COERCION: Bun's setTimeout type includes __promisify__ not needed here
        globalThis.setTimeout = ((fn: () => void) => {
            fn();
            return 0;
        }) as unknown as typeof setTimeout;
    });

    afterEach(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    describe("single chunk", () => {
        test("sends one POST with 'upload, finalize' and returns the file resource", async () => {
            const calls = mockFetch([finalChunkResponse()]);

            const result = await uploadStreamChunked(makeStream(bytes(1024)), UPLOAD_SESSION_URL);

            expect(result).toEqual(FILE_RESOURCE);
            expect(calls).toHaveLength(1);
            expect(calls[0]!.headers["x-goog-upload-command"]).toBe("upload, finalize");
            expect(calls[0]!.headers["x-goog-upload-offset"]).toBe("0");
            expect(calls[0]!.headers["content-length"]).toBe("1024");
        });

        test("sends correct byte content", async () => {
            const calls = mockFetch([finalChunkResponse()]);

            const data = bytes(50, 0xff);
            await uploadStreamChunked(makeStream(data), UPLOAD_SESSION_URL);

            expect(calls[0]!.body).toEqual(data);
        });
    });

    describe("multi-chunk", () => {
        test("first chunk uses 'upload', last uses 'upload, finalize'", async () => {
            const calls = mockFetch([activeChunkResponse(), finalChunkResponse()]);

            await uploadStreamChunked(makeStream(bytes(CHUNK_SIZE, 0x01), bytes(512, 0x02)), UPLOAD_SESSION_URL);

            expect(calls).toHaveLength(2);
            expect(calls[0]!.headers["x-goog-upload-command"]).toBe("upload");
            expect(calls[0]!.headers["x-goog-upload-offset"]).toBe("0");
            expect(calls[0]!.headers["content-length"]).toBe(String(CHUNK_SIZE));
            expect(calls[1]!.headers["x-goog-upload-command"]).toBe("upload, finalize");
            expect(calls[1]!.headers["x-goog-upload-offset"]).toBe(String(CHUNK_SIZE));
            expect(calls[1]!.headers["content-length"]).toBe("512");
        });

        test("sends correct byte content per chunk", async () => {
            const calls = mockFetch([activeChunkResponse(), finalChunkResponse()]);

            const chunk1 = bytes(CHUNK_SIZE, 0x01);
            const chunk2 = bytes(512, 0x02);
            await uploadStreamChunked(makeStream(chunk1, chunk2), UPLOAD_SESSION_URL);

            expect(calls[0]!.body).toEqual(chunk1);
            expect(calls[1]!.body).toEqual(chunk2);
        });

        test("handles a stream read that straddles the chunk boundary", async () => {
            const calls = mockFetch([activeChunkResponse(), finalChunkResponse()]);

            const oversized = bytes(CHUNK_SIZE + 100, 0x03);
            await uploadStreamChunked(makeStream(oversized), UPLOAD_SESSION_URL);

            expect(calls).toHaveLength(2);
            expect(calls[0]!.headers["content-length"]).toBe(String(CHUNK_SIZE));
            expect(calls[0]!.headers["x-goog-upload-command"]).toBe("upload");
            expect(calls[0]!.body).toEqual(oversized.subarray(0, CHUNK_SIZE));

            expect(calls[1]!.headers["content-length"]).toBe("100");
            expect(calls[1]!.headers["x-goog-upload-command"]).toBe("upload, finalize");
            expect(calls[1]!.headers["x-goog-upload-offset"]).toBe(String(CHUNK_SIZE));
            expect(calls[1]!.body).toEqual(oversized.subarray(CHUNK_SIZE));
        });
    });

    describe("retry", () => {
        test("retries when x-goog-upload-status is absent, then succeeds", async () => {
            const calls = mockFetch([
                makeResponse({}), // attempt 1 — no status header
                makeResponse({}), // attempt 2
                finalChunkResponse(), // attempt 3 — succeeds
            ]);

            const result = await uploadStreamChunked(makeStream(bytes(100)), UPLOAD_SESSION_URL);

            expect(result).toEqual(FILE_RESOURCE);
            expect(calls).toHaveLength(3);
        });

        test("throws after MAX_RETRY_COUNT (3) failed attempts", async () => {
            mockFetch([makeResponse({}), makeResponse({}), makeResponse({}), makeResponse({})]);

            await expect(uploadStreamChunked(makeStream(bytes(100)), UPLOAD_SESSION_URL)).rejects.toThrow(
                "Gemini chunk upload failed after 3 retries",
            );
        });
    });

    describe("edge cases", () => {
        test("skips zero-length chunks without treating them as EOF", async () => {
            const calls = mockFetch([finalChunkResponse()]);

            const data = bytes(100, 0xcd);
            await uploadStreamChunked(makeStream(new Uint8Array(0), new Uint8Array(0), data), UPLOAD_SESSION_URL);

            expect(calls).toHaveLength(1);
            expect(calls[0]!.body).toEqual(data);
        });
    });

    describe("error handling", () => {
        test("throws when final response is not ok", async () => {
            mockFetch([
                new Response("Bad Request", {
                    status: 400,
                    headers: { "x-goog-upload-status": "final" },
                }),
            ]);

            await expect(uploadStreamChunked(makeStream(bytes(100)), UPLOAD_SESSION_URL)).rejects.toThrow(
                "Gemini stream upload failed (400)",
            );
        });
    });
});

describe("uploadStreamSingleShot", () => {
    beforeEach(() => {
        globalThis.setTimeout = ((fn: () => void) => {
            fn();
            return 0;
        }) as unknown as typeof setTimeout;
    });

    afterEach(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    test("POSTs to the correct URL with start, upload, finalize command", async () => {
        const calls = mockFetch([finalChunkResponse()]);

        await uploadStreamSingleShot("my-api-key", makeStream(bytes(100)), { ...BASE_CONFIG, byteLength: 100 });

        expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/upload/v1beta/files?key=my-api-key");
        expect(calls[0]!.headers["content-length"]).toBe("100");
        expect(calls[0]!.headers["x-goog-upload-command"]).toBeUndefined();
        expect(calls[0]!.headers["x-goog-upload-protocol"]).toBeUndefined();
        expect(calls[0]!.headers["x-goog-upload-offset"]).toBeUndefined();
    });

    test("returns the file resource on success", async () => {
        mockFetch([finalChunkResponse()]);

        const result = await uploadStreamSingleShot("key", makeStream(bytes(512)), {
            ...BASE_CONFIG,
            byteLength: 512,
        });

        expect(result).toEqual(FILE_RESOURCE);
    });

    test("sends the stream as the request body (no intermediate buffer)", async () => {
        const calls = mockFetch([finalChunkResponse()]);
        const stream = makeStream(bytes(64, 0xab));

        await uploadStreamSingleShot("key", stream, { ...BASE_CONFIG, byteLength: 64 });

        // Body should be the raw ReadableStream, not a Uint8Array copy
        expect(calls[0]!.rawBody).toBeInstanceOf(ReadableStream);
    });

    test("throws when response is not ok", async () => {
        mockFetch([new Response("Bad Request", { status: 400 })]);

        await expect(
            uploadStreamSingleShot("key", makeStream(bytes(64)), { ...BASE_CONFIG, byteLength: 64 }),
        ).rejects.toThrow("Gemini single-shot upload failed (400)");
    });
});
