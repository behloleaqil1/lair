/**
 * The `supervisor:` block of a project config, validated with defaults
 * applied: the self-checks' settings (`supervisor.checks`), and the
 * supervisor's runs: its agent, its prompt, questions from the dashboard
 * (`supervisor.chat`) and the daily digest (`supervisor.digest`); see
 * docs/configuration.md#supervisor-self-checks-and-the-ops-api and
 * #supervisor-chat-and-digest.
 *
 * The server's own checks (event loop, latency, files, disk, stores,
 * command timeouts) follow the default project's block; a project's checks
 * follow its own.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import { CHECK_IDS, type CheckId } from "../../shared/supervisor-types.js";
import { parseAgentsConfig } from "../agents/config.js";
import { isValidPromptName, PROMPT_NAME_RULE } from "../agents/prompts.js";
import { roleAgents } from "../ai/profiles.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { knownDragonIds, loadKnownDragons } from "../services/dragon-registry.js";

const ms = (fallback: number) => z.number().int().min(1).max(600_000).default(fallback);
const percent = (fallback: number) => z.number().min(0).max(100).default(fallback);
const count = (fallback: number) => z.number().int().min(1).max(1_000_000).default(fallback);
const minutes = (fallback: number) => z.number().int().min(1).max(10_080).default(fallback);

const EventLoopSchema = z.object({ warning_ms: ms(200), failing_ms: ms(1000) }).strict();

const LatencySchema = z
  .object({
    warning_ms: ms(1000),
    failing_ms: ms(5000),
    /** Fewer requests in the window than this are too few to judge */
    min_requests: count(20),
    window_minutes: z.number().int().min(1).max(60).default(5),
  })
  .strict();

const OpenFilesSchema = z.object({ warning_percent: percent(70), failing_percent: percent(90) }).strict();

const DiskSchema = z
  .object({
    warning_percent: percent(10),
    failing_percent: percent(5),
    warning_gib: z.number().min(0).max(100_000).default(5),
    failing_gib: z.number().min(0).max(100_000).default(1),
  })
  .strict();

const StoreSchema = z
  .object({
    warning_mb: count(500),
    failing_mb: count(2000),
    wal_warning_mb: count(64),
    wal_failing_mb: count(512),
  })
  .strict();

const TimeoutsSchema = z
  .object({ window_minutes: z.number().int().min(1).max(1440).default(15), warning: count(3), failing: count(10) })
  .strict();

const HoldsSchema = z.object({ warning: count(1), failing: count(3) }).strict();

const MachinesSchema = z.object({ failing_minutes: minutes(10) }).strict();

const GateQueueSchema = z.object({ warning_minutes: minutes(60), failing_minutes: minutes(180) }).strict();

const RetentionSchema = z.object({ warning_entries: count(5000), failing_entries: count(20_000) }).strict();

export const ChecksSchema = z
  .object({
    enabled: z.boolean().default(true),
    interval_seconds: z.number().int().min(10).max(3600).default(60),
    /** A measure still running after this long reports unknown */
    timeout_seconds: z.number().int().min(1).max(120).default(10),
    /** A check failing this long raises one notice in the Decision Inbox */
    notice_minutes: z.number().int().min(1).max(1440).default(5),
    /** After a notice is withdrawn, the same check raises none again for this long */
    notice_cooldown_minutes: z.number().int().min(0).max(10_080).default(60),
    disabled: z.array(z.enum(CHECK_IDS)).max(CHECK_IDS.length).default([]),
    event_loop_lag: EventLoopSchema.default({}),
    request_latency: LatencySchema.default({}),
    open_files: OpenFilesSchema.default({}),
    disk_free: DiskSchema.default({}),
    store_size: StoreSchema.default({}),
    command_timeouts: TimeoutsSchema.default({}),
    infra_holds: HoldsSchema.default({}),
    machines: MachinesSchema.default({}),
    gate_queue_age: GateQueueSchema.default({}),
    retention: RetentionSchema.default({}),
  })
  .strict();

/** Questions from the dashboard, answered by supervisor runs (S1-2). Off by default */
export const ChatSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Supervisor runs (questions and digests) started in any 24 hours */
    max_runs_per_day: z.number().int().min(1).max(500).default(20),
    /** Between the starts of two supervisor runs */
    min_interval_seconds: z.number().int().min(0).max(86_400).default(30),
    /** Questions in one conversation; then a new one starts */
    max_conversation_turns: z.number().int().min(1).max(50).default(10),
    /** A question with no answer this long after it was asked is closed, and its run stopped */
    answer_timeout_minutes: z.number().int().min(1).max(240).default(15),
    /** The run answers by writing answer.json at the exact path Lair gives it, instead of with `lair supervisor answer` */
    answer_file: z.boolean().default(false),
  })
  .strict();

/** One digest a day, written by a supervisor run at `time` (local). Off by default */
export const DigestSchema = z
  .object({
    enabled: z.boolean().default(false),
    time: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "a local time of day, HH:MM (24 hours)")
      .default("08:00"),
  })
  .strict();

export const SupervisorSchema = z
  .object({
    checks: ChecksSchema.default({}),
    /** The supervisor agent (a dragon of the project); else the dragon on ai.roles.supervise's first profile */
    agent: z.string().min(1).max(100).optional(),
    /** The supervisor's prompt template, a file name in prompts_dir; else Lair's own (prompts/supervisor.md) */
    prompt_file: z.string().min(1).max(255).optional(),
    chat: ChatSchema.default({}),
    digest: DigestSchema.default({}),
  })
  .strict();

export type ChecksSettings = z.infer<typeof ChecksSchema>;
export type ChatSettings = z.infer<typeof ChatSchema>;
export type DigestSettings = z.infer<typeof DigestSchema>;

export interface SupervisorSettings {
  checks: ChecksSettings;
  agent: string | null;
  promptFile: string | null;
  chat: ChatSettings;
  digest: DigestSettings;
}

/**
 * The agent supervisor runs start on: supervisor.agent; else the first
 * dragon on a profile of ai.roles.supervise (in the role's order) that fill
 * doesn't start and isn't the planner agent. A reason when there is none.
 *
 * This is read when a run is about to start (and for the chat's status),
 * never as a config error: what it depends on is other modules' blocks
 * (agents, dragons, ai, planner), and a change there must never keep the
 * project's file from loading, or its self-checks from running.
 */
export function supervisorAgent(project: ProjectConfig, settings: Pick<SupervisorSettings, "agent">): { agent: string } | { problem: string } {
  const agents = parseAgentsConfig(project.agents, project);
  if (!agents.ok) return { problem: "the agents block has errors (GET /api/agents/status says which)" };
  if (!agents.settings.enabled) return { problem: "supervisor runs need agents.enabled: true" };
  const fill = agents.settings.fill.agents;
  const planner = plannerAgentOf(project);
  if (settings.agent) {
    if (!isValidDragonId(settings.agent)) return { problem: `supervisor.agent: ${settings.agent} is not a valid agent id` };
    if (!knownDragonIds(project).has(settings.agent)) return { problem: `supervisor.agent: ${settings.agent} is not one of the project's agents` };
    if (fill.includes(settings.agent)) {
      return { problem: `supervisor.agent: ${settings.agent} is in agents.fill.agents: the supervisor must not be an agent fill starts` };
    }
    if (planner === settings.agent) return { problem: `supervisor.agent: ${settings.agent} is the planner agent` };
    return { agent: settings.agent };
  }
  const candidates = roleAgents(project, "supervise", loadKnownDragons(project).values()).filter((id) => !fill.includes(id) && id !== planner);
  if (candidates.length > 0) return { agent: candidates[0] };
  return {
    problem:
      "no supervisor agent: set supervisor.agent to one of the project's agents, or give a dragon (not one fill starts) a profile of ai.roles.supervise",
  };
}

function plannerAgentOf(project: ProjectConfig): string | null {
  const planner: unknown = project.planner;
  if (typeof planner !== "object" || planner === null) return null;
  const agent = (planner as { agent?: unknown }).agent;
  if (typeof agent !== "object" || agent === null) return null;
  const id = (agent as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

export type ParseResult = { ok: true; settings: SupervisorSettings } | { ok: false; errors: string[] };

/** A warning threshold must come before its failing one. */
function orderErrors(c: ChecksSettings): string[] {
  const errors: string[] = [];
  const above = (path: string, warning: number, failing: number) => {
    if (warning > failing) errors.push(`supervisor.checks.${path}: the warning threshold (${warning}) is above the failing one (${failing})`);
  };
  const below = (path: string, warning: number, failing: number) => {
    if (warning < failing) errors.push(`supervisor.checks.${path}: the warning threshold (${warning}) is below the failing one (${failing})`);
  };
  above("event_loop_lag", c.event_loop_lag.warning_ms, c.event_loop_lag.failing_ms);
  above("request_latency", c.request_latency.warning_ms, c.request_latency.failing_ms);
  above("open_files", c.open_files.warning_percent, c.open_files.failing_percent);
  below("disk_free (percent)", c.disk_free.warning_percent, c.disk_free.failing_percent);
  below("disk_free (GiB)", c.disk_free.warning_gib, c.disk_free.failing_gib);
  above("store_size", c.store_size.warning_mb, c.store_size.failing_mb);
  above("store_size (WAL)", c.store_size.wal_warning_mb, c.store_size.wal_failing_mb);
  above("command_timeouts", c.command_timeouts.warning, c.command_timeouts.failing);
  above("infra_holds", c.infra_holds.warning, c.infra_holds.failing);
  above("gate_queue_age", c.gate_queue_age.warning_minutes, c.gate_queue_age.failing_minutes);
  above("retention", c.retention.warning_entries, c.retention.failing_entries);
  return errors;
}

/**
 * Parse a project's `supervisor:` block (absent: every default). Only the
 * block itself is checked (its keys, types, ranges, threshold order and the
 * prompt file's name): whether supervisor runs can start (an agent, the
 * agents module on) depends on other blocks, so it is no config error but
 * the chat's `problem` (supervisorAgent(), read when a run would start).
 */
export function parseSupervisorConfig(raw: unknown): ParseResult {
  const parsed = SupervisorSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `supervisor.${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  const value = parsed.data;
  const errors = orderErrors(value.checks);
  if (value.prompt_file !== undefined && !isValidPromptName(value.prompt_file)) {
    errors.push(`supervisor.prompt_file: ${PROMPT_NAME_RULE} (a file directly in prompts_dir)`);
  }
  const settings: SupervisorSettings = {
    checks: value.checks,
    agent: value.agent ?? null,
    promptFile: value.prompt_file ?? null,
    chat: value.chat,
    digest: value.digest,
  };
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, settings };
}

/**
 * When the block is invalid elsewhere (a mistake under chat, digest, agent or
 * prompt_file), the self-checks still run on `supervisor.checks` when that
 * part is valid, with questions and the digest off. Null when the checks'
 * own part is invalid.
 */
export function checksOnlySettings(raw: unknown): SupervisorSettings | null {
  const checks = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as { checks?: unknown }).checks : undefined;
  const parsed = parseSupervisorConfig(checks === undefined ? {} : { checks });
  return parsed.ok ? parsed.settings : null;
}

/** Every default (a project without the block, or one whose block is invalid, for the server's checks). */
export function defaultSupervisorSettings(): SupervisorSettings {
  const parsed = parseSupervisorConfig(undefined);
  if (!parsed.ok) throw new Error("the supervisor defaults are invalid");
  return parsed.settings;
}

export function checkDisabled(settings: ChecksSettings, id: CheckId): boolean {
  return settings.disabled.includes(id);
}
