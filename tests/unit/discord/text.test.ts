import { describe, expect, it } from "bun:test";
import {
    discordMessageToLlmText,
    formatUtcTimestamp,
    llmTextToDiscordText,
} from "../../../src/application/formatters/textTransformers.ts";
import type {
    IChatClientMessage,
    IChatClientMessageEmbed,
    IChatClientMessageSnapshot,
} from "../../../src/application/ports/chat/IChatClient.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_DATE = new Date("2024-01-01T00:00:00Z");

/** Builds a minimal IChatClientMessage, with all required fields defaulted. */
function makeMsg(overrides: {
    content?: string;
    authorDisplayName?: string;
    isForwarded?: boolean;
    forwardedSnapshot?: IChatClientMessageSnapshot | null;
    embeds?: IChatClientMessageEmbed[];
}): IChatClientMessage {
    return {
        id: "msg-1",
        channelId: "ch-1",
        guildId: "guild-1",
        authorId: "user-1",
        authorUsername: "alice",
        authorDisplayName: overrides.authorDisplayName ?? "Alice",
        isAuthorBot: false,
        createdAt: BASE_DATE,
        content: overrides.content ?? "",
        cleanContent: overrides.content ?? "",
        buttons: [],
        attachments: [],
        embeds: overrides.embeds ?? [],
        referencedMessageId: null,
        isForwarded: overrides.isForwarded ?? false,
        forwardedSnapshot: overrides.forwardedSnapshot ?? null,
        botRoleId: null,
        isDM: false,
        hasExplicitMention: () => false,
        reply: async () => {
            throw new Error("not implemented");
        },
        edit: async () => {
            throw new Error("not implemented");
        },
        delete: async () => {},
    };
}

/** Builds a minimal IChatClientMessageSnapshot for use as a forwardedSnapshot. */
function makeSnap(
    overrides: { content?: string; embeds?: IChatClientMessageEmbed[] } = {},
): IChatClientMessageSnapshot {
    return {
        cleanContent: overrides.content ?? "",
        content: null,
        attachments: [],
        embeds: overrides.embeds ?? [],
    };
}

/** Builds a minimal IChatClientMessageEmbed, with all optional fields defaulted to null. */
function makeEmbed(overrides: Partial<IChatClientMessageEmbed> & { type: string }): IChatClientMessageEmbed {
    return {
        title: null,
        description: null,
        authorName: null,
        providerName: null,
        timestamp: null,
        footerText: null,
        fields: [],
        video: null,
        image: null,
        thumbnail: null,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discordMessageToLlmText", () => {
    describe("basic attribution", () => {
        it("wraps content with attribution header", () => {
            expect(discordMessageToLlmText(makeMsg({ content: "Hello!" }))).toBe("Message from user Alice:\nHello!");
        });

        it("preserves multi-line content", () => {
            expect(discordMessageToLlmText(makeMsg({ authorDisplayName: "Bob", content: "Line one\nLine two" }))).toBe(
                "Message from user Bob:\nLine one\nLine two",
            );
        });

        it("handles empty content", () => {
            expect(discordMessageToLlmText(makeMsg({ authorDisplayName: "Charlie", content: "" }))).toBe(
                "Message from user Charlie:\n",
            );
        });

        it("uses 'Forwarded message:' prefix when isForwarded is true", () => {
            expect(discordMessageToLlmText(makeMsg({ content: "", isForwarded: true }))).toBe("Forwarded message:\n");
        });

        it("uses strippedContent when provided", () => {
            expect(discordMessageToLlmText(makeMsg({ content: "raw @Bot hello" }), "hello")).toBe(
                "Message from user Alice:\nhello",
            );
        });
    });

    describe("embed rendering", () => {
        it("renders a rich embed with all text fields", () => {
            const result = discordMessageToLlmText(
                makeMsg({
                    content: "Check this out",
                    embeds: [
                        makeEmbed({
                            type: "rich",
                            title: "My Title",
                            description: "A description",
                            authorName: "Author Name",
                            providerName: "Provider Name",
                        }),
                    ],
                }),
            );
            expect(result).toContain("Embedded content:");
            expect(result).toContain("Type: rich");
            expect(result).toContain("Title: My Title");
            expect(result).toContain("Description: A description");
            expect(result).toContain("Author: Author Name");
            expect(result).toContain("Source: Provider Name");
        });

        it("renders an embed with type only when no text fields are set", () => {
            const result = discordMessageToLlmText(
                makeMsg({ content: "look", embeds: [makeEmbed({ type: "image" })] }),
            );
            expect(result).toContain("Type: image");
        });

        it("renders multiple embeds in order", () => {
            const result = discordMessageToLlmText(
                makeMsg({
                    content: "x",
                    embeds: [makeEmbed({ type: "rich", title: "First" }), makeEmbed({ type: "rich", title: "Second" })],
                }),
            );
            const firstIdx = result.indexOf("Title: First");
            const secondIdx = result.indexOf("Title: Second");
            expect(firstIdx).toBeGreaterThanOrEqual(0);
            expect(secondIdx).toBeGreaterThan(firstIdx);
        });

        it("omits embed section when embeds is empty", () => {
            const result = discordMessageToLlmText(makeMsg({ content: "hi", embeds: [] }));
            expect(result).not.toContain("Embedded content:");
        });

        it("does not include URL fields in text output", () => {
            const result = discordMessageToLlmText(
                makeMsg({
                    content: "x",
                    embeds: [
                        makeEmbed({
                            type: "video",
                            video: { url: "https://example.com/video.mp4", proxyURL: null },
                            image: { url: "https://example.com/image.png", proxyURL: null },
                            thumbnail: { url: "https://example.com/thumb.png", proxyURL: null },
                        }),
                    ],
                }),
            );
            expect(result).not.toContain("https://");
        });

        it("omits description for YouTube provider embeds", () => {
            const result = discordMessageToLlmText(
                makeMsg({
                    content: "check this",
                    embeds: [
                        makeEmbed({
                            type: "video",
                            title: "Cool Video",
                            description: "A very long auto-generated transcript...",
                            providerName: "YouTube",
                        }),
                    ],
                }),
            );
            expect(result).toContain("Title: Cool Video");
            expect(result).toContain("Source: YouTube");
            expect(result).not.toContain("Description:");
        });

        it("includes description for non-YouTube provider embeds", () => {
            const result = discordMessageToLlmText(
                makeMsg({
                    content: "x",
                    embeds: [makeEmbed({ type: "rich", description: "Some context", providerName: "Twitter" })],
                }),
            );
            expect(result).toContain("Description: Some context");
        });

        it("omits absent fields without blank lines", () => {
            const result = discordMessageToLlmText(
                makeMsg({ content: "x", embeds: [makeEmbed({ type: "rich", title: "Only Title" })] }),
            );
            expect(result).not.toContain("Description:");
            expect(result).not.toContain("Author:");
            expect(result).not.toContain("Source:");
        });
    });

    describe("embed timestamp and fields", () => {
        it("formats the embed timestamp as a verbose UTC string", () => {
            const result = discordMessageToLlmText(
                makeMsg({
                    content: "x",
                    embeds: [makeEmbed({ type: "rich", timestamp: "2024-03-17T14:35:00.000Z" })],
                }),
            );
            expect(result).toContain("Date: Sunday, March 17, 2024 at 02:35:00 PM UTC");
        });

        it("renders embed fields with name and value", () => {
            const result = discordMessageToLlmText(
                makeMsg({
                    content: "x",
                    embeds: [
                        makeEmbed({
                            type: "rich",
                            fields: [
                                { name: "Field One", value: "Value One" },
                                { name: "Field Two", value: "Value Two" },
                            ],
                        }),
                    ],
                }),
            );
            expect(result).toContain("Fields: ");
            expect(result).toContain("Field One: Value One");
            expect(result).toContain("Field Two: Value Two");
        });

        it("renders embed footerText", () => {
            const result = discordMessageToLlmText(
                makeMsg({
                    content: "x",
                    embeds: [makeEmbed({ type: "rich", footerText: "Powered by Example" })],
                }),
            );
            expect(result).toContain("Footer: Powered by Example");
        });

        it("omits timestamp field when null", () => {
            const result = discordMessageToLlmText(
                makeMsg({ content: "x", embeds: [makeEmbed({ type: "rich", timestamp: null })] }),
            );
            expect(result).not.toContain("Date:");
        });

        it("omits fields section when fields array is empty", () => {
            const result = discordMessageToLlmText(
                makeMsg({ content: "x", embeds: [makeEmbed({ type: "rich", fields: [] })] }),
            );
            expect(result).not.toContain("Fields:");
        });

        it("omits footerText when null", () => {
            const result = discordMessageToLlmText(
                makeMsg({ content: "x", embeds: [makeEmbed({ type: "rich", footerText: null })] }),
            );
            expect(result).not.toContain("Footer:");
        });
    });

    describe("forwarded message rendering", () => {
        it("renders forwarded content section for forwardedSnapshot", () => {
            const result = discordMessageToLlmText(
                makeMsg({
                    content: "",
                    isForwarded: true,
                    forwardedSnapshot: makeSnap({ content: "Original message text" }),
                }),
            );
            expect(result).toContain("Forwarded content:");
            expect(result).toContain("Original message text");
        });

        it("renders embeds inside forwarded content", () => {
            const result = discordMessageToLlmText(
                makeMsg({
                    content: "",
                    isForwarded: true,
                    forwardedSnapshot: makeSnap({
                        content: "fwd text",
                        embeds: [makeEmbed({ type: "rich", title: "Fwd Embed" })],
                    }),
                }),
            );
            expect(result).toContain("Forwarded content:");
            expect(result).toContain("fwd text");
            expect(result).toContain("Title: Fwd Embed");
        });

        it("omits forwarded section when forwardedSnapshot is null", () => {
            const result = discordMessageToLlmText(makeMsg({ content: "hi", forwardedSnapshot: null }));
            expect(result).not.toContain("Forwarded content:");
        });
    });
});

describe("llmTextToDiscordText", () => {
    describe("horizontal rule removal", () => {
        it("removes --- rule", () => {
            expect(llmTextToDiscordText("Before\n---\nAfter")).toBe("Before\nAfter");
        });

        it("removes *** rule", () => {
            expect(llmTextToDiscordText("Before\n***\nAfter")).toBe("Before\nAfter");
        });

        it("removes ___ rule", () => {
            expect(llmTextToDiscordText("Before\n___\nAfter")).toBe("Before\nAfter");
        });

        it("removes rule with surrounding whitespace on the line", () => {
            expect(llmTextToDiscordText("Before\n  ---  \nAfter")).toBe("Before\nAfter");
        });

        it("removes longer rule sequences", () => {
            expect(llmTextToDiscordText("Before\n-------\nAfter")).toBe("Before\nAfter");
            expect(llmTextToDiscordText("Before\n*****\nAfter")).toBe("Before\nAfter");
        });

        it("does not remove inline dashes that are not standalone rules", () => {
            const text = "Some text -- with dashes";
            expect(llmTextToDiscordText(text)).toBe(text);
        });

        it("removes multiple rules throughout the text", () => {
            expect(llmTextToDiscordText("A\n---\nB\n***\nC")).toBe("A\nB\nC");
        });
    });

    describe("blank line collapsing", () => {
        it("collapses two consecutive blank lines into one newline", () => {
            expect(llmTextToDiscordText("A\n\nB")).toBe("A\nB");
        });

        it("collapses many consecutive blank lines into one newline", () => {
            expect(llmTextToDiscordText("A\n\n\n\nB")).toBe("A\nB");
        });

        it("collapses blank lines with only spaces/tabs", () => {
            expect(llmTextToDiscordText("A\n   \n\t\nB")).toBe("A\nB");
        });

        it("preserves single blank line between paragraphs", () => {
            // A single blank line means two consecutive newlines — these get collapsed to one \n
            // which is expected Discord behavior (no double-spacing)
            expect(llmTextToDiscordText("Para one\n\nPara two")).toBe("Para one\nPara two");
        });
    });

    describe("trimming", () => {
        it("trims leading and trailing whitespace", () => {
            expect(llmTextToDiscordText("  hello  ")).toBe("hello");
        });

        it("trims leading newlines", () => {
            expect(llmTextToDiscordText("\n\nHello")).toBe("Hello");
        });

        it("trims trailing newlines", () => {
            expect(llmTextToDiscordText("Hello\n\n")).toBe("Hello");
        });
    });

    describe("URL embed suppression", () => {
        it("wraps a bare http URL", () => {
            expect(llmTextToDiscordText("See http://example.com for details")).toBe(
                "See <http://example.com> for details",
            );
        });

        it("wraps a bare https URL", () => {
            expect(llmTextToDiscordText("Visit https://example.com/path?q=1")).toBe(
                "Visit <https://example.com/path?q=1>",
            );
        });

        it("wraps multiple URLs in the same text", () => {
            expect(llmTextToDiscordText("A: https://a.com B: https://b.com")).toBe(
                "A: <https://a.com> B: <https://b.com>",
            );
        });

        it("does not double-wrap an already-suppressed URL", () => {
            expect(llmTextToDiscordText("<https://example.com>")).toBe("<https://example.com>");
        });

        it("does not alter text with no URLs", () => {
            expect(llmTextToDiscordText("No links here.")).toBe("No links here.");
        });
    });

    describe("combined transformations", () => {
        it("removes rule then collapses blank lines left behind", () => {
            // After removing ---, we get "A\n\nB" which then collapses
            expect(llmTextToDiscordText("A\n\n---\n\nB")).toBe("A\nB");
        });

        it("handles a realistic LLM response", () => {
            const input = [
                "",
                "Here is the answer.",
                "",
                "---",
                "",
                "Some details:",
                "",
                "",
                "- Point one",
                "- Point two",
                "",
                "***",
                "",
                "Conclusion.",
                "",
            ].join("\n");

            const expected = ["Here is the answer.", "Some details:", "- Point one", "- Point two", "Conclusion."].join(
                "\n",
            );

            expect(llmTextToDiscordText(input)).toBe(expected);
        });
    });
});

describe("formatUtcTimestamp", () => {
    it("formats midnight UTC correctly", () => {
        expect(formatUtcTimestamp(new Date("2024-01-01T00:00:00Z"))).toBe("Monday, January 1, 2024 at 12:00:00 AM UTC");
    });

    it("formats noon UTC correctly", () => {
        expect(formatUtcTimestamp(new Date("2024-03-17T14:35:00Z"))).toBe("Sunday, March 17, 2024 at 02:35:00 PM UTC");
    });

    it("always appends UTC suffix", () => {
        expect(formatUtcTimestamp(new Date("2024-06-15T09:05:03Z"))).toMatch(/ UTC$/);
    });
});
