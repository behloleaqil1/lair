/**
 * Dragon command building tests
 *
 * Tests the dragon start/stop command building logic
 * (actual execution is mocked)
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildCommand, CommandService } from "./command.js";
import type { ProjectConfig } from "../../shared/types.js";

// Mock config for testing
function createMockConfig(
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
  return {
    name: "test-project",
    repo: "/tmp/test-repo",
    github: "test/test-repo",
    queue_file: "/tmp/queue.md",
    agents_dir: "/tmp/agents",
    gates_dir: "/tmp/gates",
    machines: {
      local: {
        name: "Local",
        type: "local",
        runners: ["heavy"],
      },
    },
    read_only: false,
    ...overrides,
  };
}

describe("buildCommand", () => {
  it("substitutes single placeholder", () => {
    const template = ["script.sh", "{dragon}", "extra"];
    const result = buildCommand(template, { dragon: "kiro-A" });
    expect(result).toEqual(["script.sh", "kiro-A", "extra"]);
  });

  it("substitutes multiple placeholders", () => {
    const template = ["dragon-start.sh", "{dragon}", "{task}", "{prompt_file}"];
    const result = buildCommand(template, {
      dragon: "kiro-B",
      task: "fix-bug-123",
      prompt_file: "/tmp/prompts/fix-bug-123.txt",
    });
    expect(result).toEqual([
      "dragon-start.sh",
      "kiro-B",
      "fix-bug-123",
      "/tmp/prompts/fix-bug-123.txt",
    ]);
  });

  it("preserves arguments without placeholders", () => {
    const template = ["ssh", "-i", "key.pem", "user@host", "{command}"];
    const result = buildCommand(template, { command: "ls -la" });
    expect(result).toEqual(["ssh", "-i", "key.pem", "user@host", "ls -la"]);
  });

  it("handles multiple occurrences of same placeholder", () => {
    const template = ["echo", "{name}", "to", "{name}"];
    const result = buildCommand(template, { name: "dragon" });
    expect(result).toEqual(["echo", "dragon", "to", "dragon"]);
  });

  it("leaves unmatched placeholders unchanged", () => {
    const template = ["cmd", "{known}", "{unknown}"];
    const result = buildCommand(template, { known: "value" });
    expect(result).toEqual(["cmd", "value", "{unknown}"]);
  });

  it("handles empty vars object", () => {
    const template = ["cmd", "arg1", "arg2"];
    const result = buildCommand(template, {});
    expect(result).toEqual(["cmd", "arg1", "arg2"]);
  });

  it("handles special characters in values", () => {
    const template = ["script.sh", "{task}"];
    const result = buildCommand(template, { task: "fix-bug; rm -rf /" });
    // Value is substituted as-is - security is handled by spawn (no shell)
    expect(result).toEqual(["script.sh", "fix-bug; rm -rf /"]);
  });

  it("handles spaces in values", () => {
    const template = ["script.sh", "{prompt_file}"];
    const result = buildCommand(template, {
      prompt_file: "/path/with spaces/file.txt",
    });
    expect(result).toEqual(["script.sh", "/path/with spaces/file.txt"]);
  });
});

describe("CommandService dragon methods", () => {
  describe("getDragonManagementConfig", () => {
    it("returns dragon config when available", () => {
      const config = createMockConfig({
        dragons: {
          "kiro-A": {
            id: "kiro-A",
            name: "Smaug",
            model: "claude-opus-4.5",
            machine: "mac",
            instructions: "Focus on backend",
          },
        },
        available_models: [
          { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
          { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
        ],
        default_instructions: "Always run quick-check",
        dragon_start_cmd: [
          "work/bin/dragon-start.sh",
          "{dragon}",
          "{task}",
          "{prompt_file}",
        ],
        dragon_stop_cmd: ["work/bin/dragon-stop.sh", "{dragon}"],
      } as any);

      const service = new CommandService(config);
      const mgmtConfig = service.getDragonManagementConfig();

      expect(mgmtConfig.dragons).toBeDefined();
      expect(mgmtConfig.dragons!["kiro-A"]).toBeDefined();
      expect(mgmtConfig.dragons!["kiro-A"].name).toBe("Smaug");
      expect(mgmtConfig.available_models).toHaveLength(2);
      expect(mgmtConfig.default_instructions).toBe("Always run quick-check");
      expect(mgmtConfig.dragon_start_cmd).toBeDefined();
      expect(mgmtConfig.dragon_stop_cmd).toBeDefined();
    });

    it("returns undefined when dragons not configured", () => {
      const agentsDir = mkdtempSync(join(tmpdir(), "lair-mgmt-"));
      try {
        const config = createMockConfig({ agents_dir: agentsDir });
        const service = new CommandService(config);
        const mgmtConfig = service.getDragonManagementConfig();

        expect(mgmtConfig.dragons).toEqual({});
        expect(mgmtConfig.available_models).toBeUndefined();
      } finally {
        rmSync(agentsDir, { recursive: true, force: true });
      }
    });

    it("includes dragons listed only in dragons.txt, next to the YAML ones", () => {
      const agentsDir = mkdtempSync(join(tmpdir(), "lair-mgmt-"));
      try {
        writeFileSync(join(agentsDir, "dragons.txt"), "kiro-B\tFafnir\tfix-auth\n1-bad\tBad\tt\n");
        const config = createMockConfig({
          agents_dir: agentsDir,
          dragons: {
            "kiro-A": { name: "Smaug", model: "claude-opus-4.5", machine: "mac", instructions: "" },
          },
        });
        const service = new CommandService(config);
        const { dragons } = service.getDragonManagementConfig();

        expect(Object.keys(dragons!).sort()).toEqual(["kiro-A", "kiro-B"]);
        expect(dragons!["kiro-A"]).toMatchObject({ name: "Smaug", model: "claude-opus-4.5", machine: "mac" });
        expect(dragons!["kiro-B"]).toEqual({
          id: "kiro-B",
          name: "Fafnir",
          model: "",
          machine: "",
          instructions: "",
        });
      } finally {
        rmSync(agentsDir, { recursive: true, force: true });
      }
    });
  });

  describe("dragonStart", () => {
    it("returns error when read_only is true", async () => {
      const config = createMockConfig({
        read_only: true,
        dragon_start_cmd: ["script.sh", "{dragon}"],
      } as any);

      const service = new CommandService(config);
      const result = await service.dragonStart(
        "kiro-A",
        "task-1",
        "/tmp/prompt.txt",
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("read-only");
    });

    it("returns error when dragon_start_cmd not configured", async () => {
      const config = createMockConfig({ read_only: false });
      const service = new CommandService(config);
      const result = await service.dragonStart(
        "kiro-A",
        "task-1",
        "/tmp/prompt.txt",
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("dragon_start_cmd not configured");
    });
  });

  describe("dragonStop", () => {
    it("returns error when read_only is true", async () => {
      const config = createMockConfig({
        read_only: true,
        dragon_stop_cmd: ["script.sh", "{dragon}"],
      } as any);

      const service = new CommandService(config);
      const result = await service.dragonStop("kiro-A");

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("read-only");
    });

    it("returns error when dragon_stop_cmd not configured", async () => {
      const config = createMockConfig({ read_only: false });
      const service = new CommandService(config);
      const result = await service.dragonStop("kiro-A");

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("dragon_stop_cmd not configured");
    });
  });
});

describe("dragon command template building", () => {
  it("builds start command with all placeholders", () => {
    const template = [
      "work/bin/dragon-start.sh",
      "{dragon}",
      "{task}",
      "{prompt_file}",
    ];
    const vars = {
      dragon: "kiro-C",
      task: "implement-feature-xyz",
      prompt_file: "/tmp/prompts/implement-feature-xyz-kiro-C.txt",
    };

    const cmd = buildCommand(template, vars);

    expect(cmd).toEqual([
      "work/bin/dragon-start.sh",
      "kiro-C",
      "implement-feature-xyz",
      "/tmp/prompts/implement-feature-xyz-kiro-C.txt",
    ]);
  });

  it("builds stop command", () => {
    const template = ["work/bin/dragon-stop.sh", "{dragon}"];
    const vars = { dragon: "kiro-D" };

    const cmd = buildCommand(template, vars);

    expect(cmd).toEqual(["work/bin/dragon-stop.sh", "kiro-D"]);
  });

  it("handles dragon ID with special format", () => {
    const template = ["script.sh", "{dragon}"];
    // Dragon IDs are like kiro-A through kiro-Z
    const cmd = buildCommand(template, { dragon: "kiro-Z" });
    expect(cmd).toEqual(["script.sh", "kiro-Z"]);
  });

  it("handles task with branch-style name", () => {
    const template = ["script.sh", "{task}"];
    const cmd = buildCommand(template, { task: "feature/auth-improvements" });
    expect(cmd).toEqual(["script.sh", "feature/auth-improvements"]);
  });

  it("handles task with PR number", () => {
    const template = ["script.sh", "{task}"];
    const cmd = buildCommand(template, { task: "#183-fix-search" });
    expect(cmd).toEqual(["script.sh", "#183-fix-search"]);
  });
});
