import { AgentStatusType, type AgentStatusUpdate, assertNever } from "../types/AgentStatus.ts";

/**
 * Maps an agent status update to a human-readable status string.
 *
 * The switch is exhaustive: any new {@link AgentStatusType} value without a matching
 * case is caught at compile time via {@link assertNever}.
 */
export function agentStatusLabel(update: AgentStatusUpdate): string {
    switch (update.type) {
        case AgentStatusType.TRIAGE:
            return "Analyzing your request";
        case AgentStatusType.DOWNLOADING_ATTACHMENTS:
            return "Downloading attachments";
        case AgentStatusType.FETCHING_CONTENT:
            return "Fetching content";
        case AgentStatusType.GENERATING:
            return "Generating response";
        case AgentStatusType.SEARCHING:
            return "Searching the web";
        case AgentStatusType.COMPUTING:
            return "Running computation";
        default:
            return assertNever(update.type);
    }
}
