import type { Logger as PinoLogger } from "pino";

/**
 * Logger type for dependency injection across application and infrastructure layers.
 *
 * Defined here in the application layer so application-layer classes can depend on it
 * without importing from infrastructure. Infrastructure's createLogger returns this type.
 *
 * This is a type-only alias for pino.Logger — the import is erased at runtime.
 */
export type Logger = PinoLogger;
