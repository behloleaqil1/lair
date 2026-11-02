/**
 * The owner rule (docs/design/pr-health.md section 4.4.1): which agent hears
 * about a PR's problems. It reads fill's last check (in memory, no file):
 *
 * 1. No agents module, or fill off: nobody (there are no task lines). Fill on
 *    but not checked yet: unknown, so nothing is planned for the PR.
 * 2. Open lines are fill's started, claimed and held lines with an agent.
 *    Done, malformed, not_allowlisted and unassigned lines never name one.
 * 3. The agent of the latest open line whose text names (repo, PR): a bare
 *    `#n` or `PR #n` means the line's `repo:` repository, else the default.
 * 4. Else, with owner.branch_window_minutes > 0: the one agent the head
 *    branch maps to through review.authors (branch_pattern, branches), if it
 *    has an open line and the head commit's committer date is in the window.
 *    The date is read (listCommits) only when this step is reached.
 *
 * With owner.rule branch_first (#292) every PR with an author has an owner:
 * 1. the one agent the head branch maps to through review.authors (no window
 *    and no open line needed: the branch says whose work it is);
 * 2. else the author the review module registered for the PR (its own
 *    repository only);
 * 3. else the latest open task line naming the PR, as above (fill on but not
 *    checked yet: unknown);
 * 4. else the host account that opened the PR.
 */
import type { FillLineView, FillStatusView } from "../../shared/agents-types.js";
import type { ProjectConfig } from "../../shared/types.js";
import { mapAuthor, type BranchGlob } from "../review/authors.js";
import { parsePrRefs, taskRepoOf, type RepoEntry } from "../repos/index.js";
import type { OwnerRule } from "./config.js";
import type { OwnerView } from "./types.js";

/** The review module as PR health reads it: the PR author it registered */
export interface ReviewAuthorSource {
  get(project: string): { settings: { repo: string }; registeredAuthor(pr: number): string | null } | undefined;
}

/** The agents module as PR health reads it: fill's last check of a project */
export interface FillSource {
  get(project: string): { fillStatus(): FillStatusView } | undefined;
}

export interface OwnerInputs {
  /** Fill's last check, or null: the project has no agents module */
  fill: FillStatusView | null;
  repos: RepoEntry[];
  authors: { branchPattern: RegExp | null; branches: BranchGlob[] };
  branchWindowMinutes: number;
  /** Default task_line */
  rule?: OwnerRule;
  /** The review module's repository and its registered author of a PR (branch_first) */
  reviewRepo?: string | null;
  registeredAuthor?: (pr: number) => string | null;
  config: Pick<ProjectConfig, "agents" | "repo">;
  now: number;
}

export type OwnerResult = { owner: OwnerView } | { unknown: string };

/** A host account name as GitHub allows it (a bot's ends in [bot]); anything else names nobody */
const HOST_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

const OPEN_STATES: ReadonlySet<FillLineView["state"]> = new Set(["started", "claimed", "held"]);

const nobody = (reason: string): OwnerResult => ({ owner: { agent: null, source: null, line: null, reason } });

/** The lines that can name an owner (fill's open lines), or the result when there are none to read. */
function openLines(fill: FillStatusView | null): FillLineView[] | OwnerResult {
  if (fill === null) return nobody("the project has no agents module, so no task line names an owner");
  if (!fill.enabled) return nobody("agents.fill is off, so no task line names an owner");
  if (fill.lastCheck === null) return { unknown: "fill has not checked the task lines yet" };
  return fill.lines.filter((l) => l.agent !== null && OPEN_STATES.has(l.state));
}

/**
 * The owner of (repo, pr) with head branch headRef. `pushedAt` reads the
 * head commit's committer date (epoch ms, or null when it is not known); a
 * failed read makes the owner unknown this tick.
 */
/** The latest open line naming (repo, pr), or null */
function namingLine(pr: { repo: string; number: number }, lines: FillLineView[], repos: RepoEntry[]): FillLineView | null {
  const repo = pr.repo.toLowerCase();
  let latest: FillLineView | null = null;
  for (const line of lines) {
    const text = `${line.name ?? ""} ${line.description ?? ""}`;
    const refs = parsePrRefs(text, repos, { mode: "mention", taskRepo: taskRepoOf(line.description ?? "") });
    if (refs.some((r) => r.repo.toLowerCase() === repo && r.number === pr.number) && (latest === null || line.line > latest.line)) latest = line;
  }
  return latest;
}

const byLine = (line: FillLineView): OwnerResult => ({
  owner: { agent: line.agent, source: "task_line", line: line.line, reason: `task line ${line.line} names the PR` },
});

/** owner.rule branch_first: branch mapping, the review module's author, a task line, the PR's author */
function branchFirst(pr: { repo: string; number: number; headRef: string; user?: string | null }, inputs: OwnerInputs): OwnerResult {
  const { branchPattern, branches } = inputs.authors;
  const mapped = branchPattern === null && branches.length === 0 ? null : mapAuthor({ branchPattern, branches, fromTasksFile: false }, pr.headRef, inputs.config).agent;
  if (mapped) return { owner: { agent: mapped, source: "branch", line: null, reason: `its branch maps to ${mapped} (review.authors)` } };
  const isReviewRepo = inputs.reviewRepo != null && inputs.reviewRepo.toLowerCase() === pr.repo.toLowerCase();
  const registered = isReviewRepo ? (inputs.registeredAuthor?.(pr.number) ?? null) : null;
  if (registered) return { owner: { agent: registered, source: "review", line: null, reason: `the review module registered ${registered} as its author` } };
  const lines = openLines(inputs.fill);
  if (!Array.isArray(lines) && "unknown" in lines) return lines;
  const latest = Array.isArray(lines) ? namingLine(pr, lines, inputs.repos) : null;
  if (latest) return byLine(latest);
  if (pr.user && HOST_LOGIN.test(pr.user)) return { owner: { agent: pr.user, source: "pr_author", line: null, reason: `no branch mapping, registered author or task line names an owner; ${pr.user} opened the PR` } };
  return nobody("no branch mapping, registered author or task line names an owner, and the host gives no usable PR author");
}

export async function ownerOf(
  pr: { repo: string; number: number; headRef: string; user?: string | null },
  inputs: OwnerInputs,
  pushedAt: () => Promise<number | null>,
): Promise<OwnerResult> {
  if (inputs.rule === "branch_first") return branchFirst(pr, inputs);
  const lines = openLines(inputs.fill);
  if (!Array.isArray(lines)) return lines;
  const latest = namingLine(pr, lines, inputs.repos);
  if (latest) return byLine(latest);
  const none = "no open task line names the PR";
  const window = inputs.branchWindowMinutes;
  if (window === 0) return nobody(`${none}, and the branch rule is off (owner.branch_window_minutes: 0)`);
  const { branchPattern, branches } = inputs.authors;
  if (branchPattern === null && branches.length === 0) return nobody(`${none}, and review.authors maps no branch to an agent`);
  const agent = mapAuthor({ branchPattern, branches, fromTasksFile: false }, pr.headRef, inputs.config).agent;
  if (agent === null) return nobody(`${none}, and its branch maps to no single agent through review.authors`);
  if (!lines.some((l) => l.agent === agent)) return nobody(`${none}; its branch maps to ${agent}, who has no open task line`);
  let at: number | null;
  try {
    at = await pushedAt();
  } catch (e) {
    return { unknown: `the head commit's date could not be read: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
  if (at === null) return nobody(`${none}; its branch maps to ${agent}, but the head commit's date is not known (not among the PR's first 300 commits, or none given)`);
  const age = Math.max(0, inputs.now - at);
  if (age > window * 60_000) return nobody(`${none}; its branch maps to ${agent}, but the head was committed over ${window} min ago`);
  return { owner: { agent, source: "branch", line: null, reason: `its branch maps to ${agent} (review.authors), head committed ${Math.floor(age / 60_000)} min ago` } };
}
