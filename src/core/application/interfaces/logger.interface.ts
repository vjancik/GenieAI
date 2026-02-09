export interface ILogger {
	debug(msg: string, ...args: unknown[]): void;
	info(msg: string, ...args: unknown[]): void;
	warn(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
	fatal(msg: string, ...args: unknown[]): void;
	child(metadata: Record<string, unknown>): ILogger;
}
