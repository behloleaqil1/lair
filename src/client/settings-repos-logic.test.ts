/**
 * Unit tests for settings-repos.ts: the logic for managing the repos: list.
 */
import { describe, expect, it } from "vitest";
import {
  addRepo,
  allRefsMap,
  hasReposKey,
  legacyGithub,
  MAX_REFS,
  migrateFromGithub,
  removeRepo,
  reposOf,
  rowToEntry,
  updateRepo,
  validateRef,
  validateRefs,
  validateRepo,
  type Draft,
  type RepoRow,
} from "./settings-repos";

describe("reposOf", () => {
  it("parses valid repos array", () => {
    const draft: Draft = {
      repos: [
        { repo: "owner/app", default: true, base: "main", ci_counts: true, refs: ["app"] },
        { repo: "owner/lib", base: "develop", ci_counts: false },
      ],
    };
    const rows = reposOf(draft);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      index: 0,
      repo: "owner/app",
      isDefault: true,
      base: "main",
      ciCounts: true,
      refs: ["app"],
    });
    expect(rows[1]).toEqual({
      index: 1,
      repo: "owner/lib",
      isDefault: false,
      base: "develop",
      ciCounts: false,
      refs: [],
    });
  });

  it("returns empty array when repos is missing", () => {
    expect(reposOf({})).toEqual([]);
  });

  it("skips invalid entries", () => {
    const draft: Draft = {
      repos: [
        { repo: "invalid" }, // no slash
        { repo: "owner/valid" },
        "not an object",
        null,
      ],
    };
    const rows = reposOf(draft);
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe("owner/valid");
  });

  it("filters invalid refs", () => {
    const draft: Draft = {
      repos: [{ repo: "owner/app", refs: ["valid", "123invalid", "pr", "also-valid"] }],
    };
    const rows = reposOf(draft);
    expect(rows[0].refs).toEqual(["valid", "also-valid"]);
  });
});

describe("hasReposKey", () => {
  it("returns true when repos key exists", () => {
    expect(hasReposKey({ repos: [] })).toBe(true);
    expect(hasReposKey({ repos: [{ repo: "a/b" }] })).toBe(true);
  });

  it("returns false when repos key is missing", () => {
    expect(hasReposKey({})).toBe(false);
    expect(hasReposKey({ github: "a/b" })).toBe(false);
  });
});

describe("legacyGithub", () => {
  it("returns github value when repos is absent", () => {
    expect(legacyGithub({ github: "owner/repo" })).toBe("owner/repo");
  });

  it("returns review.repo when github is absent", () => {
    expect(legacyGithub({ review: { repo: "owner/repo" } })).toBe("owner/repo");
  });

  it("prefers github over review.repo", () => {
    expect(legacyGithub({ github: "owner/github", review: { repo: "owner/review" } })).toBe("owner/github");
  });

  it("returns null when repos is present", () => {
    expect(legacyGithub({ repos: [], github: "owner/repo" })).toBeNull();
  });

  it("returns null when neither github nor review.repo is set", () => {
    expect(legacyGithub({})).toBeNull();
  });

  it("returns null for invalid github format", () => {
    expect(legacyGithub({ github: "invalid" })).toBeNull();
  });
});

describe("validateRepo", () => {
  it("returns null for valid repo", () => {
    expect(validateRepo("owner/repo", [], null)).toBeNull();
  });

  it("rejects empty repo", () => {
    expect(validateRepo("", [], null)).toBe("required");
    expect(validateRepo("  ", [], null)).toBe("required");
  });

  it("rejects invalid format", () => {
    expect(validateRepo("invalid", [], null)).toBe("use owner/name format");
    expect(validateRepo("owner/", [], null)).toBe("use owner/name format");
    expect(validateRepo("/repo", [], null)).toBe("use owner/name format");
  });

  it("rejects duplicate repo", () => {
    expect(validateRepo("owner/repo", ["owner/repo"], null)).toBe("repository already listed");
    expect(validateRepo("OWNER/REPO", ["owner/repo"], null)).toBe("repository already listed");
  });

  it("allows editing the same repo", () => {
    expect(validateRepo("owner/repo", ["owner/repo", "owner/other"], 0)).toBeNull();
  });
});

describe("validateRef", () => {
  it("returns null for valid refs", () => {
    expect(validateRef("app")).toBeNull();
    expect(validateRef("my-lib")).toBeNull();
    expect(validateRef("a123")).toBeNull();
    expect(validateRef("A")).toBeNull();
  });

  it("rejects empty ref", () => {
    expect(validateRef("")).toBe("required");
  });

  it("rejects ref starting with number", () => {
    expect(validateRef("123")).toBe("a letter, then up to 39 letters, digits, _ . or -");
  });

  it("rejects reserved refs", () => {
    expect(validateRef("pr")).toBe("pr and pull are reserved");
    expect(validateRef("PR")).toBe("pr and pull are reserved");
    expect(validateRef("pull")).toBe("pr and pull are reserved");
  });
});

describe("validateRefs", () => {
  it("returns null for valid refs", () => {
    expect(validateRefs(["app", "lib"], new Map(), null)).toBeNull();
  });

  it("rejects too many refs", () => {
    const refs = Array.from({ length: MAX_REFS + 1 }, (_, i) => `ref${i}`);
    expect(validateRefs(refs, new Map(), null)).toBe(`at most ${MAX_REFS} refs`);
  });

  it("rejects duplicate refs within the list", () => {
    expect(validateRefs(["app", "APP"], new Map(), null)).toBe("duplicate ref: APP");
  });

  it("rejects refs used by other repos", () => {
    const allRefs = new Map([["app", 0]]);
    expect(validateRefs(["app"], allRefs, 1)).toBe("app is used by another repository");
  });

  it("allows own refs", () => {
    const allRefs = new Map([["app", 0]]);
    expect(validateRefs(["app"], allRefs, 0)).toBeNull();
  });
});

describe("addRepo", () => {
  it("adds a repo to empty list", () => {
    const draft: Draft = {};
    const result = addRepo(draft, { repo: "owner/app", default: true });
    expect(result.repos).toEqual([{ repo: "owner/app", default: true }]);
  });

  it("adds a repo to existing list", () => {
    const draft: Draft = { repos: [{ repo: "owner/app" }] };
    const result = addRepo(draft, { repo: "owner/lib" });
    const repos = result.repos as unknown[];
    expect(repos).toHaveLength(2);
    expect(repos[1]).toEqual({ repo: "owner/lib" });
  });

  it("clears other defaults when adding a default", () => {
    const draft: Draft = { repos: [{ repo: "owner/app", default: true }] };
    const result = addRepo(draft, { repo: "owner/lib", default: true });
    const repos = result.repos as Array<Record<string, unknown>>;
    expect(repos[0].default).toBeUndefined();
    expect(repos[1].default).toBe(true);
  });
});

describe("updateRepo", () => {
  it("updates a repo at index", () => {
    const draft: Draft = { repos: [{ repo: "owner/app", base: "main" }] };
    const result = updateRepo(draft, 0, { repo: "owner/app", base: "develop" });
    const repos = result.repos as unknown[];
    expect(repos[0]).toEqual({ repo: "owner/app", base: "develop" });
  });

  it("clears other defaults when updating to default", () => {
    const draft: Draft = {
      repos: [
        { repo: "owner/app", default: true },
        { repo: "owner/lib" },
      ],
    };
    const result = updateRepo(draft, 1, { repo: "owner/lib", default: true });
    const repos = result.repos as Array<Record<string, unknown>>;
    expect(repos[0].default).toBeUndefined();
    expect(repos[1].default).toBe(true);
  });

  it("returns draft unchanged for invalid index", () => {
    const draft: Draft = { repos: [{ repo: "owner/app" }] };
    expect(updateRepo(draft, -1, { repo: "owner/lib" })).toBe(draft);
    expect(updateRepo(draft, 5, { repo: "owner/lib" })).toBe(draft);
  });
});

describe("removeRepo", () => {
  it("removes a repo at index", () => {
    const draft: Draft = {
      repos: [
        { repo: "owner/app" },
        { repo: "owner/lib" },
      ],
    };
    const result = removeRepo(draft, 0);
    const repos = result.repos as unknown[];
    expect(repos).toHaveLength(1);
    expect(repos[0]).toEqual({ repo: "owner/lib" });
  });

  it("removes repos key when list becomes empty", () => {
    const draft: Draft = { repos: [{ repo: "owner/app" }] };
    const result = removeRepo(draft, 0);
    expect(result.repos).toBeUndefined();
  });

  it("returns draft unchanged for invalid index", () => {
    const draft: Draft = { repos: [{ repo: "owner/app" }] };
    expect(removeRepo(draft, -1)).toBe(draft);
    expect(removeRepo(draft, 5)).toBe(draft);
  });
});

describe("migrateFromGithub", () => {
  it("creates repos from github value", () => {
    const draft: Draft = { github: "owner/app" };
    const result = migrateFromGithub(draft, "owner/app");
    const repos = result.repos as unknown[];
    expect(repos).toEqual([{ repo: "owner/app", default: true }]);
    expect(result.github).toBe("owner/app"); // github: is kept
  });
});

describe("rowToEntry", () => {
  it("converts row to minimal entry", () => {
    const row: Omit<RepoRow, "index"> = {
      repo: "owner/app",
      isDefault: false,
      base: null,
      ciCounts: true,
      refs: [],
    };
    expect(rowToEntry(row)).toEqual({ repo: "owner/app" });
  });

  it("includes optional fields when set", () => {
    const row: Omit<RepoRow, "index"> = {
      repo: "owner/app",
      isDefault: true,
      base: "develop",
      ciCounts: false,
      refs: ["app"],
    };
    expect(rowToEntry(row)).toEqual({
      repo: "owner/app",
      default: true,
      base: "develop",
      ci_counts: false,
      refs: ["app"],
    });
  });
});

describe("allRefsMap", () => {
  it("builds map of all refs", () => {
    const rows: RepoRow[] = [
      { index: 0, repo: "owner/app", isDefault: true, base: null, ciCounts: true, refs: ["app", "main-app"] },
      { index: 1, repo: "owner/lib", isDefault: false, base: null, ciCounts: true, refs: ["lib"] },
    ];
    const map = allRefsMap(rows);
    expect(map.get("app")).toBe(0);
    expect(map.get("main-app")).toBe(0);
    expect(map.get("lib")).toBe(1);
  });

  it("is case-insensitive", () => {
    const rows: RepoRow[] = [
      { index: 0, repo: "owner/app", isDefault: true, base: null, ciCounts: true, refs: ["App"] },
    ];
    const map = allRefsMap(rows);
    expect(map.get("app")).toBe(0);
  });
});
