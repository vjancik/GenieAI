/**
 * Dev script for testing Gemini's built-in code execution tool.
 * Invokes (or streams) the model with a prompt that requires computation and saves the
 * raw AIMessage / AIMessageChunk JSON to timestamped files in this directory.
 *
 * Run via: bunx cross-env AGENT=1 bun run scripts/dev/gemini-code-execution-test.ts
 */

import { type AIMessageChunk, HumanMessage, type MessageOutputVersion } from "@langchain/core/messages";
import { ChatGoogle } from "@langchain/google/node";

const MODEL = "gemini-3.1-flash-lite-preview";
const PROMPT = "Describe the normal distribution of IQ scores into a graphic for me";

/** Parse the first API key from a comma-separated GOOGLE_FREE_API_KEYS env var. */
function getApiKey(): string {
    const raw = process.env.GOOGLE_FREE_API_KEYS ?? "";
    const key = raw.split(",")[0]?.trim();
    if (!key) throw new Error("GOOGLE_FREE_API_KEYS is not set or empty");
    return key;
}

function buildLlm(outputVersion: MessageOutputVersion) {
    return new ChatGoogle({
        model: MODEL,
        outputVersion,
        apiKey: getApiKey(),
    }); //.bindTools([{ codeExecution: {} }]);
}

const llms: Record<MessageOutputVersion, ReturnType<typeof buildLlm>> = {
    v0: buildLlm("v0"),
    v1: buildLlm("v1"),
};

function makeBasePath(outputVersion: MessageOutputVersion, mode: "invoke" | "stream"): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${import.meta.dir}/gemini-code-execution-${timestamp}-${outputVersion}-${mode}`;
}

async function runInvoke(outputVersion: MessageOutputVersion): Promise<void> {
    const llm = llms[outputVersion];

    console.log(`[invoke] outputVersion="${outputVersion}" — "${PROMPT}"`);

    const result = await llm.invoke([new HumanMessage(PROMPT)]);
    const outPath = `${makeBasePath(outputVersion, "invoke")}.json`;

    await Bun.write(outPath, JSON.stringify(result.toJSON(), null, 2));
    console.log(`Saved: ${outPath}`);
}

async function collectStream(outputVersion: MessageOutputVersion): Promise<AIMessageChunk[]> {
    const llm = llms[outputVersion];

    console.log(`[stream] outputVersion="${outputVersion}" — "${PROMPT}"`);

    const chunks: AIMessageChunk[] = [];
    let firstChunkAt: number | null = null;
    const invokedAt = Date.now();
    for await (const chunk of await llm.stream([new HumanMessage(PROMPT)])) {
        firstChunkAt ??= Date.now();
        chunks.push(chunk);
    }
    const now = Date.now();
    const streamDurationMs = firstChunkAt !== null ? now - firstChunkAt : 0;
    const totalDurationMs = now - invokedAt;
    console.log(`Stream duration (first → last chunk): ${streamDurationMs}ms`);
    console.log(`Total response time (invoke → last chunk): ${totalDurationMs}ms`);
    return chunks;
}

async function saveChunks(chunks: AIMessageChunk[], basePath: string): Promise<void> {
    const outPath = `${basePath}-chunks.json`;
    await Bun.write(
        outPath,
        JSON.stringify(
            chunks.map((c) => c.toJSON()),
            null,
            2,
        ),
    );
    console.log(`Saved: ${outPath}`);
}

async function saveCollected(chunks: AIMessageChunk[], basePath: string): Promise<void> {
    const [first, ...rest] = chunks;
    if (!first) throw new Error("No chunks received from stream");
    const collected = rest.reduce((acc, chunk) => acc.concat(chunk), first);
    const outPath = `${basePath}-collected.json`;
    await Bun.write(outPath, JSON.stringify(collected.toJSON(), null, 2));
    console.log(`Saved: ${outPath}`);
}

async function runStream(outputVersion: MessageOutputVersion): Promise<void> {
    const chunks = await collectStream(outputVersion);
    const basePath = makeBasePath(outputVersion, "stream");
    await Promise.all([saveChunks(chunks, basePath), saveCollected(chunks, basePath)]);
}

async function runCodeExecution(outputVersion: MessageOutputVersion, stream = false): Promise<void> {
    if (stream) {
        await runStream(outputVersion);
    } else {
        await runInvoke(outputVersion);
    }
}

await runCodeExecution("v0", true);

// await runCodeExecution("v1", true);
