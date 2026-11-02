/**
 * The detector's rules (docs/design/pr-health.md section 4.4, steps 2.3 and
 * 3): which open PRs are read and in what order, and which kinds a read PR
 * has. Pure: the service reads the host and keeps the state.
 */
import { globMatches } from "../review/authors.js";
import type { HostPullRequest } from "../review/host.js";
import type { RepoEntry } from "../repos/index.js";
import type { Kind, PrHealthSettings } from "./config.js";
import type { PrFacts, RepoView } from "./types.js";

type SkipWhy = RepoView["skipped"][number]["why"];

/** pr_health:<repo>#<n>@<head8>:<kind>, at most 179 characters (a 39-character owner, a 100-character name, a 9-digit PR) */
export function findingKey(repo: string, pr: number, head: string, kind: Kind): string {
  return `pr_health:${repo}#${pr}@${head.slice(0, 8)}:${kind}`;
}

/** Why PR health does not read this PR, or null. A PR into another branch than the base is a stacked PR. */
export function skipReason(pr: HostPullRequest, repo: string, base: string, settings: PrHealthSettings): SkipWhy | null {
  if (settings.ignoredPrs.some((i) => i.repo === repo && i.pr === pr.number)) return "ignored_prs";
  if (settings.ignoredBranches.some((glob) => globMatches(glob, pr.headRef))) return "ignored_branches";
  if (pr.baseRef !== base) return "other_base";
  return null;
}

/** PRs left unread last tick first, then the most recently updated. */
export function readOrder(prs: HostPullRequest[], unread: ReadonlySet<number>): HostPullRequest[] {
  const at = (p: HostPullRequest) => Date.parse(p.updatedAt ?? "") || 0;
  return [...prs].sort((a, b) => Number(unread.has(b.number)) - Number(unread.has(a.number)) || at(b) - at(a));
}

/**
 * The kinds found at the PR's head, and those whose state is unknown: a
 * `mergeable` the host has not computed yet is neither a conflict nor the
 * end of one. Drafts get every kind but no_ci. Pending checks are neither
 * red nor missing; skipped and neutral runs count as checks.
 */
export function kindsOf(
  pr: HostPullRequest,
  facts: PrFacts,
  entry: RepoEntry,
  settings: PrHealthSettings,
  now: number,
): { found: Set<Kind>; unknown: Set<Kind> } {
  const on = settings.kinds;
  const found = new Set<Kind>();
  const unknown = new Set<Kind>();
  if (on.conflicts && facts.mergeable === false) found.add("conflicts");
  if (on.conflicts && facts.mergeable === null) unknown.add("conflicts");
  if (on.behind && facts.behindBy > settings.behindThreshold) found.add("behind");
  if (entry.ciCounts && facts.checks) {
    const updated = Date.parse(pr.updatedAt ?? "");
    const quietFor = Number.isFinite(updated) ? now - updated : 0;
    if (on.no_ci && !pr.draft && facts.checks.length === 0 && quietFor >= settings.noCiMinutes * 60_000) found.add("no_ci");
    if (on.ci_red && facts.checks.some((c) => c.state === "failure")) found.add("ci_red");
  }
  return { found, unknown };
}
