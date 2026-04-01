import { describe, expect, it, mock } from "bun:test";
import { parseFileConfig } from "../../../src/application/config/AppConfig.ts";
import type { Logger } from "../../../src/application/types/Logger.ts";
import { ConfigError } from "../../../src/domain/errors/AppError.ts";

function makeLogger(): { logger: Logger; warnMock: ReturnType<typeof mock> } {
    const warnMock = mock(() => {});
    // TYPE COERCION: partial mock — only `warn` is needed by parseFileConfig
    const logger = { warn: warnMock } as unknown as Logger;
    return { logger, warnMock };
}

const VALID_YAML = `
agent:
  nodes:
    triage:
      model: "gemini-flash-lite"
      fallbackModel: "gemini-flash"
      timeoutMs: 60000
      apiKeyType: "free"
    general:
      model: "gemini-flash"
      fallbackModel: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    computation:
      model: "gemini-flash"
      fallbackModel: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    search:
      model: "gemini-pro"
      fallbackModel: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "paid"
`;

describe("parseFileConfig", () => {
    it("parses a valid yaml config", () => {
        const config = parseFileConfig(VALID_YAML);
        expect(config.agent.nodes.triage.model).toBe("gemini-flash-lite");
        expect(config.agent.nodes.triage.fallbackModel).toBe("gemini-flash");
        expect(config.agent.nodes.triage.timeoutMs).toBe(60000);
        expect(config.agent.nodes.general.model).toBe("gemini-flash");
        expect(config.agent.nodes.search.model).toBe("gemini-pro");
    });

    it("accepts fallbackModel being absent", () => {
        const yaml = `
agent:
  nodes:
    triage:
      model: "gemini-flash-lite"
      timeoutMs: 60000
      apiKeyType: "free"
    general:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    computation:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    search:
      model: "gemini-pro"
      timeoutMs: 120000
      apiKeyType: "paid"
`;
        const config = parseFileConfig(yaml);
        expect(config.agent.nodes.triage.fallbackModel).toBeUndefined();
    });

    it("throws ConfigError for invalid yaml syntax", () => {
        expect(() => parseFileConfig("{unclosed")).toThrow(ConfigError);
    });

    it("includes the sourceName in yaml parse error messages", () => {
        expect(() => parseFileConfig("{unclosed", "config.yaml")).toThrow(
            /Failed to parse yaml config at "config\.yaml"/,
        );
    });

    it("uses a default sourceName when none is provided", () => {
        expect(() => parseFileConfig("{unclosed")).toThrow(/Failed to parse yaml config at "<config>"/);
    });

    it("throws ConfigError when a required field is missing", () => {
        const yaml = `
agent:
  nodes:
    triage:
      model: "gemini-flash-lite"
      timeoutMs: 60000
    general:
      model: "gemini-flash"
      timeoutMs: 120000
`;
        expect(() => parseFileConfig(yaml, "test.yaml")).toThrow(ConfigError);
    });

    it("throws ConfigError when agent section is missing entirely", () => {
        expect(() => parseFileConfig("foo: bar", "test.yaml")).toThrow(ConfigError);
    });

    it("throws ConfigError when model is not a string", () => {
        const yaml = `
agent:
  nodes:
    triage:
      model: 123
      timeoutMs: 60000
    general:
      model: "gemini-flash"
      timeoutMs: 120000
    search:
      model: "gemini-pro"
      timeoutMs: 120000
`;
        expect(() => parseFileConfig(yaml, "test.yaml")).toThrow(ConfigError);
    });

    it("throws ConfigError when timeoutMs is not a positive integer", () => {
        const yaml = `
agent:
  nodes:
    triage:
      model: "gemini-flash-lite"
      timeoutMs: -1
    general:
      model: "gemini-flash"
      timeoutMs: 120000
    search:
      model: "gemini-pro"
      timeoutMs: 120000
`;
        expect(() => parseFileConfig(yaml, "test.yaml")).toThrow(ConfigError);
    });

    it("throws ConfigError when timeoutMs is absent", () => {
        const yaml = `
agent:
  nodes:
    triage:
      model: "gemini-flash-lite"
    general:
      model: "gemini-flash"
      timeoutMs: 120000
    search:
      model: "gemini-pro"
      timeoutMs: 120000
`;
        expect(() => parseFileConfig(yaml, "test.yaml")).toThrow(ConfigError);
    });

    it("includes the sourceName in schema validation error messages", () => {
        expect(() => parseFileConfig("foo: bar", "my-config.yaml")).toThrow(/Invalid config file at "my-config\.yaml"/);
    });

    it("warns on unknown top-level keys", () => {
        const { logger, warnMock } = makeLogger();
        const yaml = `
agent:
  nodes:
    triage:
      model: "gemini-flash-lite"
      timeoutMs: 60000
      apiKeyType: "free"
    general:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    computation:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    search:
      model: "gemini-pro"
      timeoutMs: 120000
      apiKeyType: "paid"
typoKey: oops
`;
        parseFileConfig(yaml, "test.yaml", logger);
        expect(warnMock).toHaveBeenCalledTimes(1);
        expect(warnMock).toHaveBeenCalledWith(
            expect.objectContaining({ key: "typoKey" }),
            expect.stringContaining("typoKey"),
        );
    });

    it("warns on unknown nested keys", () => {
        const { logger, warnMock } = makeLogger();
        const yaml = `
agent:
  nodes:
    triage:
      model: "gemini-flash-lite"
      timeoutMs: 60000
      apiKeyType: "free"
      misspelledFallback: "gemini-flash"
    general:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    computation:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    search:
      model: "gemini-pro"
      timeoutMs: 120000
      apiKeyType: "paid"
`;
        parseFileConfig(yaml, "test.yaml", logger);
        expect(warnMock).toHaveBeenCalledTimes(1);
        expect(warnMock).toHaveBeenCalledWith(
            expect.objectContaining({ key: "agent.nodes.triage.misspelledFallback" }),
            expect.stringContaining("agent.nodes.triage.misspelledFallback"),
        );
    });

    it("does not warn when no logger is provided", () => {
        const yaml = `
agent:
  nodes:
    triage:
      model: "gemini-flash-lite"
      timeoutMs: 60000
      apiKeyType: "free"
    general:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    computation:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    search:
      model: "gemini-pro"
      timeoutMs: 120000
      apiKeyType: "paid"
unknownKey: oops
`;
        // Should not throw even with unknown keys when no logger passed
        expect(() => parseFileConfig(yaml)).not.toThrow();
    });

    it("normalizes thinkingLevel to uppercase", () => {
        const yaml = `
agent:
  nodes:
    triage:
      model: "gemini-flash-lite"
      timeoutMs: 60000
      apiKeyType: "free"
      thinkingLevel: "low"
    general:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    computation:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    search:
      model: "gemini-pro"
      timeoutMs: 120000
      apiKeyType: "paid"
`;
        const config = parseFileConfig(yaml);
        expect(config.agent.nodes.triage.thinkingLevel).toBe("LOW");
    });

    it("normalizes uploadAttachmentMode to lowercase", () => {
        const yaml = `
agent:
  uploadAttachmentMode: "UPLOAD"
  nodes:
    triage:
      model: "gemini-flash-lite"
      timeoutMs: 60000
      apiKeyType: "free"
    general:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    computation:
      model: "gemini-flash"
      timeoutMs: 120000
      apiKeyType: "free"
    search:
      model: "gemini-pro"
      timeoutMs: 120000
      apiKeyType: "paid"
`;
        const config = parseFileConfig(yaml);
        expect(config.agent.uploadAttachmentMode).toBe("upload");
    });

    it("does not warn for valid keys", () => {
        const { logger, warnMock } = makeLogger();
        parseFileConfig(VALID_YAML, "test.yaml", logger);
        expect(warnMock).not.toHaveBeenCalled();
    });
});
