/**
 * Maps each LangGraph node to its string identifier.
 * Centralizes node names to prevent typos across addNode, addEdge, Command.goto, and return types.
 */
export const OrchestratorNode = {
    TRIAGE: "triage",
    TOOLS: "tools",
    GENERAL: "general",
    COMPUTATION: "computation",
    GOOGLE_SEARCH: "googleSearch",
} as const;

export type OrchestratorNode = (typeof OrchestratorNode)[keyof typeof OrchestratorNode];

/** The nodes that generate the user-facing answer. */
export type AnsweringNode = Exclude<OrchestratorNode, typeof OrchestratorNode.TRIAGE | typeof OrchestratorNode.TOOLS>;
