export interface DiscordMessagePage {
	id: string;
	messageId: string;
	offset: number;
}

export interface IDiscordMessagePageRepository {
	create(page: Omit<DiscordMessagePage, 'id'>): Promise<string>;
	findById(id: string): Promise<DiscordMessagePage | null>;
	delete(id: string): Promise<void>;
}
