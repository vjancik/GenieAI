import { describe, expect, mock, test } from "bun:test";
import type { GeminiApiKey } from "../../../src/domain/entities/GeminiApiKey.ts";
import { ConfigError } from "../../../src/domain/errors/AppError.ts";
import { RoundRobinKeyProvider } from "../../../src/infrastructure/llm/RoundRobinKeyProvider.ts";

function makeKeys(count: number, lastUsedIndex?: number): GeminiApiKey[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `k${i + 1}`,
        apiKey: `key-${i + 1}`,
        isPaid: false,
        lastUsed: i === lastUsedIndex,
    }));
}

function makeStore() {
    return { setLastUsed: mock(async (_id: string) => {}) };
}

describe("RoundRobinKeyProvider", () => {
    test("rotates through the keys in order and wraps around", () => {
        const provider = new RoundRobinKeyProvider(makeKeys(3));

        expect(provider.keyCount).toBe(3);
        expect(provider.currentKey.id).toBe("k1");
        expect(provider.nextKey().id).toBe("k2");
        expect(provider.currentKey.id).toBe("k2");
        expect(provider.nextKey().id).toBe("k3");
        expect(provider.nextKey().id).toBe("k1");
    });

    describe("with a cursor store", () => {
        test("resumes from the key marked as last used", () => {
            const provider = new RoundRobinKeyProvider(makeKeys(3, 1), makeStore());

            expect(provider.currentKey.id).toBe("k2");
        });

        test("starts from the first key when none is marked as last used", () => {
            const provider = new RoundRobinKeyProvider(makeKeys(3), makeStore());

            expect(provider.currentKey.id).toBe("k1");
        });

        test("persists the new key on every rotation", () => {
            const store = makeStore();
            const provider = new RoundRobinKeyProvider(makeKeys(2), store);

            provider.nextKey();
            provider.nextKey();

            expect(store.setLastUsed.mock.calls).toEqual([["k2"], ["k1"]]);
        });
    });

    describe("without a cursor store", () => {
        test("starts from the first key even when another one is marked as last used", () => {
            const provider = new RoundRobinKeyProvider(makeKeys(3, 2));

            expect(provider.currentKey.id).toBe("k1");
        });
    });

    describe("with an empty pool", () => {
        test("constructs, reporting no keys", () => {
            expect(new RoundRobinKeyProvider([]).keyCount).toBe(0);
        });

        test("throws ConfigError when a key is requested", () => {
            const provider = new RoundRobinKeyProvider([]);

            expect(() => provider.currentKey).toThrow(ConfigError);
            expect(() => provider.nextKey()).toThrow(ConfigError);
        });
    });
});
