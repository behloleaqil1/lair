/**
 * vitest and jest console output.
 *
 * vitest: " FAIL  file > describe > test" blocks in its "Failed Tests"
 * section (and " FAIL  file [ file ]" for a file that failed to load), each
 * followed by the error and " ❯ file:line:col" frames.
 *
 * jest: "FAIL file" headers followed by "● describe › test" blocks ("● Test
 * suite failed to run" for a file that failed to load).
 */
import type { TestRef } from "../../../shared/triage-types.js";
import { cleanLog, groupFailures, makeTest, parseThrowable, type RawFailure } from "../text.js";
import type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";

const VITEST_HEADER = /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+)\s+(?:>\s+(.+?)|\[\s*\S+\s*\])\s*$/;
const VITEST_SEPARATOR = /^\s*⎯{2,}/;
const VITEST_SUMMARY = /^\s*(Test Files|Tests)\s+\d+\s+(failed|passed)/;
const VITEST_TESTS_FAILED = /^\s*Tests\s+(\d+)\s+failed/;
const DIFF_LINE = /^\s*([-+]\s|[-+]$|\d+\|)|^\s*\|/;

/** The first line that reads as an error, and the body lines to keep. */
function errorOf(body: string[]): { type?: string; message: string } {
  const lines = body.map((l) => l.trim()).filter((l) => l.length > 0 && !DIFF_LINE.test(l));
  const errorLine = lines.find((l) => /^(\w*(Error|Exception)|Error)\b/.test(l)) ?? lines[0] ?? "";
  return parseThrowable(errorLine);
}

export function parseVitest(text: string, options: ParseOptions): ParseOutput {
  const lines = cleanLog(text).split("\n");
  const raws: RawFailure[] = [];
  let failedCount: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const counted = lines[i].match(VITEST_TESTS_FAILED);
    if (counted) failedCount = Number(counted[1]);
    const header = lines[i].match(VITEST_HEADER);
    if (!header) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (VITEST_HEADER.test(line) || VITEST_SEPARATOR.test(line) || VITEST_SUMMARY.test(line)) break;
      body.push(line);
      i = j;
    }
    const file = header[1];
    const suiteFailed = header[2] === undefined;
    const error = errorOf(body);
    raws.push({
      test: makeTest(file, suiteFailed ? "(suite)" : header[2], { file }),
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
const JEST_ENTRY = /^\s*●\s+(.+?)\s*$/;
const JEST_SUMMARY = /^\s*(Tests|Test Suites|Snapshots|Time):\s+/;
const JEST_TESTS_FAILED = /^\s*Tests:\s+(\d+)\s+failed/;

export function parseJest(text: string, options: ParseOptions): ParseOutput {
  const lines = cleanLog(text).split("\n");
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
    const entry = lines[i].match(JEST_ENTRY);
    if (!entry) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (JEST_ENTRY.test(line) || JEST_FILE.test(line) || JEST_SUMMARY.test(line)) break;
      body.push(line);
      i = j;
    }
    const name = entry[1].split(" › ").join(" > ");
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
  detect: (text) =>
    /^\s*Test Files\s+\d+\s+(failed|passed)/m.test(text) ||
    /⎯{2,}\s*Failed (Tests|Suites)/.test(text) ||
    /^\s*FAIL\s+\S+\s+(>\s|\[\s)/m.test(text),
  parse: parseVitest,
};

export const jestParser: EvidenceParser = {
  id: "jest",
  source: "console",
  detect: (text) => /^\s*Test Suites:\s+\d+/m.test(text) || (/^\s*●\s/m.test(text) && /^\s*FAIL\s+\S+\s*$/m.test(text)),
  parse: parseJest,
};
