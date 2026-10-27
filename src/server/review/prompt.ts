/**
 * A reviewer agent's prompt: review.prompt_file, a file directly in the
 * project's prompts_dir (read by agents/prompts.ts: one plain file name, a
 * regular file or a symlink to one in that directory, at most 200 KB), used
 * verbatim except for these placeholders, each replaced once, in one pass (a
 * value is never scanned again):
 *
 *   {pr} {head} {repo} {tier} {base} {url} {findings_format}
 *
 * Every value is checked first (a PR number, a full sha, owner/name, a tier,
 * a plain branch name, an http(s) URL), so nothing a PR's author controls
 * beyond those shapes reaches the reviewer's prompt. The assignment token is
 * never in it: it goes to the run's environment (LAIR_REVIEW_TOKEN).
 */
import { readPromptFile, PromptFileError } from "../agents/prompts.js";
import type { Tier } from "../../shared/review-types.js";
import { isSafeBranchName } from "./authors.js";

/** What {findings_format} is replaced with: how `lair review submit --findings-file` reads findings. */
export const FINDINGS_FORMAT = [
  "One finding per line: `path:line: severity: text`, where severity is critical, high, medium, low or info",
  "(for example `src/app.ts:42: high: the token is logged`). With --verdict request_changes every finding blocks;",
  "with --verdict approve none may.",
].join(" ");

export interface PromptValues {
  pr: number;
  head: string;
  repo: string;
  tier: Tier;
  base: string;
  url: string | null;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PLACEHOLDER = /\{(pr|head|repo|tier|base|url|findings_format)\}/g;

/** Why a value can't go into a prompt, or null. */
export function invalidValue(values: PromptValues): string | null {
  if (!Number.isSafeInteger(values.pr) || values.pr < 1) return `the PR number ${values.pr} is not a positive integer`;
  if (!FULL_SHA.test(values.head)) return "the head is not a full commit sha";
  if (!REPO.test(values.repo) || values.repo.includes("..")) return `the repository ${values.repo} is not owner/name`;
  if (!["red", "amber", "green"].includes(values.tier)) return `${values.tier} is not a tier`;
  if (!isSafeBranchName(values.base)) return "the base branch name has characters a plain branch name doesn't";
  if (values.url !== null) {
    let url: URL;
    try {
      url = new URL(values.url);
    } catch {
      return "the PR URL is not a URL";
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || /[\s<>"`{}]/.test(values.url) || values.url.length > 500) {
      return "the PR URL is not a plain http(s) URL";
    }
  }
  return null;
}

/** The template with the placeholders filled in. */
export function fillTemplate(template: string, values: PromptValues): string {
  const text: Record<string, string> = {
    pr: String(values.pr),
    head: values.head,
    repo: values.repo,
    tier: values.tier,
    base: values.base,
    url: values.url ?? "(no URL)",
    findings_format: FINDINGS_FORMAT,
  };
  return template.replace(PLACEHOLDER, (_match, name: string) => text[name]);
}

/** The reviewer's prompt from `file` in `promptsDir`, or why it can't be built. */
export function buildReviewPrompt(
  promptsDir: string,
  file: string,
  values: PromptValues,
): { ok: true; prompt: string } | { ok: false; reason: string } {
  const invalid = invalidValue(values);
  if (invalid) return { ok: false, reason: `refused: ${invalid}` };
  let template: string;
  try {
    template = readPromptFile(promptsDir, file).text;
  } catch (e) {
    const why = e instanceof PromptFileError ? e.message : e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `review.prompt_file ${file}: ${why}` };
  }
  const prompt = fillTemplate(template, values);
  if (prompt.trim().length === 0) return { ok: false, reason: `review.prompt_file ${file} is empty` };
  return { ok: true, prompt };
}
