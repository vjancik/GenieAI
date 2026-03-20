// Driver note: bun-sql runs all applicable queries as prepared statements (caching them internally) but using drizzle's .prepare() method still reduces query times by avoiding dynamic query builder resolution on every query
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema.ts";

/**
 * Creates a Drizzle ORM instance connected to PostgreSQL via Bun's native SQL driver.
 *
 * Accepts an optional URL override to allow test environments to connect
 * to a dedicated test database without modifying global config.
 *
 * @param url - PostgreSQL connection string. Falls back to DATABASE_URL env var.
 */
export function createDb(url: string) {
    return drizzle(url, { schema });
}

/** Type alias for the Drizzle instance, used for dependency injection. */
export type Db = ReturnType<typeof createDb>;
