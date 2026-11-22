import { describe, expect, mock, test } from "bun:test";
import { ExternalUrlGuard, isNonPublicAddress } from "../../../src/infrastructure/http/ExternalUrlGuard.ts";

const BOTH = { httpsOnly: true, blockPrivateAddresses: true };

/** A resolver answering from a fixed table, failing for unknown hosts. */
function resolverOf(table: Record<string, string[]>) {
    return mock(async (hostname: string) => {
        const addresses = table[hostname];
        if (addresses === undefined) throw new Error(`ENOTFOUND ${hostname}`);
        return addresses;
    });
}

describe("isNonPublicAddress", () => {
    test.each([
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::",
        "fe80::1",
        "fd12:3456::1",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "::ffff:10.0.0.1",
        "64:ff9b::7f00:1",
        "2002:7f00:1::",
    ])("blocks %s", (address) => {
        expect(isNonPublicAddress(address)).toBe(true);
    });

    test.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "104.20.23.154", "::ffff:8.8.8.8", "2606:4700:10::6814:179a"])(
        "allows %s",
        (address) => {
            expect(isNonPublicAddress(address)).toBe(false);
        },
    );
});

describe("ExternalUrlGuard.check", () => {
    test("allows a public HTTPS URL", async () => {
        const guard = new ExternalUrlGuard(BOTH, resolverOf({ "example.com": ["104.20.23.154"] }));

        expect(await guard.check("https://example.com/page")).toBeNull();
    });

    test("refuses plain HTTP before resolving anything", async () => {
        const resolve = resolverOf({ "example.com": ["104.20.23.154"] });
        const guard = new ExternalUrlGuard(BOTH, resolve);

        expect(await guard.check("http://example.com/")).toMatchObject({ reason: "insecure-url" });
        expect(resolve).not.toHaveBeenCalled();
    });

    test("allows plain HTTP when HTTPS is not required", async () => {
        const guard = new ExternalUrlGuard(
            { httpsOnly: false, blockPrivateAddresses: true },
            resolverOf({ "example.com": ["104.20.23.154"] }),
        );

        expect(await guard.check("http://example.com/")).toBeNull();
    });

    test("refuses schemes other than HTTP(S) even when HTTP is allowed", async () => {
        const guard = new ExternalUrlGuard({ httpsOnly: false, blockPrivateAddresses: false }, resolverOf({}));

        expect(await guard.check("file:///etc/passwd")).toMatchObject({ reason: "insecure-url" });
    });

    test("refuses a host resolving to a private address", async () => {
        const guard = new ExternalUrlGuard(BOTH, resolverOf({ "intranet.example.com": ["10.0.0.5"] }));

        expect(await guard.check("https://intranet.example.com/")).toMatchObject({ reason: "private-address" });
    });

    test("refuses a host when any of its addresses is private", async () => {
        const guard = new ExternalUrlGuard(BOTH, resolverOf({ "mixed.example.com": ["104.20.23.154", "127.0.0.1"] }));

        expect(await guard.check("https://mixed.example.com/")).toMatchObject({ reason: "private-address" });
    });

    test.each([
        "https://127.0.0.1/",
        "https://2130706433/",
        "https://0x7f.1/",
        "https://[::1]:8443/",
        "https://[::ffff:127.0.0.1]/",
        "https://169.254.169.254/latest/meta-data/",
    ])("refuses the IP literal in %s without resolving it", async (url) => {
        const resolve = resolverOf({});
        const guard = new ExternalUrlGuard(BOTH, resolve);

        expect(await guard.check(url)).toMatchObject({ reason: "private-address" });
        expect(resolve).not.toHaveBeenCalled();
    });

    test("refuses a host that cannot be resolved", async () => {
        const guard = new ExternalUrlGuard(BOTH, resolverOf({}));

        expect(await guard.check("https://nowhere.invalid/")).toMatchObject({ reason: "unreachable" });
    });

    test("skips the address check when private addresses are allowed", async () => {
        const resolve = resolverOf({});
        const guard = new ExternalUrlGuard({ httpsOnly: true, blockPrivateAddresses: false }, resolve);

        expect(await guard.check("https://localhost/")).toBeNull();
        expect(resolve).not.toHaveBeenCalled();
    });

    test("resolves localhost through the system resolver by default", async () => {
        const guard = new ExternalUrlGuard(BOTH);

        expect(await guard.check("https://localhost/")).toMatchObject({ reason: "private-address" });
    });
});
