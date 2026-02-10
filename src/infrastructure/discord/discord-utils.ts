import { type AnyThreadChannel, type Channel, type TextBasedChannel } from 'discord.js';

/**
 * Type guard for text-based channels that have message capabilities.
 */
export function isTextBasedChannel(channel: Channel | null | undefined): channel is TextBasedChannel {
	return channel?.isTextBased() ?? false;
}

/**
 * Asserts that a channel is text-based and returns it narrowed.
 * @throws Error if the channel is not text-based or null.
 */
export function assertTextBasedChannel(
	channel: Channel | null | undefined,
	channelId?: string,
): TextBasedChannel {
	if (!channel) {
		throw new Error(channelId ? `Channel ${channelId} not found` : 'Channel not found');
	}

	if (!channel.isTextBased()) {
		throw new Error(channelId ? `Channel ${channelId} is not text-based` : 'Channel is not text-based');
	}

	return channel;
}

/**
 * Checks if a channel is a thread.
 */
export function isThreadChannel(channel: Channel | null | undefined): channel is AnyThreadChannel {
	return channel?.isThread() ?? false;
}
