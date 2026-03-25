import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import type { IImageRenderer } from "../../application/ports/IImageRenderer.ts";

/**
 * Renders HTML strings to PNG images using a singleton headless Chromium instance.
 *
 * A single browser and page are reused across calls to avoid the overhead of
 * launching a new browser per render. Requests are serialized via a queue so
 * concurrent callers don't corrupt each other's page state.
 */
export class HtmlToImageRenderer implements IImageRenderer {
    private static browser: Browser | null = null;
    private static page: Page | null = null;
    /** Serializes render calls — each request waits for the previous to finish. */
    private static queue: Promise<unknown> = Promise.resolve();

    private static async getBrowser(): Promise<Browser> {
        if (!HtmlToImageRenderer.browser) {
            HtmlToImageRenderer.browser = await chromium.launch({
                headless: true,
                args: [
                    "--disable-gpu",
                    "--disable-dev-shm-usage",
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-extensions",
                    "--disable-background-networking",
                    "--disable-default-apps",
                    "--js-flags=--max-old-space-size=256",
                ],
            });
        }
        return HtmlToImageRenderer.browser;
    }

    private static async getPage(): Promise<Page> {
        if (!HtmlToImageRenderer.page) {
            const browser = await HtmlToImageRenderer.getBrowser();
            HtmlToImageRenderer.page = await browser.newPage();
            await HtmlToImageRenderer.page.setViewportSize({ width: 1000, height: 1000 });
        }
        return HtmlToImageRenderer.page;
    }

    /**
     * Renders an HTML string to a PNG image buffer.
     *
     * Requests are queued and executed one at a time on the singleton page.
     *
     * @param html - A complete HTML document string.
     * @returns A Buffer containing the PNG image data, suitable for use as a Discord attachment.
     */
    async render(html: string): Promise<Buffer> {
        // Chain onto the queue so concurrent calls are serialized
        const result = HtmlToImageRenderer.queue.then(async () => {
            const page = await HtmlToImageRenderer.getPage();
            await page.setContent(html, { waitUntil: "networkidle" });
            // String form avoids TS dom-lib requirement — executes inside the browser where document exists
            await page.evaluateHandle("document.fonts.ready");
            return page.locator("body").screenshot({ type: "png" });
        });

        // Swallow errors from the queue perspective (caller gets the rejection directly)
        HtmlToImageRenderer.queue = result.catch(() => {});

        return result;
    }

    /**
     * Shuts down the singleton browser instance and clears all static state.
     * Call this on application shutdown to release resources.
     */
    static async shutdown(): Promise<void> {
        if (HtmlToImageRenderer.browser) {
            await HtmlToImageRenderer.browser.close();
            HtmlToImageRenderer.browser = null;
            HtmlToImageRenderer.page = null;
        }
    }
}
