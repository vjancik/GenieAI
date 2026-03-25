import { describe, expect, it } from "bun:test";
import { agentStatusLabel } from "../../../src/application/formatters/agentStatus.ts";
import { AgentStatusType } from "../../../src/application/types/AgentStatus.ts";

describe("agentStatusLabel", () => {
    it("returns correct label for TRIAGE", () => {
        expect(agentStatusLabel({ type: AgentStatusType.TRIAGE })).toBe("Analyzing your request");
    });

    it("returns correct label for DOWNLOADING_ATTACHMENTS", () => {
        expect(agentStatusLabel({ type: AgentStatusType.DOWNLOADING_ATTACHMENTS })).toBe("Downloading attachments");
    });

    it("returns correct label for FETCHING_CONTENT", () => {
        expect(agentStatusLabel({ type: AgentStatusType.FETCHING_CONTENT })).toBe("Fetching content");
    });

    it("returns correct label for GENERATING", () => {
        expect(agentStatusLabel({ type: AgentStatusType.GENERATING })).toBe("Generating response");
    });

    it("returns correct label for SEARCHING", () => {
        expect(agentStatusLabel({ type: AgentStatusType.SEARCHING })).toBe("Searching the web");
    });
});
