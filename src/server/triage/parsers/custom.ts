/**
 * Custom regex parser: a config-defined parser with patterns for failing test
 * names and summaries. Allows projects to parse their own test frameworks'
 * output without code changes. Input is bounded to prevent regex attacks.
 *
 * Config shape (triage.parsers.custom):
 *   name: string           # parser id, used in cause.parser
 *   detect: string         # regex to detect this format (matched against first 1000 chars)
 *   fail_pattern: string   # regex with named groups: (?<suite>...), (?<name>...), (?<message>...)
 *   summary_pattern?: string  # regex to extract summary: (?<failed>\d+), (?<passed>\d+)
 *
 * All patterns are matched case-insensitively. Named groups are optional:
 *   - suite: the test's class/module (default: "(unknown)")
 *   - name: the test's name (required for a match to count)
 *   - message: the error message (default: "failed")
 *   - type: the error type (optional)
 */
import { boundedLines, clip, groupFailures, makeTest, type RawFailure } from "../text.js";
import type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";

const MAX_ENTRIES = 5000;

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

/** Create a custom parser from config. Returns null if patterns are invalid. */
export function createCustomParser(config: CustomParserConfig): EvidenceParser | null {
  const detectRegex = compileRegex(config.detect);
  const failRegex = compileRegex(config.fail_pattern);
  const summaryRegex = config.summary_pattern ? compileRegex(config.summary_pattern) : null;

  if (!detectRegex || !failRegex) {
    return null;
  }

  const parse = (text: string, options: ParseOptions): ParseOutput => {
    const lines = boundedLines(text);
    const fullText = lines.join("\n");
    const raws: RawFailure[] = [];
    let failedCount: number | undefined;

    // Extract summary if pattern is provided
    if (summaryRegex) {
      summaryRegex.lastIndex = 0;
      const summaryMatch = summaryRegex.exec(fullText);
      if (summaryMatch?.groups?.failed) {
        failedCount = Number(summaryMatch.groups.failed);
      }
    }

    // Extract failing tests
    failRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();

    while ((match = failRegex.exec(fullText)) !== null && raws.length < MAX_ENTRIES) {
      const groups = match.groups ?? {};
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
      const matchEnd = matchStart + match[0].length;
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
    };
  };

  return {
    id: config.name,
    source: "console",
    detect: (text, _lines) => {
      detectRegex.lastIndex = 0;
      return detectRegex.test(text.slice(0, 2000));
    },
    parse,
  };
}

/**
 * Validate a custom parser config. Returns an array of error messages
 * (empty if valid).
 */
export function validateCustomParserConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (!config || typeof config !== "object") {
    return ["custom parser config must be an object"];
  }

  const c = config as Record<string, unknown>;

  if (typeof c.name !== "string" || c.name.length === 0) {
    errors.push("custom parser requires a non-empty 'name' field");
  } else if (!/^[a-z][a-z0-9_-]{0,31}$/.test(c.name)) {
    errors.push("custom parser name must be lowercase alphanumeric with hyphens/underscores (max 32 chars)");
  }

  if (typeof c.detect !== "string" || c.detect.length === 0) {
    errors.push("custom parser requires a non-empty 'detect' pattern");
  } else if (!compileRegex(c.detect)) {
    errors.push("custom parser 'detect' pattern is not a valid regex");
  }

  if (typeof c.fail_pattern !== "string" || c.fail_pattern.length === 0) {
    errors.push("custom parser requires a non-empty 'fail_pattern'");
  } else {
    const regex = compileRegex(c.fail_pattern);
    if (!regex) {
      errors.push("custom parser 'fail_pattern' is not a valid regex");
    } else if (!c.fail_pattern.includes("(?<name>")) {
      errors.push("custom parser 'fail_pattern' must include a (?<name>...) capture group");
    }
  }

  if (c.summary_pattern !== undefined) {
    if (typeof c.summary_pattern !== "string") {
      errors.push("custom parser 'summary_pattern' must be a string");
    } else if (c.summary_pattern.length > 0 && !compileRegex(c.summary_pattern)) {
      errors.push("custom parser 'summary_pattern' is not a valid regex");
    }
  }

  return errors;
}
