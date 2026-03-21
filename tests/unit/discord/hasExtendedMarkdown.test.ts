import { describe, expect, test } from "bun:test";
import { hasExtendedMarkdown } from "../../../src/infrastructure/discord/DiscordGateway.ts";

describe("hasExtendedMarkdown — money / currency false positives", () => {
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

    test("mixed prefix and suffix prices in one sentence — acceptable false positive", () => {
        // $50 ... 40$ forms a plausible $...$  pair; false positive is acceptable
        expect(hasExtendedMarkdown("The discount brings it from $50 down to 40$.")).toBe(true);
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

    test("mixed prefix and suffix across multiple sentences — acceptable false positive", () => {
        // $120 ... 20$ spans sentences forming a plausible $...$ pair; false positive is acceptable
        expect(
            hasExtendedMarkdown(
                "The original price was $120. After the coupon you save 20$. " +
                    "The final amount due is $100. Tax adds another 8$.",
            ),
        ).toBe(true);
    });

    test("large monetary values with commas — acceptable false positive", () => {
        // $1,000,000 ... 950,000$ forms a plausible $...$ pair; false positive is acceptable
        expect(
            hasExtendedMarkdown(
                "The contract is worth $1,000,000. The competitor bid 950,000$. " + "The difference is just $50,000.",
            ),
        ).toBe(true);
    });

    test("decimal prices mixed direction — acceptable false positive", () => {
        // $2.50 ... 1.75$ forms a plausible $...$ pair; false positive is acceptable
        expect(
            hasExtendedMarkdown(
                "Coffee is $2.50 and the muffin is 1.75$. " +
                    "Together that's $4.25, or 4.25$ if you prefer it that way.",
            ),
        ).toBe(true);
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

    test("price range with slash: $10/$20 — acceptable false positive", () => {
        // $10/$20 has non-space on both inner boundaries; false positive is acceptable
        expect(hasExtendedMarkdown("tickets are $10/$20 for student/adult")).toBe(true);
    });

    test("two prices with equals between them: $10 = $5 * 2", () => {
        // Space after $ means neither forms a valid $\S...\S$ pair — correctly rejected
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

describe("hasExtendedMarkdown — true positives (should detect)", () => {
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
