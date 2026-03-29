import { AIMessage } from "@langchain/core/messages";
import type { IMessageRepository } from "../../domain/ports/IMessageRepository.ts";
import { shortenRedirectUrl } from "../../infrastructure/http/redirectUrl.ts";
import { SearchMode } from "../config/AppConfig.ts";
import { extractWebGroundingChunks, formatGroundingSources } from "../formatters/groundingSources.ts";
import { dbMessagesToLangchain } from "../helpers/messageTransformers.ts";
import type { IChatClientButtonInteraction } from "../ports/chat/IChatClient.ts";
import { DM_GUILD_TOKEN } from "../shared/tokens.ts";
import type { Logger } from "../types/Logger.ts";

const GOOGLE_REDIRECT_PREFIX = "https://vertexaisearch.cloud.google.com";

/**
 * Application use case: handles a Sources button click on a bot response.
 *
 * Resolves grounding source citations from the persisted LangChain messages for
 * the target bot message and replies ephemerally with the formatted sources line.
 * If no sources are found (e.g. the DB row is missing or has no grounding chunks),
 * an ephemeral error message is sent instead.
 */
export class HandleSourcesUseCase {
    /**
     * @param messageRepo - Repository for looking up the bot message row by Discord ID
     * @param searchMode - Whether Google Search or Tavily is active (affects URL shortening)
     * @param logger - Logger instance
     */
    constructor(
        private readonly messageRepo: IMessageRepository,
        private readonly searchMode: SearchMode,
        private readonly logger: Logger,
    ) {}

    async execute(interaction: IChatClientButtonInteraction): Promise<void> {
        const guildId = interaction.message.guildId ?? DM_GUILD_TOKEN;

        const row = await this.messageRepo.findByDiscordMessageId({
            discordMessageId: interaction.message.id,
            channelId: interaction.message.channelId,
            guildId,
        });

        if (!row || row.langchainMessages.length === 0) {
            await interaction.reply({
                content: "*Sources are not available for this message.*",
                isEphemeral: true,
            });
            return;
        }

        const langchainMessages = dbMessagesToLangchain([row], this.logger, false);
        const lastMessage = langchainMessages.at(-1);

        if (!(lastMessage instanceof AIMessage)) {
            await interaction.reply({
                content: "*Sources are not available for this message.*",
                isEphemeral: true,
            });
            return;
        }

        const rawChunks = extractWebGroundingChunks(lastMessage.additional_kwargs);
        if (rawChunks.length === 0) {
            await interaction.reply({ content: "*No sources found for this message.*", isEphemeral: true });
            return;
        }

        const sourcesLine = formatGroundingSources(await this.resolveGroundingSources(rawChunks));
        if (!sourcesLine) {
            await interaction.reply({ content: "*No sources found for this message.*", isEphemeral: true });
            return;
        }

        void (await interaction.reply({ content: sourcesLine, isEphemeral: true }));
    }

    private async resolveGroundingSources(
        rawChunks: Array<{ uri: string; title: string }>,
    ): Promise<Array<{ title: string; url: string }>> {
        return Promise.all(
            rawChunks.map(async ({ uri, title }) => {
                if (this.searchMode === SearchMode.google) {
                    if (!uri.startsWith(GOOGLE_REDIRECT_PREFIX)) {
                        this.logger.error(
                            { uri },
                            "Google Search grounding URI does not match expected redirect prefix — may need updating",
                        );
                        return { title, url: uri };
                    }
                    return { title, url: await shortenRedirectUrl(uri) };
                }
                return { title, url: uri };
            }),
        );
    }
}
