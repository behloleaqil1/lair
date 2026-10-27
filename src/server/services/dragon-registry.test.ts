/**
 * The dragon registry shared by start/stop validation and the start dialog.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  knownDragonIds,
  loadKnownDragons,
  mergeDragonRegistry,
  readDragonsFile,
} from "./dragon-registry.js";
import { dragonDefaults, hasOwnModel, validateDragonDefaults } from "../parsers/dragon-config.js";
import type { ProjectConfig } from "../../shared/types.js";

let agentsDir: string;

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "lair-registry-"));
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

function config(dragons?: Record<string, Record<string, string>>): ProjectConfig {
  return {
    name: "test",
    repo: "/nonexistent",
    github: "example/test",
    queue_file: "/nonexistent/queue.md",
    agents_dir: agentsDir,
    gates_dir: "/nonexistent",
    machines: {},
    // YAML as written: entries may leave out model, machine and instructions
    dragons,
  } as unknown as ProjectConfig;
}

describe("mergeDragonRegistry", () => {
  it("keeps YAML dragons with their fields and the usual defaults", () => {
    const dragons = mergeDragonRegistry(
      config({
        "kiro-A": { name: "Smaug", model: "claude-opus-4.5", machine: "mac", adapter: "kiro" },
        "kiro-B": { name: "Saphira" },
      }),
      "",
    );
    expect(dragons.get("kiro-A")).toEqual({
      id: "kiro-A",
      name: "Smaug",
      model: "claude-opus-4.5",
      machine: "mac",
      instructions: "",
      adapter: "kiro",
    });
    expect(dragons.get("kiro-B")).toMatchObject({
      name: "Saphira",
      model: "claude-sonnet-4",
      machine: "local",
    });
  });

  it("adds dragons.txt-only dragons with their name and no model, machine or adapter", () => {
    const dragons = mergeDragonRegistry(config({}), "kiro-C\tFafnir\tfix-auth\naider-1 Glaurung\n");
    expect([...dragons.keys()].sort()).toEqual(["aider-1", "kiro-C"]);
    expect(dragons.get("kiro-C")).toEqual({
      id: "kiro-C",
      name: "Fafnir",
      model: "",
      machine: "",
      instructions: "",
    });
    expect(dragons.get("kiro-C")?.adapter).toBeUndefined();
    expect(dragons.get("aider-1")?.name).toBe("Glaurung");
  });

  it("lets the YAML entry win for a dragon in both sources", () => {
    const dragons = mergeDragonRegistry(
      config({ "kiro-A": { name: "Smaug", model: "claude-opus-4.5" } }),
      "kiro-A\tOther name\ttask\n",
    );
    expect(dragons.size).toBe(1);
    expect(dragons.get("kiro-A")).toMatchObject({ name: "Smaug", model: "claude-opus-4.5" });
  });

  it("drops invalid ids from either source", () => {
    const dragons = mergeDragonRegistry(
      config({ "9lives": { name: "Nine" } }),
      "1-agent\tDigit\tt\n../etc\tEscape\tt\nkiro-\tTrailing\tt\n# comment line\n",
    );
    expect(dragons.size).toBe(0);
  });

  it("works without a dragons: key", () => {
    expect([...mergeDragonRegistry(config(undefined), "kiro-A\tSmaug\tt\n").keys()]).toEqual([
      "kiro-A",
    ]);
  });
});

describe("dragon_defaults", () => {
  const withDefaults = (defaults: unknown, dragons?: Record<string, Record<string, string>>) =>
    ({ ...config(dragons), dragon_defaults: defaults }) as unknown as ProjectConfig;

  it("gives dragons.txt dragons the default model and adapter", () => {
    const dragons = mergeDragonRegistry(
      withDefaults({ model: "model-default", adapter: "aider" }),
      "kiro-C\tFafnir\tfix-auth\n",
    );
    expect(dragons.get("kiro-C")).toEqual({
      id: "kiro-C",
      name: "Fafnir",
      model: "model-default",
      machine: "",
      instructions: "",
      adapter: "aider",
    });
  });

  it("lets a YAML entry's own model and adapter win, and fills in only what it leaves out", () => {
    const dragons = mergeDragonRegistry(
      withDefaults(
        { model: "model-default", adapter: "aider" },
        {
          "kiro-A": { name: "Smaug", model: "model-own", adapter: "kiro" },
          "kiro-B": { name: "Saphira" },
        },
      ),
      "kiro-A\tSmaug\tt\n",
    );
    expect(dragons.get("kiro-A")).toMatchObject({ model: "model-own", adapter: "kiro" });
    expect(dragons.get("kiro-B")).toMatchObject({ model: "model-default", adapter: "aider" });
    expect(hasOwnModel(withDefaults({}, { "kiro-A": { name: "Smaug", model: "model-own" } }), "kiro-A")).toBe(true);
    expect(hasOwnModel(withDefaults({}, { "kiro-B": { name: "Saphira" } }), "kiro-B")).toBe(false);
  });

  it("uses only well-formed values, also when the config was never validated", () => {
    expect(dragonDefaults(withDefaults({ model: "-rf", adapter: "../x" }))).toEqual({});
    expect(dragonDefaults(withDefaults("model-a"))).toEqual({});
    expect(dragonDefaults(withDefaults(["model-a"]))).toEqual({});
    expect(dragonDefaults(withDefaults({ model: "vendor/model-1.5:latest" }))).toEqual({
      model: "vendor/model-1.5:latest",
    });
    const dragons = mergeDragonRegistry(withDefaults({ model: "--model=x" }), "kiro-C\tFafnir\tt\n");
    expect(dragons.get("kiro-C")?.model).toBe("");
  });

  it("is validated: a mapping of a model id and a known adapter only", () => {
    expect(validateDragonDefaults(config({}))).toEqual([]);
    expect(validateDragonDefaults(withDefaults({ model: "model-a", adapter: "claude-code" }))).toEqual([]);
    expect(validateDragonDefaults(withDefaults("model-a"))).toEqual([
      expect.stringContaining("dragon_defaults: must be a mapping"),
    ]);
    expect(validateDragonDefaults(withDefaults({ model: "-rf", adapter: "no-such-cli", machine: "x" }))).toEqual([
      expect.stringContaining("dragon_defaults.model: must be a model id"),
      expect.stringContaining("dragon_defaults.adapter: unknown adapter no-such-cli"),
      expect.stringContaining("dragon_defaults.machine: unknown key"),
    ]);
    // A project's own adapter counts
    const own = { ...withDefaults({ adapter: "my-cli" }), agent_adapters: { "my-cli": { id: "my-cli" } } };
    expect(validateDragonDefaults(own as unknown as ProjectConfig)).toEqual([]);
  });
});

describe("loadKnownDragons / knownDragonIds", () => {
  it("reads dragons.txt from agents_dir", () => {
    writeFileSync(join(agentsDir, "dragons.txt"), "kiro-C\tFafnir\tt\n");
    const cfg = config({ "kiro-A": { name: "Smaug" } });
    expect(readDragonsFile(cfg)).toBe("kiro-C\tFafnir\tt\n");
    expect([...loadKnownDragons(cfg).keys()].sort()).toEqual(["kiro-A", "kiro-C"]);
    expect([...knownDragonIds(cfg)].sort()).toEqual(["kiro-A", "kiro-C"]);
  });

  it("uses only the YAML map when dragons.txt is missing", () => {
    const cfg = config({ "kiro-A": { name: "Smaug" } });
    expect(readDragonsFile(cfg)).toBe("");
    expect([...knownDragonIds(cfg)]).toEqual(["kiro-A"]);
  });

  it("sees dragons.txt changes without a restart", () => {
    const cfg = config({});
    expect(knownDragonIds(cfg).size).toBe(0);
    writeFileSync(join(agentsDir, "dragons.txt"), "kiro-D\tNew\tt\n");
    expect([...knownDragonIds(cfg)]).toEqual(["kiro-D"]);
  });
});
