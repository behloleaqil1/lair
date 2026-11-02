/**
 * The Settings sections: one small entry per module (its block and the zod
 * schema its parser uses), and the core settings grouped by topic. The
 * forms are drawn from these alone (docs/design/settings-ui.md), so a new
 * module adds one entry here and nothing else; fields its schema gains later
 * appear by themselves.
 *
 * Hints are keyed by the field's path within the section ("*" for any record
 * key or list index). Most widgets are inferred (src/client/settings-form.ts),
 * so hints are a label, help text, an example and a level: basic fields show
 * by default, advanced and expert ones are folded (docs/design/settings-v2.md).
 * The Settings search finds a field by its label, help or key.
 */
import type { ZodTypeAny } from "zod";
import type { FieldHint, JsonSchema, SettingsSection } from "../../shared/settings-types.js";
import { AgentsSchema } from "../agents/config.js";
import { AiSchema } from "../ai/config.js";
import { DeliverySchema } from "../delivery/config.js";
import { ExecutorsSchema, PipelinesSchema } from "../gates/project-pipelines.js";
import { PlacementSchema } from "../placement/config.js";
import { CloudSchema } from "../cloud/config.js";
import { ReviewSchema } from "../review/config.js";
import { SupervisorSchema } from "../supervisor/config.js";
import { TrackerSchema } from "../tracker/config.js";
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

const timeouts: FieldHint = { level: "advanced", group: "Timeouts" };

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
      dragons: { label: "Agents", help: "The project's agents (dragons), by id" },
      "dragons.*.name": { label: "Name" },
      "dragons.*.adapter": { label: "Tool", options: "adapters", help: "The tool it runs on, when it names no profile" },
      "dragons.*.model": { label: "Model", help: "The model it runs, when it names no profile", example: "claude-opus-4.5" },
      "dragons.*.machine": { label: "Machine", options: "machines" },
      "dragons.*.profile": { label: "AI profile", options: "profiles", help: "An AI profile (ai.profiles), instead of adapter and model" },
      "dragons.*.instructions": { label: "Instructions", widget: "textarea" },
      default_instructions: { widget: "textarea" },
      dragon_defaults: { level: "advanced" },
      available_models: { level: "advanced" },
      dragon_start_cmd: { help: "Placeholders: {dragon}, {task}, {prompt_file}" },
    },
  },
  {
    key: "ai",
    title: "AI tools, profiles and roles",
    schema: AiSchema,
    docs: "#ai-tools-profiles-and-roles",
    hints: {
      profiles: { label: "Profiles", group: "Profiles", help: "Named tool + model: a dragon or a role names one" },
      "profiles.*.tool": {
        label: "Tool",
        options: "adapters",
        help: "A built-in tool (kiro, claude-code, codex, ...) or one of agent_adapters",
        example: "kiro",
      },
      "profiles.*.model": {
        label: "Model",
        help: "Any model the tool offers (GET /api/ai/models lists them)",
        example: "claude-opus-4.5",
      },
      // Added to what Lair starts: confirmed like a command
      "profiles.*.options.args": {
        label: "Extra arguments",
        level: "advanced",
        sensitive: true,
        help: "Literal arguments added to the tool's start command",
      },
      roles: { label: "Roles", group: "Roles", help: "Per job, profile ids in order: the first is used, the next ones are its fallbacks" },
      "roles.build": { label: "Who builds", group: "Roles", help: "Dragons that name no profile, adapter or model run on this" },
      "roles.review": {
        label: "Who reviews",
        group: "Roles",
        help: "A tier's reviewer pool with no agents of its own takes the agents on these profiles",
      },
      "roles.review.red": { label: "Reviewer for RED", group: "Roles", help: "Who reviews the riskiest changes, the strongest first" },
      "roles.review.amber": { label: "Reviewer for AMBER", group: "Roles", help: "Who reviews changes of the default tier" },
      "roles.review.green": { label: "Reviewer for GREEN", group: "Roles", help: "Who reviews low-risk changes" },
      "roles.plan": { label: "Who plans", group: "Roles", help: "The planner agent's profile, when it names none" },
      "roles.supervise": {
        label: "Who supervises",
        group: "Roles",
        help: "The supervisor's runs (questions, the digest), when supervisor.agent names no profile",
      },
    },
  },
  {
    key: "adapters",
    title: "Agent adapters",
    root: true,
    schema: AdaptersSchema,
    docs: "#agent-adapters",
    hints: {
      "agent_adapters.*.start_cmd": { help: "A template; placeholders such as {prompt_file}, {pid}" },
      "agent_adapters.*.models_cmd": { help: "Lists the tool's models (no placeholders); read by models_parser" },
      "agent_adapters.*.auth_check_cmd": { help: "Exits 0 when the tool is signed in (no placeholders)" },
      "agent_adapters.*.login_hint": { help: "The command you run in a terminal to sign in (Lair never runs it)" },
    },
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
  {
    key: "cloud",
    title: "Cloud machines",
    schema: CloudSchema,
    docs: "#cloud-machines",
    hints: {
      // Which account and instance Lair acts on, and how much it may spend: a change is confirmed like a command
      "machines.*.profile": {
        sensitive: true,
        help: "A named profile in your AWS config files; credentials never go in the project file",
      },
      "machines.*.instance": { sensitive: true, help: "Lair acts on this instance only while it carries the tag" },
      "machines.*.price_per_hour": { help: "Rounded up; the meter counts every run at this price" },
      "budget.limit": {
        sensitive: true,
        help: "No start at or above this spend (US dollars); change it here and in the provider's budget together. A higher limit does not clear a trip: the owner does, in Machines",
      },
      "budget.period": { sensitive: true, help: "The days the limit covers (UTC); a new period does not clear a trip: only the owner does, in Machines" },
      "budget.meter_start": { help: "Spend before the meter's first run" },
      "budget.spend_check_hours": { help: "How old the provider's cost reading may be (1 to 24 hours); each reading may cost money" },
      request_timeout_seconds: timeouts,
    },
  },
  {
    key: "tracker",
    title: "Tracker: GitHub issues, boards and milestones",
    schema: TrackerSchema,
    docs: "#tracker",
    hints: {
      mode: { help: "observe records what it would change on GitHub and sends nothing; act creates and closes issues, moves cards and closes milestones" },
      repos: { help: "The repositories it tracks; a task goes to the one its line names (repo:owner/name), else the first whose match takes it, else the default" },
      "repos.*.repo": { sensitive: true, help: "owner/name: the tracker writes to this repository in act mode" },
      "repos.*.project": { help: "Its Projects board: the user or organization that owns it, and the number in the board's URL" },
      "repos.*.match.tasks": { help: "Task id globs (* and ?) this repository takes" },
      "repos.*.milestones.rules": { advanced: true, help: "Issues created for these tasks go in this existing milestone (Lair never sets due dates)" },
      "repos.*.redact_patterns": { help: "Regular expressions removed from this repository's texts only (e.g. a private name a public repository must never see), after the project-wide ones" },
      "repos.*.create_issues": { help: "Create issues in this repository for tasks with none (default: create_issues_for_new_tasks): on for a private repository, off for a public one" },
      create_issues_for_new_tasks: { help: "A task with no issue gets one (act mode); otherwise only issues it names or with its exact title are linked" },
      auto_link: { help: "Link the issue a reconcile proposes for a task (one candidate only) without asking, in act mode; off: proposals wait in the status for the owner" },
      redact_patterns: { help: "Regular expressions removed from every text sent to GitHub, after the built-in ones (paths, tokens, emails, addresses)" },
      token_env: { sensitive: true, help: "The env var holding the GitHub token; default: review.token_env, else GITHUB_TOKEN" },
      api_url: { sensitive: true, advanced: true, help: "https only: the token is sent to it" },
      reconcile_interval_seconds: { advanced: true },
      write_budget_per_minute: { advanced: true },
      request_timeout_seconds: timeouts,
    },
  },
  {
    key: "supervisor",
    title: "Supervisor: self-checks, questions and the digest",
    schema: SupervisorSchema,
    docs: "#supervisor-self-checks-and-the-ops-api",
    hints: {
      "checks.enabled": { help: "Lair checks itself on a schedule; Home → Health shows the results" },
      "checks.notice_minutes": { help: "A check failing this long raises one notice in the Decision Inbox" },
      "checks.disabled": { help: "Check ids to skip" },
      "checks.timeout_seconds": timeouts,
      "checks.notice_cooldown_minutes": { advanced: true },
      agent: { help: "The agent supervisor runs start on; empty: the dragon on ai.roles.supervise's first profile" },
      prompt_file: { help: "The supervisor's prompt, a file in prompts_dir; empty: Lair's own" },
      "chat.enabled": { help: "Questions from the Ask box are answered by supervisor runs (each one costs a run)" },
      "chat.max_runs_per_day": { help: "Supervisor runs (questions and digests) in any 24 hours" },
      "chat.answer_timeout_minutes": { help: "A question with no answer by then is closed and its run stopped" },
      "chat.min_interval_seconds": { advanced: true },
      "chat.max_conversation_turns": { advanced: true },
      "chat.answer_file": { help: "The run answers by writing answer.json where Lair says, not with the lair CLI", advanced: true },
      "digest.enabled": { help: "A supervisor run writes a digest once a day; Home shows the latest" },
      "digest.time": { help: "When, in this machine's local time (HH:MM)" },
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
