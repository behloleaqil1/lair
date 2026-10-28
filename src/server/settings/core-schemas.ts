/**
 * Descriptive schemas of the core settings: the top-level keys that no
 * module's zod parser owns (see docs/configuration.md). They draw the
 * Settings forms only; what loads is still checked by parseProjectConfig
 * and the existing parsers (dragon defaults, adapters, machines), so these
 * never refuse a file the server would load: every object passes unknown
 * keys through.
 */
import { z } from "zod";

const argv = z.array(z.string().min(1)).min(1);
const text = z.string();

export const ProjectCoreSchema = z
  .object({
    name: z.string().min(1),
    repo: z.string().min(1),
    github: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "use owner/name").optional(),
    queue_file: z.string().min(1),
    agents_dir: z.string().min(1),
    gates_dir: z.string().min(1),
  })
  .passthrough();

export const ControlsSchema = z
  .object({
    read_only: z.boolean().default(true),
    allow_direct_assign: z.boolean().default(false),
    inbox_file: text.optional(),
    outbox_file: text.optional(),
    backlog_file: text.optional(),
    ask_cmd: argv.optional(),
    tick_now_cmd: argv.optional(),
    pause_cmd: argv.optional(),
    resume_cmd: argv.optional(),
    agent_run_cmd: argv.optional(),
    agent_stop_cmd: argv.optional(),
    agent_release_cmd: argv.optional(),
    gate_submit_cmd: argv.optional(),
    gate_stuck_cmd: argv.optional(),
    merge_cmd: argv.optional(),
  })
  .passthrough();

const DragonSchema = z
  .object({
    name: text.optional(),
    model: text.optional(),
    machine: text.default("local"),
    adapter: text.optional(),
    /** An ai.profiles id, instead of adapter and model */
    profile: text.optional(),
    instructions: text.default(""),
  })
  .passthrough();

const ModelSchema = z.object({ id: z.string().min(1), name: text.optional(), description: text.optional() }).passthrough();

export const DragonsSchema = z
  .object({
    dragons: z.record(DragonSchema).optional(),
    dragon_defaults: z.object({ model: text.optional(), adapter: text.optional() }).strict().optional(),
    available_models: z.array(ModelSchema).optional(),
    default_instructions: text.default(""),
    dragon_start_cmd: argv.optional(),
    dragon_stop_cmd: argv.optional(),
    dragon_release_cmd: argv.optional(),
    prompts_dir: text.default("data/prompts"),
  })
  .passthrough();

const AdapterSchema = z
  .object({
    name: text.optional(),
    start_cmd: text.optional(),
    stop_cmd: text.optional(),
    status_method: z.enum(["file", "stdout", "mcp"]).default("file"),
    queue_file: text.optional(),
    log_dir: text.optional(),
    status_pattern: text.optional(),
    mcp_endpoint: text.optional(),
    session_id_env: text.optional(),
    resume_flag: text.optional(),
    // Model discovery and sign-in checks (src/server/ai/ checks them when the project loads)
    models_cmd: argv.optional(),
    models_parser: z.enum(["kiro", "lines"]).optional(),
    models: z
      .array(
        z
          .object({ id: z.string().min(1), label: text.optional(), notes: text.optional(), default: z.boolean().optional() })
          .strict(),
      )
      .optional(),
    auth_check_cmd: argv.optional(),
    login_hint: text.optional(),
    version_cmd: argv.optional(),
    experimental: z.boolean().optional(),
  })
  .passthrough();

export const AdaptersSchema = z
  .object({
    agent_adapters: z.record(AdapterSchema).optional(),
    terminology: z
      .object({ agent_singular: text.optional(), agent_plural: text.optional(), orchestrator: text.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const MachineSchema = z
  .object({
    name: text.optional(),
    type: z.enum(["local", "ssh"]),
    runners: z.array(z.string().min(1)).default([]),
    host: text.optional(),
    user: text.optional(),
    /** A path to the SSH private key file, never the key */
    key: text.optional(),
    connect_timeout: z.number().positive().default(4),
    work_dir: text.optional(),
    gate_script: text.optional(),
    kiro_cli: text.optional(),
    sync: z.enum(["rsync", "git", "none"]).default("none"),
  })
  .passthrough();

export const MachinesSchema = z.object({ machines: z.record(MachineSchema).optional() }).passthrough();

const HealthCheckSchema = z
  .object({
    type: z.enum(["file_modified", "http", "tcp", "command", "none"]),
    path: text.optional(),
    url: text.optional(),
    host: text.optional(),
    port: z.number().int().positive().optional(),
    command: argv.optional(),
    interval: z.number().positive().optional(),
    timeout: z.number().positive().optional(),
    action: z.enum(["restart", "alert", "none"]).optional(),
    retries: z.number().int().min(0).optional(),
  })
  .passthrough();

const ProcessSchema = z
  .object({
    name: text.optional(),
    command: argv,
    cwd: text.optional(),
    env: z.record(z.string()).optional(),
    restart: z.enum(["always", "on-failure", "never"]).optional(),
    restart_delay: z.number().min(0).optional(),
    max_restarts: z.number().int().min(0).optional(),
    backoff_multiplier: z.number().positive().optional(),
    max_backoff: z.number().min(0).optional(),
    health_check: HealthCheckSchema.optional(),
    log_max_lines: z.number().int().positive().optional(),
    log_file: text.optional(),
    autostart: z.boolean().optional(),
    depends_on: z.array(z.string()).optional(),
  })
  .passthrough();

export const ProcessesSchema = z.object({ processes: z.record(ProcessSchema).optional() }).passthrough();

export const CoordinationSchema = z
  .object({
    mail_dir: text.optional(),
    wake_file: text.optional(),
    merge_bar: z
      .object({ required_steps: z.array(z.string().min(1)).default([]), require_review: z.boolean().default(true) })
      .passthrough()
      .optional(),
    orchestrator: z.object({ launchd_label: text.optional() }).passthrough().optional(),
    gate_runner: z
      .object({
        enabled: z.boolean().default(false),
        poll_interval: z.number().positive().default(5),
        sync_method: z.enum(["rsync", "git", "none"]).default("none"),
        rsync_exclude: z.array(z.string()).default([]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
