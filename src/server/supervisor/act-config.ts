/**
 * Config schema for supervisor.act (S3): an allowlist of acting ops that run
 * without the owner, in observe (record "would act") or act mode.
 *
 * docs/design/supervisor.md "Phases" S3: the allowlist of acting fixes.
 */
import { z } from "zod";

/**
 * The acting operations the supervisor can perform. Each op is validated in
 * code and goes through the owning module's own route with its checks.
 */
export const ACT_OPS = [
  "release_hold",
  "close_infra_escalation",
  "reject_duplicate_proposal",
] as const;

export type ActOp = (typeof ACT_OPS)[number];

/** off: nothing runs; observe: record "would act"; act: run allowed ops */
export type ActMode = "off" | "observe" | "act";

export const ActSchema = z
  .object({
    /** off: nothing; observe: record "would act"; act: run allowed ops */
    mode: z.enum(["off", "observe", "act"]).default("off"),
    /** Which ops may run without the owner (empty: the spec's default is none) */
    allow: z.array(z.enum(ACT_OPS)).default([]),
    /** All acting ops together; over it, nothing acts and one notice is raised */
    max_per_hour: z.number().int().min(1).max(1000).default(20),
    /** Never the same op on the same target twice inside this window */
    cooldown_minutes: z.number().int().min(1).max(10080).default(30),
  })
  .strict();

export type ActSettings = z.infer<typeof ActSchema>;

/**
 * Default infra patterns: text that says the failure is infrastructure, not
 * code. Every failed step must match one; any code failure (test, lint,
 * compile error) means it is NOT infra.
 */
export const DEFAULT_INFRA_PATTERNS: readonly string[] = [
  // Docker unreachable
  "Cannot connect to the Docker daemon",
  "Is the docker daemon running",
  "docker: command not found",
  // Docker exit code 125 is "docker daemon error"
  "rc=125",
  "exit code: 125",
  "exit status 125",
  // SSH / network errors
  "Connection refused",
  "Connection timed out",
  "Connection reset by peer",
  "Network is unreachable",
  "No route to host",
  "Host is down",
  "ssh: connect to host",
  "Permission denied (publickey",
  // Gate stuck while result now exists
  "gate stuck",
  // Machine unreachable
  "machine.*unreachable",
  "node.*unreachable",
  "placement.*failed",
];

/**
 * Patterns that indicate a code failure (not infra). If any of these appear,
 * the cause is NOT infrastructure.
 */
export const CODE_FAILURE_PATTERNS: readonly string[] = [
  // Test failures
  "FAILED",
  "FAILURE",
  "AssertionError",
  "Expected",
  "expected",
  "assertion failed",
  // Compile errors
  "error:",
  "Error:",
  "compile error",
  "compilation failed",
  "syntax error",
  "SyntaxError",
  "TypeError",
  "ReferenceError",
  // Lint errors
  "lint",
  "eslint",
  "prettier",
  "tsc error",
  "type error",
  // General test output
  "tests? failed",
  "\\d+ failing",
];

export interface ActParseResult {
  ok: true;
  settings: ActSettings;
}

export interface ActParseError {
  ok: false;
  errors: string[];
}

export type ActResult = ActParseResult | ActParseError;

/**
 * Parse the supervisor.act block. Returns defaults (mode: off, empty allow)
 * when absent.
 */
export function parseActConfig(raw: unknown): ActResult {
  const parsed = ActSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `supervisor.act.${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, settings: parsed.data };
}

/** Every default (mode: off, empty allow) */
export function defaultActSettings(): ActSettings {
  const parsed = parseActConfig(undefined);
  if (!parsed.ok) throw new Error("the act defaults are invalid");
  return parsed.settings;
}

/** Is this op allowed to run in act mode? */
export function opAllowed(settings: ActSettings, op: ActOp): boolean {
  return settings.mode === "act" && settings.allow.includes(op);
}

/** Is anything allowed to be detected (observe or act mode)? */
export function actEnabled(settings: ActSettings): boolean {
  return settings.mode !== "off";
}
