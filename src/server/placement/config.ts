/**
 * The `placement:` block of a project config, validated with defaults
 * applied. See docs/configuration.md#placement.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";

/** Lane names as the gate parser reads them (src/server/parsers/gates.ts) */
const LANE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** Machine and class ids: a letter first, so no id is an integer-like object key (class order is kept) */
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** Placeholders move_cmd may use */
export const MOVE_PLACEHOLDERS = ["id", "from", "to", "file", "priority", "project"] as const;
/** The fields a runner log line can hold, in the order `history.columns` names them */
export const HISTORY_COLUMNS = ["time", "id", "rc", "command", "lane", "ignore"] as const;
export type HistoryColumn = (typeof HISTORY_COLUMNS)[number];

const MAX_PATTERN = 500;
const argv = z.array(z.string().min(1).max(4096)).min(1).max(64);
const laneName = z.string().regex(LANE, "lane names use a letter, then letters, digits, '_' or '-' (at most 32)");
const name = z.string().regex(NAME, "names use a letter, then letters, digits, '_' or '-' (at most 32)");
const pattern = z.string().min(1).max(MAX_PATTERN);

const OnDemandSchema = z
  .object({
    /** Prints running|stopped|pending|stopping */
    state_cmd: argv,
    /** Exit 0 + stdout starting with "guard: ok" = a start is allowed */
    guard_cmd: argv,
    /** Added to the estimate while the machine is not running (seconds) */
    boot_seconds: z.number().int().min(0).max(3600).default(150),
    /** Shown in the UI; used as a tie-break */
    cost_per_hour: z.number().min(0).max(1000).optional(),
    /** How often state/guard run at most (seconds); the guard may read paid APIs, so cache it */
    check_seconds: z.number().int().min(10).max(3600).default(300),
    /** Speed factor for this machine vs others when no history exists (default 1.0) */
    speed_factor: z.number().min(0.1).max(10).default(1.0),
  })
  .strict();

const MachineSchema = z
  .object({
    /** Exit 0 (and, with `expect`, stdout starting with it) means the machine answers */
    probe: argv,
    expect: z.string().min(1).max(200).optional(),
    /** Prints the 1-minute load first and the cpu count last */
    load_cmd: argv.optional(),
    cpus: z.number().int().min(1).max(4096).optional(),
    min_up_seconds: z.number().int().min(0).max(86_400).default(240),
    /** On-demand machine: Lair tracks its state and considers it for placement even when stopped */
    on_demand: OnDemandSchema.optional(),
  })
  .strict();

const LaneSchema = z
  .object({
    machine: name,
    slots: z.number().int().min(1).max(64).default(1),
    limits: z.record(name, z.number().int().min(0).max(64)).default({}),
    /** A pseudo-lane: its runner takes jobs from these lanes' queues */
    serves: z.array(laneName).max(16).default([]),
    /** A pseudo-lane takes only jobs at this priority or more urgent */
    max_priority: z.number().int().min(0).max(999_999_999).optional(),
  })
  .strict();

const RoutingSchema = z
  .object({
    /** Lanes to overflow to when this lane has waiting jobs */
    overflow_to: z.array(laneName).max(16).default([]),
    /** Move to overflow lanes when they finish sooner */
    prefer_when_faster: z.boolean().default(false),
    /** Minimum gain in seconds to justify a prefer_when_faster move (default from placement) */
    min_gain_seconds: z.number().int().min(0).max(86_400).optional(),
  })
  .strict();

const HistorySchema = z
  .object({
    /** A tab-separated runner log, relative to gates_dir unless absolute */
    runner_log: z.string().min(1).max(1024).optional(),
    columns: z.array(z.enum(HISTORY_COLUMNS)).min(2).max(16).optional(),
    /** Matched in a result log's tail; the last match's first group is the run's seconds */
    duration_pattern: z.string().min(1).max(MAX_PATTERN).default("\\btime=(\\d+)s\\b"),
    samples: z.number().int().min(1).max(200).default(20),
  })
  .strict();

export const PlacementSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["observe", "act"]).default("observe"),
    interval_seconds: z.number().int().min(10).max(3600).default(60),
    probe_timeout_seconds: z.number().int().min(1).max(120).default(15),
    command_timeout_seconds: z.number().int().min(1).max(600).default(60),
    machines: z.record(name, MachineSchema).default({}),
    lanes: z.record(laneName, LaneSchema).default({}),
    routing: z.record(laneName, RoutingSchema).default({}),
    classes: z.record(name, z.array(pattern).min(1).max(32)).default({}),
    eligible: z.record(laneName, z.array(name).max(64)).default({}),
    prefer_quiet: z.array(pattern).max(32).default([]),
    quiet_margin: z.number().min(0).max(100).default(0.25),
    move_cmd: argv.optional(),
    max_moves_per_tick: z.number().int().min(0).max(50).default(2),
    min_gain_seconds: z.number().int().min(0).max(86_400).default(600),
    cooldown_seconds: z.number().int().min(0).max(7 * 86_400).default(1800),
    /** A job moved or tried this many times in 24 hours is held where it is */
    max_moves_per_job: z.number().int().min(1).max(100).default(3),
    default_seconds: z.number().int().min(1).max(7 * 86_400).default(1800),
    /** The request file's line where its command starts (the rest of the file is the command) */
    command_line: z.number().int().min(1).max(100).default(1),
    history: HistorySchema.default({}),
  })
  .strict();

export interface OnDemandSettings {
  stateCmd: string[];
  guardCmd: string[];
  bootSeconds: number;
  costPerHour?: number;
  checkSeconds: number;
  speedFactor: number;
}

export interface MachineSettings {
  id: string;
  probe: string[];
  expect?: string;
  loadCmd?: string[];
  cpus?: number;
  minUpSeconds: number;
  onDemand?: OnDemandSettings;
}

export interface RoutingSettings {
  /** Lanes to overflow to when this lane has waiting jobs */
  overflowTo: string[];
  /** Move to overflow lanes when they finish sooner */
  preferWhenFaster: boolean;
  /** Minimum gain in seconds to justify a prefer_when_faster move */
  minGainSeconds?: number;
}

export interface LaneSettings {
  name: string;
  machine: string;
  slots: number;
  limits: Record<string, number>;
  serves: string[];
  maxPriority?: number;
  /** The classes this lane can run (eligible.<lane>) */
  eligible: string[];
  /** Routing settings for this lane */
  routing: RoutingSettings;
}

export interface ClassSettings {
  name: string;
  patterns: RegExp[];
}

export interface HistorySettings {
  runnerLog?: string;
  columns: HistoryColumn[];
  durationPattern: RegExp;
  samples: number;
}

/** The parsed `placement:` block. */
export interface PlacementSettings {
  enabled: boolean;
  mode: "observe" | "act";
  intervalSeconds: number;
  probeTimeoutSeconds: number;
  commandTimeoutSeconds: number;
  machines: MachineSettings[];
  lanes: LaneSettings[];
  /** In the order written: the first class with a matching pattern is a job's class */
  classes: ClassSettings[];
  preferQuiet: RegExp[];
  quietMargin: number;
  moveCmd?: string[];
  maxMovesPerTick: number;
  minGainSeconds: number;
  /** The first cool-down; it doubles with every earlier move of the job in 24 hours */
  cooldownSeconds: number;
  maxMovesPerJob: number;
  defaultSeconds: number;
  commandLine: number;
  history: HistorySettings;
}

export type ParseResult =
  | { ok: true; settings: PlacementSettings }
  | { ok: false; errors: string[] };

/**
 * A pattern: `/regex/flags` (flags of i, m, s, u), else a glob where `*` is
 * any text (newlines too), `?` one character, and everything else literal.
 * A glob matches the whole text. Throws on an invalid regular expression.
 */
export function compilePattern(source: string): RegExp {
  const regex = /^\/(.+)\/([imsu]*)$/s.exec(source);
  if (regex) return new RegExp(regex[1], regex[2]);
  let body = "";
  for (const ch of source) {
    if (ch === "*") body += "[\\s\\S]*";
    else if (ch === "?") body += "[\\s\\S]";
    else body += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${body}$`);
}

/** Placeholders in an argv template, e.g. ["{id}", "x{to}"] -> id, to */
export function placeholdersIn(template: readonly string[]): string[] {
  const names = new Set<string>();
  for (const arg of template) {
    for (const match of arg.matchAll(/\{([A-Za-z_]+)\}/g)) names.add(match[1]);
  }
  return [...names];
}

/**
 * Fill move_cmd. A value that would turn an argument into an option (a
 * leading "-" where the template has none) is refused: values come from file
 * names in the queue.
 */
export function buildMoveArgv(
  template: readonly string[],
  vars: Record<string, string>,
): { argv: string[] } | { error: string } {
  for (const n of placeholdersIn(template)) {
    if (!(MOVE_PLACEHOLDERS as readonly string[]).includes(n)) {
      return { error: `placement.move_cmd: placeholder {${n}} is not allowed` };
    }
    if (vars[n] === undefined) return { error: `placement.move_cmd: no value for {${n}}` };
  }
  const out: string[] = [];
  for (const arg of template) {
    const filled = arg.replace(/\{([A-Za-z_]+)\}/g, (_, n: string) => vars[n] ?? "");
    if (filled.startsWith("-") && !arg.startsWith("-")) {
      return { error: `placement.move_cmd: the value in "${arg}" starts with "-" and would be read as an option` };
    }
    out.push(filled);
  }
  return { argv: out };
}

function compileAll(sources: string[], where: string, errors: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const source of sources) {
    try {
      out.push(compilePattern(source));
    } catch (e) {
      errors.push(`${where}: ${JSON.stringify(source)} is not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return out;
}

/** Validate a project's `placement:` block (undefined means disabled). */
export function parsePlacementConfig(raw: unknown): ParseResult {
  const parsed = PlacementSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `placement.${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const value = parsed.data;
  const errors: string[] = [];

  const classNames = new Set(Object.keys(value.classes));
  const classes: ClassSettings[] = Object.entries(value.classes).map(([n, sources]) => ({
    name: n,
    patterns: compileAll(sources, `placement.classes.${n}`, errors),
  }));
  const preferQuiet = compileAll(value.prefer_quiet, "placement.prefer_quiet", errors);

  const machines: MachineSettings[] = Object.entries(value.machines).map(([id, m]) => ({
    id,
    probe: m.probe,
    expect: m.expect,
    loadCmd: m.load_cmd,
    cpus: m.cpus,
    minUpSeconds: m.min_up_seconds,
    onDemand: m.on_demand
      ? {
          stateCmd: m.on_demand.state_cmd,
          guardCmd: m.on_demand.guard_cmd,
          bootSeconds: m.on_demand.boot_seconds,
          costPerHour: m.on_demand.cost_per_hour,
          checkSeconds: m.on_demand.check_seconds,
          speedFactor: m.on_demand.speed_factor,
        }
      : undefined,
  }));
  const machineIds = new Set(machines.map((m) => m.id));

  const lanes: LaneSettings[] = [];
  const laneNames = new Set(Object.keys(value.lanes));
  for (const [laneId, lane] of Object.entries(value.lanes)) {
    if (!machineIds.has(lane.machine)) {
      errors.push(`placement.lanes.${laneId}.machine: ${lane.machine} is not in placement.machines`);
    }
    for (const cls of Object.keys(lane.limits)) {
      if (!classNames.has(cls)) errors.push(`placement.lanes.${laneId}.limits: ${cls} is not in placement.classes`);
    }
    for (const served of lane.serves) {
      const target = value.lanes[served];
      if (!target) errors.push(`placement.lanes.${laneId}.serves: ${served} is not in placement.lanes`);
      else if (target.serves.length > 0) errors.push(`placement.lanes.${laneId}.serves: ${served} serves other lanes itself`);
      if (served === laneId) errors.push(`placement.lanes.${laneId}.serves: a lane can't serve itself`);
    }
    if (lane.max_priority !== undefined && lane.serves.length === 0) {
      errors.push(`placement.lanes.${laneId}.max_priority: only a lane with serves takes jobs by priority`);
    }
    const routing = value.routing[laneId] ?? { overflow_to: [], prefer_when_faster: false };
    for (const target of routing.overflow_to) {
      if (!laneNames.has(target)) {
        errors.push(`placement.routing.${laneId}.overflow_to: ${target} is not in placement.lanes`);
      }
      if (target === laneId) {
        errors.push(`placement.routing.${laneId}.overflow_to: a lane can't overflow to itself`);
      }
    }
    lanes.push({
      name: laneId,
      machine: lane.machine,
      slots: lane.slots,
      limits: lane.limits,
      serves: lane.serves,
      maxPriority: lane.max_priority,
      eligible: value.eligible[laneId] ?? [],
      routing: {
        overflowTo: routing.overflow_to,
        preferWhenFaster: routing.prefer_when_faster,
        minGainSeconds: routing.min_gain_seconds,
      },
    });
  }
  // Validate routing targets that reference lanes not yet parsed
  for (const [laneId] of Object.entries(value.routing)) {
    if (!laneNames.has(laneId)) {
      errors.push(`placement.routing.${laneId}: ${laneId} is not in placement.lanes`);
    }
  }
  for (const [laneId, list] of Object.entries(value.eligible)) {
    if (!value.lanes[laneId]) errors.push(`placement.eligible.${laneId}: ${laneId} is not in placement.lanes`);
    for (const cls of list) {
      if (!classNames.has(cls)) errors.push(`placement.eligible.${laneId}: ${cls} is not in placement.classes`);
    }
  }

  if (value.move_cmd) {
    for (const n of placeholdersIn(value.move_cmd)) {
      if (!(MOVE_PLACEHOLDERS as readonly string[]).includes(n)) {
        errors.push(
          `placement.move_cmd: unknown placeholder {${n}} (allowed: ${MOVE_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")})`,
        );
      }
    }
  }
  if (value.enabled) {
    if (lanes.length === 0) errors.push("placement.lanes: at least one lane is needed");
    if (value.mode === "act" && !value.move_cmd) errors.push("placement.mode is act but placement.move_cmd is not set");
  }

  let durationPattern = /\btime=(\d+)s\b/;
  try {
    durationPattern = new RegExp(value.history.duration_pattern);
    if (!/\((?!\?)/.test(value.history.duration_pattern)) {
      errors.push("placement.history.duration_pattern: needs a capture group for the seconds");
    }
  } catch (e) {
    errors.push(
      `placement.history.duration_pattern: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const columns: HistoryColumn[] = value.history.columns ?? ["time", "id", "rc", "command", "lane"];
  if (value.history.runner_log !== undefined) {
    for (const needed of ["id", "rc", "command", "lane"] as const) {
      if (columns.filter((c) => c === needed).length !== 1) {
        errors.push(`placement.history.columns: needs exactly one ${needed} column`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      mode: value.mode,
      intervalSeconds: value.interval_seconds,
      probeTimeoutSeconds: value.probe_timeout_seconds,
      commandTimeoutSeconds: value.command_timeout_seconds,
      machines,
      lanes,
      classes,
      preferQuiet,
      quietMargin: value.quiet_margin,
      moveCmd: value.move_cmd,
      maxMovesPerTick: value.max_moves_per_tick,
      minGainSeconds: value.min_gain_seconds,
      cooldownSeconds: value.cooldown_seconds,
      maxMovesPerJob: value.max_moves_per_job,
      defaultSeconds: value.default_seconds,
      commandLine: value.command_line,
      history: {
        runnerLog: value.history.runner_log,
        columns,
        durationPattern,
        samples: value.history.samples,
      },
    },
  };
}

/** Why act mode is off (observe mode, a read_only project), or null when it is on. */
export function actBlockedReason(config: ProjectConfig, settings: PlacementSettings): string | null {
  if (settings.mode !== "act") return "placement.mode is observe";
  if (config.read_only === true) return "the project is read_only";
  return null;
}
