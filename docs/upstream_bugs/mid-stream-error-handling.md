# Bug: mid-stream Gemini errors are silently swallowed by `@langchain/google`

**Status:** Shelved (2026-09-17). Out of scope for now; nothing in this plan is implemented.

**Affected versions:** `@langchain/google` 0.2.3, `@langchain/core` 1.2.9, `eventsource-parser` 3.1.1

**Upstream issue:** not filed yet

## Problem

When a streaming generation fails partway through (e.g. the model gets overloaded), Gemini has
already sent `200 OK` and some `data:` events. It then writes the error as **plain JSON with no
`data:` prefix** and closes the connection:

```text
data: {"candidates": [{"content": {"parts": [{"text": "**No, you"}],"role": "model"},"index": 0}], ...}

data: {"candidates": [{"content": {"parts": [{"text": " cannot play with or swing the swords.** ..."}],"role": "model"},"index": 0}], ...}

{
  "error": {
    "code": 503,
    "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
    "status": "UNAVAILABLE"
  }
}
```

### What the adapter does

- `eventsource-parser` reads each line of the error object (`{`, `"error": {`, …) as an unknown SSE
  field and reports it through `onError` (`processField`, default branch).
- `@langchain/google` constructs `new EventSourceParserStream()` without an `onError`
  (`dist/chat_models/base.js`, `_streamResponseChunks`), so those lines are dropped. No event is
  dispatched, nothing is thrown, and the stream ends as if it had completed normally.
- Even if the error arrived as a `data:` event, the streaming path skips events without candidates
  (`if (!candidate) return;`). The chunks it builds carry only content, tool calls, usage,
  `finishReason`, `finishMessage` and safety ratings, so no other field can reach the caller.

Google's own SDK treats this shape as an error: `@google/genai` 2.19.0 parses the raw stream for
`{"error": …}` and throws `ApiError` with the status (`dist/node/index.mjs`, around line 13800).

### What the app does as a result

- **Error after some text:** `streamingInvoke` in `src/infrastructure/llm/ResilientModelInvoker.ts`
  sees no finish reason, so it returns the partial text with `wasInterrupted: true`. Discord shows
  the partial with the "interrupted, Retry" footer. The 503 never reaches `isModelFallbackError`, so
  the fallback model is never tried, and a mid-stream 429 never triggers key rotation.
- **Error before any text:** the adapter emits no chunks, so `firstResult.done` throws the generic
  `"Model stream completed without emitting any chunks"`. `is503Error` doesn't match that message,
  so this is not routed to the fallback model either.
- Nothing is logged or sent to Sentry, because no error is ever raised.

The temporary wire tap (`src/infrastructure/llm/debug/GeminiWireTap.ts`, currently disabled; see
the comment in `src/index.ts` to re-enable it) labels these captures `ADAPTER-IGNORED-ERROR` in
`logs/geminiWireTap/`.

## Approach

Report the error as data instead of throwing it through the stream, and decide what to do with it
in one place after the stream has been consumed, next to the existing finish-reason check.

1. A `ChatGoogle` subclass detects the raw error at the transport level and emits one extra
   `AIMessageChunk` carrying the error in `response_metadata.stream_error`.
2. `streamingInvoke` reads `stream_error` after iteration and rethrows 503 and 429 as a typed error
   when the interrupted message is too short to be worth keeping. The existing `catch` in
   `invokeWithKeyRotation` then routes it: 503 to the fallback model, 429 to key rotation.

`response_metadata` is the canonical place: LangChain puts finish reasons, token usage and logprobs
there, while `additional_kwargs` is the older provider-payload bucket.

## Implementation steps

### 1. Stream-error-aware `ChatGoogle` base class

Add `src/infrastructure/llm/models/StreamErrorAwareChatGoogle.ts`, extending `ChatGoogle` from
`@langchain/google/node`.

**API client wrapper.** In the constructor, after `super(params)`, replace the `protected apiClient`
with a wrapper that delegates `hasApiKey`, `getProjectId` and `fetch` to the original, so the
library's own authentication is kept. Its `fetch`:

- Reads and **deletes** a per-call correlation header (e.g. `x-genie-stream-id`) from the request
  before delegating, so it never reaches Google.
- Leaves non-OK responses and responses without a body untouched; the adapter already raises
  `RequestError` for those.
- Wraps the body in a `ReadableStream` that passes every byte through unchanged while keeping a
  bounded tail of the decoded text (e.g. the last 64 KB).
- When the body ends, takes the text after the last SSE event boundary (`\r\n\r\n`, `\n\n` or
  `\r\r`). If it isn't a `data:` field and parses as JSON with an `error` object, it records that
  object in a `Map` keyed by the correlation id. Detection happens at the end of the body rather than
  per network chunk, so an error object split across chunks is still caught.

**`_streamResponseChunks` override.**

- Generates an id (`randomUUIDv7` from `"bun"`) and calls
  `super._streamResponseChunks(messages, { ...options, customHeaders: { ...options.customHeaders, [header]: id } }, runManager)`.
  The id is needed because model instances are cached and shared by concurrent requests, so an
  instance-level field would mix up errors between streams.
- Yields every chunk from `super` unchanged.
- Afterwards, if an error was recorded for the id, yields one extra chunk carrying the error object
  **verbatim**, exactly as it appeared on the wire (`code`, `message`, `status` and any other fields):

  ```ts
  new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({ content: [], response_metadata: { stream_error: error } }),
  });
  ```

  Google closes the connection right after sending the error, so "after `super` finishes" is the
  point where the error appears in the stream.
- Deletes the map entry in a `finally` block, so abandoned or failed streams don't leak entries.

**Wiring.**

- `ValidatedChatGoogle` extends `StreamErrorAwareChatGoogle` instead of `ChatGoogle`.
- `computationModel.ts` and both constructions in `triageModel.ts` use `StreamErrorAwareChatGoogle`
  instead of plain `ChatGoogle`.

**Optional, same wrapper:** when the body ends and the last SSE event is complete JSON without its
terminating blank line, append `\r\n\r\n` before closing. That fixes `ADAPTER-DROPPED-FINAL-EVENT`:
`eventsource-parser` has no end-of-stream flush and silently discards an unterminated final event,
which usually carries `finishReason`.

### 2. Keep `concatMessageChunks` and `normalizeContent` safe

The extra chunk must use `content: []`, not `content: ""`. Measured with the current helpers in
`src/infrastructure/llm/utils/langchainUtils.ts`:

| Error chunk content | After a text chunk | After a `functionCall` block | As the only chunk |
|---|---|---|---|
| `""` | content unchanged | **stray `{ type: "text", text: "" }` appended** | `[{ type: "text", text: "" }]` |
| `[]` | content unchanged | content unchanged | `[]` |

In both cases `response_metadata.stream_error` survives the merge and `model_provider` is kept.

Add tests next to the existing coverage in `tests/unit/llm/langchainBugs.test.ts` asserting that
appending the error chunk:

- after a text chunk, a thought (`thought: true`) chunk, and a `functionCall` chunk leaves the
  collected content identical to the same stream without the error chunk;
- as the only chunk produces `content: []` without throwing;
- preserves `response_metadata.stream_error` and the other `response_metadata` keys.

If any of these fail, fix `normalizeContent` rather than the chunk shape.

### 3. Decision logic in `streamingInvoke`

At the top of `src/infrastructure/llm/ResilientModelInvoker.ts`:

```ts
/**
 * A mid-stream 503 or 429 is rethrown (so the fallback model or key rotation takes over) only when
 * the interrupted message's visible text is shorter than this; longer partials are kept.
 * TODO: move to config (config.default.yaml + AppConfig schema) and inject it through the
 * constructor, like globalModelTimeoutMs.
 */
const MAX_INTERRUPTED_CHARS_TO_RETHROW = 100;
```

After iteration, where `finishReason` is parsed today:

1. Read `message.response_metadata.stream_error` through a type guard, e.g. a zod v4 schema
   `{ code: number, message: string, status: string }` that allows extra fields.
2. Measure the interrupted message as `extractContent(message.content).length` from
   `src/application/helpers/langchainMessageTransformers.ts`. That is the text users would see:
   thought parts and tool calls are excluded.
3. If `stream_error.code` is 503 or 429 **and** that length is `< MAX_INTERRUPTED_CHARS_TO_RETHROW`,
   throw a new `GeminiStreamError`.
   - Add it to `src/domain/errors/AppError.ts`, extending `LlmError`.
   - It exposes `status` (the numeric code), because `is503Error` and `is429Error` match on
     `status`. Its message includes Google's `status` and `message`, and `cause` is the raw error.
   - `streamingInvoke` is called inside the `try` in `invokeWithKeyRotation`, so the existing
     `catch` routes it with no further changes: 503 goes to the fallback model, 429 to key rotation.
4. Otherwise return as today. The message has no finish reason, so `wasInterrupted` stays `true`.
   Log a warning with `stream_error`, since LangChain callbacks (Sentry, LangSmith) record these
   runs as successes.

Notes:

- Other codes (e.g. 500 `INTERNAL`) are never rethrown by this rule; the partial is kept.
- An error before any text now arrives as a chunk, so the length is 0 and 503/429 are rethrown.
  The `firstResult.done` check stays as is.
- When the fallback model or every key also fails, the error surfaces through the existing
  exhaustion paths. There is no last-resort partial for short messages.

### 4. Tests

**Base class** (`tests/unit/llm/streamErrorAwareChatGoogle.test.ts`, fake global `fetch` like the
existing ChatGoogle tests):

- raw 503 after text: the final collected message has the text and `stream_error`;
- raw 503 before any text: exactly one chunk, carrying `stream_error`;
- clean stream: no extra chunk and no `stream_error`;
- the correlation header is not present on the request that reaches `fetch`;
- two concurrent streams on one instance, only one of which errors: only that one gets `stream_error`;
- non-OK responses still raise `RequestError`;
- response bytes reach the adapter unchanged.

**Decision logic** (`tests/unit/llm/resilientModelInvoker.test.ts`):

- 503 with fewer than 100 visible characters: fallback model invoked;
- 429 with fewer than 100 visible characters: next key used;
- 503 with exactly 100 or more visible characters: partial returned, `wasInterrupted: true`;
- thought-only text over 100 characters with no visible text: still rethrown;
- 500 with a short partial: partial returned, not rethrown.

**Regression tests against upstream changes** (in `tests/unit/llm/langchainGoogleBugs.test.ts`):

- Bare `ChatGoogle` still swallows the raw error: the stream completes without throwing and without
  any error on the collected message. When this fails, upstream has started handling the error;
  revisit whether the workaround is still needed or now duplicates it.
- The seams the subclass depends on still work: the `customHeaders` call option reaches the
  `Request` passed to `apiClient.fetch`, reassigning `apiClient` in a subclass constructor is used
  by `.stream()`, and `.stream()` goes through `_streamResponseChunks` (not
  `_streamChatModelEvents`, which this plan does not cover).

### 5. Cleanup

- Remove the temporary wire tap once this is verified in production: `src/infrastructure/llm/debug/`,
  its two test files, and the re-enable comment in `src/index.ts`.
- File the upstream issue on `langchain-ai/langchainjs` with the wire capture above and the
  `@google/genai` comparison, and link it at the top of this document.
