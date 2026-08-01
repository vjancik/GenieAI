import { describe, expect, test } from "bun:test";
import { analyzePage, describeProblem } from "../../../src/infrastructure/http/pageAnalysis.ts";

/** Builds an article page with `paragraphs` blocks of real prose. */
function articlePage(paragraphs = 8): string {
    const prose =
        "The measured behaviour of the system under load differs substantially from the modelled " +
        "expectation, which suggests the queueing assumptions need revisiting before the next release. ";
    return `<html><body><article><h1>A headline</h1>${`<p>${prose}</p>`.repeat(paragraphs)}</article></body></html>`;
}

describe("analyzePage", () => {
    test("treats a normal article as content, with no escalation", () => {
        const result = analyzePage(articlePage());

        expect(result.hasContent).toBe(true);
        expect(result.problem).toBeNull();
        expect(result.shouldRenderWithBrowser).toBe(false);
    });

    test("escalates a bot-protection challenge", () => {
        const html =
            "<html><body><p>Please enable JS and disable any ad blocker</p><script>var dd={};</script></body></html>";

        const result = analyzePage(html);

        expect(result.hasContent).toBe(false);
        expect(result.problem).toBe("blocked");
        expect(result.shouldRenderWithBrowser).toBe(true);
    });

    test("escalates a script-dominated shell", () => {
        // An SPA that ships its app inline and renders nothing server-side
        const html = `<html><body><div id="root"></div><script>${"const x=1;".repeat(500)}</script></body></html>`;

        const result = analyzePage(html);

        expect(result.problem).toBe("client-rendered");
        expect(result.shouldRenderWithBrowser).toBe(true);
    });

    test("escalates a large document that yields almost no text", () => {
        // Bundles loaded via src, so inline-script share stays low
        const html = `<html><body><div id="app"></div>${"<!-- padding -->".repeat(4000)}</body></html>`;

        const result = analyzePage(html);

        expect(result.problem).toBe("client-rendered");
        expect(result.shouldRenderWithBrowser).toBe(true);
    });

    test("does NOT escalate a short but complete page", () => {
        // Thin content alone is ambiguous — without evidence of client-side
        // rendering this is just a small page, and rendering would cost seconds
        // to return the same thing.
        const html = "<html><body><h1>Status</h1><p>All systems operational.</p></body></html>";

        const result = analyzePage(html);

        expect(result.problem).toBe("empty");
        expect(result.shouldRenderWithBrowser).toBe(false);
        expect(result.contentChars).toBeGreaterThan(0);
    });

    test("reports a paywall rather than escalating", () => {
        const html = `<html><body><article><h1>Headline</h1><p>Opening paragraph of the piece.</p>
            <p>Subscribe to continue reading this article.</p></article>
            <nav>${"<a href='/x'>Section link</a>".repeat(120)}</nav></body></html>`;

        const result = analyzePage(html);

        expect(result.hasContent).toBe(false);
        expect(result.problem).toBe("paywalled");
        expect(result.shouldRenderWithBrowser).toBe(false);
    });

    test("reports boilerplate-only pages without escalating", () => {
        // Site chrome rendered fine but the article container holds only a headline
        // and teaser — the shape a paywalled article shell takes. A browser would
        // fetch the same page, so there is nothing to escalate to.
        const navItems = Array.from(
            { length: 70 },
            (_, i) => `<li><a href="/s${i}">Company section number ${i}</a></li>`,
        ).join("");
        const teaser = "<p>The transit authority is weighing automation for its busiest line, a multi-year change.</p>";
        const html =
            `<html><body><nav><ul>${navItems}</ul></nav>` +
            `<main><article><h1>Driverless trains under review</h1>${teaser.repeat(4)}</article></main>` +
            `<footer><ul>${navItems}</ul></footer></body></html>`;

        const result = analyzePage(html);

        expect(result.hasContent).toBe(false);
        expect(result.problem).toBe("no-article");
        expect(result.shouldRenderWithBrowser).toBe(false);
    });

    test("does not treat an embedded challenge widget on a real article as a block", () => {
        // A full article that happens to load a reCAPTCHA script for a newsletter form
        const html = articlePage().replace(
            "</body>",
            '<script src="https://www.google.com/recaptcha/api.js"></script><span>verify you are human</span></body>',
        );

        const result = analyzePage(html);

        expect(result.hasContent).toBe(true);
        expect(result.shouldRenderWithBrowser).toBe(false);
    });
});

describe("describeProblem", () => {
    test("gives a distinct explanation for every problem", () => {
        const problems = ["blocked", "paywalled", "client-rendered", "no-article", "empty"] as const;
        const messages = problems.map(describeProblem);

        expect(new Set(messages).size).toBe(problems.length);
        for (const message of messages) expect(message.length).toBeGreaterThan(10);
    });
});
