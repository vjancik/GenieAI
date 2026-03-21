/**
 * Dev script: renders scripts/dev/render-markdown-test.md → scripts/dev/render-markdown-test.html
 *
 * Usage: bun dev:render-md-test
 */
import { join } from "node:path";
import { MarkdownToHtmlRenderer } from "../../src/infrastructure/exporters/MarkdownToHtmlRenderer.ts";

const scriptDir = import.meta.dir;
const inputPath = join(scriptDir, "render-markdown-test.md");
const outputPath = join(scriptDir, "render-markdown-test.html");

const markdown = await Bun.file(inputPath).text();
const html = new MarkdownToHtmlRenderer().render(markdown);
await Bun.write(outputPath, html);

console.log(`Rendered → ${outputPath}`);
