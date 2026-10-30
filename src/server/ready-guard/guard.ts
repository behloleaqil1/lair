/**
 * Ready guard (agents.fill.ready_guard): a DONE report that names a pull
 * request is accepted only when, at the head it names, the PR can really be
 * reviewed:
 *
 * - ci_failed / ci_pending: every CI check at the head passes (none failing,
 *   none still running, and at least one exists);
 * - behind_base / conflicting: the branch is up to date with its base branch
 *   and merges cleanly;
 * - gate_unverified: the project's gate (when it uses one) passed at that
 *   exact head;
 * - findings_unmapped: when the PR carries review findings, its body maps
 *   each finding id to a commit of the PR;
 * - head_moved / not_open: the report is about the PR's current head, and
 *   the PR is open.
 *
 * Anything the host can't say fails closed: the report is refused as
 * unverifiable and checked again later. A refusal names every failing item
 * and says what to do; fill hands it to the agent as its next instruction,
 * never marks the task done, and sends nothing to review.
 */

export type ReadyRefusal =
  | "unverifiable"
  | "not_open"
  | "head_moved"
  | "conflicting"
  | "behind_base"
  | "ci_failed"
  | "ci_pending"
  | "gate_unverified"
  | "findings_unmapped";

export interface ReadyCheck {
  name: string;
  state: "pending" | "success" | "failure" | "skipped";
}

export interface ReadyGate {
  name: string;
  status: "passed" | "failed" | "pending" | "missing";
}

/** What the git host and the review module say about one pull request right now. */
export interface ReadyFacts {
  state: "open" | "closed" | "merged";
  headSha: string;
  baseRef: string;
  /** false: conflicting; null: the host hasn't computed it yet */
  mergeable: boolean | null;
  /** Commits the base branch has that the head lacks; null: unknown */
  behindBy: number | null;
  body: string;
  /** Every check run and commit status at exactly headSha */
  checks: ReadyCheck[];
  /** The PR's commits (full shas) */
  commitShas: string[];
  /** The project's required gate at exactly headSha; null: the project uses no gate */
  gate: ReadyGate[] | null;
  /** Ids of the review findings the PR carries (empty: none) */
  findingIds: string[];
}

export interface ReadyFactsSource {
  facts(pr: number): Promise<ReadyFacts>;
}

export interface ReadyReport {
  pr: number;
  /** The head the agent reported, when the line names one */
  sha: string | null;
}

export type ReadyVerdict =
  | { ok: true }
  | {
      ok: false;
      /** The first failing item (one that needs a change before one that only needs time) */
      reason: ReadyRefusal;
      /** Only time can fix it (CI running, host not answering): checked again, the agent is not restarted */
      retry: boolean;
      /** Every failing item, one line each */
      problems: string[];
      /** What the agent is told to do next (Lair's own words; names of checks only) */
      instruction: string;
    };

const SHA = /^[0-9a-f]{7,40}$/i;
const MAX_LISTED = 5;

/**
 * The PR a DONE queue line reports: `PR #<n>` or `pull request #<n>`, and the
 * head after `at` (`at <sha>`) when it names one. null: the line names no PR
 * (a task without one; the guard doesn't apply).
 */
export function parseReadyReport(line: string): ReadyReport | null {
  const pr = /\b(?:PR|pull request)\s*#(\d{1,9})\b/i.exec(line);
  if (!pr) return null;
  const sha = /\bat\s+([0-9a-f]{7,40})\b/i.exec(line.slice(pr.index));
  return { pr: Number(pr[1]), sha: sha ? sha[1].toLowerCase() : null };
}

function names(items: string[]): string {
  // eslint-disable-next-line no-control-regex
  const shown = items.slice(0, MAX_LISTED).map((i) => i.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80)).join(", ");
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
}

/** A finding is mapped when a line of the body has its id and a sha prefix of one of the PR's commits. */
export function unmappedFindings(body: string, findingIds: string[], commitShas: string[]): string[] {
  const lines = body.split("\n");
  const commits = commitShas.map((s) => s.toLowerCase());
  return findingIds.filter((id) => {
    return !lines.some((line) => {
      if (!line.includes(id)) return false;
      const tokens = line.toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) ?? [];
      return tokens.some((t) => SHA.test(t) && commits.some((c) => c.startsWith(t)));
    });
  });
}

interface Problem {
  reason: ReadyRefusal;
  retry: boolean;
  text: string;
  todo: string;
}

function evaluate(report: ReadyReport, f: ReadyFacts): Problem[] {
  const out: Problem[] = [];
  if (f.state !== "open") {
    out.push({ reason: "not_open", retry: false, text: `PR #${report.pr} is ${f.state}`, todo: "Report on an open PR." });
    return out;
  }
  const head = f.headSha.toLowerCase();
  if (report.sha !== null && !head.startsWith(report.sha)) {
    out.push({
      reason: "head_moved",
      retry: false,
      text: `the report names ${report.sha} but the PR head is ${head.slice(0, 12)}`,
      todo: "Report the PR's current head, after the checks below pass at it.",
    });
  }
  if (f.mergeable === false) {
    out.push({
      reason: "conflicting",
      retry: false,
      text: `the branch conflicts with ${f.baseRef}`,
      todo: `Merge ${f.baseRef} into the branch, resolve the conflicts, and push.`,
    });
  }
  if (f.behindBy !== null && f.behindBy > 0) {
    out.push({
      reason: "behind_base",
      retry: false,
      text: `the branch is ${f.behindBy} commit(s) behind ${f.baseRef}`,
      todo: `Merge ${f.baseRef} into the branch (a normal merge) and push; then wait for CI again.`,
    });
  }
  if (f.mergeable === null || f.behindBy === null) {
    out.push({
      reason: "unverifiable",
      retry: true,
      text: `the host has not said whether the branch is behind or conflicting with ${f.baseRef}`,
      todo: "Nothing to change; it is checked again.",
    });
  }
  const failed = f.checks.filter((c) => c.state === "failure").map((c) => c.name);
  const running = f.checks.filter((c) => c.state === "pending").map((c) => c.name);
  if (failed.length > 0) {
    out.push({
      reason: "ci_failed",
      retry: false,
      text: `CI is not green at the head: ${names(failed)}`,
      todo: "Read the failing checks' logs, fix the cause, push, and wait for every check to pass.",
    });
  }
  if (running.length > 0 || f.checks.length === 0) {
    out.push({
      reason: "ci_pending",
      retry: true,
      text: running.length > 0 ? `CI is still running at the head: ${names(running)}` : "no CI check has run at the head yet",
      todo: "Nothing to change; it is checked again when CI finishes.",
    });
  }
  if (f.gate !== null) {
    const bad = f.gate.filter((g) => g.status !== "passed");
    const unfinished = bad.filter((g) => g.status === "pending");
    const wrong = bad.filter((g) => g.status !== "pending").map((g) => `${g.name} (${g.status})`);
    if (f.gate.length === 0) {
      out.push({
        reason: "gate_unverified",
        retry: false,
        text: "the project's gate has no result at the head",
        todo: "Run the project's gate at this exact head and wait for it to pass.",
      });
    } else if (wrong.length > 0) {
      out.push({
        reason: "gate_unverified",
        retry: false,
        text: `the project's gate did not pass at the head: ${names(wrong)}`,
        todo: "Run the project's gate at this exact head and wait for it to pass.",
      });
    }
    if (unfinished.length > 0) {
      out.push({
        reason: "gate_unverified",
        retry: true,
        text: `the project's gate is still running at the head: ${names(unfinished.map((g) => g.name))}`,
        todo: "Nothing to change; it is checked again when the gate finishes.",
      });
    }
  }
  const unmapped = unmappedFindings(f.body, f.findingIds, f.commitShas);
  if (unmapped.length > 0) {
    out.push({
      reason: "findings_unmapped",
      retry: false,
      text: `the PR body does not map these review findings to a commit: ${names(unmapped)}`,
      todo: "Add one line per finding to the PR body: the finding id and the sha of the commit that fixes it.",
    });
  }
  return out;
}

/** Check one report against the host's facts. Never throws: a host that can't answer is a retry. */
export async function evaluateReady(report: ReadyReport, source: ReadyFactsSource): Promise<ReadyVerdict> {
  let problems: Problem[];
  try {
    problems = evaluate(report, await source.facts(report.pr));
  } catch {
    problems = [
      {
        reason: "unverifiable",
        retry: true,
        text: `PR #${report.pr} could not be read from the git host`,
        todo: "Nothing to change; it is checked again.",
      },
    ];
  }
  if (problems.length === 0) return { ok: true };
  const first = problems.find((p) => !p.retry) ?? problems[0];
  const retry = problems.every((p) => p.retry);
  const todo = [...new Set(problems.filter((p) => !p.retry || retry).map((p) => p.todo))];
  const instruction = [
    `Your report for PR #${report.pr} was refused. Nothing was sent to review and the task stays open.`,
    ...problems.map((p) => `- ${p.text}`),
    "",
    ...todo,
    "Report again only when each item above is fixed.",
  ].join("\n");
  return { ok: false, reason: first.reason, retry, problems: problems.map((p) => p.text), instruction };
}
