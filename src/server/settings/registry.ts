/**
 * The Settings sections: one small entry per module (its block and the zod
 * schema its parser uses), and the core settings grouped by topic. The
 * forms are drawn from these alone (docs/design/settings-ui.md), so a new
 * module adds one entry here and nothing else; fields its schema gains later
 * appear by themselves.
 *
 * Hints are keyed by the field's path within the section ("*" for any record
 * key or list index). Most widgets are inferred (src/client/settings-form.ts),
 * so hints are help text and the occasional `advanced`.
 */
import type { ZodTypeAny } from "zod";
import type { FieldHint, JsonSchema, SettingsSection } from "../../shared/settings-types.js";
import { AgentsSchema } from "../agents/config.js";
import { DeliverySchema } from "../delivery/config.js";
import { ExecutorsSchema, PipelinesSchema } from "../gates/project-pipelines.js";
import { PlacementSchema } from "../placement/config.js";
import { ReviewSchema } from "../review/config.js";
import { TriageSchema } from "../triage/config.js";
import { WatchdogSchema } from "../watchdog/config.js";
import {
  AdaptersSchema,
  ControlsSchema,
  CoordinationSchema,
  DragonsSchema,
  MachinesSchema,
  ProcessesSchema,
  ProjectCoreSchema,
} from "./core-schemas.js";
import { toJsonSchema } from "./json-schema.js";

export interface SectionEntry {
  /** A module's top-level block; for a `root` section, the section's id */
  key: string;
  title: string;
  schema: ZodTypeAny;
  /** The schema describes top-level keys (core settings), not one block */
  root?: boolean;
  hints?: Record<string, FieldHint>;
  /** Anchor in docs/configuration.md */
  docs?: string;
}

const timeouts: FieldHint = { advanced: true };

export const SETTINGS_SECTIONS: readonly SectionEntry[] = [
  {
    key: "project",
    title: "Project",
    root: true,
    schema: ProjectCoreSchema,
    docs: "#required-fields",
    hints: {
      name: { help: "Display name" },
      repo: { help: "The repository's local path" },
      github: { help: "owner/name on GitHub" },
      queue_file: { help: "The status file agents append to" },
      agents_dir: { help: "Where agent logs (and dragons.txt) are" },
      gates_dir: { help: "Holds queue/ and results/ of the gate runner" },
    },
  },
  {
    key: "controls",
    title: "Controls",
    root: true,
    schema: ControlsSchema,
    docs: "#control-commands",
    hints: { read_only: { help: "Off lets the dashboard run the commands below (the owner only)" } },
  },
  {
    key: "dragons",
    title: "Dragons and models",
    root: true,
    schema: DragonsSchema,
    docs: "#dragons-agents",
    hints: {
      "dragons.*.adapter": { options: "adapters" },
      "dragons.*.machine": { options: "machines" },
      "dragons.*.instructions": { widget: "textarea" },
      default_instructions: { widget: "textarea" },
      dragon_start_cmd: { help: "Placeholders: {dragon}, {task}, {prompt_file}" },
    },
  },
  {
    key: "adapters",
    title: "Agent adapters",
    root: true,
    schema: AdaptersSchema,
    docs: "#agent-adapters",
    hints: { "agent_adapters.*.start_cmd": { help: "A template; placeholders such as {prompt_file}, {pid}" } },
  },
  {
    key: "machines",
    title: "Machines",
    root: true,
    schema: MachinesSchema,
    docs: "#machines",
    hints: {
      // Where Lair connects and runs gates and agents, as whom
      "machines.*.host": { sensitive: true },
      "machines.*.user": { sensitive: true },
      "machines.*.key": { widget: "path", sensitive: true, help: "The private key's path (never the key itself)" },
    },
  },
  { key: "processes", title: "Processes", root: true, schema: ProcessesSchema, docs: "#process-manager" },
  {
    key: "coordination",
    title: "Bus, merge bar and orchestrator",
    root: true,
    schema: CoordinationSchema,
    docs: "#fleet-bus",
    hints: { gate_runner: { advanced: true, help: "Not started by the server yet" } },
  },
  {
    key: "watchdog",
    title: "Watchdog",
    schema: WatchdogSchema,
    docs: "#watchdog",
    hints: {
      mode: { help: "observe reports only; act runs the playbooks" },
      agent_command: { help: "A regular expression on each process's command line; {agent} is the agent id" },
      command_timeout_seconds: timeouts,
      infra_window_minutes: timeouts,
      infra_min_tracks: timeouts,
    },
  },
  {
    key: "delivery",
    title: "Delivery",
    schema: DeliverySchema,
    docs: "#delivery",
    hints: {
      command_timeout_seconds: timeouts,
      build_timeout_seconds: timeouts,
      "environments.*.deploy.prepare_cmd": { help: "Placeholders: {sha}, {ref}, {environment}, {project}" },
      // What docker compose builds and runs, and the repository a deploy builds from
      "environments.*.compose_files": { sensitive: true },
      "environments.*.project_directory": { sensitive: true },
      "environments.*.deploy.repo": { sensitive: true },
    },
  },
  { key: "pipelines", title: "Gate pipelines", schema: PipelinesSchema, docs: "#gate-pipelines" },
  {
    key: "executors",
    title: "Gate executors",
    schema: ExecutorsSchema,
    docs: "#executor-options",
    hints: {
      "github.token_env": { help: "The variable that holds the token (never the token)" },
      "github.checkout_action": { sensitive: true, help: "Runs in CI with the repository's token" },
    },
  },
  {
    key: "review",
    title: "Reviews and merge",
    schema: ReviewSchema,
    docs: "#reviews-and-policy-merge",
    hints: {
      token_env: { help: "The variable that holds the token (never the token)" },
      reviewers: { help: "Per tier: human, peer, self or agent:<id>, or {any_of: [...], different_model: true}" },
      api_url: { advanced: true, sensitive: true, help: "Where the GitHub token is sent" },
      "merge.clone_url": { sensitive: true, help: "Where a local merge pushes" },
      "merge.check_cmd": { help: "Runs before each merge; non-zero refuses it. Placeholders: {pr}, {head}, {base}, {repo}" },
      "merge.auto": { sensitive: true, help: "Merge every PR the policy allows, one per scan, as lair:policy" },
      "merge.gate.from_triage": { help: "Also take the signed results triage accepted (verified again here)" },
    },
  },
  {
    key: "agents",
    title: "Agents",
    schema: AgentsSchema,
    docs: "#agents",
    hints: {
      env_passthrough: { help: "Names of variables an agent also gets from the server's environment" },
      "fallbacks.*.*.adapter": { options: "adapters" },
      pid_start_tolerance_seconds: timeouts,
      command_timeout_seconds: timeouts,
      "fill.tasks_file": { help: "Lines <agent>|<name>|<task>|<description>; relative to the repository" },
      "fill.prompt_files": { widget: "list", help: "Their contents, in order, make a run's prompt; {prompts_dir}, {agent}, {task}" },
      "fill.done_pattern": { advanced: true, help: "Matched against new queue lines; {task} and {agent} are replaced" },
      "fill.capacity_cmd": { help: "Exit 0: capacity available; anything else holds (its first output line is the reason)" },
    },
  },
  {
    key: "triage",
    title: "Triage",
    schema: TriageSchema,
    docs: "#triage",
    hints: {
      mode: { help: "observe reports only; act re-checks, routes and reverts" },
      "trusted_nodes.*.public_key_file": { widget: "path", help: "The node's Ed25519 public key (PEM)" },
      "recheck.capacity_cmd": { help: "Exits 0 when there is capacity for a re-check" },
      commands: { help: "argv per command; each lists its placeholders in docs/configuration.md#triage-commands" },
      infra_patterns: { advanced: true },
      context_patterns: { advanced: true },
      command_timeout_seconds: timeouts,
      base_max_age_hours: timeouts,
    },
  },
  {
    key: "placement",
    title: "Placement",
    schema: PlacementSchema,
    docs: "#placement",
    hints: {
      mode: { help: "observe says where each job would finish soonest; act moves it with move_cmd" },
      "machines.*.probe": { help: "Exit 0 (and stdout starting with expect, when set) means the machine answers" },
      "machines.*.load_cmd": { help: "Prints the 1-minute load first and the cpu count last" },
      move_cmd: { help: "Placeholders: {id}, {from}, {to}, {file}, {priority}, {project}" },
      probe_timeout_seconds: timeouts,
      command_timeout_seconds: timeouts,
      command_line: timeouts,
      history: { advanced: true },
    },
  },
];

function toSection(entry: SectionEntry): SettingsSection {
  const schema: JsonSchema = toJsonSchema(entry.schema);
  const root = entry.root === true;
  const blocks = root ? Object.keys(schema.properties ?? {}) : [entry.key];
  return {
    key: entry.key,
    title: entry.title,
    root,
    blocks,
    schema,
    hints: entry.hints ?? {},
    docs: entry.docs ? `docs/configuration.md${entry.docs}` : undefined,
    toggle: !root && schema.properties?.enabled?.type === "boolean",
  };
}

let cached: SettingsSection[] | null = null;

/** The sections as the forms read them (JSON Schema). */
export function settingsSections(entries: readonly SectionEntry[] = SETTINGS_SECTIONS): SettingsSection[] {
  if (entries !== SETTINGS_SECTIONS) return entries.map(toSection);
  cached ??= entries.map(toSection);
  return cached;
}

/** Every top-level key a section edits. */
export function ownedKeys(sections: readonly SettingsSection[] = settingsSections()): Set<string> {
  return new Set(sections.flatMap((s) => s.blocks));
}
