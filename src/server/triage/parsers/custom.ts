/**
 * Custom regex parser: a config-defined parser with patterns for failing test
 * names and summaries. Allows projects to parse their own test frameworks'
 * output without code changes. Input is bounded to prevent regex attacks.
 *
 * Config shape (triage.parsers.custom):
 *   name: string           # parser id, used in cause.parser
 *   detect: string         # regex to detect this format (matched against first 2000 chars)
 *   fail_pattern: string   # regex with named groups: (?<suite>...), (?<name>...), (?<message>...)
 *   summary_pattern?: string  # regex to extract summary: (?<failed>\d+), (?<passed>\d+)
 *
 * All patterns are matched case-insensitively. Named groups are optional:
 *   - suite: the test's class/module (default: "(unknown)")
 *   - name: the test's name (required for a match to count)
 *   - message: the error message (default: "failed")
 *   - type: the error type (optional)
 *
 * Security:
 *   - Input is capped to 256 KB to bound regex execution time
 *   - Patterns with nested quantifiers, alternation under quantifiers, or backreferences are refused
 *   - Patterns that match the empty string are refused
 *   - Regex matching runs in a worker thread with a hard time bound (2 seconds per operation);
 *     the worker is terminated on timeout (Worker.terminate()) and the match fails closed with a
 *     triage notice "pattern timed out". This is a TRUE hard bound: the worker is killed mid-exec()
 *     so even a single catastrophic regex.exec() call cannot block Lair's event loop.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { boundedLines, clip, groupFailures, makeTest, type RawFailure } from "../text.js";
import type { AsyncEvidenceParser, ParseOptions, ParseOutput } from "./types.js";
import type { MatchAllResult, RegexRequest, RegexResult, TestResult } from "./regex-worker.js";

const MAX_ENTRIES = 5000;
/** Maximum input size in bytes: patterns run over untrusted test output */
const MAX_INPUT_BYTES = 256 * 1024;
/** Timeout for regex operations in milliseconds - a hard bound enforced by Worker.terminate() */
const REGEX_TIMEOUT_MS = 2000;

/** 
 * Get the worker path and exec args lazily. This avoids issues with import.meta.url
 * in client-side tests (where fileURLToPath throws) by deferring the check.
 */
function getWorkerConfig(): { path: string; execArgv: string[] } {
  const jsPath = fileURLToPath(new URL("./regex-worker.js", import.meta.url));
  const tsPath = fileURLToPath(new URL("./regex-worker.ts", import.meta.url));
  const useTsx = !existsSync(jsPath) && existsSync(tsPath);
  return {
    path: useTsx ? tsPath : jsPath,
    execArgv: useTsx ? ["--import", "tsx"] : [],
  };
}

let workerConfig: { path: string; execArgv: string[] } | null = null;
function getOrInitWorkerConfig(): { path: string; execArgv: string[] } {
  if (!workerConfig) {
    workerConfig = getWorkerConfig();
  }
  return workerConfig;
}

export interface CustomParserConfig {
  /** Parser id, shown in cause.parser */
  name: string;
  /** Regex to detect this format (matched against the start of the text) */
  detect: string;
  /** Regex with named groups to extract failing tests */
  fail_pattern: string;
  /** Optional regex to extract summary counts */
  summary_pattern?: string;
}

/** Compile a regex safely, returning null on invalid patterns. */
function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "gi");
  } catch {
    return null;
  }
}

/**
 * Track state at each group depth: whether it contains a quantifier and/or alternation.
 * Both can cause catastrophic backtracking when the group is itself quantified.
 */
interface GroupState {
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

/**
 * Check if a pattern contains nested quantifiers or alternation under a quantifier,
 * which can cause catastrophic backtracking.
 *
 * Dangerous patterns:
 *   - (a+)+, (\w*)*, (x+?)+ - nested quantifiers
 *   - (a|a)*, (a|aa)+, (\w|\d)+ - alternation under quantifier (overlapping matches)
 *   - ((a+))+ - quantifier in nested group under quantifier
 *
 * This check propagates "contains quantifier or alternation" up through nested groups.
 */
function hasNestedQuantifiers(pattern: string): boolean {
  // Track state at each nesting level
  let depth = 0;
  const stateAtDepth: GroupState[] = [{ hasQuantifier: false, hasAlternation: false }];
  let i = 0;
  const len = pattern.length;

  while (i < len) {
    const ch = pattern[i];

    // Skip escaped characters
    if (ch === "\\") {
      i += 2;
      continue;
    }

    // Skip character classes entirely - quantifiers inside [] are literals
    if (ch === "[") {
      i++;
      while (i < len && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }

    if (ch === "(") {
      depth++;
      // Check for special group prefixes: (?:, (?<name>, (?=, (?!, (?<=, (?<!
      // The ? after ( is NOT a quantifier in these cases
      if (i + 1 < len && pattern[i + 1] === "?") {
        // Skip the opening ( and ? for group prefixes
        // We still enter the group, but don't count ? as a quantifier
        i += 2;
        // Skip : or <name> or = or ! or <= or <!
        if (i < len && pattern[i] === ":") {
          i++; // non-capturing group (?:...)
        } else if (i < len && pattern[i] === "<") {
          // Named group (?<name>...) or lookbehind (?<=...) (?<!...)
          i++;
          if (i < len && (pattern[i] === "=" || pattern[i] === "!")) {
            i++; // lookbehind
          } else {
            // Named group - skip to >
            while (i < len && pattern[i] !== ">") i++;
            if (i < len) i++;
          }
        } else if (i < len && (pattern[i] === "=" || pattern[i] === "!")) {
          i++; // lookahead
        }
        stateAtDepth[depth] = { hasQuantifier: false, hasAlternation: false };
        continue;
      }
      stateAtDepth[depth] = { hasQuantifier: false, hasAlternation: false };
      i++;
      continue;
    }

    if (ch === ")") {
      const state = stateAtDepth[depth] ?? { hasQuantifier: false, hasAlternation: false };
      depth = Math.max(0, depth - 1);
      i++;

      // Check if this group is followed by a quantifier
      if (i < len && /[+*?]/.test(pattern[i])) {
        // A quantified group containing a quantifier or alternation is dangerous
        if (state.hasQuantifier || state.hasAlternation) return true;
        // Propagate: this depth now has a quantifier
        if (stateAtDepth[depth]) stateAtDepth[depth].hasQuantifier = true;
      } else if (i < len && pattern[i] === "{" && /\d/.test(pattern[i + 1] ?? "")) {
        if (state.hasQuantifier || state.hasAlternation) return true;
        if (stateAtDepth[depth]) stateAtDepth[depth].hasQuantifier = true;
      } else {
        // Group without quantifier: propagate its state to parent
        if (stateAtDepth[depth]) {
          if (state.hasQuantifier) stateAtDepth[depth].hasQuantifier = true;
          if (state.hasAlternation) stateAtDepth[depth].hasAlternation = true;
        }
      }
      continue;
    }

    // Alternation at current depth
    if (ch === "|") {
      if (stateAtDepth[depth]) stateAtDepth[depth].hasAlternation = true;
      i++;
      continue;
    }

    // Quantifiers at current depth
    if (/[+*]/.test(ch)) {
      if (stateAtDepth[depth]) stateAtDepth[depth].hasQuantifier = true;
      i++;
      // Skip ? modifier (non-greedy) and + (possessive)
      if (i < len && /[?+]/.test(pattern[i])) i++;
      continue;
    }

    // ? as a quantifier (not after open paren, which we handle above)
    if (ch === "?") {
      // This is a standalone ? quantifier (making previous optional)
      if (stateAtDepth[depth]) stateAtDepth[depth].hasQuantifier = true;
      i++;
      continue;
    }

    if (ch === "{" && /\d/.test(pattern[i + 1] ?? "")) {
      if (stateAtDepth[depth]) stateAtDepth[depth].hasQuantifier = true;
      while (i < len && pattern[i] !== "}") i++;
      i++;
      continue;
    }

    i++;
  }

  return false;
}

/**
 * Check if a pattern contains backreferences (\1, \2, etc.). Backreferences
 * can cause exponential time complexity with certain inputs.
 */
function hasBackreferences(pattern: string): boolean {
  // Match \1 through \9, or \k<name> for named backreferences
  return /\\[1-9]|\\k</.test(pattern);
}

/**
 * Check if a pattern can match the empty string. Such patterns cause infinite
 * loops with exec() when using the g flag, and are generally not useful for
 * extracting test names.
 */
function matchesEmptyString(pattern: string): boolean {
  try {
    const regex = new RegExp(pattern, "i");
    return regex.test("");
  } catch {
    return false;
  }
}

/** Result of a worker regex operation */
interface WorkerResult<T> {
  value: T;
  timedOut: boolean;
}

/**
 * Run a regex test in a worker thread with a hard timeout.
 * Returns { value: true/false, timedOut: boolean }.
 * On timeout, the worker is terminated to prevent event loop blocking.
 */
async function workerRegexTest(pattern: string, flags: string, text: string, timeoutMs: number): Promise<WorkerResult<boolean>> {
  return new Promise((resolve) => {
    const req: RegexRequest = { kind: "test", pattern, flags, text };
    const config = getOrInitWorkerConfig();
    const worker = new Worker(config.path, { 
      workerData: req,
      execArgv: config.execArgv,
    });

    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ value: false, timedOut: true });
    }, timeoutMs);

    worker.on("message", (result: RegexResult | { error: string }) => {
      clearTimeout(timer);
      if ("error" in result) {
        resolve({ value: false, timedOut: false });
      } else if (result.kind === "test") {
        resolve({ value: (result as TestResult).matched, timedOut: false });
      } else {
        resolve({ value: false, timedOut: false });
      }
      worker.terminate();
    });

    worker.on("error", () => {
      clearTimeout(timer);
      resolve({ value: false, timedOut: false });
    });

    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) resolve({ value: false, timedOut: false });
    });
  });
}

/**
 * Run regex matchAll in a worker thread with a hard timeout.
 * Returns { value: matches[], timedOut: boolean }.
 * On timeout, the worker is terminated to prevent event loop blocking.
 */
async function workerRegexMatchAll(
  pattern: string,
  flags: string,
  text: string,
  maxMatches: number,
  timeoutMs: number,
): Promise<WorkerResult<MatchAllResult["matches"]>> {
  return new Promise((resolve) => {
    const req: RegexRequest = { kind: "matchAll", pattern, flags, text, maxMatches };
    const config = getOrInitWorkerConfig();
    const worker = new Worker(config.path, { 
      workerData: req,
      execArgv: config.execArgv,
    });

    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ value: [], timedOut: true });
    }, timeoutMs);

    worker.on("message", (result: RegexResult | { error: string }) => {
      clearTimeout(timer);
      if ("error" in result) {
        resolve({ value: [], timedOut: false });
      } else if (result.kind === "matchAll") {
        resolve({ value: (result as MatchAllResult).matches, timedOut: false });
      } else {
        resolve({ value: [], timedOut: false });
      }
      worker.terminate();
    });

    worker.on("error", () => {
      clearTimeout(timer);
      resolve({ value: [], timedOut: false });
    });

    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) resolve({ value: [], timedOut: false });
    });
  });
}

/**
 * Create an async custom parser from config. Returns null if patterns are invalid.
 *
 * The parser uses worker threads with hard timeouts (Worker.terminate()) to ensure
 * even catastrophic regex patterns cannot block Lair's event loop. When a pattern
 * times out, detect() returns false and parse() returns empty results with a note
 * explaining the timeout ("pattern timed out" triage notice).
 *
 * The returned parser has `async: true` set so callers can identify it needs
 * async handling via isAsyncParser().
 */
export function createCustomParser(config: CustomParserConfig): AsyncEvidenceParser & { async: true } | null {
  const detectRegex = compileRegex(config.detect);
  const failRegex = compileRegex(config.fail_pattern);
  const summaryRegex = config.summary_pattern ? compileRegex(config.summary_pattern) : null;

  if (!detectRegex || !failRegex) {
    return null;
  }

  const detect = async (text: string, _lines: string[]): Promise<boolean> => {
    const result = await workerRegexTest(detectRegex.source, detectRegex.flags, text.slice(0, 2000), REGEX_TIMEOUT_MS);
    // On timeout, return false (fail closed: don't use this parser)
    return result.value;
  };

  const parse = async (text: string, options: ParseOptions): Promise<ParseOutput> => {
    const notes: string[] = [];

    // Cap input to 256 KB (the tail) to bound regex execution time
    const bounded = text.length > MAX_INPUT_BYTES ? text.slice(-MAX_INPUT_BYTES) : text;
    const lines = boundedLines(bounded);
    const fullText = lines.join("\n");
    const raws: RawFailure[] = [];
    let failedCount: number | undefined;

    // Extract summary if pattern is provided
    if (summaryRegex) {
      const summaryResult = await workerRegexMatchAll(
        summaryRegex.source,
        summaryRegex.flags,
        fullText,
        1,
        REGEX_TIMEOUT_MS,
      );
      if (summaryResult.timedOut) {
        notes.push(`custom parser '${config.name}': summary_pattern timed out (>${REGEX_TIMEOUT_MS}ms)`);
      } else if (summaryResult.value.length > 0 && summaryResult.value[0].groups.failed) {
        failedCount = Number(summaryResult.value[0].groups.failed);
      }
    }

    // Extract failing tests using worker thread with hard timeout
    const matchResult = await workerRegexMatchAll(
      failRegex.source,
      failRegex.flags,
      fullText,
      MAX_ENTRIES,
      REGEX_TIMEOUT_MS,
    );

    if (matchResult.timedOut) {
      notes.push(`custom parser '${config.name}': fail_pattern timed out (>${REGEX_TIMEOUT_MS}ms), results incomplete`);
      // Return what we have (empty) with the timeout note - fail closed
      return {
        causes: [],
        passed: [],
        flaky: [],
        failedCount,
        notes,
      };
    }

    const seen = new Set<string>();
    for (const match of matchResult.value) {
      if (raws.length >= MAX_ENTRIES) break;

      const groups = match.groups;
      const name = groups.name?.trim();
      if (!name) continue;

      const suite = groups.suite?.trim() || "(unknown)";
      const key = `${suite}#${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const message = groups.message?.trim() || "failed";
      const type = groups.type?.trim();

      // Find context lines around the match
      const matchStart = match.index;
      const matchEnd = matchStart + match.match.length;
      const beforeStart = fullText.lastIndexOf("\n", matchStart) + 1;
      const afterEnd = fullText.indexOf("\n", matchEnd);
      const contextLines = fullText
        .slice(Math.max(0, beforeStart - 200), afterEnd > 0 ? afterEnd + 200 : undefined)
        .split("\n")
        .slice(0, 10);

      raws.push({
        test: makeTest(suite, name),
        type,
        message: clip(message),
        lines: contextLines,
        parser: config.name,
        step: options.step,
        evidence: [clip(message), ...contextLines.slice(0, 4).map((l) => clip(l))],
      });
    }

    return {
      causes: groupFailures(raws, options.contextPatterns),
      passed: [],
      flaky: [],
      failedCount,
      notes: notes.length > 0 ? notes : undefined,
    };
  };

  return {
    id: config.name,
    source: "console",
    async: true,
    detect,
    parse,
  };
}

/**
 * Run a catastrophic regex test with worker thread protection.
 * Exported for testing the worker timeout behavior.
 *
 * @param pattern - The regex pattern to test
 * @param text - The text to match against
 * @param timeoutMs - Timeout in milliseconds
 * @returns { timedOut: boolean, matched: boolean }
 */
export async function runCatastrophicRegexTest(
  pattern: string,
  text: string,
  timeoutMs: number,
): Promise<{ timedOut: boolean; matched: boolean }> {
  const result = await workerRegexTest(pattern, "g", text, timeoutMs);
  return { timedOut: result.timedOut, matched: result.value };
}

/**
 * Validate a custom parser config. Returns an array of error messages
 * (empty if valid).
 *
 * Security checks:
 *   - Patterns must be valid regexes
 *   - fail_pattern must not match the empty string (causes infinite loops)
 *   - Patterns must not contain nested quantifiers or alternation under quantifiers (catastrophic backtracking)
 *   - Patterns must not contain backreferences (exponential time complexity)
 */
export function validateCustomParserConfig(config: unknown): string[] {
  const errors: string[] = [];

  // Built-in parser ids that custom parsers cannot use
  const BUILTIN_IDS = ["junit", "trx", "gradle", "vitest", "jest", "pytest", "go", "cargo"];

  if (!config || typeof config !== "object") {
    return ["custom parser config must be an object"];
  }

  const c = config as Record<string, unknown>;

  if (typeof c.name !== "string" || c.name.length === 0) {
    errors.push("custom parser requires a non-empty 'name' field");
  } else if (!/^[a-z][a-z0-9_-]{0,31}$/.test(c.name)) {
    errors.push("custom parser name must start with a letter and contain only lowercase alphanumeric, hyphens and underscores (max 32 chars)");
  } else if (BUILTIN_IDS.includes(c.name)) {
    errors.push(`custom parser name '${c.name}' conflicts with a built-in parser`);
  }

  if (typeof c.detect !== "string" || c.detect.length === 0) {
    errors.push("custom parser requires a non-empty 'detect' pattern");
  } else {
    const detectRegex = compileRegex(c.detect);
    if (!detectRegex) {
      errors.push("custom parser 'detect' pattern is not a valid regex");
    } else {
      if (hasNestedQuantifiers(c.detect)) {
        errors.push("custom parser 'detect' pattern contains nested quantifiers, which can cause catastrophic backtracking");
      }
      if (hasBackreferences(c.detect)) {
        errors.push("custom parser 'detect' pattern contains backreferences, which can cause exponential time complexity");
      }
    }
  }

  if (typeof c.fail_pattern !== "string" || c.fail_pattern.length === 0) {
    errors.push("custom parser requires a non-empty 'fail_pattern'");
  } else {
    const regex = compileRegex(c.fail_pattern);
    if (!regex) {
      errors.push("custom parser 'fail_pattern' is not a valid regex");
    } else {
      if (!c.fail_pattern.includes("(?<name>")) {
        errors.push("custom parser 'fail_pattern' must include a (?<name>...) capture group");
      }
      if (matchesEmptyString(c.fail_pattern)) {
        errors.push("custom parser 'fail_pattern' must not match the empty string (causes infinite loops)");
      }
      if (hasNestedQuantifiers(c.fail_pattern)) {
        errors.push("custom parser 'fail_pattern' contains nested quantifiers, which can cause catastrophic backtracking");
      }
      if (hasBackreferences(c.fail_pattern)) {
        errors.push("custom parser 'fail_pattern' contains backreferences, which can cause exponential time complexity");
      }
    }
  }

  if (c.summary_pattern !== undefined) {
    if (typeof c.summary_pattern !== "string") {
      errors.push("custom parser 'summary_pattern' must be a string");
    } else if (c.summary_pattern.length > 0) {
      const summaryRegex = compileRegex(c.summary_pattern);
      if (!summaryRegex) {
        errors.push("custom parser 'summary_pattern' is not a valid regex");
      } else {
        if (hasNestedQuantifiers(c.summary_pattern)) {
          errors.push("custom parser 'summary_pattern' contains nested quantifiers, which can cause catastrophic backtracking");
        }
        if (hasBackreferences(c.summary_pattern)) {
          errors.push("custom parser 'summary_pattern' contains backreferences, which can cause exponential time complexity");
        }
      }
    }
  }

  return errors;
}
