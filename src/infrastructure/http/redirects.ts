import { WebFetchError } from "../../domain/errors/AppError.ts";
import type { IExternalUrlGuard, UrlRejection } from "./ExternalUrlGuard.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Upper bound on redirect hops, matching Impit's own default. */
export const MAX_REDIRECTS = 20;

/** The parts of a response the redirect loop reads. */
export interface HopResponse {
    status: number;
    headers: Headers;
    body?: ReadableStream<Uint8Array> | null;
}

/** One request of a redirect chain. */
export interface HopRequest {
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
}

/** Performs a single request without following redirects. */
export type FetchHop<R extends HopResponse> = (url: string, request: HopRequest) => Promise<R>;

/** Whether a rejection reflects a fixed policy, rather than a failure that might clear. */
function isPolicyRejection(rejection: UrlRejection): boolean {
    return rejection.reason === "insecure-url" || rejection.reason === "private-address";
}

/**
 * Builds the error reported for a refused URL. Policy refusals say so explicitly, as the
 * model relays this message and must not suggest that a retry could succeed.
 */
function toRejectionError(startUrl: string, hopUrl: string, rejection: UrlRejection): WebFetchError {
    const where = hopUrl === startUrl ? "" : `it redirects to ${hopUrl}, but `;
    const policy = isPolicyRejection(rejection) ? " — this is a fixed policy, retrying will not help" : "";
    return new WebFetchError(rejection.reason, `${startUrl}: ${where}${rejection.description}${policy}`);
}

/** Releases the body of a response that is not going to be read. */
async function discardBody(response: HopResponse): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
}

/**
 * Requests a URL and follows its redirects one hop at a time, so that every hop can be
 * checked against the external content policy before it is requested.
 *
 * The HTTP client must not follow redirects itself: it would request the next hop before
 * the policy saw it, and the final response does not reveal the hops in between.
 *
 * Method handling matches the Fetch standard: a 303, or a 301/302 answering a POST, turns
 * into a GET without a body; 307 and 308 repeat the request as is.
 *
 * @param fetchHop - Performs one request with redirects disabled
 * @param url - The URL to start from
 * @param request - The first request; later hops derive from it
 * @param guard - Checks each URL before it is requested, the first one included
 * @returns The final response together with its URL
 * @throws WebFetchError (`insecure-url` / `private-address` / `unreachable`) when a hop is refused,
 *   when a redirect target is invalid, or when the chain exceeds {@link MAX_REDIRECTS}
 */
export async function fetchFollowingRedirects<R extends HopResponse>(
    fetchHop: FetchHop<R>,
    url: string,
    request: HopRequest,
    guard?: IExternalUrlGuard,
): Promise<{ response: R; url: string }> {
    let currentUrl = url;
    let currentRequest = request;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const rejection = await guard?.check(currentUrl);
        if (rejection) throw toRejectionError(url, currentUrl, rejection);

        const response = await fetchHop(currentUrl, currentRequest);
        const location = response.headers.get("location");
        // A redirect without a target is returned as is, like the Fetch standard does
        if (!REDIRECT_STATUSES.has(response.status) || location === null) {
            return { response, url: currentUrl };
        }

        await discardBody(response);
        try {
            currentUrl = new URL(location, currentUrl).toString();
        } catch {
            throw new WebFetchError("unreachable", `${url}: it redirects to an invalid URL (${location})`);
        }
        const becomesGet =
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) && currentRequest.method === "POST");
        if (becomesGet) currentRequest = { method: "GET", headers: currentRequest.headers };
    }

    throw new WebFetchError("unreachable", `${url}: it redirects more than ${MAX_REDIRECTS} times`);
}
