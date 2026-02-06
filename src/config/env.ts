export const config = {
    discord: {
        token: process.env.DISCORD_TOKEN || '',
        messagePrefix: process.env.DISCORD_PREFIX || '!',
    },
    ai: {
        apiKey: process.env.GEMINI_API_KEY || '',
        model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
        systemPrompt: process.env.SYSTEM_PROMPT || 'You are a helpful AI assistant.',
    },
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        format: (process.env.LOG_FORMAT as 'json' | 'text') || 'text',
        useColor: !process.env.LOG_COLOR || ['true', '1'].includes(process.env.LOG_COLOR.toLowerCase()),
    }
};
