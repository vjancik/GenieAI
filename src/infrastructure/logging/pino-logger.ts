import pino, { type Logger as PinoInstance } from 'pino';
import type { ILogger } from '../../core/application/interfaces/logger.interface';

export class PinoLogger implements ILogger {
    private logger: PinoInstance;

    constructor(level: string, format: 'json' | 'text') {
        if (format === 'text') {
            // Manual "pretty" output for Windows compatibility and user request
            this.logger = pino({
                level,
                transport: undefined, // Don't use external transport
            }, {
                write: (msg: string) => {
                    try {
                        const log = JSON.parse(msg);
                        const time = new Date(log.time).toLocaleTimeString();
                        const levelStr = this.formatLevel(log.level);
                        const message = log.msg;
                        const rest = { ...log };
                        delete rest.time;
                        delete rest.level;
                        delete rest.msg;
                        delete rest.v;
                        delete rest.pid;
                        delete rest.hostname;

                        const meta = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
                        process.stdout.write(`[${time}] ${levelStr}: ${message}${meta}\n`);
                    } catch (e) {
                        process.stdout.write(msg);
                    }
                }
            });
        } else {
            this.logger = pino({
                level,
            });
        }
    }

    private formatLevel(level: number): string {
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
