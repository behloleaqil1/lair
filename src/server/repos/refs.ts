/**
 * Pull request references in task text and DONE lines, aware of the
 * project's repositories (docs/design/pr-health.md section 4.3):
 *
 * - `owner/name#12` (a listed repository only);
 * - `<ref>#12`, `<ref> PR #12`, `<ref> pull request #12`: the entry with that ref;
 * - `PR #12`, `pull request #12`: the task's repository, else the default;
 * - `#12` (mention mode only): the task's repository, else the default.
 *
 * A bare number never means a repository that is neither the task's nor the
 * default. A reference starts at a word boundary and its number is not
 * followed by a letter, digit or `_`. `[<sha>]` or ` at <sha>` after it is
 * the head it names. The regexes have no nested quantifiers, and the text is
 * cut to MAX_REF_TEXT characters first.
 */
import type { RepoEntry } from "./config.js";

export interface PrRef {
  /** owner/name, as listed */
  repo: string;
  number: number;
  sha: string | null;
}

export interface PrRefOptions {
  /** report: a PR word or a `<ref>#` form is needed (the ready guard); mention: a bare `#12` counts too */
  mode: "report" | "mention";
  /** The task's own repository (`repo:owner/name` in its description); ignored unless listed */
  taskRepo?: string | null;
  /** false: no `owner/name#12` form (a project without `repos:`, as before) */
  qualified?: boolean;
}

/** Fill's longest task line (MAX_TASK_LINE_CHARS): longer text is cut first */
export const MAX_REF_TEXT = 2000;

const TASK_REPO = /\brepo:([\w.-]+\/[\w.-]+)/i;
const PR_WORD = String.raw`(?:PR|pull request)\s*#`;
const NUMBER_AND_SHA = String.raw`(?<n>\d{1,9})(?![0-9A-Za-z_])(?:\s*\[(?<s1>[0-9a-f]{7,40})\]|\s+at\s+(?<s2>[0-9a-f]{7,40})\b)?`;
const BEFORE = String.raw`(?<![\w./-])`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The repository a task names with `repo:owner/name` (the tracker's tag), if any. */
export function taskRepoOf(text: string): string | null {
  return TASK_REPO.exec(text.slice(0, MAX_REF_TEXT))?.[1] ?? null;
}

/** The repository a bare `PR #n` of the task means: the task's own (when listed), else the default; null: none. */
export function bareRepo(repos: RepoEntry[], taskRepo: string | null | undefined): string | null {
  const own = taskRepo ? repos.find((r) => same(r.repo, taskRepo)) : undefined;
  return own?.repo ?? repos.find((r) => r.default)?.repo ?? null;
}

const compiled = new WeakMap<RepoEntry[], Map<string, RegExp>>();

function patternFor(repos: RepoEntry[], mode: PrRefOptions["mode"], qualified: boolean): RegExp {
  const key = `${mode}:${qualified}`;
  let byKey = compiled.get(repos);
  if (!byKey) compiled.set(repos, (byKey = new Map()));
  const cached = byKey.get(key);
  if (cached) return cached;
  const names = qualified ? repos.map((r) => escape(r.repo)) : [];
  // Longest first, so `app-web` is not read as `app`
  const refs = repos.flatMap((r) => r.refs.map(escape)).sort((a, b) => b.length - a.length);
  const forms = [
    ...(names.length > 0 ? [`${BEFORE}(?<repo>${names.join("|")})#`] : []),
    ...(refs.length > 0 ? [`${BEFORE}(?<ref>${refs.join("|")})(?:#|\\s+${PR_WORD})`] : []),
    `\\b${PR_WORD}`,
    ...(mode === "mention" ? [`${BEFORE}#`] : []),
  ];
  const pattern = new RegExp(`(?:${forms.join("|")})${NUMBER_AND_SHA}`, "gi");
  byKey.set(key, pattern);
  return pattern;
}

/** Every PR reference in `text`, in order, resolved to a listed repository (unresolved ones are left out). */
export function parsePrRefs(text: string, repos: RepoEntry[], options: PrRefOptions): PrRef[] {
  if (repos.length === 0) return [];
  const bare = bareRepo(repos, options.taskRepo);
  const out: PrRef[] = [];
  for (const m of text.slice(0, MAX_REF_TEXT).matchAll(patternFor(repos, options.mode, options.qualified !== false))) {
    const g = m.groups ?? {};
    const repo = g.repo
      ? repos.find((r) => same(r.repo, g.repo))?.repo
      : g.ref
        ? repos.find((r) => r.refs.some((ref) => same(ref, g.ref)))?.repo
        : bare;
    if (repo === undefined || repo === null) continue;
    out.push({ repo, number: Number(g.n), sha: (g.s1 ?? g.s2)?.toLowerCase() ?? null });
  }
  return out;
}
