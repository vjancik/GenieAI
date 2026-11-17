/**
 * Names of the real (non-routing) tools whose calls and results are persisted in conversation
 * history: the content fetchers plus the Tavily web search tool.
 *
 * Routing sentinels (`route_to_*`) are deliberately excluded — they are consumed by triage and
 * never reach history.
 *
 * Implemented as a const-object + extracted type so the names can be used both as values (tool
 * definitions, routing checks) and as an exhaustive key type for per-tool lookup tables.
 */
export const ToolName = {
    GET_WEBSITE: "get_website",
    GET_VIDEO_CAPTIONS: "get_video_captions",
    WEB_SEARCH: "web_search",
} as const;

export type ToolName = (typeof ToolName)[keyof typeof ToolName];

/** Tools that fetch the content of URLs from the user's message. */
export const CONTENT_TOOLS: ReadonlySet<string> = new Set<ToolName>([
    ToolName.GET_WEBSITE,
    ToolName.GET_VIDEO_CAPTIONS,
]);

/** Type guard narrowing an arbitrary tool name (e.g. from a persisted ToolMessage) to a {@link ToolName}. */
export function isToolName(name: string): name is ToolName {
    return Object.values<string>(ToolName).includes(name);
}

/**
 * Names of the routing sentinels triage can call to hand the request to an answering node.
 * They carry no arguments and produce no result, so they never reach conversation history.
 */
export const RoutingSentinel = {
    SEARCH: "route_to_search",
    PYTHON: "route_to_python",
    GENERAL: "route_to_general",
} as const;

export type RoutingSentinel = (typeof RoutingSentinel)[keyof typeof RoutingSentinel];
