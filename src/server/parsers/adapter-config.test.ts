/**
 * Adapter Config Parser Tests
 */
import { describe, it, expect } from "vitest";
import {
  parseAdaptersConfig,
  parseTerminologyConfig,
  mergeAdaptersWithBuiltins,
  getAllAdapters,
  validateAllAdapters,
} from "./adapter-config.js";
import { BUILTIN_ADAPTERS, DEFAULT_TERMINOLOGY } from "../services/adapters.js";
import type { AgentAdapter } from "../../shared/types.js";

describe("parseAdaptersConfig", () => {
  it("should return empty for undefined config", () => {
    const { adapters, errors } = parseAdaptersConfig(undefined);
    expect(adapters).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("should parse valid adapter config", () => {
    const raw = {
      "my-agent": {
        name: "My Agent",
        start_cmd: "my-agent start {prompt_file}",
        stop_cmd: "my-agent stop {agent_id}",
        status_method: "file",
        queue_file: "status.md",
      },
    };
    const { adapters, errors } = parseAdaptersConfig(raw);
    expect(errors).toHaveLength(0);
    expect(adapters).toHaveLength(1);
    expect(adapters[0].id).toBe("my-agent");
    expect(adapters[0].name).toBe("My Agent");
  });

  it("should use key as id when id not specified", () => {
    const raw = {
      "test-adapter": {
        name: "Test",
        start_cmd: "test start",
        stop_cmd: "test stop",
        status_method: "file",
      },
    };
    const { adapters } = parseAdaptersConfig(raw);
    expect(adapters[0].id).toBe("test-adapter");
  });

  it("should use key as name when name not specified", () => {
    const raw = {
      "my-adapter": {
        start_cmd: "start",
        stop_cmd: "stop",
        status_method: "file",
      },
    };
    const { adapters } = parseAdaptersConfig(raw);
    expect(adapters[0].name).toBe("my-adapter");
  });

  it("should collect errors for invalid adapters", () => {
    const raw = {
      "bad-adapter": {
        name: "Bad",
        // missing start_cmd, stop_cmd
        status_method: "invalid",
      },
    };
    const { adapters, errors } = parseAdaptersConfig(raw);
    expect(adapters).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("bad-adapter"))).toBe(true);
  });

  it("should parse multiple adapters", () => {
    const raw = {
      adapter1: {
        name: "Adapter 1",
        start_cmd: "a1 start",
        stop_cmd: "a1 stop",
        status_method: "file",
      },
      adapter2: {
        name: "Adapter 2",
        start_cmd: "a2 start",
        stop_cmd: "a2 stop",
        status_method: "stdout",
        status_pattern: "^status:",
      },
    };
    const { adapters, errors } = parseAdaptersConfig(raw);
    expect(errors).toHaveLength(0);
    expect(adapters).toHaveLength(2);
  });
});

describe("parseTerminologyConfig", () => {
  it("should return defaults for undefined config", () => {
    const terminology = parseTerminologyConfig(undefined);
    expect(terminology).toEqual(DEFAULT_TERMINOLOGY);
  });

  it("should return defaults for empty object", () => {
    const terminology = parseTerminologyConfig({});
    expect(terminology).toEqual(DEFAULT_TERMINOLOGY);
  });

  it("should use custom terminology", () => {
    const terminology = parseTerminologyConfig({
      agent_singular: "bot",
      agent_plural: "bots",
      orchestrator: "coordinator",
    });
    expect(terminology.agent_singular).toBe("bot");
    expect(terminology.agent_plural).toBe("bots");
    expect(terminology.orchestrator).toBe("coordinator");
  });

  it("should merge partial config with defaults", () => {
    const terminology = parseTerminologyConfig({
      agent_singular: "worker",
    });
    expect(terminology.agent_singular).toBe("worker");
    expect(terminology.agent_plural).toBe(DEFAULT_TERMINOLOGY.agent_plural);
    expect(terminology.orchestrator).toBe(DEFAULT_TERMINOLOGY.orchestrator);
  });

  it("should ignore non-string values", () => {
    const terminology = parseTerminologyConfig({
      agent_singular: 123 as unknown as string,
      agent_plural: null as unknown as string,
    });
    expect(terminology.agent_singular).toBe(DEFAULT_TERMINOLOGY.agent_singular);
    expect(terminology.agent_plural).toBe(DEFAULT_TERMINOLOGY.agent_plural);
  });
});

describe("mergeAdaptersWithBuiltins", () => {
  it("should include all built-ins when no custom", () => {
    const merged = mergeAdaptersWithBuiltins([]);
    expect(merged.kiro).toBeDefined();
    expect(merged.aider).toBeDefined();
    expect(merged["claude-code"]).toBeDefined();
  });

  it("should add custom adapters", () => {
    const custom: AgentAdapter[] = [
      {
        id: "custom",
        name: "Custom",
        start_cmd: "custom start",
        stop_cmd: "custom stop",
        status_method: "file",
      },
    ];
    const merged = mergeAdaptersWithBuiltins(custom);
    expect(merged.custom).toBeDefined();
    expect(merged.kiro).toBeDefined();
  });

  it("should override built-in with custom of same id", () => {
    const custom: AgentAdapter[] = [
      {
        id: "kiro",
        name: "Modified Kiro",
        start_cmd: "modified start",
        stop_cmd: "modified stop",
        status_method: "file",
      },
    ];
    const merged = mergeAdaptersWithBuiltins(custom);
    expect(merged.kiro.name).toBe("Modified Kiro");
    expect(merged.kiro.start_cmd).toBe("modified start");
  });
});

describe("getAllAdapters", () => {
  it("should return all built-ins plus custom", () => {
    const custom: AgentAdapter[] = [
      {
        id: "new-adapter",
        name: "New",
        start_cmd: "new start",
        stop_cmd: "new stop",
        status_method: "file",
      },
    ];
    const all = getAllAdapters(custom);
    const ids = all.map((a) => a.id);
    expect(ids).toContain("kiro");
    expect(ids).toContain("aider");
    expect(ids).toContain("new-adapter");
  });
});

describe("validateAllAdapters", () => {
  it("should pass for valid adapters", () => {
    const adapters = Object.values(BUILTIN_ADAPTERS);
    const result = validateAllAdapters(adapters);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should collect errors from multiple adapters", () => {
    const adapters: AgentAdapter[] = [
      {
        id: "bad1",
        name: "Bad 1",
        start_cmd: "",
        stop_cmd: "stop",
        status_method: "file",
      },
      {
        id: "bad2",
        name: "Bad 2",
        start_cmd: "start",
        stop_cmd: "",
        status_method: "file",
      },
    ];
    const result = validateAllAdapters(adapters);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("bad1"))).toBe(true);
    expect(result.errors.some((e) => e.includes("bad2"))).toBe(true);
  });
});
