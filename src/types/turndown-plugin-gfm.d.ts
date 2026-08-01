/**
 * Type declarations for `turndown-plugin-gfm`, which ships no bundled types
 * and has no `@types` package.
 *
 * Each export is a Turndown plugin adding GitHub Flavored Markdown support;
 * `gfm` applies all of them.
 */
declare module "turndown-plugin-gfm" {
    import type TurndownService from "turndown";

    /** Applies all GFM plugins: tables, strikethrough, task lists, highlighted code blocks. */
    export const gfm: TurndownService.Plugin;
    /** Converts `<table>` elements to Markdown pipe tables. */
    export const tables: TurndownService.Plugin;
    /** Converts `<del>` / `<s>` / `<strike>` to `~~text~~`. */
    export const strikethrough: TurndownService.Plugin;
    /** Converts checkbox list items to `- [ ]` / `- [x]`. */
    export const taskListItems: TurndownService.Plugin;
    /** Converts `<pre>` with a language class to a fenced code block. */
    export const highlightedCodeBlock: TurndownService.Plugin;
}
