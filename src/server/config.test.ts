/**
 * Project discovery (src/server/config.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDefaultProject, listProjects, loadProjectConfig } from "./config.js";

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

describe("getDefaultProject", () => {
  let warn: MockInstance;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("prefers example, then the first project, without LAIR_PROJECT", () => {
    expect(getDefaultProject({}, ["alpha", "example"])).toBe("example");
    expect(getDefaultProject({}, ["beta", "alpha"])).toBe("beta");
    expect(getDefaultProject({ LAIR_PROJECT: "" }, ["beta", "example"])).toBe("example");
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses LAIR_PROJECT when it names a listed project", () => {
    expect(getDefaultProject({ LAIR_PROJECT: "alpha" }, ["alpha", "example"])).toBe("alpha");
    expect(getDefaultProject({ LAIR_PROJECT: "  alpha\n" }, ["example", "alpha"])).toBe("alpha");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and falls back when LAIR_PROJECT is not a listed project", () => {
    expect(getDefaultProject({ LAIR_PROJECT: "gone" }, ["alpha", "example"])).toBe("example");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('LAIR_PROJECT="gone" ignored (no such project');
    expect(warn.mock.calls[0][0]).toContain('using "example"');
  });

  it.each(["../example", "/etc/passwd", ".hidden", "a b", "-x"])(
    "warns and falls back when LAIR_PROJECT is the unsafe name %j",
    (name) => {
      // Even if the list somehow contained the name, LAIR_PROJECT must not select it
      expect(getDefaultProject({ LAIR_PROJECT: name }, ["beta", name])).toBe("beta");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("not a valid project name");
    },
  );

  it("warns only once for the same bad value", () => {
    getDefaultProject({ LAIR_PROJECT: "repeat-me" }, ["example"]);
    getDefaultProject({ LAIR_PROJECT: "repeat-me" }, ["example"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("throws when there are no projects", () => {
    expect(() => getDefaultProject({}, [])).toThrow("No project configurations found");
    expect(() => getDefaultProject({ LAIR_PROJECT: "x" }, [])).toThrow(
      "No project configurations found",
    );
  });

  it("reads LAIR_PROJECT from process.env by default", () => {
    const saved = process.env.LAIR_PROJECT;
    process.env.LAIR_PROJECT = "beta";
    try {
      expect(getDefaultProject(undefined, ["example", "beta"])).toBe("beta");
    } finally {
      if (saved === undefined) delete process.env.LAIR_PROJECT;
      else process.env.LAIR_PROJECT = saved;
    }
  });
});

describe("loadProjectConfig validates dragon_defaults", () => {
  const LOCAL_DIR = join(process.cwd(), "projects", "local");
  const NAME = "lair-dragon-defaults-test";
  const FILE = join(LOCAL_DIR, `${NAME}.yaml`);
  let createdLocalDir = false;

  beforeEach(() => {
    if (!existsSync(LOCAL_DIR)) {
      mkdirSync(LOCAL_DIR, { recursive: true });
      createdLocalDir = true;
    }
  });

  afterEach(() => {
    rmSync(FILE, { force: true });
    if (createdLocalDir && existsSync(LOCAL_DIR) && readdirSync(LOCAL_DIR).length === 0) {
      rmSync(LOCAL_DIR, { recursive: true, force: true });
    }
  });

  function write(...extra: string[]): void {
    writeFileSync(
      FILE,
      [
        `name: ${NAME}`,
        "repo: /nonexistent",
        "github: example/defaults-test",
        "queue_file: /nonexistent/queue.md",
        "agents_dir: /nonexistent/agents",
        "gates_dir: /nonexistent/gates",
        "machines: {}",
        ...extra,
        "",
      ].join("\n"),
    );
  }

  it("loads a project whose dragon_defaults name a model id and a known adapter", () => {
    write("dragon_defaults:", "  model: model-default", "  adapter: aider");
    expect(loadProjectConfig(NAME).dragon_defaults).toEqual({ model: "model-default", adapter: "aider" });
  });

  it("refuses to load one with a bad value or an unknown key, and says which", () => {
    write("dragon_defaults:", "  model: --model=x", "  adapter: no-such-cli");
    expect(() => loadProjectConfig(NAME)).toThrow(/dragon_defaults\.model: must be a model id.*dragon_defaults\.adapter: unknown adapter no-such-cli/);
    write("dragon_defaults:", "  machine: local");
    expect(() => loadProjectConfig(NAME)).toThrow("dragon_defaults.machine: unknown key");
    write("dragon_defaults: model-a");
    expect(() => loadProjectConfig(NAME)).toThrow("dragon_defaults: must be a mapping");
  });
});
