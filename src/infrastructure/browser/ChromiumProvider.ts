import type { Browser, BrowserContext, Page } from "patchright";
import { chromium } from "patchright";
import type { Logger } from "../../application/types/Logger.ts";

/**
 * Chromium launch arguments.
 *
 * Limited to what a container actually requires. Resource-trimming flags
 * (extension/default-app suppression, a capped JS heap) are deliberately absent
 * because this browser also loads arbitrary third-party web pages, where they
 * throttle or break script-heavy sites.
 *
 * `--disable-background-networking` is kept: it does not affect page resource
 * loading, but it stops Chromium's own telemetry and component updates from
 * being routed through (and billed against) a per-context proxy.
 *
 * `--disable-gpu` is deliberately absent. It does not merely fall back to
 * software rendering — it removes the WebGL context entirely, so
 * `canvas.getContext("webgl")` returns null, which practically no real browser
 * does. Without it, Chromium renders through SwiftShader instead. Image
 * rendering is unaffected either way (byte-identical screenshots, same timing).
 */
const CHROMIUM_ARGS = [
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-background-networking",
];

/** Proxy settings for a single browser context. */
export type ProxySettings = {
    server: string;
    username?: string;
    password?: string;
    bypass?: string;
};

/** Per-context options callers may vary between operations. */
export type ContextOptions = {
    proxy?: ProxySettings;
    userAgent?: string;
    locale?: string;
    timezoneId?: string;
    viewport?: { width: number; height: number };
};

/** Default ceiling on simultaneous ephemeral contexts (see {@link ChromiumProvider}). */
const DEFAULT_MAX_CONCURRENT_CONTEXTS = 3;

/**
 * Owns the single Chromium instance shared by every browser-backed feature
 * (image rendering and web page fetching).
 *
 * Two access patterns are exposed because their lifecycles differ:
 * - {@link acquireLongLivedContext} for callers that reuse one page across many
 *   operations (image rendering), avoiding per-operation context setup.
 * - {@link withContext} for one-shot work needing isolation — a fresh cookie jar
 *   and, optionally, its own proxy.
 *
 * Ephemeral contexts are capped by a semaphore. Page memory is unbounded now
 * that the JS heap cap is gone, so unlimited concurrent fetches could exhaust
 * container memory and take image rendering down with them.
 */
export class ChromiumProvider {
    private browser: Browser | null = null;
    /** Serializes launches so concurrent first-callers don't start several browsers. */
    private launching: Promise<Browser> | null = null;
    private activeContexts = 0;
    /** FIFO of callers waiting for an ephemeral context slot. */
    private readonly waiters: (() => void)[] = [];

    constructor(
        private readonly logger: Logger,
        private readonly maxConcurrentContexts: number = DEFAULT_MAX_CONCURRENT_CONTEXTS,
    ) {}

    /**
     * Returns the shared browser, launching it on first use.
     *
     * A previously launched browser that has since disconnected (crash, OOM) is
     * discarded and relaunched rather than handed back as a dead handle.
     */
    private async getBrowser(): Promise<Browser> {
        if (this.browser !== null && !this.browser.isConnected()) {
            this.logger.warn("Shared Chromium disconnected — relaunching");
            this.browser = null;
        }
        if (this.browser !== null) return this.browser;

        // Collapse concurrent launches onto one in-flight promise
        this.launching ??= chromium
            .launch({
                headless: true,
                // Selects the full Chromium build. Without this, headless mode resolves to
                // `chromium-headless-shell`, which the image does not install (and which
                // bot protections detect when fetching web pages).
                channel: "chromium",
                args: CHROMIUM_ARGS,
            })
            .then((browser) => {
                this.browser = browser;
                this.logger.debug({ version: browser.version() }, "Launched shared Chromium");
                return browser;
            })
            .finally(() => {
                this.launching = null;
            });

        return this.launching;
    }

    /**
     * Creates a context that the caller owns and must close.
     *
     * Not subject to the concurrency cap — intended for the small, fixed number
     * of long-lived contexts held for the process lifetime.
     */
    async acquireLongLivedContext(options: ContextOptions = {}): Promise<BrowserContext> {
        const browser = await this.getBrowser();
        return browser.newContext(options);
    }

    /** Waits for a free ephemeral-context slot. */
    private async acquireSlot(): Promise<void> {
        if (this.activeContexts < this.maxConcurrentContexts) {
            this.activeContexts++;
            return;
        }
        await new Promise<void>((resolve) => this.waiters.push(resolve));
        this.activeContexts++;
    }

    private releaseSlot(): void {
        this.activeContexts--;
        this.waiters.shift()?.();
    }

    /**
     * Runs `fn` against a page in a fresh, isolated context, then disposes of it.
     *
     * Proxy settings are per-context: a live context's proxy cannot be changed,
     * so rotating proxies means calling this again with different settings —
     * which costs a context (milliseconds), not a relaunch.
     *
     * @param fn - Receives the page; its return value is passed through.
     * @param options - Per-context settings, including {@link ProxySettings}.
     */
    async withContext<T>(fn: (page: Page) => Promise<T>, options: ContextOptions = {}): Promise<T> {
        await this.acquireSlot();
        let context: BrowserContext | null = null;
        try {
            const browser = await this.getBrowser();
            context = await browser.newContext(options);
            const page = await context.newPage();
            return await fn(page);
        } finally {
            // Closing the context is best-effort; a crashed browser makes it throw
            await context?.close().catch(() => {});
            this.releaseSlot();
        }
    }

    /**
     * Derives a user agent that does not advertise headless mode, keeping the
     * platform and version truthful.
     *
     * Chromium reports `HeadlessChrome/<version>`, which bot protections match on
     * directly. Replacing the whole string with a different platform or version
     * instead creates contradictions with `navigator.platform` and the `sec-ch-ua`
     * client hints, which is a stronger signal than the original marker.
     */
    async resolveUserAgent(): Promise<string> {
        const browser = await this.getBrowser();
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            const ua = (await page.evaluate("navigator.userAgent")) as string;
            return ua.replace("HeadlessChrome/", "Chrome/");
        } finally {
            await context.close().catch(() => {});
        }
    }

    /** Closes the shared browser. Safe to call when nothing was ever launched. */
    async shutdown(): Promise<void> {
        const browser = this.browser;
        this.browser = null;
        if (browser === null) return;
        await browser.close().catch((err: unknown) => {
            this.logger.warn({ err }, "Error closing shared Chromium");
        });
    }
}
