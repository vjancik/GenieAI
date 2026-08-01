import type { BrowserContext, Page } from "patchright";
import type { IImageRenderer } from "../../application/ports/IImageRenderer.ts";
import type { ChromiumProvider } from "../browser/ChromiumProvider.ts";

/**
 * Renders HTML strings to PNG images on the shared Chromium instance.
 *
 * Holds one long-lived context and page, reused across calls to avoid per-render
 * setup cost. Requests are serialized via a queue so concurrent callers don't
 * corrupt each other's page state.
 *
 * The browser itself is owned by {@link ChromiumProvider} and shared with web
 * page fetching, so the image carries a single Chromium build.
 */
export class HtmlToImageRenderer implements IImageRenderer {
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    /** Serializes render calls — each request waits for the previous to finish. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly provider: ChromiumProvider) {}

    /**
     * Returns the reusable render page, recreating it if the browser was
     * restarted underneath us (crash, OOM) and the handle went stale.
     */
    private async getPage(): Promise<Page> {
        if (this.page !== null && !this.page.isClosed()) return this.page;

        this.context = await this.provider.acquireLongLivedContext({ viewport: { width: 1000, height: 1000 } });
        this.page = await this.context.newPage();
        return this.page;
    }

    /**
     * Renders an HTML string to a PNG image buffer.
     *
     * Requests are queued and executed one at a time on the reused page.
     *
     * @param html - A complete HTML document string.
     * @returns A Buffer containing the PNG image data, suitable for use as a Discord attachment.
     */
    async render(html: string): Promise<Buffer> {
        // Chain onto the queue so concurrent calls are serialized
        const result = this.queue.then(async () => {
            const page = await this.getPage();
            await page.setContent(html, { waitUntil: "networkidle" });
            // String form avoids TS dom-lib requirement — executes inside the browser where document exists
            await page.evaluateHandle("document.fonts.ready");
            return page.locator("body").screenshot({ type: "png" });
        });

        // Swallow errors from the queue perspective (caller gets the rejection directly)
        this.queue = result.catch(() => {});

        return result;
    }

    /**
     * Releases this renderer's context and page.
     *
     * Does not close the shared browser — that belongs to {@link ChromiumProvider}.
     */
    async shutdown(): Promise<void> {
        const context = this.context;
        this.context = null;
        this.page = null;
        await context?.close().catch(() => {});
    }
}
