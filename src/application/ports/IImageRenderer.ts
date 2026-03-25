/** Port for rendering HTML to a PNG image buffer. */
export interface IImageRenderer {
    render(html: string): Promise<Buffer>;
}
