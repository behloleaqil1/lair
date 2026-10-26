/**
 * The `delivery:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#delivery.
 *
 * Every value that ends up in a docker or git argv comes from here, and the
 * names (environments, services, the compose project) are checked against
 * strict patterns, so a request can only ever pick one of them.
 */
import { z } from "zod";
import { placeholdersIn } from "../watchdog/config.js";

const argv = z.array(z.string().min(1)).min(1);

/** Environment names (in URLs and the store) */
export const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** Compose service names */
export const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** Compose project names: lowercase letters, digits, '-' and '_', starting with a letter or digit */
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** A branch or ref name: no leading '-', no '..', no spaces */
const GIT_REF = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** A file or directory argument: never read as an option */
const pathArg = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith("-"), "must not start with '-'");

/** Placeholders prepare_cmd may use */
export const PREPARE_PLACEHOLDERS = ["sha", "ref", "environment", "project"] as const;

const HttpHealthSchema = z
  .object({
    type: z.literal("http"),
    url: z.string().url(),
    /** Without it any 2xx or 3xx answer counts as healthy */
    expect_status: z.number().int().min(100).max(599).optional(),
    timeout_seconds: z.number().positive().max(60).default(5),
  })
  .strict();

const ContainerHealthSchema = z.object({ type: z.literal("container") }).strict();

const HealthSchema = z.discriminatedUnion("type", [HttpHealthSchema, ContainerHealthSchema]);

const ServiceSchema = z
  .object({
    health: HealthSchema.default({ type: "container" }),
    /** The service's image is built by compose, so a deploy can rebuild it */
    build: z.boolean().default(false),
    /** Repository paths whose changes deploy this service after a merge */
    paths: z.array(z.string().min(1)).default([]),
  })
  .strict();

const CrashLoopSchema = z
  .object({
    max_restarts: z.number().int().positive().default(3),
    window_minutes: z.number().positive().default(10),
  })
  .strict();

const DeploySchema = z
  .object({
    /** Deploy changed services when `ref` moves (a merge) */
    auto: z.boolean().default(false),
    /** The repository to watch; default: the project's `repo` */
    repo: pathArg.optional(),
    ref: z.string().regex(GIT_REF, "must be a branch or ref name").default("main"),
    /** Runs before an automatic deploy builds anything, e.g. to update the working tree */
    prepare_cmd: argv.optional(),
    /** Roll back a deployed service that isn't healthy within this many minutes */
    health_timeout_minutes: z.number().positive().max(120).default(5),
  })
  .strict();

const EnvironmentSchema = z
  .object({
    type: z.literal("compose").default("compose"),
    compose_files: z.array(pathArg).min(1),
    project_name: z
      .string()
      .regex(COMPOSE_PROJECT, "use lowercase letters, digits, '-' and '_', starting with a letter or digit"),
    project_directory: pathArg.optional(),
    // `api:` with nothing under it is an empty map in YAML terms
    services: z.record(z.preprocess((value) => value ?? {}, ServiceSchema)),
    start_order: z.array(z.string()).optional(),
    /** Up and Restart wait this long for each service to be healthy */
    start_timeout_seconds: z.number().int().min(1).max(3600).default(120),
    crash_loop: CrashLoopSchema.default({}),
    deploy: DeploySchema.default({}),
  })
  .strict();

const DeliverySchema = z
  .object({
    enabled: z.boolean().default(false),
    interval_seconds: z.number().int().min(5).max(3600).default(30),
    docker_cmd: argv.default(["docker"]),
    command_timeout_seconds: z.number().int().min(1).max(3600).default(300),
    build_timeout_seconds: z.number().int().min(1).max(7200).default(1800),
    environments: z.record(EnvironmentSchema).default({}),
  })
  .strict();

type RawDelivery = z.infer<typeof DeliverySchema>;

export type HealthCheck =
  | { type: "container" }
  | { type: "http"; url: string; expectStatus?: number; timeoutSeconds: number };

export interface ServiceSettings {
  name: string;
  health: HealthCheck;
  build: boolean;
  paths: string[];
}

export interface EnvironmentSettings {
  name: string;
  composeFiles: string[];
  projectName: string;
  projectDirectory?: string;
  /** In start order */
  services: ServiceSettings[];
  startTimeoutSeconds: number;
  crashLoop: { maxRestarts: number; windowMinutes: number };
  deploy: {
    auto: boolean;
    repo?: string;
    ref: string;
    prepareCmd?: string[];
    healthTimeoutMinutes: number;
  };
}

/** The parsed `delivery:` block. */
export interface DeliverySettings {
  enabled: boolean;
  intervalSeconds: number;
  dockerCmd: string[];
  commandTimeoutSeconds: number;
  buildTimeoutSeconds: number;
  environments: EnvironmentSettings[];
}

export type ParseResult =
  | { ok: true; settings: DeliverySettings }
  | { ok: false; errors: string[] };

function environmentErrors(name: string, env: RawDelivery["environments"][string]): string[] {
  const at = `delivery.environments.${name}`;
  const errors: string[] = [];
  if (!ENVIRONMENT_NAME.test(name)) {
    errors.push(`${at}: environment names use letters, digits, '_' and '-', starting with a letter`);
  }
  const names = Object.keys(env.services);
  if (names.length === 0) {
    errors.push(`${at}.services: list at least one service`);
  }
  for (const service of names) {
    if (!SERVICE_NAME.test(service)) {
      errors.push(`${at}.services.${service}: service names use letters, digits, '.', '_' and '-'`);
    }
    const settings = env.services[service];
    if (settings.paths.length > 0 && !settings.build) {
      errors.push(`${at}.services.${service}.paths: only a service with build: true is deployed`);
    }
    if (settings.health.type === "http" && !/^https?:\/\//i.test(settings.health.url)) {
      errors.push(`${at}.services.${service}.health.url: must be an http:// or https:// URL`);
    }
  }
  const seen = new Set<string>();
  for (const service of env.start_order ?? []) {
    if (!names.includes(service)) {
      errors.push(`${at}.start_order: ${service} is not in services`);
    } else if (seen.has(service)) {
      errors.push(`${at}.start_order: ${service} is listed twice`);
    }
    seen.add(service);
  }
  if (env.deploy.auto && !names.some((s) => env.services[s].build && env.services[s].paths.length > 0)) {
    errors.push(`${at}.deploy.auto is true but no service has build: true and paths`);
  }
  if (env.deploy.prepare_cmd) {
    const allowed = new Set<string>(PREPARE_PLACEHOLDERS);
    for (const placeholder of placeholdersIn(env.deploy.prepare_cmd)) {
      if (!allowed.has(placeholder)) {
        errors.push(
          `${at}.deploy.prepare_cmd: unknown placeholder {${placeholder}} (allowed: ${PREPARE_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")})`,
        );
      }
    }
  }
  return errors;
}

/** Validate a project's `delivery:` block (undefined means disabled). */
export function parseDeliveryConfig(raw: unknown): ParseResult {
  const parsed = DeliverySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `delivery.${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const value = parsed.data;
  const errors: string[] = [];
  const composeProjects = new Map<string, string>();
  for (const [name, env] of Object.entries(value.environments)) {
    errors.push(...environmentErrors(name, env));
    const other = composeProjects.get(env.project_name);
    if (other) {
      errors.push(`delivery.environments.${name}.project_name: ${env.project_name} is also used by ${other}`);
    }
    composeProjects.set(env.project_name, name);
  }
  if (value.enabled && Object.keys(value.environments).length === 0) {
    errors.push("delivery.environments: enabled is true but no environment is configured");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      intervalSeconds: value.interval_seconds,
      dockerCmd: value.docker_cmd,
      commandTimeoutSeconds: value.command_timeout_seconds,
      buildTimeoutSeconds: value.build_timeout_seconds,
      environments: Object.entries(value.environments).map(([name, env]) => {
        const listed = env.start_order ?? [];
        const order = [...listed, ...Object.keys(env.services).filter((s) => !listed.includes(s))];
        return {
          name,
          composeFiles: env.compose_files,
          projectName: env.project_name,
          projectDirectory: env.project_directory,
          services: order.map((service) => {
            const s = env.services[service];
            const health: HealthCheck =
              s.health.type === "http"
                ? {
                    type: "http",
                    url: s.health.url,
                    expectStatus: s.health.expect_status,
                    timeoutSeconds: s.health.timeout_seconds,
                  }
                : { type: "container" };
            return { name: service, health, build: s.build, paths: s.paths };
          }),
          startTimeoutSeconds: env.start_timeout_seconds,
          crashLoop: {
            maxRestarts: env.crash_loop.max_restarts,
            windowMinutes: env.crash_loop.window_minutes,
          },
          deploy: {
            auto: env.deploy.auto,
            repo: env.deploy.repo,
            ref: env.deploy.ref,
            prepareCmd: env.deploy.prepare_cmd,
            healthTimeoutMinutes: env.deploy.health_timeout_minutes,
          },
        };
      }),
    },
  };
}

/**
 * Whether a changed file is under one of a service's paths. A path is a
 * directory or file relative to the repository root ("api/", "shared/x.ts");
 * "." matches everything.
 */
export function pathMatches(path: string, file: string): boolean {
  const prefix = path.replace(/^\.\//, "").replace(/\/+$/, "");
  if (prefix === "" || prefix === ".") return true;
  return file === prefix || file.startsWith(`${prefix}/`);
}
