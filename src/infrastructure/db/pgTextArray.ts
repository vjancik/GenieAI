/**
 * Creates a PostgreSQL `text[]` array parameter compatible with Bun's SQL driver.
 *
 * Bun's `SQL` class exposes `sql.array(values, "TEXT")` on instances, but repositories
 * only hold a Drizzle `Db` reference. This helper replicates the same `SQLArrayParameter`
 * duck-type that Bun's driver accepts: it calls `toString()` on each bound parameter,
 * so returning the PG array literal (e.g. `{"foo","bar"}`) from `toString` is sufficient.
 *
 * Usage with Drizzle prepared statements:
 * ```ts
 * const stmt = db.select().from(t)
 *     .where(sql`${t.col} = ANY(${sql.placeholder("ids")})`)
 *     .prepare("name");
 * await stmt.execute({ ids: pgTextArray(["a", "b"]) });
 * ```
 */
export function pgTextArray(values: string[]): {
    toString(): string;
    toJSON(): string;
} {
    // Escape backslashes and double-quotes inside each value per the PG array literal format.
    const serialized = `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
    return {
        toString: () => serialized,
        toJSON: () => serialized,
    };
}
