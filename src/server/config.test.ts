/**
 * Project discovery (src/server/config.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listProjects } from "./config.js";

describe("listProjects", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lair-projects-"));
    mkdirSync(join(dir, "local"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function touch(...parts: string[]): void {
    writeFileSync(join(dir, ...parts), "name: x\n");
  }

  it("lists .yaml and .yml files from projects/ and projects/local/, once each", () => {
    touch("example.yaml");
    touch("other.yml");
    touch("local", "private.yaml");
    touch("local", "example.yaml");
    expect(listProjects(dir).sort()).toEqual(["example", "other", "private"]);
  });

  it("skips files whose names the API would refuse", () => {
    touch("good.yaml");
    touch("v1.2_ok-name.yml");
    touch(".hidden.yaml");
    touch("-dash.yaml");
    touch("_under.yml");
    touch("has space.yaml");
    touch("semi;colon.yaml");
    touch(`${"a".repeat(101)}.yaml`);
    touch("local", "Ünicode.yaml");
    expect(listProjects(dir).sort()).toEqual(["good", "v1.2_ok-name"]);
  });

  it("ignores files that are not YAML", () => {
    touch("notes.txt");
    touch("example.yaml.bak");
    touch("example.yaml");
    expect(listProjects(dir)).toEqual(["example"]);
  });

  it("returns [] when the directory does not exist", () => {
    expect(listProjects(join(dir, "missing"))).toEqual([]);
  });
});
