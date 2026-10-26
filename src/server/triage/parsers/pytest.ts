/**
 * pytest console output: the "short test summary info" lines (FAILED and
 * ERROR node ids with their messages), the detail sections they point to
 * ("____ test_name ____" with its "E   ..." lines, "ERROR at setup of ...")
 * and the final "N failed, M passed in Ts" line. Setup errors shared by many
 * tests are one context cause. Reads bounded lines only; banners and section
 * titles are found with string scans.
 */
import { boundedLines, clip, groupFailures, parseThrowable, pytestTest, type RawFailure } from "../text.js";
import type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";

const SUMMARY_ENTRY = /^(FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.*))?$/;
const E_LINE = /^E\s+(.*)$/;
const LOCATION = /^(\S+\.py):(\d+):\s+(\S.*)$/;
const MAX_ENTRIES = 5000;
const MAX_SECTION_LINES = 400;

/** The text between runs of `fill` (at least three on each side), or null. */
function between(line: string, fill: string): string | null {
  const t = line.trim();
  let start = 0;
  let end = t.length;
  while (start < end && t[start] === fill) start++;
  while (end > start && t[end - 1] === fill) end--;
  if (start < 3 || t.length - end < 3) return null;
  return t.slice(start, end).trim();
}

/** "=== 1 failed, 2 passed in 0.12s ===" -> the counts' text, else null. */
function finalLine(banner: string): string | null {
  return /\b(passed|failed|errors?)\b/.test(banner) && /\bin [\d.]+s\b/.test(banner) ? banner : null;
}

interface Section {
  title: string;
  lines: string[];
  errors: string[];
  location?: { file: string; line: number; type: string };
}

function sectionFor(sections: Map<string, Section>, nodeId: string): Section | undefined {
  const parts = nodeId.split("::");
  const name = parts[parts.length - 1];
  const qualified = parts.slice(1).join(".");
  const titles = [
    name,
    qualified,
    ...[name, qualified].flatMap((n) => [`ERROR at setup of ${n}`, `ERROR at teardown of ${n}`]),
    `ERROR collecting ${parts[0]}`,
  ];
  for (const title of titles) {
    const section = sections.get(title);
    if (section) return section;
  }
  return undefined;
}

export function parsePytest(text: string, options: ParseOptions): ParseOutput {
  const lines = boundedLines(text);
  const sections = new Map<string, Section>();
  const entries: { outcome: string; nodeId: string; message: string }[] = [];
  let current: Section | null = null;
  let inSummary = false;
  let failedCount: number | undefined;

  for (const line of lines) {
    const banner = between(line, "=");
    if (banner !== null) {
      const final = finalLine(banner);
      if (final) {
        const failed = final.match(/(\d+) failed/);
        const errors = final.match(/(\d+) errors?/);
        failedCount = Number(failed?.[1] ?? 0) + Number(errors?.[1] ?? 0);
      }
      inSummary = !final && /short test summary info/i.test(banner);
      current = null;
      continue;
    }
    if (inSummary) {
      const entry = line.match(SUMMARY_ENTRY);
      if (entry && entries.length < MAX_ENTRIES) {
        entries.push({ outcome: entry[1], nodeId: entry[2], message: (entry[3] ?? "").trim() });
      }
      continue;
    }
    const title = between(line, "_");
    if (title) {
      current = { title, lines: [], errors: [] };
      if (!sections.has(title)) sections.set(title, current);
      continue;
    }
    if (!current || current.lines.length >= MAX_SECTION_LINES) continue;
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
    return {
      test: pytestTest(entry.nodeId),
      type: thrown.type ?? section?.location?.type,
      message: thrown.message,
      lines: section ? [...section.lines] : [],
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
  detect: (_text, lines) =>
    lines.some((l) => {
      const banner = between(l, "=");
      if (banner === null) return false;
      return /^(short test summary info|FAILURES|ERRORS|test session starts)$/.test(banner) || finalLine(banner) !== null;
    }),
  parse: parsePytest,
};
