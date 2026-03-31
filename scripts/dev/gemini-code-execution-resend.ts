/**
 * Dev script that loads a collected AIMessageChunk from a prior stream run,
 * reconstructs it, and re-sends it as history to ChatGoogle — intercepting the
 * generateContent request to log the serialized body without making a real API call.
 *
 * Run: bunx cross-env AGENT=1 bun run scripts/dev/gemini-code-execution-resend.ts
 */

import { AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { ChatGoogle } from "@langchain/google/node";

const COLLECTED_PATH = `${import.meta.dir}/gemini-code-execution-2026-03-31T13-32-46-251Z-v0-stream-collected.json`;

// ---------------------------------------------------------------------------
// Fetch proxy — intercepts generateContent, logs request body, short-circuits
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

globalThis.fetch = async function proxiedFetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);

    if (url.includes("generateContent")) {
        let body: unknown = "(unreadable)";
        try {
            const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
            if (typeof rawBody === "string") {
                body = JSON.parse(rawBody);
            } else if (rawBody instanceof Uint8Array || rawBody instanceof ArrayBuffer) {
                body = JSON.parse(new TextDecoder().decode(rawBody));
            } else {
                body = rawBody;
            }
        } catch {
            body = "(parse error)";
        }

        console.log(`[gemini-code-execution-resend] generateContent request body:\n${JSON.stringify(body, null, 2)}`);

        return new Response(JSON.stringify({ error: { message: "fake 500 from proxy", code: 500 } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }

    return originalFetch(input, init);
} as typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Load, reconstruct, and resend
// ---------------------------------------------------------------------------

const parsed = JSON.parse(await Bun.file(COLLECTED_PATH).text()) as { kwargs: Record<string, unknown> };

const chunk = new AIMessageChunk(parsed.kwargs);

console.log(
    `[gemini-code-execution-resend] Loaded AIMessageChunk with ${Array.isArray(chunk.content) ? chunk.content.length : 1} content block(s)`,
);
console.log(`[gemini-code-execution-resend] additional_kwargs:\n${JSON.stringify(chunk.additional_kwargs, null, 2)}`);

const llm = new ChatGoogle({
    model: "gemini-3-flash-preview",
    apiKey: "FAKE_API_KEY",
});

try {
    await llm.invoke([
        new HumanMessage("Render the normal distribution of IQ scores into a graphic for me"),
        chunk,
        new HumanMessage("test"),
    ]);
} catch {
    // Expected — fake 500 causes an error; request body was already logged above
}
