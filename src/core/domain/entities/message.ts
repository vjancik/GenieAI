import type { Role } from '../value-objects/role';

/**
 * Single source of truth for metadata shape in the system.
 */
export type Metadata = Record<string, unknown>;

/**
 * Metadata for attachments originating from Discord.
 */
export interface DiscordAttachmentSourceMetadata extends Metadata {
	discordMessageId: string;
	channelId: string;
}

/**
 * Metadata for attachments processed/persisted via Google GenAI.
 */
export interface GenAIAttachmentPersistenceMetadata extends Metadata {
	genaiUri?: string;
	genaiExpirationTime?: Date | string;
}

/**
 * Pure data representation of a message attachment.
 * Used for DTOs and Persistence.
 */
export interface MessageAttachmentData<TSource extends Metadata = Metadata, TPersistence extends Metadata = Metadata> {
	id?: string;
	mimeType: string;
	data?: string;
	url?: string;
	name?: string;
	sourceMetadata: TSource;
	persistenceMetadata: TPersistence;
}

/**
 * Properties required to create a MessageAttachment entity.
 */
export interface MessageAttachmentProps<TSource extends Metadata = Metadata, TPersistence extends Metadata = Metadata>
	extends Omit<MessageAttachmentData<TSource, TPersistence>, 'sourceMetadata' | 'persistenceMetadata'> {
	sourceMetadata?: TSource;
	persistenceMetadata?: TPersistence;
}

export abstract class MessageAttachment<TSource extends Metadata = Metadata, TPersistence extends Metadata = Metadata>
	implements MessageAttachmentData<TSource, TPersistence>
{
	public readonly id?: string;
	public readonly mimeType: string;
	public readonly data?: string;
	public readonly url?: string;
	public readonly name?: string;
	public readonly sourceMetadata: TSource;
	public readonly persistenceMetadata: TPersistence;

	constructor(props: MessageAttachmentProps<TSource, TPersistence>) {
		this.id = props.id;
		this.mimeType = props.mimeType;
		this.data = props.data;
		this.url = props.url;
		this.name = props.name;
		this.sourceMetadata = props.sourceMetadata ?? ({} as TSource);
		this.persistenceMetadata = props.persistenceMetadata ?? ({} as TPersistence);
	}

	/**
	 * Converts the entity back to a pure data object.
	 */
	// toData(): MessageAttachmentData<TSource, TPersistence> {
	// 	return {
	// 		id: this.id,
	// 		mimeType: this.mimeType,
	// 		data: this.data,
	// 		url: this.url,
	// 		name: this.name,
	// 		sourceMetadata: { ...this.sourceMetadata },
	// 		persistenceMetadata: { ...this.persistenceMetadata },
	// 	};
	// }
}

/**
 * Concrete implementation for Discord attachments.
 */
export class DiscordAttachment<TPersistence extends Metadata = Metadata> extends MessageAttachment<
	DiscordAttachmentSourceMetadata,
	TPersistence
> {}

/**
 * Generic concrete implementation for attachments.
 */
export class BaseAttachment extends MessageAttachment<Metadata, Metadata> {}

export enum MessageSource {
	DISCORD = 'discord',
	WEB = 'web',
}

export interface MessageProps<TMetadata extends Metadata = Metadata> {
	id: string;
	role: Role;
	content: string;
	timestamp: Date;
	metadata?: TMetadata;
	parentId?: string;
	attachments?: MessageAttachment[];
}

export abstract class Message<TMetadata extends Metadata = Metadata> {
	public readonly id: string;
	public readonly role: Role;
	public readonly content: string;
	public readonly timestamp: Date;
	public readonly metadata: TMetadata;
	public readonly parentId?: string;
	public readonly attachments: MessageAttachment[];
	public abstract readonly source: MessageSource;

	constructor(props: MessageProps<TMetadata>) {
		this.id = props.id;
		this.role = props.role;
		this.content = props.content;
		this.timestamp = props.timestamp;
		this.metadata = props.metadata ?? ({} as TMetadata);
		this.parentId = props.parentId;
		this.attachments = props.attachments ?? [];
	}

	/**
	 * Factory method to create the appropriate Message subclass based on source.
	 */
	static create(props: MessageProps & { source: MessageSource }): Message {
		const { source } = props;

		switch (source) {
			case MessageSource.DISCORD:
				return new DiscordMessage(props as MessageProps<DiscordMessageMetadata>);
			case MessageSource.WEB:
				return new WebMessage(props as MessageProps<WebMessageMetadata>);
			default:
				return assertNever(source);
		}
	}

	abstract formatForAI(options?: { label?: string }): {
		text: string;
	};
}

/**
 * Helper for exhaustive switch checks.
 */
function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${value}`);
}

/**
 * Metadata for messages originating from or targeted at Discord.
 */
export interface DiscordMessageMetadata extends Record<string, unknown> {
	userId: string;
	authorName: string;
}

/**
 * Concrete implementation for Discord-specific messages.
 */
export class DiscordMessage extends Message<DiscordMessageMetadata> {
	public readonly source = MessageSource.DISCORD;

	formatForAI(options: { label?: string } = {}): {
		text: string;
	} {
		const { label = 'Message from user named' } = options;
		const authorName = this.metadata.authorName ?? 'Unknown User';

		const text = `${label} ${authorName}\nMessage content:\n${this.content}`;

		return { text };
	}
}

/**
 * Metadata for messages originating from the Web.
 */
export interface WebMessageMetadata extends Record<string, unknown> {
	userId?: string;
	userName?: string;
}

/**
 * Concrete implementation for Web-specific messages.
 */
export class WebMessage extends Message<WebMessageMetadata> {
	public readonly source = MessageSource.WEB;

	formatForAI(options: { label?: string } = {}): {
		text: string;
	} {
		const { label = 'Message from web user' } = options;
		const userName = this.metadata.userName ?? 'Anonymous';

		const text = `${label} ${userName}\nMessage content:\n${this.content}`;

		return { text };
	}
}
