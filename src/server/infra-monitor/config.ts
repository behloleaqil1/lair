/**
 * The `infra_monitor:` block of a project file, parsed and checked
 * (docs/configuration.md#infrastructure-monitor). Off by default; observe
 * mode by default.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";

/** A lane name as the gate parser reads it from a request file (parsers/gates.ts) */
const LANE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MACHINE = /^[a-z][a-z0-9_-]{0,39}$/;
/** A runner pid file in gates_dir: a plain name, no directory */
const PID_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.pid$/;

/** The placeholders requeue_cmd may use: the job's id, its lane and the lane it goes to. */
export const REQUEUE_PLACEHOLDERS = ["id", "from", "to"] as const;
const PLACEHOLDER = /\{([A-Za-z_]+)\}/g;

const Argv = z
  .array(z.string().min(1).max(4096))
  .min(1)
  .max(64)
  .refine((argv) => !argv[0].startsWith("-"), "the program (first element) must not start with '-'");

/** A probe: an argv, or { argv, expect } where stdout must contain `expect` */
const Probe = z.preprocess(
  (v) => (Array.isArray(v) ? { argv: v } : v),
  z
    .object({ argv: Argv, expect: z.string().min(1).max(200).optional() })
    .strict()
    .transform((p) => ({ argv: p.argv, expect: p.expect ?? null })),
);

const Machine = z
  .object({
    probes: z.array(Probe).min(1).max(5),
    start_grace_seconds: z.number().int().min(0).max(7200).optional(),
  })
  .strict();

const Lane = z
  .object({
    machine: z.string().regex(MACHINE, "a machine id: lowercase letters, digits, '_' and '-'"),
    slots: z.number().int().min(1).max(16).default(1),
    runner_pid_files: z.array(z.string().regex(PID_FILE, "a file name in gates_dir ending in .pid")).max(16).default([]),
    requeue_to: z.array(z.string().regex(LANE)).max(8).default([]),
  })
  .strict();

const Block = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["observe", "act"]).default("observe"),
    interval_seconds: z.number().int().min(10).max(3600).default(60),
    down_threshold_seconds: z.number().int().min(30).max(3600).default(120),
    probe_timeout_seconds: z.number().int().min(1).max(120).default(15),
    machines: z.record(z.string().regex(MACHINE, "a machine id: lowercase letters, digits, '_' and '-'"), Machine).default({}),
    lanes: z.record(z.string().regex(LANE, "a lane name"), Lane).default({}),
    requeue_cmd: Argv.nullable().default(null),
    requeue_timeout_seconds: z.number().int().min(1).max(900).default(120),
    requeue_max_attempts: z.number().int().min(1).max(5).default(2),
    requeue_backoff_seconds: z.number().int().min(30).max(3600).default(300),
  })
  .strict();

export interface ProbeSettings {
  argv: string[];
  /** Text the probe's stdout must contain, or null (exit 0 is enough) */
  expect: string | null;
}

export interface MachineSettings {
  id: string;
  probes: ProbeSettings[];
  /** A job counts as under this machine only once it ran this long, unless the machine was seen up during it */
  startGraceSeconds: number;
}

export interface LaneSettings {
  name: string;
  machine: string;
  slots: number;
  runnerPidFiles: string[];
  requeueTo: string[];
}

export interface InfraMonitorSettings {
  enabled: boolean;
  mode: "observe" | "act";
  intervalSeconds: number;
  downThresholdSeconds: number;
  probeTimeoutSeconds: number;
  machines: MachineSettings[];
  lanes: LaneSettings[];
  requeueCmd: string[] | null;
  requeueTimeoutSeconds: number;
  requeueMaxAttempts: number;
  requeueBackoffSeconds: number;
}

export type ParseResult = { ok: true; settings: InfraMonitorSettings } | { ok: false; errors: string[] };

function placeholdersIn(template: readonly string[]): string[] {
  const names = new Set<string>();
  for (const arg of template) for (const m of arg.matchAll(PLACEHOLDER)) names.add(m[1]);
  return [...names];
}

/** Parse and check `infra_monitor:`. An absent block is the defaults: off. */
export function parseInfraMonitorConfig(raw: unknown): ParseResult {
  const parsed = Block.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `infra_monitor.${i.path.join(".") || "(block)"}: ${i.message}`),
    };
  }
  const b = parsed.data;
  const errors: string[] = [];
  const machines: MachineSettings[] = Object.entries(b.machines).map(([id, m]) => ({
    id,
    probes: m.probes,
    startGraceSeconds: m.start_grace_seconds ?? b.down_threshold_seconds,
  }));
  const machineIds = new Set(machines.map((m) => m.id));
  const lanes: LaneSettings[] = Object.entries(b.lanes).map(([name, l]) => ({
    name,
    machine: l.machine,
    slots: l.slots,
    runnerPidFiles: l.runner_pid_files,
    requeueTo: l.requeue_to,
  }));
  const laneNames = new Set(lanes.map((l) => l.name));
  for (const lane of lanes) {
    if (!machineIds.has(lane.machine)) {
      errors.push(`infra_monitor.lanes.${lane.name}.machine: no machine "${lane.machine}" under infra_monitor.machines`);
    }
    for (const to of lane.requeueTo) {
      if (to === lane.name) errors.push(`infra_monitor.lanes.${lane.name}.requeue_to: a lane can't re-queue to itself`);
      else if (!laneNames.has(to)) errors.push(`infra_monitor.lanes.${lane.name}.requeue_to: no lane "${to}" under infra_monitor.lanes`);
    }
  }
  // Watching nothing would look the same as watching healthy machines
  if (b.enabled && lanes.length === 0) {
    errors.push("infra_monitor.lanes: name at least one lane and its machine, or the monitor watches nothing");
  }
  if (b.requeue_cmd) {
    for (const n of placeholdersIn(b.requeue_cmd)) {
      if (!(REQUEUE_PLACEHOLDERS as readonly string[]).includes(n)) {
        errors.push(`infra_monitor.requeue_cmd: unknown placeholder {${n}} (allowed: {id}, {from}, {to})`);
      }
    }
    if (placeholdersIn([b.requeue_cmd[0]]).length > 0) errors.push("infra_monitor.requeue_cmd: the program can't be a placeholder");
    const used = placeholdersIn(b.requeue_cmd);
    if (!used.includes("id") || !used.includes("to")) errors.push("infra_monitor.requeue_cmd: must pass {id} and {to}");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      enabled: b.enabled,
      mode: b.mode,
      intervalSeconds: b.interval_seconds,
      downThresholdSeconds: b.down_threshold_seconds,
      probeTimeoutSeconds: b.probe_timeout_seconds,
      machines,
      lanes,
      requeueCmd: b.requeue_cmd,
      requeueTimeoutSeconds: b.requeue_timeout_seconds,
      requeueMaxAttempts: b.requeue_max_attempts,
      requeueBackoffSeconds: b.requeue_backoff_seconds,
    },
  };
}

/** Why act mode does nothing for this project, or null when it acts. */
export function actBlockedReason(config: ProjectConfig, settings: InfraMonitorSettings): string | null {
  if (settings.mode !== "act") return "infra_monitor.mode is observe: findings are shown, nothing is raised or run";
  if (config.read_only === true) return "the project is read_only";
  return null;
}

/**
 * Fill requeue_cmd. Each value is substituted once (no value is read as a
 * template), and a value that would turn an argument into an option (a
 * leading "-" where the template has none) is refused: ids come from file
 * names in the queue.
 */
export function buildRequeueArgv(
  template: readonly string[],
  vars: { id: string; from: string; to: string },
): { argv: string[] } | { error: string } {
  const values: Record<string, string> = vars;
  for (const n of placeholdersIn(template)) {
    if (!Object.hasOwn(values, n)) return { error: `requeue_cmd: no value for {${n}}` };
  }
  const argv: string[] = [];
  for (const arg of template) {
    const filled = arg.replace(PLACEHOLDER, (_, n: string) => values[n]);
    if (filled.startsWith("-") && !arg.startsWith("-")) {
      return { error: `requeue_cmd: the value in "${arg}" starts with "-" and would be read as an option` };
    }
    argv.push(filled);
  }
  return { argv };
}
