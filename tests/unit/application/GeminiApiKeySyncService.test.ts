import { describe, expect, mock, test } from "bun:test";
import pino from "pino";
import type { IGeminiApiKeyRepository } from "../../../src/application/ports/IGeminiApiKeyRepository.ts";
import { GeminiApiKeySyncService } from "../../../src/application/services/GeminiApiKeySync.ts";
import type { GeminiApiKey } from "../../../src/domain/message/GeminiApiKey.ts";

const testLogger = pino({ level: "silent" });

function makeKey(apiKey: string, isPaid: boolean): GeminiApiKey {
    return { id: `id-${apiKey}`, apiKey, isPaid, lastUsed: false };
}

function makeRepo(): IGeminiApiKeyRepository {
    return {
        upsert: mock(async ({ apiKey, isPaid }) => makeKey(apiKey, isPaid)),
        deactivateNotIn: mock(async () => {}),
        setLastUsed: mock(async () => {}),
    };
}

describe("GeminiApiKeySyncService.sync", () => {
    test("upserts all free keys with isPaid=false and paid key with isPaid=true", async () => {
        const repo = makeRepo();
        const service = new GeminiApiKeySyncService(repo, testLogger);

        await service.sync(["free-key-1", "free-key-2"], "paid-key");

        expect(repo.upsert).toHaveBeenCalledWith({
            apiKey: "free-key-1",
            isPaid: false,
        });
        expect(repo.upsert).toHaveBeenCalledWith({
            apiKey: "free-key-2",
            isPaid: false,
        });
        expect(repo.upsert).toHaveBeenCalledWith({
            apiKey: "paid-key",
            isPaid: true,
        });
        expect(repo.upsert).toHaveBeenCalledTimes(3);
    });

    test("returns freeKeys and paidKey split from upserted records", async () => {
        const repo = makeRepo();
        const service = new GeminiApiKeySyncService(repo, testLogger);

        const { freeKeys, paidKey } = await service.sync(["free-key-1", "free-key-2"], "paid-key");

        expect(freeKeys).toHaveLength(2);
        expect(freeKeys[0]?.apiKey).toBe("free-key-1");
        expect(freeKeys[0]?.isPaid).toBe(false);
        expect(freeKeys[1]?.apiKey).toBe("free-key-2");
        expect(freeKeys[1]?.isPaid).toBe(false);
        expect(paidKey?.apiKey).toBe("paid-key");
        expect(paidKey?.isPaid).toBe(true);
    });

    test("calls deactivateNotIn with all key strings to deactivate orphaned rows", async () => {
        const repo = makeRepo();
        const service = new GeminiApiKeySyncService(repo, testLogger);

        await service.sync(["free-key-1", "free-key-2"], "paid-key");

        expect(repo.deactivateNotIn).toHaveBeenCalledWith(["free-key-1", "free-key-2", "paid-key"]);
        expect(repo.deactivateNotIn).toHaveBeenCalledTimes(1);
    });

    test("works with a single free key", async () => {
        const repo = makeRepo();
        const service = new GeminiApiKeySyncService(repo, testLogger);

        const { freeKeys, paidKey } = await service.sync(["only-free"], "paid-key");

        expect(freeKeys).toHaveLength(1);
        expect(freeKeys[0]?.apiKey).toBe("only-free");
        expect(paidKey?.apiKey).toBe("paid-key");
        expect(repo.upsert).toHaveBeenCalledTimes(2);
        expect(repo.deactivateNotIn).toHaveBeenCalledWith(["only-free", "paid-key"]);
    });

    test("skips paid key upsert when paidApiKey is null", async () => {
        const repo = makeRepo();
        const service = new GeminiApiKeySyncService(repo, testLogger);

        const { freeKeys, paidKey } = await service.sync(["free-key"], null);

        expect(freeKeys).toHaveLength(1);
        expect(paidKey).toBeNull();
        expect(repo.upsert).toHaveBeenCalledTimes(1);
        expect(repo.upsert).toHaveBeenCalledWith({ apiKey: "free-key", isPaid: false });
        expect(repo.deactivateNotIn).toHaveBeenCalledWith(["free-key"]);
    });

    test("skips free key upserts when freeApiKeys is null", async () => {
        const repo = makeRepo();
        const service = new GeminiApiKeySyncService(repo, testLogger);

        const { freeKeys, paidKey } = await service.sync(null, "paid-key");

        expect(freeKeys).toHaveLength(0);
        expect(paidKey?.apiKey).toBe("paid-key");
        expect(repo.upsert).toHaveBeenCalledTimes(1);
        expect(repo.upsert).toHaveBeenCalledWith({ apiKey: "paid-key", isPaid: true });
        expect(repo.deactivateNotIn).toHaveBeenCalledWith(["paid-key"]);
    });

    test("upserts before deactivating, ensuring keys are not orphaned prematurely", async () => {
        const callOrder: string[] = [];
        const repo: IGeminiApiKeyRepository = {
            upsert: mock(async ({ apiKey }) => {
                callOrder.push(`upsert:${apiKey}`);
                return makeKey(apiKey, false);
            }),
            deactivateNotIn: mock(async () => {
                callOrder.push("deactivateNotIn");
            }),
            setLastUsed: mock(async () => {}),
        };
        const service = new GeminiApiKeySyncService(repo, testLogger);

        await service.sync(["free-key"], "paid-key");

        // All upserts must precede deactivateNotIn
        const deactivateIdx = callOrder.indexOf("deactivateNotIn");
        const upsertIdxs = callOrder.map((e, i) => (e.startsWith("upsert:") ? i : -1)).filter((i) => i !== -1);
        for (const upsertIdx of upsertIdxs) {
            expect(upsertIdx).toBeLessThan(deactivateIdx);
        }
    });
});
