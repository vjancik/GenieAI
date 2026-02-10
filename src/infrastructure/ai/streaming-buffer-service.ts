import { type FileHandle, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ILogger } from '../../core/application/interfaces/logger.interface';
import { AIProviderError } from '../../core/domain/errors/application-error';

export interface BufferResult {
	buffer?: Buffer;
	filePath?: string;
}

export class StreamingBufferService {
	constructor(
		private readonly tempDir: string,
		private readonly logger: ILogger,
	) {}

	async readStreamWithTwoTierLimits(
		stream: ReadableStream<Uint8Array>,
		memoryLimit: number,
		diskLimit: number,
	): Promise<BufferResult> {
		const chunks: Uint8Array[] = [];
		let totalSize = 0;
		const reader = stream.getReader();
		let tempFilePath: string | undefined;
		let fileHandle: FileHandle | undefined;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				totalSize += value.length;

				if (!tempFilePath && totalSize > memoryLimit) {
					this.logger.info(`Memory limit exceeded (${totalSize} bytes), spilling to disk...`);
					await mkdir(this.tempDir, { recursive: true });
					tempFilePath = join(this.tempDir, `upload-${Date.now()}-${Math.random().toString(36).substring(7)}`);
					fileHandle = await open(tempFilePath, 'w');

					// Write already read chunks
					for (const chunk of chunks) {
						await fileHandle.write(chunk);
					}
					chunks.length = 0; // Clear memory
				}

				if (tempFilePath && fileHandle) {
					if (totalSize > diskLimit) {
						await reader.cancel();
						throw new AIProviderError(`File too large: exceeds disk limit of ${diskLimit / 1024 / 1024}MB.`);
					}
					await fileHandle.write(value);
				} else {
					chunks.push(value);
				}
			}

			if (tempFilePath && fileHandle) {
				await fileHandle.close();
				fileHandle = undefined;
				return { filePath: tempFilePath };
			} else {
				return { buffer: Buffer.concat(chunks) };
			}
		} catch (error) {
			if (fileHandle) {
				await fileHandle.close().catch(() => {});
			}
			if (tempFilePath) {
				await unlink(tempFilePath).catch(() => {});
			}
			throw error;
		} finally {
			reader.releaseLock();
		}
	}
}
