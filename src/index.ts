import { config } from './config/env';
import { SendMessageUseCase } from './core/application/use-cases/send-message.use-case';
import { GoogleGenAIAdapter } from './infrastructure/ai/google-genai-adapter';
import { InMemoryChatRepository } from './infrastructure/database/in-memory-chat-repo';
import { DiscordBot } from './interfaces/discord';

async function main() {
    console.log('Starting AI Agent Backend...');

    // 1. Initialize Infrastructure
    const chatRepo = new InMemoryChatRepository();
    const aiAdapter = new GoogleGenAIAdapter(chatRepo);

    // 2. Initialize Application Layer (Use Cases)
    const sendMessageUseCase = new SendMessageUseCase(chatRepo, aiAdapter);

    // 3. Initialize Interface Layer
    const discordBot = new DiscordBot(sendMessageUseCase, chatRepo);

    // 4. Start Application
    try {
        // Check if token is present, otherwise warn but don't crash if just testing
        if (config.discord.token) {
            await discordBot.start(config.discord.token);
        } else {
            console.warn('WARNING: DISCORD_TOKEN is not set in .env. Bot will not connect to Discord.');
            console.log('Mock setup is complete. To test real discord connection, add DISCORD_TOKEN to .env');
        }
    } catch (error) {
        console.error('Failed to start application:', error);
        process.exit(1);
    }
}

main();
