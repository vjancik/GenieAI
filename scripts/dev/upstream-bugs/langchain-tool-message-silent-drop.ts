/**
 * Dev script for reproducing upstream LangChain/Gemini bugs.
 *
 * Intercepts the generateContent call, logs the full request body, then short-circuits
 * with a fake 500 so no real API call is made.
 *
 * Tests whether passing an object (vs array) as ToolMessage content causes the message
 * to be dropped from the history passed to generateContent.
 *
 * Run: bunx cross-env AGENT=1 bun run scripts/dev/upstream-bugs.ts
 */

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ChatGoogle } from "@langchain/google/node";

// ---------------------------------------------------------------------------
// Fetch proxy — intercepts generateContent, logs request body, returns fake 500
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

        console.log(`[upstream-bugs] generateContent request body:\n${JSON.stringify(body, null, 2)}`);

        // Short-circuit — return a fake 500 so no real API call is made
        return new Response(JSON.stringify({ error: { message: "fake 500 from upstream-bugs proxy", code: 500 } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }

    return originalFetch(input, init);
} as typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const TOOL_CALL_ID = "tool-call-123";
const TOOL_NAME = "my_tool";

async function testWithToolContents(label: string, toolContents: unknown): Promise<void> {
    console.log(`\n${"=".repeat(60)}\n[upstream-bugs] Running: ${label}\n${"=".repeat(60)}`);

    const llm = new ChatGoogle({
        model: "gemini-3.1-flash-lite-preview",
        apiKey: "FAKE KEY",
    });

    const history = [
        new HumanMessage("What is the result of my_tool?"),
        new AIMessage({
            tool_calls: [
                {
                    id: TOOL_CALL_ID,
                    name: TOOL_NAME,
                    args: { input: "test" },
                },
            ],
        }),
        new ToolMessage({
            // TYPE COERCION: ToolMessage content accepts string | MessageContentComplex[],
            // but we deliberately pass unknown shapes here to test upstream serialization behaviour.
            content: toolContents as string,
            tool_call_id: TOOL_CALL_ID,
            name: TOOL_NAME,
        }),
    ];

    try {
        await llm.invoke(history);
    } catch {
        // Expected — the fake 500 will cause an error; the request body was already logged above
    }
}

// Array of objects (expected: message included in generateContent request)
await testWithToolContents("array tool content", [
    { type: "text", text: "Result A" },
    { type: "text", text: "Result B" },
]);

// Plain object (hypothesis: message dropped from generateContent request)
await testWithToolContents("object tool content", {
    status: "ok",
    value: 42,
    items: ["foo", "bar"],
});

await testWithToolContents("string tool content", "test");
