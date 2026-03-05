import type { Logger } from "../logging/logger.ts";

/**
 * Async function that edits a Discord message to display the given content string.
 * Provided by the caller so this class remains decoupled from discord.js.
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
 * Rate-limited Discord message editor for progressive status updates.
 *
 * Enforces a maximum of 1 edit per second per channel to stay within Discord's
 * rate limits. If a channel is on cooldown, incoming updates cancel the previous
 * pending timer for that message and reschedule with the latest content, preventing
 * stale intermediate states and avoiding queue accumulation.
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
     * Schedule (or immediately execute) a status edit on a Discord message.
     *
     * If the channel's rate limit has cleared, the edit fires immediately.
     * Otherwise, any previously pending edit for this message is cancelled and
     * the new content is queued; the timer reads the latest stored content when
     * it fires, ensuring only the most recent status is ever displayed.
     *
     * @param channelId - Discord channel ID (rate limit key)
     * @param messageId - Discord message ID being edited (deduplication key)
     * @param editFn - Async function that performs the actual `message.edit(content)`
     * @param content - The new status string to display
     */
    scheduleUpdate(
        channelId: string,
        messageId: string,
        editFn: EditFn,
        content: string,
    ): void {
        const now = Date.now();
        const lastEdit = this.channelLastEdit.get(channelId) ?? 0;
        const elapsed = now - lastEdit;

        if (elapsed >= this.rateLimitMs) {
            // Rate limit cleared — execute immediately
            this.channelLastEdit.set(channelId, now);
            this.fireEdit(messageId, editFn, content);
        } else {
            // Within rate limit window — cancel existing timer and reschedule
            const existing = this.pendingByMessage.get(messageId);
            if (existing) {
                // Update content in-place so the timer closure reads the latest value
                existing.latestContent = content;
                existing.editFn = editFn;
                clearTimeout(existing.timer);
                existing.timer = this.createTimer(
                    channelId,
                    messageId,
                    this.rateLimitMs - elapsed,
                );
            } else {
                const pending: MessagePending = {
                    channelId,
                    latestContent: content,
                    editFn,
                    // timer assigned below; object created first so the closure can reference it
                    timer: undefined as unknown as ReturnType<
                        typeof setTimeout
                    >,
                };
                pending.timer = this.createTimer(
                    channelId,
                    messageId,
                    this.rateLimitMs - elapsed,
                );
                this.pendingByMessage.set(messageId, pending);
            }
        }
    }

    /**
     * Cancel any pending status edit for a message.
     * Must be called before writing the final response to prevent a pending timer
     * from overwriting the final content after it has been displayed.
     *
     * @param messageId - Discord message ID to cancel pending edits for
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
    private createTimer(
        channelId: string,
        messageId: string,
        delay: number,
    ): ReturnType<typeof setTimeout> {
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
            this.logger.warn(
                { err, messageId },
                "Failed to edit status message",
            );
        });
    }
}
