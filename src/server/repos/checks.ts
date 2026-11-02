/**
 * PR facts read straight from a repository's host: the newest run of each
 * check, and the ready guard's facts for a repository the review module does
 * not handle (it is single-repository, so there is no gate and no findings).
 */
import type { ReadyFacts } from "../ready-guard/guard.js";
import type { GitHost, HostCheck } from "../review/host.js";

/** The newest run of each check (by kind and name): a re-run replaces the run before it. */
export function newestChecks(checks: HostCheck[]): HostCheck[] {
  const newest = new Map<string, HostCheck>();
  for (const c of checks) {
    const key = `${c.kind}:${c.name}`;
    const seen = newest.get(key);
    if (!seen || Date.parse(c.at ?? "") > Date.parse(seen.at ?? "")) newest.set(key, c);
  }
  return [...newest.values()];
}

/** What the ready guard checks a report on another repository's PR against: `gate: null` and no findings. */
export async function readyFactsFromHost(host: GitHost, n: number): Promise<ReadyFacts> {
  const pr = await host.getPullRequest(n);
  const baseTip = await host.branchHead(pr.baseRef);
  const behindBy = (await host.compare(baseTip, pr.headSha)).behindBy;
  const checks = newestChecks(await host.listChecks(pr.headSha));
  return {
    state: pr.state,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    mergeable: pr.mergeable,
    behindBy,
    body: pr.body ?? "",
    checks: checks.map((c) => ({ name: c.name, state: c.state })),
    commitShas: (await host.listCommits(n)).map((c) => c.sha),
    gate: null,
    findingIds: [],
  };
}
