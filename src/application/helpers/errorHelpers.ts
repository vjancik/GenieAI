/**
 * Recursively sanitizes a value in-place for safe logging, replacing binary-like data
 * (Buffer, Uint8Array, or dense numeric arrays) with a short placeholder string.
 * Prevents multi-megabyte file payloads from spamming logs or Sentry.
 * The primary offender being discord.js on missing permissions.
 *
 * Mutates arrays, plain objects, and Error instances directly.
 * Returns the sanitized value (same reference for objects/arrays/errors,
 * replacement string for binary leaves).
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
    if (depth > 10) return value;

    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return `[Binary ${value.byteLength} bytes]`;
    }

    // Dense numeric arrays (e.g. raw byte arrays serialized as JSON)
    if (
        Array.isArray(value) &&
        value.length > 16 &&
        value.slice(0, 8).every((v) => typeof v === "number" && v >= 0 && v <= 255)
    ) {
        return `[Binary ~${value.length} bytes]`;
    }

    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            value[i] = sanitizeForLog(value[i], depth + 1);
        }
        return value;
    }

    if (value !== null && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        for (const key of Object.keys(obj)) {
            obj[key] = sanitizeForLog(obj[key], depth + 1);
        }
        return value;
    }

    return value;
}
