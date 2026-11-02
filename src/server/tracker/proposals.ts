/**
 * Link proposals: the open issues a reconcile finds for a task none is
 * linked to, by what GitHub already shows (docs/design/tracker.md, "Link
 * proposals"). Pure matching over one page of open issues per repository,
 * read once per reconcile; the service decides what becomes a link.
 *
 * - mentions_task: the issue's title or body names the task id as a word.
 *   A task id that is a plain word (no digit and none of . _ / # : -) or
 *   shorter than 4 characters is too common to be matched this way.
 * - similar_title: the issue's title is close (character bigrams, Dice
 *   coefficient, SIMILAR_TITLE_MIN) to the task's description, or to the
 *   task id and description together.
 *
 * Texts are bounded before they are matched, and each issue's words and
 * bigrams are computed once.
 */
import type { TrackerLinkReason } from "../../shared/tracker-types.js";
import type { Issue } from "./github-projects.js";

/** The similarity a title must reach to be proposed */
export const SIMILAR_TITLE_MIN = 0.85;
/** Shorter normalized titles are never compared (too little to go on) */
const SIMILAR_MIN_LENGTH = 10;
const TITLE_CHARS = 200;
const BODY_CHARS = 20_000;

export interface IssueMatch {
  repo: string;
  issue: Issue;
  reason: TrackerLinkReason;
  score: number | null;
}

/** A task id distinctive enough to be matched where it is named */
export function distinctiveTaskId(task: string): boolean {
  return task.length >= 4 && /[0-9._/#:-]/.test(task);
}

/** The task-id-shaped words of a text (split where a task id cannot go on; a trailing . : or # is punctuation) */
export function mentionTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.slice(0, BODY_CHARS).split(/[^A-Za-z0-9._/#:-]+/)) {
    const word = raw.replace(/^[#:.]+|[.:#]+$/g, "");
    if (word) out.add(word);
  }
  return out;
}

export function normalizeTitle(text: string): string {
  return text
    .slice(0, TITLE_CHARS)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    out.set(gram, (out.get(gram) ?? 0) + 1);
  }
  return out;
}

function dice(a: { norm: string; grams: Map<string, number> }, b: { norm: string; grams: Map<string, number> }): number {
  if (a.norm.length < SIMILAR_MIN_LENGTH || b.norm.length < SIMILAR_MIN_LENGTH) return 0;
  if (a.norm === b.norm) return 1;
  let both = 0;
  for (const [gram, n] of a.grams) both += Math.min(n, b.grams.get(gram) ?? 0);
  return (2 * both) / (a.norm.length - 1 + (b.norm.length - 1));
}

/** The similarity (0 to 1) of two titles, as the proposals compute it */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  return dice({ norm: x, grams: bigrams(x) }, { norm: y, grams: bigrams(y) });
}

interface Entry {
  repo: string;
  issue: Issue;
  tokens: Set<string>;
  norm: string;
  grams: Map<string, number>;
}

/** The open issues a reconcile read, indexed once */
export class IssueIndex {
  private readonly entries: Entry[] = [];
  private readonly byKey = new Map<string, Entry>();

  static key(repo: string, number: number): string {
    return `${repo.toLowerCase()}#${number}`;
  }

  add(repo: string, issue: Issue): void {
    const key = IssueIndex.key(repo, issue.number);
    if (this.byKey.has(key)) return;
    const norm = normalizeTitle(issue.title);
    const tokens = mentionTokens(issue.title);
    for (const word of mentionTokens(issue.body)) tokens.add(word);
    const entry = { repo, issue, tokens, norm, grams: bigrams(norm) };
    this.entries.push(entry);
    this.byKey.set(key, entry);
  }

  get(repo: string, number: number): Issue | null {
    return this.byKey.get(IssueIndex.key(repo, number))?.issue ?? null;
  }

  /** The issues that name the task, or whose title is close to its description (alone, or after the task id) */
  match(task: string, description: string): IssueMatch[] {
    const out: IssueMatch[] = [];
    const mentions = distinctiveTaskId(task);
    const wanted = [description, description ? `${task} ${description}` : ""]
      .map(normalizeTitle)
      .filter((norm) => norm.length >= SIMILAR_MIN_LENGTH)
      .map((norm) => ({ norm, grams: bigrams(norm) }));
    for (const entry of this.entries) {
      if (mentions && entry.tokens.has(task)) out.push({ repo: entry.repo, issue: entry.issue, reason: "mentions_task", score: null });
      let best = 0;
      for (const w of wanted) best = Math.max(best, dice(w, entry));
      if (best >= SIMILAR_TITLE_MIN) out.push({ repo: entry.repo, issue: entry.issue, reason: "similar_title", score: Math.round(best * 100) / 100 });
    }
    return out;
  }
}
