import type { BaseMessage } from "@langchain/core/messages";

/**
 * Resolves Discord token URL media blocks in LangChain messages to base64 data blocks,
 * ready for inline consumption by the LLM.
 */
export interface IInlineMediaNormalizer {
    normalize(messages: BaseMessage[]): Promise<BaseMessage[]>;
}
