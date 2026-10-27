/**
 * The Planner view's requests. Every read but the status shows plan or task
 * text, so it is the owner's too: reads and actions carry this browser's
 * owner session (owner-session.ts). Actions ask first and send
 * `confirm: true`; the server refuses them without it.
 */
import { fetchApi, ownerHeaders } from "./owner-session";
import type { ChangeView, PlannerOverviewView, PlannerRunView, ProposalView } from "../shared/planner-types";

const withProject = (path: string, project: string) => `${path}?project=${encodeURIComponent(project)}`;

export interface PlannerAction {
  question: string;
  url: string;
  body: Record<string, unknown>;
}

export function overviewUrl(project: string): string {
  return withProject("/api/planner/overview", project);
}

export function getOverview(project: string): Promise<PlannerOverviewView> {
  return fetchApi<PlannerOverviewView>(overviewUrl(project), { headers: ownerHeaders() });
}

export function getProposals(project: string, status?: string): Promise<ProposalView[]> {
  const url = `${withProject("/api/planner/proposals", project)}${status ? `&status=${encodeURIComponent(status)}` : ""}&limit=200`;
  return fetchApi<ProposalView[]>(url, { headers: ownerHeaders() });
}

export function getRuns(project: string): Promise<PlannerRunView[]> {
  return fetchApi<PlannerRunView[]>(`${withProject("/api/planner/runs", project)}&limit=30`, { headers: ownerHeaders() });
}

export function getHistory(project: string): Promise<ChangeView[]> {
  return fetchApi<ChangeView[]>(`${withProject("/api/planner/history", project)}&limit=100`, { headers: ownerHeaders() });
}

export function proposalAction(project: string, proposal: ProposalView, action: "approve" | "reject"): PlannerAction {
  const what = `${proposal.op} ${proposal.task}${proposal.agent ? ` (${proposal.agent})` : ""}`;
  return {
    question:
      action === "approve"
        ? `Apply "${what}" to the tasks file? Lair checks it against the file as it is now first.`
        : `Reject "${what}"? Nothing changes in the tasks file.`,
    url: withProject(`/api/planner/proposals/${encodeURIComponent(proposal.id)}/${action}`, project),
    body: { confirm: true },
  };
}

export function runAction(project: string, runId: string, pending: number, action: "approve" | "reject"): PlannerAction {
  return {
    question:
      action === "approve"
        ? `Apply all ${pending} waiting proposal(s) of this planner run? Each is checked against the tasks file as it is now.`
        : `Reject all ${pending} waiting proposal(s) of this planner run?`,
    url: withProject(`/api/planner/runs/${encodeURIComponent(runId)}/${action}`, project),
    body: { confirm: true },
  };
}

export function resumeAction(project: string): PlannerAction {
  return {
    question: "Resume planner runs? The next trigger starts one.",
    url: withProject("/api/planner/resume", project),
    body: { confirm: true },
  };
}

/** POST an owner action; resolves with the server's error, or null. */
export async function send(action: { url: string; body: Record<string, unknown> }): Promise<string | null> {
  try {
    const res = await fetch(action.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders() },
      body: JSON.stringify(action.body),
    });
    const data = (await res.json()) as { success?: boolean; error?: string };
    return data.success === true ? null : `${data.error ?? "failed"} (HTTP ${res.status})`;
  } catch (e) {
    return e instanceof Error ? e.message : "Network error";
  }
}

export function checkNowAction(project: string): { url: string; body: Record<string, unknown> } {
  return { url: withProject("/api/planner/check", project), body: {} };
}
