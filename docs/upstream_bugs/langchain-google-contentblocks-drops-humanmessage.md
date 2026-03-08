# Bug: HumanMessage with certain `contentBlocks` types is silently dropped from Gemini contents

**Package:** `@langchain/google`
**Version:** `0.1.5`
**Companion:** `@langchain/core` `1.1.30`
**Date discovered:** 2026-03-08
**Affected function:** `convertMessagesToGeminiContents` + `convertStandardContentMessageToGeminiContent`
in `src/converters/messages.ts`

---

## Summary

A `HumanMessage` constructed with the `contentBlocks` constructor argument (LangChain v1 format)
is silently dropped from the `contents` array sent to the Gemini API when any of its blocks
have types that `convertStandardContentBlockToGeminiPart` does not recognize (e.g. `"file"`,
`"text-plain"`, or the Gemini-specific `"media"` type). Unrecognized block types return `null`
from the switch, and if all blocks in a message return `null`, the converter returns `null` for
the whole message, which `convertMessagesToGeminiContents` then filters out.

The practical effect in a multi-turn conversation is that the user's most recent message
disappears from the request. When tool calls were also in the history, this caused the
Gemini API to respond with:

```
Please ensure that function call turn comes immediately after a user turn
or after a function response turn.
```

---

## How the two converter paths work

`convertMessagesToGeminiContents` dispatches each message to one of two converters depending
on `response_metadata.output_version`:

```js
// src/converters/messages.ts (compiled: dist/converters/messages.js ~line 381)
switch ("output_version" in message.response_metadata
    ? message.response_metadata?.output_version
    : "v0")
{
    case "v1":  return convertStandardContentMessageToGeminiContent(message);
    default:    return convertLegacyContentMessageToGeminiContent(message, messages);
}
```

When a message is constructed with `contentBlocks:`, `@langchain/core`'s `BaseMessage`
constructor automatically sets `response_metadata.output_version = "v1"`:

```js
// @langchain/core — BaseMessage constructor
if (fields.content === void 0 && fields.contentBlocks !== void 0) {
    this.content = fields.contentBlocks;
    this.response_metadata = { output_version: "v1", ...fields.response_metadata };
}
```

So `contentBlocks:` → `output_version: "v1"` → **v1 path**.
Messages constructed with `content:` have no `output_version` → **legacy path**.

---

## What `convertStandardContentBlockToGeminiPart` handles

The v1 path calls this function on every block. Its switch statement covers only four types:

```js
// dist/converters/messages.js ~line 156
function convertStandardContentBlockToGeminiPart(block) {
    switch (block.type) {
        case "text":  return { text: block.text };
        case "image":
        case "audio": return convertStandardDataContentBlockToGeminiPart(block);
        case "video": return convertStandardVideoContentBlockToGeminiPart(block);
        default:      return null;   // ← everything else is silently dropped
    }
}
```

`@langchain/core` exports a `KNOWN_BLOCK_TYPES` constant that includes five types:
`"image"`, `"video"`, `"audio"`, `"text-plain"`, `"file"`. Of these, only three are handled
by the switch. `"text-plain"` and `"file"` fall through to `default: return null`.

Notably absent from the switch is `"media"` — the Gemini-specific type used in the legacy
converter.

### Which block shapes work in the v1 path

For the three handled types, `convertStandardDataContentBlockToGeminiPart` further requires
specific field combinations (`mimeType` must be named `mimeType`, not `mime_type`):

| Block shape | Result |
|---|---|
| `{ type: "image"\|"audio"\|"video", mimeType, data }` | `{ inlineData: { mimeType, data } }` ✓ |
| `{ type: "image"\|"audio"\|"video", mimeType, url }` | `{ fileData: { mimeType, fileUri: url } }` ✓ |
| `{ type: "text-plain", ... }` | `null` — not in switch ✗ |
| `{ type: "file", ... }` | `null` — not in switch ✗ |
| `{ type: "media", mimeType, fileUri }` | `null` — not in switch ✗ |
| `{ type: "media", mimeType, data }` | `null` — not in switch ✗ |

Note: the `contentBlocks` getter normalizes blocks through `convertToV1FromDataContent`,
`convertToV1FromChatCompletionsInput`, and `convertToV1FromAnthropicInput`. These transforms
only affect blocks with `source_type: "url"|"base64"|"id"` (the older deprecated
`DataContentBlock` format). Blocks without `source_type` pass through unchanged.

---

## The original failure and how we got to the fix

**Original code** used `contentBlocks` with types from `KNOWN_BLOCK_TYPES` via a
`getBlockType(mimeType)` helper, producing blocks like:

```ts
// inline attachments
new HumanMessage({
    contentBlocks: [
        { type: "text", text: userMessage },
        { type: "image", mimeType: "image/png", data: base64Data },
    ],
});

// Gemini Files API uploads
new HumanMessage({
    contentBlocks: [
        { type: "text", text: userMessage },
        { type: "video", mimeType: "video/mp4", url: geminiFileUri },
    ],
});
```

Blocks typed `"image"` or `"video"` with `mimeType` present would actually produce valid
Gemini parts in the v1 path. However, **blocks typed `"file"` or `"text-plain"`** (which
`getBlockType` returned for document and plain-text MIME types) hit `default: return null`.
When an attachment-only message contained only such types, `parts` was empty and the entire
`HumanMessage` was dropped.

**First attempted fix**: switched from `contentBlocks:` to `content:` while keeping the same
block shapes (`{ type: "video", mimeType, url }`, etc.). This routes through the legacy path,
but the legacy path's `isMessageContentMedia` checks `content.type === "media"` — it does not
match `"video"`, `"image"`, etc. Those blocks fall to `else parts.push(item)`, pushing a raw
`{ type: "video", mimeType, url }` object that is not a valid Gemini part.

**Final fix**: used `content:` with blocks explicitly typed `"media"` and `fileUri`/`data`:

```ts
// inline attachment — legacy path, isMessageContentMedia matches
new HumanMessage({
    content: [
        { type: "text", text: userMessage },
        { type: "media", mimeType: "image/png", data: base64Data },
    ],
});

// Gemini Files API upload — legacy path, isMessageContentMedia matches
new HumanMessage({
    content: [
        { type: "text", text: userMessage },
        { type: "media", mimeType: "video/mp4", fileUri: geminiFileUri },
    ],
});
```

`isMessageContentMedia` (`content.type === "media"`) matches; `messageContentMediaData`
produces `{ inlineData: { mimeType, data } }` or `{ fileData: { fileUri, mimeType } }`.

---

## Root cause analysis

The v1 path (`convertStandardContentMessageToGeminiContent`) and the legacy path
(`convertLegacyContentMessageToGeminiContent`) support disjoint sets of block types for
Gemini media:

- **v1 path** knows `"image"`, `"video"`, `"audio"` — the standard LangChain block types —
  but only when `mimeType` (not `mime_type`) is present alongside `data` or `url`.
- **Legacy path** knows `"media"` — the Gemini-specific type — but not `"image"`, `"video"`,
  etc.

There is no single block format that works correctly with *both* paths. Using `contentBlocks:`
forces the v1 path, which silently drops `"media"` blocks. Using `content:` with `"image"` /
`"video"` typed blocks produces structurally invalid Gemini parts (raw objects, not
`inlineData`/`fileData`). The only reliable path to valid Gemini media parts is `content:`
with `"media"` typed blocks via the legacy path.

---

## Suggested upstream fixes

1. **Add `"media"` to the v1 switch** in `convertStandardContentBlockToGeminiPart`, mapping
   `{ type: "media", mimeType, fileUri }` → `{ fileData }` and `{ type: "media", mimeType, data }`
   → `{ inlineData }`. This would make `contentBlocks` work for Gemini-native media blocks.

2. **Emit a warning or error when `parts` is empty** for a non-`SystemMessage` in either
   converter, rather than silently returning `null`. A dropped non-system message is always
   a bug, not an expected condition.

3. **Add `"text-plain"` and `"file"` cases** to `convertStandardContentBlockToGeminiPart`
   so all `KNOWN_BLOCK_TYPES` from `@langchain/core` are handled, even if only by mapping
   to `{ text }` or throwing a descriptive error.
