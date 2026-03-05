import { describe, expect, mock, test } from "bun:test";
import pino from "pino";
import { StatusMessageUpdater } from "../../../src/infrastructure/discord/StatusMessageUpdater.ts";

const testLogger = pino({ level: "silent" });

/** Short rate limit for tests so waits stay under ~100ms total. */
const RATE_MS = 50;

/** Wait long enough for the rate limit timer to fire. */
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("StatusMessageUpdater", () => {
    test("executes edit immediately when channel has no prior edit", async () => {
        const updater = new StatusMessageUpdater(testLogger, RATE_MS);
        const editFn = mock(async () => {});

        updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status A");

        expect(editFn).toHaveBeenCalledTimes(1);
        expect(editFn).toHaveBeenCalledWith("Status A");
    });

    test("does not fire immediately when channel is within rate limit window", async () => {
        const updater = new StatusMessageUpdater(testLogger, RATE_MS);
        const editFn = mock(async () => {});

        // First edit fires immediately
        updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status A");
        expect(editFn).toHaveBeenCalledTimes(1);

        // Second edit within the rate limit window — must be queued
        updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status B");
        expect(editFn).toHaveBeenCalledTimes(1);
    });

    test(
        "fires queued edit after rate limit window expires",
        async () => {
            const updater = new StatusMessageUpdater(testLogger, RATE_MS);
            const editFn = mock(async () => {});

            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status A");
            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status B");

            expect(editFn).toHaveBeenCalledTimes(1);

            await wait(RATE_MS + 20);

            expect(editFn).toHaveBeenCalledTimes(2);
            expect(editFn).toHaveBeenLastCalledWith("Status B");
        },
        { retry: 5 },
    ); // Retries to mitigate flakiness from timing issues

    test(
        "uses latest content when multiple updates arrive during cooldown",
        async () => {
            const updater = new StatusMessageUpdater(testLogger, RATE_MS);
            const editFn = mock(async () => {});

            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status A");
            // Rapidly queue several — only the last should fire
            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status B");
            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status C");
            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status D");

            expect(editFn).toHaveBeenCalledTimes(1);

            await wait(RATE_MS + 20);

            expect(editFn).toHaveBeenCalledTimes(2);
            expect(editFn).toHaveBeenLastCalledWith("Status D");
        },
        { retry: 5 },
    );

    test(
        "cancel() prevents a pending edit from firing",
        async () => {
            const updater = new StatusMessageUpdater(testLogger, RATE_MS);
            const editFn = mock(async () => {});

            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status A");
            updater.scheduleUpdate("ch-1", "msg-1", editFn, "Status B");

            updater.cancel("msg-1");

            await wait(RATE_MS + 20);

            // Only the first immediate call should have happened
            expect(editFn).toHaveBeenCalledTimes(1);
        },
        { retry: 5 },
    );

    test("cancel() is a no-op when there is no pending edit", () => {
        const updater = new StatusMessageUpdater(testLogger, RATE_MS);
        expect(() => updater.cancel("msg-never-seen")).not.toThrow();
    });

    test("rate limit is per channel — different channels do not share cooldown", () => {
        const updater = new StatusMessageUpdater(testLogger, RATE_MS);
        const editFnA = mock(async () => {});
        const editFnB = mock(async () => {});

        updater.scheduleUpdate("ch-1", "msg-1", editFnA, "A");
        updater.scheduleUpdate("ch-2", "msg-2", editFnB, "B");

        // Both fire immediately because they are independent channels
        expect(editFnA).toHaveBeenCalledTimes(1);
        expect(editFnB).toHaveBeenCalledTimes(1);
    });

    test("editFn errors are caught and do not propagate", async () => {
        const updater = new StatusMessageUpdater(testLogger, RATE_MS);
        const throwingEdit = mock(async () => {
            throw new Error("Discord API error");
        });

        expect(() => {
            updater.scheduleUpdate("ch-1", "msg-1", throwingEdit, "Status A");
        }).not.toThrow();

        // Allow the rejected promise's catch handler to run
        await Promise.resolve();
        await Promise.resolve();
    });
});
