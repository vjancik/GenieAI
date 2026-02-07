import { GoogleGenAI } from '@google/genai';
import type { ILogger } from '../../core/application/interfaces/logger.interface';
import { AIProviderError } from '../../core/domain/errors/application-error';

export interface UploadOptions {
    mimeType: string;
    size: number;
    displayName?: string;
    resumable?: boolean;
}

export interface GenAIFile {
    name: string;
    displayName: string;
    mimeType: string;
    sizeBytes: string;
    createTime: string;
    updateTime: string;
    expirationTime: string;
    sha256Hash: string;
    uri: string;
    state: string;
}

export class GoogleGenAIFileUploader {
    private apiClient: {
        getAuthHeaders(): Promise<Headers>;
        request(options: {
            path: string;
            httpMethod: string;
            body: string | Blob;
            httpOptions: { apiVersion: string; headers: Record<string, string> };
        }): Promise<{ headers: Record<string, string> }>;
    };

    constructor(
        private client: GoogleGenAI,
        private logger: ILogger
    ) {
        // Accessing protected apiClient using a type-safe cast
        this.apiClient = (client as unknown as { apiClient: GoogleGenAIFileUploader['apiClient'] }).apiClient;
    }

    async uploadStream(stream: ReadableStream, options: UploadOptions): Promise<GenAIFile> {
        this.logger.info(`Starting streaming upload for ${options.displayName || 'unnamed file'} (${options.size} bytes)`);

        try {
            // 1. Get the upload URL
            const uploadUrl = await this.fetchUploadUrl(options);
            this.logger.debug(`Obtained upload URL: ${uploadUrl}`);

            // 2. Upload the stream data
            const headers = await this.apiClient.getAuthHeaders();
            const fetchHeaders = new Headers(headers);
            fetchHeaders.set('X-Goog-Upload-Command', 'upload, finalize');
            fetchHeaders.set('X-Goog-Upload-Offset', '0');
            // Content-Length is required by some servers when streaming
            fetchHeaders.set('Content-Length', String(options.size));

            const response = await fetch(uploadUrl, {
                method: 'POST',
                headers: fetchHeaders,
                body: stream,
                // @ts-ignore - duplex is required for streaming bodies in Node.js fetch
                duplex: 'half'
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new AIProviderError(`Upload failed with status ${response.status}: ${errorText}`);
            }

            const result = await response.json() as { file: GenAIFile };
            this.logger.info(`Upload completed successfully: ${result.file.uri}`);
            return result.file;
        } catch (error) {
            this.logger.error('Streaming upload failed', error);
            throw error;
        }
    }

    private async fetchUploadUrl(options: UploadOptions): Promise<string> {
        const fileMetadata = {
            file: {
                mimeType: options.mimeType,
                displayName: options.displayName,
            }
        };

        const uploadHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(options.size),
            'X-Goog-Upload-Header-Content-Type': options.mimeType,
        };

        if (options.displayName) {
            uploadHeaders['X-Goog-Upload-File-Name'] = options.displayName;
        }

        const response = await this.apiClient.request({
            path: 'upload/v1beta/files',
            httpMethod: 'POST',
            body: JSON.stringify(fileMetadata),
            httpOptions: {
                apiVersion: '', // v1beta is in the path
                headers: uploadHeaders
            }
        });

        // The response is an HttpResponse object which has a headers property (map)
        const uploadUrl = response.headers['x-goog-upload-url'];
        if (!uploadUrl) {
            throw new AIProviderError('Server did not return x-goog-upload-url header');
        }

        return uploadUrl;
    }
}
