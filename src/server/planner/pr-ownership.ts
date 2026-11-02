/**
 * PR ownership checks for the planner verifier (issue #290): when a finish
 * proposal names a PR, verify that the PR belongs to the task.
 *
 * A PR belongs to a task when:
 * 1. Its head branch names the task id (e.g., agent/worker-a/feat-login contains "feat-login")
 * 2. Its head branch maps to the task's agent per review.authors config
 * 3. Its title or body names the task id
 *
 * Lair runs the check itself when a planner run's finish proposals come in
 * (service.ts): a PR that belongs to another task refuses the proposal, a PR
 * Lair cannot read holds it for the owner (unsure), never "owned".
 */

import type { ProjectConfig } from "../../shared/types.js";
import type { AuthorMapping } from "../review/authors.js";
import { globMatches } from "../review/authors.js";
import { parseReviewConfig } from "../review/config.js";
import { GitHubHost, tokenFrom } from "../review/github.js";

/** Extracted PR reference from a proposal reason. */
export interface ExtractedPr {
  number: number;
  context: string;
}

/** A PR's metadata for ownership checking. */
export interface PrMetadata {
  number: number;
  headBranch: string;
  title: string;
  body: string | null;
  state: "open" | "closed" | "merged";
}

/** Result of PR ownership check. */
export interface OwnershipResult {
  owns: boolean;
  reason: string | null;
  method: "branch_contains_task" | "branch_agent_match" | "title_body_match" | "none";
}

/** Extract PR numbers from a finish proposal's reason (merged as #N, PR #N merged, etc.). */
export function extractPrNumbers(reason: string): ExtractedPr[] {
  const results: ExtractedPr[] = [];
  const seen = new Set<number>();
  const patterns = [
    /merged\s+(?:as\s+)?(?:PR\s*)?#(\d+)/gi,
    /(?:PR\s*)?#(\d+)\s+(?:is\s+)?merged/gi,
    /merged\s+in\s+(?:PR\s*)?#(\d+)/gi,
    /merged\s*\((?:PR\s*)?#(\d+)\)/gi,
    /\(merged\s+(?:as\s+)?(?:PR\s*)?#(\d+)\)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of reason.matchAll(pattern)) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > 0 && !seen.has(num)) {
        seen.add(num);
        results.push({ number: num, context: match[0] });
      }
    }
  }
  // Fall back: bare #N if reason contains merge
  if (results.length === 0 && /merge/i.test(reason)) {
    for (const match of reason.matchAll(/#(\d+)/g)) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > 0 && !seen.has(num)) {
        seen.add(num);
        results.push({ number: num, context: match[0] });
      }
    }
  }
  return results;
}

/** Check if a branch names the task id (case-insensitive, separator-normalized). */
export function branchContainsTask(branch: string, taskId: string): boolean {
  // Normalize: lowercase and treat - and _ as equivalent within a segment
  const normSeg = (s: string) => s.toLowerCase().replace(/[_]/g, "-");
  const branchParts = branch.toLowerCase().split("/");
  const taskParts = taskId.toLowerCase().split("/");
  // Match task parts as consecutive segments in the branch
  for (let i = 0; i <= branchParts.length - taskParts.length; i++) {
    if (taskParts.every((t, j) => normSeg(branchParts[i + j]) === normSeg(t))) return true;
  }
  return false;
}

/** Check if a branch maps to the expected agent via review.authors config. */
export function branchMatchesAgent(branch: string, expectedAgent: string | null, mapping: AuthorMapping | null): boolean {
  if (!mapping || !expectedAgent) return false;
  if (mapping.branchPattern?.exec(branch)?.groups?.agent === expectedAgent) return true;
  for (const glob of mapping.branches) {
    if (globMatches(glob, branch) && glob.agent === expectedAgent) return true;
  }
  return false;
}

/** Check if a PR's title or body names the task id (word boundary match). */
export function titleBodyNamesTask(pr: PrMetadata, taskId: string): boolean {
  const text = `${pr.title} ${pr.body ?? ""}`.toLowerCase();
  const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const task = taskId.toLowerCase();
  // Word boundary: must be preceded and followed by non-word-like chars (not letters, digits, or hyphens)
  // This prevents "feat-login" from matching "feat-login-fix"
  const boundary = "(?<![a-z0-9-])"; // negative lookbehind: not preceded by word char or hyphen
  const endBoundary = "(?![a-z0-9-])"; // negative lookahead: not followed by word char or hyphen
  const variants = [task, task.replace(/-/g, "_"), task.replace(/_/g, "-")];
  for (const v of variants) {
    if (new RegExp(`${boundary}${escaped(v)}${endBoundary}`).test(text)) return true;
  }
  return false;
}

/** Check if a PR belongs to a task. */
export function checkPrOwnership(
  pr: PrMetadata,
  taskId: string,
  taskAgent: string | null,
  authorMapping: AuthorMapping | null,
): OwnershipResult {
  if (branchContainsTask(pr.headBranch, taskId)) {
    return { owns: true, reason: null, method: "branch_contains_task" };
  }
  if (branchMatchesAgent(pr.headBranch, taskAgent, authorMapping)) {
    return { owns: true, reason: null, method: "branch_agent_match" };
  }
  if (titleBodyNamesTask(pr, taskId)) {
    return { owns: true, reason: null, method: "title_body_match" };
  }
  const reasons = [`branch '${pr.headBranch}' does not contain task id '${taskId}'`];
  if (taskAgent && authorMapping) reasons.push(`branch does not map to agent '${taskAgent}'`);
  reasons.push(`title/body does not name task '${taskId}'`);
  return { owns: false, reason: reasons.join("; "), method: "none" };
}

/** Reads one PR (the review host's getPullRequest). */
export interface PrReader {
  getPullRequest(n: number): Promise<{ number: number; title: string; body?: string | null; headRef: string; state: "open" | "closed" | "merged" }>;
}

/** What Lair reads PRs with, and the project's review.authors mapping. */
export interface PrSource {
  reader: PrReader | null;
  mapping: AuthorMapping | null;
  /** Why there is no reader (shown in an unsure note) */
  missing: string | null;
}

/** One PR read may take this long; then it fails (a timeout is unsure, never owned). */
export const PR_READ_TIMEOUT_MS = 15_000;
/** At most this many PRs of one reason are read. */
export const MAX_PRS_PER_REASON = 5;

/** The project's PR source: its review block's host and authors mapping, or no reader when it has none. */
export function prSourceFromConfig(config: ProjectConfig): PrSource {
  if (config.review === undefined) return { reader: null, mapping: null, missing: "the project has no review block" };
  const parsed = parseReviewConfig(config.review, config);
  if (!parsed.ok) return { reader: null, mapping: null, missing: "the project's review block is not valid" };
  const s = parsed.settings;
  const token = tokenFrom(s.tokenEnv, s.tokenCmd);
  return {
    reader: new GitHubHost({ repo: s.repo, apiUrl: s.apiUrl, token, timeoutMs: PR_READ_TIMEOUT_MS }),
    mapping: { branchPattern: s.authors.branchPattern, branches: s.authors.branches, fromTasksFile: false },
    missing: null,
  };
}

/** A finish proposal's PR ownership: none (its reason names no merged PR), owned, not_owned or unsure. */
export interface FinishOwnership {
  state: "none" | "owned" | "not_owned" | "unsure";
  note: string | null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);

/**
 * Check every PR a finish proposal's reason names as merged. Any PR of
 * another task: not_owned; any PR that cannot be read: unsure; all owned:
 * owned (the note names the route that matched).
 */
export async function checkFinishOwnership(input: {
  reason: string;
  task: string;
  agent: string | null;
  source: PrSource;
  timeoutMs?: number;
}): Promise<FinishOwnership> {
  const prs = extractPrNumbers(input.reason).slice(0, MAX_PRS_PER_REASON);
  if (prs.length === 0) return { state: "none", note: null };
  const owned: string[] = [];
  const notOwned: string[] = [];
  const unsure: string[] = [];
  for (const { number } of prs) {
    const reader = input.source.reader;
    if (!reader) {
      unsure.push(`PR #${number} could not be read (${input.source.missing ?? "no PR host"}), so its ownership is unknown`);
      continue;
    }
    let pr: Awaited<ReturnType<PrReader["getPullRequest"]>>;
    try {
      pr = await withTimeout(reader.getPullRequest(number), input.timeoutMs ?? PR_READ_TIMEOUT_MS);
    } catch (e) {
      unsure.push(`PR #${number} could not be read (${errorText(e)}), so its ownership is unknown`);
      continue;
    }
    const result = checkPrOwnership(
      { number, headBranch: pr.headRef, title: pr.title, body: pr.body ?? null, state: pr.state },
      input.task,
      input.agent,
      input.source.mapping,
    );
    if (result.owns) owned.push(`PR #${number} belongs to task ${input.task} (${result.method})`);
    else notOwned.push(`PR #${number} does not belong to task ${input.task}: ${result.reason}`);
  }
  if (notOwned.length > 0) return { state: "not_owned", note: [...notOwned, ...unsure].join("; ") };
  if (unsure.length > 0) return { state: "unsure", note: unsure.join("; ") };
  return { state: "owned", note: owned.join("; ") };
}
