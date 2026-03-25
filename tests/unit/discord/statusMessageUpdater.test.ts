import { describe, expect, mock, test } from "bun:test";
import pino from "pino";
import { StatusMessageUpdater } from "../../../src/application/services/StatusMessageUpdater.ts";

const testLogger = pino({ level: "silent" });

/** Short rate limit for tests so waits stay under ~100ms total. */
const RATE_MS = 50;

/** Wait long enough for the rate limit timer to fire. */
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("StatusMessageUpdater", () => {
    test("never fires synchronously — always deferred even with no prior edit", () => {
        const updater = new StatusMessageUpdater(testLogger, RATE_MS);
        const editFn = mock(async () => {});

        updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status A");

        // Must NOT have fired yet — always deferred by rateLimitMs
        expect(editFn).toHaveBeenCalledTimes(0);
    });

    test(
        "fires after rateLimitMs when channel has no prior edit",
        async () => {
            const updater = new StatusMessageUpdater(testLogger, RATE_MS);
            const editFn = mock(async () => {});

            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status A");
            expect(editFn).toHaveBeenCalledTimes(0);

            await wait(RATE_MS + 20);

            expect(editFn).toHaveBeenCalledTimes(1);
            expect(editFn).toHaveBeenCalledWith("Status A");
        },
        { retry: 5 },
    );

    test("does not fire a second time when a new update arrives while timer is pending", () => {
        const updater = new StatusMessageUpdater(testLogger, RATE_MS);
        const editFn = mock(async () => {});

        updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status A");
        updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status B");

        // Still zero — timer not fired yet and no second timer was created
        expect(editFn).toHaveBeenCalledTimes(0);
    });

    test(
        "fires once with the latest content when multiple updates arrive before timer",
        async () => {
            const updater = new StatusMessageUpdater(testLogger, RATE_MS);
            const editFn = mock(async () => {});

            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status A");
            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status B");
            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status C");
            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status D");

            await wait(RATE_MS + 20);

            // Exactly one edit, with the last content
            expect(editFn).toHaveBeenCalledTimes(1);
            expect(editFn).toHaveBeenCalledWith("Status D");
        },
        { retry: 5 },
    );

    test(
        "subsequent update after first fires uses remaining rate limit delay",
        async () => {
            const updater = new StatusMessageUpdater(testLogger, RATE_MS);
            const editFn = mock(async () => {});

            // First update — fires after RATE_MS
            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status A");
            await wait(RATE_MS + 20);
            expect(editFn).toHaveBeenCalledTimes(1);

            // Second update arrives immediately after — fires after another ~RATE_MS
            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status B");
            expect(editFn).toHaveBeenCalledTimes(1); // not yet

            await wait(RATE_MS + 20);
            expect(editFn).toHaveBeenCalledTimes(2);
            expect(editFn).toHaveBeenLastCalledWith("Status B");
        },
        { retry: 5 },
    );

    test(
        "cancel() prevents the pending edit from firing",
        async () => {
            const updater = new StatusMessageUpdater(testLogger, RATE_MS);
            const editFn = mock(async () => {});

            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status A");
            updater.cancel("msg-1");

            await wait(RATE_MS + 20);

            expect(editFn).toHaveBeenCalledTimes(0);
        },
        { retry: 5 },
    );

    test("cancel() is a no-op when there is no pending edit", () => {
        const updater = new StatusMessageUpdater(testLogger, RATE_MS);
        expect(() => updater.cancel("msg-never-seen")).not.toThrow();
    });

    test("rate limit is per channel — first update on each channel is independently deferred", async () => {
        const updater = new StatusMessageUpdater(testLogger, RATE_MS);
        const editFnA = mock(async () => {});
        const editFnB = mock(async () => {});

        updater.scheduleUpdate("ch-1", "msg-1", editFnA, "A");
        updater.scheduleUpdate("ch-2", "msg-2", editFnB, "B");

        // Neither fires synchronously
        expect(editFnA).toHaveBeenCalledTimes(0);
        expect(editFnB).toHaveBeenCalledTimes(0);
    });

    test("editFn errors are caught and do not propagate", async () => {
        const updater = new StatusMessageUpdater(testLogger, RATE_MS);
        const throwingEdit = mock(async () => {
            throw new Error("Discord API error");
        });

        updater.scheduleUpdate("ch-1", "msg-1", throwingEdit, "Status A");

        // Allow the timer to fire and the rejected promise to be handled
        await wait(RATE_MS + 20);
        await Promise.resolve();
    });
});
