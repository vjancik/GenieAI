/**
 * Returns true if the text contains any markdown features that benefit from
 * rich rendering: inline equations ($...$), block equations ($$...$$), or
 * GFM tables (a pipe-delimited header row followed by a separator row).
 *
 * @param text - The text to inspect
 */
export function hasExtendedMarkdown(text: string): boolean {
    // Block equations: $$...$$
    if (/\$\$[\s\S]+?\$\$/.test(text)) return true;
    // Inline equations: $...$ on a single line, where the character immediately after the
    // opening $ is alphanumeric or \ (LaTeX command prefix), and the character immediately
    // before the closing $ is not markdown emphasis/formatting punctuation (* _ ~ |).
    // - The char after the opening $ must be a Unicode letter/digit or \ (LaTeX command prefix).
    //   This rejects suffix-style currency like **45,000$** (followed by *) and accidental
    //   matches like $) or $/ that can appear in prose.
    // - The char before the closing $ must not be markdown emphasis punctuation (* _ ~ |).
    //   This rejects prefix-style bold currency like **$45,000** (ends with ** before $).
    // Equations inside bold like **$E = mc^2$** are unaffected — inner $ delimiters
    // are surrounded by alphanumeric chars on both sides.
    if (/\$[\p{L}\p{N}\\][^$\n]+[^*_~–—\-|\s]\$/u.test(text)) return true;
    // GFM table: a line with pipes, followed by a separator line (---|:---:|etc.)
    if (/^\|.+\|[ \t]*\n\|[ \t]*[-:| \t]+\|/m.test(text)) return true;
    return false;
}
