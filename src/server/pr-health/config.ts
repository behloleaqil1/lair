/**
 * The `pr_health:` block of a project file, parsed and checked
 * (docs/configuration.md#pr-health, docs/design/pr-health.md section 4.7).
 * Off by default; observe mode by default. It reads the project's `repos:`
 * list (src/server/repos/): an invalid list keeps PR health off.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import { compileBranchGlob, type BranchGlob } from "../review/authors.js";
import { parseReviewConfig } from "../review/config.js";
import { parseReposConfig, type RepoEntry } from "../repos/index.js";

export const KINDS = ["conflicts", "behind", "no_ci", "ci_red"] as const;
export type Kind = (typeof KINDS)[number];

/** The placeholders notify_cmd and withdraw_cmd may use (act mode fills them) */
export const NOTE_PLACEHOLDERS = ["agent", "repo", "pr", "head", "kinds", "id", "message"] as const;
const PLACEHOLDER = /\{([A-Za-z_]+)\}/g;
const IGNORED_PR = /^([A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,8})$/;

const Argv = z
  .array(z.string().min(1).max(4096))
  .min(1)
  .max(64)
  .refine((argv) => !argv[0].startsWith("-"), "the program (first element) must not start with '-'");

const int = (min: number, max: number, fallback: number) => z.number().int().min(min).max(max).default(fallback);

const Block = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["observe", "act"]).default("observe"),
    interval_seconds: int(60, 3600, 300),
    request_timeout_seconds: int(1, 120, 20),
    max_prs_per_repo: int(1, 100, 30),
    max_requests_per_tick: int(10, 1000, 120),
    behind_threshold: int(1, 10000, 30),
    no_ci_minutes: int(1, 1440, 20),
    clear_minutes: int(0, 1440, 10),
    kinds: z
      .object({ conflicts: z.boolean().default(true), behind: z.boolean().default(true), no_ci: z.boolean().default(true), ci_red: z.boolean().default(true) })
      .strict()
      .default({}),
    ignored_prs: z.array(z.string().regex(IGNORED_PR, "use owner/name#N")).max(200).default([]),
    // `*` stays within one path segment, and bot branches have several (dependabot/npm_and_yarn/x)
    ignored_branches: z.array(z.string()).max(50).default(["dependabot/**"]),
    owner: z.object({ branch_window_minutes: int(0, 10080, 360) }).strict().default({}),
    notify_cmd: Argv.nullable().default(null),
    withdraw_cmd: Argv.nullable().default(null),
    command_timeout_seconds: int(1, 300, 30),
    max_attempts: int(1, 5, 3),
    backoff_seconds: int(30, 3600, 300),
    escalate_after_minutes: z.number().int().min(10).max(10080).nullable().default(null),
  })
  .strict();

export interface PrHealthSettings {
  enabled: boolean;
  mode: "observe" | "act";
  intervalSeconds: number;
  requestTimeoutSeconds: number;
  maxPrsPerRepo: number;
  maxRequestsPerTick: number;
  behindThreshold: number;
  noCiMinutes: number;
  clearMinutes: number;
  kinds: Record<Kind, boolean>;
  /** Each as the repository is listed in repos: */
  ignoredPrs: { repo: string; pr: number }[];
  ignoredBranches: BranchGlob[];
  branchWindowMinutes: number;
  notifyCmd: string[] | null;
  withdrawCmd: string[] | null;
  commandTimeoutSeconds: number;
  maxAttempts: number;
  backoffSeconds: number;
  escalateAfterMinutes: number | null;
  /** The project's repositories (repos:, or its fallbacks) */
  repos: RepoEntry[];
  /** Why PR health watches nothing (no repository), or null */
  inactive: string | null;
  /** The review module's host and token (review.api_url, token_env, token_cmd), else GitHub and GITHUB_TOKEN */
  apiUrl: string;
  tokenEnv: string;
  tokenCmd: string[] | null;
  /** review.authors' branch mappings, for the owner rule's branch step (none when review: does not parse) */
  authors: { branchPattern: RegExp | null; branches: BranchGlob[] };
}

export type ParseResult = { ok: true; settings: PrHealthSettings } | { ok: false; errors: string[] };

function placeholdersIn(template: readonly string[]): string[] {
  const names = new Set<string>();
  for (const arg of template) for (const m of arg.matchAll(PLACEHOLDER)) names.add(m[1]);
  return [...names];
}

/** Parse and check `pr_health:` with the project's repository list. An absent block is the defaults: off. */
export function parsePrHealthConfig(project: ProjectConfig): ParseResult {
  const parsed = Block.safeParse(project.pr_health ?? {});
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `pr_health.${i.path.join(".") || "(block)"}: ${i.message}`) };
  }
  const b = parsed.data;
  const errors: string[] = [];
  const list = parseReposConfig(project);
  // An invalid repos: is the project's problem (the reloader reports it); it keeps PR health off when it is on
  if (!list.ok && b.enabled) errors.push(...list.errors);
  const repos = list.ok ? list.repos : [];
  const ignoredPrs: PrHealthSettings["ignoredPrs"] = [];
  b.ignored_prs.forEach((text, i) => {
    const [, repo, pr] = IGNORED_PR.exec(text) as RegExpExecArray;
    const entry = repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase());
    if (entry) ignoredPrs.push({ repo: entry.repo, pr: Number(pr) });
    else if (list.ok) errors.push(`pr_health.ignored_prs.${i}: ${repo} is not listed in repos:`);
  });
  const ignoredBranches: BranchGlob[] = [];
  b.ignored_branches.forEach((glob, i) => {
    const compiled = compileBranchGlob(glob, "ignored");
    if (typeof compiled === "string") errors.push(`pr_health.ignored_branches.${i}: ${compiled}`);
    else ignoredBranches.push(compiled);
  });
  for (const key of ["notify_cmd", "withdraw_cmd"] as const) {
    const argv = b[key];
    if (!argv) continue;
    for (const n of placeholdersIn(argv)) {
      if (!(NOTE_PLACEHOLDERS as readonly string[]).includes(n)) {
        errors.push(`pr_health.${key}: unknown placeholder {${n}} (allowed: ${NOTE_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")})`);
      }
    }
    if (placeholdersIn([argv[0]]).length > 0) errors.push(`pr_health.${key}: the program can't be a placeholder`);
  }
  if (b.mode === "act" && !b.notify_cmd) errors.push("pr_health.mode: act needs notify_cmd, the command that sends a note");
  if (errors.length > 0) return { ok: false, errors };
  const review = parseReviewConfig(project.review, project);
  return {
    ok: true,
    settings: {
      enabled: b.enabled,
      mode: b.mode,
      intervalSeconds: b.interval_seconds,
      requestTimeoutSeconds: b.request_timeout_seconds,
      maxPrsPerRepo: b.max_prs_per_repo,
      maxRequestsPerTick: b.max_requests_per_tick,
      behindThreshold: b.behind_threshold,
      noCiMinutes: b.no_ci_minutes,
      clearMinutes: b.clear_minutes,
      kinds: { ...b.kinds },
      ignoredPrs,
      ignoredBranches,
      branchWindowMinutes: b.owner.branch_window_minutes,
      notifyCmd: b.notify_cmd,
      withdrawCmd: b.withdraw_cmd,
      commandTimeoutSeconds: b.command_timeout_seconds,
      maxAttempts: b.max_attempts,
      backoffSeconds: b.backoff_seconds,
      escalateAfterMinutes: b.escalate_after_minutes,
      repos,
      inactive: list.ok ? list.inactive : null,
      apiUrl: review.ok ? review.settings.apiUrl : "https://api.github.com",
      tokenEnv: review.ok ? review.settings.tokenEnv : "GITHUB_TOKEN",
      tokenCmd: review.ok ? review.settings.tokenCmd : null,
      authors: review.ok ? { branchPattern: review.settings.authors.branchPattern, branches: review.settings.authors.branches } : { branchPattern: null, branches: [] },
    },
  };
}

/** Why act mode does nothing for this project, or null when it acts. */
export function actBlockedReason(config: ProjectConfig, settings: PrHealthSettings): string {
  if (settings.mode !== "act") return "pr_health.mode is observe: findings are shown, nothing is sent or raised";
  if (config.read_only === true) return "the project is read_only";
  return "act mode is not available in this version: findings are shown, nothing is sent or raised";
}
