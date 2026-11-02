/**
 * Checks module configuration: parsing and validation for `checks:` in project config.
 *
 * Each project defines named check kinds, each with:
 * - command: argv template with placeholders ({sha}, {branch}, {tests}, {agent}, {check_id}, {output_dir})
 * - tests: selector validation (pattern, max_count, max_length)
 * - timeout_seconds, max_concurrent, max_per_agent_per_hour
 * - parse: exit code semantics and optional JUnit path
 * - budget: daily limit and guard_cmd
 * - remote: the git remote a check's branch must be pushed to (default origin)
 */
import { createContext, Script } from "vm";
import { z } from "zod";

// ============ Constants ============

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_PER_AGENT_PER_HOUR = 10;
export const DEFAULT_SELECTOR_PATTERN = "^[A-Za-z0-9_.*#]+$";
export const DEFAULT_SELECTOR_MAX_COUNT = 50;
export const DEFAULT_SELECTOR_MAX_LENGTH = 5000;

/**
 * Exit codes:
 * - 0: pass
 * - 1: test failures
 * - 3: infrastructure error
 * - 4: refused by guard
 */
export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_INFRASTRUCTURE = 3;
export const EXIT_GUARD_REFUSED = 4;

// ============ Schemas ============

const SelectorSchema = z.object({
  pattern: z.string().default(DEFAULT_SELECTOR_PATTERN),
  max_count: z.number().int().positive().default(DEFAULT_SELECTOR_MAX_COUNT),
  max_length: z.number().int().positive().default(DEFAULT_SELECTOR_MAX_LENGTH),
});

const ParseSchema = z
  .object({
    junit_path: z.string().optional(),
  })
  .default({});

const BudgetSchema = z
  .object({
    daily_limit: z.number().int().positive().optional(),
    guard_cmd: z.array(z.string()).optional(),
  })
  .default({});

/** A git remote name: it reaches git's argv, so no leading dash and no shell characters */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const CheckKindSchema = z.object({
  command: z.array(z.string()).min(1),
  /** The remote a check's branch must be pushed to: its sha must be reachable from <remote>/<branch> */
  remote: z.string().regex(REMOTE_NAME, "remote must be a git remote name").default("origin"),
  tests: SelectorSchema.default({}),
  timeout_seconds: z.number().int().positive().default(DEFAULT_TIMEOUT_SECONDS),
  max_concurrent: z.number().int().positive().default(DEFAULT_MAX_CONCURRENT),
  max_per_agent_per_hour: z.number().int().positive().default(DEFAULT_MAX_PER_AGENT_PER_HOUR),
  parse: ParseSchema,
  budget: BudgetSchema,
});

export const ChecksConfigSchema = z.record(z.string(), CheckKindSchema);

// ============ Types ============

export type SelectorConfig = z.infer<typeof SelectorSchema>;
export type ParseConfig = z.infer<typeof ParseSchema>;
export type BudgetConfig = z.infer<typeof BudgetSchema>;
export type CheckKindConfig = z.infer<typeof CheckKindSchema>;
export type ChecksConfig = z.infer<typeof ChecksConfigSchema>;

export interface ParsedChecksConfig {
  kinds: Map<string, CheckKindConfig>;
}

// ============ Parsing ============

export type ParseChecksResult =
  | { ok: true; config: ParsedChecksConfig }
  | { ok: false; error: string };

/**
 * Parse and validate checks configuration.
 * Returns an error string if invalid.
 */
export function parseChecksConfig(raw: unknown): ParseChecksResult {
  if (raw === undefined || raw === null) {
    return { ok: true, config: { kinds: new Map() } };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "checks must be an object" };
  }

  const parsed = ChecksConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.join(".");
    return { ok: false, error: `checks.${path}: ${issue.message}` };
  }

  const kinds = new Map<string, CheckKindConfig>();
  for (const [name, kind] of Object.entries(parsed.data)) {
    // Validate kind name: lowercase letters, digits, hyphens only
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return {
        ok: false,
        error: `checks.${name}: kind name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens`,
      };
    }

    // Validate command has no shell metacharacters (except valid placeholders)
    for (const arg of kind.command) {
      if (containsShellMetacharsInTemplate(arg)) {
        return {
          ok: false,
          error: `checks.${name}.command: argument "${arg.slice(0, 40)}" contains shell metacharacters`,
        };
      }
    }

    // Validate guard_cmd if present (no placeholders allowed here)
    if (kind.budget.guard_cmd) {
      for (const arg of kind.budget.guard_cmd) {
        if (containsShellMetachars(arg)) {
          return {
            ok: false,
            error: `checks.${name}.budget.guard_cmd: argument "${arg.slice(0, 40)}" contains shell metacharacters`,
          };
        }
      }
    }

    // Validate selector pattern is a valid regex
    try {
      new RegExp(kind.tests.pattern);
    } catch {
      return {
        ok: false,
        error: `checks.${name}.tests.pattern: invalid regex "${kind.tests.pattern}"`,
      };
    }

    kinds.set(name, kind);
  }

  return { ok: true, config: { kinds } };
}

// ============ Validation helpers ============

/** Characters that have special meaning in shells. Never run through a shell anyway, but reject them for safety. */
const SHELL_METACHARS_WITH_BRACES = /[;&|`$(){}[\]<>*?!'"\\]/;
const SHELL_METACHARS_NO_BRACES = /[;&|`$()[\]<>*?!'"\\]/;

/**
 * Valid placeholder pattern: {word} where word is lowercase letters/underscores.
 * We allow placeholders like {sha}, {tests}, {branch}, {agent}, {check_id}, {output_dir}.
 */
const VALID_PLACEHOLDERS = new Set(["sha", "branch", "tests", "agent", "check_id", "output_dir"]);

/**
 * Check if text contains shell metacharacters in a command template.
 * Allows known placeholders like {sha} but rejects arbitrary braces and other metachars.
 */
function containsShellMetacharsInTemplate(text: string): boolean {
  // Check for non-brace metachars first
  if (SHELL_METACHARS_NO_BRACES.test(text)) {
    return true;
  }

  // Check for braces: only allow known placeholders
  const bracePattern = /\{([^}]*)\}/g;
  let match;
  while ((match = bracePattern.exec(text)) !== null) {
    const placeholder = match[1];
    if (!VALID_PLACEHOLDERS.has(placeholder)) {
      // Unknown or invalid brace pattern
      return true;
    }
  }

  return false;
}

/**
 * Check if text contains shell metacharacters in a substituted value.
 * After substitution, no braces should remain.
 */
function containsShellMetachars(text: string): boolean {
  return SHELL_METACHARS_WITH_BRACES.test(text);
}

/** Dangerous patterns in test selectors that could be injection attempts */
const DANGEROUS_PATTERNS = [";", "$(", "`", "|", "&", " ", "/", "\\", "..", "\n", "\r"];

/**
 * Validate a test selector item against the kind's pattern and dangerous patterns.
 */
export function validateSelectorItem(
  item: string,
  config: SelectorConfig,
): { valid: true } | { valid: false; reason: string } {
  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (item.includes(pattern)) {
      return { valid: false, reason: `selector contains forbidden pattern "${pattern}"` };
    }
  }

  // Check against allowlist pattern (the project's regex, time-bounded: the item is the agent's)
  const matched = matchesWithin(config.pattern, item, PATTERN_TIMEOUT_MS);
  if (matched === "timeout") {
    return { valid: false, reason: `selector pattern ${config.pattern} took longer than ${PATTERN_TIMEOUT_MS} ms` };
  }
  if (!matched) {
    return { valid: false, reason: `selector item "${item.slice(0, 40)}" does not match pattern ${config.pattern}` };
  }

  return { valid: true };
}

/** How long the project's selector pattern may take on one item before the request is refused */
export const PATTERN_TIMEOUT_MS = 100;

const matchContext = createContext({ re: /./, value: "" });
const matchScript = new Script("re.test(value)");

/**
 * Test `value` against `pattern` in a vm context with a timeout, so a pattern
 * that backtracks badly is interrupted instead of stalling the event loop.
 */
export function matchesWithin(pattern: string, value: string, timeoutMs: number): boolean | "timeout" {
  matchContext.re = new RegExp(pattern);
  matchContext.value = value;
  try {
    return matchScript.runInContext(matchContext, { timeout: timeoutMs }) === true;
  } catch (e) {
    // Any other error (none is expected from test()) refuses the item too
    return (e as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? "timeout" : false;
  } finally {
    matchContext.value = "";
  }
}

// ============ Branch names ============

/**
 * Validate a branch name: it reaches git's argv, a refspec and the command's
 * {branch} placeholder. A subset of git's check-ref-format rules: starts with
 * a letter or digit (so no leading dash), only letters, digits, ".", "_", "-"
 * and "/", no "..", no "//", no segment starting with ".", no trailing "/" or
 * ".", no ".lock" suffix, and not HEAD.
 */
export function validateBranchName(branch: string): { valid: true } | { valid: false; reason: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)) {
    return { valid: false, reason: "branch must start with a letter or digit and use only letters, digits, . _ - /" };
  }
  if (branch.includes("..")) return { valid: false, reason: 'branch must not contain ".."' };
  if (branch.includes("//")) return { valid: false, reason: 'branch must not contain "//"' };
  if (branch.split("/").some((part) => part.startsWith("."))) {
    return { valid: false, reason: 'branch segments must not start with "."' };
  }
  if (branch.endsWith("/") || branch.endsWith(".")) return { valid: false, reason: 'branch must not end with "/" or "."' };
  if (branch.endsWith(".lock")) return { valid: false, reason: 'branch must not end with ".lock"' };
  if (branch === "HEAD") return { valid: false, reason: "branch must name a branch, not HEAD" };
  return { valid: true };
}

/**
 * Validate an entire tests array against the kind's configuration.
 */
export function validateSelector(
  tests: string[],
  config: SelectorConfig,
): { valid: true } | { valid: false; reason: string } {
  // Check count
  if (tests.length > config.max_count) {
    return { valid: false, reason: `too many tests: ${tests.length} > ${config.max_count}` };
  }

  // Check total length
  const totalLength = tests.join(" ").length;
  if (totalLength > config.max_length) {
    return { valid: false, reason: `tests total length ${totalLength} > ${config.max_length}` };
  }

  // Check each item
  for (const item of tests) {
    const result = validateSelectorItem(item, config);
    if (!result.valid) {
      return result;
    }
  }

  return { valid: true };
}

// ============ Command building ============

export interface CommandPlaceholders {
  sha: string;
  branch?: string;
  tests: string;
  agent: string;
  check_id: string;
  output_dir: string;
}

/**
 * Build the command argv by substituting placeholders.
 * Never runs through a shell. Returns null if a placeholder value is invalid.
 */
export function buildCommand(
  template: string[],
  placeholders: CommandPlaceholders,
): string[] | null {
  const result: string[] = [];

  for (const arg of template) {
    let substituted = arg;

    // Substitute each placeholder
    substituted = substituted.replace(/\{sha\}/g, placeholders.sha);
    substituted = substituted.replace(/\{branch\}/g, placeholders.branch ?? "");
    substituted = substituted.replace(/\{tests\}/g, placeholders.tests);
    substituted = substituted.replace(/\{agent\}/g, placeholders.agent);
    substituted = substituted.replace(/\{check_id\}/g, placeholders.check_id);
    substituted = substituted.replace(/\{output_dir\}/g, placeholders.output_dir);

    // Reject if result contains shell metachars (defense in depth)
    if (containsShellMetachars(substituted)) {
      return null;
    }

    // Reject if a placeholder that starts an argument produced a value starting with -
    if (arg.startsWith("{") && substituted.startsWith("-")) {
      return null;
    }

    result.push(substituted);
  }

  return result;
}
