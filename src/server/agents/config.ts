/**
 * The `agents:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#agents.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import type { BudgetMetric } from "../../shared/agents-types.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { getAdapter } from "../services/adapters.js";
import { placeholdersIn } from "../watchdog/config.js";

const argv = z.array(z.string().min(1)).min(1);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** Model ids such as "vendor/model-1.5:latest"; never starting with "-" */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

/**
 * Lines that mean the provider is rate limiting (matched case-insensitively).
 * They look for an error, not the words alone, so an agent that writes about
 * rate limiting in its own work isn't mistaken for one that hit a limit.
 */
export const DEFAULT_RATE_LIMIT_PATTERNS = [
  "\\brate[ _-]?limit(ed)?\\b.*\\b(exceeded|reached|error|retry|try again)\\b",
  "\\b(exceeded|reached|hit)\\b.*\\brate[ _-]?limit\\b",
  "\\b(error|status|http)\\b\\W*429\\b",
  "\\b429 too many requests\\b",
  "\\bquota (exceeded|exhausted)\\b",
  "\\busage limit (reached|exceeded)\\b",
];

/** Lines that mean the provider is failing (matched case-insensitively). */
export const DEFAULT_PROVIDER_ERROR_PATTERNS = [
  "\\boverloaded_error\\b",
  "\\bmodel is (overloaded|unavailable)\\b",
  "\\bapi error\\b.*\\b5\\d\\d\\b",
  "\\b(status|http)\\W*5(00|02|03|04|29)\\b",
];

const LimitSchema = z
  .object({
    soft: z.number().positive().optional(),
    hard: z.number().positive().optional(),
  })
  .strict();

const LimitsSchema = z
  .object({
    daily_tokens: LimitSchema.optional(),
    daily_cost: LimitSchema.optional(),
    monthly_tokens: LimitSchema.optional(),
    monthly_cost: LimitSchema.optional(),
  })
  .strict();

const LockSchema = z
  .object({
    name: z.string().regex(SAFE_NAME, "lock names use letters, digits, '.', '_' and '-'"),
    /** A lock file, or a lock directory with its holder's pid in <path>/<pid_file> */
    path: z.string().min(1),
    pid_file: z.string().regex(SAFE_NAME).default("pid"),
    /** launch: held while a run starts; run: held by the agent process until it ends */
    hold: z.enum(["launch", "run"]).default("launch"),
    /** A lock with no holder pid (a legacy lock) is broken once it is this old, when a run waits on it */
    stale_minutes: z.number().positive().default(30),
    /** Also break such a pid-less lock when no run waits on it */
    break_without_waiter: z.boolean().default(false),
  })
  .strict();

/** An environment variable name */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * A queue line that reports a task done: "- DONE <task> by <agent> ...". The
 * task id ends at whitespace or the end of the line, never at ':' or '-' (task
 * ids may contain both, so "feat" isn't done by "- DONE feat:login").
 */
export const DEFAULT_DONE_PATTERN = "^-\\s+DONE\\s+{task}(?=\\s|$)";
/** A run that waits ("come back when my gate finishes"); add (?<wake>...) to capture what it waits on */
export const DEFAULT_WAITING_PATTERN = "^-\\s+WAITING\\s+{task}(?=\\s|$)";
/** A run that needs someone else first */
export const DEFAULT_BLOCKED_PATTERN = "^-\\s+BLOCKED\\s+{task}(?=\\s|$)";

const WakeSchema = z
  .object({
    /** The file whose existence wakes a waiting task (a gate's result); {wake}, {gates_dir}, {agents_dir}, {repo} */
    file: z.string().min(1).optional(),
    /** The directory that file must stay inside; {gates_dir}, {agents_dir}, {repo} */
    root: z.string().min(1).default("{gates_dir}"),
    /** How often fill looks for the file, per task */
    poll_seconds: z.number().int().min(1).max(3600).default(60),
    /** Waiting this long raises one decision */
    max_wait_minutes: z.number().positive().default(240),
    /** With nothing to wait on (no capture, or no wake.file), the task starts again after this long */
    fallback_seconds: z.number().min(0).default(900),
  })
  .strict();

const FillSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Lines <agent>|<name>|<task>|<description>; relative to repo */
    tasks_file: z.string().min(1).optional(),
    /** The agents fill may start; required when enabled */
    agents: z.array(z.string()).default([]),
    /** Files whose contents, in order, make a run's prompt; {prompts_dir}, {agent} and {task} are replaced */
    prompt_files: z.array(z.string().min(1)).default([]),
    /** Runs fill started that may be active at once */
    max_active: z.number().int().min(1).max(100).default(1),
    /**
     * Matched case-insensitively against each trimmed queue line written since
     * the task's last start; {task} and {agent} are replaced (the task id must
     * be in the matched text exactly as written)
     */
    done_pattern: z.string().min(1).max(500).default(DEFAULT_DONE_PATTERN),
    /** Exit 0: capacity available; anything else (a timeout too) holds, its first output line the reason */
    capacity_cmd: argv.optional(),
    interval_seconds: z.number().int().min(1).max(3600).default(60),
    /** Runs in a row that exit 0 without reporting the task done; then fill holds it and asks the owner */
    max_completions_without_done: z.number().int().min(1).max(100).default(3),
    /** After such a run, fill waits this long before starting the task again, doubling up to max_backoff_seconds */
    backoff_seconds: z.number().min(0).default(60),
    max_backoff_seconds: z.number().min(0).default(1800),
    /** A run that ended on such a line waits (see wake); same rules as done_pattern; (?<wake>...) optional */
    waiting_pattern: z.string().min(1).max(500).default(DEFAULT_WAITING_PATTERN),
    /** A run that ended on such a line is held for the owner at once */
    blocked_pattern: z.string().min(1).max(500).default(DEFAULT_BLOCKED_PATTERN),
    wake: WakeSchema.default({}),
  })
  .strict();

const ProfileSchema = z
  .object({
    adapter: z.string().regex(SAFE_NAME, "adapter ids use letters, digits, '.', '_' and '-'"),
    model: z.string().regex(MODEL_ID).optional(),
    provider: z.string().regex(PROVIDER).optional(),
  })
  .strict();

export const AgentsSchema = z
  .object({
    enabled: z.boolean().default(false),
    interval_seconds: z.number().int().min(1).max(3600).default(15),
    /** A run with no live agent process this long after it was requested is never-started */
    start_timeout_minutes: z.number().positive().default(10),
    /** A process that dies this soon after it started (or with an empty log) died on start */
    dead_on_start_seconds: z.number().min(0).default(60),
    /** Default: watchdog.hung_minutes */
    hung_minutes: z.number().positive().optional(),
    /** SIGTERM, then SIGKILL after this long */
    stop_grace_seconds: z.number().min(0).max(3600).default(30),
    /** How far a process's start time may differ from the one recorded for its pid */
    pid_start_tolerance_seconds: z.number().min(0).max(600).default(5),
    /** The agent's session directory; {agents_dir}, {agent} and {repo} are replaced */
    session_dir: z.string().min(1).optional(),
    /** Prints the branch state for a resume summary; {task}, {agent} and {repo} are replaced */
    branch_state_cmd: argv.optional(),
    command_timeout_seconds: z.number().int().min(1).max(600).default(30),
    /** Variables of this server's environment an agent also gets (beyond PATH, HOME, ...), e.g. a provider API key */
    env_passthrough: z.array(z.string().regex(ENV_NAME, "environment variable names only")).default([]),
    recovery: z
      .object({
        same_session_restarts: z.number().int().min(0).max(10).default(2),
        fresh_sessions: z.number().int().min(0).max(10).default(1),
        backoff_seconds: z.number().min(0).default(30),
        max_backoff_seconds: z.number().min(0).default(1800),
      })
      .strict()
      .default({}),
    retries: z
      .object({
        /** Never-started runs are retried this many times, then escalated */
        max_retries: z.number().int().min(0).max(100).default(3),
        backoff_seconds: z.number().min(0).default(60),
        max_backoff_seconds: z.number().min(0).default(3600),
      })
      .strict()
      .default({}),
    locks: z.array(LockSchema).default([]),
    failover: z
      .object({
        rate_limit_patterns: z.array(z.string().min(1)).default(DEFAULT_RATE_LIMIT_PATTERNS),
        provider_error_patterns: z.array(z.string().min(1)).default(DEFAULT_PROVIDER_ERROR_PATTERNS),
        /** A live run fails over only when its log's last line matches and the log was silent this long */
        silence_seconds: z.number().min(0).default(120),
        /** A provider that rate-limited or failed is skipped this long */
        cooldown_minutes: z.number().min(0).default(30),
        /** Failovers per task (chain of runs); one more is escalated instead */
        max_failovers: z.number().int().min(0).max(20).default(3),
      })
      .strict()
      .default({}),
    /** Regular expressions with named groups (?<tokens>...) and/or (?<cost>...), read from run logs */
    usage_patterns: z.array(z.string().min(1)).default([]),
    /** Adapter id -> provider name (default: the adapter id) */
    providers: z.record(z.string().regex(PROVIDER)).default({}),
    /** Agent id -> profiles to fail over to, in order */
    fallbacks: z.record(z.array(ProfileSchema)).default({}),
    budgets: z
      .object({
        project: LimitsSchema.optional(),
        /** Every agent's budget, unless per_agent sets the metric */
        agent: LimitsSchema.optional(),
        per_agent: z.record(LimitsSchema).default({}),
      })
      .strict()
      .default({}),
    fill: FillSchema.default({}),
  })
  .strict();

type RawSettings = z.infer<typeof AgentsSchema>;

/** The parsed `agents.fill:` block. */
export interface FillSettings {
  enabled: boolean;
  tasksFile?: string;
  agents: string[];
  promptFiles: string[];
  maxActive: number;
  donePattern: string;
  capacityCmd?: string[];
  intervalSeconds: number;
  maxCompletionsWithoutDone: number;
  backoffSeconds: number;
  maxBackoffSeconds: number;
  waitingPattern: string;
  blockedPattern: string;
  wake: {
    file?: string;
    root: string;
    pollSeconds: number;
    maxWaitMinutes: number;
    fallbackSeconds: number;
  };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * done_pattern for one task: {task} and {agent} replaced by the ids, as
 * literal text, and case-insensitive, like the module's own DONE check
 * (parseQueueLine). doneLineMatches keeps the task id itself exact.
 */
export function donePatternFor(template: string, task: string, agent: string): RegExp {
  return new RegExp(
    template.replace(/\{(task|agent)\}/g, (_match, name: string) => escapeRegExp(name === "task" ? task : agent)),
    "i",
  );
}

/**
 * A queue line reports the task done: the trimmed line matches the pattern,
 * and the matched text holds the task id exactly as written (task ids are
 * case-sensitive; the DONE keyword is not).
 */
export function doneLineMatches(pattern: RegExp, task: string, line: string): boolean {
  return taskLineMatch(pattern, task, line) !== null;
}

/** The match of a fill pattern (done, waiting, blocked) on a queue line, by doneLineMatches' rules, or null. */
export function taskLineMatch(pattern: RegExp, task: string, line: string): RegExpExecArray | null {
  const match = pattern.exec(line.trim());
  return match !== null && match[0].includes(task) ? match : null;
}

/** What a waiting line may name to wait on: one plain name (a gate id, say), never a path or an option */
export const WAKE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface BudgetLimit {
  soft?: number;
  hard?: number;
}

export type BudgetLimits = Partial<Record<BudgetMetric, BudgetLimit>>;

export interface AgentLockSettings {
  name: string;
  path: string;
  pidFile: string;
  hold: "launch" | "run";
  staleMinutes: number;
  breakWithoutWaiter: boolean;
}

export interface ProfileSettings {
  adapter: string;
  model?: string;
  provider?: string;
}

/** The parsed `agents:` block. */
export interface AgentsSettings {
  enabled: boolean;
  intervalSeconds: number;
  startTimeoutMinutes: number;
  deadOnStartSeconds: number;
  hungMinutes?: number;
  stopGraceSeconds: number;
  pidStartToleranceSeconds: number;
  sessionDir?: string;
  branchStateCmd?: string[];
  commandTimeoutSeconds: number;
  /** Extra variables an agent gets from this server's environment (never LAIR_*) */
  envPassthrough: string[];
  recovery: {
    sameSessionRestarts: number;
    freshSessions: number;
    backoffSeconds: number;
    maxBackoffSeconds: number;
  };
  retries: { maxRetries: number; backoffSeconds: number; maxBackoffSeconds: number };
  locks: AgentLockSettings[];
  failover: {
    rateLimit: RegExp[];
    providerError: RegExp[];
    silenceSeconds: number;
    cooldownMinutes: number;
    maxFailovers: number;
  };
  /** Usage patterns, compiled case-insensitive and global */
  usagePatterns: RegExp[];
  providers: Record<string, string>;
  fallbacks: Record<string, ProfileSettings[]>;
  budgets: {
    project?: BudgetLimits;
    agent?: BudgetLimits;
    perAgent: Record<string, BudgetLimits>;
  };
  fill: FillSettings;
}

export type AgentsParseResult =
  | { ok: true; settings: AgentsSettings }
  | { ok: false; errors: string[] };

function compile(patterns: string[], flags: string, where: string, errors: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  patterns.forEach((pattern, i) => {
    try {
      compiled.push(new RegExp(pattern, flags));
    } catch (e) {
      errors.push(`${where}[${i}]: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
    }
  });
  return compiled;
}

function checkPlaceholders(template: string, allowed: string[], where: string, errors: string[]): void {
  for (const name of placeholdersIn([template])) {
    if (!allowed.includes(name)) {
      errors.push(`${where}: unknown placeholder {${name}} (allowed: ${allowed.map((n) => `{${n}}`).join(", ")})`);
    }
  }
}

function checkLimits(limits: RawSettings["budgets"]["project"], where: string, errors: string[]): void {
  if (!limits) return;
  for (const [metric, limit] of Object.entries(limits)) {
    if (limit && limit.soft !== undefined && limit.hard !== undefined && limit.soft > limit.hard) {
      errors.push(`${where}.${metric}: soft (${limit.soft}) is above hard (${limit.hard})`);
    }
  }
}

/**
 * Validate a project's `agents:` block (undefined means disabled). The
 * project config is needed to check the adapters that fallbacks name.
 */
export function parseAgentsConfig(raw: unknown, project?: ProjectConfig): AgentsParseResult {
  const parsed = AgentsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `agents.${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const value: RawSettings = parsed.data;
  const errors: string[] = [];

  const rateLimit = compile(value.failover.rate_limit_patterns, "i", "agents.failover.rate_limit_patterns", errors);
  const providerError = compile(
    value.failover.provider_error_patterns,
    "i",
    "agents.failover.provider_error_patterns",
    errors,
  );
  const usagePatterns = compile(value.usage_patterns, "gi", "agents.usage_patterns", errors);
  value.usage_patterns.forEach((pattern, i) => {
    if (!pattern.includes("(?<tokens>") && !pattern.includes("(?<cost>")) {
      errors.push(`agents.usage_patterns[${i}]: needs a named group (?<tokens>...) or (?<cost>...)`);
    }
  });

  if (value.session_dir) {
    checkPlaceholders(value.session_dir, ["agents_dir", "agent", "repo"], "agents.session_dir", errors);
  }
  value.branch_state_cmd?.forEach((arg, i) =>
    checkPlaceholders(arg, ["task", "agent", "repo"], `agents.branch_state_cmd[${i}]`, errors),
  );

  for (const name of value.env_passthrough) {
    if (name.toUpperCase().startsWith("LAIR_")) {
      errors.push(`agents.env_passthrough: ${name}: LAIR_* variables are never passed to agents`);
    }
  }

  const lockNames = new Set<string>();
  const lockPaths = new Set<string>();
  for (const lock of value.locks) {
    if (lockNames.has(lock.name)) errors.push(`agents.locks: duplicate lock name ${lock.name}`);
    if (lockPaths.has(lock.path)) errors.push(`agents.locks: duplicate lock path ${lock.path}`);
    lockNames.add(lock.name);
    lockPaths.add(lock.path);
  }

  for (const [agent, profiles] of Object.entries(value.fallbacks)) {
    if (!isValidDragonId(agent)) {
      errors.push(`agents.fallbacks.${agent}: not a valid agent id`);
      continue;
    }
    profiles.forEach((profile, i) => {
      if (project && !getAdapter(profile.adapter, project)) {
        errors.push(`agents.fallbacks.${agent}[${i}]: unknown adapter ${profile.adapter}`);
      }
    });
  }
  for (const agent of Object.keys(value.budgets.per_agent)) {
    if (!isValidDragonId(agent)) errors.push(`agents.budgets.per_agent.${agent}: not a valid agent id`);
  }
  checkLimits(value.budgets.project, "agents.budgets.project", errors);
  checkLimits(value.budgets.agent, "agents.budgets.agent", errors);
  for (const [agent, limits] of Object.entries(value.budgets.per_agent)) {
    checkLimits(limits, `agents.budgets.per_agent.${agent}`, errors);
  }
  checkFill(value, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      intervalSeconds: value.interval_seconds,
      startTimeoutMinutes: value.start_timeout_minutes,
      deadOnStartSeconds: value.dead_on_start_seconds,
      hungMinutes: value.hung_minutes,
      stopGraceSeconds: value.stop_grace_seconds,
      pidStartToleranceSeconds: value.pid_start_tolerance_seconds,
      sessionDir: value.session_dir,
      branchStateCmd: value.branch_state_cmd,
      commandTimeoutSeconds: value.command_timeout_seconds,
      envPassthrough: value.env_passthrough,
      recovery: {
        sameSessionRestarts: value.recovery.same_session_restarts,
        freshSessions: value.recovery.fresh_sessions,
        backoffSeconds: value.recovery.backoff_seconds,
        maxBackoffSeconds: value.recovery.max_backoff_seconds,
      },
      retries: {
        maxRetries: value.retries.max_retries,
        backoffSeconds: value.retries.backoff_seconds,
        maxBackoffSeconds: value.retries.max_backoff_seconds,
      },
      locks: value.locks.map((lock) => ({
        name: lock.name,
        path: lock.path,
        pidFile: lock.pid_file,
        hold: lock.hold,
        staleMinutes: lock.stale_minutes,
        breakWithoutWaiter: lock.break_without_waiter,
      })),
      failover: {
        rateLimit,
        providerError,
        silenceSeconds: value.failover.silence_seconds,
        cooldownMinutes: value.failover.cooldown_minutes,
        maxFailovers: value.failover.max_failovers,
      },
      usagePatterns,
      providers: value.providers,
      fallbacks: value.fallbacks,
      budgets: {
        project: value.budgets.project,
        agent: value.budgets.agent,
        perAgent: value.budgets.per_agent,
      },
      fill: {
        enabled: value.fill.enabled,
        tasksFile: value.fill.tasks_file,
        agents: value.fill.agents,
        promptFiles: value.fill.prompt_files,
        maxActive: value.fill.max_active,
        donePattern: value.fill.done_pattern,
        capacityCmd: value.fill.capacity_cmd,
        intervalSeconds: value.fill.interval_seconds,
        maxCompletionsWithoutDone: value.fill.max_completions_without_done,
        backoffSeconds: value.fill.backoff_seconds,
        maxBackoffSeconds: value.fill.max_backoff_seconds,
        waitingPattern: value.fill.waiting_pattern,
        blockedPattern: value.fill.blocked_pattern,
        wake: {
          file: value.fill.wake.file,
          root: value.fill.wake.root,
          pollSeconds: value.fill.wake.poll_seconds,
          maxWaitMinutes: value.fill.wake.max_wait_minutes,
          fallbackSeconds: value.fill.wake.fallback_seconds,
        },
      },
    },
  };
}

function checkFill(value: RawSettings, errors: string[]): void {
  const fill = value.fill;
  if (fill.enabled) {
    if (!value.enabled) errors.push("agents.fill.enabled: fill needs agents.enabled: true");
    if (!fill.tasks_file) errors.push("agents.fill.tasks_file: required when fill is enabled");
    if (fill.agents.length === 0) {
      errors.push("agents.fill.agents: list the agents fill may start (required when fill is enabled)");
    }
    if (fill.prompt_files.length === 0) {
      errors.push("agents.fill.prompt_files: at least one prompt file is required when fill is enabled");
    }
  }
  fill.agents.forEach((agent, i) => {
    if (!isValidDragonId(agent)) errors.push(`agents.fill.agents[${i}]: ${agent} is not a valid agent id`);
  });
  fill.prompt_files.forEach((template, i) => {
    checkPlaceholders(template, ["prompts_dir", "agent", "task"], `agents.fill.prompt_files[${i}]`, errors);
    if (template.split(/[\\/]/).includes("..")) {
      errors.push(`agents.fill.prompt_files[${i}]: a ".." segment is refused (prompt files stay inside prompts_dir)`);
    }
  });
  checkTaskPattern(fill.done_pattern, "done_pattern", "done", errors);
  checkTaskPattern(fill.waiting_pattern, "waiting_pattern", "waiting", errors);
  checkTaskPattern(fill.blocked_pattern, "blocked_pattern", "blocked", errors);

  const wake = fill.wake;
  if (wake.file !== undefined) {
    checkPlaceholders(wake.file, ["wake", "gates_dir", "agents_dir", "repo"], "agents.fill.wake.file", errors);
    if (!wake.file.includes("{wake}")) errors.push("agents.fill.wake.file: needs {wake} (what the waiting line names)");
    if (wake.file.split(/[\\/]/).includes("..")) errors.push('agents.fill.wake.file: a ".." segment is refused');
  }
  checkPlaceholders(wake.root, ["gates_dir", "agents_dir", "repo"], "agents.fill.wake.root", errors);
  if (wake.root.split(/[\\/]/).includes("..")) errors.push('agents.fill.wake.root: a ".." segment is refused');
}

/** A fill pattern: {task} and {agent} only, {task} required, and it compiles. */
function checkTaskPattern(pattern: string, key: string, what: string, errors: string[]): void {
  checkPlaceholders(pattern, ["task", "agent"], `agents.fill.${key}`, errors);
  if (!pattern.includes("{task}")) {
    errors.push(`agents.fill.${key}: needs {task} (without it one ${what} line would match every task)`);
    return;
  }
  try {
    donePatternFor(pattern, "example-task", "example-agent");
  } catch (e) {
    errors.push(`agents.fill.${key}: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Backoff for attempt n (1-based): base * 2^(n-1), capped. In milliseconds. */
export function backoffMs(attempt: number, baseSeconds: number, maxSeconds: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  return Math.min(maxSeconds, baseSeconds * 2 ** exponent) * 1000;
}
