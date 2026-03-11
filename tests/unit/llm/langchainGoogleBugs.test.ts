/**
 * Regression tests for upstream @langchain/google bugs.
 *
 * These tests intercept the actual fetch call made by ChatGoogle so they record
 * the exact Gemini API request body that the library produces. They are
 * intentionally snapshot-based: if a library upgrade changes the serialized
 * body, the snapshot diff will surface the change for review.
 *
 * @see docs/upstream_bugs/langchain-google-contentblocks-drops-humanmessage.md
 * @see docs/upstream_bugs/langchain-google-tool-response-name-unknown.md
 */

import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ChatGoogle } from "@langchain/google";

// ---------------------------------------------------------------------------
// Fetch interceptor helpers
// ---------------------------------------------------------------------------

/**
 * Installs a one-shot global fetch mock that captures the request body of the
 * first call made to any URL path containing `generateContent`, then throws so
 * that ChatGoogle never sees a real response (we only care about the request).
 *
 * Returns the captured JSON body. Must be called before ChatGoogle is invoked,
 * because the library resolves `fetch` at call-time from globalThis.
 */
async function captureGenerateContentBody(invoke: () => Promise<unknown>): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;

    // TYPE COERCION: our mock omits the `preconnect` property on the fetch
    // function object, which is only relevant in browser contexts. Casting
    // avoids polluting the mock with a no-op stub.
    globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
        const url = input instanceof Request ? input.url : typeof input === "string" ? input : input.toString();

        const body = input instanceof Request ? await input.clone().text() : init?.body;

        if (url.includes("generateContent") && body) {
            captured = JSON.parse(typeof body === "string" ? body : String(body)) as Record<string, unknown>;
            // Throw to short-circuit — we don't need an actual API response.
            throw new Error("fetch intercepted");
        }

        // Pass through any other calls (e.g., token refresh) to avoid breakage.
        return originalFetch(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;

    try {
        await invoke();
    } catch (err) {
        // Swallow only our own sentinel error; re-throw anything unexpected.
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

// ---------------------------------------------------------------------------
// Bug: HumanMessage with contentBlocks is silently dropped
// (docs/upstream_bugs/langchain-google-contentblocks-drops-humanmessage.md)
// ---------------------------------------------------------------------------

describe("@langchain/google — HumanMessage multimodal serialization", () => {
    /**
     * v0 syntax: `content:` array with Gemini-native `"media"` type blocks.
     * Uses the legacy converter path (no output_version in response_metadata).
     * This is the WORKING approach documented in the bug report.
     */
    test("v0 content: with media type blocks produces expected Gemini parts (snapshot)", async () => {
        const model = new ChatGoogle({
            model: "gemini-2.5-flash",
            apiKey: "test-api-key-fake",
        });

        const messages = [
            new HumanMessage({
                content: [
                    { type: "text", text: "Describe this image and video." },
                    {
                        type: "media",
                        mimeType: "image/png",
                        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/img-abc123",
                    },
                    {
                        type: "media",
                        mimeType: "video/mp4",
                        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/vid-def456",
                    },
                    {
                        type: "media",
                        mimeType: "audio/mpeg",
                        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/aud-003",
                    },
                    {
                        type: "media",
                        mimeType: "text/plain",
                        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/txt-004",
                    },
                    {
                        type: "media",
                        mimeType: "application/pdf",
                        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/pdf-005",
                    },
                ],
            }),
        ];

        const body = await captureGenerateContentBody(() => model.invoke(messages));

        expect(body.contents).toMatchInlineSnapshot(`
[
  {
    "parts": [
      {
        "text": "Describe this image and video.",
      },
      {
        "fileData": {
          "fileUri": "https://generativelanguage.googleapis.com/v1beta/files/img-abc123",
          "mimeType": "image/png",
        },
      },
      {
        "fileData": {
          "fileUri": "https://generativelanguage.googleapis.com/v1beta/files/vid-def456",
          "mimeType": "video/mp4",
        },
      },
      {
        "fileData": {
          "fileUri": "https://generativelanguage.googleapis.com/v1beta/files/aud-003",
          "mimeType": "audio/mpeg",
        },
      },
      {
        "fileData": {
          "fileUri": "https://generativelanguage.googleapis.com/v1beta/files/txt-004",
          "mimeType": "text/plain",
        },
      },
      {
        "fileData": {
          "fileUri": "https://generativelanguage.googleapis.com/v1beta/files/pdf-005",
          "mimeType": "application/pdf",
        },
      },
    ],
    "role": "user",
  },
]
`);
    });

    /**
     * v1 syntax: `contentBlocks:` with all five LangChainBlockType values
     * (image, video, audio, text-plain, file) plus a text block, each backed
     * by a `url` field. Uses the v1 converter path (output_version: "v1" is
     * injected automatically by @langchain/core when contentBlocks: is used).
     *
     * The snapshot documents which block types the v1 converter handles
     * correctly and which it silently drops (returns null → message filtered):
     *
     *   "image" | "video" | "audio"  → fileData part  ✓  (handled)
     *   "text-plain" | "file"        → null            ✗  (dropped — BUG)
     *
     * If a library upgrade adds support for "text-plain" / "file", those blocks
     * will appear in the snapshot and the assertion should be updated.
     */
    test("v1 contentBlocks: all LangChainBlockType values — snapshot shows which are dropped (snapshot)", async () => {
        const model = new ChatGoogle({
            model: "gemini-2.5-flash",
            apiKey: "test-api-key-fake",
        });

        const messages = [
            new HumanMessage({
                contentBlocks: [
                    { type: "text", text: "Process all these attachments." },
                    {
                        type: "image",
                        mimeType: "image/png",
                        url: "https://generativelanguage.googleapis.com/v1beta/files/img-001",
                    },
                    {
                        type: "video",
                        mimeType: "video/mp4",
                        url: "https://generativelanguage.googleapis.com/v1beta/files/vid-002",
                    },
                    {
                        type: "audio",
                        mimeType: "audio/mpeg",
                        url: "https://generativelanguage.googleapis.com/v1beta/files/aud-003",
                    },
                    {
                        type: "text-plain",
                        mimeType: "text/plain",
                        url: "https://generativelanguage.googleapis.com/v1beta/files/txt-004",
                    },
                    {
                        type: "file",
                        mimeType: "application/pdf",
                        url: "https://generativelanguage.googleapis.com/v1beta/files/pdf-005",
                    },
                ],
            }),
        ];

        const body = await captureGenerateContentBody(() => model.invoke(messages));

        expect(body.contents).toMatchInlineSnapshot(`
[
  {
    "parts": [
      {
        "text": "Process all these attachments.",
      },
      {
        "fileData": {
          "fileUri": "https://generativelanguage.googleapis.com/v1beta/files/img-001",
          "mimeType": "image/png",
        },
      },
      {
        "fileData": {
          "fileUri": "https://generativelanguage.googleapis.com/v1beta/files/vid-002",
          "mimeType": "video/mp4",
        },
      },
      {
        "fileData": {
          "fileUri": "https://generativelanguage.googleapis.com/v1beta/files/aud-003",
          "mimeType": "audio/mpeg",
        },
      },
    ],
    "role": "user",
  },
]
`);
    });
});

// ---------------------------------------------------------------------------
// Bug: functionResponse.name is always "unknown" in legacy message converter
// (docs/upstream_bugs/langchain-google-tool-response-name-unknown.md)
// ---------------------------------------------------------------------------

describe("@langchain/google — ToolMessage name serialization bug", () => {
    /**
     * Constructs a history with:
     *   - AIMessage containing TWO tool calls (distinct ids and names)
     *   - TWO ToolMessages each referencing one of those ids by tool_call_id
     *
     * Then invokes ChatGoogle with a follow-up HumanMessage so the library
     * must serialize the full history. We snapshot the `contents` array to
     * observe what actually reaches the Gemini API.
     *
     * KNOWN BUGS (as of @langchain/google 0.1.5, legacy path):
     * 1. The AIMessage's functionCall parts are entirely absent — the model turn
     *    is dropped by the legacy converter regardless of whether matching tool
     *    definitions are bound to the model.
     * 2. Both functionResponse.name values are "unknown" because the legacy
     *    converter reads `AIMessage.name` (always undefined) instead of looking
     *    up the matching tool_call by id. Setting `name` on ToolMessage has no
     *    effect in the legacy path.
     *
     * Using two tool calls (rather than one) makes it visible in the snapshot
     * whether the library can match multiple responses to their call names
     * independently, which would be required for a correct future fix.
     *
     * If a future upgrade fixes these, the snapshot should be updated to reflect
     * the corrected serialization (functionCall parts present, real names, single
     * batched function turn).
     */
    test("ToolMessage name is 'unknown' in functionResponse (legacy path bug snapshot)", async () => {
        // Bind matching tool declarations so the request mirrors real usage.
        // The AIMessage's functionCall parts are still absent in the snapshot
        // (BUG 1) — the model turn is dropped regardless.
        const model = new ChatGoogle({
            model: "gemini-2.5-flash",
            apiKey: "test-api-key-fake",
        }).bindTools([
            {
                name: "get_website",
                description: "Fetch the content of a web page.",
                parameters: {
                    type: "object",
                    properties: {
                        urls: { type: "array", items: { type: "string" } },
                    },
                    required: ["urls"],
                },
            },
            {
                name: "get_video_transcription",
                description: "Transcribe a video.",
                parameters: {
                    type: "object",
                    properties: {
                        urls: { type: "array", items: { type: "string" } },
                    },
                    required: ["urls"],
                },
            },
        ]);

        // AIMessage with two distinct tool calls in a single turn.
        const aiWithToolCalls = new AIMessage({
            // content: [{
            //   type: 'functionCall',
            //   functionCall: {
            //     id: 'call_id_website_001',
            //     name: 'get_website',
            //     args: { urls: ['https://example.com'] },
            //   },
            // }, {
            //   type: 'functionCall',
            //   functionCall: {
            //     id: 'call_id_video_002',
            //     name: 'get_video_transcription',
            //     args: { urls: ['https://youtube.com/watch?v=abc'] },
            //   },
            // }],
            tool_calls: [
                {
                    id: "call_id_website_001",
                    name: "get_website",
                    args: { urls: ["https://example.com"] },
                    type: "tool_call",
                },
                // commenting this out correctly causes an error on invocation due to missing tool call id
                {
                    id: "call_id_video_002",
                    name: "get_video_transcription",
                    args: { urls: ["https://youtube.com/watch?v=abc"] },
                    type: "tool_call",
                },
            ],
        });

        // Two ToolMessages, each matched to one call by id and carrying the
        // correct name — the bug is in the library serializer, not here.
        const toolResponseWebsite = new ToolMessage({
            content: "Website content for example.com",
            tool_call_id: "call_id_website_001",
            name: "get_website",
        });

        const toolResponseVideo = new ToolMessage({
            content: "Video transcript for abc",
            tool_call_id: "call_id_video_002",
            name: "get_video_transcription",
        });

        const history = [
            new HumanMessage("Fetch example.com and transcribe the video."),
            aiWithToolCalls,
            toolResponseWebsite,
            toolResponseVideo,
        ];
        const followUp = new HumanMessage("Thanks, summarize both results.");

        const body = await captureGenerateContentBody(() => model.invoke([...history, followUp]));

        // The snapshot reveals what is actually sent in the request contents.
        // BUG 1: The AIMessage's functionCall parts are entirely absent — the
        //   model turn is dropped by the legacy converter even when matching tool
        //   definitions are bound to the model via bindTools().
        // BUG 2: Both functionResponse.name values are "unknown" instead of the
        //   real tool names, because the legacy converter reads AIMessage.name
        //   (always undefined) rather than the matched tool_call's name.
        expect(body.contents).toMatchInlineSnapshot(`
[
  {
    "parts": [
      {
        "text": "Fetch example.com and transcribe the video.",
      },
    ],
    "role": "user",
  },
  {
    "parts": [
      {
        "functionResponse": {
          "id": "call_id_website_001",
          "name": "unknown",
          "response": {
            "result": "Website content for example.com",
          },
        },
      },
    ],
    "role": "function",
  },
  {
    "parts": [
      {
        "functionResponse": {
          "id": "call_id_video_002",
          "name": "unknown",
          "response": {
            "result": "Video transcript for abc",
          },
        },
      },
    ],
    "role": "function",
  },
  {
    "parts": [
      {
        "text": "Thanks, summarize both results.",
      },
    ],
    "role": "user",
  },
]
`);
    });
});
