/**
 * Settings → Repositories (docs/design/project-setup.md §4.2): logic for
 * managing the repos: list and offering github: migration. The draft uses
 * the same setIn/getIn pattern as other Settings pages.
 */
import { isPlainObject } from "../shared/settings-rules";
import { getIn, setIn } from "./settings-form";

/** A repository entry as the UI shows it. */
export interface RepoRow {
  /** Index in the repos: array */
  index: number;
  /** owner/name */
  repo: string;
  /** This is the default repository for bare PR #12 */
  isDefault: boolean;
  /** The base branch (null: host's default) */
  base: string | null;
  /** Whether hosted CI counts for this repository */
  ciCounts: boolean;
  /** Short names: app#12, lib#12 */
  refs: string[];
}

/** A repo entry as stored in the YAML (snake_case keys). */
export interface RepoEntry {
  repo: string;
  default?: boolean;
  base?: string | null;
  ci_counts?: boolean;
  refs?: string[];
}

/** The draft = project config values. */
export type Draft = Record<string, unknown>;

/** GitHub repo pattern (owner/name). */
const GITHUB_REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

/** Ref pattern: a letter, then up to 39 letters/digits/_ . -. */
const REF_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

/** Reserved refs that cannot be used as repository names. */
const RESERVED_REFS = new Set(["pr", "pull"]);

/** Maximum number of repositories in a project. */
export const MAX_REPOS = 20;

/** Maximum number of refs per repository. */
export const MAX_REFS = 8;

// ============ READ ============

/** The repos: array from the draft, or [] if absent. */
export function reposArrayOf(draft: Draft): unknown[] {
  const repos = getIn(draft, ["repos"]);
  return Array.isArray(repos) ? repos : [];
}

/** Whether the draft has an explicit repos: key. */
export function hasReposKey(draft: Draft): boolean {
  return getIn(draft, ["repos"]) !== undefined;
}

/** The legacy github: value, if set and repos: is absent. */
export function legacyGithub(draft: Draft): string | null {
  if (hasReposKey(draft)) return null;
  const github = getIn(draft, ["github"]);
  if (typeof github === "string" && GITHUB_REPO.test(github)) return github;
  const reviewRepo = getIn(draft, ["review", "repo"]);
  if (typeof reviewRepo === "string" && GITHUB_REPO.test(reviewRepo)) return reviewRepo;
  return null;
}

/** Parse the repos: array into UI rows. */
export function reposOf(draft: Draft): RepoRow[] {
  const raw = reposArrayOf(draft);
  const rows: RepoRow[] = [];
  for (let i = 0; i < raw.length && i < MAX_REPOS; i++) {
    const entry = raw[i];
    if (!isPlainObject(entry)) continue;
    const repo = typeof entry.repo === "string" ? entry.repo : "";
    if (!GITHUB_REPO.test(repo)) continue;
    rows.push({
      index: i,
      repo,
      isDefault: entry.default === true,
      base: typeof entry.base === "string" ? entry.base : null,
      ciCounts: entry.ci_counts !== false,
      refs: Array.isArray(entry.refs) ? entry.refs.filter((r): r is string => typeof r === "string" && REF_PATTERN.test(r) && !RESERVED_REFS.has(r.toLowerCase())) : [],
    });
  }
  return rows;
}

// ============ VALIDATE ============

/** Validate a repo string. Returns error message or null if valid. */
export function validateRepo(repo: string, existingRepos: string[], editingIndex: number | null): string | null {
  if (!repo || repo.trim() === "") return "required";
  if (!GITHUB_REPO.test(repo.trim())) return "use owner/name format";
  const lower = repo.trim().toLowerCase();
  for (let i = 0; i < existingRepos.length; i++) {
    if (editingIndex !== null && i === editingIndex) continue;
    if (existingRepos[i].toLowerCase() === lower) return "repository already listed";
  }
  return null;
}

/** Validate a ref string. Returns error message or null if valid. */
export function validateRef(ref: string): string | null {
  if (!ref || ref.trim() === "") return "required";
  const trimmed = ref.trim();
  if (!REF_PATTERN.test(trimmed)) return "a letter, then up to 39 letters, digits, _ . or -";
  if (RESERVED_REFS.has(trimmed.toLowerCase())) return "pr and pull are reserved";
  return null;
}

/** Validate refs array. Returns error message or null if valid. */
export function validateRefs(refs: string[], allRefs: Map<string, number>, editingIndex: number | null): string | null {
  if (refs.length > MAX_REFS) return `at most ${MAX_REFS} refs`;
  const seen = new Set<string>();
  for (const ref of refs) {
    const err = validateRef(ref);
    if (err) return err;
    const lower = ref.toLowerCase();
    if (seen.has(lower)) return `duplicate ref: ${ref}`;
    seen.add(lower);
    const owner = allRefs.get(lower);
    if (owner !== undefined && owner !== editingIndex) return `${ref} is used by another repository`;
  }
  return null;
}

/** Build a map of all refs to their owning repo index. */
export function allRefsMap(rows: RepoRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    for (const ref of row.refs) {
      map.set(ref.toLowerCase(), row.index);
    }
  }
  return map;
}

// ============ WRITE ============

/** Add a new repository entry to the draft. */
export function addRepo(draft: Draft, entry: RepoEntry): Draft {
  const current = reposArrayOf(draft);
  // If adding as default, clear default from others
  const updated = entry.default
    ? current.map((r) => (isPlainObject(r) ? { ...r, default: undefined } : r))
    : current;
  return setIn(draft, ["repos"], [...updated, entry]) as Draft;
}

/** Update a repository entry at index. */
export function updateRepo(draft: Draft, index: number, entry: RepoEntry): Draft {
  const current = reposArrayOf(draft);
  if (index < 0 || index >= current.length) return draft;
  // If making this one default, clear default from others
  let updated = [...current];
  if (entry.default) {
    updated = updated.map((r, i) => (i !== index && isPlainObject(r) ? { ...r, default: undefined } : r));
  }
  updated[index] = entry;
  return setIn(draft, ["repos"], updated) as Draft;
}

/** Remove a repository entry at index. */
export function removeRepo(draft: Draft, index: number): Draft {
  const current = reposArrayOf(draft);
  if (index < 0 || index >= current.length) return draft;
  const updated = [...current];
  updated.splice(index, 1);
  // If the list is now empty, remove the repos key entirely
  return setIn(draft, ["repos"], updated.length === 0 ? undefined : updated) as Draft;
}

/** Migrate from legacy github:/review.repo to repos:[{repo, default: true}]. */
export function migrateFromGithub(draft: Draft, repo: string): Draft {
  const entry: RepoEntry = { repo, default: true };
  return setIn(draft, ["repos"], [entry]) as Draft;
}

/** Convert a RepoRow back to a RepoEntry for storage. */
export function rowToEntry(row: Omit<RepoRow, "index">): RepoEntry {
  const entry: RepoEntry = { repo: row.repo };
  if (row.isDefault) entry.default = true;
  if (row.base !== null) entry.base = row.base;
  if (!row.ciCounts) entry.ci_counts = false;
  if (row.refs.length > 0) entry.refs = row.refs;
  return entry;
}
