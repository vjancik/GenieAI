/**
 * Defines the set of discrete processing phases the agent can be in during a single turn.
 *
 * Implemented as a const-object + extracted type (rather than an enum) to allow both
 * value-level use (`AgentStatusType.TRIAGE`) and type-level exhaustiveness checks in
 * switch statements, while remaining idiomatic TypeScript.
 */
export const AgentStatusType = {
    TRIAGE: "TRIAGE",
    DOWNLOADING_ATTACHMENTS: "DOWNLOADING_ATTACHMENTS",
    FETCHING_CONTENT: "FETCHING_CONTENT",
    GENERATING: "GENERATING",
    SEARCHING: "SEARCHING",
} as const;

export type AgentStatusType = (typeof AgentStatusType)[keyof typeof AgentStatusType];

/**
 * Payload emitted when the agent transitions into a new processing phase.
 * Designed as an extensible discriminated union: add phase-specific fields
 * alongside the `type` discriminant as needed.
 */
export interface AgentStatusUpdate {
    type: AgentStatusType;
}

/**
 * Callback invoked whenever the agent transitions to a new processing phase.
 * Intended to live in LangGraph context (not state) to avoid checkpoint serialization.
 */
export type OnStatusUpdate = (update: AgentStatusUpdate) => void;

/**
 * Compile-time exhaustiveness guard for discriminated union switch statements.
 * If TypeScript allows this call, the switch is missing a case for the union member.
 * At runtime, throws with the unhandled value to surface implementation bugs immediately.
 *
 * @param x - A value that should be `never` if all union cases are handled
 */
export function assertNever(x: never): never {
    throw new Error(`Unhandled status type: ${String(x)}`);
}
