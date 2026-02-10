import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../../config/env';
import * as schema from './schema';

const pool = new pg.Pool({
	connectionString: config.database.url,
});

export const db = drizzle(pool, { schema });
