/**
 * The project's repositories (`repos:`), one list for every module that reads
 * pull requests of more than one repository: the ready guard now, PR health
 * later. Each entry has its base branch, whether its hosted CI counts, and
 * the short names task text uses for it (`app#12`). See
 * docs/configuration.md#repositories and docs/design/pr-health.md.
 *
 * Without `repos:` the list falls back to `tracker.repos[]` (their repo and
 * default), else to the review repository (`review.repo`, else `github`),
 * else it is empty and the modules that need it are inactive.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import { isSafeBranchName } from "../review/authors.js";

export interface RepoEntry {
  /** owner/name */
  repo: string;
  /** Bare `PR #12` and `#12` mean this repository (unless the task names its own) */
  default: boolean;
  /** The branch its PRs merge into; null: the host's default branch */
  base: string | null;
  /** false: its hosted CI is not a signal (no CI item is checked or reported) */
  ciCounts: boolean;
  /** Short names task text uses for it: `app#12`, `app PR #12` */
  refs: string[];
}

export type ReposResult =
  | {
      ok: true;
      repos: RepoEntry[];
      /** Where the list came from */
      from: "repos" | "tracker" | "review" | "none";
      /** Why the modules that need the list are inactive (it is empty), else null */
      inactive: string | null;
    }
  | { ok: false; errors: string[] };

export const MAX_REPOS = 20;
/** GitHub's limits, so a key built from it stays short */
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
const RESERVED_REFS = new Set(["pr", "pull"]);

const Ref = z
  .string()
  .regex(REF, "a letter, then up to 39 letters, digits, _ . or -")
  .refine((r) => !RESERVED_REFS.has(r.toLowerCase()), "pr and pull are not repository names");

const EntrySchema = z
  .object({
    repo: z.string().regex(REPO, "use owner/name"),
    default: z.boolean().optional(),
    base: z.string().min(1).max(255).refine(isSafeBranchName, "not a plain branch name").nullable().default(null),
    ci_counts: z.boolean().default(true),
    refs: z.array(Ref).max(8).optional(),
  })
  .strict();

const ReposSchema = z.array(EntrySchema).max(MAX_REPOS, `at most ${MAX_REPOS} repositories`);

/** The name part as a ref, when it is a valid one */
function nameRef(repo: string): string[] {
  const name = repo.split("/")[1] ?? "";
  return REF.test(name) && !RESERVED_REFS.has(name.toLowerCase()) ? [name] : [];
}

/** Defaulted refs two entries share are dropped from both (set `refs` to name them) */
function dropSharedDefaults(entries: { entry: RepoEntry; explicit: boolean }[]): RepoEntry[] {
  const count = new Map<string, number>();
  for (const { entry } of entries) for (const ref of entry.refs) count.set(ref.toLowerCase(), (count.get(ref.toLowerCase()) ?? 0) + 1);
  return entries.map(({ entry, explicit }) =>
    explicit ? entry : { ...entry, refs: entry.refs.filter((r) => count.get(r.toLowerCase()) === 1) },
  );
}

function fromRepos(raw: unknown): ReposResult {
  const parsed = ReposSchema.safeParse(raw);
  if (!parsed.success) {
    const where = (path: (string | number)[]) => `repos${path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("")}`;
    return { ok: false, errors: parsed.error.issues.map((issue) => `${where(issue.path)}: ${issue.message}`) };
  }
  const list = parsed.data;
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const refOwner = new Map<string, number>();
  list.forEach((r, i) => {
    const key = r.repo.toLowerCase();
    if (seen.has(key)) errors.push(`repos[${i}].repo: ${r.repo} is listed twice (also repos[${seen.get(key)}])`);
    seen.set(key, i);
    (r.refs ?? []).forEach((ref, j) => {
      const owner = refOwner.get(ref.toLowerCase());
      if (owner !== undefined && owner !== i) errors.push(`repos[${i}].refs[${j}]: ${ref} is also a ref of repos[${owner}]`);
      refOwner.set(ref.toLowerCase(), i);
    });
  });
  // An explicit ref that is another entry's name (its default ref) would take that name from it silently
  list.forEach((r, i) => {
    if (r.refs !== undefined) return;
    for (const ref of nameRef(r.repo)) {
      const owner = refOwner.get(ref.toLowerCase());
      if (owner !== undefined) errors.push(`repos[${owner}].refs: ${ref} is the name of repos[${i}] (${r.repo}); set repos[${i}].refs to tell them apart`);
    }
  });
  const defaults = list.filter((r) => r.default === true).length;
  if (list.length > 1 && defaults !== 1) {
    errors.push(`repos: exactly one entry must be default: true (${defaults} are), so a bare PR #<n> names one repository`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const repos = dropSharedDefaults(
    list.map((r) => ({
      explicit: r.refs !== undefined,
      entry: {
        repo: r.repo,
        default: r.default ?? list.length === 1,
        base: r.base,
        ciCounts: r.ci_counts,
        refs: r.refs ?? nameRef(r.repo),
      },
    })),
  );
  return { ok: true, repos, from: "repos", inactive: repos.length === 0 ? "repos: lists no repository" : null };
}

/** The project's repository list (see the file comment for the fallbacks). Errors name their key: `repos[1].refs[0]: ...`. */
export function parseReposConfig(project: Pick<ProjectConfig, "github" | "repos" | "tracker" | "review">): ReposResult {
  if (project.repos !== undefined) return fromRepos(project.repos);
  const plain = (repo: string, isDefault: boolean, base: string | null) => ({
    explicit: false,
    entry: { repo, default: isDefault, base, ciCounts: true, refs: nameRef(repo) },
  });
  const tracked = (project.tracker as { repos?: unknown } | undefined)?.repos;
  if (Array.isArray(tracked)) {
    const valid = tracked.filter((r): r is { repo: string; default?: unknown } => typeof r?.repo === "string" && REPO.test(r.repo));
    // As the tracker reads it: one entry is the default; two or more with no single default are "no default"
    const defaults = valid.filter((r) => r.default === true).length;
    const repos = dropSharedDefaults(
      valid.slice(0, MAX_REPOS).map((r) => plain(r.repo, valid.length === 1 || (r.default === true && defaults === 1), null)),
    );
    if (repos.length > 0) return { ok: true, repos, from: "tracker", inactive: null };
  }
  const review = project.review as { repo?: unknown; default_branch?: unknown } | undefined;
  const repo = typeof review?.repo === "string" ? review.repo : project.github;
  if (typeof repo === "string" && REPO.test(repo)) {
    const base = typeof review?.default_branch === "string" && isSafeBranchName(review.default_branch) ? review.default_branch : null;
    return { ok: true, repos: [plain(repo, true, base).entry], from: "review", inactive: null };
  }
  return { ok: true, repos: [], from: "none", inactive: "no repository is set: list them in repos: (or set tracker.repos, review.repo or github:)" };
}
