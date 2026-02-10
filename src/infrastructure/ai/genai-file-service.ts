import { type File, FileState, type GoogleGenAI } from '@google/genai';
import type { ILogger } from '../../core/application/interfaces/logger.interface';
import { AIProviderError } from '../../core/domain/errors/application-error';
import { type GenAIFile, GoogleGenAIFileUploader } from './google-genai-file-uploader';

export class GenAIFileService {
	private fileUploader: GoogleGenAIFileUploader;
	private static getFileGate: Promise<void> = Promise.resolve();

	constructor(
		private readonly client: GoogleGenAI,
		private readonly logger: ILogger,
	) {
		this.fileUploader = new GoogleGenAIFileUploader(client, logger);
	}

	async uploadStream(
		stream: ReadableStream<Uint8Array>,
		options: { mimeType: string; size: number; displayName?: string },
	) {
		return this.fileUploader.uploadStream(stream, options);
	}

	async uploadDirect(file: Blob | string, options: { mimeType: string; displayName?: string }) {
		return this.client.files.upload({
			file,
			config: options,
		});
	}

	async waitForFileProcessing(file: File | GenAIFile): Promise<File | GenAIFile> {
		let fileState = file.state;
		const fileName = file.name;

		if (!fileName) return file;

		if (fileState === FileState.ACTIVE || fileState === FileState.STATE_UNSPECIFIED) {
			return file;
		}

		if (fileState === FileState.FAILED) {
			throw new AIProviderError(`File upload failed processing immediately: ${fileName}`);
		}

		this.logger.info(`File ${fileName} is in state ${fileState}. Waiting for processing...`);

		let currentDelay = 1000;
		const expGrowthRate = 1.5;
		const maxDelay = 5000;
		const startTime = Date.now();
		const timeout = 5 * 60 * 1000;

		while (fileState === FileState.PROCESSING && Date.now() - startTime < timeout) {
			await new Promise((resolve) => setTimeout(resolve, currentDelay));
			currentDelay = Math.min(currentDelay * expGrowthRate, maxDelay);

			try {
				const updatedFile = await this.getFileWithRateLimit(fileName);
				fileState = updatedFile.state;

				if (fileState === FileState.ACTIVE || fileState === FileState.STATE_UNSPECIFIED) {
					return updatedFile;
				}

				if (fileState === FileState.FAILED) {
					throw new AIProviderError(`File processing failed for ${fileName}`);
				}
			} catch (error) {
				this.logger.warn(`Error polling file state for ${fileName}:`, error);
			}
		}

		throw new AIProviderError(`File ${fileName} timed out processing.`);
	}

	private async getFileWithRateLimit(fileName: string): Promise<File> {
		const currentGate = GenAIFileService.getFileGate;
		let resolveNext: (() => void) | undefined;
		GenAIFileService.getFileGate = new Promise((r) => {
			resolveNext = r;
		});

		await currentGate;
		try {
			return await this.client.files.get({ name: fileName });
		} finally {
			setTimeout(() => resolveNext?.(), 1000);
		}
	}
}
