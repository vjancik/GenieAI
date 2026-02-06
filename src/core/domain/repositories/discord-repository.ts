export interface IDiscordRepository {
    saveMapping(discordId: string, messageId: string): Promise<void>;
    getMessageId(discordId: string): Promise<string | null>;
}
