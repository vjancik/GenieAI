import type { BaseMessage } from "@langchain/core/messages";
import type { OnStatusUpdate } from "../types/AgentStatus.ts";

/**
 * Resolves Discord token URL media blocks in LangChain messages to base64 data blocks,
 * ready for inline consumption by the LLM.
 */
export interface IInlineMediaNormalizer {
    normalize(messages: BaseMessage[], onStatusUpdate?: OnStatusUpdate): Promise<BaseMessage[]>;
}
