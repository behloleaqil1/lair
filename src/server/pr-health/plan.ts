/**
 * What act mode would do now (docs/design/pr-health.md section 4.4 step 6),
 * shown as `planned` in the status: for each (repo, PR, head) with open
 * findings, a note to its owner with the argv notify_cmd would run, or a
 * no_owner notice when nobody owns it. An unknown owner plans nothing.
 * Observe mode runs and raises none of it. Act mode (act.ts) builds its
 * notes and withdrawals with the same helpers.
 */
import { buildArgv } from "../infra-monitor/config.js";
import { KINDS, type Kind, type PrHealthSettings } from "./config.js";
import type { OwnerResult } from "./owner.js";
import type { ClearedWhy, NoteRecord, Planned } from "./types.js";

const MAX_MESSAGE = 500;

/** One (repo, PR, head) with open findings, and the facts its note needs */
export interface PlanGroup {
  repo: string;
  pr: number;
  head: string;
  kinds: Kind[];
  /** The kinds the last read found (open findings that are not clearing) */
  seen: Kind[];
  /** When the head's first open finding was found (epoch ms) */
  since: number;
  owner: OwnerResult;
  base: string | null;
  behindBy: number;
  failing: number;
  /** Minutes since the PR was last updated (no_ci) */
  quietMinutes: number;
}

/** The delivery id ({id}) of a note naming these kinds at this head */
export function deliveryId(repo: string, pr: number, head: string, kinds: readonly Kind[]): string {
  return `pr_health:${repo}#${pr}@${head.slice(0, 8)}:${KINDS.filter((k) => kinds.includes(k)).join("+")}`;
}

/** The note: Lair's words, config values and validated fields only (no branch name, check name or title). */
export function noteMessage(g: PlanGroup, id: string): string {
  const head8 = g.head.slice(0, 8);
  const base = g.base ?? "the base";
  const texts: Record<Kind, string> = {
    conflicts: `it conflicts with ${base}: merge ${base} into the branch with a normal merge, resolve, push`,
    behind: `it is ${g.behindBy} commits behind ${base}: merge ${base} and push`,
    no_ci: `no CI has run at ${head8} for ${g.quietMinutes} min`,
    ci_red: `CI is red at ${head8} (${g.failing} failing checks): fix them before reporting it done or waiting`,
  };
  return `PR ${g.repo}#${g.pr} at ${head8}: ${g.kinds.map((k) => texts[k]).join("; ")}. Fix this before other work on that PR. (${id})`.slice(0, MAX_MESSAGE);
}

/** notify_cmd filled for a note to `agent` naming `kinds` of the group's head */
export function noteArgv(template: readonly string[], agent: string, group: PlanGroup, kinds: readonly Kind[]): { id: string; argv: string[] } | { id: string; error: string } {
  const named = KINDS.filter((k) => kinds.includes(k));
  const id = deliveryId(group.repo, group.pr, group.head, named);
  const message = noteMessage({ ...group, kinds: named }, id);
  const vars = { agent, repo: group.repo, pr: String(group.pr), head: group.head.slice(0, 8), kinds: named.join(","), id, message };
  return { id, ...buildArgv("notify_cmd", template, vars) };
}

/** withdraw_cmd filled for a sent note whose problem cleared */
export function withdrawArgv(template: readonly string[], r: NoteRecord, why: ClearedWhy): { argv: string[] } | { error: string } {
  const head8 = r.head.slice(0, 8);
  const message = `PR ${r.repo}#${r.pr} at ${head8}: ${r.kinds.join(", ")} no longer seen (${why}); note ${r.id} is withdrawn.`.slice(0, MAX_MESSAGE);
  return buildArgv("withdraw_cmd", template, { agent: r.agent, repo: r.repo, pr: String(r.pr), head: head8, kinds: r.kinds.join(","), id: r.id, message });
}

export function plan(groups: PlanGroup[], settings: PrHealthSettings): Planned[] {
  const out: Planned[] = [];
  for (const group of groups) {
    if ("unknown" in group.owner) continue;
    const agent = group.owner.owner.agent;
    if (agent === null) {
      out.push({ type: "notice", key: `pr_health:${group.repo}#${group.pr}@${group.head.slice(0, 8)}`, code: "no_owner" });
      continue;
    }
    if (!settings.notifyCmd) {
      out.push({ type: "note", id: deliveryId(group.repo, group.pr, group.head, group.kinds), agent, argv: null, reason: "no notify_cmd is set" });
      continue;
    }
    const filled = noteArgv(settings.notifyCmd, agent, group, group.kinds);
    out.push("argv" in filled ? { type: "note", id: filled.id, agent, argv: filled.argv, reason: null } : { type: "note", id: filled.id, agent, argv: null, reason: filled.error });
  }
  return out;
}
