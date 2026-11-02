/**
 * Go test output: `go test -json` produces one JSON object per line with
 * Test (test name), Package (suite), Action (pass, fail, output, etc.) and
 * Output (the line's text). A test that fails has Action "fail" with its
 * Output lines before it. Reads bounded lines only.
 */
import { boundedLines, clip, groupFailures, makeTest, parseThrowable, type RawFailure } from "../text.js";
import type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";

const MAX_ENTRIES = 5000;
const MAX_OUTPUT_LINES = 400;

interface GoTestEvent {
  Time?: string;
  Action: string;
  Package?: string;
  Test?: string;
  Output?: string;
  Elapsed?: number;
}

/** Parse a line as a go test JSON event; returns null if not valid JSON or missing Action. */
function parseEvent(line: string): GoTestEvent | null {
  if (!line.startsWith("{")) return null;
  try {
    const event = JSON.parse(line) as unknown;
    if (typeof event !== "object" || event === null) return null;
    const obj = event as Record<string, unknown>;
    if (typeof obj.Action !== "string") return null;
    return {
      Time: typeof obj.Time === "string" ? obj.Time : undefined,
      Action: obj.Action,
      Package: typeof obj.Package === "string" ? obj.Package : undefined,
      Test: typeof obj.Test === "string" ? obj.Test : undefined,
      Output: typeof obj.Output === "string" ? obj.Output : undefined,
      Elapsed: typeof obj.Elapsed === "number" ? obj.Elapsed : undefined,
    };
  } catch {
    return null;
  }
}

/** Extract the error message from output lines (typically after "--- FAIL:"). */
function extractError(outputs: string[]): { type?: string; message: string } {
  const errorLines = outputs
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("--- FAIL:") && !l.startsWith("=== RUN") && !l.startsWith("=== PAUSE") && !l.startsWith("=== CONT"));

  // Look for common Go error patterns
  for (const line of errorLines) {
    // panic: message
    if (line.startsWith("panic:")) {
      return { type: "panic", message: line.slice(6).trim() };
    }
    // Error messages from testing.T
    if (/^\s*(Error|Fatal)/.test(line)) {
      return parseThrowable(line);
    }
    // Assertion failures (testify, etc.)
    if (/assert.*failed|expected.*got|not equal/i.test(line)) {
      return { type: "AssertionError", message: clip(line) };
    }
  }

  // Fall back to the first non-empty line
  const first = errorLines[0] ?? "";
  return parseThrowable(first);
}

export function parseGoTest(text: string, options: ParseOptions): ParseOutput {
  const lines = boundedLines(text);
  const testOutputs = new Map<string, string[]>(); // key: "package::test"
  const failures: { pkg: string; test: string; outputs: string[] }[] = [];
  let failedCount = 0;

  for (const line of lines) {
    const event = parseEvent(line);
    if (!event) continue;

    const pkg = event.Package ?? "(unknown)";
    const test = event.Test;
    const key = test ? `${pkg}::${test}` : pkg;

    switch (event.Action) {
      case "output":
        if (event.Output) {
          const outputs = testOutputs.get(key) ?? [];
          if (outputs.length < MAX_OUTPUT_LINES) {
            outputs.push(event.Output.replace(/\n$/, ""));
          }
          testOutputs.set(key, outputs);
        }
        break;

      case "fail":
        if (test && failures.length < MAX_ENTRIES) {
          failedCount++;
          const outputs = testOutputs.get(key) ?? [];
          failures.push({ pkg, test, outputs: [...outputs] });
        } else if (!test) {
          // Package-level failure: only include if no tests in this package failed
          // (a package "fail" with test failures is just a summary, not a build error)
          const hasTestFailures = failures.some((f) => f.pkg === pkg && f.test !== "(package)");
          if (!hasTestFailures) {
            const outputs = testOutputs.get(key) ?? [];
            if (outputs.length > 0 && failures.length < MAX_ENTRIES) {
              failures.push({ pkg, test: "(package)", outputs: [...outputs] });
            }
          }
        }
        break;

      case "pass":
        // Track passed tests for future metrics
        break;
    }
  }

  const raws: RawFailure[] = failures.map((f) => {
    const error = extractError(f.outputs);
    const isPackageFailure = f.test === "(package)";
    return {
      test: makeTest(f.pkg, f.test),
      type: error.type,
      message: error.message,
      lines: f.outputs,
      parser: "go",
      step: options.step,
      kind: isPackageFailure ? "build" : undefined,
      evidence: f.outputs
        .filter((l) => l.trim().length > 0)
        .slice(0, 6)
        .map((l) => clip(l)),
    };
  });

  return {
    causes: groupFailures(raws, options.contextPatterns),
    passed: [],
    flaky: [],
    failedCount: failedCount > 0 ? failedCount : undefined,
  };
}

export const goTestParser: EvidenceParser = {
  id: "go",
  source: "console",
  detect: (_text, lines) => {
    // Detect go test -json output: lines starting with { that have "Action" field
    // Scan all bounded lines, not just the first 100 - a cold-cache run may have
    // many "go: downloading" lines before the first test event.
    let jsonLines = 0;
    for (const line of lines) {
      if (line.startsWith("{") && line.includes('"Action"')) {
        jsonLines++;
        if (jsonLines >= 3) return true;
      }
    }
    return false;
  },
  parse: parseGoTest,
};
