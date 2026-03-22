import { describe, expect, test } from "bun:test";
import { file } from "bun";
import { hasExtendedMarkdown } from "../../../src/infrastructure/discord/DiscordGateway.ts";

// ─── True negatives (must return false) ───────────────────────────────────────

describe("hasExtendedMarkdown — plain currency (must not trigger)", () => {
    test("single price suffix: costs $5", () => {
        expect(hasExtendedMarkdown("The item costs $5.")).toBe(false);
    });

    test("single price prefix: 5$", () => {
        expect(hasExtendedMarkdown("That will be 5$.")).toBe(false);
    });

    test("multiple prices suffix in one sentence", () => {
        expect(hasExtendedMarkdown("You can buy it for $10 or $20 depending on the size.")).toBe(false);
    });

    test("multiple prices prefix in one sentence", () => {
        expect(hasExtendedMarkdown("Options are 10$ and 20$ respectively.")).toBe(false);
    });

    test("paragraph with several sentences containing $ suffix prices", () => {
        expect(
            hasExtendedMarkdown(
                "We offer three tiers. The basic plan is 9$ per month. " +
                    "The pro plan is 29$ per month. Enterprise starts at 99$.",
            ),
        ).toBe(false);
    });

    test("paragraph with several sentences containing $ prefix prices", () => {
        expect(
            hasExtendedMarkdown(
                "Groceries cost $3 for milk and $5 for bread. " +
                    "The total came to $8 before tax. After tax it was $8.64.",
            ),
        ).toBe(false);
    });

    test("dollar sign in a URL-like context", () => {
        expect(hasExtendedMarkdown("Visit https://example.com?ref=$abc for the $10 deal.")).toBe(false);
    });

    test("two prices with a slash between them: 10$ / $5", () => {
        expect(hasExtendedMarkdown("costs 10$ / $5 per unit")).toBe(false);
    });

    test("two prices with a slash between them: $10 / $5", () => {
        expect(hasExtendedMarkdown("price is $10 / $5 depending on quantity")).toBe(false);
    });

    test("two prices with equals between them: $10 = $5 * 2", () => {
        expect(hasExtendedMarkdown("note that $10 = $5 * 2 in this context")).toBe(false);
    });

    test("plain paragraph with no special syntax", () => {
        expect(
            hasExtendedMarkdown(
                "This is a plain paragraph. It has multiple sentences. " + "None of them contain any special markdown.",
            ),
        ).toBe(false);
    });
});

describe("hasExtendedMarkdown — bold/italic-wrapped currency (must not trigger)", () => {
    test("inline currency in bold: **$50**", () => {
        expect(hasExtendedMarkdown("The price is **$50** today.")).toBe(false);
    });

    test("italic-wrapped prices: _$10_ and _$20_ separated by prose", () => {
        expect(hasExtendedMarkdown("Options are _$10_ or _$20_.")).toBe(false);
    });

    test("message1: bold prefix-style prices **$45,000** and **$100,000**", async () => {
        // Previously the inline regex matched "$45,000** ... **$100,000" across both bold-wrapped
        // prices. The closing-char guard ([^*_~|]) now rejects it.
        const text = await file(new URL("data/hasExtendedMarkdownTest-message1.md", import.meta.url)).text();
        expect(hasExtendedMarkdown(text)).toBe(false);
    });

    test("message2: bold suffix-style prices **45,000$** and **100,000$**", async () => {
        // Suffix-style currency has $ followed by * (the closing **), which fails the
        // opening-char guard ([\p{L}\p{N}\\]) — not a valid equation start.
        const text = await file(new URL("data/hasExtendedMarkdownTest-message2.md", import.meta.url)).text();
        expect(hasExtendedMarkdown(text)).toBe(false);
    });
});

// ─── True positives (must return true) ────────────────────────────────────────

describe("hasExtendedMarkdown — equations and tables (must trigger)", () => {
    test("inline equation", () => {
        expect(hasExtendedMarkdown("The formula is $E = mc^2$ and it's famous.")).toBe(true);
    });

    test("block equation", () => {
        expect(hasExtendedMarkdown("See below:\n$$\n\\int_0^\\infty e^{-x} dx = 1\n$$")).toBe(true);
    });

    test("GFM table", () => {
        expect(hasExtendedMarkdown("| Name | Price |\n|------|-------|\n| Apple | $1 |")).toBe(true);
    });

    test("equation mixed with money in same text", () => {
        expect(hasExtendedMarkdown("The cost is $50 but the energy formula is $E = mc^2$.")).toBe(true);
    });
});

// ─── Acceptable false positives ───────────────────────────────────────────────

describe("hasExtendedMarkdown — acceptable false positives", () => {
    test("mixed prefix and suffix prices in one sentence: $50 down to 40$", () => {
        // $50 ... 40$ — no emphasis punctuation adjacent to either $; acceptable false positive
        expect(hasExtendedMarkdown("The discount brings it from $50 down to 40$.")).toBe(true);
    });

    test("mixed prefix and suffix across multiple sentences", () => {
        // $120 ... 20$ spans sentences; acceptable false positive
        expect(
            hasExtendedMarkdown(
                "The original price was $120. After the coupon you save 20$. " +
                    "The final amount due is $100. Tax adds another 8$.",
            ),
        ).toBe(true);
    });

    test("large monetary values with commas: $1,000,000 ... 950,000$", () => {
        expect(
            hasExtendedMarkdown(
                "The contract is worth $1,000,000. The competitor bid 950,000$. " + "The difference is just $50,000.",
            ),
        ).toBe(true);
    });

    test("decimal prices mixed direction: $2.50 ... 1.75$", () => {
        expect(
            hasExtendedMarkdown(
                "Coffee is $2.50 and the muffin is 1.75$. " +
                    "Together that's $4.25, or 4.25$ if you prefer it that way.",
            ),
        ).toBe(true);
    });

    test("price range with slash: $10/$20", () => {
        // No emphasis punctuation adjacent to either $ — acceptable false positive
        expect(hasExtendedMarkdown("tickets are $10/$20 for student/adult")).toBe(true);
    });

    test("price range with en dash: $20B–$25B", () => {
        // $20B...B$ — no emphasis punctuation adjacent to either $; acceptable false positive
        expect(hasExtendedMarkdown("valuation is $20B–$25B")).toBe(true);
    });
});
