/**
 * AI profiles, roles and tools (docs/design/ai-roles.md, A6-1), through the
 * production code: project files parsed by parseProjectConfig, the dragon
 * registry, the agents module's failover, the review config, the tools
 * service, the real routes behind the real HumanAuth, and the real agents
 * module with the real Decision Inbox. Only the boundaries are fake: the
 * command runner (the tools' own commands, and ssh to a remote machine),
 * the process spawner and table, and the clock. PATH lookups read real files
 * in a temporary directory.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseYaml, stringify } from "yaml";
import type { AgentAdapter, ProjectConfig } from "../../shared/types.js";
import type { AiModelsView, AiToolsView } from "../../shared/ai-types.js";
import { loadProjectConfig, parseProjectConfig } from "../config.js";
import { parseDragonRegistry } from "../parsers/dragon-config.js";
import { mergeDragonRegistry } from "../services/dragon-registry.js";
import { BUILTIN_ADAPTERS, buildStartCommand, validateAdapter } from "../services/adapters.js";
import { parseAgentsConfig } from "../agents/config.js";
import { profilesFor } from "../agents/failover.js";
import { AgentsManager } from "../agents/service.js";
import { parseReviewConfig } from "../review/config.js";
import { FakeProcessTable, FakeSpawner, NoCommands, SharedClock } from "../review/testing/agent-fakes.js";
import { NodeFileSystem } from "../watchdog/probes.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { OWNER_ONLY_PREFIXES, isUnder } from "../human-auth/cors.js";
import { mountDecisions } from "../decisions/index.js";
import { commandArgvProblem, validateAiConfig } from "./config.js";
import { MAX_MODELS, parseKiroModels, parseLineModels } from "./parsers.js";
import { AiError, AiToolsService, signInFrom } from "./tools.js";
import { registerAiRoutes } from "./routes.js";
import type { ToolRunner, ToolRunOptions, ToolRunOutput } from "./runner.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const iso = (ms: number) => new Date(ms).toISOString();
const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A directory of executable files with these names: a PATH on which they are installed. */
function binWith(...programs: string[]): string {
  const dir = tempDir("lair-ai-bin-");
  for (const program of programs) {
    writeFileSync(join(dir, program), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, program), 0o755);
  }
  return dir;
}

/** The command runner: what the tools' commands (and ssh) answer. Unanswered: the program is not installed. */
class FakeRunner implements ToolRunner {
  calls: { argv: string[]; options: ToolRunOptions }[] = [];
  constructor(public answer: (argv: string[]) => ToolRunOutput | Promise<ToolRunOutput> | undefined = () => undefined) {}
  async run(argv: string[], options: ToolRunOptions): Promise<ToolRunOutput> {
    this.calls.push({ argv: [...argv], options });
    const answered = await this.answer(argv);
    return answered ?? { code: -1, stdout: "", stderr: "", failure: "not_found", message: `spawn ${argv[0]} ENOENT` };
  }
  commands(): string[] {
    return this.calls.map((c) => c.argv.join(" "));
  }
}

const out = (stdout: string, code = 0, stderr = ""): ToolRunOutput => ({ code, stdout, stderr });

/**
 * What a real `kiro-cli whoami` prints (a made-up organisation, profile and
 * account): none of it may reach the API, the dashboard or a decision.
 */
const WHOAMI_SIGNED_IN =
  "Logged in with IAM Identity Center (https://example-org.awsapps.com/start/)\n" +
  "Profile: arn:aws:codewhisperer:us-east-1:123456789012:profile/EXAMPLEPROFILE\n";
const WHOAMI_SIGNED_OUT =
  "Not logged in. Sign in again at https://example-org.awsapps.com/start/ " +
  "(profile arn:aws:codewhisperer:us-east-1:123456789012:profile/EXAMPLEPROFILE)\n";
/** What must never be shown: the portal, the ARN, the account id */
const PRIVATE = ["awsapps", "example-org", "arn:", "123456789012", "EXAMPLEPROFILE", "https://"];
const leaks = (text: string) => PRIVATE.filter((p) => text.includes(p));

const TEST_CLI: AgentAdapter = {
  id: "test-cli",
  name: "Test CLI",
  start_cmd: "agent-cli run --agent {agent_id} --model {model} --prompt {prompt_file}",
  stop_cmd: "kill -TERM {pid}",
  status_method: "file",
  log_dir: "logs",
};

const AI = {
  profiles: {
    "kiro-opus": { tool: "kiro", model: "claude-opus-4.5" },
    "kiro-cheap": { tool: "kiro", model: "claude-haiku-4.5", options: { args: ["--effort", "low"] } },
    other: { tool: "test-cli", model: "model-x" },
  },
  roles: {
    build: ["kiro-opus", "kiro-cheap"],
    plan: ["other"],
    review: { amber: ["other", "kiro-cheap"] },
  },
};

/** A project file's text: the required keys, the test adapter, and `extra`. */
function projectYaml(dir: string, extra: Record<string, unknown>): string {
  return stringify({
    name: "Demo",
    repo: dir,
    github: "example/demo",
    queue_file: join(dir, "queue.md"),
    agents_dir: join(dir, "agents"),
    gates_dir: join(dir, "gates"),
    machines: {},
    agent_adapters: { "test-cli": TEST_CLI },
    ...extra,
  });
}

/** The project as Lair loads it (parseProjectConfig: the AI keys are validated there). */
function load(dir: string, extra: Record<string, unknown> = {}): ProjectConfig {
  return parseProjectConfig(projectYaml(dir, extra), "demo", join(dir, "demo.yaml"));
}

/** Why the project doesn't load ("" when it does). */
function refusal(dir: string, extra: Record<string, unknown>): string {
  try {
    load(dir, extra);
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function settingsOf(config: ProjectConfig, agents: Record<string, unknown> = { enabled: true }) {
  const parsed = parseAgentsConfig(agents, config);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.settings;
}

// ============ 1. CONFIG ============

describe("the ai: block and the keys it adds are checked when the project loads", () => {
  it("loads a project with profiles, roles, a dragon on a profile and an adapter's model and sign-in commands", () => {
    const dir = tempDir("lair-ai-");
    const config = load(dir, {
      ai: AI,
      dragons: { builder: { name: "Builder", profile: "kiro-opus" } },
      agent_adapters: {
        "test-cli": {
          ...TEST_CLI,
          models_cmd: ["agent-cli", "models"],
          models_parser: "lines",
          models: [{ id: "model-x", label: "Model X", default: true }],
          auth_check_cmd: ["agent-cli", "whoami"],
          login_hint: "agent-cli login",
          version_cmd: ["agent-cli", "--version"],
          experimental: true,
        },
      },
    });
    expect(validateAiConfig(config)).toEqual([]);
  });

  it("refuses unknown tools and profiles, a profile next to an adapter or model, and placeholders, with each key's path", () => {
    const dir = tempDir("lair-ai-");
    const message = refusal(dir, {
      agent_adapters: {
        "test-cli": TEST_CLI,
        "my-cli": { ...TEST_CLI, id: "my-cli", models_cmd: ["my-cli", "{model}"], models_parser: "xml", login_hint: "a\nb" },
      },
      ai: {
        profiles: {
          good: { tool: "kiro", model: "auto" },
          bad: { tool: "nope", model: "m" },
          argy: { tool: "kiro", model: "auto", options: { args: ["--model={model}"] } },
        },
        roles: { build: ["good", "good"], review: { amber: ["good", "ghost"] } },
      },
      dragons: {
        "worker-a": { name: "A", profile: "ghost" },
        "worker-b": { name: "B", profile: "good", model: "model-b" },
      },
    });
    expect(message).toMatch(/^Invalid project config demo: /);
    for (const expected of [
      "ai.profiles.bad.tool: unknown tool nope (built in: kiro, aider, claude-code, cursor-agent, codex, gemini, opencode, goose, copilot; or define it in agent_adapters)",
      "ai.profiles.argy.options.args[0]: a literal argument, with no {placeholder} and no control characters",
      "ai.roles.build[1]: profile good is listed twice",
      "ai.roles.review.amber[1]: unknown profile ghost (not in ai.profiles)",
      "dragons.worker-a.profile: unknown profile ghost (not in ai.profiles)",
      "dragons.worker-b.profile: name a profile, or an adapter and a model, not both",
      "agent_adapters.my-cli.models_cmd: [1] has a placeholder: the command is run as written, so none is allowed",
      "agent_adapters.my-cli.models_parser: kiro or lines",
      "agent_adapters.my-cli.login_hint: one line of at most 200 characters",
    ]) {
      expect(message).toContain(expected);
    }
    // The zod shape: bad ids and unknown keys, with their paths
    expect(refusal(dir, { ai: { profiles: { "1bad": { tool: "kiro", model: "auto" } }, extra: true } })).toContain(
      "ai.profiles.1bad: profile ids",
    );
    expect(refusal(dir, { ai: { profiles: { p: { tool: "kiro", model: "-rf" } } } })).toContain("ai.profiles.p.model: a model id");
    // Nothing new: nothing to say
    expect(validateAiConfig(load(dir, { dragons: { a: { name: "A", adapter: "kiro", model: "auto" } } }))).toEqual([]);
  });

  it("refuses a review role no dragon runs while reviews by agents are on", () => {
    const dir = tempDir("lair-ai-");
    const ai = { profiles: { rv: { tool: "kiro", model: "auto" }, other: { tool: "test-cli", model: "model-x" } }, roles: { review: { amber: ["rv"] } } };
    const agentReviews = { enabled: true, prompt_file: "review-prompt.md" };
    expect(refusal(dir, { ai, review: agentReviews, dragons: { a: { name: "A", adapter: "kiro", model: "auto" } } })).toContain(
      "ai.roles.review.amber: no dragon runs this profile (rv), and reviews by agents are on (review.prompt_file): give a reviewer dragon profile: rv",
    );
    // A dragon on it, reviews by agents off, or the build role's first profile (a dragons.txt dragon runs it): loads
    expect(refusal(dir, { ai, review: agentReviews, dragons: { r: { name: "R", profile: "rv" } } })).toBe("");
    expect(refusal(dir, { ai, review: { enabled: true }, dragons: {} })).toBe("");
    expect(refusal(dir, { ai: { ...ai, roles: { build: ["rv"], review: { amber: ["rv"] } } }, review: agentReviews })).toBe("");
  });

  it("loads the documented example: a dragon on its profile, one on its role's, and the role's failover", () => {
    const doc = readFileSync(new URL("../../../docs/configuration.md", import.meta.url), "utf-8");
    const section = doc.slice(doc.indexOf("## AI tools, profiles and roles"));
    const start = section.indexOf("```yaml") + "```yaml".length;
    const example = parseYaml(section.slice(start, section.indexOf("```", start))) as Record<string, unknown>;
    const config = load(tempDir("lair-ai-"), example);
    const registry = parseDragonRegistry(config);
    expect(registry.get("rev-1")).toMatchObject({ adapter: "claude-code", model: "opus", profile: "claude-best" });
    expect(registry.get("kiro-B")).toMatchObject({ adapter: "kiro", model: "claude-opus-4.5", profile: "kiro-opus" });
    expect(profilesFor(config, settingsOf(config), "kiro-A").map((p) => p.model)).toEqual(["claude-opus-4.5", "claude-haiku-4.5"]);
    expect(profilesFor(config, settingsOf(config), "rev-1")).toEqual([
      { adapter: "claude-code", model: "opus", provider: "claude-code", profile: "claude-best", args: ["--verbose"] },
    ]);
  });

  it("checks that a review pool's role:<role> names a role the project sets, and gives a tier without a pool its review role", () => {
    const github = "example/demo";
    const unset = parseReviewConfig({ reviewers_pool: { amber: "role:review.amber" } }, { github });
    expect(unset.ok).toBe(false);
    expect(!unset.ok && unset.errors).toEqual([
      "review.reviewers_pool.amber: role:review.amber names a role the project doesn't set (ai.roles.review.amber)",
    ]);
    const typo = parseReviewConfig({ reviewers_pool: { amber: ["role:review.blue"] } }, { github });
    expect(!typo.ok && typo.errors.join("; ")).toContain("review.reviewers_pool.amber.0: agent ids");

    const ai = { profiles: { p: { tool: "kiro", model: "auto" } }, roles: { review: { amber: ["p"] } } };
    const set = parseReviewConfig({ reviewers_pool: { red: ["rev-b"] } }, { github, ai });
    if (!set.ok) throw new Error(set.errors.join("; "));
    // red keeps its own pool; amber takes its role; green has neither
    expect(set.settings.agentReviews.pools).toEqual({ red: ["rev-b"], amber: ["role:review.amber"] });
    const slot = parseReviewConfig(
      { reviewers: { amber: [{ any_of: ["peer"], pool: ["role:review.amber", "rev-b"] }] } },
      { github, ai },
    );
    if (!slot.ok) throw new Error(slot.errors.join("; "));
    expect(slot.settings.reviewers.amber[0].pool).toEqual(["role:review.amber", "rev-b"]);
  });
});

// ============ 2. RESOLUTION ============

describe("a dragon runs on its profile, its adapter and model, or its role's first profile", () => {
  function project(dir: string, extra: Record<string, unknown> = {}): ProjectConfig {
    return load(dir, {
      ai: AI,
      dragon_defaults: { model: "default-model", adapter: "test-cli" },
      dragons: {
        builder: { name: "Builder", profile: "kiro-opus" },
        classic: { name: "Classic", adapter: "test-cli", model: "model-a" },
        halfway: { name: "Halfway", model: "model-h" },
        plain: { name: "Plain" },
        planner: { name: "Planner" },
        cheap: { name: "Cheap", profile: "kiro-cheap" },
      },
      planner: { agent: { id: "planner" } },
      ...extra,
    });
  }

  it("resolves each dragon's tool and model, and dragons.txt dragons too", () => {
    const dir = tempDir("lair-ai-");
    const config = project(dir);
    const registry = parseDragonRegistry(config);
    expect(registry.get("builder")).toEqual({
      id: "builder",
      name: "Builder",
      model: "claude-opus-4.5",
      machine: "local",
      instructions: "",
      adapter: "kiro",
      profile: "kiro-opus",
    });
    // adapter + model: exactly as before profiles (dragon_defaults fills what it leaves out)
    expect(registry.get("classic")).toEqual({
      id: "classic",
      name: "Classic",
      model: "model-a",
      machine: "local",
      instructions: "",
      adapter: "test-cli",
    });
    expect(registry.get("halfway")).toEqual({
      id: "halfway",
      name: "Halfway",
      model: "model-h",
      machine: "local",
      instructions: "",
      adapter: "test-cli",
    });
    // Naming nothing: its role's first profile (ai.roles.build; ai.roles.plan for the planner agent)
    expect(registry.get("plain")).toMatchObject({ adapter: "kiro", model: "claude-opus-4.5", profile: "kiro-opus" });
    expect(registry.get("planner")).toMatchObject({ adapter: "test-cli", model: "model-x", profile: "other" });
    expect(mergeDragonRegistry(config, "txt-1\tTxt\tidle\n").get("txt-1")).toEqual({
      id: "txt-1",
      name: "Txt",
      model: "claude-opus-4.5",
      machine: "",
      instructions: "",
      adapter: "kiro",
      profile: "kiro-opus",
    });
  });

  it("fails over along its role: the profiles after its own, with their options; agents.fallbacks still wins", () => {
    const dir = tempDir("lair-ai-");
    const config = project(dir);
    const settings = settingsOf(config);
    expect(profilesFor(config, settings, "builder")).toEqual([
      { adapter: "kiro", model: "claude-opus-4.5", provider: "kiro", profile: "kiro-opus" },
      { adapter: "kiro", model: "claude-haiku-4.5", provider: "kiro", profile: "kiro-cheap", args: ["--effort", "low"] },
    ]);
    // The last of its role: no fallback
    expect(profilesFor(config, settings, "cheap")).toEqual([
      { adapter: "kiro", model: "claude-haiku-4.5", provider: "kiro", profile: "kiro-cheap", args: ["--effort", "low"] },
    ]);
    expect(profilesFor(config, settings, "planner")).toEqual([
      { adapter: "test-cli", model: "model-x", provider: "test-cli", profile: "other" },
    ]);
    // adapter + model: the same profile as before, nothing added
    expect(profilesFor(config, settings, "classic")).toStrictEqual([{ adapter: "test-cli", model: "model-a", provider: "test-cli" }]);

    const explicit = settingsOf(config, { enabled: true, fallbacks: { builder: [{ adapter: "test-cli", model: "model-z" }] } });
    expect(profilesFor(config, explicit, "builder")).toEqual([
      { adapter: "kiro", model: "claude-opus-4.5", provider: "kiro", profile: "kiro-opus" },
      { adapter: "test-cli", model: "model-z", provider: "test-cli" },
    ]);
  });

  it("names a dragon's tool by the adapter's key: an agent_adapters entry with another id keeps its own commands and checks", () => {
    const dir = tempDir("lair-ai-");
    const config = load(dir, {
      agent_adapters: { "test-cli": TEST_CLI, "kiro-custom": { ...TEST_CLI, id: "kiro", name: "My Kiro" } },
      dragons: { mine: { name: "Mine", adapter: "kiro-custom", model: "model-m" } },
    });
    expect(profilesFor(config, settingsOf(config), "mine")).toStrictEqual([
      { adapter: "kiro-custom", model: "model-m", provider: "kiro-custom" },
    ]);
    // Not the built-in kiro's sign-in check
    expect(new AiToolsService({ runner: new FakeRunner(), env: { PATH: binWith("agent-cli") } }).signInRefusal("kiro-custom", config)).toBeNull();
  });

  it("leaves a project without ai: exactly as it was", () => {
    const dir = tempDir("lair-ai-");
    const withDefaults = load(dir, {
      dragon_defaults: { model: "default-model" },
      dragons: { own: { name: "Own", adapter: "test-cli", model: "model-a" }, bare: { name: "Bare" } },
    });
    const registry = parseDragonRegistry(withDefaults);
    expect(registry.get("own")).toEqual({ id: "own", name: "Own", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" });
    expect(registry.get("bare")).toEqual({ id: "bare", name: "Bare", model: "default-model", machine: "local", instructions: "" });
    expect(registry.get("bare")!.adapter).toBeUndefined();
    const bare = parseDragonRegistry(load(dir, { dragons: { bare: { name: "Bare" } } })).get("bare");
    expect(bare).toEqual({ id: "bare", name: "Bare", model: "claude-sonnet-4", machine: "local", instructions: "" });
    expect(profilesFor(withDefaults, settingsOf(withDefaults), "own")).toStrictEqual([
      { adapter: "test-cli", model: "model-a", provider: "test-cli" },
    ]);
  });
});

// ============ 3. COMMAND SAFETY ============

describe("commands are argv arrays: no value becomes the program or an option", () => {
  it("adds a profile's options.args as literal arguments after the start command, before the resume flag", () => {
    const built = buildStartCommand(BUILTIN_ADAPTERS.kiro, {
      agentId: "worker",
      task: "t1",
      promptFile: "/tmp/prompt.txt",
      model: "claude-haiku-4.5",
      sessionId: "s-1",
      agentProfile: "worker",
      extraArgs: ["--effort", "low"],
    });
    expect(built.warnings).toEqual([]);
    expect(built.command).toEqual([
      "kiro-cli",
      "chat",
      "--no-interactive",
      "--trust-all-tools",
      "--agent",
      "worker",
      "--model",
      "claude-haiku-4.5",
      "/tmp/prompt.txt",
      "--effort",
      "low",
      "--resume-id",
      "s-1",
    ]);
  });

  it("refuses a placeholder value that would become an option, and a placeholder as the program", () => {
    const option = buildStartCommand(BUILTIN_ADAPTERS.kiro, {
      agentId: "worker",
      task: "t1",
      promptFile: "--config=/etc/other",
      model: "auto",
      agentProfile: "worker",
    });
    expect(option.warnings).toEqual(['Variable {prompt_file} would become an option: "--config=/etc/other"']);
    const program: AgentAdapter = {
      id: "programmed",
      name: "Programmed",
      start_cmd: "{model} run {prompt_file}",
      stop_cmd: "kill -TERM {pid}",
      status_method: "file",
      queue_file: "work/queue.md",
    };
    expect(buildStartCommand(program, { agentId: "w", task: "t", promptFile: "/tmp/p", model: "evil" }).warnings).toEqual([
      "The program can't come from a placeholder ({model})",
    ]);
    expect(validateAdapter(program).errors).toEqual(['The program of "{model} run {prompt_file}" can\'t come from a placeholder']);
    // Every preset passes
    for (const adapter of Object.values(BUILTIN_ADAPTERS)) expect(validateAdapter(adapter).errors).toEqual([]);
  });

  it("runs a tool's own commands as written: no placeholders, no option as the program, quoted for a remote shell", async () => {
    expect(commandArgvProblem(["kiro-cli", "chat", "--list-models"])).toBeNull();
    expect(commandArgvProblem(["my-cli", "{model}"])).toContain("placeholder");
    expect(commandArgvProblem(["--version"])).toBe("the program (the first element) can't start with '-'");
    expect(commandArgvProblem(["my-cli", "a\nb"])).toBe("[1] has a control character");
    expect(commandArgvProblem("my-cli models")).toBe("an argv: a list of strings, the program first");

    const dir = tempDir("lair-ai-");
    const config = load(dir, {
      machines: { build: { name: "Build", type: "ssh", host: "build.example", user: "dev", key: "/keys/build", runners: [] } },
      agent_adapters: {
        "test-cli": TEST_CLI,
        "my-cli": { ...TEST_CLI, id: "my-cli", models_cmd: ["my-cli", "list; touch it's"] },
      },
    });
    const runner = new FakeRunner((argv) => (argv[0] === "ssh" ? out("model-1\n") : undefined));
    const service = new AiToolsService({ runner, clock: new SharedClock(NOW), env: { PATH: "/nowhere" } });
    const models = await service.models(config, "my-cli", "build");
    expect(models).toMatchObject({ source: "cmd", machine: "build", models: [{ id: "model-1" }] });
    // ssh's own options come first; the remote command quotes every element, so the remote shell parses none of it
    expect(runner.calls[0].argv).toEqual([
      "ssh",
      "-i",
      "/keys/build",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=4",
      "dev@build.example",
      "'my-cli' 'list; touch it'\\''s'",
    ]);

    // A command that slipped past the config check is never run
    const unchecked = { ...config, agent_adapters: { bad: { ...TEST_CLI, id: "bad", models_cmd: ["-x", "{model}"] } } } as ProjectConfig;
    expect(await service.models(unchecked, "bad")).toEqual({ tool: "bad", machine: "local", models: [], source: "none", fetchedAt: null });
    expect(runner.calls).toHaveLength(1);
  });
});

// ============ 4. MODEL LISTS ============

/** `kiro-cli chat --list-models`, as the CLI prints it */
const KIRO_SAMPLE = [
  "* auto  1.00x credits  Models chosen…",
  "  claude-opus-4.5  2.20x credits  Claude Opus 4.5 model",
].join("\n");

describe("model lists", () => {
  it("reads kiro-cli chat --list-models: the default marked with *, the cost multiplier and the description", () => {
    expect(parseKiroModels(KIRO_SAMPLE)).toEqual([
      { id: "auto", label: "Models chosen…", notes: "1.00x credits", default: true },
      { id: "claude-opus-4.5", label: "Claude Opus 4.5 model", notes: "2.20x credits", default: false },
    ]);
    // Colours, a heading, a help line and an option-shaped line around it change nothing
    const noisy = [
      "Available models:",
      "",
      "\x1b[1;32m* \x1b[0mauto  1.00x credits  Models chosen…",
      "  claude-opus-4.5\t2.20x credits  Claude Opus 4.5 model\r",
      "  --help  Show help",
      "Press Enter to continue",
    ].join("\n");
    expect(parseKiroModels(noisy)).toEqual(parseKiroModels(KIRO_SAMPLE));
  });

  it("takes an indented * as the default too", () => {
    const indented = ["  * auto  1.00x credits  Models chosen…", "    claude-opus-4.5  2.20x credits  Claude Opus 4.5 model"].join("\n");
    expect(parseKiroModels(indented)).toEqual(parseKiroModels(KIRO_SAMPLE));
    expect(parseKiroModels(indented)[0]).toMatchObject({ id: "auto", default: true });
  });

  it("shows nothing of a list that could name an account: no URL or ARN as a model, none in a label", () => {
    const listed = parseKiroModels(
      [
        "* auto  1.00x credits  Chosen for https://example-org.awsapps.com/start/",
        "  arn:aws:bedrock:us-east-1:123456789012:model/x  1.00x credits  An ARN",
        "  https://example-org.awsapps.com/start  1.00x credits  A URL",
        "  claude-3-5-sonnet-20241022  1.00x credits  Account 123456789012",
      ].join("\n"),
    );
    // A dated model id stays as it is
    expect(listed.map((m) => m.id)).toEqual(["auto", "claude-3-5-sonnet-20241022"]);
    expect(listed.map((m) => m.label)).toEqual(["Chosen for", "Account"]);
    expect(leaks(JSON.stringify(listed))).toEqual([]);
    expect(leaks(JSON.stringify(parseLineModels("https://example-org.awsapps.com/x\nmodel-a Profile arn:aws:x:123456789012")))).toEqual([]);
  });

  it("is bounded: a huge line or a flood of lines reads quickly, to at most MAX_MODELS models", () => {
    const flood = Array.from({ length: 5000 }, (_, i) => `  model-${i}  1.00x credits  Model ${i}`).join("\n");
    const started = Date.now();
    expect(parseKiroModels(flood)).toHaveLength(MAX_MODELS);
    expect(parseKiroModels(`  ${"a".repeat(1_000_000)}  x`)).toEqual([]);
    expect(parseLineModels("x".repeat(2_000_000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reads one model per line for custom tools: the first word, a label after it, * for the default", () => {
    const output = [
      "# models",
      "",
      "anthropic/claude-sonnet-4-5",
      "* openai/gpt-5  GPT-5 by OpenAI",
      "--not-a-model",
      "anthropic/claude-sonnet-4-5",
    ].join("\n");
    expect(parseLineModels(output)).toEqual([
      { id: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5", notes: "", default: false },
      { id: "openai/gpt-5", label: "GPT-5 by OpenAI", notes: "", default: true },
    ]);
  });

  it("caches a tool's list for an hour, refreshes on request, shares one run, and falls back to the known list", async () => {
    const dir = tempDir("lair-ai-");
    const config = load(dir);
    const clock = new SharedClock(NOW);
    const runner = new FakeRunner((argv) => (argv.join(" ") === "kiro-cli chat --list-models" ? out(KIRO_SAMPLE) : undefined));
    const service = new AiToolsService({ runner, clock, env: { PATH: "/nowhere" } });
    const listed: AiModelsView = {
      tool: "kiro",
      machine: "local",
      models: [
        { id: "auto", label: "Models chosen…", notes: "1.00x credits", default: true },
        { id: "claude-opus-4.5", label: "Claude Opus 4.5 model", notes: "2.20x credits", default: false },
      ],
      source: "cmd",
      fetchedAt: iso(NOW),
    };
    expect(await service.models(config, "kiro")).toEqual(listed);
    clock.t = NOW + 59 * MIN;
    expect(await service.models(config, "kiro")).toEqual(listed);
    expect(runner.calls).toHaveLength(1);
    clock.t = NOW + 61 * MIN;
    expect((await service.models(config, "kiro")).fetchedAt).toBe(iso(NOW + 61 * MIN));
    expect(runner.calls).toHaveLength(2);
    // Refresh reads it again at once; two at the same time share one run
    const [a, b] = await Promise.all([
      service.models(config, "kiro", undefined, true),
      service.models(config, "kiro", "local", true),
    ]);
    expect(runner.calls).toHaveLength(3);
    expect(a).toEqual(b);
    expect(runner.calls.every((c) => c.options.timeoutMs > 0 && c.options.maxBytes > 0)).toBe(true);

    // A list command that fails: the preset's known list, with the reason (its category, never its output), read
    // again a minute later
    runner.answer = (argv) => (argv[0] === "kiro-cli" ? out("", 1, WHOAMI_SIGNED_OUT) : undefined);
    const failing = await service.models(config, "kiro", undefined, true);
    expect(failing).toMatchObject({
      source: "preset",
      fetchedAt: null,
      error: "`kiro-cli chat --list-models` gave no list: exit code 1",
    });
    expect(leaks(JSON.stringify(failing))).toEqual([]);
    expect(failing.models[0]).toEqual({ id: "auto", label: "Models chosen by task", notes: "", default: true });
    expect(failing.models.map((m) => m.id)).toContain("claude-opus-4.5");
    const calls = runner.calls.length;
    clock.t += 30 * SEC;
    await service.models(config, "kiro");
    expect(runner.calls).toHaveLength(calls);
    clock.t += 31 * SEC;
    await service.models(config, "kiro");
    expect(runner.calls).toHaveLength(calls + 1);

    // No list command: the known list, or nothing; neither runs anything
    const before = runner.calls.length;
    expect(await service.models(config, "claude-code")).toMatchObject({
      source: "preset",
      models: [{ id: "opus" }, { id: "sonnet" }, { id: "haiku" }],
    });
    expect(await service.models(config, "goose")).toEqual({ tool: "goose", machine: "local", models: [], source: "none", fetchedAt: null });
    expect(runner.calls).toHaveLength(before);
    // A list command whose program is missing, and no known list
    expect(await service.models(config, "opencode")).toEqual({
      tool: "opencode",
      machine: "local",
      models: [],
      source: "none",
      fetchedAt: null,
      error: "`opencode models` gave no list: not installed",
    });

    // An edited command is never answered from the old one's cache
    const edited = load(dir, { agent_adapters: { "test-cli": TEST_CLI, kiro: { ...BUILTIN_ADAPTERS.kiro, models_cmd: ["kiro-cli", "models"] } } });
    runner.answer = () => out(KIRO_SAMPLE);
    await service.models(edited, "kiro");
    expect(runner.calls[runner.calls.length - 1].argv).toEqual(["kiro-cli", "models"]);

    await expect(service.models(config, "no-such-tool")).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.models(config, "-x")).rejects.toBeInstanceOf(AiError);
    await expect(service.models(config, "kiro", "elsewhere")).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ============ 5. SIGN-IN AND INSTALLED STATE ============

describe("sign-in status: the tool's own check, never its token files", () => {
  it("maps a check's answer: exit 0 is signed in, a signed-out first line is signed out, anything else is unknown", () => {
    expect(signInFrom(out("Logged in with Builder ID\n"), "kiro-cli login")).toEqual({
      state: "signed_in",
      as: "Logged in with Builder ID",
      detail: "signed in (Logged in with Builder ID)",
      fix: "kiro-cli login",
    });
    expect(signInFrom(out("", 1, "error: Not logged in\n"), "kiro-cli login")).toEqual({
      state: "signed_out",
      as: null,
      detail: "not signed in",
      fix: "kiro-cli login",
    });
    expect(signInFrom(out("You are not signed in. Run login first.", 1), null).state).toBe("signed_out");
    // A failure that doesn't say so never stops the agents: its category only, never its output
    expect(signInFrom(out("", 2, "error: unrecognized subcommand 'whoami'"), null)).toEqual({
      state: "unknown",
      as: null,
      detail: "can't tell: the sign-in check failed (exit code 2)",
      fix: null,
    });
    expect(signInFrom({ code: -1, stdout: "", stderr: "", failure: "timeout", message: "no answer after 5 s" }, null)).toMatchObject({
      state: "unknown",
      detail: "can't tell: the sign-in check failed (timed out)",
    });
    expect(signInFrom(out("", 255, "ssh: connect to host build.example port 22: Connection refused"), null, true)).toMatchObject({
      state: "unknown",
      detail: "the machine didn't answer (ssh exit code 255)",
    });
    // A transient failure that mentions logging in on a later line is not "signed out"
    expect(signInFrom(out("", 1, "Error: the service did not answer\nplease log in again if this persists\n"), null).state).toBe("unknown");
  });

  it("never shows a check's own output: a known kind of sign-in at most, nothing of an account or organisation", () => {
    const signedIn = signInFrom(out(WHOAMI_SIGNED_IN), "kiro-cli login");
    expect(signedIn).toEqual({
      state: "signed_in",
      as: "Logged in with IAM Identity Center",
      detail: "signed in (Logged in with IAM Identity Center)",
      fix: "kiro-cli login",
    });
    // A sign-in line Lair doesn't know: signed in, and nothing of the line
    expect(signInFrom(out("Logged in as someone@example.com (account 123456789012)\n"), null)).toEqual({
      state: "signed_in",
      as: null,
      detail: "signed in",
      fix: null,
    });
    const signedOut = signInFrom(out("", 1, WHOAMI_SIGNED_OUT), "kiro-cli login");
    expect(signedOut).toEqual({ state: "signed_out", as: null, detail: "not signed in", fix: "kiro-cli login" });
    expect(leaks(JSON.stringify([signedIn, signedOut, signInFrom(out(WHOAMI_SIGNED_OUT, 3), null)]))).toEqual([]);
  });

  it("reports per tool and machine: installed, version and sign-in with the fix, in the agents' environment, cached briefly", async () => {
    const dir = tempDir("lair-ai-");
    const home = tempDir("lair-ai-home-");
    const bin = binWith("kiro-cli");
    const config = load(dir, {
      ai: AI,
      agents: { enabled: true, env_passthrough: ["TOOL_REGION"] },
      dragons: { builder: { name: "Builder", profile: "kiro-opus" } },
    });
    const clock = new SharedClock(NOW);
    const runner = new FakeRunner((argv) => {
      const command = argv.join(" ");
      if (command === "kiro-cli --version") return out("kiro-cli 1.20.0\n");
      if (command === "kiro-cli whoami") return out("", 1, "Not logged in\n");
      return undefined;
    });
    const env = { PATH: bin, HOME: home, TOOL_REGION: "eu", SECRET_TOKEN: "not-for-tools", LAIR_NODE_TOKEN: "not-for-tools" };
    const service = new AiToolsService({ runner, clock, env });
    const view: AiToolsView = await service.tools("demo", config);
    expect(view.project).toBe("demo");
    expect(view.tools.map((t) => t.id)).toEqual([
      "kiro",
      "aider",
      "claude-code",
      "cursor-agent",
      "codex",
      "gemini",
      "opencode",
      "goose",
      "copilot",
      "test-cli",
    ]);
    const kiro = view.tools.find((t) => t.id === "kiro")!;
    expect(kiro).toMatchObject({
      name: "Kiro CLI",
      experimental: false,
      program: "kiro-cli",
      signInCheck: true,
      modelsCmd: true,
      knownModels: 5,
      inUse: true,
    });
    expect(kiro.machines).toEqual([
      {
        machine: "local",
        installed: true,
        path: join(bin, "kiro-cli"),
        version: "kiro-cli 1.20.0",
        signIn: { state: "signed_out", as: null, detail: "not signed in", fix: "kiro-cli login" },
        checkedAt: iso(NOW),
      },
    ]);
    // A sign-in check gets 5 s; the version, only shown here, the usual 15 s
    expect(runner.calls.find((c) => c.argv[1] === "whoami")!.options.timeoutMs).toBe(5000);
    expect(runner.calls.find((c) => c.argv[1] === "--version")!.options.timeoutMs).toBe(15000);
    const claude = view.tools.find((t) => t.id === "claude-code")!;
    expect(claude).toMatchObject({ experimental: true, program: "claude", signInCheck: false, inUse: false });
    expect(claude.machines[0]).toEqual({
      machine: "local",
      installed: false,
      path: null,
      version: null,
      signIn: { state: "unknown", as: null, detail: "not installed: claude is not on PATH", fix: "claude, then /login" },
      checkedAt: iso(NOW),
    });
    // A profile names it (ai.profiles.other)
    expect(view.tools.find((t) => t.id === "test-cli")!.inUse).toBe(true);
    // Only the installed tool's commands ran, each in the environment an agent gets: no other variable of this server
    expect(runner.commands().sort()).toEqual(["kiro-cli --version", "kiro-cli whoami"]);
    for (const call of runner.calls) expect(call.options.env).toEqual({ PATH: bin, HOME: home, TOOL_REGION: "eu" });

    // Cached briefly
    await service.tools("demo", config);
    expect(runner.calls).toHaveLength(2);
    clock.t = NOW + 61 * SEC;
    runner.answer = (argv) => (argv[1] === "whoami" ? out("Logged in with Builder ID\n") : argv[1] === "--version" ? out("kiro-cli 1.20.0\n") : undefined);
    const later = await service.tools("demo", config);
    expect(runner.calls).toHaveLength(4);
    expect(later.tools[0].machines[0].signIn).toMatchObject({ state: "signed_in", as: "Logged in with Builder ID" });
  });

  it("checks a remote machine through ssh, only for the tools of the dragons that run there", async () => {
    const dir = tempDir("lair-ai-");
    const config = load(dir, {
      machines: {
        build: { name: "Build", type: "ssh", host: "build.example", user: "dev", key: "/keys/build", runners: [] },
        idle: { name: "Idle", type: "ssh", host: "idle.example", user: "dev", key: "/keys/idle", runners: [] },
      },
      dragons: { remote: { name: "Remote", adapter: "kiro", model: "auto", machine: "build" } },
    });
    const runner = new FakeRunner((argv) => {
      if (argv[0] !== "ssh") return undefined;
      const remote = argv[argv.length - 1];
      if (remote === "command -v 'kiro-cli'") return out("/home/dev/.local/bin/kiro-cli\n");
      if (remote === "'kiro-cli' '--version'") return out("kiro-cli 1.20.0\n");
      if (remote === "'kiro-cli' 'whoami'") return out("Logged in with Builder ID\n");
      return out("", 127, "command not found");
    });
    const service = new AiToolsService({ runner, clock: new SharedClock(NOW), env: { PATH: binWith() } });
    const view = await service.tools("demo", config);
    const kiro = view.tools.find((t) => t.id === "kiro")!;
    expect(kiro.machines.map((m) => [m.machine, m.installed, m.signIn.state])).toEqual([
      ["local", false, "unknown"],
      ["build", true, "signed_in"],
    ]);
    expect(kiro.machines[1]).toMatchObject({ path: "/home/dev/.local/bin/kiro-cli", version: "kiro-cli 1.20.0" });
    // No other tool is asked about on the build machine, and the idle machine is not asked at all
    expect(view.tools.filter((t) => t.id !== "kiro").every((t) => t.machines.map((m) => m.machine).join() === "local")).toBe(true);
    expect(view.notes).toEqual(["idle: no dragon runs there, so its tools were not checked"]);
    expect(runner.calls.every((c) => c.argv[0] === "ssh" && c.argv.includes("dev@build.example"))).toBe(true);
    expect(runner.calls).toHaveLength(3);
  });
});

// ============ 6. ROUTES ============

describe("the AI tools API is the owner's, reads included", () => {
  async function serve(
    answer: (argv: string[]) => ToolRunOutput | undefined = (argv) =>
      argv.join(" ") === "kiro-cli chat --list-models" ? out(KIRO_SAMPLE) : undefined,
    path = binWith(),
  ) {
    const root = tempDir("lair-ai-routes-");
    const projects = join(root, "projects");
    mkdirSync(projects);
    writeFileSync(join(projects, "demo.yaml"), projectYaml(root, {}));
    const tokenPath = join(root, "data", "owner.token");
    const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
    const runner = new FakeRunner(answer);
    const clock = new SharedClock(NOW);
    const service = new AiToolsService({ runner, clock, env: { PATH: path } });
    const app: FastifyInstance = Fastify({ logger: false });
    await registerOwnerRoutes(app, auth);
    await registerAiRoutes(app, {
      service,
      auth,
      defaultProject: () => "demo",
      config: (project) => loadProjectConfig(project, projects),
      projectsDir: projects,
    });
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      auth.close();
    });
    const owner = { ...BROWSER, [OWNER_SESSION_HEADER]: auth.createSession(readFileSync(tokenPath, "utf-8").trim())!.session };
    return { app, runner, owner, clock };
  }

  it("answers 403 to no session, a browser not signed in and an invalid session, and runs nothing", async () => {
    const { app, runner, owner } = await serve();
    const routes: ["GET" | "POST", string, unknown?][] = [
      ["GET", "/api/ai/tools?project=demo"],
      ["POST", "/api/ai/tools/refresh", { project: "demo" }],
      ["GET", "/api/ai/models?tool=kiro&project=demo"],
      ["POST", "/api/ai/models/refresh", { tool: "kiro", project: "demo" }],
    ];
    const strangers: [string, Record<string, string>][] = [
      ["no session", {}],
      ["a browser not signed in", BROWSER],
      ["an invalid session", { ...BROWSER, [OWNER_SESSION_HEADER]: "x".repeat(43) }],
    ];
    for (const [method, url, payload] of routes) {
      expect(isUnder(url, OWNER_ONLY_PREFIXES), url).toBe(true);
      for (const [who, headers] of strangers) {
        const res = await app.inject({ method, url, headers, payload: payload as Record<string, unknown> | undefined });
        expect(res.statusCode, `${method} ${url}: ${who}`).toBe(403);
      }
    }
    expect(runner.calls).toEqual([]);

    // The owner
    const tools = await app.inject({ url: "/api/ai/tools?project=demo", headers: owner });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().data.tools.map((t: { id: string }) => t.id)).toContain("codex");
    const models = await app.inject({ url: "/api/ai/models?tool=kiro", headers: owner });
    expect(models.statusCode).toBe(200);
    expect(models.json().data).toMatchObject({ tool: "kiro", source: "cmd", fetchedAt: iso(NOW) });
    const refreshed = await app.inject({ method: "POST", url: "/api/ai/models/refresh", headers: owner, payload: { tool: "kiro" } });
    expect(refreshed.statusCode).toBe(200);
    expect(runner.commands().filter((c) => c === "kiro-cli chat --list-models")).toHaveLength(2);

    expect((await app.inject({ url: "/api/ai/models?tool=nope", headers: owner })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/ai/models?tool=-x", headers: owner })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/ai/tools?project=../etc", headers: owner })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/ai/tools?project=other", headers: owner })).statusCode).toBe(400);
  });

  it("Refresh (Settings → AI) checks again: a tool signed in since the last check shows signed in", async () => {
    let signedIn = false;
    const { app, runner, owner, clock } = await serve((argv) => {
      if (argv.join(" ") !== "kiro-cli whoami") return undefined;
      return signedIn ? out("Logged in with Builder ID\n") : out("Not logged in\n", 1);
    }, binWith("kiro-cli"));
    const kiro = (body: string): string =>
      JSON.parse(body).data.tools.find((t: { id: string }) => t.id === "kiro").machines[0].signIn.state;
    const refresh = () => app.inject({ method: "POST", url: "/api/ai/tools/refresh", headers: owner, payload: { project: "demo" } });
    const whoamis = () => runner.commands().filter((c) => c === "kiro-cli whoami").length;
    expect(kiro((await app.inject({ url: "/api/ai/tools?project=demo", headers: owner })).body)).toBe("signed_out");
    signedIn = true;
    // Within the minute: the last check's answer
    expect(kiro((await app.inject({ url: "/api/ai/tools?project=demo", headers: owner })).body)).toBe("signed_out");
    // A refresh within 5 seconds of the last check answers from it, however often it is asked: no check runs
    const soon = await Promise.all([refresh(), refresh(), refresh()]);
    expect(soon.map((r) => [r.statusCode, kiro(r.body)])).toEqual([
      [200, "signed_out"],
      [200, "signed_out"],
      [200, "signed_out"],
    ]);
    expect(whoamis()).toBe(1);
    clock.advance(5_000);
    // Then it checks again, once for refreshes that come together
    const later = await Promise.all([refresh(), refresh()]);
    expect(later.map((r) => kiro(r.body))).toEqual(["signed_in", "signed_in"]);
    expect(whoamis()).toBe(2);
    expect((await app.inject({ method: "POST", url: "/api/ai/tools/refresh", headers: owner, payload: { project: "../etc" } })).statusCode).toBe(400);
  });

  it("never answers with a tool's own output: the sign-in portal, profile ARN and account stay out", async () => {
    const { app, owner } = await serve((argv) => {
      const command = argv.join(" ");
      if (command === "kiro-cli whoami") return out(WHOAMI_SIGNED_IN);
      if (command === "kiro-cli --version") return out("kiro-cli 1.20.0 https://example-org.awsapps.com/start/ 123456789012\n");
      if (command === "kiro-cli chat --list-models") return out("", 1, WHOAMI_SIGNED_OUT);
      return undefined;
    }, binWith("kiro-cli"));
    const tools = await app.inject({ url: "/api/ai/tools?project=demo", headers: owner });
    expect(tools.statusCode).toBe(200);
    const kiro = tools.json().data.tools.find((t: { id: string }) => t.id === "kiro");
    expect(kiro.machines[0]).toMatchObject({
      installed: true,
      version: "kiro-cli 1.20.0",
      signIn: { state: "signed_in", as: "Logged in with IAM Identity Center", detail: "signed in (Logged in with IAM Identity Center)" },
    });
    expect(leaks(tools.body)).toEqual([]);
    const models = await app.inject({ url: "/api/ai/models?tool=kiro", headers: owner });
    expect(models.json().data).toMatchObject({ source: "preset", error: "`kiro-cli chat --list-models` gave no list: exit code 1" });
    expect(leaks(models.body)).toEqual([]);
  });
});

// ============ 7. THE AGENTS MODULE REFUSES STARTS ON A SIGNED-OUT TOOL ============

describe("a tool signed out on this machine starts no run here", () => {
  /** The agents module and the Decision Inbox as the server wires them, with the tools service over `answer` */
  async function agentsWith(answer: (argv: string[]) => ToolRunOutput | Promise<ToolRunOutput> | undefined) {
    const dir = tempDir("lair-ai-agents-");
    mkdirSync(join(dir, "agents"));
    mkdirSync(join(dir, "gates"));
    writeFileSync(join(dir, "queue.md"), "# Queue\n");
    const config = load(dir, {
      inbox_file: join(dir, "inbox.md"),
      prompts_dir: join(dir, "prompts"),
      dragons: {
        "worker-a": { name: "A", adapter: "kiro", model: "claude-opus-4.5" },
        "worker-b": { name: "B", adapter: "kiro", model: "claude-opus-4.5" },
        "worker-c": { name: "C", adapter: "test-cli", model: "model-c" },
        "worker-f": { name: "F", adapter: "kiro", model: "claude-opus-4.5" },
      },
      agents: {
        enabled: true,
        interval_seconds: 1,
        // worker-f can run on another tool
        fallbacks: { "worker-f": [{ adapter: "test-cli", model: "model-f" }] },
      },
    });
    const clock = new SharedClock(NOW);
    const runner = new FakeRunner(answer);
    const tools = new AiToolsService({ runner, clock, env: { PATH: binWith("kiro-cli"), HOME: dir } });
    const procs = new FakeProcessTable(clock);
    const spawner = new FakeSpawner(procs, clock);
    const agents = new AgentsManager({
      dbPath: join(dir, "data", "agents.db"),
      probes: { processes: procs, fs: new NodeFileSystem(), runner: new NoCommands(), clock, spawner, self: { pid: 100, startedAt: NOW - 60 * MIN }, systemInfo: { cpuCount: () => 4, loadAvg1: () => 0.5, totalMemory: () => 16e9, memory: async () => ({ available: 8e9 }) } },
      tools,
    });
    agents.load([{ name: "demo", config }]);
    const app = Fastify();
    const tokenPath = join(dir, "data", "owner.token");
    const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
    const inbox = await mountDecisions(app, { dbPath: ":memory:", humanAuth: auth, defaultProject: () => "demo", clock, producers: [agents] });
    cleanups.push(async () => {
      await agents.stop();
      await app.close();
      auth.close();
    });
    const service = agents.get("demo");
    const store = agents.getStore();
    if (!service || !store) throw new Error(agents.status("demo").errors.join("; "));
    const owner = { ...BROWSER, [OWNER_SESSION_HEADER]: auth.createSession(readFileSync(tokenPath, "utf-8").trim())!.session };
    const request = async (...agentIds: string[]) => {
      const ids: Record<string, string> = {};
      for (const agent of agentIds) ids[agent] = (await service.requestRun({ agent, task: `task-${agent}`, prompt: "Do the task" })).id;
      return ids;
    };
    const signInDecisions = () => inbox.list({ project: "demo" }).filter((d) => d.key === "signin:kiro:local");
    const whoamis = () => runner.commands().filter((c) => c === "kiro-cli whoami").length;
    /** Move the clock on, tick, and let the sign-in checks it started finish */
    const at = async (ms: number) => {
      clock.t = NOW + ms;
      await service.tick();
      await tools.idle();
    };
    return { app, owner, clock, runner, tools, spawner, service, store, inbox, request, signInDecisions, whoamis, at };
  }

  it("holds every run on it with the fix, raises one decision for the project, and starts them once signed in", async () => {
    let signedIn = false;
    const h = await agentsWith((argv) => {
      const command = argv.join(" ");
      if (command === "kiro-cli whoami") return signedIn ? out(WHOAMI_SIGNED_IN) : out("", 1, WHOAMI_SIGNED_OUT);
      return undefined;
    });
    const runs = await h.request("worker-a", "worker-b", "worker-c", "worker-f");
    // The requests started the check in the background: one for the tool, not one per run
    await h.tools.idle();
    expect(h.whoamis()).toBe(1);

    await h.at(0);
    // The runs on kiro wait, saying why and what to run; the run on another tool, and the one with a fallback on it, start
    expect(h.spawner.calls.map((c) => [c.env.LAIR_AGENT, c.argv[0]]).sort()).toEqual([
      ["worker-c", "agent-cli"],
      ["worker-f", "agent-cli"],
    ]);
    for (const agent of ["worker-a", "worker-b"]) {
      const run = h.store.getRun(runs[agent])!;
      expect(run.state).toBe("queued");
      expect(run.detail).toContain("Kiro CLI (kiro) is not signed in on this machine: run `kiro-cli login` in a terminal on it");
      expect(leaks(run.detail)).toEqual([]);
    }
    expect(h.store.getRun(runs["worker-f"])!.profile).toMatchObject({ adapter: "test-cli", model: "model-f" });
    // One decision for the tool, not one per agent or run, and never "every profile is failing"
    const [decision] = h.signInDecisions();
    expect(h.signInDecisions()).toHaveLength(1);
    expect(decision).toMatchObject({ status: "open", kind: "other", source: { module: "agents", ref: "signin:kiro" } });
    expect(decision.title).toBe("Kiro CLI is not signed in on this machine: Lair starts no agent on it here");
    expect(decision.context).toContain("Its sign-in check (`kiro-cli whoami`) says it is not signed in on this machine.");
    expect(decision.context).toContain("run `kiro-cli login` in a terminal on this machine");
    expect(decision.context).toContain("worker-a on task-worker-a");
    // Nothing of the check's output: not the portal, the ARN or the account
    expect(leaks(JSON.stringify(h.inbox.list({ project: "demo" })))).toEqual([]);
    expect(h.inbox.list({ project: "demo" }).filter((d) => d.key.startsWith("exhausted:"))).toEqual([]);
    // The agents module runs the sign-in check alone, with its own 5 s; never the version
    expect(h.runner.commands().some((c) => c.includes("--version"))).toBe(false);
    expect(h.runner.calls.every((c) => c.options.timeoutMs === 5000)).toBe(true);

    // Looked at again 30 s later: the next check starts while the last answer still stands
    await h.at(31 * SEC);
    expect(h.spawner.calls).toHaveLength(2);
    expect(h.whoamis()).toBe(2);
    expect(h.inbox.list({ project: "demo" }).filter((d) => d.source.module === "agents")).toHaveLength(1);

    // Signed in: once a check after it has answered they start, and the decision is withdrawn
    signedIn = true;
    await h.at(62 * SEC);
    await h.at(93 * SEC);
    expect(h.spawner.calls.slice(2).map((c) => [c.env.LAIR_AGENT, c.argv[0]]).sort()).toEqual([
      ["worker-a", "kiro-cli"],
      ["worker-b", "kiro-cli"],
    ]);
    expect(h.signInDecisions()).toHaveLength(1);
    expect(h.signInDecisions()[0].status).toBe("withdrawn");
  });

  it("is not asked again after Keep waiting, while it stays signed out", async () => {
    const h = await agentsWith((argv) => (argv.join(" ") === "kiro-cli whoami" ? out("", 1, "Not logged in\n") : undefined));
    await h.request("worker-a");
    await h.tools.idle();
    await h.at(0);
    const [decision] = h.signInDecisions();
    const answered = await h.app.inject({
      method: "POST",
      url: `/api/decisions/${decision.id}/answer`,
      headers: h.owner,
      payload: { optionId: "wait" },
    });
    expect(answered.statusCode).toBe(200);
    for (const ms of [31 * SEC, 62 * SEC, 93 * SEC, 124 * SEC]) await h.at(ms);
    expect(h.whoamis()).toBeGreaterThanOrEqual(4);
    expect(h.spawner.calls).toHaveLength(0);
    // Still the one answered decision: no new one every minute
    expect(h.inbox.list({ project: "demo" }).filter((d) => d.source.module === "agents")).toEqual([
      expect.objectContaining({ key: "signin:kiro:local", status: "answered" }),
    ]);
  });

  it("never waits for a check: a hung sign-in check delays no tick, and a start with no answer yet goes ahead", async () => {
    // The check never answers (the runner's 5 s timeout is the boundary's; here it hangs for good)
    const h = await agentsWith((argv) => (argv.join(" ") === "kiro-cli whoami" ? new Promise<ToolRunOutput>(() => undefined) : undefined));
    await h.request("worker-a");
    // A tick that awaited the check would never resolve
    const ticked = await Promise.race([
      h.service.tick().then(() => "ticked"),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 2000)),
    ]);
    expect(ticked).toBe("ticked");
    // Unknown never holds a start
    expect(h.spawner.calls.map((c) => [c.env.LAIR_AGENT, c.argv[0]])).toEqual([["worker-a", "kiro-cli"]]);
    // One check, started by the request, with the 5 s timeout; the tick started no second one
    expect(h.runner.calls.map((c) => [c.argv.join(" "), c.options.timeoutMs])).toEqual([["kiro-cli whoami", 5000]]);
  });
});
