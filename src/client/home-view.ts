/**
 * Home's "Needs you" list and its FYI list, kept apart from the component
 * so tests check the same rules.
 *
 * - Needs you: what only the owner can settle, newest first. Every open
 *   `action` decision of this project (each hold the owner must lift has
 *   one, so holds are not listed apart), the project's config errors, and
 *   one row for the action items of other projects. A decision row is its
 *   plain sentence (the decision's title), its answer buttons inline (the
 *   same rules as the Decisions view: inlineAnswer) and a link to its full
 *   context.
 * - FYI (collapsed): what is worth knowing but asks nothing: notices, agents
 *   whose state needs a look, providers the agents module waits out after
 *   transient errors, failed gates and PRs ready to merge.
 */
import { CONFIRM_KINDS, type Decision, type DecisionOption } from "../shared/decision-types";
import type { ProviderUnreachableView } from "../shared/agents-types";
import type { ConfigProblem } from "../shared/lifecycle-types";
import type { FailedGate } from "./gate-detail-view";
import type { PrRow } from "./pr-view";
import type { WorkRow } from "./work-view";
import { linkTo } from "./router";

export type NeedKind = "decision" | "config" | "elsewhere" | "notice" | "agent" | "gate" | "pr";
export type NeedTone = "error" | "warning" | "neutral";

/** What Home shows when nothing waits on the owner. */
export const NOTHING_NEEDS_YOU = "Nothing needs you.";

export const SIGN_IN_TO_ANSWER = "Sign in as the owner from Decisions to answer here";

export interface InlineOption {
  option: DecisionOption;
  recommended: boolean;
  /** The answer goes through a confirmation step first (the CONFIRM_KINDS) */
  confirm: boolean;
}

/**
 * How a decision is answered from Home:
 * - buttons: one per option; disabled (with the reason) until this browser is signed in as the owner;
 * - link: only from the Decisions view (a credentials decision needs its secret typed there).
 */
export type InlineAnswer =
  | { mode: "buttons"; options: InlineOption[]; disabledReason: string | null }
  | { mode: "link"; label: string; reason: string };

export interface NeedItem {
  kind: NeedKind;
  /** Unique within its list */
  key: string;
  /** The plain sentence: what waits and why */
  title: string;
  detail: string;
  /** The full context */
  href: string;
  linkLabel: string;
  tone: NeedTone;
  at: string | null;
  /** A decision row: the decision, and (action items) how Home answers it */
  decision?: Decision;
  answer?: InlineAnswer;
}

export interface NeedsInput {
  project: string;
  /** Every project's decisions (the Decision Inbox is shared) */
  decisions: readonly Decision[];
  failures: readonly FailedGate[];
  prs: readonly PrRow[];
  configProblems: readonly ConfigProblem[];
  work: readonly WorkRow[];
  /** This browser is signed in as the owner (null: not known yet) */
  signedIn: boolean | null;
  /** Providers the agents module waits out after transient errors (GET /api/agents/status `unreachable`) */
  unreachable?: readonly ProviderUnreachableView[];
}

export interface NeedsView {
  /** What needs the owner, newest first (the other projects' row last) */
  items: NeedItem[];
  /** For their information; shown collapsed */
  fyi: NeedItem[];
}

/** How Home answers a decision: the Decisions view's rules (confirmation first; a secret only there). */
export function inlineAnswer(decision: Decision, signedIn: boolean | null): InlineAnswer {
  if (decision.kind === "credentials") {
    return { mode: "link", label: "Answer in Decisions", reason: "It needs the secret, typed in the Decisions view" };
  }
  const confirm = CONFIRM_KINDS.includes(decision.kind);
  return {
    mode: "buttons",
    options: decision.options.map((option) => ({
      option,
      recommended: option.id === decision.recommended.optionId,
      confirm,
    })),
    disabledReason: signedIn === true ? null : SIGN_IN_TO_ANSWER,
  };
}

/** Newest first; rows without a time last, in the order they came. */
function newestFirst(a: NeedItem, b: NeedItem): number {
  if (a.at === b.at) return 0;
  if (a.at === null) return 1;
  if (b.at === null) return -1;
  return Date.parse(b.at) - Date.parse(a.at);
}

/** An open decision that needs the owner's answer (a decision without attention, from an older server, does). */
export const isActionItem = (d: Decision) => d.status === "open" && d.attention !== "notice";
export const isNotice = (d: Decision) => d.status === "open" && d.attention === "notice";

export function needsYou(input: NeedsInput): NeedsView {
  const mine = (d: Decision) => d.project === input.project;
  const items: NeedItem[] = [];

  for (const d of input.decisions.filter((d) => isActionItem(d) && mine(d))) {
    items.push({
      kind: "decision",
      key: `decision:${d.id}`,
      title: d.title,
      detail: `${d.overdue ? "Overdue · " : ""}from ${d.source.module}`,
      href: linkTo("decisions", d.id),
      linkLabel: "Details",
      tone: d.overdue ? "error" : "warning",
      at: d.createdAt,
      decision: d,
      answer: inlineAnswer(d, input.signedIn),
    });
  }
  for (const p of input.configProblems.filter((p) => p.project === input.project)) {
    items.push({
      kind: "config",
      key: `config:${p.file}`,
      title: `${p.file} has an error: Lair can't use it until you fix it`,
      detail: p.previousRunning ? `The previous config is still running: ${p.error}` : p.error,
      href: linkTo("settings"),
      linkLabel: "Open Settings",
      tone: "error",
      at: p.at,
    });
  }
  items.sort(newestFirst);

  const elsewhere = input.decisions.filter((d) => isActionItem(d) && !mine(d)).length;
  if (elsewhere > 0) {
    items.push({
      kind: "elsewhere",
      key: "decision:elsewhere",
      title: `${elsewhere} ${elsewhere === 1 ? "thing needs" : "things need"} you in other projects`,
      detail: "The Decisions view lists every project's",
      href: linkTo("decisions"),
      linkLabel: "Open Decisions",
      tone: "neutral",
      at: null,
    });
  }

  const fyi: NeedItem[] = [];
  for (const d of input.decisions.filter((d) => isNotice(d) && mine(d))) {
    fyi.push({
      kind: "notice",
      key: `notice:${d.id}`,
      title: d.title,
      detail: `from ${d.source.module}`,
      href: linkTo("decisions", d.id),
      linkLabel: "Details",
      tone: "neutral",
      at: d.createdAt,
      decision: d,
    });
  }
  for (const row of input.work.filter((r) => r.attention)) {
    fyi.push({
      kind: "agent",
      key: `agent:${row.id}`,
      title: `${row.id} is ${row.state}`,
      detail: row.detail ?? "",
      href: linkTo("work", row.id),
      linkLabel: "Open",
      tone: "error",
      at: null,
    });
  }
  // A provider Lair waits out after transient errors: nothing to answer yet (its decision comes if it lasts)
  for (const u of input.unreachable ?? []) {
    fyi.push({
      kind: "agent",
      key: `agent:provider:${u.provider}`,
      title: `Provider ${u.provider} is unreachable`,
      detail: `${u.fleet ? "Every agent waits" : `${u.agents.join(", ")} wait${u.agents.length === 1 ? "s" : ""}`}: ${u.waiting} run(s), ${u.failures} transient failure(s); Lair tries one start at a time`,
      href: linkTo("work"),
      linkLabel: "Open",
      tone: "neutral",
      at: u.since,
    });
  }
  for (const f of input.failures) {
    fyi.push({
      kind: "gate",
      key: `gate:${f.id}`,
      title: `Gate failed: ${f.track}`,
      detail: f.failedSteps.length > 0 ? `Failed: ${f.failedSteps.join(", ")}` : "See its steps",
      href: linkTo("gates", f.id, "results"),
      linkLabel: "Open",
      tone: "error",
      at: f.finishedAt ?? null,
    });
  }
  for (const pr of input.prs.filter((p) => p.readiness.group === "ready")) {
    fyi.push({
      kind: "pr",
      key: `pr:${pr.number}`,
      title: `#${pr.number} ${pr.readiness.label === "Merge ready" ? "is ready to merge" : "passed its gate"}`,
      detail: pr.title,
      href: linkTo("prs", String(pr.number)),
      linkLabel: "Open",
      tone: "neutral",
      at: pr.updatedAt,
    });
  }
  return { items, fyi: fyi.sort(newestFirst) };
}
