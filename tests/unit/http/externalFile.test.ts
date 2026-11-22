import { describe, expect, test } from "bun:test";
import {
    declaredByteLength,
    resolveFileMimeType,
    resolveFileName,
} from "../../../src/infrastructure/http/externalFile.ts";

describe("resolveFileMimeType", () => {
    test("trusts a specific type the model reads as a file", () => {
        expect(resolveFileMimeType("application/pdf", "https://example.com/x")).toBe("application/pdf");
        expect(resolveFileMimeType("audio/mpeg", "https://example.com/x")).toBe("audio/mpeg");
    });

    test("rejects a specific type the model cannot read, whatever the extension says", () => {
        expect(resolveFileMimeType("application/zip", "https://example.com/x.pdf")).toBeNull();
    });

    test("infers the type from the extension for generic or missing types", () => {
        expect(resolveFileMimeType("application/octet-stream", "https://example.com/a/x.pdf?dl=1")).toBe(
            "application/pdf",
        );
        expect(resolveFileMimeType(null, "https://example.com/photo.PNG")).toBe("image/png");
    });

    test("returns null when neither the header nor the extension tells", () => {
        expect(resolveFileMimeType("application/octet-stream", "https://example.com/download")).toBeNull();
        expect(resolveFileMimeType(null, "https://example.com/archive.zip")).toBeNull();
    });
});

describe("resolveFileName", () => {
    test("prefers the extended filename* parameter", () => {
        const headers = new Headers({
            "content-disposition": "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
        });
        expect(resolveFileName(headers, "https://example.com/x")).toBe("résumé.pdf");
    });

    test("reads quoted and unquoted filename parameters", () => {
        expect(
            resolveFileName(new Headers({ "content-disposition": 'inline; filename="a b.pdf"' }), "https://e.com/x"),
        ).toBe("a b.pdf");
        expect(
            resolveFileName(new Headers({ "content-disposition": "attachment; filename=c.pdf" }), "https://e.com/x"),
        ).toBe("c.pdf");
    });

    test("falls back to the decoded last path segment, then to a generic name", () => {
        expect(resolveFileName(new Headers(), "https://example.com/docs/my%20file.pdf?x=1")).toBe("my file.pdf");
        expect(resolveFileName(new Headers(), "https://example.com/")).toBe("file");
    });
});

describe("declaredByteLength", () => {
    test("reads Content-Length", () => {
        expect(declaredByteLength(new Headers({ "content-length": "1024" }))).toBe(1024);
    });

    test("is unknown without a valid Content-Length", () => {
        expect(declaredByteLength(new Headers())).toBeNull();
        expect(declaredByteLength(new Headers({ "content-length": "abc" }))).toBeNull();
    });

    test("is unknown for a compressed body, whose length counts the bytes on the wire", () => {
        expect(declaredByteLength(new Headers({ "content-length": "1024", "content-encoding": "gzip" }))).toBeNull();
        expect(declaredByteLength(new Headers({ "content-length": "1024", "content-encoding": "identity" }))).toBe(
            1024,
        );
    });
});
