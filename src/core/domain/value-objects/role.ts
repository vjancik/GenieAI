export enum Role {
	SYSTEM = 'system',
	USER = 'user',
	ASSISTANT = 'model', // Google GenAI uses 'model' or 'assistant', usually 'model' in new SDK for role
	FUNCTION = 'function',
}
