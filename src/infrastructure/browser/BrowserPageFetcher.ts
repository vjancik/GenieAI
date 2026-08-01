import type { Logger } from "../../application/types/Logger.ts";
import type { ChromiumProvider, ProxySettings } from "./ChromiumProvider.ts";

/** Selectors used to accept consent interstitials that block the article. */
const CONSENT_ACCEPT_SELECTORS = [
    'button[name="agree"]',
    "button.accept-all",
    'form.consent-form button[type="submit"]',
    'button[id*="accept" i]',
];

const NAVIGATION_TIMEOUT_MS = 30_000;
/** Settle time after DOM ready for client-side rendering and JS challenges. */
const SETTLE_MS = 4_000;
const CONSENT_SETTLE_MS = 2_500;

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
            async (page) => {
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
                await page.waitForTimeout(SETTLE_MS);
                await this.acceptConsentIfPresent(url, page);
                return page.content();
            },
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
            await Promise.all([
                page
                    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
                    .catch(() => {}),
                button.click({ timeout: 5_000 }).catch(() => {}),
            ]);
            await page.waitForTimeout(CONSENT_SETTLE_MS);
            return;
        }
    }
}
