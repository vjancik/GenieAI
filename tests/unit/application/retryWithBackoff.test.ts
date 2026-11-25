import { describe, expect, mock, test } from "bun:test";
import { retryWithBackoff } from "../../../src/application/services/retryWithBackoff.ts";

/** An operation that fails with each of `errors` in turn, then resolves to "ok". */
function failingThen(...errors: Error[]) {
    let calls = 0;
    return mock(async () => {
        const err = errors[calls++];
        if (err) throw err;
        return "ok";
    });
}

const makeSleep = () => mock(async (_ms: number) => {});

describe("retryWithBackoff", () => {
    test("returns the first attempt's result without waiting", async () => {
        const operation = failingThen();
        const sleepFn = makeSleep();

        const result = await retryWithBackoff(
            operation,
            { maxRetries: 3, initialDelayMs: 100 },
            { isRetryable: () => true, sleepFn },
        );

        expect(result).toBe("ok");
        expect(operation).toHaveBeenCalledTimes(1);
        expect(sleepFn).not.toHaveBeenCalled();
    });

    test("retries retryable failures, doubling the delay each time", async () => {
        const operation = failingThen(new Error("1"), new Error("2"), new Error("3"));
        const sleepFn = makeSleep();
        const onRetry = mock((_err: unknown, _retry: number, _delayMs: number) => {});

        const result = await retryWithBackoff(
            operation,
            { maxRetries: 3, initialDelayMs: 100 },
            { isRetryable: () => true, onRetry, sleepFn },
        );

        expect(result).toBe("ok");
        expect(operation).toHaveBeenCalledTimes(4);
        expect(sleepFn.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400]);
        expect(onRetry.mock.calls.map(([err, retry, delayMs]) => [(err as Error).message, retry, delayMs])).toEqual([
            ["1", 1, 100],
            ["2", 2, 200],
            ["3", 3, 400],
        ]);
    });

    test("throws the last error once the retries are used up", async () => {
        const operation = failingThen(new Error("1"), new Error("2"), new Error("3"));

        const run = retryWithBackoff(
            operation,
            { maxRetries: 1, initialDelayMs: 100 },
            { isRetryable: () => true, sleepFn: makeSleep() },
        );

        await expect(run).rejects.toThrow("2");
        expect(operation).toHaveBeenCalledTimes(2);
    });

    test("throws a non-retryable failure immediately", async () => {
        const operation = failingThen(new Error("transient"), new Error("fatal"));
        const sleepFn = makeSleep();

        const run = retryWithBackoff(
            operation,
            { maxRetries: 5, initialDelayMs: 100 },
            { isRetryable: (err) => (err as Error).message === "transient", sleepFn },
        );

        await expect(run).rejects.toThrow("fatal");
        expect(operation).toHaveBeenCalledTimes(2);
        expect(sleepFn).toHaveBeenCalledTimes(1);
    });

    test("passes the number of retries so far to each attempt", async () => {
        const operation = mock(async (retry: number) => {
            if (retry < 2) throw new Error(`attempt ${retry}`);
            return retry;
        });

        const result = await retryWithBackoff(
            operation,
            { maxRetries: 3, initialDelayMs: 0 },
            { isRetryable: () => true, sleepFn: makeSleep() },
        );

        expect(result).toBe(2);
        expect(operation.mock.calls.map(([retry]) => retry)).toEqual([0, 1, 2]);
    });

    test("does not retry when maxRetries is 0", async () => {
        const operation = failingThen(new Error("transient"));

        const run = retryWithBackoff(
            operation,
            { maxRetries: 0, initialDelayMs: 100 },
            { isRetryable: () => true, sleepFn: makeSleep() },
        );

        await expect(run).rejects.toThrow("transient");
        expect(operation).toHaveBeenCalledTimes(1);
    });
});
