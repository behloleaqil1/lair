/**
 * PR ownership checks for the planner verifier (issue #290): when a finish
 * proposal names a PR, verify that the PR belongs to the task.
 *
 * A PR belongs to a task when:
 * 1. Its head branch names the task id (e.g., kiro/kiro-A/feat-login contains "feat-login")
 * 2. Its head branch maps to the task's agent per review.authors config
 * 3. Its title or body names the task id
 */

import type { AuthorMapping } from "../review/authors.js";
import { globMatches } from "../review/authors.js";

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
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "/");
  const branchParts = norm(branch).split("/");
  const taskParts = norm(taskId).split("/");
  for (let i = 0; i <= branchParts.length - taskParts.length; i++) {
    if (taskParts.every((t, j) => branchParts[i + j] === t)) return true;
  }
  return norm(branch).endsWith(norm(taskId));
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
  const variants = [taskId, taskId.replace(/-/g, "_"), taskId.replace(/_/g, "-")];
  for (const v of variants) {
    if (new RegExp(`\\b${escaped(v.toLowerCase())}\\b`).test(text)) return true;
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
