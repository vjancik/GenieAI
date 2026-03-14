/**
 * Prevents duplicate processing when multiple users click the same button
 * simultaneously. Discord does not deduplicate concurrent button clicks,
 * so each handler must acquire a lock before proceeding.
 *
 * The lock is keyed by `messageId:customId` so that different buttons on the
 * same message (e.g. Retry and Next Page) have independent locks and don't
 * block each other.
 */
export class InteractionLock {
    private readonly locked = new Set<string>();

    private key(messageId: string, customId: string): string {
        return `${messageId}:${customId}`;
    }

    isLocked(messageId: string, customId: string): boolean {
        return this.locked.has(this.key(messageId, customId));
    }

    setLocked(messageId: string, customId: string): void {
        this.locked.add(this.key(messageId, customId));
    }

    clearLock(messageId: string, customId: string): void {
        this.locked.delete(this.key(messageId, customId));
    }
}
