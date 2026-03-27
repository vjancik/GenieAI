import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDb } from "./connection.ts";

const url = process.env.DATABASE_URL;
if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
}

const db = createDb(url);

await migrate(db, { migrationsFolder: "./src/infrastructure/db/migrations" });

console.log("Migrations applied successfully");
process.exit(0);
