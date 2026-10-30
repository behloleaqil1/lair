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
import { ReviewSchema } from "../review/config.js";
import { SupervisorSchema } from "../supervisor/config.js";
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
  {
    key: "pipelines",
    title: "Gate pipelines",
    schema: PipelinesSchema,
    docs: "#gate-pipelines",
    hints: {
      "*": { label: "Pipeline", help: "A named pipeline with steps and lanes" },
      "*.timeout_minutes": { label: "Timeout", help: "Maximum time for the whole pipeline" },
      "*.lanes": { label: "Lanes", help: "Per-lane executor configuration" },
      "*.lanes.*.executors": { label: "Executors", help: "Executor order for this lane" },
      "*.steps": { label: "Steps", help: "The commands that run, in order" },
      "*.steps.*.name": { label: "Step name", help: "Identifier for the step" },
      "*.steps.*.run": { label: "Command", help: "The command to run (argv, one argument per item)" },
      "*.steps.*.lane": { label: "Lane", help: "Which lane runs this step (default: default)" },
      "*.steps.*.timeout_minutes": { label: "Step timeout", help: "Maximum time for this step" },
      "*.steps.*.continue_on_failure": { label: "Continue on failure", help: "Keep running later steps even if this one fails" },
      "*.steps.*.env": { label: "Environment", help: "Extra environment variables for this step" },
    },
  },
  {
    key: "executors",
    title: "Gate executors",
    schema: ExecutorsSchema,
    docs: "#executor-options",
    hints: {
      order: { label: "Executor order", help: "The order to try executors (github, local, nodes)" },
      retry_seconds: { label: "Retry interval", level: "advanced", help: "Seconds between tries while no executor can take a job" },
      github: { label: "GitHub Actions", group: "GitHub", help: "Run gates on GitHub Actions" },
      "github.repo": { label: "Repository", group: "GitHub", help: "owner/name; default: the project's github" },
      "github.token_env": { label: "Token variable", group: "GitHub", help: "The environment variable that holds the token (never the token)" },
      "github.workflow": { label: "Workflow file", group: "GitHub", help: "File name under .github/workflows/" },
      "github.hosted": { label: "Use hosted runners", group: "GitHub", help: "Run on GitHub-hosted runners" },
      "github.hosted_runs_on": { label: "Hosted runner label", group: "GitHub", help: "The runs-on label for hosted runners" },
      "github.self_hosted": { label: "Use self-hosted runners", group: "GitHub", help: "Run on self-hosted runners" },
      "github.self_hosted_labels": { label: "Self-hosted labels", group: "GitHub", help: "Labels to match self-hosted runners" },
      "github.monthly_minutes": { label: "Monthly minutes", group: "GitHub", help: "GitHub-hosted minutes a private repository may use per month (0: none)" },
      "github.pickup_timeout_minutes": { label: "Pickup timeout", group: "GitHub", level: "advanced", help: "How long to wait for a runner to pick up a job" },
      "github.unavailable_minutes": { label: "Unavailable cooldown", group: "GitHub", level: "advanced", help: "How long to skip GitHub after it's unavailable" },
      "github.poll_seconds": { label: "Poll interval", group: "GitHub", level: "advanced", help: "How often to check workflow run status" },
      "github.checkout_action": { label: "Checkout action", group: "GitHub", sensitive: true, help: "Runs in CI with the repository's token" },
      local: { label: "Local executor", group: "Local", help: "Run gates on this machine" },
      "local.max_parallel": { label: "Max parallel", group: "Local", help: "Jobs that may run at once" },
      "local.min_free_ram_mb": { label: "Min free RAM", group: "Local", help: "Don't start jobs when free RAM is below this" },
      "local.max_load_per_core": { label: "Max load", group: "Local", help: "Don't start jobs when load per core is above this" },
      "local.capacity_retry_seconds": { label: "Capacity retry", group: "Local", level: "advanced", help: "Seconds between capacity checks" },
      "local.workdir": { label: "Working directory", group: "Local", help: "worktree: a clean git worktree at the commit; repo: the repository as it is" },
      "local.worktree_dir": { label: "Worktree directory", group: "Local", help: "Where worktrees go; default data/pipelines/worktrees" },
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
      enabled: { label: "Agents enabled", help: "Enable the agents module to start and manage agent runs" },
      interval_seconds: { label: "Poll interval", level: "advanced", help: "How often Lair checks on agent runs" },
      start_timeout_minutes: { label: "Start timeout", help: "A run with no live agent process this long after it was requested is never-started" },
      dead_on_start_seconds: { label: "Dead on start threshold", level: "advanced", help: "A process that dies this soon after it started (or with an empty log) died on start" },
      hung_minutes: { label: "Hung timeout", level: "advanced", help: "Override watchdog.hung_minutes for agents" },
      stop_grace_seconds: { label: "Stop grace period", level: "advanced", help: "SIGTERM, then SIGKILL after this long" },
      pid_start_tolerance_seconds: { label: "PID tolerance", level: "advanced", help: "How far a process's start time may differ from the one recorded for its pid" },
      session_dir: { label: "Session directory", level: "advanced", help: "The agent's session directory; {agents_dir}, {agent} and {repo} are replaced" },
      branch_state_cmd: { label: "Branch state command", level: "advanced", help: "Prints the branch state for a resume summary; {task}, {agent} and {repo} are replaced" },
      command_timeout_seconds: { label: "Command timeout", level: "advanced", help: "Timeout for branch_state_cmd and similar commands" },
      env_passthrough: { label: "Environment passthrough", help: "Names of variables an agent also gets from the server's environment" },
      recovery: { label: "Recovery", group: "Recovery", help: "What happens when a run crashes or fails" },
      "recovery.same_session_restarts": { label: "Same session restarts", group: "Recovery", help: "Restarts in the same session before trying a fresh one" },
      "recovery.fresh_sessions": { label: "Fresh sessions", group: "Recovery", help: "Fresh session attempts after same-session restarts are exhausted" },
      "recovery.backoff_seconds": { label: "Backoff (seconds)", group: "Recovery", level: "advanced", help: "Initial delay between recovery attempts" },
      "recovery.max_backoff_seconds": { label: "Max backoff", group: "Recovery", level: "advanced", help: "Maximum delay between recovery attempts" },
      retries: { label: "Retries", group: "Retries", help: "How never-started runs are retried" },
      "retries.max_retries": { label: "Max retries", group: "Retries", help: "Never-started runs are retried this many times, then escalated" },
      "retries.backoff_seconds": { label: "Backoff (seconds)", group: "Retries", level: "advanced", help: "Initial delay between retries" },
      "retries.max_backoff_seconds": { label: "Max backoff", group: "Retries", level: "advanced", help: "Maximum delay between retries" },
      locks: { label: "Locks", level: "advanced", help: "Resource locks agents must hold during launch or run" },
      failover: { label: "Failover", group: "Failover", help: "Automatic switch to another provider when one fails" },
      "failover.rate_limit_patterns": { label: "Rate limit patterns", group: "Failover", level: "advanced", help: "Patterns that indicate rate limiting" },
      "failover.provider_error_patterns": { label: "Provider error patterns", group: "Failover", level: "advanced", help: "Patterns that indicate provider failures" },
      "failover.silence_seconds": { label: "Silence threshold", group: "Failover", level: "advanced", help: "A live run fails over only when its log was silent this long" },
      "failover.cooldown_minutes": { label: "Cooldown", group: "Failover", help: "A provider that rate-limited or failed is skipped this long" },
      "failover.max_failovers": { label: "Max failovers", group: "Failover", help: "Failovers per task; one more is escalated instead" },
      transient_patterns: { label: "Transient patterns", level: "advanced", help: "Patterns that indicate transient failures (wait and retry)" },
      transient_max_minutes: { label: "Transient max wait", level: "advanced", help: "A provider failing transiently this long raises a decision" },
      transient_max_retries: { label: "Transient max retries", level: "advanced", help: "Transient retries per task before escalation" },
      usage_patterns: { label: "Usage patterns", level: "advanced", help: "Patterns with (?<tokens>...) or (?<cost>...) to extract usage from logs" },
      providers: { label: "Providers", level: "advanced", help: "Adapter id -> provider name (default: the adapter id)" },
      "fallbacks.*.adapter": { label: "Adapter", options: "adapters", help: "The adapter to fail over to" },
      "fallbacks.*.model": { label: "Model", help: "The model to use with this adapter" },
      "fallbacks.*.provider": { label: "Provider", help: "The provider name (default: the adapter id)" },
      budgets: { label: "Budgets", group: "Budgets", help: "Spending limits for the project and per agent" },
      "budgets.project": { label: "Project budget", group: "Budgets", help: "Limits for the whole project" },
      "budgets.agent": { label: "Default agent budget", group: "Budgets", help: "Default limits for each agent unless overridden" },
      "budgets.per_agent": { label: "Per-agent budgets", group: "Budgets", help: "Limits for specific agents" },
      fill: { label: "Fill", group: "Fill", help: "Automatic task assignment: reads a tasks file and starts agents" },
      "fill.enabled": { label: "Fill enabled", group: "Fill", help: "Enable automatic task assignment" },
      "fill.tasks_file": { label: "Tasks file", group: "Fill", help: "Lines <agent>|<name>|<task>|<description>; relative to the repository" },
      "fill.agents": { label: "Allowed agents", group: "Fill", help: "The agents fill may start" },
      "fill.prompt_files": { label: "Prompt files", group: "Fill", widget: "list", help: "Their contents, in order, make a run's prompt; {prompts_dir}, {agent}, {task}" },
      "fill.max_active": { label: "Max active", group: "Fill", help: "Runs fill started that may be active at once" },
      "fill.done_pattern": { label: "Done pattern", group: "Fill", level: "advanced", help: "Matched against new queue lines; {task} and {agent} are replaced" },
      "fill.capacity_cmd": { label: "Capacity command", group: "Fill", help: "Exit 0: capacity available; anything else holds (its first output line is the reason)" },
      "fill.interval_seconds": { label: "Interval", group: "Fill", level: "advanced", help: "How often fill checks for tasks to start" },
      "fill.max_completions_without_done": { label: "Max completions without done", group: "Fill", level: "advanced", help: "Runs that exit 0 without reporting done before holding" },
      "fill.backoff_seconds": { label: "Backoff", group: "Fill", level: "advanced", help: "Initial delay after a completion without done" },
      "fill.max_backoff_seconds": { label: "Max backoff", group: "Fill", level: "advanced", help: "Maximum delay after completions without done" },
      "fill.waiting_pattern": { label: "Waiting pattern", group: "Fill", level: "advanced", help: "A run that ended on such a line waits" },
      "fill.blocked_pattern": { label: "Blocked pattern", group: "Fill", level: "advanced", help: "A run that ended on such a line is held for the owner" },
      "fill.wake": { label: "Wake settings", group: "Fill", level: "advanced", help: "How waiting tasks are woken" },
      "fill.wake.file": { label: "Wake file", group: "Fill", level: "advanced", help: "The file whose existence wakes a waiting task; {wake}, {gates_dir}, {agents_dir}, {repo}" },
      "fill.wake.root": { label: "Wake root", group: "Fill", level: "advanced", help: "The directory that wake file must stay inside" },
      "fill.wake.poll_seconds": { label: "Wake poll interval", group: "Fill", level: "advanced", help: "How often fill looks for the wake file" },
      "fill.wake.max_wait_minutes": { label: "Max wait", group: "Fill", level: "advanced", help: "Waiting this long raises one decision" },
      "fill.wake.max_queue_wait_minutes": { label: "Max queue wait", group: "Fill", level: "advanced", help: "Waiting this long holds even while the gate is still queued" },
      "fill.wake.requeue_marker": { label: "Requeue marker", group: "Fill", level: "advanced", help: "A marker naming the id a gate was re-queued as" },
      "fill.wake.fallback_seconds": { label: "Fallback wait", group: "Fill", level: "advanced", help: "With nothing to wait on, the task starts again after this long" },
    },
  },
  {
    key: "triage",
    title: "Triage",
    schema: TriageSchema,
    docs: "#triage",
    hints: {
      enabled: { label: "Triage enabled", help: "Enable automatic diagnosis and handling of gate failures" },
      mode: { label: "Mode", help: "observe reports only; act re-checks, routes and reverts" },
      default_branch: { label: "Default branch", help: "The branch to compare against for pre-existing failures" },
      interval_seconds: { label: "Interval", level: "advanced", help: "How often triage checks for new results" },
      command_timeout_seconds: { label: "Command timeout", level: "advanced", help: "Timeout for triage commands" },
      infra_patterns: { label: "Infrastructure patterns", help: "Patterns that identify infrastructure failures (network, container, OOM)" },
      default_infra_patterns: { label: "Use default patterns", help: "Also use the built-in infrastructure patterns" },
      infra_signatures: { label: "Infrastructure signatures", level: "advanced", help: "Root-cause signatures added to the built-in ones" },
      timeout_signatures: { label: "Timeout signatures", level: "advanced", help: "Signatures for timeout failures" },
      context_patterns: { label: "Context patterns", help: "Patterns for shared context or bootstrap failures (groups tests into one cause)" },
      default_context_patterns: { label: "Use default context patterns", help: "Also use the built-in context patterns" },
      overload_per_core: { label: "Overload threshold", level: "advanced", help: "A timeout while load per core was at least this is infra" },
      base_max_age_hours: { label: "Base result max age", level: "advanced", help: "A base commit's result older than this is not used to call a failure pre-existing" },
      "trusted_nodes.*.id": { label: "Node ID", help: "Identifier for the trusted node" },
      "trusted_nodes.*.public_key_file": { label: "Public key file", widget: "path", help: "The node's Ed25519 public key (PEM)" },
      actions: { label: "Actions", group: "Actions", help: "What to do for each kind of failure" },
      "actions.infra": { label: "Infrastructure action", group: "Actions", help: "What to do for infrastructure failures: recheck, route, or none" },
      "actions.pre_existing": { label: "Pre-existing action", group: "Actions", help: "What to do for pre-existing failures: fix_task or none" },
      "actions.code": { label: "Code action", group: "Actions", help: "What to do for code failures: route or none" },
      recheck: { label: "Re-checks", group: "Re-checks", help: "Automatic re-running of failed gates" },
      "recheck.max_retries": { label: "Max re-checks", group: "Re-checks", help: "How many times to re-check an infrastructure failure" },
      "recheck.max_concurrent": { label: "Max concurrent", group: "Re-checks", help: "Re-checks that may run at once" },
      "recheck.timeout_minutes": { label: "Timeout", group: "Re-checks", help: "How long a re-check may run" },
      "recheck.request_timeout_seconds": { label: "Request timeout", group: "Re-checks", level: "advanced", help: "recheck must start the run and return within this" },
      "recheck.max_load_per_core": { label: "Max load", group: "Re-checks", level: "advanced", help: "Don't start re-checks when load is above this" },
      "recheck.min_free_memory_mb": { label: "Min free memory", group: "Re-checks", level: "advanced", help: "Don't start re-checks when free memory is below this" },
      "recheck.capacity_cmd": { label: "Capacity command", group: "Re-checks", help: "Exits 0 when there is capacity for a re-check" },
      flaky: { label: "Flaky tests", group: "Flaky", help: "Policy for tests that pass and fail inconsistently" },
      "flaky.window_minutes": { label: "Window", group: "Flaky", help: "Time window for counting flaky occurrences" },
      "flaky.ticket_after": { label: "Ticket threshold", group: "Flaky", help: "Flaky this many times in a row creates a reliability task" },
      "flaky.ticket_deadline_days": { label: "Ticket deadline", group: "Flaky", help: "Days to fix a flaky test" },
      "flaky.quarantine": { label: "Quarantine", group: "Flaky", help: "Automatically quarantine flaky tests" },
      "flaky.quarantine_cap": { label: "Quarantine cap", group: "Flaky", help: "Maximum tests to quarantine" },
      "flaky.release_after_passes": { label: "Release threshold", group: "Flaky", help: "Passes in a row to release a quarantined test" },
      bisect: { label: "Bisection", group: "Bisect", help: "Finding which commit broke a test" },
      "bisect.enabled": { label: "Bisect enabled", group: "Bisect", help: "Enable automatic bisection to find culprit commits" },
      "bisect.revert": { label: "Revert policy", group: "Bisect", help: "auto: open a revert for a proven culprit; propose: ask through a decision; off" },
      "bisect.max_candidates": { label: "Max candidates", group: "Bisect", help: "Maximum commits to consider for bisection" },
      "bisect.protected_merges": { label: "Protected merges", group: "Bisect", help: "Merges that are never reverted automatically" },
      "bisect.protected_trailer": { label: "Protected trailer", group: "Bisect", help: "A commit message trailer that marks a merge as protected" },
      commands: { label: "Commands", group: "Commands", help: "argv per command; each lists its placeholders in docs/configuration.md#triage-commands" },
      "commands.recheck": { label: "Recheck command", group: "Commands", help: "How to request a re-check" },
      "commands.notify_agent": { label: "Notify agent command", group: "Commands", help: "How to notify an agent about a failure" },
      "commands.create_task": { label: "Create task command", group: "Commands", help: "How to create a fix task" },
      "commands.raise_decision": { label: "Raise decision command", group: "Commands", help: "How to raise a decision for the owner" },
      "commands.open_revert": { label: "Open revert command", group: "Commands", help: "How to open a revert PR" },
      decision_file: { label: "Decision file", level: "advanced", help: "Where decisions go when no raise_decision command is set" },
    },
  },
  {
    key: "placement",
    title: "Placement",
    schema: PlacementSchema,
    docs: "#placement",
    hints: {
      enabled: { label: "Placement enabled", help: "Enable automatic job placement across machines" },
      mode: { label: "Mode", help: "observe says where each job would finish soonest; act moves it with move_cmd" },
      interval_seconds: { label: "Interval", level: "advanced", help: "How often placement checks for jobs to move" },
      probe_timeout_seconds: { label: "Probe timeout", level: "advanced", help: "Timeout for machine probes" },
      command_timeout_seconds: { label: "Command timeout", level: "advanced", help: "Timeout for move commands" },
      machines: { label: "Machines", group: "Machines", help: "The machines jobs can run on" },
      "machines.*.probe": { label: "Probe command", group: "Machines", help: "Exit 0 (and stdout starting with expect, when set) means the machine answers" },
      "machines.*.expect": { label: "Expected output", group: "Machines", help: "The probe's stdout must start with this" },
      "machines.*.load_cmd": { label: "Load command", group: "Machines", help: "Prints the 1-minute load first and the cpu count last" },
      "machines.*.cpus": { label: "CPU count", group: "Machines", help: "Override the detected CPU count" },
      "machines.*.min_up_seconds": { label: "Min uptime", group: "Machines", help: "A machine must be up this long before getting jobs" },
      lanes: { label: "Lanes", group: "Lanes", help: "Gate lanes and their routing" },
      "lanes.*.machine": { label: "Machine", group: "Lanes", help: "Which machine this lane runs on" },
      "lanes.*.slots": { label: "Slots", group: "Lanes", help: "Jobs that may run at once on this lane" },
      "lanes.*.limits": { label: "Class limits", group: "Lanes", help: "Max jobs per class on this lane" },
      "lanes.*.serves": { label: "Serves", group: "Lanes", help: "A pseudo-lane: takes jobs from these lanes' queues" },
      "lanes.*.max_priority": { label: "Max priority", group: "Lanes", help: "A pseudo-lane takes only jobs at this priority or more urgent" },
      classes: { label: "Job classes", group: "Classes", help: "Patterns that group similar jobs (the first matching class is a job's class)" },
      eligible: { label: "Eligible classes", group: "Classes", help: "Per lane, which classes it can run" },
      prefer_quiet: { label: "Prefer quiet patterns", help: "Jobs matching these patterns prefer machines with low load" },
      quiet_margin: { label: "Quiet margin", level: "advanced", help: "A machine is quiet when its load is this fraction below capacity" },
      move_cmd: { label: "Move command", help: "Placeholders: {id}, {from}, {to}, {file}, {priority}, {project}" },
      max_moves_per_tick: { label: "Max moves per tick", level: "advanced", help: "Jobs moved per placement interval" },
      min_gain_seconds: { label: "Min gain", help: "Only move a job if it saves at least this much time" },
      cooldown_seconds: { label: "Cooldown", help: "Wait this long before moving the same job again" },
      max_moves_per_job: { label: "Max moves per job", help: "A job moved this many times in 24 hours is held where it is" },
      default_seconds: { label: "Default duration", help: "Estimated job duration when no history is available" },
      command_line: { label: "Command line", level: "advanced", help: "The request file's line where its command starts" },
      history: { label: "History", group: "History", level: "advanced", help: "How placement learns job durations" },
      "history.runner_log": { label: "Runner log", group: "History", level: "advanced", help: "A tab-separated runner log, relative to gates_dir" },
      "history.columns": { label: "Columns", group: "History", level: "advanced", help: "Column names in the runner log" },
      "history.duration_pattern": { label: "Duration pattern", group: "History", level: "advanced", help: "Matched in a result log's tail; the last match's first group is the seconds" },
      "history.samples": { label: "Samples", group: "History", level: "advanced", help: "Number of past runs to average" },
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
