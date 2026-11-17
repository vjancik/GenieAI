import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { type AnsweringNode, OrchestratorNode } from "../../../src/infrastructure/llm/agents/orchestratorNode.ts";
import {
    collectFetchedUrls,
    planTriageRoute,
    TriageOutcome,
} from "../../../src/infrastructure/llm/agents/triageRoutePlanner.ts";

const ALL_TOOLS = new Set(["get_website", "get_video_captions", "web_search"]);
/** The tools available in Google search mode, where web_search is not executable. */
const CONTENT_ONLY = new Set(["get_website", "get_video_captions"]);
const NOTHING_FETCHED = new Set<string>();

const TAVILY_ROUTES = new Map<string, AnsweringNode>([
    ["route_to_general", OrchestratorNode.GENERAL],
    ["route_to_python", OrchestratorNode.COMPUTATION],
]);
/** Google search mode adds the route to the Google Search node. */
const GOOGLE_ROUTES = new Map<string, AnsweringNode>([
    ...TAVILY_ROUTES,
    ["route_to_search", OrchestratorNode.GOOGLE_SEARCH],
]);

let nextId = 0;
function call(name: string, args: Record<string, unknown> = {}): ToolCall {
    return { name, args, id: `call_${nextId++}`, type: "tool_call" };
}

function toolMessage(name: string, content: unknown) {
    return new ToolMessage({
        content: typeof content === "string" ? content : JSON.stringify(content),
        name,
        tool_call_id: "c1",
    });
}

describe("planTriageRoute", () => {
    test("falls back to general when triage made no tool call", () => {
        const plan = planTriageRoute([], ALL_TOOLS, TAVILY_ROUTES, NOTHING_FETCHED);

        expect(plan).toEqual({
            answerNode: OrchestratorNode.GENERAL,
            outcome: TriageOutcome.NO_TOOL_CALL,
            toolCalls: new Map(),
        });
    });

    test.each([
        { sentinel: "route_to_search", answerNode: OrchestratorNode.GOOGLE_SEARCH },
        { sentinel: "route_to_python", answerNode: OrchestratorNode.COMPUTATION },
        { sentinel: "route_to_general", answerNode: OrchestratorNode.GENERAL },
    ])("routes $sentinel to the $answerNode node without tool calls to execute", ({ sentinel, answerNode }) => {
        const plan = planTriageRoute([call(sentinel)], CONTENT_ONLY, GOOGLE_ROUTES, NOTHING_FETCHED);

        expect(plan.answerNode).toBe(answerNode);
        expect(plan.outcome).toBe(TriageOutcome.SENTINEL);
        expect(plan.toolCalls.size).toBe(0);
    });

    test("lets the first recognized sentinel decide, skipping unknown tools", () => {
        const plan = planTriageRoute(
            [call("made_up_tool"), call("route_to_python"), call("route_to_general")],
            ALL_TOOLS,
            TAVILY_ROUTES,
            NOTHING_FETCHED,
        );

        expect(plan.answerNode).toBe(OrchestratorNode.COMPUTATION);
    });

    test("falls back to general when triage only called unknown tools", () => {
        const plan = planTriageRoute([call("made_up_tool")], ALL_TOOLS, TAVILY_ROUTES, NOTHING_FETCHED);

        expect(plan.answerNode).toBe(OrchestratorNode.GENERAL);
        expect(plan.outcome).toBe(TriageOutcome.UNKNOWN_TOOL);
    });

    test("treats a sentinel without a route as unknown", () => {
        // route_to_search has no destination in Tavily mode
        const plan = planTriageRoute([call("route_to_search")], ALL_TOOLS, TAVILY_ROUTES, NOTHING_FETCHED);

        expect(plan.answerNode).toBe(OrchestratorNode.GENERAL);
        expect(plan.outcome).toBe(TriageOutcome.UNKNOWN_TOOL);
    });

    test("treats web_search as unknown when it is not executable", () => {
        const plan = planTriageRoute(
            [call("web_search", { query: "q" })],
            CONTENT_ONLY,
            GOOGLE_ROUTES,
            NOTHING_FETCHED,
        );

        expect(plan.answerNode).toBe(OrchestratorNode.GENERAL);
        expect(plan.outcome).toBe(TriageOutcome.UNKNOWN_TOOL);
        expect(plan.toolCalls.size).toBe(0);
    });

    test("executes every executable call unchanged, in order, and answers with general by default", () => {
        const website = call("get_website", { urls: ["https://a.com"] });
        const search = call("web_search", { query: "q" });
        const video = call("get_video_captions", { urls: ["https://v.com"] });

        const plan = planTriageRoute(
            [website, call("made_up_tool"), search, video],
            ALL_TOOLS,
            TAVILY_ROUTES,
            NOTHING_FETCHED,
        );

        expect(plan.answerNode).toBe(OrchestratorNode.GENERAL);
        expect(plan.outcome).toBe(TriageOutcome.TOOL_CALLS);
        expect([...plan.toolCalls.entries()]).toEqual([
            [website, website],
            [search, search],
            [video, video],
        ]);
        // Unchanged calls are passed through by identity
        expect(plan.toolCalls.get(website)).toBe(website);
    });

    test.each([
        { sentinel: "route_to_search", answerNode: OrchestratorNode.GOOGLE_SEARCH },
        { sentinel: "route_to_python", answerNode: OrchestratorNode.COMPUTATION },
        { sentinel: "route_to_general", answerNode: OrchestratorNode.GENERAL },
    ])("lets $sentinel pick who answers after the tool calls ran", ({ sentinel, answerNode }) => {
        const website = call("get_website", { urls: ["https://a.com"] });

        // The sentinel's position among the calls is irrelevant
        const plan = planTriageRoute([call(sentinel), website], CONTENT_ONLY, GOOGLE_ROUTES, NOTHING_FETCHED);

        expect(plan.answerNode).toBe(answerNode);
        expect(plan.outcome).toBe(TriageOutcome.TOOL_CALLS);
        // Only the real call is executed; the sentinel never becomes a tool call to run
        expect([...plan.toolCalls.keys()]).toEqual([website]);
    });

    test("lets a sentinel route the results of a web search", () => {
        const search = call("web_search", { query: "q" });

        const plan = planTriageRoute([search, call("route_to_python")], ALL_TOOLS, TAVILY_ROUTES, NOTHING_FETCHED);

        expect(plan.answerNode).toBe(OrchestratorNode.COMPUTATION);
        expect([...plan.toolCalls.keys()]).toEqual([search]);
    });

    test("drops already-fetched URLs from a copy of the call, leaving the original untouched", () => {
        const website = call("get_website", { urls: ["https://old.com", "https://new.com"] });

        const plan = planTriageRoute([website], ALL_TOOLS, TAVILY_ROUTES, new Set(["get_website:https://old.com"]));

        const planned = plan.toolCalls.get(website);
        expect(planned).not.toBe(website);
        expect(planned).toEqual({ ...website, args: { urls: ["https://new.com"] } });
        expect(website.args).toEqual({ urls: ["https://old.com", "https://new.com"] });
    });

    test("only treats a URL as fetched for the tool that fetched it", () => {
        const video = call("get_video_captions", { urls: ["https://old.com"] });

        const plan = planTriageRoute([video], ALL_TOOLS, TAVILY_ROUTES, new Set(["get_website:https://old.com"]));

        expect(plan.toolCalls.get(video)).toBe(video);
    });

    test("skips the tools when every requested URL is already in history, and still follows the sentinel", () => {
        const fetched = new Set(["get_website:https://old.com"]);
        const website = () => call("get_website", { urls: ["https://old.com"] });

        expect(planTriageRoute([website()], CONTENT_ONLY, GOOGLE_ROUTES, fetched)).toEqual({
            answerNode: OrchestratorNode.GENERAL,
            outcome: TriageOutcome.ALREADY_FETCHED,
            toolCalls: new Map(),
        });
        expect(planTriageRoute([website(), call("route_to_search")], CONTENT_ONLY, GOOGLE_ROUTES, fetched)).toEqual({
            answerNode: OrchestratorNode.GOOGLE_SEARCH,
            outcome: TriageOutcome.ALREADY_FETCHED,
            toolCalls: new Map(),
        });
    });

    test("still runs a web search when the content calls alongside it are fully fetched", () => {
        const search = call("web_search", { query: "q" });

        const plan = planTriageRoute(
            [call("get_website", { urls: ["https://old.com"] }), search],
            ALL_TOOLS,
            TAVILY_ROUTES,
            new Set(["get_website:https://old.com"]),
        );

        expect(plan.outcome).toBe(TriageOutcome.TOOL_CALLS);
        expect([...plan.toolCalls.keys()]).toEqual([search]);
    });

    test("passes a content call with malformed arguments through for the tool to reject", () => {
        const malformed = call("get_website", { urls: "https://a.com" });

        const plan = planTriageRoute([malformed], ALL_TOOLS, TAVILY_ROUTES, new Set(["get_website:https://a.com"]));

        expect(plan.toolCalls.get(malformed)).toBe(malformed);
    });
});

describe("collectFetchedUrls", () => {
    test("collects successfully fetched URLs per content tool", () => {
        const fetched = collectFetchedUrls([
            new HumanMessage("hi"),
            toolMessage("get_website", [{ url: "https://a.com", pageContents: "A" }]),
            toolMessage("get_video_captions", [{ url: "https://v.com", videoCaptions: "V" }]),
            new AIMessage("answer"),
        ]);

        expect(fetched).toEqual(new Set(["get_website:https://a.com", "get_video_captions:https://v.com"]));
    });

    test("skips failed entries so they can be fetched again", () => {
        const fetched = collectFetchedUrls([
            toolMessage("get_website", [
                { url: "https://a.com", error: "timeout" },
                { url: "https://b.com", pageContents: "B" },
            ]),
        ]);

        expect(fetched).toEqual(new Set(["get_website:https://b.com"]));
    });

    test("ignores results of tools that don't fetch URLs", () => {
        const fetched = collectFetchedUrls([
            toolMessage("web_search", [{ url: "https://a.com", title: "A", content: "a" }]),
        ]);

        expect(fetched.size).toBe(0);
    });

    test("skips results that aren't an array of entries instead of rejecting the history", () => {
        const fetched = collectFetchedUrls([
            toolMessage("get_website", "not json"),
            toolMessage("get_website", { url: "https://a.com", pageContents: "legacy shape" }),
            toolMessage("get_website", [null, "text", { url: 42 }, { url: "https://b.com", pageContents: "B" }]),
        ]);

        expect(fetched).toEqual(new Set(["get_website:https://b.com"]));
    });
});
