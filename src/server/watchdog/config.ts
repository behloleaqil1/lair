/**
 * The `watchdog:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#watchdog.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import {
  ACTION_IDS,
  ACTION_PLACEHOLDERS,
  DETECTOR_IDS,
  PLAYBOOK_IDS,
  type ActionId,
  type DetectorId,
  type PlaybookId,
  type PlaybookSettings,
} from "./types.js";
import { BUILTIN_PLAYBOOKS } from "./playbooks.js";

const argv = z.array(z.string().min(1)).min(1);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const LockSchema = z
  .object({
    name: z.string().regex(SAFE_NAME, "lock names use letters, digits, '.', '_' and '-'"),
    /** A lock directory or a lock file */
    path: z.string().min(1),
    /** For a lock directory: the file inside it that holds the holder's pid */
    pid_file: z.string().regex(SAFE_NAME).default("pid"),
    lease_minutes: z.number().positive().default(30),
  })
  .strict();

const ContainerSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    max_restarts: z.number().int().positive().default(3),
    window_minutes: z.number().positive().default(10),
  })
  .strict();

const PlaybookSettingsSchema = z
  .object({
    act: z.boolean().default(false),
    max_attempts: z.number().int().min(1).max(10).optional(),
    cooldown_minutes: z.number().min(0).optional(),
    verify_delay_seconds: z.number().min(0).max(600).optional(),
  })
  .strict();

const actionsShape = Object.fromEntries(
  ACTION_IDS.map((id) => [id, argv.optional()]),
) as Record<ActionId, z.ZodOptional<typeof argv>>;

const playbooksShape = Object.fromEntries(
  PLAYBOOK_IDS.map((id) => [id, PlaybookSettingsSchema.optional()]),
) as Record<PlaybookId, z.ZodOptional<typeof PlaybookSettingsSchema>>;

const WatchdogSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["observe", "act"]).default("observe"),
    interval_seconds: z.number().int().min(5).max(3600).default(60),
    command_timeout_seconds: z.number().int().min(1).max(3600).default(120),
    /**
     * Regular expression matched against each process's command line; {agent}
     * stands for the agent id. Without it the process-based detectors
     * (duplicate_agent, agent_hung, orphan_claim) are inactive.
     */
    agent_command: z.string().min(1).optional(),
    hung_minutes: z.number().positive().default(45),
    claim_grace_minutes: z.number().min(0).default(5),
    max_agents: z.number().int().positive().optional(),
    idle_minutes: z.number().positive().default(10),
    stall_hours: z.number().positive().default(4),
    gate_lease_minutes: z.number().positive().default(30),
    infra_window_minutes: z.number().positive().default(60),
    infra_min_tracks: z.number().int().min(2).default(3),
    ready_tasks_cmd: argv.optional(),
    merged_cmd: argv.optional(),
    docker_cmd: argv.default(["docker"]),
    escalation_file: z.string().min(1).optional(),
    disabled_detectors: z.array(z.enum(DETECTOR_IDS)).default([]),
    locks: z.array(LockSchema).default([]),
    containers: z.array(ContainerSchema).default([]),
    actions: z.object(actionsShape).strict().default({}),
    playbooks: z.object(playbooksShape).strict().default({}),
  })
  .strict();

type RawSettings = z.infer<typeof WatchdogSchema>;

export interface LockSettings {
  name: string;
  path: string;
  pidFile: string;
  leaseMinutes: number;
}

export interface ContainerSettings {
  name: string;
  maxRestarts: number;
  windowMinutes: number;
}

/** The parsed `watchdog:` block. */
export interface WatchdogSettings {
  enabled: boolean;
  mode: "observe" | "act";
  intervalSeconds: number;
  commandTimeoutSeconds: number;
  agentCommand?: string;
  hungMinutes: number;
  claimGraceMinutes: number;
  maxAgents?: number;
  idleMinutes: number;
  stallHours: number;
  gateLeaseMinutes: number;
  infraWindowMinutes: number;
  infraMinTracks: number;
  readyTasksCmd?: string[];
  mergedCmd?: string[];
  dockerCmd: string[];
  escalationFile?: string;
  disabledDetectors: DetectorId[];
  locks: LockSettings[];
  containers: ContainerSettings[];
  actions: Partial<Record<ActionId, string[]>>;
  playbooks: Record<PlaybookId, PlaybookSettings>;
}

export type ParseResult =
  | { ok: true; settings: WatchdogSettings }
  | { ok: false; errors: string[] };

/** Placeholders in an argv template, e.g. ["{agent}", "x{pid}"] -> agent, pid */
export function placeholdersIn(template: string[]): string[] {
  const names = new Set<string>();
  for (const arg of template) {
    for (const match of arg.matchAll(/\{([A-Za-z_]+)\}/g)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

/**
 * Turn an agent_command pattern into a RegExp for one agent. The id is
 * escaped and bounded, so "worker-a" does not match "worker-ab".
 */
export function agentMatcher(pattern: string, agentId: string): RegExp {
  const escaped = agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bounded = `(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`;
  return new RegExp(pattern.split("{agent}").join(bounded));
}

/** Validate a project's `watchdog:` block (undefined means disabled). */
export function parseWatchdogConfig(raw: unknown): ParseResult {
  const parsed = WatchdogSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `watchdog.${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const value: RawSettings = parsed.data;
  const errors: string[] = [];

  if (value.agent_command !== undefined) {
    if (!value.agent_command.includes("{agent}")) {
      errors.push("watchdog.agent_command: must contain {agent}");
    } else {
      try {
        agentMatcher(value.agent_command, "probe-id");
      } catch (e) {
        errors.push(
          `watchdog.agent_command: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }
  }

  for (const id of ACTION_IDS) {
    const template = value.actions[id];
    if (!template) continue;
    const allowed = new Set<string>([...ACTION_PLACEHOLDERS[id], "project"]);
    for (const name of placeholdersIn(template)) {
      if (!allowed.has(name)) {
        errors.push(
          `watchdog.actions.${id}: unknown placeholder {${name}} (allowed: ${[...allowed].map((n) => `{${n}}`).join(", ")})`,
        );
      }
    }
  }

  const lockNames = new Set<string>();
  for (const lock of value.locks) {
    if (lockNames.has(lock.name)) {
      errors.push(`watchdog.locks: duplicate lock name ${lock.name}`);
    }
    lockNames.add(lock.name);
  }

  const playbooks = {} as Record<PlaybookId, PlaybookSettings>;
  for (const playbook of BUILTIN_PLAYBOOKS) {
    const given = value.playbooks[playbook.id];
    const settings: PlaybookSettings = {
      act: given?.act ?? playbook.defaults.act,
      maxAttempts: given?.max_attempts ?? playbook.defaults.maxAttempts,
      cooldownMinutes: given?.cooldown_minutes ?? playbook.defaults.cooldownMinutes,
      verifyDelaySeconds:
        given?.verify_delay_seconds ?? playbook.defaults.verifyDelaySeconds,
    };
    playbooks[playbook.id] = settings;
    if (settings.act) {
      for (const step of playbook.steps) {
        if (step.action && !value.actions[step.action]) {
          errors.push(
            `watchdog.playbooks.${playbook.id}.act is true but watchdog.actions.${step.action} is not set`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      mode: value.mode,
      intervalSeconds: value.interval_seconds,
      commandTimeoutSeconds: value.command_timeout_seconds,
      agentCommand: value.agent_command,
      hungMinutes: value.hung_minutes,
      claimGraceMinutes: value.claim_grace_minutes,
      maxAgents: value.max_agents,
      idleMinutes: value.idle_minutes,
      stallHours: value.stall_hours,
      gateLeaseMinutes: value.gate_lease_minutes,
      infraWindowMinutes: value.infra_window_minutes,
      infraMinTracks: value.infra_min_tracks,
      readyTasksCmd: value.ready_tasks_cmd,
      mergedCmd: value.merged_cmd,
      dockerCmd: value.docker_cmd,
      escalationFile: value.escalation_file,
      disabledDetectors: value.disabled_detectors,
      locks: value.locks.map((lock) => ({
        name: lock.name,
        path: lock.path,
        pidFile: lock.pid_file,
        leaseMinutes: lock.lease_minutes,
      })),
      containers: value.containers.map((c) => ({
        name: c.name,
        maxRestarts: c.max_restarts,
        windowMinutes: c.window_minutes,
      })),
      actions: value.actions,
      playbooks,
    },
  };
}

/**
 * Whether act mode is in effect: mode act and the project is not read_only.
 * Returns the reason when it is not.
 */
export function actBlockedReason(
  config: ProjectConfig,
  settings: WatchdogSettings,
): string | null {
  if (settings.mode !== "act") {
    return "watchdog.mode is observe";
  }
  if (config.read_only === true) {
    return "the project is read_only";
  }
  return null;
}
