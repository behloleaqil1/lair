/**
 * Types of PR health (docs/design/pr-health.md sections 4.4 and 4.7).
 *
 * PR health reads each listed repository's open pull requests and finds:
 * - conflicts: the host says the PR can't merge into its base;
 * - behind: the PR is more than behind_threshold commits behind its base;
 * - no_ci: no check has run at the head of a non-draft PR for no_ci_minutes;
 * - ci_red: the newest run of at least one check at the head failed.
 * no_ci and ci_red need the repository's `ci_counts` and its
 * `pr_health.repos.<repo>.ci_signal` (both default true).
 */
import type { HostCheck } from "../review/host.js";
import type { Kind } from "./config.js";

export type { Kind } from "./config.js";

/** What PR health knows about one PR, kept between ticks so an unchanged PR costs no request. */
export interface PrFacts {
  headSha: string;
  baseTip: string;
  /** null: the host has not computed it yet (unknown) */
  mergeable: boolean | null;
  behindBy: number;
  /** The newest run of each check at checksHead, or null (not read: ci_counts is off) */
  checks: HostCheck[] | null;
  checksHead: string | null;
  /** Every check passed or was skipped, and there is at least one: not read again at this head */
  checksSettled: boolean;
}

/** Who hears about a PR's problems (owner.ts): agent null means nobody owns it, with the reason */
export interface OwnerView {
  agent: string | null;
  /** review: the author the review module registered; pr_author: the host account that opened the PR (owner.rule branch_first) */
  source: "task_line" | "branch" | "review" | "pr_author" | null;
  line: number | null;
  reason: string;
}

export interface FindingView {
  /** pr_health:<repo>#<n>@<head8>:<kind> */
  key: string;
  repo: string;
  pr: number;
  /** The full head sha */
  head: string;
  kind: Kind;
  /** When it was first found (epoch ms) */
  since: number;
  /** Since when successful reads have not found it (epoch ms); cleared after clear_minutes */
  clearingSince: number | null;
  owner: OwnerView | "unknown";
  /** Why the owner is unknown, or null */
  ownerReason: string | null;
  /** The open Decision Inbox notice (act mode), or null */
  noticeId: string | null;
}

export type ClearedWhy = "fixed" | "head_moved" | "closed" | "ignored";

export interface RepoView {
  repo: string;
  /** null until it is known (the host's default branch is read once) */
  base: string | null;
  ciCounts: boolean;
  /** Its CI counts for PR health (ci_counts and pr_health.repos.<repo>.ci_signal) */
  ciSignal: boolean;
  /** inactive: not read yet */
  state: "ok" | "error" | "inactive";
  /** The last read's error, one line, or null */
  error: string | null;
  /** The last tick stopped at the request budget or the deadline before every PR was read */
  partial: boolean;
  /** The list has 100 open PRs: more may exist and are not seen */
  truncated: boolean;
  lastReadAt: number | null;
  prsRead: number;
  skipped: { pr: number; why: "ignored_prs" | "ignored_branches" | "other_base" | "max_prs_per_repo" }[];
}

/** What act mode would do now (plan.ts): a note per owned (repo, PR, head), a no_owner notice per unowned one */
export type Planned =
  | { type: "note" | "withdraw"; id: string; agent: string | null; argv: string[] | null; reason: string | null }
  | { type: "notice"; key: string; code: "no_owner" | "delivery_failed" | "unfixed" };

export interface PrHealthTick {
  at: string;
  durationMs: number;
  requests: number;
  prsRead: number;
  findings: number;
}

export interface PrHealthStatus {
  project: string;
  enabled: boolean;
  running: boolean;
  mode: "observe" | "act" | null;
  /** Why act mode does nothing, or null when it acts */
  actBlocked: string | null;
  /** Why PR health watches nothing (no repository), or null */
  inactive: string | null;
  intervalSeconds: number | null;
  lastTick: PrHealthTick | null;
  lastError: string | null;
  /** No tick finished for three intervals: PR health is not watching */
  stale: boolean;
  repos: RepoView[];
  findings: FindingView[];
  planned: Planned[];
  /** The delivery ledger's records of this project (act mode; observe never reads the ledger) */
  deliveries: NoteRecord[];
  /** The ledger's cap gave way to records it still needs, or null */
  warning: string | null;
}

/** A withdrawal of a sent note (act mode), with why its problem cleared */
export interface WithdrawState {
  status: "running" | "done" | "skipped" | "failed" | "gave_up";
  why: ClearedWhy;
  attempts: number;
  lastAttemptAt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
}

/** One note in the delivery ledger (data/pr-health-deliveries.json, act mode): the new kinds of one (repo, PR, head) */
export interface NoteRecord {
  project: string;
  /** The delivery id, {id}: pr_health:<repo>#<n>@<head8>:<kinds joined "+"> */
  id: string;
  repo: string;
  pr: number;
  /** The full head sha */
  head: string;
  kinds: Kind[];
  agent: string;
  /** running: started and not finished (a restart counts it as a failed attempt); sent is final */
  status: "running" | "sent" | "failed" | "gave_up";
  attempts: number;
  lastAttemptAt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  argv: string[];
  sentAt: number | null;
  withdraw: WithdrawState | null;
}
