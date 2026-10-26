/**
 * Gradle console output: "Class > test FAILED" blocks with their indented
 * exception and "Caused by" lines, the "N tests completed, M failed" summary,
 * and, when no test failed, the "* What went wrong:" block (a build or
 * compile failure). Reads bounded lines only, and finds test headers with
 * string scans rather than a backtracking pattern.
 */
import { boundedLines, clip, groupFailures, makeTest, parseThrowable, type RawFailure } from "../text.js";
import type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";

const SUMMARY = /^(\d+) tests? completed, (\d+) failed/;
const WHAT_WENT_WRONG = /^\* What went wrong:\s*$/;
const BLOCK_END = /^\* (Try|Get more help|Exception is|Where):?/;
const COMPILE_ERROR = /^e:\s+\S|\.(java|kt|kts|groovy|scala):\d+:(\d+:)?\s*error:/;
const MAX_FAILURES = 5000;

/** "com.example.FooTest > bar() FAILED" -> suite and name; anything else -> null. */
export function gradleTestHeader(line: string): { suite: string; name: string } | null {
  if (line.length === 0 || line[0] === " " || line[0] === "\t" || line[0] === ">") return null;
  const trimmed = line.trimEnd();
  if (!trimmed.endsWith(" FAILED")) return null;
  const body = trimmed.slice(0, -" FAILED".length);
  const at = body.indexOf(" > ");
  if (at <= 0 || at + 3 >= body.length) return null;
  return { suite: body.slice(0, at), name: body.slice(at + 3) };
}

export function parseGradle(text: string, options: ParseOptions): ParseOutput {
  const lines = boundedLines(text);
  const raws: RawFailure[] = [];
  const wrong: string[] = [];
  let failedCount: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const summary = line.match(SUMMARY);
    if (summary) {
      failedCount = (failedCount ?? 0) + Number(summary[2]);
      continue;
    }
    if (WHAT_WENT_WRONG.test(line)) {
      for (let j = i + 1; j < lines.length && !BLOCK_END.test(lines[j]); j++) {
        const entry = lines[j].trim();
        if (entry && wrong.length < 20) wrong.push(entry.replace(/^>\s*/, ""));
        i = j;
      }
      continue;
    }
    const header = gradleTestHeader(line);
    if (!header) continue;
    // The block is every indented line after the header; the full exception
    // format has blank lines inside it, before each "Caused by:"
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === ""); j++) {
      body.push(lines[j]);
      i = j;
    }
    while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
    if (raws.length >= MAX_FAILURES) continue;
    const head = parseThrowable(body.find((l) => l.trim().length > 0) ?? "");
    raws.push({
      test: makeTest(header.suite, header.name),
      type: head.type,
      message: head.message,
      lines: body,
      parser: "gradle",
      step: options.step,
    });
  }

  const causes = groupFailures(raws, options.contextPatterns);
  if (raws.length === 0 && wrong.length > 0) {
    const compileErrors = lines.filter((l) => COMPILE_ERROR.test(l.trim())).slice(0, 10);
    const first = compileErrors[0] ? parseThrowable(compileErrors[0].trim()).message : wrong[0];
    causes.push(
      ...groupFailures(
        [
          {
            kind: "build",
            message: first,
            lines: compileErrors,
            parser: "gradle",
            step: options.step,
            evidence: [...wrong.slice(0, 4), ...compileErrors.slice(0, 4)].map((l) => clip(l)),
          },
        ],
        [],
      ),
    );
  }
  return { causes, passed: [], flaky: [], failedCount };
}

export const gradleParser: EvidenceParser = {
  id: "gradle",
  source: "console",
  detect: (_text, lines) =>
    lines.some(
      (l) =>
        /^\d+ tests? completed, \d+ failed/.test(l) ||
        /^FAILURE: Build (failed|completed)/.test(l) ||
        /^> Task :\S/.test(l) ||
        gradleTestHeader(l) !== null,
    ),
  parse: parseGradle,
};
