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
}

function assertSha(sha: string): void {
  if (!SHA_PATTERN.test(sha)) throw new Error(`not a commit sha: ${JSON.stringify(sha).slice(0, 80)}`);
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
}
