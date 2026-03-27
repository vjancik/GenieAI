/**
 * Downloads a file from a URL to a local path, with progress reporting,
 * retries, and a connection timeout.
 *
 * Usage: bun scripts/docker/downloadFile.ts <URL> <output file path>
 */

import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_RETRIES = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const PROGRESS_INTERVAL_MS = 1_000;
const WRITE_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

function printHelp(): void {
    console.log("Usage: bun scripts/docker/downloadFile.ts <URL> <output file path>");
    console.log("");
    console.log("Arguments:");
    console.log("  URL              The URL to download from");
    console.log("  output file path Local file path to write the downloaded content");
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function downloadWithProgress(url: string, outputPath: string): Promise<void> {
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(connectTimer);
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentLength = response.headers.get("content-length");
    const totalBytes = contentLength !== null ? parseInt(contentLength, 10) : null;
    let downloadedBytes = 0;
    let lastProgressTime = 0;

    const body = response.body;
    if (!body) throw new Error("Response body is empty");

    await mkdir(dirname(outputPath), { recursive: true });
    const writer = Bun.file(outputPath).writer({ highWaterMark: WRITE_BUFFER_BYTES });
    const reader = body.getReader();

    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            writer.write(value);
            downloadedBytes += value.byteLength;

            const now = Date.now();
            if (now - lastProgressTime >= PROGRESS_INTERVAL_MS) {
                lastProgressTime = now;
                if (totalBytes !== null) {
                    const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
                    process.stdout.write(
                        `\rDownloading... ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)} (${pct}%)   `,
                    );
                } else {
                    process.stdout.write(`\rDownloading... ${formatBytes(downloadedBytes)}   `);
                }
            }
        }

        await writer.end();
    } catch (err) {
        reader.cancel();
        await writer.end();
        throw err;
    }

    // Final newline after progress line
    process.stdout.write("\n");
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        printHelp();
        process.exit(1);
    }

    // TYPE COERCION: length is checked above — both indices are guaranteed to be present
    const url = args[0] as string;
    const outputPath = args[1] as string;

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (attempt > 1) {
                console.log(`Retry ${attempt - 1}/${MAX_RETRIES - 1}...`);
            }
            await downloadWithProgress(url, outputPath);
            console.log(`Saved to: ${outputPath}`);
            return;
        } catch (err) {
            lastError = err;
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Attempt ${attempt} failed: ${message}`);
            // Clean up partial file; ignore error if it was never created
            await unlink(outputPath).catch(() => {});
        }
    }

    console.error(`Download failed after ${MAX_RETRIES} attempts.`);
    if (lastError instanceof Error) console.error(lastError.message);
    process.exit(1);
}

void main();
