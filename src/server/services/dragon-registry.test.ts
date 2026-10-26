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
