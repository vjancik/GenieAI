import { describe, expect, it } from "bun:test";
import { safeParseTavilyResponse } from "../../../src/infrastructure/llm/tools/tavilySearchTool.ts";

describe("safeParseTavilyResponse", () => {
    it("parses a pre-parsed object directly", () => {
        const obj = { results: [{ url: "https://example.com", title: "Example", content: "text" }] };

        const { objResponse, parsed } = safeParseTavilyResponse(obj);

        expect(objResponse).toBe(obj);
        expect(parsed.success).toBe(true);
    });

    it("JSON.parses a string input before validating", () => {
        const obj = { results: [{ url: "https://example.com", title: "Example", content: "text" }] };
        const raw = JSON.stringify(obj);

        const { objResponse, parsed } = safeParseTavilyResponse(raw);

        expect(objResponse).toEqual(obj);
        expect(parsed.success).toBe(true);
    });

    it("returns parsed.success=false when results field is missing", () => {
        const { parsed } = safeParseTavilyResponse({ query: "test" });

        expect(parsed.success).toBe(false);
    });

    it("returns the raw objResponse even when parse fails", () => {
        const obj = { notResults: [] };
        const { objResponse, parsed } = safeParseTavilyResponse(obj);

        expect(objResponse).toBe(obj);
        expect(parsed.success).toBe(false);
    });
});
