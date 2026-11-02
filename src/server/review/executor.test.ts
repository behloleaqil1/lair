/**
 * Merge executor. The local method runs the real git CLI against a bare
 * repository in a temp directory (standing in for the host), so these tests
 * exercise the production git calls end to end. The host method goes through
 * the GitHub provider against a stand-in API.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseReviewConfig, type MergeSettings } from "./config.js";
import {
  LocalMerger,
  checkCommitEmails,
  emailAllowed,
  maskEmail,
  mergeOnHost,
  planMerge,
  type LocalMergeInput,
} from "./executor.js";
import { GitHubHost } from "./github.js";
import { systemGit } from "./git.js";
import { FakeRemote, HOST_ACCOUNT, fakeGitHubApi, type Person } from "./testing/fakes.js";

const IDENTITY: Person = { name: "Release Bot", email: "12345+release@users.noreply.github.com" };
const AGENT: Person = { name: "Fleet Agent", email: "agents@example.com" };
const PRIVATE: Person = { name: "Someone", email: "someone@private.example" };
const ALLOWED = ["*@users.noreply.github.com", "agents@example.com"];

const git = systemGit(60_000);
let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function identityEnv(person: Person): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: person.name,
    GIT_AUTHOR_EMAIL: person.email,
    GIT_COMMITTER_NAME: person.name,
    GIT_COMMITTER_EMAIL: person.email,
  };
}

/** Set-up commands run with an explicit identity, so no machine's git config is needed. */
async function sh(cwd: string, args: string[], env: Record<string, string> = identityEnv(AGENT)): Promise<string> {
  const result = await git.run(args, { cwd, env });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A bare "host" repository with main (one commit) and a feature branch on top of it. */
async function repository(featureAuthor: Person) {
  dir = mkdtempSync(join(tmpdir(), "lair-review-git-"));
  const remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  await sh(dir, ["init", "--bare", "--initial-branch=main", remote]);
  await sh(dir, ["init", "--initial-branch=main", seed]);
  const commit = async (file: string, text: string, message: string, who: Person) => {
    writeFileSync(join(seed, file), text);
    await sh(seed, ["add", file]);
    await sh(seed, ["-c", "commit.gpgsign=false", "commit", "-m", message], identityEnv(who));
    return sh(seed, ["rev-parse", "HEAD"]);
  };
  const base = await commit("README.md", "# demo\n", "initial", AGENT);
  await sh(seed, ["remote", "add", "origin", remote]);
  await sh(seed, ["push", "origin", "main"]);
  await sh(seed, ["checkout", "-b", "feature"]);
  const head = await commit("feature.txt", "feature\n", "feat: add a feature", featureAuthor);
  await sh(seed, ["push", "origin", "feature"]);
  const tipOf = (branch: string) => sh(dir!, ["--git-dir", remote, "rev-parse", branch]);
  const advanceMain = async () => {
    await sh(seed, ["checkout", "main"]);
    const moved = await commit("other.txt", "other\n", "chore: other work", AGENT);
    await sh(seed, ["push", "origin", "main"]);
    return moved;
  };
  return { remote, base, head, tipOf, advanceMain, workDir: join(dir, "work") };
}

function input(remote: string, head: string, overrides: Partial<LocalMergeInput> = {}): LocalMergeInput {
  return {
    cloneUrl: remote,
    baseRef: "main",
    headSha: head,
    fetchRef: "refs/heads/feature",
    strategy: "ff-only",
    identity: IDENTITY,
    allowedEmails: ALLOWED,
    title: "Add a feature (#7)",
    body: "Merged by Lair.",
    ...overrides,
  };
}

describe("local merge with real git", () => {
  it("fast-forwards the target branch to the reviewed head and pushes", async () => {
    const repo = await repository(AGENT);
    const result = await new LocalMerger({ git, workDir: repo.workDir }).merge(input(repo.remote, repo.head));
    expect(result).toMatchObject({ merged: true, resultSha: repo.head, commitsChecked: 1, reasons: [] });
    expect(await repo.tipOf("main")).toBe(repo.head);
  });

  it("squashes with the configured identity, never the commit authors'", async () => {
    const repo = await repository(AGENT);
    const result = await new LocalMerger({ git, workDir: repo.workDir }).merge(
      input(repo.remote, repo.head, { strategy: "squash" }),
    );
    expect(result.merged).toBe(true);
    const tip = await repo.tipOf("main");
    expect(tip).toBe(result.resultSha);
    const meta = await sh(dir!, ["--git-dir", repo.remote, "log", "-1", "--format=%an|%ae|%cn|%ce|%s|%P", "main"]);
    expect(meta).toBe(`${IDENTITY.name}|${IDENTITY.email}|${IDENTITY.name}|${IDENTITY.email}|Add a feature (#7)|${repo.base}`);
  });

  it("refuses before the push when a commit carries an email outside the allow-list", async () => {
    const repo = await repository(PRIVATE);
    const result = await new LocalMerger({ git, workDir: repo.workDir }).merge(input(repo.remote, repo.head));
    expect(result.merged).toBe(false);
    expect(result.emailViolations.map((v) => v.role)).toEqual(["author", "committer"]);
    expect(result.reasons[0]).toBe(
      `commit ${repo.head.slice(0, 7)}: author email s***@private.example, which is not in review.merge.allowed_emails`,
    );
    expect(await repo.tipOf("main")).toBe(repo.base);
  });

  it("refuses a fast-forward when the target moved, and a head that is not the reviewed one", async () => {
    const repo = await repository(AGENT);
    const moved = await repo.advanceMain();
    const merger = new LocalMerger({ git, workDir: repo.workDir });
    const behind = await merger.merge(input(repo.remote, repo.head));
    expect(behind.merged).toBe(false);
    expect(behind.reasons[0]).toContain("a fast-forward is impossible");
    expect(await repo.tipOf("main")).toBe(moved);

    const other = await merger.merge(input(repo.remote, repo.base));
    expect(other.reasons[0]).toContain("the PR head moved");
    expect(await repo.tipOf("main")).toBe(moved);
  });
});

describe("email allow-list", () => {
  it("matches globs case-insensitively and masks what it reports", () => {
    expect(emailAllowed("12345+Name@Users.Noreply.GitHub.com", ALLOWED)).toBe(true);
    expect(emailAllowed("agents@example.com", ALLOWED)).toBe(true);
    expect(emailAllowed("agents@example.com.invalid", ALLOWED)).toBe(false);
    expect(emailAllowed("", ALLOWED)).toBe(false);
    expect(maskEmail("someone@private.example")).toBe("s***@private.example");
  });

  it("checks trailers in commit messages too", () => {
    const violations = checkCommitEmails(
      [
        {
          sha: "a".repeat(40),
          author: AGENT,
          committer: AGENT,
          message: `feat: x\n\nCo-authored-by: Someone <${PRIVATE.email}>\nCo-authored-by: Bot <1+bot@users.noreply.github.com>`,
        },
      ],
      ALLOWED,
    );
    expect(violations).toEqual([{ sha: "a".repeat(40), role: "message", email: PRIVATE.email }]);
  });
});

describe("choosing the method", () => {
  const settings = (merge: Record<string, unknown>): MergeSettings => {
    const parsed = parseReviewConfig(
      { enabled: true, merge: { gate: { source: "checks", required: ["ci"] }, ...merge } },
      { github: "example-org/demo" },
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return parsed.settings.merge;
  };

  it("merges locally unless the host account's email is declared private, whatever the repository's visibility", () => {
    expect(planMerge(settings({}))).toMatchObject({ method: "local", strategy: "ff-only", refusal: null });
    expect(planMerge(settings({ host_email_private: true }))).toMatchObject({
      method: "host",
      strategy: "squash",
      refusal: null,
    });
    // Asking for host merges without declaring the email private is refused, not silently allowed
    const host = planMerge(settings({ method: "host" }));
    expect(host.method).toBe("host");
    expect(host.refusal).toContain("host_email_private: true");
    expect(planMerge(settings({ method: "local", host_email_private: true })).method).toBe("local");
  });

  it("needs an identity for a local squash, and defaults the allow-list to it plus noreply addresses", () => {
    const parsed = parseReviewConfig(
      { enabled: true, merge: { gate: { source: "checks", required: ["ci"] }, local_strategy: "squash" } },
      { github: "example-org/demo" },
    );
    expect(parsed.ok).toBe(false);
    expect(settings({ identity: IDENTITY }).allowedEmails).toEqual([IDENTITY.email, "*@users.noreply.github.com"]);
    expect(settings({}).cloneUrl).toBe("https://github.com/example-org/demo.git");
  });
});

describe("host merge through the GitHub provider", () => {
  function hostRepo(author: Person) {
    const remote = new FakeRemote();
    const base = remote.commit([], AGENT, "initial");
    remote.branches.set("main", base);
    const head = remote.commit([base], author, "feat: x");
    remote.openPull({ number: 5, headRef: "feature", headSha: head, files: [] });
    const host = new GitHubHost({
      repo: remote.repo,
      apiUrl: "https://api.github.com",
      token: async () => "test-token",
      fetch: fakeGitHubApi(remote),
    });
    return { remote, base, head, host };
  }

  it("checks every published commit before calling the host's merge", async () => {
    const { remote, base, head, host } = hostRepo(PRIVATE);
    const result = await mergeOnHost(host, {
      pr: 5,
      headSha: head,
      strategy: "merge",
      title: "x",
      body: "",
      allowedEmails: ALLOWED,
      prUser: "example-bot",
    });
    expect(result.merged).toBe(false);
    expect(result.reasons).toHaveLength(2);
    expect(remote.requests.some((r) => r.method === "PUT")).toBe(false);
    expect(remote.branches.get("main")).toBe(base);
  });

  it("squashes on the host at the exact head, and refuses an email in its own message", async () => {
    const { remote, base, head, host } = hostRepo(PRIVATE);
    const leaky = await mergeOnHost(host, {
      pr: 5,
      headSha: head,
      strategy: "squash",
      title: "x",
      body: `Reviewed by ${PRIVATE.email}`,
      allowedEmails: ALLOWED,
      prUser: "example-bot",
    });
    expect(leaky.merged).toBe(false);
    expect(leaky.emailViolations).toEqual([expect.objectContaining({ role: "message" })]);

    const stale = await mergeOnHost(host, {
      pr: 5,
      headSha: base,
      strategy: "squash",
      title: "x",
      body: "",
      allowedEmails: ALLOWED,
      prUser: "example-bot",
    });
    expect(stale.merged).toBe(false);
    expect(stale.reasons[0]).toContain("409");

    const merged = await mergeOnHost(host, {
      pr: 5,
      headSha: head,
      strategy: "squash",
      title: "x",
      body: "",
      allowedEmails: ALLOWED,
      prUser: "example-bot",
    });
    expect(merged.merged).toBe(true);
    const tip = remote.branches.get("main")!;
    expect(merged.resultSha).toBe(tip);
    expect(remote.commits.get(tip)).toMatchObject({ parents: [base], author: HOST_ACCOUNT });
    const put = remote.requests.filter((r) => r.method === "PUT");
    expect(put.map((r) => r.body)).toEqual([
      expect.objectContaining({ sha: base }),
      expect.objectContaining({ sha: head, merge_method: "squash" }),
    ]);
  });

  it("refuses a host squash or merge commit authored as an account whose public email isn't allowed", async () => {
    const { remote, base, head, host } = hostRepo(AGENT);
    remote.publicEmails.set("example-bot", PRIVATE.email);
    const squash = await mergeOnHost(host, {
      pr: 5,
      headSha: head,
      strategy: "squash",
      title: "x",
      body: "",
      allowedEmails: ALLOWED,
      prUser: "example-bot",
    });
    expect(squash.merged).toBe(false);
    expect(squash.reasons).toEqual([
      "the host would author the squash commit as example-bot, whose public email s***@private.example is not in review.merge.allowed_emails",
    ]);

    // A merge commit is authored as the token's account
    remote.publicEmails.delete("example-bot");
    remote.viewer = "merge-account";
    remote.publicEmails.set("merge-account", PRIVATE.email);
    const merge = await mergeOnHost(host, {
      pr: 5,
      headSha: head,
      strategy: "merge",
      title: "x",
      body: "",
      allowedEmails: ALLOWED,
      prUser: "example-bot",
    });
    expect(merge.reasons[0]).toContain("merge commit as merge-account");

    const unknown = await mergeOnHost(host, {
      pr: 5,
      headSha: head,
      strategy: "squash",
      title: "x",
      body: "",
      allowedEmails: ALLOWED,
      prUser: null,
    });
    expect(unknown.reasons[0]).toContain("host account is unknown");
    expect(remote.requests.some((r) => r.method === "PUT")).toBe(false);
    expect(remote.branches.get("main")).toBe(base);
  });
});
