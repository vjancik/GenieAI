/** Port for rendering Markdown to HTML. */
export interface IMarkdownRenderer {
    render(markdown: string): string;
}
