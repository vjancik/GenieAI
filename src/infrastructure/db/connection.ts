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
export function createDb(url?: string) {
    const connectionUrl = url ?? process.env["DATABASE_URL"];
    if (!connectionUrl) {
        throw new Error("No DATABASE_URL provided for database connection");
    }
    return drizzle(connectionUrl, { schema });
}

/** Type alias for the Drizzle instance, used for dependency injection. */
export type Db = ReturnType<typeof createDb>;
