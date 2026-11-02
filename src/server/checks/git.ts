/**
 * Git checks for a check request: the sha must be on the branch as pushed to
 * the project's remote ("a sha not on a pushed branch of the task's
 * repository is refused").
 *
 * The sha must be an ancestor of (or equal to) refs/remotes/<remote>/<branch>.
 * When it is not (the remote-tracking ref is stale or missing, or the sha is
 * not in this repository yet), the branch is fetched once from the remote into
 * that ref and the check is repeated. Every git call has a timeout, and a
 * timeout, an unknown object or any other git error is a refusal, never a pass.
 */

/** One git command's outcome (argv without the leading "git"). */
export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs git in the project's repository; the one boundary the tests fake. */
export interface GitRunner {
  run(args: string[], timeoutMs: number): Promise<GitResult>;
}

export type ShaCheck = { ok: true } | { ok: false; reason: string };

/** Local git calls (rev-parse, merge-base) */
export const GIT_LOCAL_TIMEOUT_MS = 15_000;
/** The fetch from the remote */
export const GIT_FETCH_TIMEOUT_MS = 60_000;

type Look =
  | { state: "yes" }
  | { state: "no" }
  | { state: "missing" }
  | { state: "unknown"; reason: string }
  | { state: "error"; reason: string };

function failure(what: string, result: GitResult): string {
  if (result.timedOut) return `${what} timed out`;
  const detail = result.stderr.trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? "";
  return `${what} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`;
}

async function look(git: GitRunner, sha: string, ref: string): Promise<Look> {
  const tip = await git.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], GIT_LOCAL_TIMEOUT_MS);
  if (tip.timedOut) return { state: "error", reason: failure("git rev-parse", tip) };
  if (tip.exitCode !== 0) return { state: "missing" };
  const result = await git.run(["merge-base", "--is-ancestor", sha, ref], GIT_LOCAL_TIMEOUT_MS);
  if (result.timedOut) return { state: "error", reason: failure("git merge-base", result) };
  if (result.exitCode === 0) return { state: "yes" };
  if (result.exitCode === 1) return { state: "no" };
  // 128: the sha is not in this repository (yet), or another git error
  return { state: "unknown", reason: failure("git merge-base", result) };
}

/**
 * Whether `sha` is on `branch` as pushed to `remote`. The caller has already
 * validated the three values (40-hex sha, validateBranchName, remote name).
 */
export async function shaOnPushedBranch(git: GitRunner, sha: string, branch: string, remote: string): Promise<ShaCheck> {
  const ref = `refs/remotes/${remote}/${branch}`;

  const first = await look(git, sha, ref);
  if (first.state === "yes") return { ok: true };
  if (first.state === "error") return { ok: false, reason: first.reason };

  // Stale or missing remote-tracking ref, or an unknown sha: fetch the branch once and look again
  const fetched = await git.run(
    ["fetch", "--no-tags", "--quiet", remote, `+refs/heads/${branch}:${ref}`],
    GIT_FETCH_TIMEOUT_MS,
  );
  if (fetched.exitCode !== 0 || fetched.timedOut) {
    return { ok: false, reason: `branch "${branch}" could not be fetched from ${remote}: ${failure("git fetch", fetched)}` };
  }

  const second = await look(git, sha, ref);
  switch (second.state) {
    case "yes":
      return { ok: true };
    case "no":
      return { ok: false, reason: `sha is not on branch "${branch}" as pushed to ${remote}` };
    case "missing":
      return { ok: false, reason: `branch "${branch}" is not on ${remote}` };
    default:
      return { ok: false, reason: `sha is not on branch "${branch}" as pushed to ${remote}: ${second.reason}` };
  }
}
