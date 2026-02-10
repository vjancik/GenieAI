import type { MessageAttachment, Metadata } from '../../domain/entities/message';

export interface IAttachmentManager<TSource extends Metadata = Metadata, TPersistence extends Metadata = Metadata> {
	/**
	 * Retrieves the file stream for an attachment.
	 * Implementing classes should handle refreshing stale URLs if necessary.
	 */
	getAttachmentStream(
		attachment: MessageAttachment<TSource, TPersistence>,
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
		metadata: Partial<MessageAttachment<TSource, TPersistence>>,
	): Promise<void>;
}
