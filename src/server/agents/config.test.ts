/**
 * The `agents:` config block: defaults, validation, and the backoff rule.
 */
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ProjectConfig } from "../../shared/types.js";
import {
  backoffMs,
  DEFAULT_BLOCKED_PATTERN,
  DEFAULT_DONE_PATTERN,
  DEFAULT_WAITING_PATTERN,
  doneLineMatches,
  donePatternFor,
  parseAgentsConfig,
  taskLineMatch,
} from "./config.js";

const project = {
  name: "Demo",
  repo: "/home/user/project",
  github: "example/demo",
  queue_file: "/home/user/project/queue.md",
  agents_dir: "/home/user/project/agents",
  gates_dir: "/home/user/project/gates",
  machines: {},
  agent_adapters: {
    "other-cli": {
      id: "other-cli",
      name: "Other CLI",
      start_cmd: "other-cli --task-file {prompt_file}",
      stop_cmd: "kill -TERM {pid}",
      status_method: "file",
      log_dir: "logs",
    },
  },
} as ProjectConfig;

function errorsOf(raw: unknown): string[] {
  const parsed = parseAgentsConfig(raw, project);
  return parsed.ok ? [] : parsed.errors;
}

describe("agents config", () => {
  it("is off by default, with the documented defaults", () => {
    const parsed = parseAgentsConfig(undefined, project);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings).toMatchObject({
      enabled: false,
      intervalSeconds: 15,
      startTimeoutMinutes: 10,
      deadOnStartSeconds: 60,
      stopGraceSeconds: 30,
      recovery: { sameSessionRestarts: 2, freshSessions: 1, backoffSeconds: 30, maxBackoffSeconds: 1800 },
      retries: { maxRetries: 3, backoffSeconds: 60, maxBackoffSeconds: 3600 },
      failover: { silenceSeconds: 120, cooldownMinutes: 30, maxFailovers: 3 },
      envPassthrough: [],
      locks: [],
      fallbacks: {},
      budgets: { perAgent: {} },
    });
    expect(parsed.settings.hungMinutes).toBeUndefined();
    expect(parsed.settings.failover.rateLimit.length).toBeGreaterThan(0);
  });

  it("parses locks, fallbacks, providers and budgets", () => {
    const parsed = parseAgentsConfig(
      {
        enabled: true,
        locks: [{ name: "session-store", path: "/home/user/project/work/session.lock", hold: "run" }],
        env_passthrough: ["EXAMPLE_PROVIDER_KEY"],
        providers: { "other-cli": "provider-a" },
        fallbacks: { "worker-a": [{ adapter: "other-cli", model: "vendor/model-b", provider: "provider-b" }] },
        budgets: { agent: { daily_cost: { soft: 5, hard: 8 } }, per_agent: { "worker-a": { monthly_tokens: { hard: 1000000 } } } },
        usage_patterns: ["tokens: (?<tokens>\\d+)"],
      },
      project,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.locks).toEqual([
      {
        name: "session-store",
        path: "/home/user/project/work/session.lock",
        pidFile: "pid",
        hold: "run",
        staleMinutes: 30,
        breakWithoutWaiter: false,
      },
    ]);
    expect(parsed.settings.envPassthrough).toEqual(["EXAMPLE_PROVIDER_KEY"]);
    expect(parsed.settings.fallbacks["worker-a"]).toEqual([
      { adapter: "other-cli", model: "vendor/model-b", provider: "provider-b" },
    ]);
    expect(parsed.settings.budgets.perAgent["worker-a"]).toEqual({ monthly_tokens: { hard: 1000000 } });
    expect(parsed.settings.usagePatterns[0].flags).toBe("gi");
  });

  it("refuses unknown keys, bad patterns, unknown adapters and contradictory limits", () => {
    expect(errorsOf({ enabled: true, restart_forever: true })[0]).toContain("agents.(root)");
    expect(errorsOf({ failover: { rate_limit_patterns: ["(unclosed"] } })[0]).toContain(
      "agents.failover.rate_limit_patterns[0]: not a valid regular expression",
    );
    expect(errorsOf({ usage_patterns: ["tokens: \\d+"] })).toEqual([
      "agents.usage_patterns[0]: needs a named group (?<tokens>...) or (?<cost>...)",
    ]);
    expect(errorsOf({ fallbacks: { "worker-a": [{ adapter: "no-such-cli" }] } })).toEqual([
      "agents.fallbacks.worker-a[0]: unknown adapter no-such-cli",
    ]);
    expect(errorsOf({ budgets: { agent: { daily_cost: { soft: 9, hard: 8 } } } })).toEqual([
      "agents.budgets.agent.daily_cost: soft (9) is above hard (8)",
    ]);
    expect(errorsOf({ session_dir: "{home}/sessions" })[0]).toContain("unknown placeholder {home}");
    expect(
      errorsOf({ locks: [{ name: "a", path: "/home/user/x.lock" }, { name: "a", path: "/home/user/y.lock" }] }),
    ).toEqual(["agents.locks: duplicate lock name a"]);
    expect(errorsOf({ fallbacks: { "worker-a": [{ adapter: "other-cli", model: "-rf" }] } })[0]).toContain(
      "agents.fallbacks.worker-a.0.model",
    );
    expect(errorsOf({ env_passthrough: ["LAIR_NODE_TOKEN"] })).toEqual([
      "agents.env_passthrough: LAIR_NODE_TOKEN: LAIR_* variables are never passed to agents",
    ]);
    expect(errorsOf({ env_passthrough: ["NOT A NAME"] })[0]).toContain("agents.env_passthrough.0");
    // In any case: some environments treat variable names case-insensitively
    expect(errorsOf({ env_passthrough: ["lair_node_token"] })).toEqual([
      "agents.env_passthrough: lair_node_token: LAIR_* variables are never passed to agents",
    ]);
  });

  it("fill is off by default; enabled, it needs agents.enabled, tasks_file, an allowlist and prompt files", () => {
    const parsed = parseAgentsConfig(undefined, project);
    expect(parsed.ok && parsed.settings.fill).toEqual({
      enabled: false,
      tasksFile: undefined,
      agents: [],
      promptFiles: [],
      maxActive: 1,
      donePattern: DEFAULT_DONE_PATTERN,
      capacityCmd: undefined,
      intervalSeconds: 60,
      maxCompletionsWithoutDone: 3,
      backoffSeconds: 60,
      maxBackoffSeconds: 1800,
      waitingPattern: DEFAULT_WAITING_PATTERN,
      blockedPattern: DEFAULT_BLOCKED_PATTERN,
      wake: { file: undefined, root: "{gates_dir}", pollSeconds: 60, maxWaitMinutes: 240, fallbackSeconds: 900 },
    });
    expect(errorsOf({ fill: { enabled: true } })).toEqual([
      "agents.fill.enabled: fill needs agents.enabled: true",
      "agents.fill.tasks_file: required when fill is enabled",
      "agents.fill.agents: list the agents fill may start (required when fill is enabled)",
      "agents.fill.prompt_files: at least one prompt file is required when fill is enabled",
    ]);
  });

  it("fill: waiting_pattern and blocked_pattern need {task} and must compile; wake.file needs {wake} and stays put", () => {
    const fill = {
      enabled: true,
      tasks_file: "work/tasks.txt",
      agents: ["worker-a"],
      prompt_files: ["{prompts_dir}/{agent}.txt"],
      waiting_pattern: "^-\\s+WAITING\\s+{task}(?:\\s+(?<wake>\\d{8}T\\d{6}Z-\\S+))?(?=\\s|$)",
      wake: { file: "{gates_dir}/results/{wake}.rc", root: "{gates_dir}/results" },
    };
    const withFill = (extra: Record<string, unknown>) => ({ enabled: true, fill: { ...fill, ...extra } });
    expect(errorsOf(withFill({}))).toEqual([]);
    for (const key of ["waiting_pattern", "blocked_pattern"]) {
      expect(errorsOf(withFill({ [key]: "^- WAITING " }))).toEqual([
        `agents.fill.${key}: needs {task} (without it one ${key === "waiting_pattern" ? "waiting" : "blocked"} line would match every task)`,
      ]);
      expect(errorsOf(withFill({ [key]: "^- BLOCKED ({task}" }))[0]).toContain(`agents.fill.${key}: not a valid regular expression`);
      expect(errorsOf(withFill({ [key]: "^- BLOCKED {task} {gate}" }))[0]).toContain(`agents.fill.${key}: unknown placeholder {gate}`);
    }
    const wake = (extra: Record<string, unknown>) => withFill({ wake: { ...fill.wake, ...extra } });
    expect(errorsOf(wake({ file: "{gates_dir}/results/latest.rc" }))).toEqual([
      "agents.fill.wake.file: needs {wake} (what the waiting line names)",
    ]);
    expect(errorsOf(wake({ file: "{gates_dir}/../{wake}.rc" }))).toEqual(['agents.fill.wake.file: a ".." segment is refused']);
    expect(errorsOf(wake({ file: "{home}/{wake}.rc" }))[0]).toContain("agents.fill.wake.file: unknown placeholder {home}");
    expect(errorsOf(wake({ root: "{gates_dir}/.." }))).toEqual(['agents.fill.wake.root: a ".." segment is refused']);
    expect(errorsOf(wake({ root: "{wake}" }))[0]).toContain("agents.fill.wake.root: unknown placeholder {wake}");
    expect(errorsOf(wake({ poll_seconds: 0 }))[0]).toContain("agents.fill.wake.poll_seconds");
    expect(errorsOf(wake({ every: 1 }))[0]).toContain("agents.fill.wake");
  });

  it("the default waiting and blocked patterns: the task's own line, the task id exact", () => {
    const matches = (template: string, line: string, task = "feat-login") =>
      taskLineMatch(donePatternFor(template, task, "worker-a"), task, line) !== null;
    expect(matches(DEFAULT_WAITING_PATTERN, "- WAITING feat-login 20260101T000000Z-x-abcdef12-1 by worker-a: gate queued")).toBe(true);
    expect(matches(DEFAULT_WAITING_PATTERN, "  -  waiting feat-login")).toBe(true);
    expect(matches(DEFAULT_WAITING_PATTERN, "- WAITING feat-login-2 by worker-a")).toBe(false);
    expect(matches(DEFAULT_WAITING_PATTERN, "- WAITING feat:login by worker-a", "feat")).toBe(false);
    expect(matches(DEFAULT_BLOCKED_PATTERN, "- BLOCKED feat-login by worker-a: needs a key")).toBe(true);
    expect(matches(DEFAULT_BLOCKED_PATTERN, "- BLOCKED FEAT-LOGIN by worker-a")).toBe(false);
    expect(matches(DEFAULT_BLOCKED_PATTERN, "- DONE feat-login by worker-a")).toBe(false);
    // A capture names what the run waits on
    const gate = donePatternFor("^-\\s+WAITING\\s+{task}(?:\\s+(?<wake>\\d{8}T\\d{6}Z-\\S+))?(?=\\s|$)", "feat-login", "worker-a");
    expect(taskLineMatch(gate, "feat-login", "- WAITING feat-login 20260101T000000Z-x-abcdef12-1 by worker-a")?.groups?.wake).toBe(
      "20260101T000000Z-x-abcdef12-1",
    );
    expect(taskLineMatch(gate, "feat-login", "- WAITING feat-login by worker-a")?.groups?.wake).toBeUndefined();
  });

  it("fill: prompt paths can't climb out, placeholders are checked, done_pattern needs {task}", () => {
    const fill = {
      enabled: true,
      tasks_file: "work/tasks.txt",
      agents: ["worker-a"],
      prompt_files: ["{prompts_dir}/restart-addendum.txt", "{prompts_dir}/{agent}.txt"],
      capacity_cmd: ["capacity-check"],
    };
    const withFill = (extra: Record<string, unknown>) => ({ enabled: true, fill: { ...fill, ...extra } });
    expect(errorsOf(withFill({}))).toEqual([]);
    expect(errorsOf(withFill({ prompt_files: ["{prompts_dir}/../secrets.txt"] }))).toEqual([
      'agents.fill.prompt_files[0]: a ".." segment is refused (prompt files stay inside prompts_dir)',
    ]);
    expect(errorsOf(withFill({ prompt_files: ["{prompts_dir}/{repo}.txt"] }))[0]).toContain(
      "agents.fill.prompt_files[0]: unknown placeholder {repo}",
    );
    expect(errorsOf(withFill({ agents: ["not an id"] }))).toEqual(["agents.fill.agents[0]: not an id is not a valid agent id"]);
    expect(errorsOf(withFill({ done_pattern: "^- DONE " }))[0]).toContain("agents.fill.done_pattern: needs {task}");
    expect(errorsOf(withFill({ done_pattern: "^- DONE ({task}" }))[0]).toContain(
      "agents.fill.done_pattern: not a valid regular expression",
    );
    expect(errorsOf(withFill({ max_active: 0 }))[0]).toContain("agents.fill.max_active");
    expect(errorsOf(withFill({ max_completions_without_done: 0 }))[0]).toContain("agents.fill.max_completions_without_done");
    expect(errorsOf(withFill({ capacity_cmd: [] }))[0]).toContain("agents.fill.capacity_cmd");
    expect(errorsOf(withFill({ launch_forever: true }))[0]).toContain("agents.fill");
  });

  it("the default done_pattern: a DONE line for the task, in any case and spacing, never a longer task id", () => {
    const done = (line: string, task = "feat-login") =>
      doneLineMatches(donePatternFor(DEFAULT_DONE_PATTERN, task, "worker-a"), task, line);
    expect(done("- DONE feat-login by worker-a 12:05Z: merged")).toBe(true);
    expect(done("- DONE feat-login")).toBe(true);
    // Trimmed, and DONE in any case, as the module's own DONE check reads queue lines
    expect(done("   -  done feat-login by worker-a   ")).toBe(true);
    // The task id is exact: another case, or a longer id, is another task
    expect(done("- DONE FEAT-LOGIN by worker-a")).toBe(false);
    expect(done("- DONE feat-login-2 by worker-a 12:05Z: merged")).toBe(false);
    expect(done("- WAITING feat-login 20260101T000000Z-x-abcdef12-1 by worker-a")).toBe(false);
    // ':' and '-' can be inside a task id, so neither ends one: "feat" isn't done by feat:login or feat-login
    expect(done("- DONE feat:login by worker-a", "feat")).toBe(false);
    expect(done("- DONE feat-login by worker-a", "feat")).toBe(false);
    expect(done("- DONE feat by worker-a", "feat")).toBe(true);
    // Task ids are literal text in the pattern
    expect(done("- DONE fix21 by worker-a", "fix.1")).toBe(false);
  });

  it("the documented fill example parses, and its done_pattern refuses a longer task id", () => {
    const doc = readFileSync(new URL("../../../docs/configuration.md", import.meta.url), "utf-8");
    const section = doc.slice(doc.indexOf("### Fill"));
    const start = section.indexOf("```yaml") + "```yaml".length;
    const example = parseYaml(section.slice(start, section.indexOf("```", start))) as { agents: unknown };
    const parsed = parseAgentsConfig(example.agents, project);
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
    if (!parsed.ok) return;
    const done = (line: string, task: string) =>
      doneLineMatches(donePatternFor(parsed.settings.fill.donePattern, task, "worker-a"), task, line);
    expect(done("- DONE feat-login by worker-a 12:05Z: merged", "feat-login")).toBe(true);
    expect(done("- DONE feat-login-2 by worker-a", "feat-login")).toBe(false);
    expect(done("- DONE feat:login by worker-a", "feat")).toBe(false);
  });

  it("backs off exponentially, capped", () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 10, 60))).toEqual([10_000, 20_000, 40_000, 60_000]);
  });
});
