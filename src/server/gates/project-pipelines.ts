/**
 * The `pipelines:` and `executors:` blocks of a project config, validated
 * with defaults applied. See docs/configuration.md#gate-pipelines and
 * docs/design/runners.md.
 *
 * Each lane of a pipeline becomes one GatePipeline (id `<pipeline>.<lane>`)
 * for the existing gate executor, so every executor produces the same
 * GateResult.
 */
import { z } from "zod";
import type { GatePipeline } from "../../shared/policy-types.js";
import type { ExecutorKind } from "../../shared/pipeline-types.js";
import { parseGatePipeline } from "./pipeline-config.js";

/** Pipeline and lane names: they end up in workflow inputs and job keys */
export const PIPELINE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** Step names: they end up in workflow step names and log markers */
export const STEP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/;
const RUNNER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ACTION_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
export const DEFAULT_LANE = "default";
export const EXECUTOR_KINDS = ["github", "nodes", "local"] as const satisfies readonly ExecutorKind[];

/**
 * Text that ends up inside a generated workflow. `${{` would be evaluated by
 * GitHub before the shell sees it, and control characters (newlines) could
 * change the script, so both are refused.
 */
function workflowSafe(value: string): string | null {
  if (value.includes("${{")) return "must not contain ${{";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return "must not contain newlines or control characters";
  return null;
}

const SafeString = z.string().superRefine((value, ctx) => {
  const problem = workflowSafe(value);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});

const Argv = z.array(SafeString).min(1).refine((argv) => argv[0].length > 0, "the program (first item) is empty");

const Order = z
  .array(z.enum(EXECUTOR_KINDS))
  .min(1)
  .refine((order) => new Set(order).size === order.length, "an executor is listed twice");

const StepSchema = z
  .object({
    name: z
      .string()
      .regex(STEP_NAME, "step names use letters, digits, '.', '_' and '-'")
      .refine((name) => !name.toLowerCase().startsWith("lair-"), "names starting with lair- are reserved"),
    run: Argv,
    lane: z.string().regex(PIPELINE_NAME, "lane names use letters, digits, '_' and '-'").default(DEFAULT_LANE),
    timeout_minutes: z.number().positive().max(1440).default(30),
    continue_on_failure: z.boolean().default(false),
    env: z
      .record(SafeString)
      .refine((env) => Object.keys(env).every((key) => ENV_NAME.test(key)), "env names use letters, digits and '_'")
      .refine(
        (env) => Object.keys(env).every((key) => !/^(GITHUB_|RUNNER_|LAIR_)/i.test(key)),
        "env names starting with GITHUB_, RUNNER_ or LAIR_ are reserved",
      )
      .optional(),
  })
  .strict();

const LaneSchema = z.object({ executors: Order }).strict();

const PipelineSchema = z
  .object({
    timeout_minutes: z.number().positive().max(1440).default(120),
    lanes: z.record(LaneSchema).default({}),
    steps: z.array(StepSchema).min(1),
  })
  .strict();

const PipelinesSchema = z.record(PipelineSchema);

const GithubSchema = z
  .object({
    /** owner/name; default: the project's `github` */
    repo: z.string().regex(REPO, "use owner/name").optional(),
    /** The environment variable that holds the token (never the token itself) */
    token_env: z.string().regex(ENV_NAME).default("LAIR_GITHUB_TOKEN"),
    /** File name under .github/workflows/ */
    workflow: z.string().regex(WORKFLOW_FILE, "a file name ending in .yml or .yaml").default("lair-gates.yml"),
    hosted: z.boolean().default(true),
    hosted_runs_on: z.string().regex(RUNNER_LABEL).default("ubuntu-latest"),
    self_hosted: z.boolean().default(true),
    self_hosted_labels: z.array(z.string().regex(RUNNER_LABEL)).min(1).default(["self-hosted"]),
    /** GitHub-hosted minutes a private repository may use per calendar month (0: none) */
    monthly_minutes: z.number().int().min(0).default(0),
    pickup_timeout_minutes: z.number().positive().max(1440).default(10),
    unavailable_minutes: z.number().min(0).max(10080).default(30),
    poll_seconds: z.number().min(1).max(600).default(15),
    checkout_action: z.string().regex(ACTION_REF, "owner/name@ref").default("actions/checkout@v4"),
  })
  .strict();

const LocalSchema = z
  .object({
    max_parallel: z.number().int().min(1).max(64).default(1),
    min_free_ram_mb: z.number().min(0).default(1024),
    max_load_per_core: z.number().positive().default(1.5),
    capacity_retry_seconds: z.number().min(1).max(3600).default(30),
    /** worktree: a clean `git worktree` at the commit; repo: the repository as it is */
    workdir: z.enum(["worktree", "repo"]).default("worktree"),
    /** Where worktrees go; default data/pipelines/worktrees under the Lair directory */
    worktree_dir: z.string().min(1).optional(),
  })
  .strict();

const ExecutorsSchema = z
  .object({
    order: Order.default([...EXECUTOR_KINDS]),
    /** Seconds between tries while no executor can take a job */
    retry_seconds: z.number().min(1).max(3600).default(60),
    github: GithubSchema.default({}),
    local: LocalSchema.default({}),
  })
  .strict();

// ============ PARSED SETTINGS ============

export interface PipelineStepSettings {
  name: string;
  argv: string[];
  lane: string;
  timeoutSeconds: number;
  continueOnFailure: boolean;
  env?: Record<string, string>;
}

export interface LaneSettings {
  name: string;
  /** Executor order for this lane */
  order: ExecutorKind[];
  steps: PipelineStepSettings[];
  /** The lane as a gate pipeline (id `<pipeline>.<lane>`) */
  gate: GatePipeline;
}

export interface PipelineSettings {
  name: string;
  timeoutSeconds: number;
  steps: PipelineStepSettings[];
  /** Lanes in the order their first step appears */
  lanes: LaneSettings[];
}

export interface GithubSettings {
  repo: string | null;
  tokenEnv: string;
  workflow: string;
  hosted: boolean;
  hostedRunsOn: string;
  selfHosted: boolean;
  selfHostedLabels: string[];
  monthlyMinutes: number;
  pickupTimeoutMinutes: number;
  unavailableMinutes: number;
  pollSeconds: number;
  checkoutAction: string;
}

export interface LocalSettings {
  maxParallel: number;
  minFreeRamMb: number;
  maxLoadPerCore: number;
  capacityRetrySeconds: number;
  workdir: "worktree" | "repo";
  worktreeDir?: string;
}

export interface ExecutorSettings {
  order: ExecutorKind[];
  retrySeconds: number;
  github: GithubSettings;
  local: LocalSettings;
}

export interface ProjectPipelineSettings {
  pipelines: PipelineSettings[];
  executors: ExecutorSettings;
}

export type PipelineParseResult =
  | { ok: true; settings: ProjectPipelineSettings }
  | { ok: false; errors: string[] };

/** The display form of an argv: each argument single-quoted when it needs it */
export function displayCommand(argv: string[]): string {
  return argv.map((arg) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : shellQuote(arg))).join(" ");
}

/** POSIX single-quoting: safe for any text without control characters */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function issues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${prefix}${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`);
}

/**
 * Validate a project's `pipelines:` and `executors:` blocks. `github` is the
 * project's `github` (owner/name), the default for `executors.github.repo`.
 */
export function parsePipelineConfig(
  rawPipelines: unknown,
  rawExecutors: unknown,
  github?: string,
): PipelineParseResult {
  const errors: string[] = [];
  const pipelinesParsed = PipelinesSchema.safeParse(rawPipelines ?? {});
  const executorsParsed = ExecutorsSchema.safeParse(rawExecutors ?? {});
  if (!pipelinesParsed.success) errors.push(...issues("pipelines", pipelinesParsed.error));
  if (!executorsParsed.success) errors.push(...issues("executors", executorsParsed.error));
  if (!pipelinesParsed.success || !executorsParsed.success) {
    return { ok: false, errors };
  }
  const executors = executorsParsed.data;

  const pipelines: PipelineSettings[] = [];
  for (const [name, raw] of Object.entries(pipelinesParsed.data)) {
    if (!PIPELINE_NAME.test(name)) {
      errors.push(`pipelines.${name}: pipeline names use letters, digits, '_' and '-' (at most 40)`);
      continue;
    }
    const steps: PipelineStepSettings[] = raw.steps.map((step) => ({
      name: step.name,
      argv: step.run,
      lane: step.lane,
      timeoutSeconds: Math.round(step.timeout_minutes * 60),
      continueOnFailure: step.continue_on_failure,
      env: step.env,
    }));
    const seen = new Set<string>();
    for (const step of steps) {
      if (seen.has(step.name)) errors.push(`pipelines.${name}.steps: duplicate step name ${step.name}`);
      seen.add(step.name);
    }
    const laneNames = [...new Set(steps.map((s) => s.lane))];
    for (const lane of Object.keys(raw.lanes)) {
      if (!laneNames.includes(lane)) {
        errors.push(`pipelines.${name}.lanes.${lane}: no step uses this lane`);
      }
    }
    const timeoutSeconds = Math.round(raw.timeout_minutes * 60);
    const lanes: LaneSettings[] = [];
    for (const lane of laneNames) {
      const laneSteps = steps.filter((s) => s.lane === lane);
      try {
        const gate = parseGatePipeline({
          id: `${name}.${lane}`,
          name: `${name} (${lane})`,
          steps: laneSteps.map((s) => ({
            name: s.name,
            command: displayCommand(s.argv),
            argv: s.argv,
            timeoutSeconds: s.timeoutSeconds,
            continueOnFailure: s.continueOnFailure || undefined,
            env: s.env,
          })),
          scope: [],
          defaultSteps: laneSteps.map((s) => s.name),
          timeoutSeconds,
        });
        lanes.push({
          name: lane,
          order: raw.lanes[lane]?.executors ?? executors.order,
          steps: laneSteps,
          gate,
        });
      } catch (e) {
        errors.push(`pipelines.${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    pipelines.push({ name, timeoutSeconds, steps, lanes });
  }

  const repo = executors.github.repo ?? (github && REPO.test(github) ? github : null);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      pipelines,
      executors: {
        order: executors.order,
        retrySeconds: executors.retry_seconds,
        github: {
          repo,
          tokenEnv: executors.github.token_env,
          workflow: executors.github.workflow,
          hosted: executors.github.hosted,
          hostedRunsOn: executors.github.hosted_runs_on,
          selfHosted: executors.github.self_hosted,
          selfHostedLabels: executors.github.self_hosted_labels,
          monthlyMinutes: executors.github.monthly_minutes,
          pickupTimeoutMinutes: executors.github.pickup_timeout_minutes,
          unavailableMinutes: executors.github.unavailable_minutes,
          pollSeconds: executors.github.poll_seconds,
          checkoutAction: executors.github.checkout_action,
        },
        local: {
          maxParallel: executors.local.max_parallel,
          minFreeRamMb: executors.local.min_free_ram_mb,
          maxLoadPerCore: executors.local.max_load_per_core,
          capacityRetrySeconds: executors.local.capacity_retry_seconds,
          workdir: executors.local.workdir,
          worktreeDir: executors.local.worktree_dir,
        },
      },
    },
  };
}

/** Key of a lane in workflow inputs and job names: `<pipeline>.<lane>` */
export function jobKey(pipeline: string, lane: string): string {
  return `${pipeline}.${lane}`;
}
