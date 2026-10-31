/**
 * Cargo test output (Rust): the text format with "test name ... FAILED" lines,
 * followed by "failures:" sections listing the failed tests and their output.
 * Also detects build failures ("error[E0XXX]:") before tests run.
 * Reads bounded lines only.
 */
import { boundedLines, clip, groupFailures, makeTest, parseThrowable, type RawFailure } from "../text.js";
import type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";

const MAX_ENTRIES = 5000;
const MAX_SECTION_LINES = 400;

// "test module::submodule::test_name ... FAILED"
const TEST_RESULT = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED|ignored)/;
// "---- module::submodule::test_name stdout ----"
const SECTION_HEADER = /^----\s+(\S+)\s+stdout\s+----$/;
// Summary line: "test result: FAILED. 3 passed; 1 failed; 0 ignored"
const SUMMARY = /^test result:\s+(ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/;
// Rust compiler error: "error[E0425]: cannot find value `x` in this scope"
const COMPILER_ERROR = /^error\[E\d+\]:\s+(.+)$/;
// Old panic format (pre-1.73): "thread 'test_name' panicked at 'message', location"
const PANIC_OLD = /^thread\s+'[^']+'\s+panicked\s+at\s+'(.+)$/;
// New panic format (Rust 1.73+): "thread 'test_name' panicked at src/lib.rs:45:9:"
// followed by the message on the next line(s)
const PANIC_NEW = /^thread\s+'[^']+'\s+panicked\s+at\s+(\S+\.rs):(\d+):\d+:?\s*$/;
// Location in old panic: "src/lib.rs:42:5"
const PANIC_LOCATION = /^(\S+\.rs):(\d+):\d+$/;

interface Section {
  name: string;
  lines: string[];
}

function extractError(lines: string[]): { type?: string; message: string; file?: string; line?: number } {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Try new Rust 1.73+ panic format first: "thread 'x' panicked at src/lib.rs:45:9:"
    const panicNew = line.match(PANIC_NEW);
    if (panicNew) {
      // The message is on the following lines
      const messageParts: string[] = [];
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const nextLine = lines[j].trim();
        // Stop at stack trace or other panic info
        if (nextLine.startsWith("note:") || nextLine.startsWith("stack backtrace:") || nextLine === "") {
          break;
        }
        messageParts.push(nextLine);
      }
      const message = messageParts.join(" ").trim() || "panicked";
      return { type: "panic", message, file: panicNew[1], line: Number(panicNew[2]) };
    }

    // Old panic format: "thread 'x' panicked at 'message', location"
    const panicOld = line.match(PANIC_OLD);
    if (panicOld) {
      // Look for location in subsequent lines
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const loc = lines[j].trim().match(PANIC_LOCATION);
        if (loc) {
          return { type: "panic", message: panicOld[1], file: loc[1], line: Number(loc[2]) };
        }
      }
      return { type: "panic", message: panicOld[1] };
    }

    // assertion failures
    if (/assertion.*failed|assert(_eq|_ne)?!/i.test(line)) {
      return { type: "AssertionError", message: clip(line.trim()) };
    }
  }

  // Fall back to first non-empty line
  const first = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  return parseThrowable(first);
}

export function parseCargoTest(text: string, options: ParseOptions): ParseOutput {
  const lines = boundedLines(text);
  const failedTests = new Set<string>();
  const sections = new Map<string, Section>();
  const compilerErrors: string[] = [];
  let current: Section | null = null;
  let failedCount: number | undefined;

  for (const line of lines) {
    // Track compiler errors (build failures)
    const compError = line.match(COMPILER_ERROR);
    if (compError && compilerErrors.length < 20) {
      compilerErrors.push(line);
      continue;
    }

    // Summary line
    const summary = line.match(SUMMARY);
    if (summary) {
      failedCount = Number(summary[3]);
      continue;
    }

    // Test result lines
    const result = line.match(TEST_RESULT);
    if (result) {
      if (result[2] === "FAILED") {
        failedTests.add(result[1]);
      }
      continue;
    }

    // Start of failures section
    if (/^failures:$/.test(line.trim())) {
      current = null;
      continue;
    }

    // End of failures section (test result line)
    if (/^test result:/.test(line)) {
      current = null;
    }

    // Section headers in failures output
    const sectionHeader = line.match(SECTION_HEADER);
    if (sectionHeader) {
      const name = sectionHeader[1];
      current = { name, lines: [] };
      if (!sections.has(name)) {
        sections.set(name, current);
      }
      continue;
    }

    // Collect section content
    if (current && current.lines.length < MAX_SECTION_LINES) {
      current.lines.push(line);
    }
  }

  const raws: RawFailure[] = [];

  // Build failure (compiler errors before tests)
  if (compilerErrors.length > 0 && failedTests.size === 0) {
    const first = compilerErrors[0];
    const match = first.match(COMPILER_ERROR);
    raws.push({
      kind: "build",
      message: match ? match[1] : first,
      type: "CompileError",
      lines: compilerErrors,
      parser: "cargo",
      step: options.step,
      evidence: compilerErrors.slice(0, 6).map((l) => clip(l)),
    });
  }

  // Test failures
  for (const testName of failedTests) {
    if (raws.length >= MAX_ENTRIES) break;

    const section = sections.get(testName);
    const sectionLines = section?.lines ?? [];
    const error = extractError(sectionLines);

    // Parse test name: "module::submodule::test_name" -> suite "module::submodule", name "test_name"
    const parts = testName.split("::");
    const name = parts.pop() ?? testName;
    const suite = parts.join("::") || "(root)";

    raws.push({
      test: makeTest(suite, name, { file: error.file }),
      type: error.type,
      message: error.message,
      lines: sectionLines,
      parser: "cargo",
      step: options.step,
      evidence: sectionLines
        .filter((l) => l.trim().length > 0)
        .slice(0, 6)
        .map((l) => clip(l)),
    });
  }

  return {
    causes: groupFailures(raws, options.contextPatterns),
    passed: [],
    flaky: [],
    failedCount,
  };
}

export const cargoTestParser: EvidenceParser = {
  id: "cargo",
  source: "console",
  detect: (_text, lines) => {
    // Detect cargo test output: "running N tests" or "test result: ..." or "test name ... ok/FAILED"
    for (const line of lines) {
      if (/^running \d+ tests?$/.test(line.trim())) return true;
      if (/^test result:\s+(ok|FAILED)\./.test(line)) return true;
      if (TEST_RESULT.test(line)) return true;
    }
    return false;
  },
  parse: parseCargoTest,
};
