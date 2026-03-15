import { describe, expect, it } from "bun:test";
import { llmTextToDiscordText } from "../../../src/application/formatters/textTransformers.ts";
import { discordMessageToLlmText } from "../../../src/infrastructure/discord/textTransformers.ts";

describe("discordMessageToLlmText", () => {
    it("wraps content with attribution header", () => {
        expect(discordMessageToLlmText("Alice", "Hello!")).toBe("Message from user Alice:\nHello!");
    });

    it("preserves multi-line content", () => {
        const content = "Line one\nLine two";
        expect(discordMessageToLlmText("Bob", content)).toBe("Message from user Bob:\nLine one\nLine two");
    });

    it("handles empty content", () => {
        expect(discordMessageToLlmText("Charlie", "")).toBe("Message from user Charlie:\n");
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
