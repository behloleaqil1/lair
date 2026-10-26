/**
 * pytest console output: the "short test summary info" lines (FAILED and
 * ERROR node ids with their messages), the detail sections they point to
 * ("____ test_name ____" with its "E   ..." lines, "ERROR at setup of ...")
 * and the final "N failed, M passed in Ts" line. Setup errors shared by many
 * tests are one context cause.
 */
import { clip, cleanLog, groupFailures, parseThrowable, pytestTest, type RawFailure } from "../text.js";
import type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";

const SECTION = /^_{3,}\s+(.+?)\s+_{3,}\s*$/;
const BANNER = /^={3,}\s*(.*?)\s*={3,}\s*$/;
const SUMMARY_ENTRY = /^(FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.*))?$/;
const FINAL = /^={3,}\s+(.*\b(?:passed|failed|errors?)\b.*?)\s+in\s+[\d.]+s\b.*={3,}\s*$/;
const E_LINE = /^E\s+(.*)$/;
const LOCATION = /^(\S+\.py):(\d+):\s+(\S.*)$/;

interface Section {
  title: string;
  lines: string[];
  errors: string[];
  location?: { file: string; line: number; type: string };
}

function sectionFor(sections: Section[], nodeId: string): Section | undefined {
  const parts = nodeId.split("::");
  const name = parts[parts.length - 1];
  const qualified = parts.slice(1).join(".");
  const titles = new Set([
    name,
    qualified,
    ...[name, qualified].flatMap((n) => [`ERROR at setup of ${n}`, `ERROR at teardown of ${n}`]),
    `ERROR collecting ${parts[0]}`,
  ]);
  return sections.find((s) => titles.has(s.title));
}

export function parsePytest(text: string, options: ParseOptions): ParseOutput {
  const lines = cleanLog(text).split("\n");
  const sections: Section[] = [];
  const entries: { outcome: string; nodeId: string; message: string }[] = [];
  let current: Section | null = null;
  let inSummary = false;
  let failedCount: number | undefined;

  for (const line of lines) {
    const final = line.match(FINAL);
    if (final) {
      const failed = final[1].match(/(\d+) failed/);
      const errors = final[1].match(/(\d+) errors?/);
      failedCount = Number(failed?.[1] ?? 0) + Number(errors?.[1] ?? 0);
      current = null;
      inSummary = false;
      continue;
    }
    const banner = line.match(BANNER);
    if (banner) {
      inSummary = /short test summary info/i.test(banner[1]);
      current = null;
      continue;
    }
    if (inSummary) {
      const entry = line.match(SUMMARY_ENTRY);
      if (entry) entries.push({ outcome: entry[1], nodeId: entry[2], message: (entry[3] ?? "").trim() });
      continue;
    }
    const section = line.match(SECTION);
    if (section) {
      current = { title: section[1], lines: [], errors: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    const error = line.match(E_LINE);
    if (error) current.errors.push(error[1].trim());
    const location = line.match(LOCATION);
    if (location) current.location = { file: location[1], line: Number(location[2]), type: location[3] };
  }

  const raws: RawFailure[] = entries.map((entry) => {
    const section = sectionFor(sections, entry.nodeId);
    const errorText = entry.message || section?.errors[0] || entry.outcome;
    const thrown = parseThrowable(errorText);
    const lines = section ? [...section.lines] : [];
    return {
      test: pytestTest(entry.nodeId),
      type: thrown.type ?? section?.location?.type,
      message: thrown.message,
      lines,
      parser: "pytest",
      step: options.step,
      contextText: section?.title ?? (entry.outcome === "ERROR" ? "error at setup of" : undefined),
      evidence: (section?.errors ?? []).slice(0, 4).map((e) => clip(e)),
    };
  });

  return { causes: groupFailures(raws, options.contextPatterns), passed: [], flaky: [], failedCount };
}

export const pytestParser: EvidenceParser = {
  id: "pytest",
  source: "console",
  detect: (text) =>
    /^={3,} (short test summary info|FAILURES|ERRORS|test session starts) ={3,}\s*$/m.test(text) ||
    /^={3,} .*\b(passed|failed)\b.* in [\d.]+s\b.*={3,}\s*$/m.test(text),
  parse: parsePytest,
};
