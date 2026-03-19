# Bug: `ChatGoogle.invoke()` ignores `RunnableConfig.timeout` — non-streaming path drops the AbortSignal

**Package:** `@langchain/google`
**Version confirmed:** `0.1.6`, `0.1.7` (with `@langchain/core` up to `1.1.34`)
**Affects:** non-streaming `.invoke()` calls (i.e. `streaming: false`, which is the default)
**Does NOT affect:** streaming path (`.stream()` / `streaming: true`)

---

## Summary

Passing `{ timeout: N }` to `ChatGoogle.invoke()` has no effect. If the Gemini API stalls, the call hangs indefinitely regardless of the configured timeout. The abort signal that `@langchain/core` creates from the timeout value is fully formed and reachable inside `_generate`, but it is silently dropped when the library constructs the `Request` object for the `generateContent` fetch call.

---

## Root cause — exact location

`@langchain/core` converts `RunnableConfig.timeout` into an `AbortSignal` inside `ensureConfig` (`runnables/config.js`):

```js
// @langchain/core — runnables/config.js
const timeoutSignal = AbortSignal.timeout(originalTimeoutMs);
// merged with any existing signal, then stored as config.signal
empty.signal = timeoutSignal; // (or AbortSignal.any([...]) if there was already a signal)
delete empty.timeout;         // timeout is consumed here; signal is the sole carrier from now on
```

This signal is then passed as `options.signal` all the way down the runnable chain. `@langchain/core` also wraps the `_generate` return value with `raceWithSignal(promise, options.signal)`, which will reject the outer promise as soon as the signal fires — **but only if the inner fetch is already settled or the signal actually fires**.

The problem is in `BaseChatGoogle._generate` (`chat_models/base.js`). The **non-streaming** branch (lines ~190–194 in the compiled output) creates the `Request` object without the signal:

```js
// @langchain/google — chat_models/base.js  (_generate, non-streaming branch)
const response = await this.apiClient.fetch(new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // ← options.signal is available here but is never passed
}));
```

Because `fetch` receives no signal, the network request cannot be cancelled. The `fetch` call blocks the microtask queue indefinitely. `raceWithSignal` in `@langchain/core` *does* listen for the abort event and *would* resolve the race — but `_generate` never yields back to the event loop while the fetch is outstanding (it is awaiting it), so the abort event handler and `raceWithSignal`'s rejection promise cannot run until after `fetch` returns. The result is a permanent hang.

By contrast, the **streaming** branch (`_streamResponseChunks`, lines ~248–252) correctly includes the signal:

```js
// @langchain/google — chat_models/base.js  (_streamResponseChunks, streaming branch)
const response = await this.apiClient.fetch(new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal   // ← signal IS wired here
}));
```

This asymmetry means timeouts work for streaming invocations but are silently ignored for non-streaming ones.

---

## Reproduction

```ts
import { ChatGoogle } from "@langchain/google";
import { HumanMessage } from "@langchain/core/messages";

// Intercept fetch and stall forever (honours AbortSignal if passed)
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("generateContent")) {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        // Signal is undefined here — it was never passed by _generate
        console.log("signal passed to fetch:", signal); // → undefined
        return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason));
            // Without the signal this promise never settles
        });
    }
    return originalFetch(input, init);
};

const model = new ChatGoogle({ model: "gemini-2.5-flash", apiKey: "any-key" });

const start = Date.now();
try {
    // This call hangs forever; the timeout is never respected
    await model.invoke([new HumanMessage("Hello")], { timeout: 500 });
} catch (e) {
    console.log(`Rejected after ${Date.now() - start}ms`); // never reached
}
```

**Observed:** the call hangs indefinitely.
**Expected:** the call rejects with a `TimeoutError` / `AbortError` after ~500 ms.

The signal IS present in `options` inside `_generate` (verified by inspection), but it is not forwarded to the `Request` constructor.

---

## Fix

Add `signal: options.signal` to the `Request` constructor in the non-streaming branch of `_generate`, mirroring what `_streamResponseChunks` already does:

```js
// _generate — non-streaming branch
const response = await this.apiClient.fetch(new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,  // add this line
}));
```

---

## Workaround (until fixed)

Wrap the `invoke` call in a manual `Promise.race` with your own `AbortSignal`:

```ts
async function invokeWithTimeout(model, messages, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);
    try {
        return await Promise.race([
            model.invoke(messages),
            new Promise((_, reject) => {
                controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
```

Note that this workaround lets the underlying fetch continue to run in the background (it will never be cancelled), which means the API call still completes and consumes quota — it just does not block your application.
