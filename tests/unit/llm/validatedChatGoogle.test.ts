/**
 * Tests for {@link ValidatedChatGoogle}, which forces Gemini's `VALIDATED`
 * function-calling mode — a mode `@langchain/google` cannot express through
 * `tool_choice` (its converter treats unknown strings as function names and
 * emits `mode: "ANY"` with a bogus `allowedFunctionNames` entry).
 *
 * These tests intercept the actual fetch call so they assert on the exact
 * `toolConfig` that reaches the Gemini API.
 */

import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import { ValidatedChatGoogle } from "../../../src/infrastructure/llm/models/ValidatedChatGoogle.ts";

const FAKE_API_KEY = "test-api-key-fake-validated-mode";

/**
 * Installs a one-shot global fetch mock that captures the request body of the
 * first `generateContent` call, then throws so the model never sees a response.
 * All other URLs pass through unchanged.
 */
async function captureGenerateContentBody(invoke: () => Promise<unknown>): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;

    // TYPE COERCION: our mock omits the `preconnect` property on the fetch
    // function object, which is only relevant in browser contexts.
    globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
        const url = input instanceof Request ? input.url : typeof input === "string" ? input : input.toString();
        const body = input instanceof Request ? await input.clone().text() : init?.body;

        if (url.includes("generateContent") && body) {
            captured = JSON.parse(typeof body === "string" ? body : String(body)) as Record<string, unknown>;
            throw new Error("fetch intercepted");
        }

        return originalFetch(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;

    try {
        await invoke();
    } catch (err) {
        if (!(err instanceof Error) || err.message !== "fetch intercepted") {
            throw err;
        }
    } finally {
        globalThis.fetch = originalFetch;
    }

    if (!captured) {
        throw new Error("fetch interceptor: generateContent request was never made");
    }

    return captured;
}

function createModel() {
    // `maxRetries: 0` is required: the interceptor throws to short-circuit the request,
    // and the AsyncCaller would otherwise retry that throw six times with exponential backoff.
    return new ValidatedChatGoogle({ model: "gemini-2.5-flash", apiKey: FAKE_API_KEY, maxRetries: 0 });
}

const dummyTool = tool(() => "", {
    name: "dummy_tool",
    description: "A tool that does nothing.",
    schema: z.object({ input: z.string() }),
});

describe("ValidatedChatGoogle", () => {
    test("emits VALIDATED mode with no bound tools", async () => {
        const body = await captureGenerateContentBody(() => createModel().invoke([new HumanMessage("hi")]));

        expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    });

    test("emits VALIDATED mode with bound tools", async () => {
        const model = createModel().bindTools([dummyTool]);
        const body = await captureGenerateContentBody(() => model.invoke([new HumanMessage("hi")]));

        expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
        // The tool declarations themselves must still be sent.
        expect(body.tools).toBeDefined();
    });

    test("overrides any tool_choice the caller supplies, and never sends allowedFunctionNames", async () => {
        for (const toolChoice of ["auto", "any", "none", "dummy_tool"]) {
            const model = createModel().bindTools([dummyTool], { tool_choice: toolChoice });
            const body = await captureGenerateContentBody(() => model.invoke([new HumanMessage("hi")]));

            expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
        }
    });

    test("leaves the rest of the request body intact", async () => {
        const model = createModel();
        const body = await captureGenerateContentBody(() => model.invoke([new HumanMessage("hello there")]));

        expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hello there" }] }]);
        expect(body.generationConfig).toBeDefined();
    });
});
