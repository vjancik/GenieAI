/**
 * Dev script: renders scripts/dev/render-markdown-test.html → scripts/dev/render-markdown-test.png
 *
 * Usage: bun dev:render-html-to-image
 */
import { join } from "node:path";
import pino from "pino";
import { ChromiumProvider } from "../../src/infrastructure/browser/ChromiumProvider.ts";
import { HtmlToImageRenderer } from "../../src/infrastructure/exporters/HtmlToImageRenderer.ts";

const scriptDir = import.meta.dir;
const inputPath = join(scriptDir, "render-markdown-test.html");
const outputPath = join(scriptDir, "render-markdown-test.png");

const html = await Bun.file(inputPath).text();
const chromiumProvider = new ChromiumProvider(pino({ level: "warn" }));
const renderer = new HtmlToImageRenderer(chromiumProvider);
const buffer = await renderer.render(html);
await Bun.write(outputPath, buffer);

await renderer.shutdown();
await chromiumProvider.shutdown();
console.log(`Rendered → ${outputPath}`);
