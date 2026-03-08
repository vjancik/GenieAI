/**
 * Re-exports configuration types and parsing from the application layer, and
 * provides the singleton config instance for infrastructure consumers.
 *
 * The config interface and parsing logic live in the application layer so that
 * application-layer classes can import them without violating the dependency
 * direction rule (Infrastructure → Application → Domain).
 */
import { loadConfig } from "../../application/config/AppConfig.ts";

export type {
    AppConfig,
    AttachmentMode,
} from "../../application/config/AppConfig.ts";

export const config = loadConfig();
