import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/**
 * Signatures of bot-protection interstitials. Only meaningful on documents that
 * yielded little text — a full article page can legitimately embed a reCAPTCHA
 * widget script for an unrelated newsletter form.
 */
const CHALLENGE_PATTERN =
    /please enable JS and disable any ad blocker|Checking your browser|just a moment|cf_chl_|px-captcha|perimeterx|unusual activity|complete the security check|enable javascript and cookies|verify you are (a )?human/i;

/** Signatures of subscription gates. Reported to the model rather than retried. */
const PAYWALL_PATTERN =
    /subscribe to (continue|read)|this (content|article) is for subscribers|already a subscriber|to continue reading|sign in to (continue|read)/i;

/** Below this many characters, a page has not produced usable content. */
const MIN_CONTENT_CHARS = 1000;
/**
 * Visible text above this length means the page's chrome rendered, so an absent
 * article is a content decision rather than a rendering failure.
 */
const SUBSTANTIAL_CHROME_CHARS = 2000;
/** Inline-script share above which a thin page looks client-rendered. */
const CLIENT_RENDERED_SCRIPT_SHARE = 50;
/** A document this large yielding almost no text is a shell regardless of script ratio. */
const LARGE_DOCUMENT_BYTES = 50_000;
const LARGE_DOCUMENT_MIN_TEXT = 500;

/** Why a page did not yield usable content. */
export type PageProblem = "blocked" | "paywalled" | "client-rendered" | "no-article" | "empty";

/** Structural read of a fetched HTML document. */
export type PageAnalysis = {
    /** Article text extracted with boilerplate stripped, or "" when none was found. */
    articleText: string;
    /** All visible text, scripts and styles removed. */
    visibleText: string;
    /** Best available content length — the larger of the two above. */
    contentChars: number;
    /** Whether the page produced enough text to be worth returning. */
    hasContent: boolean;
    /** Best guess at what went wrong, when {@link hasContent} is false. */
    problem: PageProblem | null;
    /** Whether re-fetching with a JS-capable browser could plausibly change the outcome. */
    shouldRenderWithBrowser: boolean;
};

/** Collapses whitespace so length comparisons are not skewed by formatting. */
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** Visible text with non-content elements removed. */
function extractVisibleText(html: string): string {
    const { document } = parseHTML(html);
    for (const element of [...document.querySelectorAll("script,style,noscript,svg,template")]) {
        element.remove();
    }
    return normalize(document.body?.textContent ?? "");
}

/** Readability's article text, or "" when the page is not article-shaped. */
function extractArticleText(html: string): string {
    try {
        const { document } = parseHTML(html);
        // TYPE COERCION: linkedom's Document is structurally compatible with the
        // subset of the DOM Readability uses, but the two type definitions differ.
        const article = new Readability(document as never).parse();
        return normalize(article?.textContent ?? "");
    } catch {
        // Readability throws on documents it cannot make sense of
        return "";
    }
}

/** Share of the document that is inline script, as a percentage. */
function inlineScriptShare(html: string): number {
    if (html.length === 0) return 0;
    const scriptBytes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].reduce(
        (total, match) => total + (match[1]?.length ?? 0),
        0,
    );
    return (scriptBytes / html.length) * 100;
}

/**
 * Decides whether a fetched page yielded usable content, and if not, whether a
 * JS-capable browser could change that.
 *
 * Escalation keys on *positive evidence* of client-side rendering rather than on
 * the absence of text. Thin content is ambiguous on its own — a short but
 * complete page and an unrendered shell look identical — so a page is only
 * escalated when it is thin AND shows a challenge signature, a script-dominated
 * body, or a large document that produced almost no text.
 *
 * @param html - The raw HTML as fetched.
 */
export function analyzePage(html: string): PageAnalysis {
    const visibleText = extractVisibleText(html);
    const articleText = extractArticleText(html);
    const contentChars = Math.max(articleText.length, visibleText.length);
    const hasContent = contentChars >= MIN_CONTENT_CHARS;

    if (hasContent) {
        // A page can carry plenty of text and still be a subscription gate; report
        // that so the model can tell the user rather than summarizing the notice.
        if (PAYWALL_PATTERN.test(html) && articleText.length < MIN_CONTENT_CHARS) {
            return {
                articleText,
                visibleText,
                contentChars,
                hasContent: false,
                problem: "paywalled",
                shouldRenderWithBrowser: false,
            };
        }
        // Plenty of navigation and footer text but no article body. The chrome
        // rendered, so the article is being withheld rather than left unrendered —
        // running a browser produces the same page, so there is nothing to escalate to.
        if (visibleText.length >= SUBSTANTIAL_CHROME_CHARS && articleText.length < MIN_CONTENT_CHARS) {
            return {
                articleText,
                visibleText,
                contentChars,
                hasContent: false,
                problem: "no-article",
                shouldRenderWithBrowser: false,
            };
        }
        return {
            articleText,
            visibleText,
            contentChars,
            hasContent: true,
            problem: null,
            shouldRenderWithBrowser: false,
        };
    }

    const challenged = CHALLENGE_PATTERN.test(html);
    const scriptHeavy = inlineScriptShare(html) >= CLIENT_RENDERED_SCRIPT_SHARE;
    const emptyLargeDocument = html.length > LARGE_DOCUMENT_BYTES && visibleText.length < LARGE_DOCUMENT_MIN_TEXT;

    if (challenged) {
        return {
            articleText,
            visibleText,
            contentChars,
            hasContent,
            problem: "blocked",
            shouldRenderWithBrowser: true,
        };
    }
    if (scriptHeavy || emptyLargeDocument) {
        return {
            articleText,
            visibleText,
            contentChars,
            hasContent,
            problem: "client-rendered",
            shouldRenderWithBrowser: true,
        };
    }
    if (PAYWALL_PATTERN.test(html)) {
        return {
            articleText,
            visibleText,
            contentChars,
            hasContent,
            problem: "paywalled",
            shouldRenderWithBrowser: false,
        };
    }

    // Thin, script-light and unremarkable: a genuinely short page. Rendering it
    // would cost seconds and return the same content.
    return { articleText, visibleText, contentChars, hasContent, problem: "empty", shouldRenderWithBrowser: false };
}

/** Human-readable explanation of a page problem, for the model to relay. */
export function describeProblem(problem: PageProblem): string {
    switch (problem) {
        case "blocked":
            return "the site blocked automated access (bot protection challenge)";
        case "paywalled":
            return "the content is behind a paywall or subscription gate";
        case "client-rendered":
            return "the page renders its content with JavaScript that could not be executed";
        case "no-article":
            return "the page returned only navigation and boilerplate, with no article body";
        case "empty":
            return "the page returned no readable content";
    }
}
