# Bug: `AIMessage` with `tool_calls` silently dropped in legacy message converter

**Package:** `@langchain/google`
**Version:** `0.1.5`
**Companion:** `@langchain/core` `1.1.30`
**Date discovered:** 2026-03-11
**Affected function:** `convertLegacyContentMessageToGeminiContent` in `src/converters/messages.ts`

---

## Summary

When an `AIMessage` that contains `tool_calls` (and an empty `content: ""`) is serialized by
the legacy message converter, the entire model turn is silently dropped from the `contents`
array sent to the Gemini API. No `functionCall` parts are emitted for the tool calls, and the
message is absent from the conversation history.

This is distinct from — but compounds — the
[`functionResponse.name` always "unknown"](./langchain-google-tool-response-name-unknown.md)
bug: the model never even sees the `functionCall` it supposedly already made.

---

## Root cause

`convertLegacyContentMessageToGeminiContent` (compiled: `dist/converters/messages.js` ~line 209)
builds a `parts` array solely from `message.content`. It **never reads `message.tool_calls`**:

```js
// dist/converters/messages.js lines 308-340
let parts = [];
if (typeof message.content === "string") {
    if (message.content.trim()) parts.push({ text: message.content });  // empty string → nothing added
} else if (Array.isArray(message.content)) {
    for (const item of message.content) {
        // only handles: text, dataContentBlock, { type: "functionCall" }, image_url, media
        // message.tool_calls is NEVER read here
    }
}
// ... ToolMessage handling (irrelevant for AIMessage) ...
if (parts.length > 0) return { role, parts };
return null;  // ← dropped silently
```

When the model responds with tool calls, LangChain stores them in `AIMessage.tool_calls` (a
top-level property) and sets `content: ""`. Because `"".trim()` is falsy, no text part is
added. Because `tool_calls` is never iterated, no `functionCall` parts are added. The result
is `parts.length === 0`, so the function returns `null`, and
`convertMessagesToGeminiContents` (line 386: `if (content) contents.push(content)`) silently
filters it out.

Note: the legacy converter **does** handle `{ type: "functionCall" }` items inside
`message.content` (line 315–320), which is a legacy/Gemini-specific content block format.
But `message.tool_calls` — the standard LangChain format used by `ChatGoogle` when parsing
API responses — is a completely separate property that the legacy path never touches.

---

## There is no code path that converts `tool_calls` to `functionCall` parts in the legacy converter

The v1/standard path (`convertStandardContentMessageToGeminiContent`, line 171) is equally
broken: it only processes `message.contentBlocks`, and only handles `ToolMessage`, not
`AIMessage` with `tool_calls`.

The `functionCall` handling that *does* exist (line 315) only fires for legacy Gemini-native
content blocks placed directly inside `message.content`, not for the `tool_calls` array.

---

## Proposed fix

After the existing `message.content` processing block (line 324), add:

```js
// Convert standard LangChain tool_calls to Gemini functionCall parts
if (AIMessage.isInstance(message) && message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
        parts.push({
            functionCall: {
                id: tc.id,
                name: tc.name,
                args: tc.args,
            },
        });
    }
}
```

---

## Workaround (no project-level workaround possible)

There is no clean workaround. The dropped model turn means the Gemini API receives:

```
[HumanMessage] → [ToolMessage] → [ToolMessage] → [HumanMessage]
```

instead of the correct:

```
[HumanMessage] → [AIMessage w/ functionCall] → [ToolMessage] → [ToolMessage] → [HumanMessage]
```

The `functionResponse` turns appear without their preceding `functionCall` turn. In practice,
the Gemini API accepts this (likely treating the responses as orphaned), but the model loses
the context of which calls it made and why.

The only partial mitigation is the `triageResponse.name = toolCall.name` workaround documented
in [langchain-google-tool-response-name-unknown.md](./langchain-google-tool-response-name-unknown.md),
which at least gives the orphaned `functionResponse` blocks the correct name — but the model
turn itself remains absent.

---

## Impact

- The model receives no record of its own tool call decisions in multi-turn conversations.
- Conversation history sent to the API is structurally invalid (responses without a preceding
  call turn).
- Context continuity across tool-use turns is silently broken.
- Regression test: `tests/unit/llm/langchainGoogleBugs.test.ts` —
  `"ToolMessage name is 'unknown' in functionResponse (legacy path bug snapshot)"` —
  the snapshot explicitly shows the AIMessage model turn absent from `contents`.
