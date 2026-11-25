import { describe, expect, mock, test } from "bun:test";
import type { IRoundRobinKeyProvider } from "../../../src/application/ports/IRoundRobinKeyProvider.ts";
import { runWithKeyRotation } from "../../../src/application/services/runWithKeyRotation.ts";

type Key = { id: string };

/** A key pool over `ids` whose cursor can also be advanced from outside, like a concurrent request would. */
function makeProvider(ids: string[]) {
    let index = 0;
    const provider = {
        get currentKey(): Key {
            return { id: ids[index] as string };
        },
        nextKey: mock((): Key => {
            index = (index + 1) % ids.length;
            return { id: ids[index] as string };
        }),
        keyCount: ids.length,
        advanceExternally() {
            index = (index + 1) % ids.length;
        },
    };
    return provider satisfies IRoundRobinKeyProvider<Key>;
}

describe("runWithKeyRotation", () => {
    test("returns the first attempt's value without rotating", async () => {
        const provider = makeProvider(["a", "b"]);

        const result = await runWithKeyRotation(provider, async () => ({ kind: "success", value: 42 }));

        expect(result).toEqual({ kind: "success", value: 42, key: { id: "a" }, attemptCount: 1 });
        expect(provider.nextKey).not.toHaveBeenCalled();
    });

    test("rotates past unusable keys and leaves the cursor on the key that worked", async () => {
        const provider = makeProvider(["a", "b", "c"]);
        const attempt = mock(async (key: Key, _attemptIndex: number) =>
            key.id === "c"
                ? { kind: "success" as const, value: key.id }
                : { kind: "keyUnusable" as const, error: key.id },
        );

        const result = await runWithKeyRotation(provider, attempt);

        expect(result).toEqual({ kind: "success", value: "c", key: { id: "c" }, attemptCount: 3 });
        expect(attempt.mock.calls.map(([key, index]) => [key.id, index])).toEqual([
            ["a", 0],
            ["b", 1],
            ["c", 2],
        ]);
        expect(provider.currentKey.id).toBe("c");
    });

    test("reports exhaustion with the last key's error after trying every key once", async () => {
        const provider = makeProvider(["a", "b"]);
        const attempt = mock(async (key: Key) => ({ kind: "keyUnusable" as const, error: `${key.id} failed` }));

        const result = await runWithKeyRotation(provider, attempt);

        expect(result).toEqual({ kind: "exhausted", lastError: "b failed" });
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    test("reports an empty pool as exhausted without attempting", async () => {
        const attempt = mock(async () => ({ kind: "success" as const, value: 1 }));

        const result = await runWithKeyRotation(makeProvider([]), attempt);

        expect(result).toEqual({ kind: "exhausted", lastError: undefined });
        expect(attempt).not.toHaveBeenCalled();
    });

    test("does not advance the cursor again when a concurrent request already moved it", async () => {
        const provider = makeProvider(["a", "b", "c"]);

        await runWithKeyRotation(provider, async (key) => {
            if (key.id !== "a") return { kind: "success", value: key.id };
            provider.advanceExternally();
            return { kind: "keyUnusable", error: "a failed" };
        });

        // "b" is tried next instead of being skipped
        expect(provider.nextKey).not.toHaveBeenCalled();
        expect(provider.currentKey.id).toBe("b");
    });

    test("propagates errors thrown by an attempt without rotating", async () => {
        const provider = makeProvider(["a", "b"]);

        const run = runWithKeyRotation(provider, async () => {
            throw new Error("bad request");
        });

        await expect(run).rejects.toThrow("bad request");
        expect(provider.nextKey).not.toHaveBeenCalled();
    });
});
