# Bug: `functionResponse.name` always "unknown" in legacy message converter

**Package:** `@langchain/google`
**Version:** `0.1.5`
**Companion:** `@langchain/core` `1.1.30`
**Date discovered:** 2026-03-08
**Affected function:** `convertLegacyContentMessageToGeminiContent` in `src/converters/messages.ts`

---

## Summary

When a `ToolMessage` is converted to a Gemini API `functionResponse` content block via the
legacy message converter, the `name` field of the response is always `"unknown"` instead of
the actual tool/function name. This causes a mismatch between the `functionCall.name` in the
model's prior turn and the `functionResponse.name` in the reply turn, which can cause the
Gemini API to reject the request or silently mis-attribute the response.

---

## Root cause

In `convertLegacyContentMessageToGeminiContent`, the code looks up the `AIMessage` that
contains a matching `tool_call_id`, then reads `.name` from that AIMessage:

```js
// src/converters/messages.ts (compiled: dist/converters/messages.js ~line 327)
const toolCall = messages
    .filter(AIMessage.isInstance)
    .find((msg) => msg.tool_calls?.find((tc) => tc.id === message.tool_call_id));

if (!toolCall) throw new ToolCallNotFoundError(message.tool_call_id);

parts.push({
    functionResponse: {
        id: message.tool_call_id,
        name: toolCall?.name || "unknown",   // <-- BUG: reads AIMessage.name
        response: { result: responseContent },
    },
});
```

The variable is named `toolCall` but is actually the **AIMessage** that contains the matching
call. `AIMessage.name` is the participant/author name field (a `BaseMessage` property), not
the name of the function that was called. It is `undefined` in the typical case, so the
expression falls back to `"unknown"`.

The fix should look up the specific tool call **within** the found AIMessage:

```js
// Proposed fix
const aiMsg = messages
    .filter(AIMessage.isInstance)
    .find((msg) => msg.tool_calls?.find((tc) => tc.id === message.tool_call_id));

if (!aiMsg) throw new ToolCallNotFoundError(message.tool_call_id);

const matchedToolCall = aiMsg.tool_calls?.find((tc) => tc.id === message.tool_call_id);

parts.push({
    functionResponse: {
        id: message.tool_call_id,
        name: matchedToolCall?.name ?? message.name ?? "unknown",
        response: { result: responseContent },
    },
});
```

---

## The v1 path does it correctly — inconsistency between paths

The **v1/standard path** (`convertStandardContentMessageToGeminiContent`, used when
`response_metadata.output_version === "v1"`) reads the name correctly from the `ToolMessage`
directly:

```js
// src/converters/messages.ts (compiled: dist/converters/messages.js ~line 191)
parts.push({
    functionResponse: {
        id: message.tool_call_id,
        name: message.name || "unknown",   // reads ToolMessage.name — correct
        response: { result: responseContent },
    },
});
```

So the v1 path works if `name` is set on the `ToolMessage`. The legacy path ignores
`message.name` entirely.

---

## Why `ToolMessage.name` alone doesn't fix it

Setting `name` on the `ToolMessage` constructor (e.g. `new ToolMessage({ ..., name: "get_website" })`)
has no effect when the message goes through the legacy path, because the legacy path never
reads `message.name`.

A message takes the legacy path unless `response_metadata.output_version === "v1"` is set.
`ToolMessage` constructed with the standard `content:` field (not `contentBlocks:`) does not
receive `output_version: "v1"` and therefore always goes through the legacy path.

---

## Workaround (applied in this project)

Before adding the `AIMessage` (triage response) to graph state, set its `.name` to the tool
call name. The legacy converter finds this AIMessage by `tool_call_id` and reads `.name` from
it — the bug reads the wrong object's `.name`, so we populate that wrong object with the
correct value:

```ts
// agentOrchestrator.ts — triageNode
triageResponse.name = toolCall.name;
return new Command({ goto: "executeTool", update: { messages: [triageResponse] } });
```

This works for single-tool-call turns only. For multiple tool calls in one turn it would be
incorrect, because all `ToolMessage`s resolve to the same `AIMessage` and would all receive
the same name.

---

## Impact

- Every `functionResponse` sent to the Gemini API has `name: "unknown"` instead of the actual
  function name.
- The Gemini model cannot match the response to the originating `functionCall`, potentially
  causing silent context loss or an explicit API error.
- Setting `name` on `ToolMessage` has no effect in the legacy path, making the bug invisible
  from the caller's perspective.
