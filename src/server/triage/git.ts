/**
 * Git, read-only: the merges between the last green commit and a red one,
 * a commit's parents and message, and the files a change touched. Runs `git`
 * from an argv array (never a shell) through the watchdog's CommandRunner,
 * and passes only validated commit shas.
 */
import type { CommandRunner } from "../watchdog/probes.js";
import { SHA_PATTERN } from "./config.js";

export interface CommitInfo {
  sha: string;
  parents: string[];
  subject: string;
  body: string;
}

export interface GitProbe {
  /** First-parent commits after `from` up to and including `to`, oldest first */
  firstParentRange(from: string, to: string): Promise<string[]>;
  commit(sha: string): Promise<CommitInfo>;
  /** Files changed on `head` since it left `base` (base...head) */
  changedFiles(base: string, head: string): Promise<string[]>;
  /** Where `sha` left `branch` (git merge-base), or null when they share no history */
  mergeBase(sha: string, branch: string): Promise<string | null>;
  /** Whether `ancestor` is in `descendant`'s history (git merge-base --is-ancestor) */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** The commits `branch` points at: the local branch and each remote's branch of that exact name */
  branchTips(branch: string): Promise<string[]>;
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function assertSha(sha: string): void {
  if (!SHA_PATTERN.test(sha)) throw new Error(`not a commit sha: ${JSON.stringify(sha).slice(0, 80)}`);
}

function assertBranch(branch: string): void {
  if (!BRANCH.test(branch) || branch.includes("..")) {
    throw new Error(`not a branch name: ${JSON.stringify(branch).slice(0, 80)}`);
  }
}

export class GitCli implements GitProbe {
  constructor(
    private repo: string,
    private runner: CommandRunner,
    private timeoutMs = 30_000,
  ) {}

  private async git(args: string[]): Promise<string> {
    const out = await this.runner.run(["git", "-C", this.repo, ...args], { timeoutMs: this.timeoutMs });
    if (out.code !== 0) {
      throw new Error(`git ${args[0]} failed (${out.code}): ${out.stderr.trim().slice(0, 300)}`);
    }
    return out.stdout;
  }

  async firstParentRange(from: string, to: string): Promise<string[]> {
    assertSha(from);
    assertSha(to);
    const out = await this.git(["rev-list", "--first-parent", "--reverse", `${from}..${to}`]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => SHA_PATTERN.test(l));
  }

  async commit(sha: string): Promise<CommitInfo> {
    assertSha(sha);
    const out = await this.git(["show", "-s", "--format=%H%x00%P%x00%s%x00%b", sha]);
    const [full, parents, subject, ...body] = out.split("\0");
    return {
      sha: (full ?? sha).trim(),
      parents: (parents ?? "").trim().split(/\s+/).filter(Boolean),
      subject: (subject ?? "").trim(),
      body: body.join("\0").trim(),
    };
  }

  async changedFiles(base: string, head: string): Promise<string[]> {
    assertSha(base);
    assertSha(head);
    const out = await this.git(["diff", "--name-only", `${base}...${head}`]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  async mergeBase(sha: string, branch: string): Promise<string | null> {
    assertSha(sha);
    assertBranch(branch);
    const out = await this.runner.run(["git", "-C", this.repo, "merge-base", sha, branch], { timeoutMs: this.timeoutMs });
    if (out.code === 1 && out.stdout.trim() === "") return null;
    if (out.code !== 0) throw new Error(`git merge-base failed (${out.code}): ${out.stderr.trim().slice(0, 300)}`);
    const base = out.stdout.trim();
    return SHA_PATTERN.test(base) ? base.toLowerCase() : null;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    assertSha(ancestor);
    assertSha(descendant);
    const out = await this.runner.run(["git", "-C", this.repo, "merge-base", "--is-ancestor", ancestor, descendant], {
      timeoutMs: this.timeoutMs,
    });
    if (out.code === 0) return true;
    if (out.code === 1) return false;
    throw new Error(`git merge-base --is-ancestor failed (${out.code}): ${out.stderr.trim().slice(0, 300)}`);
  }

  async branchTips(branch: string): Promise<string[]> {
    assertBranch(branch);
    const out = await this.git(["for-each-ref", "--format=%(objectname) %(refname)", `refs/heads/${branch}`, "refs/remotes/"]);
    const tips = new Set<string>();
    for (const line of out.split("\n")) {
      const [sha, ref] = line.trim().split(" ");
      if (!sha || !ref || !SHA_PATTERN.test(sha)) continue;
      // Exactly refs/heads/<branch> or refs/remotes/<remote>/<branch>: never a branch that only ends in its name
      const remote = ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : null;
      const slash = remote ? remote.indexOf("/") : -1;
      if (ref === `refs/heads/${branch}` || (remote && slash > 0 && remote.slice(slash + 1) === branch)) tips.add(sha.toLowerCase());
    }
    return [...tips];
  }
}
