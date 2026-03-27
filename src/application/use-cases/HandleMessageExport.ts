import { DiscordError, isMissingPermissionsError } from "../../domain/errors/AppError.ts";
import type { IMessageRepository } from "../../domain/message/IMessageRepository.ts";
import { sanitizeForLog } from "../helpers/errorHelpers.ts";
import { dbMessagesToLangchain, extractContent } from "../helpers/messageTransformers.ts";
import type {
    IChatClientBot,
    IChatClientButtonInteraction,
    IChatClientContextMenuInteraction,
    IChatClientMessage,
} from "../ports/chat/IChatClient.ts";
import type { IImageRenderer } from "../ports/IImageRenderer.ts";
import type { IInteractionLock } from "../ports/IInteractionLock.ts";
import type { IMarkdownRenderer } from "../ports/IMarkdownRenderer.ts";
import type { Logger } from "../types/Logger.ts";

/** Sentinel value stored as guild_id for DM messages, which have no guild. */
const DM_GUILD_TOKEN = "@me";

/** Custom ID for the Render button attached to responses containing extended markdown. */
const RENDER_BUTTON_ID = "render_image";

/**
 * Returns the button array for `message` with the button matching `removeId` filtered out.
 * Passing the result to `message.edit({ buttons })` replaces the row in-place.
 */
function withoutButton(message: IChatClientMessage, removeId: string): IChatClientMessage["buttons"] {
    return message.buttons.filter((b) => b.customId !== removeId);
}

/**
 * Application use case: handles all export and render interactions.
 *
 * Owns the three export flows:
 * - "Export as HTML" context menu command ({@link handleExportHtml})
 * - "Export as Image" context menu command ({@link handleExportImage})
 * - "Render" button on messages containing extended markdown ({@link handleRender})
 */
export class HandleExportUseCase {
    /**
     * @param messageRepo - Repository for finding message rows and persisting render replies
     * @param markdownRenderer - Port for rendering Markdown to HTML
     * @param imageRenderer - Port for rendering HTML to a PNG image buffer
     * @param bot - Chat client bot adapter for reading the current bot user ID
     * @param logger - Logger instance
     * @param previousBotId - Optional Discord user ID of the previous bot version; allows
     *   exporting messages authored by it
     * @param interactionLock - Lock to prevent duplicate concurrent render processing
     */
    constructor(
        private readonly messageRepo: IMessageRepository,
        private readonly markdownRenderer: IMarkdownRenderer,
        private readonly imageRenderer: IImageRenderer,
        private readonly bot: IChatClientBot,
        private readonly logger: Logger,
        private readonly previousBotId: string | undefined,
        private readonly interactionLock: IInteractionLock,
    ) {}

    /** Handles the "Export as HTML" message context menu command. */
    async handleExportHtml(interaction: IChatClientContextMenuInteraction): Promise<void> {
        const botUserId = this.bot.userId;
        const target = interaction.targetMessage;

        // Only allow exporting messages authored by this bot or the previous bot
        if (target.authorId !== botUserId && target.authorId !== this.previousBotId) {
            await interaction.reply({ content: "*You can only export bot messages.*", isEphemeral: true });
            return;
        }

        this.logger.info(
            {
                targetMessageId: target.id,
                channelId: target.channelId,
                guildId: target.guildId,
                invokerUserId: interaction.userId,
            },
            "Handling Export as HTML command",
        );

        await interaction.deferReply({ isEphemeral: true });

        const markdown = await this.resolveExportContent(target);
        if (!markdown.trim()) {
            void (await interaction.editReply({ content: "*The message has no text content.*" }));
            return;
        }
        const html = this.markdownRenderer.render(markdown);
        const filename = `render-${target.id}.html`;

        void (await interaction.editReply({
            files: [{ attachment: Buffer.from(html, "utf-8"), name: filename }],
        }));
    }

    /** Handles the "Export as Image" message context menu command. */
    async handleExportImage(interaction: IChatClientContextMenuInteraction): Promise<void> {
        const botUserId = this.bot.userId;
        const target = interaction.targetMessage;

        // Only allow exporting messages authored by this bot or the previous bot
        if (target.authorId !== botUserId && target.authorId !== this.previousBotId) {
            await interaction.reply({ content: "*You can only export bot messages.*", isEphemeral: true });
            return;
        }

        this.logger.info(
            {
                targetMessageId: target.id,
                channelId: target.channelId,
                guildId: target.guildId,
                invokerUserId: interaction.userId,
            },
            "Handling Export as Image command",
        );

        await interaction.deferReply({ isEphemeral: true });

        const markdown = await this.resolveExportContent(target);
        if (!markdown.trim()) {
            void (await interaction.editReply({ content: "*The message has no text content.*" }));
            return;
        }
        const html = this.markdownRenderer.render(markdown);
        const png = await this.imageRenderer.render(html);
        const filename = `render-${target.id}.png`;

        void (await interaction.editReply({
            files: [{ attachment: png, name: filename }],
        }));
    }

    /** Handles the "Render" button attached to bot replies containing extended markdown. */
    async handleRender(interaction: IChatClientButtonInteraction): Promise<void> {
        const botMessage = interaction.message;

        if (this.interactionLock.isLocked(botMessage.id, RENDER_BUTTON_ID)) {
            await interaction.reply({ content: "*Already rendering, please wait.*", isEphemeral: true });
            return;
        }

        this.interactionLock.setLocked(botMessage.id, RENDER_BUTTON_ID);
        try {
            this.logger.info(
                {
                    botMessageId: botMessage.id,
                    channelId: botMessage.channelId,
                    guildId: botMessage.guildId,
                    invokerUserId: interaction.userId,
                },
                "Handling Render button",
            );

            // Acknowledge the button press without creating an interaction reply — the
            // rendered image will be sent as a normal reply to the bot message instead.
            await interaction.deferUpdate();

            const markdown = await this.resolveExportContent(botMessage);
            const html = this.markdownRenderer.render(markdown);
            const png = await this.imageRenderer.render(html);
            const filename = `render-${botMessage.id}.png`;

            let renderReply: IChatClientMessage;
            try {
                renderReply = await botMessage.reply({
                    files: [{ attachment: png, name: filename }],
                    allowedMentions: { repliedUser: false },
                });
            } catch (err) {
                sanitizeForLog(err);
                if (isMissingPermissionsError(err)) {
                    this.logger.error(
                        { channelId: botMessage.channelId, guildId: botMessage.guildId },
                        "Render failed: bot is missing Send Messages or Attach Files permission in this channel",
                    );
                    throw new DiscordError("Missing permissions to send render reply", err);
                }
                throw err;
            }

            // Persist so the render reply participates in the DB reply chain
            await this.messageRepo.saveBotMessage({
                discordMessageId: renderReply.id,
                repliesToDiscordId: botMessage.id,
                channelId: renderReply.channelId,
                guildId: renderReply.guildId ?? DM_GUILD_TOKEN,
                discordAuthorId: this.bot.userId,
                langchainMessages: [],
                retriesLeft: null,
                usedFallback: false,
                interactionType: "message_create",
                interactionAuthorDiscordId: interaction.userId,
            });

            // Remove the Render button from the original message now that it's been rendered.
            await botMessage.edit({ buttons: withoutButton(botMessage, RENDER_BUTTON_ID) });
        } finally {
            this.interactionLock.clearLock(botMessage.id, RENDER_BUTTON_ID);
        }
    }

    /**
     * Resolves the full markdown content for a bot message to export.
     *
     * Looks up the DB row for the target message and extracts text from its
     * persisted LangChain messages (which may contain the full multi-page content).
     * Falls back to the Discord message content if no DB row exists.
     */
    private async resolveExportContent(target: IChatClientMessage): Promise<string> {
        const guildId = target.guildId ?? DM_GUILD_TOKEN;
        const row = await this.messageRepo.findByDiscordMessageId({
            discordMessageId: target.id,
            channelId: target.channelId,
            guildId,
        });

        if (row && row.langchainMessages.length > 0) {
            // Find the last AI message in the stored LangChain messages and extract its content
            const langchainMessages = dbMessagesToLangchain([row], this.logger);
            // Walk from the end to find the last substantive AI response
            for (let i = langchainMessages.length - 1; i >= 0; i--) {
                const msg = langchainMessages[i];
                if (msg === undefined) continue;
                const content = extractContent(msg);
                if (content.trim().length > 0) return content;
            }
        }

        // Fallback: use mention-resolved message content
        return target.cleanContent;
    }
}
