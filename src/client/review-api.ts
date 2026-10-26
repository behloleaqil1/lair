/**
 * Review requests from the dashboard. The owner-only ones (a human review,
 * resolving a finding, releasing a hold, merging) carry this browser's owner
 * session (owner-session.ts); without one the server answers 403.
 */
import type {
  MergeHold,
  MergeResponse,
  PrReviewStatus,
  ReviewFinding,
  ReviewRecord,
} from "../shared/review-types";
import { fetchApi, ownerHeaders } from "./owner-session";
import type { DraftFinding } from "./review-view";

function query(project: string): string {
  return `?project=${encodeURIComponent(project)}`;
}

function post(body: unknown, owner: boolean): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(owner ? ownerHeaders() : {}) },
    body: JSON.stringify(body),
  };
}

export function prStatus(project: string, pr: number): Promise<PrReviewStatus> {
  return fetchApi<PrReviewStatus>(`/api/review/prs/${pr}${query(project)}`);
}

export interface OwnerReviewDraft {
  reviewer: string;
  headSha: string;
  verdict: "approve" | "request_changes";
  summary: string;
  findings: DraftFinding[];
}

/** The owner's own review, bound to `headSha`. */
export function submitOwnerReview(
  project: string,
  pr: number,
  draft: OwnerReviewDraft,
): Promise<{ review: ReviewRecord; stale: boolean }> {
  return fetchApi<{ review: ReviewRecord; stale: boolean }>(
    `/api/review/prs/${pr}/owner-review${query(project)}`,
    post(
      {
        reviewer: draft.reviewer,
        head_sha: draft.headSha,
        verdict: draft.verdict,
        summary: draft.summary,
        findings: draft.findings,
      },
      true,
    ),
  );
}

export function resolveFinding(
  project: string,
  id: string,
  resolution: { by: string; note: string; status?: "resolved" | "dismissed" },
): Promise<ReviewFinding> {
  return fetchApi<ReviewFinding>(
    `/api/review/findings/${encodeURIComponent(id)}/resolve${query(project)}`,
    post({ by: resolution.by, note: resolution.note, status: resolution.status ?? "resolved" }, true),
  );
}

export function releaseHold(project: string, id: string, by: string): Promise<MergeHold> {
  return fetchApi<MergeHold>(`/api/review/holds/${encodeURIComponent(id)}/release${query(project)}`, post({ by }, true));
}

/** Merge at the head the owner confirmed; a refusal throws with every failed condition. */
export function mergePr(project: string, pr: number, headSha: string, by: string): Promise<MergeResponse> {
  return fetchApi<MergeResponse>(`/api/review/prs/${pr}/merge${query(project)}`, post({ confirm: true, head_sha: headSha, by }, true));
}

/** Ask the assigner and the Decision Inbox for the missing reviews (no owner session needed). */
export function requestReviews(project: string, pr: number): Promise<{ slot: string; channel: string; detail: string }[]> {
  return fetchApi<{ slot: string; channel: string; detail: string }[]>(`/api/review/prs/${pr}/request-reviews${query(project)}`, post({}, false));
}
