import type { Logger } from "../../application/types/Logger.ts";
import type { ChromiumProvider, ProxySettings } from "./ChromiumProvider.ts";

/** Selectors used to accept consent interstitials that block the article. */
const CONSENT_ACCEPT_SELECTORS = [
    'button[name="agree"]',
    "button.accept-all",
    'form.consent-form button[type="submit"]',
    'button[id*="accept" i]',
];

const NAVIGATION_TIMEOUT_MS = 25_000;
/** Settle time after DOM ready for client-side rendering and JS challenges. */
const SETTLE_MS = 4_000;
/**
 * How long to wait for a consent click to navigate.
 *
 * Deliberately much shorter than {@link NAVIGATION_TIMEOUT_MS}: many consent
 * widgets dismiss themselves without navigating at all, so this timeout is
 * expected to expire on a page that is working correctly.
 */
const CONSENT_NAVIGATION_TIMEOUT_MS = 8_000;
const CONSENT_CLICK_TIMEOUT_MS = 5_000;
const CONSENT_SETTLE_MS = 2_500;
/**
 * Hard ceiling on one page fetch, covering navigation, settling and consent.
 *
 * A context is one of a small number of concurrent slots, so a page that stalls
 * must not be able to hold one indefinitely and starve other fetches.
 */
const TOTAL_BUDGET_MS = 45_000;

/** Rejects if `operation` outruns its budget, so a stalled page cannot hold a context. */
async function withBudget<T>(operation: Promise<T>, budgetMs: number, url: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${budgetMs}ms loading ${url}`)), budgetMs);
    });
    try {
        return await Promise.race([operation, budget]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fetches web pages with a real browser, for sites whose content only exists
 * after JavaScript runs — client-rendered pages and JS bot-protection challenges.
 *
 * Each fetch runs in its own context, so cookies never carry between requests and
 * a proxy can be varied per call.
 */
export class BrowserPageFetcher {
    /** Cached because deriving it costs a context. */
    private userAgent: string | null = null;

    constructor(
        private readonly provider: ChromiumProvider,
        private readonly logger: Logger,
    ) {}

    private async getUserAgent(): Promise<string> {
        this.userAgent ??= await this.provider.resolveUserAgent();
        return this.userAgent;
    }

    /**
     * Loads `url` in a browser and returns the rendered HTML.
     *
     * @param url - The page to load.
     * @param proxy - Optional per-request proxy; rotating means passing different
     *   settings on the next call, since a live context's proxy cannot change.
     */
    async fetchRenderedHtml(url: string, proxy?: ProxySettings): Promise<string> {
        const userAgent = await this.getUserAgent();

        return this.provider.withContext(
            async (page) =>
                withBudget(
                    (async () => {
                        // `domcontentloaded` rather than `load`/`networkidle`: ad and tracker
                        // requests frequently never settle, and the DOM is all we need.
                        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
                        await page.waitForTimeout(SETTLE_MS);
                        await this.acceptConsentIfPresent(url, page);
                        return page.content();
                    })(),
                    TOTAL_BUDGET_MS,
                    url,
                ),
            {
                userAgent,
                locale: "en-US",
                timezoneId: "America/New_York",
                viewport: { width: 1440, height: 900 },
                ...(proxy ? { proxy } : {}),
            },
        );
    }

    /** Clicks a consent accept button when the page is showing one. */
    private async acceptConsentIfPresent(
        url: string,
        page: Parameters<Parameters<ChromiumProvider["withContext"]>[0]>[0],
    ) {
        for (const selector of CONSENT_ACCEPT_SELECTORS) {
            const button = page.locator(selector).first();
            if ((await button.count()) === 0) continue;

            this.logger.debug({ url, selector }, "Accepting consent interstitial");
            // The navigation wait is armed before the click so a fast redirect is not
            // missed, but capped short — widgets that dismiss in place never navigate,
            // and waiting the full navigation timeout for them stalls the whole fetch.
            await Promise.all([
                page
                    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: CONSENT_NAVIGATION_TIMEOUT_MS })
                    .catch(() => {}),
                button.click({ timeout: CONSENT_CLICK_TIMEOUT_MS }).catch(() => {}),
            ]);
            await page.waitForTimeout(CONSENT_SETTLE_MS);
            return;
        }
    }
}
