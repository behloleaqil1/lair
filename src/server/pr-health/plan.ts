/**
 * What act mode would do now (docs/design/pr-health.md section 4.4 step 6),
 * shown as `planned` in the status: for each (repo, PR, head) with open
 * findings, a note to its owner with the argv notify_cmd would run, or a
 * no_owner notice when nobody owns it. An unknown owner plans nothing.
 * Observe mode runs and raises none of it.
 */
import { KINDS, type Kind, type PrHealthSettings } from "./config.js";
import type { OwnerResult } from "./owner.js";
import type { Planned } from "./types.js";

const PLACEHOLDER = /\{([A-Za-z_]+)\}/g;
const MAX_MESSAGE = 500;

/** One (repo, PR, head) with open findings, and the facts its note needs */
export interface PlanGroup {
  repo: string;
  pr: number;
  head: string;
  kinds: Kind[];
  owner: OwnerResult;
  base: string | null;
  behindBy: number;
  failing: number;
  /** Minutes since the PR was last updated (no_ci) */
  quietMinutes: number;
}

/** Each placeholder filled once; a value that would start with "-" where its template argument does not is refused. */
export function fillArgv(template: readonly string[], vars: Readonly<Record<string, string>>): { argv: string[] } | { error: string } {
  const argv: string[] = [];
  for (const arg of template) {
    const filled = arg.replace(PLACEHOLDER, (whole, n: string) => (Object.hasOwn(vars, n) ? vars[n] : whole));
    if (filled.startsWith("-") && !arg.startsWith("-")) return { error: `the value in "${arg}" starts with "-" and would be read as an option` };
    argv.push(filled);
  }
  return { argv };
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

export function plan(groups: PlanGroup[], settings: PrHealthSettings): Planned[] {
  const out: Planned[] = [];
  for (const group of groups) {
    if ("unknown" in group.owner) continue;
    const head8 = group.head.slice(0, 8);
    const agent = group.owner.owner.agent;
    if (agent === null) {
      out.push({ type: "notice", key: `pr_health:${group.repo}#${group.pr}@${head8}`, code: "no_owner" });
      continue;
    }
    const kinds = KINDS.filter((k) => group.kinds.includes(k));
    const id = `pr_health:${group.repo}#${group.pr}@${head8}:${kinds.join("+")}`;
    if (!settings.notifyCmd) {
      out.push({ type: "note", id, agent, argv: null, reason: "no notify_cmd is set" });
      continue;
    }
    const message = noteMessage({ ...group, kinds }, id);
    const filled = fillArgv(settings.notifyCmd, { agent, repo: group.repo, pr: String(group.pr), head: head8, kinds: kinds.join(","), id, message });
    out.push("argv" in filled ? { type: "note", id, agent, argv: filled.argv, reason: null } : { type: "note", id, agent, argv: null, reason: `notify_cmd: ${filled.error}` });
  }
  return out;
}
