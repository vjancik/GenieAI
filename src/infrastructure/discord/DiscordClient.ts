import { Client, Events, GatewayIntentBits } from "discord.js";
import type { Logger } from "../../application/types/Logger.ts";

/**
 * Thin wrapper around the discord.js {@link Client} responsible solely for
 * lifecycle management (login and destroy).
 *
 * Exposes the underlying `client` instance directly so consumers (e.g.
 * {@link DiscordGateway}, {@link DiscordChatMessageService}) can save a
 * reference at construction time and use the full discord.js API without
 * additional indirection.
 */
export class DiscordClient {
    /** The underlying discord.js client. Consumers should save this reference at construction time. */
    readonly client: Client;

    constructor(
        private readonly token: string,
        private readonly logger: Logger,
    ) {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
            ],
        });

        this.client.once(Events.ClientReady, (readyClient) => {
            this.logger.info({ tag: readyClient.user.tag }, "Discord bot ready");
        });
    }

    /** Connect the bot to Discord's gateway. */
    async start(): Promise<void> {
        await this.client.login(this.token);
        this.logger.info({ tag: this.client.user?.tag }, "Discord bot connected");
    }

    /** Gracefully disconnect from Discord. */
    stop(): void {
        this.client.destroy();
        this.logger.info("Discord bot disconnected");
    }
}
