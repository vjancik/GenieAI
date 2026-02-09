import { type MessageAttachment } from '../../domain/entities/message';

export interface IAttachmentManager {
	/**
	 * Retrieves the file stream for an attachment.
	 * Implementing classes should handle refreshing stale URLs if necessary.
	 */
	getAttachmentStream(
		attachment: MessageAttachment,
		messageId: string,
	): Promise<{
		stream: ReadableStream;
		mimeType: string;
		contentLength?: number;
	}>;

	/**
	 * Updates attachment metadata (e.g. saving the Google File URI).
	 */
	updateAttachmentMetadata(
		messageId: string,
		attachmentId: string,
		metadata: Partial<MessageAttachment>,
	): Promise<void>;
}
