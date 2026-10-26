/**
 * The `triage:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#triage.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";

export const INFRA_KINDS = ["network", "container", "oom", "runner", "disk", "load"] as const;
export type InfraKind = (typeof INFRA_KINDS)[number];

export interface InfraPattern {
  id: string;
  kind: InfraKind;
  /** A regular expression, matched case-insensitively against each evidence line */
  pattern: string;
}

/**
 * Infrastructure failures: the environment, not the change. Generic patterns
 * for common runtimes; a project adds its own in `triage.infra_patterns`.
 */
export const DEFAULT_INFRA_PATTERNS: InfraPattern[] = [
  {
    id: "connection-timeout",
    kind: "network",
    pattern:
      "connect(ion)? timed out|SocketTimeoutException|ConnectTimeoutException|ETIMEDOUT|timed out (while )?waiting for (a |the )?connection",
  },
  {
    id: "connection-refused",
    kind: "network",
    pattern: "connection refused|ECONNREFUSED|java\\.net\\.ConnectException",
  },
  { id: "connection-reset", kind: "network", pattern: "ECONNRESET|connection reset by peer|socket hang up" },
  {
    id: "dns",
    kind: "network",
    pattern:
      "EAI_AGAIN|ENOTFOUND|getaddrinfo|temporary failure in name resolution|could not resolve host|UnknownHostException",
  },
  {
    id: "download",
    kind: "network",
    pattern: "could not (get|head) '?https?:|received status code 5\\d\\d|read timed out",
  },
  {
    id: "container-start",
    kind: "container",
    pattern:
      "container startup failed|could not start container|ContainerLaunchException|timed out waiting for container|cannot connect to the docker daemon|error response from daemon|could not find a valid docker environment|failed to create (the )?container",
  },
  {
    id: "out-of-memory",
    kind: "oom",
    pattern: "OutOfMemoryError|JavaScript heap out of memory|cannot allocate memory|ENOMEM|\\bMemoryError\\b|OOMKilled|out of memory",
  },
  {
    id: "runner-died",
    kind: "runner",
    pattern:
      "runner (has )?(died|lost|disconnected|was terminated)|lost communication with the server|received a shutdown signal|the forked VM terminated|test executor \\d+ finished with non-zero exit value|worker (process )?(crashed|exited unexpectedly|terminated unexpectedly)|daemon disappeared|signal: killed",
  },
  { id: "disk-full", kind: "disk", pattern: "no space left on device|ENOSPC|disk quota exceeded" },
];

/**
 * A failure matching one of these is a shared context or bootstrap failure:
 * every test it fails is grouped into ONE cause.
 */
export const DEFAULT_CONTEXT_PATTERNS: string[] = [
  "failed to load (the )?(application ?)?context",
  "failure threshold \\(\\d+\\) exceeded",
  "error (at|in) setup of",
  "failed on setup with",
  "(before|after) ?(all|each)? hook",
  "test suite failed to run",
  "initializationError",
  "error collecting",
  "could not (start|initiali[sz]e|bootstrap) (the )?(application|app|context|server)",
];

/** Project-configured commands (triage.commands.<id>) and their placeholders. */
export const COMMAND_PLACEHOLDERS = {
  recheck: ["request", "purpose", "sha", "branch", "gate", "steps", "tests", "classes", "attempt"],
  notify_agent: ["agent", "gate", "sha", "branch", "pr", "record", "message"],
  create_task: ["kind", "key", "title", "body"],
  raise_decision: ["kind", "subject", "question", "context", "recommended", "options"],
  open_revert: ["sha", "branch", "incident", "reason", "pr"],
} as const satisfies Record<string, readonly string[]>;
export type CommandId = keyof typeof COMMAND_PLACEHOLDERS;
export const COMMAND_IDS = Object.keys(COMMAND_PLACEHOLDERS) as CommandId[];

/** Placeholders that hold a list: an argument that is exactly `{name}` becomes one argument per item. */
export const LIST_PLACEHOLDERS = new Set(["steps", "tests", "classes", "options"]);

const argv = z.array(z.string().min(1)).min(1);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
export const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

const PatternSchema = z
  .object({
    id: z.string().regex(SAFE_ID, "pattern ids use letters, digits, '.', '_' and '-'"),
    kind: z.enum(INFRA_KINDS),
    pattern: z.string().min(1),
  })
  .strict();

const commandsShape = Object.fromEntries(COMMAND_IDS.map((id) => [id, argv.optional()])) as Record<
  CommandId,
  z.ZodOptional<typeof argv>
>;

const TriageSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["observe", "act"]).default("observe"),
    default_branch: z.string().regex(BRANCH, "not a branch name").default("main"),
    interval_seconds: z.number().int().min(5).max(3600).default(60),
    command_timeout_seconds: z.number().int().min(1).max(3600).default(120),
    infra_patterns: z.array(PatternSchema).default([]),
    /** false: only the project's infra_patterns apply */
    default_infra_patterns: z.boolean().default(true),
    context_patterns: z.array(z.string().min(1)).default([]),
    default_context_patterns: z.boolean().default(true),
    /** A timeout while the machine's load per core was at least this is infra (load) */
    overload_per_core: z.number().positive().default(2),
    actions: z
      .object({
        infra: z.enum(["recheck", "route", "none"]).default("recheck"),
        pre_existing: z.enum(["fix_task", "none"]).default("fix_task"),
        code: z.enum(["route", "none"]).default("route"),
      })
      .strict()
      .default({}),
    recheck: z
      .object({
        max_retries: z.number().int().min(0).max(5).default(1),
        max_concurrent: z.number().int().min(1).max(20).default(1),
        timeout_minutes: z.number().positive().default(120),
        max_load_per_core: z.number().positive().optional(),
        min_free_memory_mb: z.number().min(0).optional(),
        /** Exits 0 when there is capacity for a re-check */
        capacity_cmd: argv.optional(),
      })
      .strict()
      .default({}),
    flaky: z
      .object({
        window_minutes: z.number().positive().default(1440),
        /** Flaky this many times in a row: a reliability task (quality.md §15) */
        ticket_after: z.number().int().min(1).max(10).default(2),
        ticket_deadline_days: z.number().int().min(1).max(90).default(7),
        quarantine: z.boolean().default(true),
        quarantine_cap: z.number().int().min(0).default(10),
      })
      .strict()
      .default({}),
    bisect: z
      .object({
        enabled: z.boolean().default(true),
        /** auto: open a revert for a proven culprit; propose: ask through a decision; off */
        revert: z.enum(["auto", "propose", "off"]).default("propose"),
        max_candidates: z.number().int().min(1).max(1000).default(64),
        /** Merges a human marked protected: never reverted automatically */
        protected_merges: z.array(z.string().regex(SHA_PATTERN, "not a commit sha")).default([]),
        /** A merge whose message has `<trailer>: yes` is protected too */
        protected_trailer: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/).default("Lair-Protected"),
      })
      .strict()
      .default({}),
    commands: z.object(commandsShape).strict().default({}),
    /** Where decisions go when no raise_decision command is set (default: inbox_file) */
    decision_file: z.string().min(1).optional(),
  })
  .strict();

export interface CompiledPattern {
  id: string;
  kind: InfraKind;
  regex: RegExp;
}

/** The parsed `triage:` block. */
export interface TriageSettings {
  enabled: boolean;
  mode: "observe" | "act";
  defaultBranch: string;
  intervalSeconds: number;
  commandTimeoutSeconds: number;
  infraPatterns: CompiledPattern[];
  contextPatterns: RegExp[];
  overloadPerCore: number;
  actions: { infra: "recheck" | "route" | "none"; preExisting: "fix_task" | "none"; code: "route" | "none" };
  recheck: {
    maxRetries: number;
    maxConcurrent: number;
    timeoutMinutes: number;
    maxLoadPerCore?: number;
    minFreeMemoryMb?: number;
    capacityCmd?: string[];
  };
  flaky: {
    windowMinutes: number;
    ticketAfter: number;
    ticketDeadlineDays: number;
    quarantine: boolean;
    quarantineCap: number;
  };
  bisect: {
    enabled: boolean;
    revert: "auto" | "propose" | "off";
    maxCandidates: number;
    protectedMerges: string[];
    protectedTrailer: string;
  };
  commands: Partial<Record<CommandId, string[]>>;
  decisionFile?: string;
}

export type TriageParseResult = { ok: true; settings: TriageSettings } | { ok: false; errors: string[] };

/** Placeholders in an argv template, e.g. ["{sha}", "x{tests}"] -> sha, tests */
export function placeholdersIn(template: string[]): string[] {
  const names = new Set<string>();
  for (const arg of template) {
    for (const match of arg.matchAll(/\{([A-Za-z_]+)\}/g)) names.add(match[1]);
  }
  return [...names];
}

function compile(pattern: string, where: string, errors: string[]): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch (e) {
    errors.push(`${where}: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

/** Validate a project's `triage:` block (undefined means disabled). */
export function parseTriageConfig(raw: unknown): TriageParseResult {
  const parsed = TriageSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `triage.${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  const value = parsed.data;
  const errors: string[] = [];

  const infraPatterns: CompiledPattern[] = [];
  const ids = new Set<string>();
  const given = value.infra_patterns.map((p, i) => ({ ...p, where: `triage.infra_patterns.${i}.pattern` }));
  const defaults = value.default_infra_patterns
    ? DEFAULT_INFRA_PATTERNS.filter((d) => !value.infra_patterns.some((p) => p.id === d.id)).map((p) => ({
        ...p,
        where: `default pattern ${p.id}`,
      }))
    : [];
  // The project's own patterns first: a project pattern with a default's id replaces it
  for (const p of [...given, ...defaults]) {
    if (ids.has(p.id)) {
      errors.push(`triage.infra_patterns: duplicate pattern id ${p.id}`);
      continue;
    }
    ids.add(p.id);
    const regex = compile(p.pattern, p.where, errors);
    if (regex) infraPatterns.push({ id: p.id, kind: p.kind, regex });
  }

  const contextPatterns: RegExp[] = [];
  const contextSources = [
    ...value.context_patterns.map((p, i) => ({ p, where: `triage.context_patterns.${i}` })),
    ...(value.default_context_patterns ? DEFAULT_CONTEXT_PATTERNS.map((p) => ({ p, where: "default context pattern" })) : []),
  ];
  for (const { p, where } of contextSources) {
    const regex = compile(p, where, errors);
    if (regex) contextPatterns.push(regex);
  }

  for (const id of COMMAND_IDS) {
    const template = value.commands[id];
    if (!template) continue;
    const allowed = new Set<string>([...COMMAND_PLACEHOLDERS[id], "project"]);
    for (const name of placeholdersIn(template)) {
      if (!allowed.has(name)) {
        errors.push(
          `triage.commands.${id}: unknown placeholder {${name}} (allowed: ${[...allowed].map((n) => `{${n}}`).join(", ")})`,
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      mode: value.mode,
      defaultBranch: value.default_branch,
      intervalSeconds: value.interval_seconds,
      commandTimeoutSeconds: value.command_timeout_seconds,
      infraPatterns,
      contextPatterns,
      overloadPerCore: value.overload_per_core,
      actions: {
        infra: value.actions.infra,
        preExisting: value.actions.pre_existing,
        code: value.actions.code,
      },
      recheck: {
        maxRetries: value.recheck.max_retries,
        maxConcurrent: value.recheck.max_concurrent,
        timeoutMinutes: value.recheck.timeout_minutes,
        maxLoadPerCore: value.recheck.max_load_per_core,
        minFreeMemoryMb: value.recheck.min_free_memory_mb,
        capacityCmd: value.recheck.capacity_cmd,
      },
      flaky: {
        windowMinutes: value.flaky.window_minutes,
        ticketAfter: value.flaky.ticket_after,
        ticketDeadlineDays: value.flaky.ticket_deadline_days,
        quarantine: value.flaky.quarantine,
        quarantineCap: value.flaky.quarantine_cap,
      },
      bisect: {
        enabled: value.bisect.enabled,
        revert: value.bisect.revert,
        maxCandidates: value.bisect.max_candidates,
        protectedMerges: value.bisect.protected_merges.map((s) => s.toLowerCase()),
        protectedTrailer: value.bisect.protected_trailer,
      },
      commands: value.commands,
      decisionFile: value.decision_file,
    },
  };
}

/**
 * Whether commands may run: mode act and the project is not read_only.
 * Returns the reason when they may not.
 */
export function actBlockedReason(config: ProjectConfig, settings: TriageSettings): string | null {
  if (settings.mode !== "act") return "triage.mode is observe";
  if (config.read_only === true) return "the project is read_only";
  return null;
}
