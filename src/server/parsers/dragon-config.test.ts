/**
 * Dragon config parser tests
 */
import { describe, it, expect } from "vitest";
import {
  parseDragonRegistry,
  parseAvailableModels,
  getDefaultInstructions,
  isValidDragonId,
  validateDragonConfig,
  validateAllDragons,
  getDragonConfig,
  getModelName,
  getMachineName,
  combineInstructions,
} from "./dragon-config.js";
import type { ProjectConfig, DragonConfig } from "../../shared/types.js";

// Minimal valid project config
const minimalConfig: ProjectConfig = {
  name: "Test",
  repo: "/tmp/repo",
  github: "test/repo",
  queue_file: "/tmp/queue.md",
  agents_dir: "/tmp/agents",
  gates_dir: "/tmp/gates",
  machines: {
    mac: { name: "Mac Studio", type: "local", runners: ["heavy"] },
    "build-server": {
      name: "Build Server",
      type: "ssh",
      host: "198.51.100.10",
      user: "deploy",
      key: "~/.ssh/example_key",
      runners: ["remote"],
    },
  },
};

describe("parseDragonRegistry", () => {
  it("returns empty map when no dragons configured", () => {
    const result = parseDragonRegistry(minimalConfig);
    expect(result.size).toBe(0);
  });

  it("parses dragon config with all fields", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      dragons: {
        "kiro-A": {
          name: "Smaug",
          model: "claude-opus-4.5",
          machine: "mac",
          instructions: "Focus on backend work.",
        },
      },
    };

    const result = parseDragonRegistry(config);

    expect(result.size).toBe(1);
    const dragon = result.get("kiro-A");
    expect(dragon).toBeDefined();
    expect(dragon!.id).toBe("kiro-A");
    expect(dragon!.name).toBe("Smaug");
    expect(dragon!.model).toBe("claude-opus-4.5");
    expect(dragon!.machine).toBe("mac");
    expect(dragon!.instructions).toBe("Focus on backend work.");
  });

  it("applies defaults for missing fields", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      dragons: {
        "kiro-B": {
          name: "Saphira",
          model: "", // empty
          machine: "", // empty
          instructions: "",
        },
      },
    };

    const result = parseDragonRegistry(config);
    const dragon = result.get("kiro-B");

    expect(dragon!.model).toBe("claude-sonnet-4"); // default
    expect(dragon!.machine).toBe("local"); // default
    expect(dragon!.instructions).toBe("");
  });

  it("uses ID as name when name not provided", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      dragons: {
        "kiro-C": {
          name: "",
          model: "claude-haiku",
          machine: "mac",
          instructions: "",
        },
      },
    };

    const result = parseDragonRegistry(config);
    const dragon = result.get("kiro-C");

    expect(dragon!.name).toBe("kiro-C");
  });

  it("parses multiple dragons", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      dragons: {
        "kiro-A": { name: "Smaug", model: "claude-opus-4.5", machine: "mac", instructions: "" },
        "kiro-B": { name: "Saphira", model: "claude-sonnet-4", machine: "mac", instructions: "" },
        "kiro-C": { name: "Drogon", model: "claude-haiku", machine: "build-server", instructions: "" },
      },
    };

    const result = parseDragonRegistry(config);

    expect(result.size).toBe(3);
    expect(result.has("kiro-A")).toBe(true);
    expect(result.has("kiro-B")).toBe(true);
    expect(result.has("kiro-C")).toBe(true);
  });

  it("skips dragons with invalid IDs", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      dragons: {
        "kiro-A": { name: "Valid", model: "", machine: "", instructions: "" },
        "../escape": { name: "Invalid", model: "", machine: "", instructions: "" },
        "1-agent": { name: "Also Invalid", model: "", machine: "", instructions: "" },
        "has space": { name: "Spaces", model: "", machine: "", instructions: "" },
      },
    };

    const result = parseDragonRegistry(config);

    expect(result.size).toBe(1);
    expect(result.has("kiro-A")).toBe(true);
  });

  it("keeps dragons with non-kiro IDs", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      dragons: {
        "kiro-A": { name: "Smaug", model: "", machine: "", instructions: "" },
        "aider-1": { name: "Saphira", model: "", machine: "", instructions: "", adapter: "aider" },
        worker_b: { name: "Toothless", model: "", machine: "", instructions: "" },
      },
    };

    const result = parseDragonRegistry(config);

    expect([...result.keys()].sort()).toEqual(["aider-1", "kiro-A", "worker_b"]);
    expect(result.get("aider-1")!.adapter).toBe("aider");
  });
});

describe("parseAvailableModels", () => {
  it("returns defaults when no models configured", () => {
    const result = parseAvailableModels(minimalConfig);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].id).toBe("claude-opus-4.5");
  });

  it("returns configured models", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      available_models: [
        { id: "gpt-4", name: "GPT-4", description: "OpenAI GPT-4" },
        { id: "gpt-3.5", name: "GPT-3.5 Turbo" },
      ],
    };

    const result = parseAvailableModels(config);

    expect(result.length).toBe(2);
    expect(result[0].id).toBe("gpt-4");
    expect(result[0].name).toBe("GPT-4");
    expect(result[0].description).toBe("OpenAI GPT-4");
    expect(result[1].description).toBeUndefined();
  });

  it("uses ID as name when name not provided", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      available_models: [{ id: "custom-model", name: "" }],
    };

    const result = parseAvailableModels(config);

    expect(result[0].name).toBe("custom-model");
  });

  it("returns defaults for empty array", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      available_models: [],
    };

    const result = parseAvailableModels(config);

    expect(result.length).toBeGreaterThan(0);
  });
});

describe("getDefaultInstructions", () => {
  it("returns empty string when not configured", () => {
    const result = getDefaultInstructions(minimalConfig);
    expect(result).toBe("");
  });

  it("returns configured instructions", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      default_instructions: "Always run quick-check before committing.",
    };

    const result = getDefaultInstructions(config);

    expect(result).toBe("Always run quick-check before committing.");
  });
});

describe("isValidDragonId", () => {
  it("accepts kiro IDs (kiro-A through kiro-Z)", () => {
    expect(isValidDragonId("kiro-A")).toBe(true);
    expect(isValidDragonId("kiro-M")).toBe(true);
    expect(isValidDragonId("kiro-Z")).toBe(true);
  });

  it("accepts generic agent IDs", () => {
    expect(isValidDragonId("aider-1")).toBe(true);
    expect(isValidDragonId("worker_b")).toBe(true);
    expect(isValidDragonId("Claude")).toBe(true);
    expect(isValidDragonId("kiro-AB")).toBe(true);
    expect(isValidDragonId("x")).toBe(true);
    expect(isValidDragonId("a".repeat(64))).toBe(true);
  });

  it("rejects IDs that don't start with a letter", () => {
    expect(isValidDragonId("1-agent")).toBe(false);
    expect(isValidDragonId("-kiro")).toBe(false);
    expect(isValidDragonId("_kiro")).toBe(false);
  });

  it("rejects a trailing separator", () => {
    expect(isValidDragonId("kiro-")).toBe(false);
    expect(isValidDragonId("kiro_")).toBe(false);
  });

  it("rejects path and shell characters", () => {
    expect(isValidDragonId("../etc")).toBe(false);
    expect(isValidDragonId("kiro/A")).toBe(false);
    expect(isValidDragonId("kiro.A")).toBe(false);
    expect(isValidDragonId("kiro A")).toBe(false);
    expect(isValidDragonId("kiro;rm")).toBe(false);
  });

  it("rejects empty and over-long IDs", () => {
    expect(isValidDragonId("")).toBe(false);
    expect(isValidDragonId("a".repeat(65))).toBe(false);
  });
});

describe("validateDragonConfig", () => {
  it("returns no errors for valid config", () => {
    const dragon: DragonConfig = {
      id: "kiro-A",
      name: "Smaug",
      model: "claude-opus-4.5",
      machine: "mac",
      instructions: "",
    };

    const errors = validateDragonConfig(dragon, minimalConfig);

    expect(errors).toEqual([]);
  });

  it("reports error for unknown machine", () => {
    const dragon: DragonConfig = {
      id: "kiro-A",
      name: "Smaug",
      model: "claude-opus-4.5",
      machine: "nonexistent",
      instructions: "",
    };

    const errors = validateDragonConfig(dragon, minimalConfig);

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("machine 'nonexistent' not found");
  });

  it("reports error for unknown model", () => {
    const dragon: DragonConfig = {
      id: "kiro-A",
      name: "Smaug",
      model: "nonexistent-model",
      machine: "mac",
      instructions: "",
    };

    const errors = validateDragonConfig(dragon, minimalConfig);

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("model 'nonexistent-model' not in available_models");
  });

  it("reports multiple errors", () => {
    const dragon: DragonConfig = {
      id: "kiro-A",
      name: "Smaug",
      model: "bad-model",
      machine: "bad-machine",
      instructions: "",
    };

    const errors = validateDragonConfig(dragon, minimalConfig);

    expect(errors.length).toBe(2);
  });
});

describe("validateAllDragons", () => {
  it("returns no errors for valid config", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      dragons: {
        "kiro-A": { name: "Smaug", model: "claude-opus-4.5", machine: "mac", instructions: "" },
      },
    };

    const errors = validateAllDragons(config);

    expect(errors).toEqual([]);
  });

  it("collects errors from all dragons", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      dragons: {
        "kiro-A": { name: "Smaug", model: "bad-model", machine: "mac", instructions: "" },
        "kiro-B": { name: "Saphira", model: "claude-opus-4.5", machine: "bad-machine", instructions: "" },
      },
    };

    const errors = validateAllDragons(config);

    expect(errors.length).toBe(2);
  });
});

describe("getDragonConfig", () => {
  const config: ProjectConfig = {
    ...minimalConfig,
    dragons: {
      "kiro-A": { name: "Smaug", model: "claude-opus-4.5", machine: "mac", instructions: "Do backend." },
    },
  };

  it("returns dragon config by ID", () => {
    const dragon = getDragonConfig(config, "kiro-A");

    expect(dragon).toBeDefined();
    expect(dragon!.name).toBe("Smaug");
  });

  it("returns undefined for unknown ID", () => {
    const dragon = getDragonConfig(config, "kiro-Z");

    expect(dragon).toBeUndefined();
  });
});

describe("getModelName", () => {
  it("returns model name for known ID", () => {
    const name = getModelName(minimalConfig, "claude-opus-4.5");
    expect(name).toBe("Claude Opus 4.5");
  });

  it("returns ID for unknown model", () => {
    const name = getModelName(minimalConfig, "unknown-model");
    expect(name).toBe("unknown-model");
  });

  it("uses configured models", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      available_models: [{ id: "gpt-4", name: "GPT-4 Turbo" }],
    };

    const name = getModelName(config, "gpt-4");
    expect(name).toBe("GPT-4 Turbo");
  });
});

describe("getMachineName", () => {
  it("returns machine name for known ID", () => {
    const name = getMachineName(minimalConfig, "mac");
    expect(name).toBe("Mac Studio");
  });

  it("returns ID for unknown machine", () => {
    const name = getMachineName(minimalConfig, "unknown");
    expect(name).toBe("unknown");
  });
});

describe("combineInstructions", () => {
  it("combines all instruction levels", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      default_instructions: "Project rules.",
      dragons: {
        "kiro-A": {
          name: "Smaug",
          model: "claude-opus-4.5",
          machine: "mac",
          instructions: "Dragon rules.",
        },
      },
    };

    const result = combineInstructions(config, "kiro-A", "Task rules.");

    expect(result).toContain("Project rules.");
    expect(result).toContain("Dragon rules.");
    expect(result).toContain("Task rules.");
  });

  it("handles missing levels gracefully", () => {
    const result = combineInstructions(minimalConfig, "kiro-A", "Just task.");

    expect(result).toBe("Just task.");
  });

  it("handles dragon with no instructions", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      default_instructions: "Project.",
      dragons: {
        "kiro-A": { name: "Smaug", model: "", machine: "", instructions: "" },
      },
    };

    const result = combineInstructions(config, "kiro-A", "Task.");

    expect(result).toBe("Project.\n\nTask.");
  });

  it("handles unknown dragon", () => {
    const config: ProjectConfig = {
      ...minimalConfig,
      default_instructions: "Project.",
    };

    const result = combineInstructions(config, "kiro-Z", "Task.");

    expect(result).toBe("Project.\n\nTask.");
  });

  it("returns empty string when all levels empty", () => {
    const result = combineInstructions(minimalConfig, "kiro-A");

    expect(result).toBe("");
  });
});
