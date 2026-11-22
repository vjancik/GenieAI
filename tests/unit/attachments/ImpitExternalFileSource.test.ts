import { describe, expect, mock, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import pino from "pino";
import type { MediaUnavailable, OpenedMedia } from "../../../src/application/ports/IMediaSource.ts";
import { ImpitExternalFileSource } from "../../../src/infrastructure/attachments/ImpitExternalFileSource.ts";

const testLogger = pino({ level: "silent" });

const URL = "https://example.com/docs/report.pdf";
const MAX_BYTES = 1024;

type Reply = { ok?: boolean; status?: number; headers?: Record<string, string>; chunks?: Uint8Array[] };

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
}

/** Builds a source whose HTTP client answers every attempt through `respond`. */
function makeSource(
    respond: (browser: string, url: string) => Reply | Promise<Reply>,
    urlGuard?: ConstructorParameters<typeof ImpitExternalFileSource>[2]["urlGuard"],
) {
    const signals: AbortSignal[] = [];
    const browsers: string[] = [];
    const requested: string[] = [];
    const createClient = mock((browser: "firefox" | "chrome") => ({
        fetch: async (url: string, init: { signal: AbortSignal; redirect: "manual" }) => {
            expect(init.redirect).toBe("manual");
            browsers.push(browser);
            requested.push(url);
            signals.push(init.signal);
            const reply = await respond(browser, url);
            const status = reply.status ?? 200;
            return {
                ok: reply.ok ?? (status >= 200 && status < 300),
                status,
                headers: new Headers(reply.headers),
                body: streamOf(reply.chunks ?? []),
            };
        },
    }));
    const source = new ImpitExternalFileSource(createClient, testLogger, {
        maxBytes: MAX_BYTES,
        responseTimeoutMs: 1000,
        urlGuard,
    });
    return { source, signals, browsers, requested };
}

/** Asserts that a result is a successfully opened file. */
function opened(result: OpenedMedia | MediaUnavailable): OpenedMedia {
    if ("unavailable" in result) throw new Error(`expected an opened file, got: ${result.unavailable}`);
    return result;
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

        const file = opened(await source.open(URL));

        expect(file).toMatchObject({ mimeType: "application/pdf", byteLength: 3, name: "report.pdf" });
        expect(await readAll(file.stream)).toBe(3);
        expect(signals[0]?.aborted).toBe(false);
    });

    test("spools a body of undeclared length to learn its size, then cleans up", async () => {
        const before = (await spooledFiles()).length;
        const { source } = makeSource(() => ({
            headers: { "content-type": "application/pdf" },
            chunks: [new Uint8Array(100), new Uint8Array(50)],
        }));

        const file = opened(await source.open(URL));

        expect(file.byteLength).toBe(150);
        expect((await spooledFiles()).length).toBe(before + 1);
        expect(await readAll(file.stream)).toBe(150);
        expect((await spooledFiles()).length).toBe(before);
    });

    test("gives up on a body of undeclared length that outgrows the limit", async () => {
        const before = (await spooledFiles()).length;
        const { source, signals } = makeSource(() => ({
            headers: { "content-type": "application/pdf" },
            chunks: [new Uint8Array(MAX_BYTES), new Uint8Array(1)],
        }));

        expect(await source.open(URL)).toMatchObject({ unavailable: expect.any(String) });
        expect(signals[0]?.aborted).toBe(true);
        expect((await spooledFiles()).length).toBe(before);
    });

    test("rejects a file declared larger than the limit without reading it", async () => {
        const { source, signals } = makeSource(() => ({
            headers: { "content-type": "application/pdf", "content-length": String(MAX_BYTES + 1) },
        }));

        expect(await source.open(URL)).toMatchObject({ unavailable: expect.any(String) });
        expect(signals[0]?.aborted).toBe(true);
    });

    test("reports a file that is gone as null, without trying another fingerprint", async () => {
        const { source, browsers } = makeSource(() => ({ ok: false, status: 404 }));

        expect(await source.open(URL)).toEqual({ unavailable: "the server responded with HTTP 404" });
        expect(browsers).toEqual(["firefox"]);
    });

    test("reports a URL that now serves a web page as null", async () => {
        const { source } = makeSource(() => ({ headers: { "content-type": "text/html", "content-length": "10" } }));

        expect(await source.open(URL, "application/pdf")).toMatchObject({ unavailable: expect.any(String) });
    });

    test("falls back to the expected type when the server names none", async () => {
        const { source } = makeSource(() => ({ headers: { "content-length": "3" } }));

        const file = opened(await source.open("https://example.com/download?id=5", "audio/mpeg"));

        expect(file.mimeType).toBe("audio/mpeg");
    });

    test("retries a transport failure with the other fingerprint", async () => {
        const { source, browsers } = makeSource((browser) => {
            if (browser === "firefox") throw new Error("TLS handshake failed");
            return { headers: { "content-type": "application/pdf", "content-length": "0" } };
        });

        opened(await source.open(URL));
        expect(browsers).toEqual(["firefox", "chrome"]);
    });

    test("returns null when no fingerprint can connect", async () => {
        const { source } = makeSource(() => {
            throw new Error("connection refused");
        });

        expect(await source.open(URL)).toMatchObject({ unavailable: expect.any(String) });
    });

    test("follows redirects to the file, checking every hop", async () => {
        const checked: string[] = [];
        const guard = {
            check: async (url: string) => {
                checked.push(url);
                return null;
            },
        };
        const { source } = makeSource(
            (_browser, url): Reply =>
                url === URL
                    ? { status: 302, headers: { location: "https://cdn.example.com/report.pdf" } }
                    : { headers: { "content-type": "application/pdf", "content-length": "0" } },
            guard,
        );

        expect(opened(await source.open(URL)).name).toBe("report.pdf");
        expect(checked).toEqual([URL, "https://cdn.example.com/report.pdf"]);
    });

    test("reports a redirect refused by the policy as unavailable, with the reason", async () => {
        const guard = {
            check: async (url: string) =>
                url.startsWith("http:")
                    ? { reason: "insecure-url" as const, description: "only HTTPS URLs are allowed, plain HTTP is not" }
                    : null,
        };
        const { source, requested, browsers } = makeSource(
            () => ({ status: 301, headers: { location: "http://example.com/report.pdf" } }),
            guard,
        );

        const result = await source.open(URL);

        expect("unavailable" in result).toBe(true);
        const reason = (result as MediaUnavailable).unavailable;
        expect(reason).toContain("only HTTPS URLs are allowed");
        expect(reason).toContain("redirects to http://example.com/report.pdf");
        // The notice shown in place of the file names the URL already
        expect(reason.startsWith(URL)).toBe(false);
        expect(requested).toEqual([URL]);
        expect(browsers).toEqual(["firefox"]);
    });
});
