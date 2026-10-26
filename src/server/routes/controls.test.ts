/**
 * Dragon id validation for /api/controls/dragon/start and /stop: the ids
 * accepted are the dragons the dashboard lists (YAML `dragons:` plus
 * <agents_dir>/dragons.txt).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dragonIdError, knownDragonIds } from "./controls.js";
import type { ProjectConfig } from "../../shared/types.js";

let agentsDir: string;

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "lair-controls-"));
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

function config(dragons: ProjectConfig["dragons"]): ProjectConfig {
  return {
    name: "test",
    repo: "/nonexistent",
    github: "example/test",
    queue_file: "/nonexistent/queue.md",
    agents_dir: agentsDir,
    gates_dir: "/nonexistent",
    machines: {},
    dragons,
  };
}

function dragon(name: string): NonNullable<ProjectConfig["dragons"]>[string] {
  return { name, model: "test-model", machine: "local", instructions: "" };
}

function writeDragonsTxt(lines: string[]): void {
  writeFileSync(join(agentsDir, "dragons.txt"), lines.join("\n") + "\n");
}

describe("knownDragonIds", () => {
  it("returns the YAML dragons when there is no dragons.txt", () => {
    const ids = knownDragonIds(config({ alpha: dragon("Alpha") }));
    expect([...ids]).toEqual(["alpha"]);
  });

  it("returns the dragons.txt dragons when the YAML map is empty", () => {
    writeDragonsTxt(["# id\tname\ttask", "kiro-A\tSmaug\tfix-auth", "aider-1 Glaurung"]);
    const ids = knownDragonIds(config({}));
    expect([...ids].sort()).toEqual(["aider-1", "kiro-A"]);
  });

  it("merges both sources", () => {
    writeDragonsTxt(["kiro-A\tSmaug\tfix-auth", "alpha\tAlpha\tdup"]);
    const ids = knownDragonIds(config({ alpha: dragon("Alpha"), beta: dragon("Beta") }));
    expect([...ids].sort()).toEqual(["alpha", "beta", "kiro-A"]);
  });

  it("works without a dragons: key at all", () => {
    writeDragonsTxt(["kiro-A\tSmaug\tfix-auth"]);
    expect([...knownDragonIds(config(undefined))]).toEqual(["kiro-A"]);
  });

  it("drops ids that fail isValidDragonId from either source", () => {
    writeDragonsTxt(["1-agent\tDigit\tt", "../etc\tEscape\tt", "kiro-\tTrailing\tt"]);
    const ids = knownDragonIds(config({ "9lives": dragon("Nine") }));
    expect([...ids]).toEqual([]);
  });
});

describe("dragonIdError", () => {
  it("accepts a dragon defined in the YAML dragons: map", () => {
    expect(dragonIdError(config({ alpha: dragon("Alpha") }), "alpha")).toBeNull();
  });

  it("rejects a digit-first id even when the YAML map has it", () => {
    expect(dragonIdError(config({ "9lives": dragon("Nine") }), "9lives")).toBe("Invalid dragonId");
  });

  it("accepts a dragon listed only in dragons.txt (YAML dragons: {})", () => {
    writeDragonsTxt(["kiro-A\tSmaug\tfix-auth", "kiro-B\tFafnir\tunassigned"]);
    const cfg = config({});
    expect(dragonIdError(cfg, "kiro-A")).toBeNull();
    expect(dragonIdError(cfg, "kiro-B")).toBeNull();
  });

  it("rejects an id in neither source", () => {
    writeDragonsTxt(["kiro-A\tSmaug\tfix-auth"]);
    const cfg = config({ alpha: dragon("Alpha") });
    expect(dragonIdError(cfg, "kiro-Z")).toBe("Unknown dragon: kiro-Z");
  });

  it("rejects a digit-first id as invalid, even if dragons.txt lists it", () => {
    writeDragonsTxt(["1-agent\tDigit\tt"]);
    expect(dragonIdError(config({}), "1-agent")).toBe("Invalid dragonId");
  });

  it.each(["x/../../../escape", "kiro.A", "kiro A", "kiro-", "a".repeat(65)])(
    "rejects the malformed id %j",
    (id) => {
      expect(dragonIdError(config({ alpha: dragon("Alpha") }), id)).toBe("Invalid dragonId");
    },
  );

  it.each([undefined, null, "", 42])("rejects a missing id (%j)", (id) => {
    expect(dragonIdError(config({ alpha: dragon("Alpha") }), id)).toBe("Missing dragonId");
  });
});
