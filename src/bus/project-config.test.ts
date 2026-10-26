/**
 * lair-bus project config lookup: .yaml and .yml, projects/local/ first,
 * the current directory before the package root.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  busConfigCandidates,
  findBusConfigPath,
  loadBusProjectConfig,
} from "./project-config.js";

let cwdRoot: string;
let pkgRoot: string;

beforeEach(() => {
  cwdRoot = mkdtempSync(join(tmpdir(), "lair-bus-cwd-"));
  pkgRoot = mkdtempSync(join(tmpdir(), "lair-bus-pkg-"));
  for (const root of [cwdRoot, pkgRoot]) {
    mkdirSync(join(root, "projects", "local"), { recursive: true });
  }
});

afterEach(() => {
  rmSync(cwdRoot, { recursive: true, force: true });
  rmSync(pkgRoot, { recursive: true, force: true });
});

function write(root: string, rel: string, name: string): string {
  const path = join(root, "projects", rel);
  writeFileSync(path, `name: ${name}\nqueue_file: /q/${name}.md\nmail_dir: /mail\n`);
  return path;
}

describe("busConfigCandidates", () => {
  it("checks local before public and .yaml before .yml, root by root", () => {
    expect(busConfigCandidates("p", ["/a", "/b"])).toEqual([
      join("/a", "projects", "local", "p.yaml"),
      join("/a", "projects", "local", "p.yml"),
      join("/a", "projects", "p.yaml"),
      join("/a", "projects", "p.yml"),
      join("/b", "projects", "local", "p.yaml"),
      join("/b", "projects", "local", "p.yml"),
      join("/b", "projects", "p.yaml"),
      join("/b", "projects", "p.yml"),
    ]);
  });
});

describe("findBusConfigPath / loadBusProjectConfig", () => {
  it("loads a .yml config", () => {
    const path = write(cwdRoot, "only-yml.yml", "OnlyYml");
    expect(findBusConfigPath("only-yml", [cwdRoot, pkgRoot])).toBe(path);
    expect(loadBusProjectConfig("only-yml", [cwdRoot, pkgRoot])).toEqual({
      name: "OnlyYml",
      queue_file: "/q/OnlyYml.md",
      inbox_file: undefined,
      mail_dir: "/mail",
      wake_file: undefined,
    });
  });

  it("loads a .yml config from projects/local/", () => {
    write(cwdRoot, "proj.yaml", "Public");
    write(cwdRoot, join("local", "proj.yml"), "Private");
    expect(loadBusProjectConfig("proj", [cwdRoot, pkgRoot]).name).toBe("Private");
  });

  it("prefers .yaml over .yml in the same directory", () => {
    write(cwdRoot, "both.yml", "Yml");
    write(cwdRoot, "both.yaml", "Yaml");
    expect(loadBusProjectConfig("both", [cwdRoot, pkgRoot]).name).toBe("Yaml");
  });

  it("prefers the current directory over the package root", () => {
    write(pkgRoot, join("local", "proj.yaml"), "Package");
    write(cwdRoot, "proj.yml", "Cwd");
    expect(loadBusProjectConfig("proj", [cwdRoot, pkgRoot]).name).toBe("Cwd");
  });

  it("falls back to the package root", () => {
    write(pkgRoot, "pkg-only.yml", "PkgOnly");
    expect(loadBusProjectConfig("pkg-only", [cwdRoot, pkgRoot]).name).toBe("PkgOnly");
  });

  it("lists every searched path when nothing matches", () => {
    expect(() => loadBusProjectConfig("missing", [cwdRoot, pkgRoot])).toThrow(
      /Project config not found: missing\nSearched: .*missing\.yaml.*missing\.yml/,
    );
  });
});
