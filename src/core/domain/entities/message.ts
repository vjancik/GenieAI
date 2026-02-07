import { Role } from '../value-objects/role';

export interface MessageAttachment {
    id?: string; // External Attachment ID (e.g. Discord snowflake)
    discordMessageId?: string; // The ID of the Discord Message this attachment belongs to
    channelId?: string; // The ID of the Discord Channel this attachment belongs to
    mimeType: string;
    data?: string; // Base64 encoded string (optional if using URI)
    url?: string; // Source URL
    name?: string; // Original filename
    genaiUri?: string; // Google GenAI File URI after upload
    genaiExpirationTime?: Date; // When the GenAI file expires
}

export interface MessageProps {
    id: string;
    role: Role;
    content: string;
    timestamp: Date;
    metadata?: Record<string, any>;
    parentId?: string;
    attachments?: MessageAttachment[];
}

export class Message {
    public readonly id: string;
    public readonly role: Role;
    public readonly content: string;
    public readonly timestamp: Date;
    public readonly metadata?: Record<string, any>;
    public readonly parentId?: string;
    public readonly attachments: MessageAttachment[];

    constructor(props: MessageProps) {
        this.id = props.id;
        this.role = props.role;
        this.content = props.content;
        this.timestamp = props.timestamp;
        this.metadata = props.metadata;
        this.parentId = props.parentId;
        this.attachments = props.attachments || [];
    }
}
