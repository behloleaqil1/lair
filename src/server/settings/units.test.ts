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
import { collectCommands, commentSecrets, findSecrets, isSecretKey, redactSecrets } from "../../shared/settings-rules.js";
import { formatDiff, lineDiff } from "../../shared/line-diff.js";
import { diffValues, kindOf, saveRequestOf, setIn, textToList, textToNumber } from "../../client/settings-form";
import type { SettingsCheck } from "../../shared/settings-types.js";

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

describe("Save after a review", () => {
  it("sends the command changes' confirmation only when the owner ticked it", () => {
    const changes = [{ path: ["dragon_start_cmd"], value: ["./bin/start", "{dragon}"] }];
    const check: SettingsCheck = {
      ok: true,
      errors: [],
      diff: { hunks: [], added: 0, removed: 0 },
      yaml: "",
      commands: [{ path: "dragon_start_cmd", before: null, after: ["./bin/start", "{dragon}"] }],
      commandsDigest: "d1",
      conflict: false,
      currentHash: "h",
    };
    // A request carried over with a digest is not confirmed by that
    const reviewed = { baseHash: "h", changes, confirmCommands: "stale" };
    expect(saveRequestOf(reviewed, check, false)).toEqual({ baseHash: "h", changes });
    expect(saveRequestOf(reviewed, check, true)).toEqual({ baseHash: "h", changes, confirmCommands: "d1" });
    expect(saveRequestOf(reviewed, { ...check, commands: [], commandsDigest: "" }, true)).toEqual({ baseHash: "h", changes });
  });
});

describe("a save changes only the lines it changes, in a file written by hand", () => {
  // A real project file's shape: padded flow maps with comments aligned by several spaces, a block comment, a quoted
  // string, a multi-line flow map, a padded flow list and a list at its key's indentation (`key:\n- a`)
  const kiroA = '  kiro-A: { id: kiro-A, name: Smaug, model: claude-opus-4.5, machine: mac, instructions: "", adapter: kiro-lair }   # builds';
  const kiroB = "  kiro-B: { id: kiro-B, name: Glaurung, model: claude-sonnet-4, machine: mac, adapter: kiro-lair }    # reviews";
  const file = [
    "# The project's own file",
    "name: Lair",
    "",
    "# The agents, one line each",
    "dragons:",
    kiroA,
    kiroB,
    "  kiro-C: {",
    "    id: kiro-C,",
    "    name: Saphira,",
    "    model: claude-haiku-4.5",
    "  }",
    "machines:",
    "  mac: { type: local, runners: [ heavy, light ] }      # this one",
    "watchdog:",
    "  enabled: true          # on",
    "  interval_seconds: 60   # once a minute",
    "  mode: 'observe'",
    "agents:",
    "  env_passthrough:",
    "  - LANG",
    "  - TZ",
    'prompts_dir: "data/prompts"',
    "",
  ].join("\n");

  /** The save changed exactly this line, and nothing else */
  const onlyLine = (out: string, from: string, to: string) => {
    expect(file.split(from)).toHaveLength(2);
    expect(out).toBe(file.replace(from, to));
    expect(lineDiff(file, out)).toMatchObject({ added: 1, removed: 1 });
  };

  it("a model changed: one line, with its padding, its other keys and its aligned comment as they were", () => {
    const out = applyChanges(file, [{ path: ["dragons", "kiro-A", "model"], value: "claude-opus-4.6" }]);
    onlyLine(out, kiroA, kiroA.replace("claude-opus-4.5", "claude-opus-4.6"));
  });

  it("values in a multi-line flow map, a number before an aligned comment, a quoted string, a padded flow list", () => {
    onlyLine(
      applyChanges(file, [{ path: ["dragons", "kiro-C", "model"], value: "claude-sonnet-4.5" }]),
      "    model: claude-haiku-4.5",
      "    model: claude-sonnet-4.5",
    );
    onlyLine(applyChanges(file, [{ path: ["watchdog", "interval_seconds"], value: 90 }]), "interval_seconds: 60   #", "interval_seconds: 90   #");
    onlyLine(applyChanges(file, [{ path: ["prompts_dir"], value: "prompts" }]), 'prompts_dir: "data/prompts"', 'prompts_dir: "prompts"');
    onlyLine(applyChanges(file, [{ path: ["machines", "mac", "runners"], value: ["heavy", "gpu"] }]), "[ heavy, light ]", "[ heavy, gpu ]");
    // A string that would read as a number is quoted, so it stays a string
    const quoted = applyChanges(file, [{ path: ["dragons", "kiro-A", "machine"], value: "60" }]);
    onlyLine(quoted, "machine: mac, instructions", 'machine: "60", instructions');
    expect(parseYaml(quoted).dragons["kiro-A"].machine).toBe("60");
  });

  it("keys removed from and added to a padded flow map (a move to a profile): its line only", () => {
    const moved = applyChanges(file, [
      { path: ["dragons", "kiro-B", "model"], remove: true },
      { path: ["dragons", "kiro-B", "adapter"], remove: true },
      { path: ["dragons", "kiro-B", "profile"], value: "kiro-cheap" },
    ]);
    onlyLine(moved, kiroB, "  kiro-B: { id: kiro-B, name: Glaurung, machine: mac, profile: kiro-cheap }    # reviews");
    // The first key of a padded flow map
    onlyLine(applyChanges(file, [{ path: ["dragons", "kiro-A", "id"], remove: true }]), "{ id: kiro-A, name: Smaug", "{ name: Smaug");
  });

  it("a key removed from a block map takes its own line, aligned comment included", () => {
    const out = applyChanges(file, [{ path: ["watchdog", "enabled"], remove: true }]);
    expect(out).toBe(file.replace("  enabled: true          # on\n", ""));
    expect(lineDiff(file, out)).toMatchObject({ added: 0, removed: 1 });
  });

  it("a new key, and a new agent among flow-map siblings (written like them), each add one line", () => {
    const key = applyChanges(file, [{ path: ["watchdog", "command_timeout_seconds"], value: 30 }]);
    expect(key).toBe(file.replace("  mode: 'observe'\n", "  mode: 'observe'\n  command_timeout_seconds: 30\n"));
    const agent = applyChanges(file, [{ path: ["dragons", "kiro-D"], value: { name: "Fafnir", profile: "kiro-cheap" } }]);
    expect(agent).toBe(file.replace("  }\nmachines:", "  }\n  kiro-D: { name: Fafnir, profile: kiro-cheap }\nmachines:"));
    expect(lineDiff(file, agent)).toMatchObject({ added: 1, removed: 0 });
  });

  it("a change it can't make in place (a list that grows) writes the file from its nodes, its flow maps still padded", () => {
    const out = applyChanges(file, [{ path: ["machines", "mac", "runners"], value: ["heavy", "light", "gpu"] }]);
    expect(parseYaml(out)).toEqual({ ...parseYaml(file), machines: { mac: { type: "local", runners: ["heavy", "light", "gpu"] } } });
    expect(out).toContain("kiro-B: { id: kiro-B, name: Glaurung,");
    expect(out).toContain("# The agents, one line each");
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

  it("hides secrets in messages, and finds those in comments", () => {
    const token = ["ghp", "_", "S".repeat(36)].join("");
    expect(redactSecrets(`received '${token}'`)).toBe("received '[hidden]'");
    expect(redactSecrets("received 'plain-value'", ["plain-value"])).toBe("received '[hidden]'");
    const text = [`a: 1`, `  # old: ${token}`, `b: "x #y"`, `url: "https://example.com/#frag"`, `c: 2 # ${token}`].join("\n");
    expect(commentSecrets(text)).toEqual([
      { line: 2, why: "a comment looks like a GitHub token" },
      { line: 5, why: "a comment looks like a GitHub token" },
    ]);
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
