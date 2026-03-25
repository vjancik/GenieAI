/**
 * Port for a per-button in-memory lock that prevents duplicate processing
 * when multiple users click the same button simultaneously.
 *
 * The lock is keyed by both `messageId` and `customId` so that different
 * buttons on the same message have independent locks.
 */
export interface IInteractionLock {
    isLocked(messageId: string, customId: string): boolean;
    setLocked(messageId: string, customId: string): void;
    clearLock(messageId: string, customId: string): void;
}
