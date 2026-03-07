/**
 * Fetch proxy preload script — intercepts generateContent API calls and logs the full request body.
 *
 * Load with: bun --preload ./src/devScripts/fetch-proxy.ts <your-script>
 */

const originalFetch = globalThis.fetch;

globalThis.fetch = async function proxiedFetch(
    input: Request | string | URL,
    init?: RequestInit,
): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);

    if (url.includes("generateContent")) {
        let body: unknown = "(unreadable)";
        try {
            const rawBody =
                init?.body ??
                (input instanceof Request
                    ? await input.clone().text()
                    : undefined);
            if (typeof rawBody === "string") {
                body = JSON.parse(rawBody);
            } else if (
                rawBody instanceof Uint8Array ||
                rawBody instanceof ArrayBuffer
            ) {
                body = JSON.parse(new TextDecoder().decode(rawBody));
            } else {
                body = rawBody;
            }
        } catch {
            body = "(parse error)";
        }

        console.log(
            "[fetch-proxy] generateContent request\n" +
                JSON.stringify({ url, body }, null, 2),
        );
    }

    return originalFetch(input, init);
} as typeof globalThis.fetch;

console.log(
    "[fetch-proxy] Fetch proxy active — logging generateContent requests",
);
