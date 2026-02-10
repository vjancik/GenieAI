import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.warn('DATABASE_URL is not set. Database migrations may fail.');
}

export default defineConfig({
	schema: './src/infrastructure/database/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		url: databaseUrl ?? '',
	},
});
