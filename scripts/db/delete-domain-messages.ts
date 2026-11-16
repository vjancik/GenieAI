/**
 * Deletes messages whose stored text contains a URL on one of a list of domains,
 * together with every message that replies to them — recursively, down to the
 * leaves of each reply tree (see `lib/messageSubtrees.ts` for why the replies have
 * to go too).
 *
 * The default domains are the Instagram mirror sites whose link previews were
 * stored incompletely: their embeds arrive as "components" embeds (text and media
 * nested in a component tree) or serve media only to Discord's crawler, so messages
 * saved before that was handled lack the embed text and/or the video. Once deleted,
 * the next reply into such a thread re-fetches it from Discord and rebuilds it with
 * the current pipeline.
 *
 * A message matches when its serialized `langchain_messages` contains an http(s)
 * URL whose host is one of the domains or a subdomain of one. The host must end
 * right after the domain, so `oginstagram.com.evil.example` does not match.
 *
 * Run with:
 *   bun scripts/db/delete-domain-messages.ts [--dry] [--url <connection string>] [--domains a.com,b.com]
 *
 *   --dry       Only count what would be deleted; nothing is modified.
 *   --url       Database to operate on. Defaults to DATABASE_URL (loaded from .env by Bun).
 *   --domains   Comma-separated domains to use instead of the default list.
 *
 * Safe to re-run — messages re-created after a run contain the same URLs and would be
 * deleted again, so run it once per cleanup rather than on a schedule.
 */

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod/v4";
import { deleteMessageSubtrees, parseCommonArgs } from "./lib/messageSubtrees.ts";

const logger = pino({ level: "info", transport: { target: "pino-pretty" } });

/** Instagram mirror ("embed fixer") domains affected by the embed handling fixes. */
const DEFAULT_DOMAINS = [
    "oginstagram.com",
    "hhinstagram.com",
    "kkinstagram.com",
    "vxinstagram.com",
    "vxtwitter.com",
    "fixvx.com",
];

/** A bare hostname: dot-separated labels of letters, digits and hyphens. */
const DOMAIN_RE = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/;

/** Reads `--domains a.com,b.com`, falling back to {@link DEFAULT_DOMAINS}. Rejects anything that is not a bare hostname. */
function parseDomains(args: string[]): string[] {
    const flagIndex = args.indexOf("--domains");
    if (flagIndex === -1) return DEFAULT_DOMAINS;
    const domains = (args[flagIndex + 1] ?? "")
        .split(",")
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain !== "");
    if (domains.length === 0) throw new Error("--domains needs a comma-separated list of domains");
    const invalid = domains.filter((domain) => !DOMAIN_RE.test(domain));
    if (invalid.length > 0) throw new Error(`Not bare domains: ${invalid.join(", ")}`);
    return domains;
}

/**
 * Builds a PostgreSQL regex matching an http(s) URL on the given domain or any
 * subdomain of it. The trailing negative lookahead ends the host at the domain.
 */
function urlPattern(domain: string): string {
    return `https?://([a-z0-9-]+\\.)*${domain.replaceAll(".", "\\.")}(?![a-z0-9.-])`;
}

const args = process.argv.slice(2);
const domains = parseDomains(args);
logger.info({ domains }, "Matching messages containing URLs on these domains");

await deleteMessageSubtrees({
    ...parseCommonArgs(args),
    logger,
    // One alternation over all domains; `~*` matches case-insensitively
    seedCondition: sql`m.langchain_messages::text ~* ${domains.map(urlPattern).join("|")}`,
    describeSeeds: async (tx) => {
        // A message linking to several domains is counted once per domain here
        const perDomain: Record<string, number> = {};
        for (const domain of domains) {
            const rows = await tx.execute(sql`
                SELECT count(*)::int AS "matches" FROM messages m
                WHERE m.id IN (SELECT id FROM seed_messages) AND m.langchain_messages::text ~* ${urlPattern(domain)}
            `);
            perDomain[domain] = z.object({ matches: z.number() }).parse(rows[0]).matches;
        }
        logger.info(perDomain, "Matching messages per domain");
    },
});
