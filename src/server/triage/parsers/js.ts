/**
 * vitest and jest console output.
 *
 * vitest: " FAIL  file > describe > test" blocks in its "Failed Tests"
 * section (and " FAIL  file [ file ]" for a file that failed to load), each
 * followed by the error and " ❯ file:line:col" frames.
 *
 * jest: "FAIL file" headers followed by "● describe › test" blocks ("● Test
 * suite failed to run" for a file that failed to load).
 *
 * Both read bounded lines only, and parse headers with string scans.
 */
import type { TestRef } from "../../../shared/triage-types.js";
import { boundedLines, groupFailures, makeTest, parseThrowable, type RawFailure } from "../text.js";
import type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";

const FAIL_PREFIX = /^\s*FAIL\s+/;
const VITEST_SEPARATOR = /^\s*⎯⎯/;
const VITEST_SUMMARY = /^\s*(Test Files|Tests)\s+\d+\s+(failed|passed)/;
const VITEST_TESTS_FAILED = /^\s*Tests\s+(\d+)\s+failed/;
const DIFF_LINE = /^\s*([-+]\s|[-+]$|\d+\|)|^\s*\|/;
const MAX_FAILURES = 5000;

/** " FAIL  file > a > b" -> file and name; " FAIL  file [ file ]" -> file only; else null. */
export function vitestHeader(line: string): { file: string; name?: string } | null {
  const prefix = line.match(FAIL_PREFIX);
  if (!prefix) return null;
  let rest = line.slice(prefix[0].length);
  // A workspace project name: "|unit| file > ..."
  if (rest.startsWith("|")) {
    const end = rest.indexOf("|", 1);
    if (end < 0) return null;
    rest = rest.slice(end + 1).trimStart();
  }
  const space = rest.search(/\s/);
  if (space <= 0) return null;
  const file = rest.slice(0, space);
  const after = rest.slice(space).trim();
  if (after.startsWith(">")) {
    const name = after.slice(1).trim();
    return name ? { file, name } : null;
  }
  if (after.startsWith("[") && after.endsWith("]")) return { file };
  return null;
}

/** The first line that reads as an error. */
function errorOf(body: string[]): { type?: string; message: string } {
  const lines = body.map((l) => l.trim()).filter((l) => l.length > 0 && !DIFF_LINE.test(l));
  const errorLine = lines.find((l) => /^(\w*(Error|Exception)|Error)\b/.test(l)) ?? lines[0] ?? "";
  return parseThrowable(errorLine);
}

export function parseVitest(text: string, options: ParseOptions): ParseOutput {
  const lines = boundedLines(text);
  const raws: RawFailure[] = [];
  let failedCount: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const counted = lines[i].match(VITEST_TESTS_FAILED);
    if (counted) failedCount = Number(counted[1]);
    const header = vitestHeader(lines[i]);
    if (!header) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (vitestHeader(line) || VITEST_SEPARATOR.test(line) || VITEST_SUMMARY.test(line)) break;
      body.push(line);
      i = j;
    }
    if (raws.length >= MAX_FAILURES) continue;
    const suiteFailed = header.name === undefined;
    const error = errorOf(body);
    raws.push({
      test: makeTest(header.file, header.name ?? "(suite)", { file: header.file }),
      type: error.type,
      message: error.message,
      lines: body,
      parser: "vitest",
      step: options.step,
      kind: suiteFailed ? "context" : undefined,
      contextText: suiteFailed ? "the test file failed to load" : undefined,
    });
  }
  return { causes: groupFailures(raws, options.contextPatterns), passed: [], flaky: [], failedCount };
}

const JEST_FILE = /^\s*(FAIL|PASS)\s+(\S+)/;
const JEST_SUMMARY = /^\s*(Tests|Test Suites|Snapshots|Time):\s+/;
const JEST_TESTS_FAILED = /^\s*Tests:\s+(\d+)\s+failed/;

/** "  ● a › b" -> "a › b"; else null. */
function jestEntry(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("●")) return null;
  const name = trimmed.slice(1).trim();
  return name || null;
}

export function parseJest(text: string, options: ParseOptions): ParseOutput {
  const lines = boundedLines(text);
  const raws: RawFailure[] = [];
  let file = "(unknown)";
  let failedCount: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const counted = lines[i].match(JEST_TESTS_FAILED);
    if (counted) failedCount = Number(counted[1]);
    const header = lines[i].match(JEST_FILE);
    if (header) {
      file = header[2];
      continue;
    }
    const entry = jestEntry(lines[i]);
    if (!entry) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (jestEntry(line) || JEST_FILE.test(line) || JEST_SUMMARY.test(line)) break;
      body.push(line);
      i = j;
    }
    if (raws.length >= MAX_FAILURES) continue;
    const name = entry.split(" › ").join(" > ");
    const suiteFailed = /^Test suite failed to run$/i.test(name);
    const error = errorOf(body);
    const test: TestRef = makeTest(file, suiteFailed ? "(suite)" : name, { file });
    raws.push({
      test,
      type: error.type,
      message: error.message,
      lines: body,
      parser: "jest",
      step: options.step,
      kind: suiteFailed ? "context" : undefined,
      contextText: name,
    });
  }
  return { causes: groupFailures(raws, options.contextPatterns), passed: [], flaky: [], failedCount };
}

export const vitestParser: EvidenceParser = {
  id: "vitest",
  source: "console",
  detect: (_text, lines) =>
    lines.some(
      (l) =>
        /^\s*Test Files\s+\d+\s+(failed|passed)/.test(l) ||
        (l.includes("⎯⎯") && /Failed (Tests|Suites)/.test(l)) ||
        vitestHeader(l) !== null,
    ),
  parse: parseVitest,
};

export const jestParser: EvidenceParser = {
  id: "jest",
  source: "console",
  detect: (_text, lines) =>
    lines.some((l) => /^\s*Test Suites:\s+\d+/.test(l)) ||
    (lines.some((l) => jestEntry(l) !== null) && lines.some((l) => /^\s*FAIL\s+\S+\s*$/.test(l))),
  parse: parseJest,
};
