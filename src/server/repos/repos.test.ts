import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../shared/types.js";
import { ReviewManager } from "../review/service.js";
import { FakeRemote, fakeGitHubApi } from "../review/testing/fakes.js";
import { parsePrRefs, parseReposConfig, readyFactsFromHost, RepoHosts, RepoSources, taskRepoOf, type RepoEntry } from "./index.js";

const APP: RepoEntry = { repo: "example/app", default: true, base: null, ciCounts: true, refs: ["app"] };
const LIB: RepoEntry = { repo: "example/lib", default: false, base: null, ciCounts: true, refs: ["lib"] };
const REPOS = [APP, LIB];
const refs = (text: string, mode: "report" | "mention" = "report", taskRepo: string | null = taskRepoOf(text)) =>
  parsePrRefs(text, REPOS, { mode, taskRepo }).map((r) => `${r.repo}#${r.number}${r.sha ? `@${r.sha}` : ""}`);
const errorsOf = (repos: unknown) => {
  const result = parseReposConfig({ github: "example/app", repos });
  return result.ok ? [] : result.errors;
};

describe("repos: config", () => {
  it("AT-1 repos_config_defaults_and_fallbacks: tracker.repos, then the review repository, else empty and inactive", () => {
    const tracker = parseReposConfig({ github: "", tracker: { repos: [{ repo: "example/app", default: true }, { repo: "example/lib" }] } });
    expect(tracker).toEqual({
      ok: true,
      from: "tracker",
      inactive: null,
      repos: [
        { repo: "example/app", default: true, base: null, ciCounts: true, refs: ["app"] },
        { repo: "example/lib", default: false, base: null, ciCounts: true, refs: ["lib"] },
      ],
    });
    // The tracker allows two entries with no default: that is no default here too, not an error
    const noDefault = parseReposConfig({ github: "", tracker: { repos: [{ repo: "example/app" }, { repo: "example/lib" }] } });
    expect(noDefault.ok && noDefault.repos.map((r) => r.default)).toEqual([false, false]);

    expect(parseReposConfig({ github: "", review: { repo: "example/app", default_branch: "trunk" } })).toEqual({
      ok: true,
      from: "review",
      inactive: null,
      repos: [{ repo: "example/app", default: true, base: "trunk", ciCounts: true, refs: ["app"] }],
    });
    expect(parseReposConfig({ github: "example/app" })).toMatchObject({ ok: true, repos: [{ repo: "example/app", refs: ["app"], ciCounts: true }] });

    const none = parseReposConfig({ github: "" });
    expect(none).toMatchObject({ ok: true, repos: [], from: "none" });
    expect(none.ok && none.inactive).toMatch(/no repository is set/);

    // repos: itself: one entry is the default; ci_counts, base and refs as written
    expect(parseReposConfig({ github: "", repos: [{ repo: "example/lib", ci_counts: false, base: "develop" }] })).toEqual({
      ok: true,
      from: "repos",
      inactive: null,
      repos: [{ repo: "example/lib", default: true, base: "develop", ciCounts: false, refs: ["lib"] }],
    });
  });

  it("AT-2 repos_config_rejects_bad_entries: each error names its key", () => {
    const two = (a: object, b: object) => [{ repo: "example/app", default: true, ...a }, { repo: "example/lib", ...b }];
    expect(errorsOf([{ repo: "app" }])[0]).toMatch(/^repos\[0\]\.repo: use owner\/name/);
    expect(errorsOf(two({}, { repo: "Example/App" }))[0]).toMatch(/^repos\[1\]\.repo: Example\/App is listed twice/);
    expect(errorsOf([{ repo: "example/app", refs: ["pr"] }])[0]).toMatch(/^repos\[0\]\.refs\[0\]: pr and pull/);
    expect(errorsOf(two({ refs: ["web"] }, { refs: ["WEB"] }))[0]).toMatch(/^repos\[1\]\.refs\[0\]: WEB is also a ref of repos\[0\]/);
    // An explicit ref equal to another entry's default name is the same collision, not a silent takeover
    expect(errorsOf(two({ refs: ["Lib"] }, {}))[0]).toMatch(/^repos\[0\]\.refs: lib is the name of repos\[1\] \(example\/lib\)/);
    expect(errorsOf(two({ refs: ["core"] }, {}))).toEqual([]);
    expect(errorsOf(two({}, { default: true }))[0]).toMatch(/^repos: exactly one entry must be default: true \(2 are\)/);
    expect(errorsOf(two({ default: false }, {}))[0]).toMatch(/^repos: exactly one entry must be default: true \(0 are\)/);
    const many = Array.from({ length: 21 }, (_, i) => ({ repo: `example/r${i}`, default: i === 0 }));
    expect(errorsOf(many)[0]).toMatch(/^repos: at most 20 repositories/);
    expect(errorsOf([{ repo: "example/app", base: "-x" }])[0]).toMatch(/^repos\[0\]\.base:/);
  });

  it("AT-2: an invalid repos: turns off repository-aware parsing in the ready guard (the review repository alone, as before)", () => {
    const remote = new FakeRemote("example/app");
    const fetch = fakeGitHubApi(remote);
    const config = {
      name: "demo",
      repo: "/tmp/demo",
      github: "example/app",
      queue_file: "q",
      agents_dir: "a",
      gates_dir: "g",
      machines: {},
      review: { enabled: true, reviewers: { green: [] }, merge: { gate: { source: "checks", required: ["build"] }, method: "host" } },
    } as unknown as ProjectConfig;
    const reviews = new ReviewManager({ dbPath: ":memory:", fetch, env: {}, autoRequestMs: 0, agentCheckMs: 0 });
    cleanups.push(() => reviews.close());
    reviews.load([{ name: "demo", config }]);
    expect(reviews.get("demo"), reviews.info("demo").errors.join("; ")).toBeDefined();
    const warnings: string[] = [];
    const sources = new RepoSources({ review: (p) => reviews.get(p), fetch, env: {}, warn: (t) => warnings.push(t) });

    const good = sources.readyFacts("demo", { ...config, repos: [{ repo: "example/app", default: true }, { repo: "example/lib" }] });
    expect(good).toMatchObject({ legacy: false, repos: [{ repo: "example/app" }, { repo: "example/lib" }] });

    const bad = sources.readyFacts("demo", { ...config, repos: [{ repo: "example/app", default: true }, { repo: "lib" }] });
    expect(bad).toMatchObject({ legacy: true, repos: [{ repo: "example/app", default: true, refs: [] }] });
    expect(warnings.join("\n")).toContain("repos[1].repo");
    // Without repos: the guard is as before: the review repository alone, PR #n forms only
    expect(sources.readyFacts("demo", config)).toMatchObject({ legacy: true, repos: [{ repo: "example/app", refs: [] }] });
    expect(remote.requests).toEqual([]);
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("PR references", () => {
  it("AT-3 prRefs_forms", () => {
    expect(refs("fix app#12")).toEqual(["example/app#12"]);
    expect(refs("App PR #12 is red")).toEqual(["example/app#12"]);
    expect(refs("see lib pull request #7")).toEqual(["example/lib#7"]);
    expect(refs("see example/lib#7 at ABC1234")).toEqual(["example/lib#7@abc1234"]);
    expect(refs("PR #12 [abc1234]")).toEqual(["example/app#12@abc1234"]);
    expect(refs("repo:example/lib PR #3")).toEqual(["example/lib#3"]);
    expect(refs("bare #12", "mention")).toEqual(["example/app#12"]);
    expect(refs("bare #12", "report")).toEqual([]);
    for (const text of ["xapp#12", "app#123", "app#12a"]) {
      for (const mode of ["report", "mention"] as const) expect(refs(text, mode)).not.toContain("example/app#12");
    }
    expect(refs("xapp#12", "mention")).toEqual([]);
    expect(refs("app#12a", "mention")).toEqual([]);
    // Without the qualified form (a project with no repos:): only PR words
    expect(parsePrRefs("example/app#12, PR #3", [APP], { mode: "report", qualified: false }).map((r) => r.number)).toEqual([3]);
  });

  it("AT-4 prRefs_cross_repo_negative", () => {
    expect(refs("fix app#42")).toEqual(["example/app#42"]);
    expect(refs("#42", "mention", null)).toEqual(["example/app#42"]);
    expect(refs("#42", "mention", "example/lib")).toEqual(["example/lib#42"]);
    // A task repository that is not listed is no task repository
    expect(refs("#42", "mention", "example/other")).toEqual(["example/app#42"]);
    expect(refs("example/other#42", "mention")).toEqual([]);
    expect(refs("example/other#42", "report")).toEqual([]);
    // No default and no task repository: a bare PR names nothing
    expect(parsePrRefs("PR #42 and #43", [{ ...APP, default: false }, LIB], { mode: "mention" })).toEqual([]);
  });
});

describe("one host per repository", () => {
  it("AT-6: readyFactsFromHost reads lib's PR from lib's host only, with gate null and no findings; hosts are kept", async () => {
    const lib = new FakeRemote("example/lib");
    lib.defaultBranch = "trunk";
    const base = lib.commit([], { name: "W", email: "w@example.com" }, "init");
    lib.branches.set("main", base);
    const head = lib.commit([base], { name: "W", email: "w@example.com" }, "change");
    lib.openPull({ number: 7, headRef: "agent/worker-a/x", headSha: head, files: [] });
    lib.setChecks(head, [["build", "failure"], ["build", "success"]]);
    const hosts = new RepoHosts({ repos: [APP, LIB], apiUrl: "https://api.example.test", token: async () => null, fetch: fakeGitHubApi(lib) });

    const facts = await readyFactsFromHost(hosts.host("example/lib"), 7);
    expect(facts).toMatchObject({ state: "open", headSha: head, baseRef: "main", mergeable: true, behindBy: 0, gate: null, findingIds: [], commitShas: [head] });
    // The newest run of each name: the later success replaces the failure
    expect(facts.checks).toEqual([{ name: "build", state: "success" }]);
    expect(lib.requests.every((r) => r.path.startsWith("/repos/example/lib/"))).toBe(true);

    expect(hosts.host("EXAMPLE/LIB")).toBe(hosts.host("example/lib"));
    expect(() => hosts.host("example/other")).toThrow(/not one of the project's repositories/);
    const before = lib.requests.length;
    expect(await hosts.base("example/lib")).toBe("trunk");
    expect(await hosts.base("example/lib")).toBe("trunk");
    expect(lib.requests.length).toBe(before + 1);
    expect(await new RepoHosts({ repos: [{ ...LIB, base: "develop" }], apiUrl: "https://x.test", token: async () => null, fetch: fakeGitHubApi(lib) }).base("example/lib")).toBe(
      "develop",
    );
  });
});
