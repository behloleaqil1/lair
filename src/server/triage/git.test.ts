/**
 * GitCli against a real repository in a temp dir: the default branch's
 * first-parent merges since a commit, a merge's parents and message, and a
 * change's files. Runs the real `git` through the real ExecFileRunner.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecFileRunner } from "../watchdog/probes.js";
import { GitCli } from "./git.js";

let dir = "";
const shas: Record<string, string> = {};

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=Lair Test", "-c", "user.email=lair-test", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf-8" },
  ).trim();
}

function commit(file: string, message: string): string {
  writeFileSync(join(dir, file), `${message}\n`);
  git("add", file);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

function mergeBranch(branch: string, ...messages: string[]): string {
  git("checkout", "-q", "main");
  git("merge", "--no-ff", "-q", ...messages.flatMap((m) => ["-m", m]), branch);
  return git("rev-parse", "HEAD");
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lair-triage-git-"));
  git("init", "-q", "-b", "main");
  shas.c0 = commit("a.txt", "initial");
  git("checkout", "-q", "-b", "feat-one");
  shas.f1 = commit("b.txt", "feature one");
  shas.m1 = mergeBranch("feat-one", "Merge pull request #12 from example/feat-one", "Lair-Protected: yes");
  git("checkout", "-q", "-b", "feat-two");
  shas.f2 = commit("c.txt", "feature two");
  shas.m2 = mergeBranch("feat-two", "Merge pull request #13 from example/feat-two");
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("GitCli", () => {
  it("lists the first-parent merges after a commit, oldest first", async () => {
    const cli = new GitCli(dir, new ExecFileRunner());
    expect(await cli.firstParentRange(shas.c0, shas.m2)).toEqual([shas.m1, shas.m2]);
    expect(await cli.firstParentRange(shas.m1, shas.m2)).toEqual([shas.m2]);
  });

  it("reads a merge's parents, subject and body", async () => {
    const cli = new GitCli(dir, new ExecFileRunner());
    const info = await cli.commit(shas.m1);
    expect(info).toEqual({
      sha: shas.m1,
      parents: [shas.c0, shas.f1],
      subject: "Merge pull request #12 from example/feat-one",
      body: "Lair-Protected: yes",
    });
  });

  it("lists the files a change touched since it left its base", async () => {
    const cli = new GitCli(dir, new ExecFileRunner());
    expect(await cli.changedFiles(shas.m1, shas.f2)).toEqual(["c.txt"]);
  });

  it("refuses anything that isn't a sha, and reports git's errors", async () => {
    const cli = new GitCli(dir, new ExecFileRunner());
    await expect(cli.firstParentRange("--all", shas.m2)).rejects.toThrow("not a commit sha");
    await expect(cli.commit("0123456789abcdef0123456789abcdef01234567")).rejects.toThrow(/^git show failed/);
  });
});
