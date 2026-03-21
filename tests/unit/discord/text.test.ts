import { describe, expect, it } from "bun:test";
import { discordMessageToLlmText, llmTextToDiscordText } from "../../../src/application/formatters/textTransformers.ts";

describe("discordMessageToLlmText", () => {
    describe("basic attribution", () => {
        it("wraps content with attribution header", () => {
            expect(discordMessageToLlmText({ authorDisplayName: "Alice", content: "Hello!" })).toBe(
                "Message from user Alice:\nHello!",
            );
        });

        it("preserves multi-line content", () => {
            expect(discordMessageToLlmText({ authorDisplayName: "Bob", content: "Line one\nLine two" })).toBe(
                "Message from user Bob:\nLine one\nLine two",
            );
        });

        it("handles empty content", () => {
            expect(discordMessageToLlmText({ authorDisplayName: "Charlie", content: "" })).toBe(
                "Message from user Charlie:\n",
            );
        });

        it("uses 'Forwarded message:' prefix when isForwarded is true", () => {
            expect(discordMessageToLlmText({ authorDisplayName: "Alice", content: "", isForwarded: true })).toBe(
                "Forwarded message:\n",
            );
        });
    });

    describe("embed rendering", () => {
        it("renders a rich embed with all text fields", () => {
            const result = discordMessageToLlmText({
                authorDisplayName: "Alice",
                content: "Check this out",
                embeds: [
                    {
                        type: "rich",
                        title: "My Title",
                        description: "A description",
                        author: { name: "Author Name" },
                        provider: { name: "Provider Name" },
                    },
                ],
            });
            expect(result).toContain("Embedded content:");
            expect(result).toContain("Type: rich");
            expect(result).toContain("Title: My Title");
            expect(result).toContain("Description: A description");
            expect(result).toContain("Author: Author Name");
            expect(result).toContain("Source: Provider Name");
            expect(result).toContain("END");
        });

        it("renders an embed with type only when no text fields are set", () => {
            const result = discordMessageToLlmText({
                authorDisplayName: "Alice",
                content: "look",
                embeds: [{ type: "image" }],
            });
            expect(result).toContain("Type: image");
            expect(result).toContain("END");
        });

        it("renders multiple embeds in order", () => {
            const result = discordMessageToLlmText({
                authorDisplayName: "Alice",
                content: "x",
                embeds: [
                    { type: "rich", title: "First" },
                    { type: "rich", title: "Second" },
                ],
            });
            const firstIdx = result.indexOf("Title: First");
            const secondIdx = result.indexOf("Title: Second");
            expect(firstIdx).toBeGreaterThanOrEqual(0);
            expect(secondIdx).toBeGreaterThan(firstIdx);
        });

        it("omits embed section when embeds is undefined", () => {
            const result = discordMessageToLlmText({ authorDisplayName: "Alice", content: "hi" });
            expect(result).not.toContain("Embedded content:");
            expect(result).not.toContain("END");
        });

        it("omits embed section when embeds array is empty", () => {
            const result = discordMessageToLlmText({ authorDisplayName: "Alice", content: "hi", embeds: [] });
            expect(result).not.toContain("Embedded content:");
            expect(result).not.toContain("END");
        });

        it("does not include URL fields in text output", () => {
            const result = discordMessageToLlmText({
                authorDisplayName: "Alice",
                content: "x",
                embeds: [
                    {
                        type: "video",
                        video: { url: "https://example.com/video.mp4" },
                        image: { url: "https://example.com/image.png" },
                        thumbnail: { url: "https://example.com/thumb.png" },
                    },
                ],
            });
            expect(result).not.toContain("https://");
        });

        it("omits description for YouTube provider embeds", () => {
            const result = discordMessageToLlmText({
                authorDisplayName: "Alice",
                content: "check this",
                embeds: [
                    {
                        type: "video",
                        title: "Cool Video",
                        description: "A very long auto-generated transcript...",
                        provider: { name: "YouTube" },
                    },
                ],
            });
            expect(result).toContain("Title: Cool Video");
            expect(result).toContain("Source: YouTube");
            expect(result).not.toContain("Description:");
        });

        it("includes description for non-YouTube provider embeds", () => {
            const result = discordMessageToLlmText({
                authorDisplayName: "Alice",
                content: "x",
                embeds: [{ type: "rich", description: "Some context", provider: { name: "Twitter" } }],
            });
            expect(result).toContain("Description: Some context");
        });

        it("omits absent fields without blank lines", () => {
            const result = discordMessageToLlmText({
                authorDisplayName: "Alice",
                content: "x",
                embeds: [{ type: "rich", title: "Only Title" }],
            });
            expect(result).not.toContain("Description:");
            expect(result).not.toContain("Author:");
            expect(result).not.toContain("Source:");
        });
    });

    describe("forwarded message snapshot rendering", () => {
        it("renders forwarded content section for messageSnapshots", () => {
            const result = discordMessageToLlmText({
                authorDisplayName: "Alice",
                content: "",
                isForwarded: true,
                messageSnapshots: [{ authorDisplayName: "", content: "Original message text" }],
            });
            expect(result).toContain("Forwarded content:");
            expect(result).toContain("Original message text");
            expect(result).toContain("END");
        });

        it("renders embeds inside forwarded content", () => {
            const result = discordMessageToLlmText({
                authorDisplayName: "Alice",
                content: "",
                isForwarded: true,
                messageSnapshots: [
                    {
                        authorDisplayName: "",
                        content: "fwd text",
                        embeds: [{ type: "rich", title: "Fwd Embed" }],
                    },
                ],
            });
            expect(result).toContain("Forwarded content:");
            expect(result).toContain("fwd text");
            expect(result).toContain("Title: Fwd Embed");
            expect(result).toContain("END");
        });

        it("omits forwarded section when messageSnapshots is undefined", () => {
            const result = discordMessageToLlmText({ authorDisplayName: "Alice", content: "hi" });
            expect(result).not.toContain("Forwarded content:");
        });
    });

    describe("END marker", () => {
        it("appends END when embeds are present", () => {
            const result = discordMessageToLlmText({
                authorDisplayName: "Alice",
                content: "x",
                embeds: [{ type: "rich" }],
            });
            expect(result.endsWith("END")).toBe(true);
        });

        it("appends END when messageSnapshots are present", () => {
            const result = discordMessageToLlmText({
                authorDisplayName: "Alice",
                content: "x",
                messageSnapshots: [{ authorDisplayName: "", content: "snap" }],
            });
            expect(result.endsWith("END")).toBe(true);
        });

        it("does not append END when neither embeds nor snapshots are present", () => {
            const result = discordMessageToLlmText({ authorDisplayName: "Alice", content: "hi" });
            expect(result.endsWith("END")).toBe(false);
        });
    });
});

describe("discordMessageToLlmText (legacy two-arg style — via snapshot shape)", () => {
    // Ensure all previous call-site shapes still work via the snapshot object
    it("wraps content with attribution header", () => {
        expect(discordMessageToLlmText({ authorDisplayName: "Alice", content: "Hello!" })).toBe(
            "Message from user Alice:\nHello!",
        );
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
