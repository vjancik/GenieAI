import hljs from "highlight.js";
import katex from "katex";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import markedKatex from "marked-katex-extension";
import type { IMarkdownRenderer } from "../../application/ports/IMarkdownRenderer.ts";

/**
 * Renders Markdown to a self-contained HTML string.
 *
 * Supported features:
 * - Standard Markdown (headings, lists, code blocks, blockquotes, links, etc.)
 * - GitHub-Flavored Markdown tables
 * - Syntax highlighting for fenced code blocks (highlight.js, atom-one-dark theme)
 * - Inline LaTeX: `$...$`
 * - Block LaTeX: `$$...$$`
 */
export class MarkdownToHtmlRenderer implements IMarkdownRenderer {
    private readonly marked: Marked;

    constructor() {
        this.marked = new Marked();
        this.marked.use(
            markedHighlight({
                langPrefix: "hljs language-",
                highlight(code, lang) {
                    const language = hljs.getLanguage(lang) ? lang : "plaintext";
                    return hljs.highlight(code, { language }).value;
                },
            }),
        );
        this.marked.use(
            markedKatex({
                throwOnError: false,
                // Render display-mode ($$...$$) equations as block elements
                displayMode: true,
            }),
        );
    }

    /**
     * Renders a Markdown string to a full, self-contained HTML document.
     *
     * KaTeX CSS is inlined via CDN so the output renders correctly without
     * any external build step.
     *
     * @param markdown - The Markdown source string.
     * @returns A complete HTML document string.
     */
    render(markdown: string): string {
        const body = this.marked.parse(markdown) as string;
        // Inline KaTeX stylesheet so the returned HTML is self-contained
        const katexCssVersion = katex.version;
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Rendered Markdown</title>
  <link rel="stylesheet" href="https://fonts.cdnfonts.com/css/gg-sans-2" />
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/katex@${katexCssVersion}/dist/katex.min.css"
    crossorigin="anonymous"
  />
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/highlight.js@${hljs.versionString}/styles/atom-one-dark.min.css"
    crossorigin="anonymous"
  />
  <style>
    @font-face {
      font-family: "gg sans";
      src: local("gg sans Bold");
      font-weight: 700;
    }
    @font-face {
      font-family: "gg sans";
      src: local("gg sans SemiBold");
      font-weight: 600;
    }
    @font-face {
      font-family: "gg sans";
      src: local("gg sans Medium");
      font-weight: 400 500;
    }
    /* Discord dark theme tokens */
    :root {
      --bg-primary:       #313338; /* BACKGROUND_PRIMARY — chat area */
      --bg-secondary:     #2b2d31; /* BACKGROUND_SECONDARY — sidebar */
      --bg-tertiary:      #1e1f22; /* BACKGROUND_TERTIARY — code blocks */
      --bg-modifier-hover:#35373c;
      --text-normal:      #dbdee1;
      --text-muted:       #949ba4;
      --text-link:        #00a8fc;
      --header-primary:   #f2f3f5;
      --interactive-active: #f2f3f5;
      --channeltextarea-bg: #383a40;
      --blockquote-bar:   #4e5058;
      --border-subtle:    #3f4147;
      --code-inline-bg:   #383a40;
      --code-block-bg:    #2b2d31;
      --table-row-alt:    #2e3035;
    }

    *, *::before, *::after { box-sizing: border-box; }

    body {
      background: var(--bg-primary);
      color: var(--text-normal);
      /* Discord uses Whitney, falls back to system sans */
      font-family: "gg sans", "gg sans Normal", "gg sans Medium", "gg sans SemiBold", "Noto Sans", Whitney, "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 16px;
      line-height: 1.375;
      margin: 0 auto;
      padding: 1rem 1.25rem;
      max-width: 1000px;
    }

    /* ── Headings ─────────────────────────────────── */
    h1, h2, h3, h4, h5, h6 {
      color: var(--header-primary);
      font-weight: 700;
      margin: 1.25rem 0 0.25rem;
      line-height: 1.25;
    }
    h1 { font-size: 1.5rem;   border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.3rem; }
    h2 { font-size: 1.25rem;  border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.3rem; }
    h3 { font-size: 1.0625rem; }
    h4 { font-size: 0.9375rem; }
    h5 { font-size: 0.875rem;  color: var(--text-muted); }
    h6 { font-size: 0.8125rem; color: var(--text-muted); }

    /* ── Body text ────────────────────────────────── */
    p { margin: 0.125rem 0 0.5rem; }

    a { color: var(--text-link); text-decoration: none; }
    a:hover { text-decoration: underline; }

    strong { color: var(--header-primary); font-weight: 700; }
    em     { font-style: italic; }
    del    { color: var(--text-muted); }

    /* ── Inline code ──────────────────────────────── */
    code {
      background: var(--code-inline-bg);
      color: #f8f8f2;
      padding: 0.15em 0.4em;
      border-radius: 3px;
      border: 1px solid var(--border-subtle);
      font-family: "Consolas", "Andale Mono WT", "Andale Mono", "Lucida Console", monospace;
      font-size: 0.875em;
    }

    /* ── Code blocks ──────────────────────────────── */
    pre {
      background: var(--code-block-bg) !important;
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 1rem 0.75rem !important;
      overflow-x: auto;
      margin: 0.5rem 0;
    }
    pre code {
      background: none !important;
      border: none;
      padding: 0 !important;
      font-size: 0.8125rem;
      color: #f8f8f2;
      border-radius: 0;
    }

    /* ── Blockquote ───────────────────────────────── */
    blockquote {
      border-left: 4px solid var(--blockquote-bar);
      background: transparent;
      margin: 0.25rem 0;
      padding: 0 0.75rem;
      color: var(--text-normal);
    }

    /* ── Lists ────────────────────────────────────── */
    ul, ol {
      padding-left: 1.5rem;
      margin: 0.25rem 0 0.5rem;
    }
    li { margin: 0.15rem 0; }
    /* Task list checkboxes */
    li input[type="checkbox"] {
      margin-right: 0.4em;
      accent-color: #5865f2;
    }

    /* ── Tables ───────────────────────────────────── */
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 0.75rem 0;
      font-size: 0.9375rem;
    }
    th, td {
      border: 1px solid var(--border-subtle);
      padding: 0.4rem 0.75rem;
      text-align: left;
    }
    th {
      background: var(--bg-secondary);
      color: var(--header-primary);
      font-weight: 600;
    }
    tr:nth-child(even) td { background: var(--table-row-alt); }

    /* ── Horizontal rule ──────────────────────────── */
    hr {
      border: none;
      border-top: 1px solid var(--border-subtle);
      margin: 1rem 0;
    }

    /* ── Images ───────────────────────────────────── */
    img {
      max-width: 100%;
      border-radius: 4px;
    }

    /* ── KaTeX ────────────────────────────────────── */
    .katex { color: var(--text-normal); }
    .katex-display {
      overflow-x: auto;
      overflow-y: hidden;
      margin: 0.75rem 0;
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
    }
}
