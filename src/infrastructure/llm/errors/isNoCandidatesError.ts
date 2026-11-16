/**
 * Returns true if the error is the `@langchain/google` `NoCandidatesError`, thrown when the Gemini
 * API responds without any answer candidates and without reporting that the prompt was blocked.
 *
 * Matched structurally on its name because the package does not export the class.
 */
export function isNoCandidatesError(err: unknown): boolean {
    return err instanceof Error && err.name === "NoCandidatesError";
}
