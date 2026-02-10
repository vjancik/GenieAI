export const config = {
	discord: {
		token: process.env.DISCORD_TOKEN ?? '',
		messagePrefix: process.env.DISCORD_PREFIX ?? '!',
	},
	ai: {
		apiKey: process.env.GEMINI_API_KEY ?? '',
		model: process.env.GEMINI_MODEL ?? 'gemini-flash-latest',
		systemPrompt: process.env.SYSTEM_PROMPT ?? 'You are a helpful AI assistant.',
		attachmentMemoryLimit: Number(process.env.ATTACHMENT_MEMORY_LIMIT) || 20 * 1024 * 1024,
		attachmentDiskLimit: Number(process.env.ATTACHMENT_DISK_LIMIT) || 100 * 1024 * 1024,
	},
	logging: {
		level: process.env.LOG_LEVEL ?? 'info',
		format: (process.env.LOG_FORMAT as 'json' | 'text') ?? 'text',
		useColor: !process.env.LOG_COLOR || ['true', '1'].includes(process.env.LOG_COLOR.toLowerCase()),
	},
	database: {
		url: process.env.DATABASE_URL ?? 'postgresql://genie:genie_pass@localhost:5432/genie_ai',
	},
};
