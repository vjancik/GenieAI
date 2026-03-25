import type { Logger } from "../types/Logger.ts";

/**
 * Async function that edits a message to display the given content string.
 * Provided by the caller so this class remains decoupled from any specific platform SDK.
 */
export type EditFn = (content: string) => Promise<void>;

/** Internal tracking record for a rate-limited pending edit on a single message. */
interface MessagePending {
    channelId: string;
    /** Always reflects the latest requested content — updated in-place on each call. */
    latestContent: string;
    editFn: EditFn;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Debouncing + rate-limited message editor for progressive status updates.
 *
 * Every `scheduleUpdate` call schedules a deferred edit — never fires immediately.
 * The delay is `max(0, rateLimitMs - elapsedSinceLastEdit)`, where a channel with
 * no prior edit is treated as `elapsed = 0` (full `rateLimitMs` delay). This prevents
 * UI thrashing when a status update arrives immediately after the initial placeholder
 * reply is sent.
 *
 * If a new update arrives while a timer is already pending for the same message, the
 * content is updated in-place (last wins) without resetting the timer. This collapses
 * rapid intermediate states into a single edit at the originally scheduled time.
 *
 * Rate limiting is tracked per channel; pending content is tracked per message
 * (a message always belongs to exactly one channel, so these are consistent).
 */
export class StatusMessageUpdater {
    /** Timestamp of the most recent committed edit per channelId. */
    private readonly channelLastEdit = new Map<string, number>();

    /** Pending timer + latest content per messageId. */
    private readonly pendingByMessage = new Map<string, MessagePending>();

    /**
     * @param logger - Logger for warning on edit failures
     * @param rateLimitMs - Minimum ms between edits per channel (default: 2000). Configurable for testing.
     */
    constructor(
        private readonly logger: Logger,
        private readonly rateLimitMs = 2000,
    ) {}

    /**
     * Schedule a debounced status edit on a message.
     *
     * Always deferred — never fires synchronously. The delay is
     * `max(0, rateLimitMs - elapsed)` where a channel with no prior edit is
     * treated as `elapsed = 0` so the very first update always waits the full
     * `rateLimitMs`, preventing thrash against the initial placeholder message.
     *
     * If a timer for this message is already pending, the content is updated in-place
     * and the existing timer is kept — no reset. This collapses rapid intermediate
     * states into a single edit at the originally scheduled time.
     *
     * @param channelId - Channel ID (rate limit key)
     * @param messageId - Message ID being edited (deduplication key)
     * @param editFn - Async function that performs the actual message edit
     * @param content - The new status string to display
     */
    scheduleUpdate(channelId: string, messageId: string, editFn: EditFn, content: string): void {
        const existing = this.pendingByMessage.get(messageId);
        if (existing) {
            // Timer already scheduled — update content in-place, keep the timer as-is
            existing.latestContent = content;
            existing.editFn = editFn;
            return;
        }

        // No pending timer — compute delay and schedule
        const lastEdit = this.channelLastEdit.get(channelId);
        // Treat no prior edit as elapsed = 0 so the first update always waits rateLimitMs
        const elapsed = lastEdit !== undefined ? Date.now() - lastEdit : 0;
        const delay = Math.max(0, this.rateLimitMs - elapsed);

        const pending: MessagePending = {
            channelId,
            latestContent: content,
            editFn,
            timer: this.createTimer(channelId, messageId, delay),
        };
        this.pendingByMessage.set(messageId, pending);
    }

    /**
     * Cancel any pending status edit for a message.
     * Must be called before writing the final response to prevent a pending timer
     * from overwriting the final content after it has been displayed.
     *
     * @param messageId - Message ID to cancel pending edits for
     */
    cancel(messageId: string): void {
        const pending = this.pendingByMessage.get(messageId);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingByMessage.delete(messageId);
        }
    }

    /**
     * Creates a setTimeout that reads the latest pending content from the map when it fires.
     * This ensures that multiple rapid updates collapse into a single edit showing the newest state.
     */
    private createTimer(channelId: string, messageId: string, delay: number): ReturnType<typeof setTimeout> {
        return setTimeout(() => {
            const pending = this.pendingByMessage.get(messageId);
            if (!pending) return;

            this.pendingByMessage.delete(messageId);
            this.channelLastEdit.set(channelId, Date.now());
            this.fireEdit(messageId, pending.editFn, pending.latestContent);
        }, delay);
    }

    /** Fire an edit as fire-and-forget, catching and logging any errors so they never propagate. */
    private fireEdit(messageId: string, editFn: EditFn, content: string): void {
        editFn(content).catch((err) => {
            this.logger.warn({ err, messageId }, "Failed to edit status message");
        });
    }
}
