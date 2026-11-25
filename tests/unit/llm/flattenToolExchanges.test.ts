import { describe, expect, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages";
import pino from "pino";
import { ToolName } from "../../../src/application/types/ToolName.ts";
import { AppError } from "../../../src/domain/errors/AppError.ts";
import { flattenToolExchanges } from "../../../src/infrastructure/llm/agents/flattenToolExchanges.ts";

const testLogger = pino({ level: "silent" });

/** Builds a triage-style AIMessage carrying one tool call per given tool name. */
function toolCallMessage(...names: string[]) {
    return new AIMessage({
        content: "",
        tool_calls: names.map((name, i) => ({ name, args: {}, id: `call_${i}`, type: "tool_call" as const })),
    });
}

/** Builds a ToolMessage whose content is the JSON-serialized result, as the orchestrator persists it. */
function toolResult(name: string, result: unknown, id = "call_0") {
    return new ToolMessage({ content: JSON.stringify(result), name, tool_call_id: id });
}

/** Returns the string content of the message at `index`, failing the test if it is not a HumanMessage. */
function humanTextAt(messages: BaseMessage[], index: number): string {
    const message = messages[index];
    expect(message).toBeInstanceOf(HumanMessage);
    expect(typeof message?.content).toBe("string");
    return message?.content as string;
}

describe("flattenToolExchanges", () => {
    test("returns a history without tool exchanges unchanged", () => {
        const messages = [new HumanMessage("hi"), new AIMessage("hello"), new HumanMessage("bye")];

        const result = flattenToolExchanges(messages, testLogger);

        expect(result.exchangeCount).toBe(0);
        expect(result.messages).toEqual(messages);
        // Untouched messages are passed through by reference
        expect(result.messages[1]).toBe(messages[1] as BaseMessage);
    });

    test("replaces a website exchange with a single HumanMessage", () => {
        const messages = [
            new HumanMessage("Summarize https://example.com"),
            toolCallMessage(ToolName.GET_WEBSITE),
            toolResult(ToolName.GET_WEBSITE, [{ url: "https://example.com", pageContents: "Page body" }]),
        ];

        const result = flattenToolExchanges(messages, testLogger);

        expect(result.exchangeCount).toBe(1);
        expect(result.messages).toHaveLength(2);
        expect(result.messages[0]).toBe(messages[0] as BaseMessage);
        expect(humanTextAt(result.messages, 1)).toBe("Website contents of https://example.com:\nPage body");
    });

    test("renders video captions with title and author, and falls back to the URL without a title", () => {
        const messages = [
            toolCallMessage(ToolName.GET_VIDEO_CAPTIONS),
            toolResult(ToolName.GET_VIDEO_CAPTIONS, [
                { url: "https://youtu.be/a", videoCaptions: "(0:01) hello", title: "Video A", author: "Alice" },
                { url: "https://youtu.be/b", videoCaptions: "(0:02) world" },
            ]),
        ];

        const text = humanTextAt(flattenToolExchanges(messages, testLogger).messages, 0);

        expect(text).toBe(
            'Video captions of "Video A" by Alice (https://youtu.be/a):\n(0:01) hello\n\n' +
                "Video captions of https://youtu.be/b:\n(0:02) world",
        );
    });

    test("renders failed entries as retrieval failures", () => {
        const messages = [
            toolCallMessage(ToolName.GET_WEBSITE, ToolName.GET_VIDEO_CAPTIONS),
            toolResult(
                ToolName.GET_WEBSITE,
                [
                    {
                        url: "https://example.com",
                        error: "https://example.com: the request timed out",
                        reason: "timeout",
                    },
                ],
                "call_0",
            ),
            toolResult(
                ToolName.GET_VIDEO_CAPTIONS,
                [{ url: "https://youtu.be/a", error: "This video has no captions or subtitles available", title: "A" }],
                "call_1",
            ),
        ];

        const text = humanTextAt(flattenToolExchanges(messages, testLogger).messages, 0);

        expect(text).toBe(
            "Failed to retrieve website contents: https://example.com: the request timed out\n\n" +
                'Failed to retrieve video captions of "A" (https://youtu.be/a): This video has no captions or subtitles available',
        );
    });

    test("renders web search results as numbered sources", () => {
        const messages = [
            toolCallMessage(ToolName.WEB_SEARCH),
            toolResult(ToolName.WEB_SEARCH, [
                { url: "https://a.com", title: "A", content: "first", score: 0.9, raw_content: null },
                { url: "https://b.com", title: "B", content: "second" },
            ]),
        ];

        const text = humanTextAt(flattenToolExchanges(messages, testLogger).messages, 0);

        expect(text).toBe("Web search context:\n[1] A (https://a.com)\nfirst\n\n[2] B (https://b.com)\nsecond");
    });

    test("explains an empty web search to the model, naming the query", () => {
        const messages = [
            new AIMessage({
                content: "",
                tool_calls: [
                    { name: ToolName.WEB_SEARCH, args: { query: "obscure topic" }, id: "call_0", type: "tool_call" },
                ],
            }),
            toolResult(ToolName.WEB_SEARCH, []),
        ];

        const text = humanTextAt(flattenToolExchanges(messages, testLogger).messages, 0);

        expect(text).toBe(
            'Web search context:\nThe web search for "obscure topic" found no results, so there is no web content ' +
                "to base the answer on. Tell the user that nothing relevant could be found online. If you answer " +
                "from your own knowledge instead, say so, and point out that it may be outdated.",
        );
    });

    test("explains an empty web search without a query when the call has none", () => {
        const messages = [toolCallMessage(ToolName.WEB_SEARCH), toolResult(ToolName.WEB_SEARCH, [])];

        const text = humanTextAt(flattenToolExchanges(messages, testLogger).messages, 0);

        expect(text).toStartWith("Web search context:\nThe web search found no results,");
    });

    test("merges all ToolMessages of one exchange into one HumanMessage", () => {
        const messages = [
            new HumanMessage("Compare these"),
            toolCallMessage(ToolName.GET_WEBSITE, ToolName.GET_VIDEO_CAPTIONS),
            toolResult(ToolName.GET_WEBSITE, [{ url: "https://example.com", pageContents: "Page" }], "call_0"),
            toolResult(ToolName.GET_VIDEO_CAPTIONS, [{ url: "https://youtu.be/a", videoCaptions: "Caps" }], "call_1"),
        ];

        const result = flattenToolExchanges(messages, testLogger);

        expect(result.exchangeCount).toBe(1);
        expect(result.messages).toHaveLength(2);
        expect(humanTextAt(result.messages, 1)).toBe(
            "Website contents of https://example.com:\nPage\n\nVideo captions of https://youtu.be/a:\nCaps",
        );
    });

    test("flattens exchanges from past turns and the current turn, keeping answers in place", () => {
        const messages = [
            new HumanMessage("Summarize https://example.com"),
            toolCallMessage(ToolName.GET_WEBSITE),
            toolResult(ToolName.GET_WEBSITE, [{ url: "https://example.com", pageContents: "Page" }]),
            new AIMessage("It is a page."),
            new HumanMessage("What's new on this topic?"),
            toolCallMessage(ToolName.WEB_SEARCH),
            toolResult(ToolName.WEB_SEARCH, [{ url: "https://a.com", title: "A", content: "news" }]),
        ];

        const result = flattenToolExchanges(messages, testLogger);

        expect(result.exchangeCount).toBe(2);
        expect(result.messages.map((m) => m.type)).toEqual(["human", "human", "ai", "human", "human"]);
        expect(result.messages[2]).toBe(messages[3] as BaseMessage);
        // No tool call or tool response survives the rewrite
        expect(result.messages.some((m) => m instanceof ToolMessage)).toBe(false);
        expect(result.messages.some((m) => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0)).toBe(false);
    });

    test("recognizes streamed AIMessageChunks carrying tool calls", () => {
        const messages = [
            new AIMessageChunk({
                content: "",
                tool_calls: [{ name: ToolName.GET_WEBSITE, args: {}, id: "call_0", type: "tool_call" }],
            }),
            toolResult(ToolName.GET_WEBSITE, [{ url: "https://example.com", pageContents: "Page" }]),
        ];

        const result = flattenToolExchanges(messages, testLogger);

        expect(result.exchangeCount).toBe(1);
        expect(result.messages).toHaveLength(1);
    });

    test("forwards raw content under a neutral label for unknown tools and unrecognized shapes", () => {
        const messages = [
            toolCallMessage("legacy_tool", ToolName.GET_WEBSITE, ToolName.WEB_SEARCH),
            new ToolMessage({ content: "plain text result", name: "legacy_tool", tool_call_id: "call_0" }),
            toolResult(ToolName.GET_WEBSITE, [{ link: "https://example.com", body: "old shape" }], "call_1"),
            new ToolMessage({ content: "not json", name: ToolName.WEB_SEARCH, tool_call_id: "call_2" }),
        ];

        const text = humanTextAt(flattenToolExchanges(messages, testLogger).messages, 0);

        expect(text).toBe(
            "Retrieved context:\nplain text result\n\n" +
                'Retrieved context:\n[{"link":"https://example.com","body":"old shape"}]\n\n' +
                "Retrieved context:\nnot json",
        );
    });

    test("does not mutate the input array", () => {
        const messages = [
            new HumanMessage("Summarize"),
            toolCallMessage(ToolName.GET_WEBSITE),
            toolResult(ToolName.GET_WEBSITE, [{ url: "https://example.com", pageContents: "Page" }]),
        ];
        const snapshot = [...messages];

        flattenToolExchanges(messages, testLogger);

        expect(messages).toEqual(snapshot);
        expect(messages).toHaveLength(3);
    });

    test("throws when a tool call has no response", () => {
        const messages = [
            new HumanMessage("Summarize"),
            toolCallMessage(ToolName.GET_WEBSITE, ToolName.GET_VIDEO_CAPTIONS),
            toolResult(ToolName.GET_WEBSITE, [{ url: "https://example.com", pageContents: "Page" }]),
        ];

        expect(() => flattenToolExchanges(messages, testLogger)).toThrow(AppError);
    });

    test("throws when a trailing AIMessage tool call has no response at all", () => {
        const messages = [new HumanMessage("Search this"), toolCallMessage(ToolName.WEB_SEARCH)];

        expect(() => flattenToolExchanges(messages, testLogger)).toThrow(AppError);
    });

    test("throws on a ToolMessage without a preceding tool call", () => {
        const messages = [
            new HumanMessage("Summarize"),
            toolResult(ToolName.GET_WEBSITE, [{ url: "https://example.com", pageContents: "Page" }]),
        ];

        expect(() => flattenToolExchanges(messages, testLogger)).toThrow(AppError);
    });

    test("throws on more tool responses than tool calls", () => {
        const messages = [
            toolCallMessage(ToolName.GET_WEBSITE),
            toolResult(ToolName.GET_WEBSITE, [{ url: "https://a.com", pageContents: "A" }], "call_0"),
            toolResult(ToolName.GET_WEBSITE, [{ url: "https://b.com", pageContents: "B" }], "call_1"),
        ];

        expect(() => flattenToolExchanges(messages, testLogger)).toThrow(AppError);
    });
});

describe("flattenToolExchanges — files found by the website tool", () => {
    const FILE_URL = "https://example.com/report.pdf";
    const fileEntry = { url: FILE_URL, file: { mimeType: "application/pdf", name: "report.pdf", sizeBytes: 100 } };

    test("embeds the file as a media block right after the text introducing it", () => {
        const messages = [
            new HumanMessage("summarize these"),
            toolCallMessage(ToolName.GET_WEBSITE),
            toolResult(ToolName.GET_WEBSITE, [
                { url: "https://example.com/a", pageContents: "Page A" },
                fileEntry,
                { url: "https://example.com/b", pageContents: "Page B" },
            ]),
        ];

        const result = flattenToolExchanges(messages, testLogger, { embedExternalFiles: true, httpsOnly: false });

        expect(result.messages[1]).toBeInstanceOf(HumanMessage);
        expect(result.messages[1]?.content).toEqual([
            {
                type: "text",
                text: `Website contents of https://example.com/a:\nPage A\n\nFile retrieved from ${FILE_URL} (report.pdf, application/pdf):`,
            },
            { type: "media", mimeType: "application/pdf", url: FILE_URL },
            { type: "text", text: "Website contents of https://example.com/b:\nPage B" },
        ]);
    });

    test("mentions a plain HTTP file with the policy instead of embedding it when HTTPS is required", () => {
        const httpEntry = { ...fileEntry, url: "http://example.com/report.pdf" };
        const messages = [toolCallMessage(ToolName.GET_WEBSITE), toolResult(ToolName.GET_WEBSITE, [httpEntry])];

        const text = humanTextAt(
            flattenToolExchanges(messages, testLogger, { embedExternalFiles: true, httpsOnly: true }).messages,
            0,
        );

        expect(text).toContain("http://example.com/report.pdf");
        expect(text).toContain("only HTTPS URLs are allowed");
    });

    test("still embeds HTTPS files when HTTPS is required", () => {
        const messages = [toolCallMessage(ToolName.GET_WEBSITE), toolResult(ToolName.GET_WEBSITE, [fileEntry])];

        const result = flattenToolExchanges(messages, testLogger, { embedExternalFiles: true, httpsOnly: true });

        expect(result.messages[0]?.content).toContainEqual({
            type: "media",
            mimeType: "application/pdf",
            url: FILE_URL,
        });
    });

    test("only mentions the file in text when embedding is disabled", () => {
        const messages = [toolCallMessage(ToolName.GET_WEBSITE), toolResult(ToolName.GET_WEBSITE, [fileEntry])];

        const text = humanTextAt(flattenToolExchanges(messages, testLogger).messages, 0);

        expect(text).toContain(FILE_URL);
        expect(text).toContain("could not be loaded");
    });

    test("leaves the original tool messages untouched", () => {
        const tool = toolResult(ToolName.GET_WEBSITE, [fileEntry]);
        const messages = [toolCallMessage(ToolName.GET_WEBSITE), tool];

        flattenToolExchanges(messages, testLogger, { embedExternalFiles: true, httpsOnly: false });

        expect(messages[1]).toBe(tool);
        expect(tool.content).toBe(JSON.stringify([fileEntry]));
    });
});
