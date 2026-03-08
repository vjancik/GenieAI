/**
 * Minimal @google/genai test script for validating Sentry Google_GenAI instrumentation.
 *
 * Run via: bun run sentry:test
 *
 * Uses the same model as the general agent. Does NOT go through LangChain,
 * so a successful trace in Sentry means the issue is LangChain-specific.
 */

// import '../../src/infrastructure/instrumentation/sentry/instrumentation.ts';

import { GoogleGenAI } from "@google/genai";
import * as Sentry from "@sentry/bun";

if (!process.env.GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY is not set");
}

const genai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

console.log("Sending generateContent request...");

const response = await genai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: "Reply with exactly one word: hello",
});

console.log("Response:", response.text);

// Flush Sentry before the process exits so traces/spans are not dropped.
console.log("Flushing Sentry...");
await Sentry.flush(5000);
console.log("Done.");
