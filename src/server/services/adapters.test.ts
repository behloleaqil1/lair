/**
 * Agent Adapter Service Tests
 */
import { describe, it, expect } from "vitest";
import {
  BUILTIN_ADAPTERS,
  DEFAULT_TERMINOLOGY,
  containsShellMetacharacters,
  validateSubstitutionValue,
  substituteVariables,
  getAdapter,
  listAdapters,
  validateAdapter,
  buildStartCommand,
  buildStopCommand,
  parseTerminology,
  parseAdapters,
  mergeWithBuiltins,
  getDragonAdapter,
  validateDragonsAdapters,
  tokenizeTemplate,
} from "./adapters.js";
import type {
  AgentAdapter,
  ProjectConfig,
  DragonConfig,
} from "../../shared/types.js";

// ============ BUILTIN ADAPTERS ============

describe("BUILTIN_ADAPTERS", () => {
  it("should have kiro adapter", () => {
    expect(BUILTIN_ADAPTERS.kiro).toBeDefined();
    expect(BUILTIN_ADAPTERS.kiro.id).toBe("kiro");
    expect(BUILTIN_ADAPTERS.kiro.name).toBe("Kiro CLI");
    expect(BUILTIN_ADAPTERS.kiro.status_method).toBe("file");
  });

  it("should have aider adapter", () => {
    expect(BUILTIN_ADAPTERS.aider).toBeDefined();
    expect(BUILTIN_ADAPTERS.aider.id).toBe("aider");
    expect(BUILTIN_ADAPTERS.aider.status_method).toBe("file");
  });

  it("should have claude-code adapter", () => {
    expect(BUILTIN_ADAPTERS["claude-code"]).toBeDefined();
    expect(BUILTIN_ADAPTERS["claude-code"].status_method).toBe("stdout");
    expect(BUILTIN_ADAPTERS["claude-code"].status_pattern).toBeDefined();
  });

  it("should have cursor-agent adapter", () => {
    expect(BUILTIN_ADAPTERS["cursor-agent"]).toBeDefined();
    expect(BUILTIN_ADAPTERS["cursor-agent"].status_method).toBe("mcp");
  });

  it("uses the neutral work/ layout for kiro defaults", () => {
    expect(BUILTIN_ADAPTERS.kiro.queue_file).toBe("work/queue.md");
    expect(BUILTIN_ADAPTERS.kiro.log_dir).toBe("work/logs/");
  });

  it("labels the unverified adapters as experimental", () => {
    expect(BUILTIN_ADAPTERS["claude-code"].name).toContain("experimental");
    expect(BUILTIN_ADAPTERS["cursor-agent"].name).toContain("experimental");
  });

  it("every built-in adapter validates", () => {
    for (const adapter of Object.values(BUILTIN_ADAPTERS)) {
      expect(validateAdapter(adapter).errors).toEqual([]);
    }
  });
});

// ============ TEMPLATE TOKENIZING ============

describe("tokenizeTemplate", () => {
  it("splits on whitespace", () => {
    expect(tokenizeTemplate("  a  b\tc ")).toEqual(["a", "b", "c"]);
  });

  it("keeps quoted text together", () => {
    expect(tokenizeTemplate(`run "two words" 'it''s' "say \\"hi\\""`)).toEqual([
      "run",
      "two words",
      "its",
      'say "hi"',
    ]);
  });

  it("keeps an empty quoted argument", () => {
    expect(tokenizeTemplate(`cmd ""`)).toEqual(["cmd", ""]);
  });

  it("rejects unbalanced quotes", () => {
    expect(() => tokenizeTemplate(`cmd "oops`)).toThrow("Unterminated");
  });
});

// ============ SHELL METACHARACTER DETECTION ============

describe("containsShellMetacharacters", () => {
  it("should return false for safe strings", () => {
    expect(containsShellMetacharacters("hello")).toBe(false);
    expect(containsShellMetacharacters("task-name")).toBe(false);
    expect(containsShellMetacharacters("kiro-A")).toBe(false);
    expect(containsShellMetacharacters("/path/to/file.txt")).toBe(false);
    expect(containsShellMetacharacters("claude-opus-4.5")).toBe(false);
  });

  it("should return true for dangerous characters", () => {
    expect(containsShellMetacharacters("hello; rm -rf")).toBe(true);
    expect(containsShellMetacharacters("$(whoami)")).toBe(true);
    expect(containsShellMetacharacters("`id`")).toBe(true);
    expect(containsShellMetacharacters("hello | cat")).toBe(true);
    expect(containsShellMetacharacters("foo && bar")).toBe(true);
    expect(containsShellMetacharacters("test\ncommand")).toBe(true);
    expect(containsShellMetacharacters("'quoted'")).toBe(true);
    expect(containsShellMetacharacters('"quoted"')).toBe(true);
    expect(containsShellMetacharacters("hello*")).toBe(true);
    expect(containsShellMetacharacters("hello?")).toBe(true);
    expect(containsShellMetacharacters("${VAR}")).toBe(true);
  });
});

describe("validateSubstitutionValue", () => {
  it("should return null for safe values", () => {
    expect(validateSubstitutionValue("task", "my-task")).toBeNull();
    expect(validateSubstitutionValue("model", "claude-opus-4.5")).toBeNull();
  });

  it("should return error message for unsafe values", () => {
    const result = validateSubstitutionValue("task", "task; rm -rf /");
    expect(result).toContain("shell metacharacters");
    expect(result).toContain("task");
  });
});

// ============ VARIABLE SUBSTITUTION ============

describe("substituteVariables", () => {
  it("should substitute all provided variables", () => {
    const template = "cmd --agent {agent_id} --task {task}";
    const { result, warnings } = substituteVariables(template, {
      agent_id: "kiro-A",
      task: "my-task",
    });
    expect(result).toBe("cmd --agent kiro-A --task my-task");
    expect(warnings).toHaveLength(0);
  });

  it("should substitute the same variable multiple times", () => {
    const template = "{task} and {task}";
    const { result } = substituteVariables(template, { task: "foo" });
    expect(result).toBe("foo and foo");
  });

  it("should warn about unsubstituted variables", () => {
    const template = "cmd --model {model}";
    const { result, warnings } = substituteVariables(template, {});
    expect(result).toBe("cmd --model {model}");
    expect(warnings).toContain("Unsubstituted variable: {model}");
  });

  it("should reject values with shell metacharacters", () => {
    const template = "cmd {task}";
    const { result, warnings } = substituteVariables(template, {
      task: "bad; rm -rf /",
    });
    // Should not substitute
    expect(result).toBe("cmd {task}");
    expect(warnings.some((w) => w.includes("shell metacharacters"))).toBe(true);
  });

  it("should handle empty vars", () => {
    const template = "simple command";
    const { result, warnings } = substituteVariables(template, {});
    expect(result).toBe("simple command");
    expect(warnings).toHaveLength(0);
  });
});

// ============ GET ADAPTER ============

describe("getAdapter", () => {
  it("should return built-in adapter", () => {
    const adapter = getAdapter("kiro");
    expect(adapter).toBeDefined();
    expect(adapter?.id).toBe("kiro");
  });

  it("should return undefined for unknown adapter", () => {
    const adapter = getAdapter("unknown-adapter");
    expect(adapter).toBeUndefined();
  });

  it("should prefer custom adapter over built-in", () => {
    const customAdapter: AgentAdapter = {
      id: "kiro",
      name: "Custom Kiro",
      start_cmd: "custom-kiro {prompt_file}",
      stop_cmd: "custom-stop",
      status_method: "file",
    };
    const projectConfig = {
      agent_adapters: { kiro: customAdapter },
    } as unknown as ProjectConfig;

    const adapter = getAdapter("kiro", projectConfig);
    expect(adapter?.name).toBe("Custom Kiro");
  });

  it("should return custom adapter not in built-ins", () => {
    const customAdapter: AgentAdapter = {
      id: "my-agent",
      name: "My Agent",
      start_cmd: "my-agent start",
      stop_cmd: "my-agent stop",
      status_method: "file",
    };
    const projectConfig = {
      agent_adapters: { "my-agent": customAdapter },
    } as unknown as ProjectConfig;

    const adapter = getAdapter("my-agent", projectConfig);
    expect(adapter?.name).toBe("My Agent");
  });
});

// ============ LIST ADAPTERS ============

describe("listAdapters", () => {
  it("should list all built-in adapters when no config", () => {
    const adapters = listAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(4);
    expect(adapters.find((a) => a.id === "kiro")).toBeDefined();
    expect(adapters.find((a) => a.id === "aider")).toBeDefined();
  });

  it("should include custom adapters", () => {
    const customAdapter: AgentAdapter = {
      id: "custom",
      name: "Custom",
      start_cmd: "custom start",
      stop_cmd: "custom stop",
      status_method: "file",
    };
    const projectConfig = {
      agent_adapters: { custom: customAdapter },
    } as unknown as ProjectConfig;

    const adapters = listAdapters(projectConfig);
    expect(adapters.find((a) => a.id === "custom")).toBeDefined();
  });
});

// ============ VALIDATE ADAPTER ============

describe("validateAdapter", () => {
  it("should validate a correct adapter", () => {
    const adapter: AgentAdapter = {
      id: "test",
      name: "Test",
      start_cmd: "test start",
      stop_cmd: "test stop",
      status_method: "file",
      queue_file: "status.md",
    };
    const result = validateAdapter(adapter);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject missing id", () => {
    const adapter = {
      name: "Test",
      start_cmd: "test start",
      stop_cmd: "test stop",
      status_method: "file",
    } as unknown as AgentAdapter;
    const result = validateAdapter(adapter);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("should reject missing start_cmd", () => {
    const adapter = {
      id: "test",
      name: "Test",
      stop_cmd: "test stop",
      status_method: "file",
    } as unknown as AgentAdapter;
    const result = validateAdapter(adapter);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("start_cmd"))).toBe(true);
  });

  it("should reject invalid status_method", () => {
    const adapter = {
      id: "test",
      name: "Test",
      start_cmd: "test start",
      stop_cmd: "test stop",
      status_method: "invalid" as "file",
    };
    const result = validateAdapter(adapter);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("status_method"))).toBe(true);
  });

  it("should warn about file adapter without queue_file", () => {
    const adapter: AgentAdapter = {
      id: "test",
      name: "Test",
      start_cmd: "test start",
      stop_cmd: "test stop",
      status_method: "file",
    };
    const result = validateAdapter(adapter);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("queue_file"))).toBe(true);
  });

  it("should warn about stdout adapter without status_pattern", () => {
    const adapter: AgentAdapter = {
      id: "test",
      name: "Test",
      start_cmd: "test start",
      stop_cmd: "test stop",
      status_method: "stdout",
    };
    const result = validateAdapter(adapter);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("status_pattern"))).toBe(true);
  });

  it("should reject invalid status_pattern regex", () => {
    const adapter: AgentAdapter = {
      id: "test",
      name: "Test",
      start_cmd: "test start",
      stop_cmd: "test stop",
      status_method: "stdout",
      status_pattern: "[invalid(regex",
    };
    const result = validateAdapter(adapter);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("regex"))).toBe(true);
  });

  it("should warn about mcp adapter without mcp_endpoint", () => {
    const adapter: AgentAdapter = {
      id: "test",
      name: "Test",
      start_cmd: "test start",
      stop_cmd: "test stop",
      status_method: "mcp",
    };
    const result = validateAdapter(adapter);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("mcp_endpoint"))).toBe(true);
  });
});

// ============ BUILD START COMMAND ============

describe("buildStartCommand", () => {
  it("should build kiro start command", () => {
    const adapter = BUILTIN_ADAPTERS.kiro;
    const { command, warnings } = buildStartCommand(adapter, {
      agentId: "kiro-A",
      task: "my-task",
      promptFile: "/path/to/prompt.txt",
      model: "claude-opus-4.5",
      agentProfile: "dragon",
    });

    expect(command).toContain("kiro-cli");
    expect(command).toContain("chat");
    expect(command).toContain("--model");
    expect(command).toContain("claude-opus-4.5");
    expect(command).toContain("/path/to/prompt.txt");
    expect(warnings).toHaveLength(0);
  });

  it("should build aider start command", () => {
    const adapter = BUILTIN_ADAPTERS.aider;
    const { command } = buildStartCommand(adapter, {
      agentId: "worker-1",
      task: "fix-bug",
      promptFile: "/tmp/prompt.md",
    });

    expect(command).toContain("aider");
    expect(command).toContain("--yes");
    expect(command).toContain("/tmp/prompt.md");
  });

  it("should build claude-code start command with real CLI flags", () => {
    const adapter = BUILTIN_ADAPTERS["claude-code"];
    const { command, warnings } = buildStartCommand(adapter, {
      agentId: "builder-1",
      task: "write-tests",
      promptFile: "/tmp/task.txt",
      model: "sonnet",
    });

    expect(command.slice(0, 6)).toEqual([
      "claude",
      "-p",
      "--model",
      "sonnet",
      "--append-system-prompt-file",
      "/tmp/task.txt",
    ]);
    // The quoted query is a single argument
    expect(command).toHaveLength(7);
    expect(warnings).toHaveLength(0);
  });

  it("should build cursor-agent start command with real CLI flags", () => {
    const adapter = BUILTIN_ADAPTERS["cursor-agent"];
    const { command, warnings } = buildStartCommand(adapter, {
      agentId: "cursor-1",
      task: "refactor",
      promptFile: "/tmp/task.txt",
      model: "auto",
    });

    expect(command.slice(0, 4)).toEqual(["agent", "-p", "--model", "auto"]);
    expect(command).toHaveLength(5);
    expect(command[4]).toContain("/tmp/task.txt");
    expect(warnings).toHaveLength(0);
  });

  it("keeps a prompt path with spaces as one argument", () => {
    const { command, warnings } = buildStartCommand(BUILTIN_ADAPTERS.aider, {
      agentId: "worker-1",
      task: "fix-bug",
      promptFile: "/home/me/My Prompts/task one.md",
    });

    expect(warnings).toHaveLength(0);
    expect(command).toEqual([
      "aider",
      "--yes",
      "--message-file",
      "/home/me/My Prompts/task one.md",
    ]);
  });

  it("should add resume flag when session_id provided", () => {
    const adapter = BUILTIN_ADAPTERS.kiro;
    const { command } = buildStartCommand(adapter, {
      agentId: "kiro-A",
      task: "continue",
      promptFile: "/path/prompt.txt",
      sessionId: "sess_abc123",
      agentProfile: "dragon",
      model: "claude-sonnet-4",
    });

    expect(command).toContain("--resume-id");
    expect(command).toContain("sess_abc123");
  });

  it("should warn about unsubstituted variables", () => {
    const adapter: AgentAdapter = {
      id: "test",
      name: "Test",
      start_cmd: "test --foo {unknown_var}",
      stop_cmd: "stop",
      status_method: "file",
    };
    const { warnings } = buildStartCommand(adapter, {
      agentId: "test-1",
      task: "task",
      promptFile: "/tmp/prompt.txt",
    });

    expect(warnings.some((w) => w.includes("unknown_var"))).toBe(true);
  });
});

// ============ BUILD STOP COMMAND ============

describe("buildStopCommand", () => {
  it("should build kiro stop command", () => {
    const adapter = BUILTIN_ADAPTERS.kiro;
    const { command } = buildStopCommand(adapter, {
      agentId: "kiro-A",
      sessionDir: "/path/to/session",
    });

    expect(command).toContain("touch");
    expect(command.some((c) => c.includes("STOP"))).toBe(true);
  });

  it("should build aider stop command with PID", () => {
    const adapter = BUILTIN_ADAPTERS.aider;
    const { command } = buildStopCommand(adapter, {
      agentId: "worker-1",
      pid: 12345,
    });

    expect(command).toContain("kill");
    expect(command).toContain("-INT");
    expect(command).toContain("12345");
  });

  it("should build claude-code stop command with PID", () => {
    const adapter = BUILTIN_ADAPTERS["claude-code"];
    const { command } = buildStopCommand(adapter, {
      agentId: "builder-1",
      pid: 54321,
    });

    expect(command).toContain("kill");
    expect(command).toContain("-TERM");
    expect(command).toContain("54321");
  });

  it("should build cursor-agent stop command (the CLI has no stop subcommand)", () => {
    const adapter = BUILTIN_ADAPTERS["cursor-agent"];
    const { command } = buildStopCommand(adapter, {
      agentId: "cursor-1",
      pid: 4242,
    });

    expect(command).toEqual(["kill", "-TERM", "4242"]);
  });

  it("keeps a session dir with spaces as one argument", () => {
    const { command } = buildStopCommand(BUILTIN_ADAPTERS.kiro, {
      agentId: "kiro-A",
      sessionDir: "/tmp/my sessions/a",
    });

    expect(command).toEqual(["touch", "/tmp/my sessions/a/STOP"]);
  });

  it("should warn when PID required but not provided", () => {
    const adapter = BUILTIN_ADAPTERS.aider;
    const { warnings } = buildStopCommand(adapter, {
      agentId: "worker-1",
      // no pid
    });

    expect(warnings.some((w) => w.includes("pid"))).toBe(true);
  });
});

// ============ PARSE TERMINOLOGY ============

describe("parseTerminology", () => {
  it("should return defaults when no config", () => {
    const terminology = parseTerminology();
    expect(terminology).toEqual(DEFAULT_TERMINOLOGY);
  });

  it("should return defaults when no terminology in config", () => {
    const config = {} as ProjectConfig;
    const terminology = parseTerminology(config);
    expect(terminology).toEqual(DEFAULT_TERMINOLOGY);
  });

  it("should use custom terminology", () => {
    const config = {
      terminology: {
        agent_singular: "worker",
        agent_plural: "workers",
        orchestrator: "coordinator",
      },
    } as unknown as ProjectConfig;
    const terminology = parseTerminology(config);
    expect(terminology.agent_singular).toBe("worker");
    expect(terminology.agent_plural).toBe("workers");
    expect(terminology.orchestrator).toBe("coordinator");
  });

  it("should merge partial custom terminology with defaults", () => {
    const config = {
      terminology: {
        agent_singular: "bot",
      },
    } as unknown as ProjectConfig;
    const terminology = parseTerminology(config);
    expect(terminology.agent_singular).toBe("bot");
    expect(terminology.agent_plural).toBe("dragons"); // default
    expect(terminology.orchestrator).toBe("orchestrator"); // default
  });
});

// ============ PARSE ADAPTERS ============

describe("parseAdapters", () => {
  it("should return all built-in adapters by default", () => {
    const adapters = parseAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(4);
  });

  it("should merge custom adapters", () => {
    const config = {
      agent_adapters: {
        custom: {
          id: "custom",
          name: "Custom",
          start_cmd: "custom start",
          stop_cmd: "custom stop",
          status_method: "file" as const,
        },
      },
    } as unknown as ProjectConfig;
    const adapters = parseAdapters(config);
    expect(adapters.find((a) => a.id === "custom")).toBeDefined();
    expect(adapters.find((a) => a.id === "kiro")).toBeDefined();
  });
});

// ============ MERGE WITH BUILTINS ============

describe("mergeWithBuiltins", () => {
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
    const merged = mergeWithBuiltins(custom);
    expect(merged.custom).toBeDefined();
    expect(merged.kiro).toBeDefined();
  });

  it("should override built-in with same id", () => {
    const custom: AgentAdapter[] = [
      {
        id: "kiro",
        name: "Modified Kiro",
        start_cmd: "modified-kiro",
        stop_cmd: "stop",
        status_method: "file",
      },
    ];
    const merged = mergeWithBuiltins(custom);
    expect(merged.kiro.name).toBe("Modified Kiro");
  });
});

// ============ GET DRAGON ADAPTER ============

describe("getDragonAdapter", () => {
  it("should return kiro adapter by default", () => {
    const dragon: DragonConfig = {
      id: "kiro-A",
      name: "Smaug",
      model: "claude-opus-4.5",
      machine: "local",
      instructions: "",
    };
    const adapter = getDragonAdapter(dragon);
    expect(adapter?.id).toBe("kiro");
  });

  it("should return specified adapter", () => {
    const dragon: DragonConfig = {
      id: "worker-1",
      name: "Builder",
      model: "gpt-4",
      machine: "local",
      instructions: "",
      adapter: "aider",
    };
    const adapter = getDragonAdapter(dragon);
    expect(adapter?.id).toBe("aider");
  });

  it("should return custom adapter from config", () => {
    const dragon: DragonConfig = {
      id: "agent-1",
      name: "Agent",
      model: "custom-model",
      machine: "local",
      instructions: "",
      adapter: "my-agent",
    };
    const config = {
      agent_adapters: {
        "my-agent": {
          id: "my-agent",
          name: "My Agent",
          start_cmd: "my-agent start",
          stop_cmd: "my-agent stop",
          status_method: "file" as const,
        },
      },
    } as unknown as ProjectConfig;
    const adapter = getDragonAdapter(dragon, config);
    expect(adapter?.id).toBe("my-agent");
  });
});

// ============ VALIDATE DRAGONS ADAPTERS ============

describe("validateDragonsAdapters", () => {
  it("should pass when all dragons use valid adapters", () => {
    const config = {
      dragons: {
        "kiro-A": { name: "Smaug", model: "claude", machine: "local", instructions: "" },
        "kiro-B": { name: "Saphira", model: "claude", machine: "local", instructions: "", adapter: "aider" },
      },
    } as unknown as ProjectConfig;
    const errors = validateDragonsAdapters(config);
    expect(errors).toHaveLength(0);
  });

  it("should error when dragon uses unknown adapter", () => {
    const config = {
      dragons: {
        "kiro-A": {
          name: "Test",
          model: "claude",
          machine: "local",
          instructions: "",
          adapter: "nonexistent",
        },
      },
    } as unknown as ProjectConfig;
    const errors = validateDragonsAdapters(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("nonexistent");
  });

  it("should return empty errors for empty dragons", () => {
    const config = { dragons: {} } as unknown as ProjectConfig;
    const errors = validateDragonsAdapters(config);
    expect(errors).toHaveLength(0);
  });
});
