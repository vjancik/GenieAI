import { describe, expect, mock, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import pino from "pino";
import { ImpitExternalFileSource } from "../../../src/infrastructure/attachments/ImpitExternalFileSource.ts";

const testLogger = pino({ level: "silent" });

const URL = "https://example.com/docs/report.pdf";
const MAX_BYTES = 1024;

type Reply = { ok?: boolean; status?: number; url?: string; headers?: Record<string, string>; chunks?: Uint8Array[] };

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
}

/** Builds a source whose HTTP client answers every attempt through `respond`. */
function makeSource(respond: (browser: string) => Reply | Promise<Reply>) {
    const signals: AbortSignal[] = [];
    const browsers: string[] = [];
    const createClient = mock((browser: "firefox" | "chrome") => ({
        fetch: async (url: string, init: { signal: AbortSignal }) => {
            browsers.push(browser);
            signals.push(init.signal);
            const reply = await respond(browser);
            return {
                ok: reply.ok ?? true,
                status: reply.status ?? 200,
                url: reply.url ?? url,
                headers: new Headers(reply.headers),
                body: streamOf(reply.chunks ?? []),
            };
        },
    }));
    const source = new ImpitExternalFileSource(createClient, testLogger, {
        maxBytes: MAX_BYTES,
        responseTimeoutMs: 1000,
    });
    return { source, signals, browsers };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number> {
    let total = 0;
    for await (const chunk of stream) total += chunk.byteLength;
    return total;
}

const spooledFiles = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("genie-external-file-"));

describe("ImpitExternalFileSource.open", () => {
    test("opens a file with a declared length as a live stream", async () => {
        const { source, signals } = makeSource(() => ({
            headers: { "content-type": "application/pdf", "content-length": "3" },
            chunks: [new Uint8Array([1, 2, 3])],
        }));

        const opened = await source.open(URL);

        expect(opened).toMatchObject({ mimeType: "application/pdf", byteLength: 3, name: "report.pdf" });
        expect(await readAll(opened?.stream as ReadableStream<Uint8Array>)).toBe(3);
        expect(signals[0]?.aborted).toBe(false);
    });

    test("spools a body of undeclared length to learn its size, then cleans up", async () => {
        const before = (await spooledFiles()).length;
        const { source } = makeSource(() => ({
            headers: { "content-type": "application/pdf" },
            chunks: [new Uint8Array(100), new Uint8Array(50)],
        }));

        const opened = await source.open(URL);

        expect(opened?.byteLength).toBe(150);
        expect((await spooledFiles()).length).toBe(before + 1);
        expect(await readAll(opened?.stream as ReadableStream<Uint8Array>)).toBe(150);
        expect((await spooledFiles()).length).toBe(before);
    });

    test("gives up on a body of undeclared length that outgrows the limit", async () => {
        const before = (await spooledFiles()).length;
        const { source, signals } = makeSource(() => ({
            headers: { "content-type": "application/pdf" },
            chunks: [new Uint8Array(MAX_BYTES), new Uint8Array(1)],
        }));

        expect(await source.open(URL)).toBeNull();
        expect(signals[0]?.aborted).toBe(true);
        expect((await spooledFiles()).length).toBe(before);
    });

    test("rejects a file declared larger than the limit without reading it", async () => {
        const { source, signals } = makeSource(() => ({
            headers: { "content-type": "application/pdf", "content-length": String(MAX_BYTES + 1) },
        }));

        expect(await source.open(URL)).toBeNull();
        expect(signals[0]?.aborted).toBe(true);
    });

    test("reports a file that is gone as null, without trying another fingerprint", async () => {
        const { source, browsers } = makeSource(() => ({ ok: false, status: 404 }));

        expect(await source.open(URL)).toBeNull();
        expect(browsers).toEqual(["firefox"]);
    });

    test("reports a URL that now serves a web page as null", async () => {
        const { source } = makeSource(() => ({ headers: { "content-type": "text/html", "content-length": "10" } }));

        expect(await source.open(URL, "application/pdf")).toBeNull();
    });

    test("falls back to the expected type when the server names none", async () => {
        const { source } = makeSource(() => ({ headers: { "content-length": "3" } }));

        const opened = await source.open("https://example.com/download?id=5", "audio/mpeg");

        expect(opened?.mimeType).toBe("audio/mpeg");
    });

    test("retries a transport failure with the other fingerprint", async () => {
        const { source, browsers } = makeSource((browser) => {
            if (browser === "firefox") throw new Error("TLS handshake failed");
            return { headers: { "content-type": "application/pdf", "content-length": "0" } };
        });

        expect(await source.open(URL)).not.toBeNull();
        expect(browsers).toEqual(["firefox", "chrome"]);
    });

    test("returns null when no fingerprint can connect", async () => {
        const { source } = makeSource(() => {
            throw new Error("connection refused");
        });

        expect(await source.open(URL)).toBeNull();
    });
});
