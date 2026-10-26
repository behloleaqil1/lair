/**
 * Risk tiers as configuration: rules over path globs, file kinds, change size
 * and labels decide a PR's tier (red / amber / green), and the result says
 * which rules matched and why. docs/design/autonomy.md §5.
 *
 * Every changed file gets the highest tier of the file rules that match it,
 * or the default tier when none does. Size and label rules apply to the whole
 * change. The PR's tier is the highest of all of them.
 */
import type { FileRisk, RiskAssessment, RiskRuleMatch, Tier } from "../../shared/review-types.js";

export interface RiskRule {
  id: string;
  tier: Tier;
  description?: string;
  /** Globs over changed paths. A glob without "/" matches the file name at any depth */
  paths?: string[];
  /** File kinds (see DEFAULT_FILE_KINDS), e.g. migration, auth, billing, workflow, dependency */
  kinds?: string[];
  /** Any of these labels on the PR (case-insensitive) */
  labels?: string[];
  /** Added plus deleted lines at least this many */
  minLines?: number;
  /** At least this many changed files */
  minFiles?: number;
}

export interface ChangedFile {
  path: string;
  /** The old path of a renamed file: a rename out of a red area is still red */
  previousPath?: string | null;
  additions: number;
  deletions: number;
}

export interface ChangeFacts {
  files: ChangedFile[];
  labels: string[];
}

const TIER_RANK: Record<Tier, number> = { green: 1, amber: 2, red: 3 };

export function higherTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * Built-in file kinds. A project's `file_kinds` adds kinds or replaces these
 * lists. Globs without "/" match the file name at any depth.
 */
export const DEFAULT_FILE_KINDS: Record<string, string[]> = {
  migration: [
    "**/migrations/**",
    "**/migration/**",
    "**/migrate/**",
    "**/alembic/**",
    "**/flyway/**",
    "**/liquibase/**",
    "*.migration.*",
  ],
  auth: [
    "**/auth/**",
    "**/authn/**",
    "**/authz/**",
    "**/authentication/**",
    "**/authorization/**",
    "**/oauth/**",
    "**/security/**",
    "**/permissions/**",
    "**/rbac/**",
    "**/session/**",
    "**/sessions/**",
  ],
  billing: [
    "**/billing/**",
    "**/payment/**",
    "**/payments/**",
    "**/invoice/**",
    "**/invoices/**",
    "**/subscription/**",
    "**/subscriptions/**",
    "**/checkout/**",
    "**/pricing/**",
  ],
  workflow: [
    ".github/workflows/**",
    ".github/actions/**",
    ".gitlab-ci.yml",
    ".gitlab/**",
    ".circleci/**",
    ".buildkite/**",
    "Jenkinsfile",
    "azure-pipelines.yml",
    "bitbucket-pipelines.yml",
    ".drone.yml",
  ],
  dependency: [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "requirements*.txt",
    "Pipfile",
    "Pipfile.lock",
    "poetry.lock",
    "pyproject.toml",
    "uv.lock",
    "go.mod",
    "go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "Gemfile",
    "Gemfile.lock",
    "build.gradle",
    "build.gradle.kts",
    "gradle.lockfile",
    "pom.xml",
    "composer.json",
    "composer.lock",
    "*.csproj",
    "packages.lock.json",
    "mix.exs",
    "mix.lock",
  ],
  docs: ["**/*.md", "**/*.mdx", "**/*.rst", "docs/**", "LICENSE", "CHANGELOG*"],
  test: [
    "*.test.*",
    "*.spec.*",
    "**/__tests__/**",
    "test_*.py",
    "*_test.py",
    "*_test.go",
    "*Test.java",
    "*Tests.java",
    "*Test.kt",
    "**/tests/**",
    "**/test/**",
  ],
};

/** Rules used when a project sets none: risky kinds red, dependencies amber, docs and tests green. */
export const DEFAULT_RISK_RULES: RiskRule[] = [
  { id: "migrations", tier: "red", kinds: ["migration"], description: "Database migrations" },
  { id: "auth", tier: "red", kinds: ["auth"], description: "Authentication, authorisation and sessions" },
  { id: "billing", tier: "red", kinds: ["billing"], description: "Money" },
  { id: "ci-workflows", tier: "red", kinds: ["workflow"], description: "CI workflows can reach secrets" },
  { id: "security-label", tier: "red", labels: ["security"], description: "Labelled security" },
  { id: "dependencies", tier: "amber", kinds: ["dependency"], description: "Dependency changes" },
  { id: "large-change", tier: "amber", minLines: 500, description: "Large changes" },
  { id: "docs", tier: "green", kinds: ["docs"], description: "Documentation" },
  { id: "tests", tier: "green", kinds: ["test"], description: "Tests (the integrity check still runs)" },
];

// ============ GLOBS ============

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

/** Regex source for a glob body: `**` spans directories, `*` and `?` don't, `{a,b}` alternates. */
function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        const alternatives = glob.slice(i + 1, end).split(",").map(globSource);
        out += `(?:${alternatives.join("|")})`;
        i = end;
      } else {
        out += "\\{";
      }
    } else {
      out += REGEX_SPECIAL.test(c) ? `\\${c}` : c;
    }
  }
  return out;
}

const globCache = new Map<string, RegExp>();

/**
 * True if `path` matches `glob`. A glob with no "/" is matched against the
 * file name only, so `package.json` matches `apps/web/package.json`.
 */
export function matchPath(glob: string, path: string): boolean {
  const normalized = path.replace(/^\.?\//, "");
  const pattern = glob.replace(/^\.?\//, "");
  let regex = globCache.get(pattern);
  if (!regex) {
    regex = new RegExp(`^${globSource(pattern)}$`);
    globCache.set(pattern, regex);
  }
  if (pattern.includes("/")) return regex.test(normalized);
  const slash = normalized.lastIndexOf("/");
  return regex.test(slash >= 0 ? normalized.slice(slash + 1) : normalized);
}

/** The file kinds `path` belongs to. */
export function fileKindsOf(path: string, kinds: Record<string, string[]>): string[] {
  return Object.entries(kinds)
    .filter(([, globs]) => globs.some((g) => matchPath(g, path)))
    .map(([kind]) => kind);
}

// ============ ASSESSMENT ============

const MAX_REASONS_PER_RULE = 5;

/**
 * Compute a change's risk tier, with every rule that matched and why.
 */
export function assessRisk(
  change: ChangeFacts,
  rules: RiskRule[],
  fileKinds: Record<string, string[]>,
  defaultTier: Tier,
): RiskAssessment {
  const additions = change.files.reduce((n, f) => n + f.additions, 0);
  const deletions = change.files.reduce((n, f) => n + f.deletions, 0);
  const totalLines = additions + deletions;
  const labels = change.labels.map((l) => l.toLowerCase());

  const perFile = new Map<string, { tier: Tier | null; rules: string[] }>();
  for (const file of change.files) perFile.set(file.path, { tier: null, rules: [] });

  const matches: RiskRuleMatch[] = [];
  let changeTier: Tier | null = null;

  for (const rule of rules) {
    const reasons: string[] = [];

    if (rule.labels && rule.labels.length > 0) {
      const wanted = rule.labels.map((l) => l.toLowerCase());
      const hit = labels.filter((l) => wanted.includes(l));
      if (hit.length === 0) continue;
      reasons.push(`label ${hit.join(", ")}`);
    }
    if (rule.minLines !== undefined) {
      if (totalLines < rule.minLines) continue;
      reasons.push(`${totalLines} changed lines (at least ${rule.minLines})`);
    }
    if (rule.minFiles !== undefined) {
      if (change.files.length < rule.minFiles) continue;
      reasons.push(`${change.files.length} changed files (at least ${rule.minFiles})`);
    }

    const selectsFiles = (rule.paths?.length ?? 0) > 0 || (rule.kinds?.length ?? 0) > 0;
    const matchedFiles: string[] = [];
    if (selectsFiles) {
      for (const file of change.files) {
        const candidates = [file.path, file.previousPath].filter((p): p is string => !!p);
        let why: string | null = null;
        for (const candidate of candidates) {
          const kind = (rule.kinds ?? []).find((k) =>
            (fileKinds[k] ?? []).some((g) => matchPath(g, candidate)),
          );
          if (kind) {
            why = `kind ${kind}: ${candidate}`;
            break;
          }
          const glob = (rule.paths ?? []).find((g) => matchPath(g, candidate));
          if (glob) {
            why = `path ${glob}: ${candidate}`;
            break;
          }
        }
        if (!why) continue;
        matchedFiles.push(file.path);
        if (reasons.length < MAX_REASONS_PER_RULE) reasons.push(why);
        const entry = perFile.get(file.path)!;
        entry.tier = entry.tier ? higherTier(entry.tier, rule.tier) : rule.tier;
        entry.rules.push(rule.id);
      }
      if (matchedFiles.length === 0) continue;
      if (matchedFiles.length > MAX_REASONS_PER_RULE) {
        reasons.push(`and ${matchedFiles.length - MAX_REASONS_PER_RULE} more file(s)`);
      }
    } else {
      changeTier = changeTier ? higherTier(changeTier, rule.tier) : rule.tier;
    }

    matches.push({
      id: rule.id,
      tier: rule.tier,
      description: rule.description ?? null,
      reasons,
      files: matchedFiles,
    });
  }

  const files: FileRisk[] = change.files.map((f) => {
    const entry = perFile.get(f.path)!;
    return { path: f.path, tier: entry.tier ?? defaultTier, rules: entry.rules };
  });

  let tier: Tier = files.length > 0 ? "green" : defaultTier;
  for (const f of files) tier = higherTier(tier, f.tier);
  if (changeTier) tier = higherTier(tier, changeTier);

  return {
    tier,
    defaultTier,
    rules: matches,
    files,
    size: { files: change.files.length, additions, deletions },
    labels: change.labels,
  };
}
