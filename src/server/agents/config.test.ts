/**
 * The `agents:` config block: defaults, validation, and the backoff rule.
 */
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ProjectConfig } from "../../shared/types.js";
import {
  anyAgentPatternFor,
  backoffMs,
  DEFAULT_BLOCKED_PATTERN,
  DEFAULT_DONE_PATTERN,
  DEFAULT_TRANSIENT_PATTERNS,
  DEFAULT_WAITING_PATTERN,
  doneLineMatches,
  fillPatternFor,
  getAgentClass,
  parseAgentsConfig,
  REPORTED_TASK_GROUP,
  reportPatternFor,
  taskLineMatch,
} from "./config.js";
import { matchTransient } from "./failover.js";

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
      doneMatch: "task_id",
      warnings: [],
      capacity: {
        loadPerCpuMax: undefined,
        memory: { pressureMax: undefined, availableMinPct: undefined },
        heavyWork: { detect: [], detectPatterns: [], maxActive: 1 },
        agentClass: {},
        defaultClass: "local",
      },
      capacityCmd: undefined,
      intervalSeconds: 60,
      maxCompletionsWithoutDone: 3,
      backoffSeconds: 60,
      maxBackoffSeconds: 1800,
      waitingPattern: DEFAULT_WAITING_PATTERN,
      blockedPattern: DEFAULT_BLOCKED_PATTERN,
      readyGuard: false,
      readyWaitMinutes: 120,
      wake: {
        file: undefined,
        root: "{gates_dir}",
        pollSeconds: 60,
        maxWaitMinutes: 240,
        maxQueueWaitMinutes: 1440,
        requeueMarker: undefined,
        fallbackSeconds: 900,
      },
      idle: {
        noticeMinutes: 0,
        readySources: ["tasks_file"],
      },
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
        `agents.fill.${key}: needs {task} or {agent} (without either one ${key === "waiting_pattern" ? "waiting" : "blocked"} line would match every task)`,
      ]);
      // {agent} alone is enough, right after "by\s+" (the line's author)
      expect(errorsOf(withFill({ [key]: "^- WAITING .*\\bby\\s+{agent}(?=[\\s(]|$)" }))).toEqual([]);
      expect(errorsOf(withFill({ [key]: "^- WAITING .* by\\s+{agent}(?=[\\s(]|$)" }))).toEqual([]);
      // "by" in any case (patterns match case-insensitively), but the escapes as written
      expect(errorsOf(withFill({ [key]: "^- WAITING .*\\bBY\\s+{agent}(?=[\\s(]|$)" }))).toEqual([]);
      // Anywhere else it could match a line that only names the agent ("merged kiro-A's PR"), or another agent
      for (const pattern of [
        "^- DONE merged {agent}'s PR",
        "^- DONE .*{agent}",
        "^- DONE .*\\bbaby\\s+{agent}",
        "^- DONE .*\\bby\\s*{agent}",
        "^- DONE .* by {agent}",
        "^- DONE .*-by\\s+{agent}",
        // \S+ is not \s+, and \B is not \b
        "^- DONE .*\\bby\\S+{agent}",
        "^- DONE .*\\Bby\\s+{agent}",
      ]) {
        expect(errorsOf(withFill({ [key]: pattern }))).toEqual([
          `agents.fill.${key}: {agent} must come right after "\\bby\\s+" (the line's author: "... by {agent}")`,
        ]);
      }
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
    // A re-queue marker: {wake} required, {n} allowed, inside the directories fill may read
    expect(errorsOf(wake({ requeue_marker: "{gates_dir}/results/{wake}.recheck-{n}", max_queue_wait_minutes: 600 }))).toEqual([]);
    expect(errorsOf(wake({ requeue_marker: "{gates_dir}/results/latest.recheck" }))).toEqual([
      "agents.fill.wake.requeue_marker: needs {wake} (the gate id the marker is about)",
    ]);
    expect(errorsOf(wake({ requeue_marker: "{gates_dir}/../{wake}.recheck" }))).toEqual([
      'agents.fill.wake.requeue_marker: a ".." segment is refused',
    ]);
    expect(errorsOf(wake({ requeue_marker: "{home}/{wake}" }))[0]).toContain("agents.fill.wake.requeue_marker: unknown placeholder {home}");
    expect(errorsOf(wake({ max_queue_wait_minutes: 0 }))[0]).toContain("agents.fill.wake.max_queue_wait_minutes");
  });

  it("the default waiting and blocked patterns: the task's own line, the task id exact", () => {
    const matches = (template: string, line: string, task = "feat-login") =>
      taskLineMatch(fillPatternFor(template, task, "worker-a"), line) !== null;
    expect(matches(DEFAULT_WAITING_PATTERN, "- WAITING feat-login 20260101T000000Z-x-abcdef12-1 by worker-a: gate queued")).toBe(true);
    expect(matches(DEFAULT_WAITING_PATTERN, "  -  waiting feat-login")).toBe(true);
    expect(matches(DEFAULT_WAITING_PATTERN, "- WAITING feat-login-2 by worker-a")).toBe(false);
    expect(matches(DEFAULT_WAITING_PATTERN, "- WAITING feat:login by worker-a", "feat")).toBe(false);
    expect(matches(DEFAULT_BLOCKED_PATTERN, "- BLOCKED feat-login by worker-a: needs a key")).toBe(true);
    expect(matches(DEFAULT_BLOCKED_PATTERN, "- BLOCKED FEAT-LOGIN by worker-a")).toBe(false);
    expect(matches(DEFAULT_BLOCKED_PATTERN, "- DONE feat-login by worker-a")).toBe(false);
    // A capture names what the run waits on
    const gate = fillPatternFor("^-\\s+WAITING\\s+{task}(?:\\s+(?<wake>\\d{8}T\\d{6}Z-\\S+))?(?=\\s|$)", "feat-login", "worker-a");
    expect(taskLineMatch(gate, "- WAITING feat-login 20260101T000000Z-x-abcdef12-1 by worker-a")?.groups?.wake).toBe(
      "20260101T000000Z-x-abcdef12-1",
    );
    expect(taskLineMatch(gate, "- WAITING feat-login by worker-a")?.groups?.wake).toBeUndefined();
  });

  it("patterns that match by agent: the fleet's real line shapes, the agent's own lines only, never a longer id", () => {
    const doc = readFileSync(new URL("../../../docs/configuration.md", import.meta.url), "utf-8");
    const section = doc.slice(doc.indexOf("#### Matching by agent"));
    const start = section.indexOf("```yaml") + "```yaml".length;
    const example = parseYaml(section.slice(start, section.indexOf("```", start))) as { agents: unknown };
    const parsed = parseAgentsConfig(example.agents, project);
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
    if (!parsed.ok) return;
    const { donePattern, waitingPattern, blockedPattern } = parsed.settings.fill;
    // The tasks file's ids (kiro/currency-enforcement, ...) are not in the lines: these patterns don't use {task}
    const match = (template: string, agent: string, line: string) =>
      taskLineMatch(fillPatternFor(template, "kiro/currency-enforcement", agent), line);

    const waitingH =
      "- WAITING currency-enforcement 20261027T041146Z-currency-enforcement-r9-64bebb9d-77679 by kiro-H (Viserion) 06:25Z: gate queued";
    expect(match(waitingPattern, "kiro-H", waitingH)?.groups?.wake).toBe("20261027T041146Z-currency-enforcement-r9-64bebb9d-77679");
    const waitingD = "- WAITING #183 sf-storage gate 20261027T064438Z-sf-storage-ab12cd34-5150 by kiro-D (Glaurung) 06:45Z: gate queued";
    expect(match(waitingPattern, "kiro-D", waitingD)?.groups?.wake).toBe("20261027T064438Z-sf-storage-ab12cd34-5150");
    // A WAITING line without a gate id still waits (it falls back)
    const waitingB = "- WAITING trial-allowance-3 by kiro-B (Drogon) 06:30Z: waiting on a review";
    expect(match(waitingPattern, "kiro-B", waitingB)).not.toBeNull();
    expect(match(waitingPattern, "kiro-B", waitingB)?.groups?.wake).toBeUndefined();
    expect(match(donePattern, "kiro-H", "- DONE currency-enforcement by kiro-H (Viserion) 07:10Z: merged")).not.toBeNull();
    expect(match(blockedPattern, "kiro-D", "- BLOCKED #183 sf-storage by kiro-D (Glaurung) 06:50Z: needs the bucket key")).not.toBeNull();

    // Only the agent's own lines: kiro-H's line naming kiro-C in its message isn't kiro-C's
    expect(match(donePattern, "kiro-C", "- DONE currency-enforcement by kiro-H (Viserion) 07:10Z: reviewed by kiro-C")).toBeNull();
    expect(match(waitingPattern, "kiro-C", `${waitingH}, review by kiro-C`)).toBeNull();
    // Only the attribution form counts ("by <id>" then "(", a time, ":" or the end), not a kiro-style id elsewhere
    expect(match(donePattern, "kiro-A", "- DONE reviewed by kiro-A and merged")).toBeNull();
    expect(match(donePattern, "kiro-A", "- DONE reviewed by kiro-A")).not.toBeNull();
    // A longer id that starts with the agent's is another agent
    expect(match(donePattern, "kiro-A", "- DONE sf-storage by kiro-AB (Rhaegal) 07:00Z: merged")).toBeNull();
    expect(match(blockedPattern, "kiro-A", "- BLOCKED sf-storage by kiro-AB: needs a key")).toBeNull();
    // Another kind of line, and another agent, never count
    expect(match(donePattern, "kiro-H", waitingH)).toBeNull();
    expect(match(waitingPattern, "kiro-D", waitingH)).toBeNull();
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
    expect(errorsOf(withFill({ done_pattern: "^- DONE " }))).toEqual([
      "agents.fill.done_pattern: needs {task} or {agent} (without either one done line would match every task)",
    ]);
    expect(errorsOf(withFill({ done_pattern: "^- DONE .*\\bby\\s+{agent}(?=[\\s(]|$)" }))).toEqual([]);
    expect(errorsOf(withFill({ done_pattern: "^- DONE ({task}" }))[0]).toContain(
      "agents.fill.done_pattern: not a valid regular expression",
    );
    expect(errorsOf(withFill({ max_active: 0 }))[0]).toContain("agents.fill.max_active");
    expect(errorsOf(withFill({ max_completions_without_done: 0 }))[0]).toContain("agents.fill.max_completions_without_done");
    expect(errorsOf(withFill({ capacity_cmd: [] }))[0]).toContain("agents.fill.capacity_cmd");
    expect(errorsOf(withFill({ launch_forever: true }))[0]).toContain("agents.fill");
  });

  it("the default done_pattern: a DONE line for the task, in any case and spacing, never a longer task id", () => {
    const done = (line: string, task = "feat-login") => doneLineMatches(fillPatternFor(DEFAULT_DONE_PATTERN, task, "worker-a"), line);
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
      doneLineMatches(fillPatternFor(parsed.settings.fill.donePattern, task, "worker-a"), line);
    expect(done("- DONE feat-login by worker-a 12:05Z: merged", "feat-login")).toBe(true);
    expect(done("- DONE feat-login-2 by worker-a", "feat-login")).toBe(false);
    expect(done("- DONE feat:login by worker-a", "feat")).toBe(false);
  });

  /** A fleet's patterns: done names the task and the agent (DONE or READY); waiting and blocked only the agent */
  const FLEET = {
    done_pattern: "^-\\s+(?:DONE|READY)\\s+{task}(?=[\\s:]|$).*\\bby\\s+{agent}(?=[\\s(]|$)",
    waiting_pattern: "^-\\s+WAITING\\s+(?:(?:.*?\\s)?(?<wake>\\d{8}T\\d{6}Z-[A-Za-z0-9._-]+)\\b)?.*\\bby\\s+{agent}(?=[\\s(]|$)",
    blocked_pattern: "^-\\s+BLOCKED\\s+.*\\bby\\s+{agent}(?=[\\s(]|$)",
  };

  it("done_match: task_id when done_pattern names the task; agent_legacy, with a warning, when it names only the agent; task_id asked for without {task} is an error", () => {
    const fill = { enabled: true, tasks_file: "work/tasks.txt", agents: ["worker-a"], prompt_files: ["{prompts_dir}/{agent}.txt"] };
    const settingsOf = (extra: Record<string, unknown>, enabled = true) => {
      const parsed = parseAgentsConfig({ enabled: true, fill: { ...fill, enabled, ...extra } }, project);
      if (!parsed.ok) throw new Error(parsed.errors.join("; "));
      return parsed.settings.fill;
    };
    const byAgent = "^-\\s+DONE\\s+.*\\bby\\s+{agent}(?=[\\s(]|$)";

    // The default patterns name the task: task_id, nothing to warn about
    expect(settingsOf({})).toMatchObject({ doneMatch: "task_id", warnings: [] });
    // A done_pattern that names only the agent keeps matching by agent (such configs worked before done_match), warned
    const legacy = settingsOf({ done_pattern: byAgent });
    expect(legacy.doneMatch).toBe("agent_legacy");
    expect(legacy.warnings).toEqual([
      "agents.fill.done_pattern has no {task}: fill matches DONE lines by agent (done_match agent_legacy), so a DONE line the agent writes about any other task closes its open task. Put {task} in done_pattern so a line closes only the task it names",
    ]);
    // The fleet's: task_id for its done lines, a warning for each pattern that can't name a task
    const fleet = settingsOf(FLEET);
    expect(fleet.doneMatch).toBe("task_id");
    expect(fleet.warnings.map((w) => w.slice(0, w.indexOf(":")))).toEqual([
      "agents.fill.waiting_pattern has no {task}",
      "agents.fill.blocked_pattern has no {task}",
    ]);
    // agent_legacy asked for with patterns that name the task: allowed, and it says what it turns off
    expect(settingsOf({ done_match: "agent_legacy" })).toMatchObject({
      doneMatch: "agent_legacy",
      warnings: [expect.stringContaining("agents.fill.done_match is agent_legacy: a line an agent writes about a task it isn't on is not reported")],
    });
    expect(settingsOf({ done_match: "task_id" })).toMatchObject({ doneMatch: "task_id", warnings: [] });
    // Fill off: nothing to warn about
    expect(settingsOf({ done_pattern: byAgent }, false).warnings).toEqual([]);

    // task_id asked for with a done_pattern that can't name the task: an error, never a silent fallback
    expect(errorsOf({ enabled: true, fill: { ...fill, done_pattern: byAgent, done_match: "task_id" } })).toEqual([
      'agents.fill.done_match: "task_id" needs {task} in done_pattern (a line that names only the agent can\'t say which task it closes); add {task}, or set done_match: agent_legacy',
    ]);
    expect(errorsOf({ enabled: true, fill: { ...fill, done_match: "by_title" } })[0]).toContain("agents.fill.done_match");
  });

  it("reportPatternFor reads the task id an agent's report line names, with the project's own pattern", () => {
    const read = (template: string, line: string, agent = "worker-a") =>
      reportPatternFor(template, agent)?.exec(line)?.groups?.[REPORTED_TASK_GROUP] ?? null;
    expect(read(DEFAULT_DONE_PATTERN, "- DONE old-task by worker-a 12:05Z: merged")).toBe("old-task");
    expect(read(DEFAULT_WAITING_PATTERN, "- WAITING old-task 20260302T120100Z-g-1 by worker-a 12:05Z: queued")).toBe("old-task");
    // Every character a task id may have
    expect(read(DEFAULT_DONE_PATTERN, "- DONE web/fix#12.v2:b_1 by worker-a")).toBe("web/fix#12.v2:b_1");
    // The pattern's own keywords and its own end of the id: READY is a report here, the id ends at ':'
    expect(read(FLEET.done_pattern, "- READY lair-x PR #194 at 4395a03 by worker-a (Mushu) 20:58Z: fixed")).toBe("lair-x");
    // Its {agent}: another agent's line is no report of this one
    expect(read(FLEET.done_pattern, "- READY lair-x PR #194 at 4395a03 by worker-b (Mushu) 20:58Z: fixed")).toBeNull();
    // A keyword the pattern doesn't have is no report, nor is a quoted line
    expect(read(FLEET.done_pattern, "- MERGED lair-x by worker-a 21:00Z")).toBeNull();
    expect(read(DEFAULT_DONE_PATTERN, '> "- DONE old-task by worker-a"')).toBeNull();
    // A second {task} must be the same id
    expect(read("^-\\s+DONE\\s+{task}\\s+closes\\s+{task}(?=\\s|$)", "- DONE a-1 closes a-1")).toBe("a-1");
    expect(read("^-\\s+DONE\\s+{task}\\s+closes\\s+{task}(?=\\s|$)", "- DONE a-1 closes a-2")).toBeNull();
    // A pattern without {task}: its lines name no task
    expect(reportPatternFor(FLEET.blocked_pattern, "worker-a")).toBeNull();
  });

  it("transient_patterns: defaults that look for an error, bounded in number and length, matched on a dead run's last 3 lines cut to 500 characters", () => {
    const parsed = parseAgentsConfig({}, project);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { settings } = parsed;
    expect(settings.transient.patterns.map((p) => p.source)).toEqual(DEFAULT_TRANSIENT_PATTERNS);
    expect(settings.transient.patterns.every((p) => p.flags === "i")).toBe(true);
    expect(settings.transient).toMatchObject({ maxMinutes: 120, maxRetries: 5 });

    // The line a real provider outage printed, and the usual network errors
    const outage =
      'Error: A network error occurred. Please check your connection and try again. (code -32000): {"errorType":"ClientNetworkError","retryErrorType":"TRANSIENT"}';
    expect(matchTransient(["working on step 3", outage], settings)).toBe(outage);
    for (const line of [
      'retry failed: {"retryErrorType": "TRANSIENT"}',
      "Error: read ECONNRESET",
      "Error: connect ETIMEDOUT 10.0.0.1:443",
      "Error: connect ECONNREFUSED 127.0.0.1:8443",
      "getaddrinfo EAI_AGAIN api.example.com",
      "Error: connection refused",
      "HTTP 503 Service Unavailable",
      "API returned status: 502",
      "502 Bad Gateway",
    ]) {
      expect(matchTransient([line], settings)).toBe(line);
    }
    // An agent's own output in the same log: a word alone, or a test's assertion, is no outage
    for (const line of [
      "processed 1503 files",
      "AssertionError: expected 503 to equal 200",
      "expected 503 to equal 200",
      "1 failed: the TRANSIENT retry case",
      "handles ECONNRESET by retrying",
      "Error: assertion failed in step 3",
      "all 42 tests passed",
    ]) {
      expect(matchTransient([line], settings)).toBeNull();
    }
    // Bounded: the last 3 lines only, newest first, each trimmed and cut to 500 characters before a pattern sees it
    expect(matchTransient([outage, "ok", "ok", "ok"], settings)).toBeNull();
    expect(matchTransient([outage, "ok", "ok"], settings)).toBe(outage);
    expect(matchTransient([`${"x".repeat(500)} ClientNetworkError`], settings)).toBeNull();
    expect(matchTransient([`   ${"x".repeat(470)} ClientNetworkError   `], settings)).toBe(`${"x".repeat(470)} ClientNetworkError`);
    // The retries per task are bounded too
    expect(errorsOf({ transient_max_retries: 0 })).toEqual([]);
    expect(errorsOf({ transient_max_retries: 51 })[0]).toMatch(/^agents\.transient_max_retries: /);
    expect(errorsOf({ transient_max_retries: 1.5 })[0]).toMatch(/^agents\.transient_max_retries: /);
    // Off with an empty list
    const off = parseAgentsConfig({ transient_patterns: [] }, project);
    expect(off.ok && matchTransient([outage], off.settings)).toBeNull();

    // At most 50 patterns, each at most 300 characters, each a regular expression
    expect(errorsOf({ transient_patterns: Array.from({ length: 50 }, (_, i) => `error ${i}`) })).toEqual([]);
    expect(errorsOf({ transient_patterns: Array.from({ length: 51 }, (_, i) => `error ${i}`) })[0]).toMatch(/^agents\.transient_patterns: /);
    expect(errorsOf({ transient_patterns: ["x".repeat(300)] })).toEqual([]);
    expect(errorsOf({ transient_patterns: ["x".repeat(301)] })[0]).toMatch(/^agents\.transient_patterns\.0: /);
    expect(errorsOf({ transient_patterns: ["", "ok"] })[0]).toMatch(/^agents\.transient_patterns\.0: /);
    expect(errorsOf({ transient_patterns: ["(unclosed"] })[0]).toContain("agents.transient_patterns[0]: not a valid regular expression");
    expect(errorsOf({ transient_max_minutes: 0 })[0]).toMatch(/^agents\.transient_max_minutes: /);
  });

  it("backs off exponentially, capped", () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 10, 60))).toEqual([10_000, 20_000, 40_000, 60_000]);
  });

  it("fill.idle: notices are off by default; ready_sources takes only the wired source", () => {
    const parsed = parseAgentsConfig(undefined, project);
    expect(parsed.ok && parsed.settings.fill.idle).toEqual({ noticeMinutes: 0, readySources: ["tasks_file"] });

    const fill = {
      enabled: true,
      tasks_file: "work/tasks.txt",
      agents: ["worker-a"],
      prompt_files: ["{prompts_dir}/{agent}.txt"],
    };
    const withIdle = (idle: Record<string, unknown>) => ({ enabled: true, fill: { ...fill, idle } });
    const on = parseAgentsConfig(withIdle({ notice_minutes: 30, ready_sources: ["tasks_file"] }), project);
    expect(on.ok && on.settings.fill.idle).toEqual({ noticeMinutes: 30, readySources: ["tasks_file"] });
    expect(errorsOf(withIdle({ notice_minutes: 0 }))).toEqual([]);
    // Sources that aren't wired, an empty list, a fraction, a negative or an unknown key are errors, never silent no-ops
    expect(errorsOf(withIdle({ ready_sources: ["tasks_file", "backlog"] }))[0]).toContain("agents.fill.idle.ready_sources.1");
    expect(errorsOf(withIdle({ ready_sources: ["tracker"] }))[0]).toContain("agents.fill.idle.ready_sources.0");
    expect(errorsOf(withIdle({ ready_sources: [] }))[0]).toContain("agents.fill.idle.ready_sources");
    expect(errorsOf(withIdle({ notice_minutes: 1.5 }))[0]).toContain("agents.fill.idle.notice_minutes");
    expect(errorsOf(withIdle({ notice_minutes: -1 }))[0]).toContain("agents.fill.idle.notice_minutes");
    expect(errorsOf(withIdle({ side_queue: [] }))[0]).toContain("agents.fill.idle");
  });

  it("anyAgentPatternFor: a done line for an unassigned task counts by any agent, and never without the task", () => {
    const both = anyAgentPatternFor("^-\\s+DONE\\s+{task}\\b.*\\bby\\s+{agent}", "feat-x");
    expect(both).not.toBeNull();
    expect(doneLineMatches(both!, "- DONE feat-x shipped by worker-b 12:00Z")).toBe(true);
    expect(doneLineMatches(both!, "- DONE feat-x shipped by someone-else (Name): ok")).toBe(true);
    expect(doneLineMatches(both!, "- DONE feat-xy by worker-b")).toBe(false);
    expect(doneLineMatches(both!, "- WAITING feat-x by worker-b")).toBe(false);
    const taskOnly = anyAgentPatternFor(DEFAULT_DONE_PATTERN, "feat-x");
    expect(doneLineMatches(taskOnly!, "- DONE feat-x by worker-b 12:00Z: done")).toBe(true);
    expect(doneLineMatches(taskOnly!, "- DONE feat-xy by worker-b")).toBe(false);
    // A pattern that names only the agent can't say which task a line is about
    expect(anyAgentPatternFor("^-\\s+DONE\\b.*\\bby\\s+{agent}", "feat-x")).toBeNull();
  });

  it("fill.capacity: native capacity settings with load, memory, heavy_work, and agent_class", () => {
    const fill = {
      enabled: true,
      tasks_file: "work/tasks.txt",
      agents: ["worker-a", "worker-b"],
      prompt_files: ["{prompts_dir}/{agent}.txt"],
    };
    const withFill = (extra: Record<string, unknown>) => ({ enabled: true, fill: { ...fill, ...extra } });
    
    // Defaults: no native capacity checks enabled
    const defaults = parseAgentsConfig(withFill({}), project);
    expect(defaults.ok).toBe(true);
    if (!defaults.ok) return;
    expect(defaults.settings.fill.capacity).toEqual({
      loadPerCpuMax: undefined,
      memory: { pressureMax: undefined, availableMinPct: undefined },
      heavyWork: { detect: [], detectPatterns: [], maxActive: 1 },
      agentClass: {},
      defaultClass: "local",
    });

    // Full capacity config
    const full = parseAgentsConfig(withFill({
      capacity: {
        load_per_cpu_max: 0.8,
        memory: { available_min_pct: 10 },
        heavy_work: { detect: ["*-gate", "backend-*"], max_active: 2 },
        agent_class: { "worker-a": "remote" },
        default_class: "local",
      },
    }), project);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.settings.fill.capacity).toEqual({
      loadPerCpuMax: 0.8,
      memory: { pressureMax: undefined, availableMinPct: 10 },
      heavyWork: { detect: ["*-gate", "backend-*"], detectPatterns: [/^.*-gate$/, /^backend-.*$/], maxActive: 2 },
      agentClass: { "worker-a": "remote" },
      defaultClass: "local",
    });

    // Invalid agent id in agent_class
    expect(errorsOf(withFill({
      capacity: { agent_class: { "not an id": "remote" } },
    }))).toEqual(["agents.fill.capacity.agent_class.not an id: not a valid agent id"]);

    // An agent_class key must name an agent fill may start
    expect(errorsOf(withFill({
      capacity: { agent_class: { "worker-z": "remote" } },
    }))).toEqual(["agents.fill.capacity.agent_class.worker-z: not in agents.fill.agents"]);

    // detect entries are task-id globs: regex metacharacters are literal, only * and ? are wildcards
    const meta = parseAgentsConfig(withFill({ capacity: { heavy_work: { detect: ["gate(backend", "v1.2-*", "x?y"] } } }), project);
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    const [paren, dotted, single] = meta.settings.fill.capacity.heavyWork.detectPatterns;
    expect(paren.test("gate(backend")).toBe(true);
    expect(paren.test("gateXbackend")).toBe(false);
    expect(dotted.test("v1.2-run")).toBe(true);
    expect(dotted.test("v1x2-run")).toBe(false);
    expect(single.test("xzy")).toBe(true);
    expect(single.test("xy")).toBe(false);

    // pressure_max is a percentage
    expect(errorsOf(withFill({ capacity: { memory: { pressure_max: 101 } } }))[0]).toContain("agents.fill.capacity.memory.pressure_max");
    const pressure = parseAgentsConfig(withFill({ capacity: { memory: { pressure_max: 40 } } }), project);
    expect(pressure.ok && pressure.settings.fill.capacity.memory.pressureMax).toBe(40);

    // Invalid values for limits
    expect(errorsOf(withFill({ capacity: { load_per_cpu_max: 0 } }))[0]).toContain("agents.fill.capacity.load_per_cpu_max");
    expect(errorsOf(withFill({ capacity: { load_per_cpu_max: -1 } }))[0]).toContain("agents.fill.capacity.load_per_cpu_max");
    expect(errorsOf(withFill({ capacity: { memory: { available_min_pct: -1 } } }))[0]).toContain("agents.fill.capacity.memory.available_min_pct");
    expect(errorsOf(withFill({ capacity: { memory: { available_min_pct: 101 } } }))[0]).toContain("agents.fill.capacity.memory.available_min_pct");
    expect(errorsOf(withFill({ capacity: { heavy_work: { max_active: 0 } } }))[0]).toContain("agents.fill.capacity.heavy_work.max_active");

    // Invalid class value
    expect(errorsOf(withFill({ capacity: { default_class: "hybrid" } }))[0]).toContain("agents.fill.capacity.default_class");
    expect(errorsOf(withFill({ capacity: { agent_class: { "worker-a": "hybrid" } } }))[0]).toContain("agents.fill.capacity.agent_class.worker-a");
  });

  it("getAgentClass returns the agent-specific class or the default", () => {
    const capacity = {
      loadPerCpuMax: 0.8,
      memory: { pressureMax: undefined, availableMinPct: undefined },
      heavyWork: { detect: [], detectPatterns: [], maxActive: 1 },
      agentClass: { "worker-a": "remote" as const },
      defaultClass: "local" as const,
    };
    expect(getAgentClass(capacity, "worker-a")).toBe("remote");
    expect(getAgentClass(capacity, "worker-b")).toBe("local");
    expect(getAgentClass(capacity, "unknown")).toBe("local");
    
    // With default_class: remote
    const remoteDefault = { ...capacity, defaultClass: "remote" as const };
    expect(getAgentClass(remoteDefault, "worker-a")).toBe("remote");
    expect(getAgentClass(remoteDefault, "worker-b")).toBe("remote");
  });
});

describe("agents.fill.ready_guard", () => {
  const guarded = { enabled: true, fill: { ready_guard: true } };

  it("is a config error without review.enabled: the PRs could not be read, so every report would pass", () => {
    expect(errorsOf(guarded)).toEqual([
      "agents.fill.ready_guard: needs review.enabled (the PRs are read through the review module's git host)",
    ]);
    const parsed = parseAgentsConfig(guarded, { ...project, review: { enabled: false } } as ProjectConfig);
    expect(parsed.ok).toBe(false);
  });

  it("loads with review.enabled, and the wait for an unverifiable report is bounded", () => {
    const reviewed = { ...project, review: { enabled: true } } as ProjectConfig;
    const parsed = parseAgentsConfig({ ...guarded, fill: { ready_guard: true, ready_wait_minutes: 30 } }, reviewed);
    expect(parsed.ok && parsed.settings.fill.readyGuard).toBe(true);
    expect(parsed.ok && parsed.settings.fill.readyWaitMinutes).toBe(30);
    expect(errorsOf({ enabled: true, fill: { ready_wait_minutes: 0 } })[0]).toContain("agents.fill.ready_wait_minutes");
  });

  it("is not checked when the guard is off", () => {
    expect(errorsOf({ enabled: true, fill: { ready_guard: false } })).toEqual([]);
  });
});
