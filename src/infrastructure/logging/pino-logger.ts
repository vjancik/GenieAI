import pino, { type Logger as PinoInstance } from 'pino';
import type { ILogger } from '../../core/application/interfaces/logger.interface';

export class PinoLogger implements ILogger {
	private logger: PinoInstance;

	constructor(
		levelOrInstance: string | PinoInstance,
		private format: 'json' | 'text' = 'json',
		private useColor: boolean = true,
	) {
		if (typeof levelOrInstance !== 'string') {
			this.logger = levelOrInstance;
		} else {
			const level = levelOrInstance;
			const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
			const serviceName = process.env.OTEL_SERVICE_NAME || 'genie-ai-bot';

			const streams: { stream: any; level?: string }[] = [];

			// 1. Console Stream
			if (format === 'text') {
				streams.push({
					level: level as string,
					stream: {
						write: (msg: string) => {
							try {
								const log = JSON.parse(msg);
								const {
									level,
									msg: message,
									time,
									className,
									serviceName,
									context: logContext,
									hostname,
									pid,
									v,
									...rest
								} = log;

								const timeStr = this.useColor
									? `\x1b[90m${new Date(time).toLocaleTimeString()}\x1b[0m`
									: new Date(time).toLocaleTimeString();
								const levelStr = this.formatLevel(level);

								const context = className || serviceName || logContext;
								let contextStr = '';
								if (context) {
									contextStr = this.useColor ? ` \x1b[36m[${context}]\x1b[0m` : ` [${context}]`;
								}

								let output = `[${timeStr}] ${levelStr}${contextStr}: ${message}`;

								if (Object.keys(rest).length > 0) {
									const trimmedRest = this.trimStrings(rest);
									const metaStr = JSON.stringify(trimmedRest);
									output += ` ${metaStr}`;
								}

								process.stdout.write(`${output}\n`);
							} catch (e) {
								process.stdout.write(msg);
							}
						},
					},
				});
			} else {
				streams.push({ level: level as string, stream: process.stdout });
			}

			// 2. OpenTelemetry Stream (if configured)
			if (otelEndpoint) {
				streams.push({
					level: level as string,
					stream: pino.transport({
						target: 'pino-opentelemetry-transport',
						options: {
							loggerName: serviceName, // This sets the scope_name in OTel
							resourceAttributes: {
								'service.name': serviceName,
							},
						},
					}),
				});
			}

			if (streams.length > 1) {
				this.logger = pino({ level }, pino.multistream(streams));
			} else if (streams.length === 1) {
				const single = streams[0]!;
				if (format === 'text') {
					this.logger = pino({ level }, single.stream);
				} else {
					this.logger = pino({ level });
				}
			} else {
				this.logger = pino({ level });
			}
		}
	}

	child(metadata: Record<string, any>): ILogger {
		return new PinoLogger(this.logger.child(metadata), this.format, this.useColor);
	}

	private formatLevel(level: number): string {
		const label = this.getLevelLabel(level);
		if (!this.useColor) return label;

		switch (level) {
			case 10:
				return `\x1b[90m${label}\x1b[0m`; // Gray
			case 20:
				return `\x1b[34m${label}\x1b[0m`; // Blue
			case 30:
				return `\x1b[32m${label}\x1b[0m`; // Green
			case 40:
				return `\x1b[33m${label}\x1b[0m`; // Yellow
			case 50:
				return `\x1b[31m${label}\x1b[0m`; // Red
			case 60:
				return `\x1b[41m${label}\x1b[0m`; // Red background
			default:
				return `\x1b[32m${label}\x1b[0m`;
		}
	}

	private getLevelLabel(level: number): string {
		switch (level) {
			case 10:
				return 'TRACE';
			case 20:
				return 'DEBUG';
			case 30:
				return 'INFO';
			case 40:
				return 'WARN';
			case 50:
				return 'ERROR';
			case 60:
				return 'FATAL';
			default:
				return 'INFO';
		}
	}

	debug(msg: string, ...args: any[]): void {
		this.logger.debug(this.mergeArgs(msg, args));
	}

	info(msg: string, ...args: any[]): void {
		this.logger.info(this.mergeArgs(msg, args));
	}

	warn(msg: string, ...args: any[]): void {
		this.logger.warn(this.mergeArgs(msg, args));
	}

	error(msg: string, ...args: any[]): void {
		this.logger.error(this.mergeArgs(msg, args));
	}

	fatal(msg: string, ...args: any[]): void {
		this.logger.fatal(this.mergeArgs(msg, args));
	}

	private mergeArgs(msg: string, args: any[]): any {
		if (args.length === 0) return msg;
		const meta = args.length === 1 && typeof args[0] === 'object' ? args[0] : { args };

		// If meta is an Error, spreading it results in loss of non-enumerable properties (message, stack, etc.)
		if (meta instanceof Error) {
			return { err: meta, msg };
		}

		return { ...meta, msg };
	}

	private trimStrings(obj: any, depth: number = 0): any {
		if (depth >= 10) return '[Max Depth Reached]';

		if (typeof obj === 'string') {
			return obj.length > 100 ? obj.substring(0, 100) + '...' : obj;
		}
		if (typeof obj !== 'object' || obj === null) {
			return obj;
		}
		if (Array.isArray(obj)) {
			return obj.map((item) => this.trimStrings(item, depth + 1));
		}
		const trimmed: any = {};
		for (const key in obj) {
			trimmed[key] = this.trimStrings(obj[key], depth + 1);
		}
		return trimmed;
	}
}
