import { describe, expect, mock, test } from "bun:test";
import pino from "pino";
import type { IExternalUrlGuard, UrlRejection } from "../../../src/infrastructure/http/ExternalUrlGuard.ts";
import { HttpsUpgrader, probeHttps, upgradeSuppliedUrl } from "../../../src/infrastructure/http/HttpsUpgrader.ts";

const logger = pino({ level: "silent" });

/** A guard refusing the given hosts as private, recording every URL it checks. */
function makeGuard(blockedHosts: string[] = []) {
    const checked: string[] = [];
    const guard: IExternalUrlGuard = {
        check: async (url): Promise<UrlRejection | null> => {
            checked.push(url);
            return blockedHosts.includes(new URL(url).hostname)
                ? { reason: "private-address", description: "it points to a private address" }
                : null;
        },
    };
    return { guard, checked };
}

describe("HttpsUpgrader", () => {
    test("upgrades a plain HTTP URL whose host serves HTTPS", async () => {
        const probe = mock(async () => true);

        const upgraded = await new HttpsUpgrader(logger, undefined, probe).upgrade("http://example.com/a?b=1#c");

        expect(upgraded).toBe("https://example.com/a?b=1#c");
        expect(probe).toHaveBeenCalledWith("https://example.com/a?b=1#c");
    });

    test("keeps the URL as given when the host does not serve HTTPS", async () => {
        const upgraded = await new HttpsUpgrader(logger, undefined, async () => false).upgrade("http://example.com");

        expect(upgraded).toBe("http://example.com");
    });

    test.each(["https://example.com/", "ftp://example.com/file", "not a url"])(
        "leaves %p alone without probing",
        async (url) => {
            const probe = mock(async () => true);

            expect(await new HttpsUpgrader(logger, undefined, probe).upgrade(url)).toBe(url);
            expect(probe).not.toHaveBeenCalled();
        },
    );

    test("does not upgrade a URL with an explicit port, which serves plain HTTP", async () => {
        const probe = mock(async () => true);

        expect(await new HttpsUpgrader(logger, undefined, probe).upgrade("http://example.com:8080/")).toBe(
            "http://example.com:8080/",
        );
        expect(probe).not.toHaveBeenCalled();
    });

    test("treats the default port as no port", async () => {
        const upgraded = await new HttpsUpgrader(logger, undefined, async () => true).upgrade("http://example.com:80/");

        expect(upgraded).toBe("https://example.com/");
    });

    test("checks the HTTPS URL with the guard before probing it", async () => {
        const { guard, checked } = makeGuard();

        await new HttpsUpgrader(logger, guard, async () => true).upgrade("http://example.com/");

        expect(checked).toEqual(["https://example.com/"]);
    });

    test("never probes a host the guard refuses", async () => {
        const { guard } = makeGuard(["internal.local"]);
        const probe = mock(async () => true);

        const upgraded = await new HttpsUpgrader(logger, guard, probe).upgrade("http://internal.local/admin");

        expect(upgraded).toBe("http://internal.local/admin");
        expect(probe).not.toHaveBeenCalled();
    });
});

describe("probeHttps", () => {
    /** A client factory whose clients answer, or fail, per browser profile. */
    function clientsBy(outcomes: Record<string, "answer" | "fail">) {
        const requests: { browser: string; url: string; method?: string; redirect?: string }[] = [];
        const createClient = (browser: string) => ({
            fetch: async (url: string, init?: { method?: string; redirect?: string }) => {
                requests.push({ browser, url, method: init?.method, redirect: init?.redirect });
                if (outcomes[browser] === "fail") throw new Error("InvalidCertificate(UnknownIssuer)");
                return { status: 405, body: null } as never;
            },
        });
        return { createClient, requests };
    }

    test("sends a HEAD request that does not follow redirects", async () => {
        const { createClient, requests } = clientsBy({ firefox: "answer", chrome: "answer" });

        await probeHttps("https://example.com/", createClient);

        expect(requests[0]).toMatchObject({ url: "https://example.com/", method: "HEAD", redirect: "manual" });
    });

    test("counts any HTTP response as HTTPS support, even an error status", async () => {
        const { createClient } = clientsBy({ firefox: "answer", chrome: "answer" });

        expect(await probeHttps("https://example.com/", createClient)).toBe(true);
    });

    test("succeeds when only one fingerprint completes the handshake", async () => {
        const { createClient, requests } = clientsBy({ firefox: "fail", chrome: "answer" });

        expect(await probeHttps("https://example.com/", createClient)).toBe(true);
        expect(requests.map((r) => r.browser).sort()).toEqual(["chrome", "firefox"]);
    });

    test("fails when no fingerprint can connect, such as on a certificate error", async () => {
        const { createClient } = clientsBy({ firefox: "fail", chrome: "fail" });

        expect(await probeHttps("https://example.com/", createClient)).toBe(false);
    });
});

describe("upgradeSuppliedUrl", () => {
    test("returns the URL alone when there is no upgrader", async () => {
        expect(await upgradeSuppliedUrl("http://example.com/", undefined)).toEqual({ url: "http://example.com/" });
    });

    test("returns the URL alone when it was not upgraded", async () => {
        const upgrader = { upgrade: async (url: string) => url };

        expect(await upgradeSuppliedUrl("http://example.com/", upgrader)).toEqual({ url: "http://example.com/" });
    });

    test("records the supplied URL when it was upgraded", async () => {
        const upgrader = { upgrade: async () => "https://example.com/" };

        expect(await upgradeSuppliedUrl("http://example.com/", upgrader)).toEqual({
            url: "https://example.com/",
            upgradedFrom: "http://example.com/",
        });
    });
});
