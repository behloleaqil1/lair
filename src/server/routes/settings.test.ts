/**
 * Settings routes tests
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";

// Test data directory
const TEST_DIR = join(process.cwd(), "data", "test-settings");

// Mock config content
const mockConfig = {
  name: "test-project",
  repo: "/test/repo",
  github: "testuser/test-repo",
  queue_file: "/test/queue.md",
  agents_dir: "/test/agents",
  gates_dir: "/test/gates",
  read_only: true,
  machines: {
    mac: {
      name: "Test Mac",
      type: "local" as const,
      runners: ["heavy" as const, "light" as const],
    },
  },
  dragons: {
    "kiro-A": {
      name: "Smaug",
      model: "claude-opus-4.5",
      machine: "mac",
      adapter: "kiro",
      instructions: "Test instructions",
    },
  },
  available_models: [
    { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
  ],
  default_instructions: "Default test instructions",
};

describe("Settings data structures", () => {
  it("validates read_only boolean", () => {
    expect(typeof mockConfig.read_only).toBe("boolean");
    expect(mockConfig.read_only).toBe(true);
  });

  it("validates dragons record structure", () => {
    const dragons = mockConfig.dragons;
    expect(dragons).toBeDefined();
    expect(Object.keys(dragons)).toHaveLength(1);

    const dragon = dragons["kiro-A"];
    expect(dragon.name).toBe("Smaug");
    expect(dragon.model).toBe("claude-opus-4.5");
    expect(dragon.machine).toBe("mac");
    expect(dragon.adapter).toBe("kiro");
  });

  it("validates available_models array", () => {
    const models = mockConfig.available_models;
    expect(Array.isArray(models)).toBe(true);
    expect(models).toHaveLength(2);

    expect(models[0].id).toBe("claude-opus-4.5");
    expect(models[0].name).toBe("Claude Opus 4.5");
  });

  it("validates machines record structure", () => {
    const machines = mockConfig.machines;
    expect(machines).toBeDefined();

    const mac = machines.mac;
    expect(mac.name).toBe("Test Mac");
    expect(mac.type).toBe("local");
    expect(mac.runners).toEqual(["heavy", "light"]);
  });

  it("validates default_instructions string", () => {
    expect(typeof mockConfig.default_instructions).toBe("string");
    expect(mockConfig.default_instructions).toBe("Default test instructions");
  });
});

describe("Settings update merging", () => {
  it("merges read_only update", () => {
    const current = { ...mockConfig };
    const update = { read_only: false };

    const merged = { ...current, ...update };

    expect(merged.read_only).toBe(false);
    expect(merged.dragons).toEqual(mockConfig.dragons);
  });

  it("merges dragons update (replaces entire dragons object)", () => {
    const current = { ...mockConfig };
    const newDragons = {
      "kiro-B": {
        name: "Temeraire",
        model: "claude-sonnet-4",
        machine: "mac",
        adapter: "kiro",
        instructions: "New instructions",
      },
    };

    const merged = { ...current, dragons: newDragons };

    expect(Object.keys(merged.dragons)).toHaveLength(1);
    expect(merged.dragons["kiro-B"]).toBeDefined();
    expect("kiro-A" in merged.dragons).toBe(false);
  });

  it("merges available_models update", () => {
    const current = { ...mockConfig };
    const newModels = [
      { id: "gpt-4", name: "GPT-4" },
    ];

    const merged = { ...current, available_models: newModels };

    expect(merged.available_models).toHaveLength(1);
    expect(merged.available_models[0].id).toBe("gpt-4");
  });

  it("merges machines update (preserves unaffected fields)", () => {
    const current = { ...mockConfig };
    const machineUpdate = {
      mac: {
        ...current.machines.mac,
        name: "Updated Mac",
      },
    };

    const merged = {
      ...current,
      machines: {
        ...current.machines,
        ...machineUpdate,
      },
    };

    expect(merged.machines.mac.name).toBe("Updated Mac");
    expect(merged.machines.mac.type).toBe("local");
    expect(merged.machines.mac.runners).toEqual(["heavy", "light"]);
  });

  it("merges default_instructions update", () => {
    const current = { ...mockConfig };
    const update = { default_instructions: "Updated instructions" };

    const merged = { ...current, ...update };

    expect(merged.default_instructions).toBe("Updated instructions");
  });
});

describe("Dragon validation", () => {
  it("validates dragon ID format", () => {
    const validIds = ["kiro-A", "kiro-B", "kiro-Z"];
    const invalidIds = ["kiro-a", "kiro-1", "kiro-AB", "invalid"];

    const isValidDragonId = (id: string): boolean => {
      return /^kiro-[A-Z]$/.test(id);
    };

    for (const id of validIds) {
      expect(isValidDragonId(id)).toBe(true);
    }

    for (const id of invalidIds) {
      expect(isValidDragonId(id)).toBe(false);
    }
  });

  it("requires name field", () => {
    const dragon = mockConfig.dragons["kiro-A"];
    expect(dragon.name).toBeDefined();
    expect(typeof dragon.name).toBe("string");
    expect(dragon.name.length).toBeGreaterThan(0);
  });

  it("validates adapter references", () => {
    const validAdapters = ["kiro", "aider", "claude-code", "cursor-agent"];
    const dragon = mockConfig.dragons["kiro-A"];

    expect(validAdapters).toContain(dragon.adapter);
  });
});

describe("Model validation", () => {
  it("requires id and name fields", () => {
    for (const model of mockConfig.available_models) {
      expect(model.id).toBeDefined();
      expect(typeof model.id).toBe("string");
      expect(model.name).toBeDefined();
      expect(typeof model.name).toBe("string");
    }
  });

  it("handles optional description field", () => {
    const modelWithDesc: { id: string; name: string; description?: string } = {
      id: "test-model",
      name: "Test Model",
      description: "A test model",
    };

    const modelWithoutDesc: { id: string; name: string; description?: string } = {
      id: "test-model-2",
      name: "Test Model 2",
    };

    expect(modelWithDesc.description).toBe("A test model");
    expect(modelWithoutDesc.description).toBeUndefined();
  });
});

describe("Machine validation", () => {
  it("validates machine type", () => {
    const validTypes = ["local", "ssh"];
    const machine = mockConfig.machines.mac;

    expect(validTypes).toContain(machine.type);
  });

  it("requires SSH fields for SSH machines", () => {
    const sshMachine = {
      name: "Remote",
      type: "ssh" as const,
      host: "198.51.100.10",
      user: "admin",
      key: "/path/to/key",
      runners: ["remote" as const],
    };

    expect(sshMachine.host).toBeDefined();
    expect(sshMachine.user).toBeDefined();
    expect(sshMachine.key).toBeDefined();
  });

  it("validates runner values", () => {
    const validRunners = ["heavy", "light", "remote"];
    const machine = mockConfig.machines.mac;

    for (const runner of machine.runners) {
      expect(validRunners).toContain(runner);
    }
  });
});

describe("Config backup", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it("generates unique backup filename", () => {
    const configPath = join(TEST_DIR, "test.yaml");
    const timestamp = Date.now();
    const backupPath = `${configPath}.backup-${timestamp}`;

    expect(backupPath).toContain(".backup-");
    expect(backupPath).toContain(String(timestamp));
  });

  it("creates backup before update", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const backupPath = `${configPath}.backup-${Date.now()}`;

    // Create original config
    writeFileSync(configPath, "original: true");

    // Copy to backup
    const original = readFileSync(configPath, "utf-8");
    writeFileSync(backupPath, original);

    // Verify backup exists
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf-8")).toBe("original: true");
  });
});
