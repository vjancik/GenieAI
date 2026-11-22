import { file as bunFile } from "bun";
import { isGeminiNativeMimeType } from "../../application/helpers/geminiMimeType.ts";
import { parseMimeType } from "../../application/helpers/parseMimeType.ts";

/** The MIME type servers fall back to when they don't know what they are serving. */
const GENERIC_BINARY_MIME_TYPE = "application/octet-stream";

/** Name given to a file whose URL and headers reveal none. */
const FALLBACK_FILE_NAME = "file";

/**
 * Extensions of text and source code files. Servers often deliver these as the generic binary
 * type (or a non-standard one), so the extension is what reveals that they are readable text.
 */
const TEXT_FILE_EXTENSIONS = new Set([
    // Prose, data and configuration
    "txt",
    "text",
    "md",
    "markdown",
    "mdx",
    "rst",
    "adoc",
    "asciidoc",
    "org",
    "tex",
    "bib",
    "log",
    "csv",
    "tsv",
    "json",
    "jsonc",
    "json5",
    "jsonl",
    "ndjson",
    "geojson",
    "ipynb",
    "xml",
    "xsd",
    "xsl",
    "svg",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "properties",
    "env",
    "lock",
    "srt",
    "vtt",
    "diff",
    "patch",
    // Markup and styles
    "html",
    "htm",
    "xhtml",
    "css",
    "scss",
    "sass",
    "less",
    "vue",
    "svelte",
    "astro",
    // Programming languages
    "c",
    "h",
    "cc",
    "cpp",
    "cxx",
    "hpp",
    "hh",
    "hxx",
    "cs",
    "fs",
    "fsx",
    "java",
    "kt",
    "kts",
    "scala",
    "groovy",
    "gradle",
    "go",
    "rs",
    "swift",
    "m",
    "mm",
    "dart",
    "zig",
    "nim",
    "v",
    "d",
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "mts",
    "cts",
    "tsx",
    "py",
    "pyi",
    "rb",
    "php",
    "pl",
    "pm",
    "lua",
    "r",
    "jl",
    "ex",
    "exs",
    "erl",
    "hrl",
    "hs",
    "elm",
    "clj",
    "cljs",
    "edn",
    "ml",
    "mli",
    "sol",
    "asm",
    "s",
    "vhd",
    "vhdl",
    "sv",
    // Shells, build and infrastructure
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "psm1",
    "bat",
    "cmd",
    "sql",
    "graphql",
    "gql",
    "proto",
    "tf",
    "hcl",
    "nix",
    "cmake",
    "mk",
    "dockerfile",
]);

/** Names of extensionless (or dot-) files that are text by convention. */
const TEXT_FILE_NAMES = new Set([
    "dockerfile",
    "makefile",
    "gnumakefile",
    "rakefile",
    "gemfile",
    "procfile",
    "jenkinsfile",
    "vagrantfile",
    "readme",
    "license",
    "changelog",
    ".gitignore",
    ".gitattributes",
    ".dockerignore",
    ".editorconfig",
    ".env",
]);

/** Extensions read as HTML rather than as plain text. */
const HTML_FILE_EXTENSIONS = new Set(["html", "htm", "xhtml"]);

/** The path of a URL, or null when the URL cannot be parsed. */
function pathOf(url: string): string | null {
    try {
        return decodeURIComponent(new URL(url).pathname);
    } catch {
        return null;
    }
}

/** Whether a Content-Type tells nothing about the content: absent, empty, or the generic binary type. */
export function isGenericMimeType(mimeType: string | null): boolean {
    return mimeType === null || mimeType === "" || mimeType === GENERIC_BINARY_MIME_TYPE;
}

/**
 * Infers from a URL whether it points at a text or source code file, see {@link TEXT_FILE_EXTENSIONS}.
 * Meant for responses whose Content-Type is generic: a specific type always takes precedence.
 *
 * @param url - The final URL of the response, after redirects
 * @returns `text/html` for HTML files, `text/plain` for other text files, or null when the
 *   URL does not name a text file
 */
export function inferTextContentType(url: string): string | null {
    const fileName = pathOf(url)?.split("/").at(-1)?.toLowerCase();
    if (!fileName) return null;
    if (TEXT_FILE_NAMES.has(fileName)) return "text/plain";

    const dot = fileName.lastIndexOf(".");
    if (dot <= 0) return null;
    const extension = fileName.slice(dot + 1);
    if (HTML_FILE_EXTENSIONS.has(extension)) return "text/html";
    return TEXT_FILE_EXTENSIONS.has(extension) ? "text/plain" : null;
}

/**
 * Determines the MIME type of a file served from the web, as far as the model can read it.
 *
 * The response's Content-Type is trusted when it names a specific type. Servers that answer
 * with the generic binary type (or none at all) are common for downloads, so in that case
 * the type is inferred from the file extension in the URL.
 *
 * @param headerMimeType - The bare media type from the Content-Type header, or null when absent
 * @param url - The final URL of the response, after redirects
 * @returns A type the model reads as a file (PDF, image, audio, video), or null when the
 *   response is of any other type
 */
export function resolveFileMimeType(headerMimeType: string | null, url: string): string | null {
    if (headerMimeType !== null && !isGenericMimeType(headerMimeType)) {
        return isGeminiNativeMimeType(headerMimeType) ? headerMimeType : null;
    }

    const path = pathOf(url);
    if (path === null) return null;
    // Bun derives the type from the extension alone; the file is never touched
    const inferred = parseMimeType(bunFile(path).type);
    return inferred !== null && isGeminiNativeMimeType(inferred) ? inferred : null;
}

/**
 * Picks a display name for a file served from the web: the name suggested by the
 * Content-Disposition header, else the last segment of the URL path.
 */
export function resolveFileName(headers: Headers, url: string): string {
    const disposition = headers.get("content-disposition");
    // RFC 6266: the extended `filename*` parameter (charset'lang'value) takes precedence
    const extended = disposition?.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i)?.[1];
    if (extended !== undefined) {
        try {
            return decodeURIComponent(extended.trim());
        } catch {
            // Malformed percent-encoding: fall through to the plain parameter
        }
    }
    const plain = disposition?.match(/filename\s*=\s*(?:"([^"]*)"|([^;]+))/i);
    const fromHeader = (plain?.[1] ?? plain?.[2])?.trim();
    if (fromHeader) return fromHeader;

    const segment = pathOf(url)?.split("/").filter(Boolean).at(-1);
    return segment ?? FALLBACK_FILE_NAME;
}

/**
 * Reads the size of a response body from its headers.
 *
 * A compressed response is reported as unknown: its Content-Length counts the bytes on the
 * wire, while the body is read decompressed and so comes out larger.
 *
 * @returns The exact number of bytes the body yields, or null when the headers don't tell
 */
export function declaredByteLength(headers: Headers): number | null {
    const encoding = headers.get("content-encoding");
    if (encoding !== null && encoding.trim() !== "" && encoding.trim().toLowerCase() !== "identity") return null;

    const header = headers.get("content-length");
    if (header === null) return null;
    const length = Number(header);
    return Number.isSafeInteger(length) && length >= 0 ? length : null;
}
