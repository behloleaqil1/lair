/**
 * The pieces of Settings on their own: the zod to JSON Schema converter, the
 * Document-based YAML edits, the command and secret rules, the line diff,
 * the parsers' messages as field errors, and the form's change list.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { toJsonSchema } from "./json-schema.js";
import { ChangeError, applyChanges, newConfigText } from "./yaml-doc.js";
import { commandChanges, fieldErrors } from "./checks.js";
import { githubOf } from "./service.js";
import { collectCommands, findSecrets, isSecretKey } from "../../shared/settings-rules.js";
import { formatDiff, lineDiff } from "../../shared/line-diff.js";
import { diffValues, kindOf, setIn, textToList, textToNumber } from "../../client/settings-form";

describe("toJsonSchema", () => {
  it("converts the zod features the config parsers use", () => {
    const Node: z.ZodTypeAny = z.lazy(() => z.object({ child: Node.optional() }));
    const schema = z
      .object({
        enabled: z.boolean().default(false),
        count: z.number().int().min(1).max(10).default(3),
        ratio: z.number().positive(),
        name: z.string().regex(/^[a-z]+$/).min(2).max(8),
        url: z.string().url().optional(),
        mode: z.enum(["observe", "act"]).default("observe"),
        kind: z.literal("compose").default("compose"),
        argv: z.array(z.string().min(1)).min(1),
        envs: z.record(z.string()),
        loose: z.object({ a: z.string() }).passthrough(),
        either: z.union([z.string(), z.object({ any_of: z.array(z.string()) }).strict()]),
        tagged: z.discriminatedUnion("type", [
          z.object({ type: z.literal("http"), url: z.string() }),
          z.object({ type: z.literal("container") }),
        ]),
        checked: z.string().refine((s) => !s.startsWith("-"), "no options"),
        prepared: z.preprocess((v) => v ?? {}, z.object({ build: z.boolean().default(false) })),
        maybe: z.string().nullable(),
        tree: Node,
      })
      .strict();
    const json = toJsonSchema(schema);
    expect(json.type).toBe("object");
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(["ratio", "name", "argv", "envs", "loose", "either", "tagged", "checked", "maybe", "tree"]);
    const p = json.properties!;
    expect(p.enabled).toEqual({ type: "boolean", default: false });
    expect(p.count).toEqual({ type: "integer", minimum: 1, maximum: 10, default: 3 });
    expect(p.ratio).toEqual({ type: "number", exclusiveMinimum: 0 });
    expect(p.name).toEqual({ type: "string", pattern: "^[a-z]+$", minLength: 2, maxLength: 8 });
    expect(p.url).toEqual({ type: "string", format: "uri" });
    expect(p.mode).toEqual({ type: "string", enum: ["observe", "act"], default: "observe" });
    expect(p.kind).toEqual({ type: "string", const: "compose", default: "compose" });
    expect(p.argv).toEqual({ type: "array", items: { type: "string", minLength: 1 }, minItems: 1 });
    expect(p.envs).toEqual({ type: "object", additionalProperties: { type: "string" } });
    expect(p.loose.additionalProperties).toBe(true);
    expect(p.either.anyOf).toHaveLength(2);
    expect(p.tagged.discriminator).toEqual({ propertyName: "type" });
    expect(p.tagged.oneOf![0].properties!.type).toEqual({ type: "string", const: "http" });
    expect(p.checked).toEqual({ type: "string", "x-refined": true });
    expect(p.prepared).toMatchObject({ type: "object", "x-refined": true, properties: { build: { default: false } } });
    expect(p.maybe).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    // A schema that refers to itself stops where it recurses
    expect(p.tree.properties!.child).toEqual({});
  });
});

describe("applyChanges", () => {
  const text = [
    "# top comment",
    "",
    "name: Shop # display name",
    "watchdog:",
    "  # how often",
    "  interval_seconds: 60",
    "  mode: 'observe'",
    "delivery:",
    "  environments:",
    "    local:",
    "      services:",
    "        web:",
    "dragon_stop_cmd: [\"./stop\", \"{dragon}\"]",
    "",
  ].join("\n");

  it("changes values in place, keeping comments, quoting and order", () => {
    const out = applyChanges(text, [
      { path: ["watchdog", "interval_seconds"], value: 120 },
      { path: ["watchdog", "mode"], value: "act" },
      { path: ["name"], value: "Shop 2" },
    ]);
    expect(out).toBe(
      text.replace("interval_seconds: 60", "interval_seconds: 120").replace("'observe'", "'act'").replace("Shop #", "Shop 2 #"),
    );
  });

  it("adds keys after the others, lists of scalars as flow lists, and fills an empty value", () => {
    const out = applyChanges(text, [
      { path: ["watchdog", "actions"], value: { restart_agent: ["./restart", "{agent}"] } },
      { path: ["delivery", "environments", "local", "services", "web", "build"], value: true },
      { path: ["dragon_stop_cmd"], value: ["./stop", "{dragon}", "--now"] },
    ]);
    expect(parseYaml(out)).toMatchObject({
      watchdog: { interval_seconds: 60, mode: "observe", actions: { restart_agent: ["./restart", "{agent}"] } },
      delivery: { environments: { local: { services: { web: { build: true } } } } },
      dragon_stop_cmd: ["./stop", "{dragon}", "--now"],
    });
    expect(out).toContain('restart_agent: [./restart, "{agent}"]');
    expect(out).toContain('dragon_stop_cmd: ["./stop", "{dragon}", --now]');
    expect(out).toContain("  # how often\n  interval_seconds: 60\n");
  });

  it("removes keys, and refuses changes it can't apply", () => {
    const out = applyChanges(text, [{ path: ["watchdog", "mode"], remove: true }, { path: ["missing", "key"], remove: true }]);
    expect(out).toBe(text.replace("  mode: 'observe'\n", ""));
    expect(() => applyChanges(text, [{ path: ["name", "first"], value: "x" }])).toThrow(ChangeError);
    expect(() => applyChanges(text, [{ path: ["__proto__", "x"], value: 1 }])).toThrow(/not allowed/);
    expect(() => applyChanges(text, [{ path: ["a"], value: { constructor: 1 } }])).toThrow(/not allowed/);
    expect(() => applyChanges(text, [{ path: [], value: 1 }])).toThrow(ChangeError);
    expect(() => applyChanges("name: [broken\n", [{ path: ["name"], value: "x" }])).toThrow(/YAML tab/);
  });

  it("writes a new file with its comment at the top", () => {
    const out = newConfigText({ name: "Demo", repo: "/srv/demo", skip: undefined, watchdog: { enabled: true } }, " made here");
    expect(out.startsWith("# made here\n\nname: Demo\n")).toBe(true);
    expect(parseYaml(out)).toEqual({ name: "Demo", repo: "/srv/demo", watchdog: { enabled: true } });
  });
});

describe("command-bearing fields", () => {
  it("finds commands by key and shape in any block, and nothing else", () => {
    const config = {
      ask_cmd: ["./ask", "{text}"],
      agent_adapters: { mine: { start_cmd: "mine --prompt {prompt_file}", status_method: "file" } },
      watchdog: { actions: { restart_agent: ["./r", "{agent}"] }, agent_command: "worker {agent}" },
      triage: { actions: { infra: "recheck" }, commands: { recheck: ["./recheck", "{request}"] } },
      agents: { fill: { capacity_cmd: ["./free"], agents: ["a"] } },
      pipelines: { ci: { steps: [{ name: "test", run: ["npm", "test"], env: { CI: "1" } }] } },
      processes: { api: { command: ["node", "server.js"], cwd: "/srv" } },
      machines: { box: { type: "ssh", gate_script: "/opt/gate.sh", key: "~/.ssh/id" } },
      server: { update_cmd: [["git", "pull"], ["npm", "ci"]] },
      placement: { machines: { m1: { probe: ["ssh", "m1", "true"], load_cmd: ["ssh", "m1", "uptime"], cpus: 8 } }, move_cmd: ["./move", "{id}"] },
    };
    expect([...collectCommands(config).keys()].sort()).toEqual([
      "agent_adapters.mine.start_cmd",
      "agents.fill.capacity_cmd",
      "ask_cmd",
      "machines.box.gate_script",
      "pipelines.ci.steps.0.env",
      "pipelines.ci.steps.0.run",
      "placement.machines.m1.load_cmd",
      "placement.machines.m1.probe",
      "placement.move_cmd",
      "processes.api.command",
      "processes.api.cwd",
      "server.update_cmd",
      "triage.commands.recheck",
      "watchdog.actions.restart_agent",
    ]);
  });

  it("lists the commands a change adds or alters, not those it removes", () => {
    const before = { ask_cmd: ["./ask"], merge_cmd: ["./merge"] };
    const after = { ask_cmd: ["./ask", "--fast"], tick_now_cmd: ["./tick"] };
    expect(commandChanges(before, after, [])).toEqual([
      { path: "ask_cmd", before: ["./ask"], after: ["./ask", "--fast"] },
      { path: "tick_now_cmd", before: null, after: ["./tick"] },
    ]);
  });
});

describe("secrets", () => {
  it("knows secret keys from keys that point at one", () => {
    for (const key of ["token", "api_key", "apiKey", "password", "client_secret", "node_token", "private_key"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ["token_env", "token_cmd", "password_file", "key", "public_key_file", "node_keys", "session_id_env"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it("finds values shaped like secrets anywhere, and not ordinary values", () => {
    const aws = ["AKIA", "Z".repeat(16)].join("");
    const findings = findSecrets({
      a: ["x", `key=${aws}`],
      b: { clone_url: ["https://ci:", "s".repeat(12), "@example.com/r.git"].join("") },
      ok: {
        branch: "task-abcdefghijklmnopqrstuvwxyz",
        remote: "git@github.com:example/shop.git",
        user_url: "https://ci@example.com/r.git",
        token_env: "GITHUB_TOKEN",
      },
    });
    expect(findings.map((f) => f.path)).toEqual(["a.1", "b.clone_url"]);
  });
});

describe("lineDiff", () => {
  it("diffs lines in hunks with context", () => {
    const a = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].join("\n") + "\n";
    const b = a.replace("two", "TWO").replace("nine\n", "");
    const diff = lineDiff(a, b);
    expect(diff).toMatchObject({ added: 1, removed: 2 });
    expect(formatDiff(diff)).toBe(
      ["@@ -1,10 +1,9 @@", " one", "-two", "+TWO", " three", " four", " five", " six", " seven", " eight", "-nine", " ten"].join("\n"),
    );
    expect(lineDiff(a, a).hunks).toEqual([]);
    expect(lineDiff("", "x\n")).toMatchObject({ added: 1, removed: 0 });
    // Past the edit bound the middle is shown replaced
    const many = (p: string) => Array.from({ length: 50 }, (_, i) => `${p}${i}`).join("\n");
    expect(lineDiff(many("a"), many("b"), 10)).toMatchObject({ replaced: true, added: 50, removed: 50 });
  });
});

describe("parser messages", () => {
  it("become errors at their field", () => {
    expect(
      fieldErrors([
        "watchdog.interval_seconds: Number must be greater than or equal to 5",
        "delivery.(root): Expected object, received string",
        "dragon_defaults.model: not a model id; dragon_defaults.adapter: unknown adapter x",
        "Adapter 'x': start_cmd is required",
      ]),
    ).toEqual([
      { path: "watchdog.interval_seconds", message: "Number must be greater than or equal to 5" },
      { path: "delivery", message: "Expected object, received string" },
      { path: "dragon_defaults.model", message: "not a model id" },
      { path: "dragon_defaults.adapter", message: "unknown adapter x" },
      { path: "", message: "Adapter 'x': start_cmd is required" },
    ]);
  });

  it("reads the GitHub repo of a remote", () => {
    expect(githubOf("https://github.com/example/shop.git")).toBe("example/shop");
    expect(githubOf("git@github.com:example/shop.git")).toBe("example/shop");
    expect(githubOf("ssh://git@github.com/example/shop")).toBe("example/shop");
    expect(githubOf("https://gitlab.example.com/example/shop.git")).toBeNull();
  });
});

describe("the form's changes", () => {
  it("sends only what changed: keys set and removed, lists whole", () => {
    const before = { a: 1, b: { c: [1, 2], d: "x" }, gone: true };
    const after = { a: 1, b: { c: [1, 2, 3], e: "y" }, added: { f: 1 } };
    expect(diffValues(before, after)).toEqual([
      { path: ["gone"], remove: true },
      { path: ["b", "d"], remove: true },
      { path: ["b", "c"], value: [1, 2, 3] },
      { path: ["b", "e"], value: "y" },
      { path: ["added"], value: { f: 1 } },
    ]);
    expect(setIn({ a: { b: 1 } }, ["a", "c"], 2)).toEqual({ a: { b: 1, c: 2 } });
    expect(setIn({ a: { b: 1 } }, ["a", "b"], undefined)).toEqual({ a: {} });
  });

  it("reads list and number widgets without changing what was typed", () => {
    expect(textToList("git\n  pull --ff-only\n\n")).toEqual(["git", "  pull --ff-only"]);
    expect(textToList("\n")).toBeUndefined();
    expect(textToNumber("")).toBeUndefined();
    expect(textToNumber(" 12.5 ")).toBe(12.5);
    expect(textToNumber("12x")).toBe("12x");
    expect(kindOf("prepare_cmd", { type: "array", items: { type: "string" } }, undefined)).toBe("argv");
    expect(kindOf("paths", { type: "array", items: { type: "string" } }, undefined)).toBe("globs");
    expect(kindOf("restart_agent", { type: "array", items: { type: "string" } }, undefined, "actions")).toBe("argv");
    expect(kindOf("infra", { type: "string", enum: ["recheck"] }, undefined, "actions")).toBe("select");
  });
});
