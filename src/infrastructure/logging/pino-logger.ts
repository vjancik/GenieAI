import pino, { type Logger as PinoInstance } from 'pino';
import type { ILogger } from '../../core/application/interfaces/logger.interface';

export class PinoLogger implements ILogger {
    private logger: PinoInstance;

    constructor(
        levelOrInstance: string | PinoInstance,
        private format: 'json' | 'text' = 'json',
        private useColor: boolean = true
    ) {
        if (typeof levelOrInstance !== 'string') {
            this.logger = levelOrInstance;
        } else {
            const level = levelOrInstance;
            if (format === 'text') {
                this.logger = pino({
                    level,
                    transport: undefined,
                }, {
                    write: (msg: string) => {
                        try {
                            const log = JSON.parse(msg);
                            const time = new Date(log.time).toLocaleTimeString();
                            const levelStr = this.formatLevel(log.level);
                            const message = log.msg;

                            // Extract context (className, serviceName, or context)
                            const context = log.className || log.serviceName || log.context;
                            let contextStr = '';
                            if (context) {
                                contextStr = this.useColor ? ` \x1b[36m[${context}]\x1b[0m` : ` [${context}]`;
                            }

                            const timeStr = this.useColor ? `\x1b[90m${time}\x1b[0m` : time;

                            process.stdout.write(`[${timeStr}] ${levelStr}${contextStr}: ${message}\n`);
                        } catch (e) {
                            process.stdout.write(msg);
                        }
                    }
                });
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
            case 10: return `\x1b[90m${label}\x1b[0m`; // Gray
            case 20: return `\x1b[34m${label}\x1b[0m`; // Blue
            case 30: return `\x1b[32m${label}\x1b[0m`;  // Green
            case 40: return `\x1b[33m${label}\x1b[0m`;  // Yellow
            case 50: return `\x1b[31m${label}\x1b[0m`; // Red
            case 60: return `\x1b[41m${label}\x1b[0m`; // Red background
            default: return `\x1b[32m${label}\x1b[0m`;
        }
    }

    private getLevelLabel(level: number): string {
        switch (level) {
            case 10: return 'TRACE';
            case 20: return 'DEBUG';
            case 30: return 'INFO';
            case 40: return 'WARN';
            case 50: return 'ERROR';
            case 60: return 'FATAL';
            default: return 'INFO';
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
        return { ...meta, msg };
    }
}
