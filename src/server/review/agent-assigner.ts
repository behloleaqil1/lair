/**
 * Reviews by agents (docs/configuration.md#reviews-by-agents): a
 * ReviewAssigner that has a PR's review done by an agent the agents module
 * supervises, so a PR doesn't wait on a human reviewer. It is on for a
 * project that sets review.prompt_file (and agents.enabled); self-checks, and
 * projects without it, go to the default assigner.
 *
 * For a requested slot of kind `agent:<id>` (that agent) or `peer` (any agent
 * but the author) it picks a reviewer that is:
 * - in the slot's `pool`, else review.reviewers_pool.<tier> (a named slot: that agent), and not the author;
 * - with `different_model`, on a model other than the author's in every
 *   profile it can run with, fallbacks included, so a failover can't land on it;
 * - free in the agents module (no active run, not over budget), not reviewing
 *   this PR already, and not one that already reviewed this head.
 * It starts the run in-process (AgentRuns.requestRun) with task id
 * `review-<pr>-<head8>` (`-<n>` added for the n-th slot of a tier with
 * several) and the prompt built from review.prompt_file (prompt.ts). The
 * assignment token goes to the run's environment only, as LAIR_REVIEW_TOKEN:
 * a module run variable the agents module keeps in memory, never in the
 * prompt, the store or a log. The reviewer posts its review with
 * `lair review submit` (src/cli/review-submit.ts).
 *
 * One record per slot and head (review_agent_assignments), and at most one
 * run per slot at a time. check() follows them, every 15 s:
 * - the request's token was used: reviewed;
 * - the PR moved to another head, or closed: stale, nothing more is started;
 * - the run's chain ended without a review (it exited without submitting, was
 *   escalated, or its variables were lost in a restart): retried with a new
 *   token (the old one stops working) after retries.backoff_seconds, doubling,
 *   by an agent not tried yet when there is one; after retries.max_attempts
 *   runs the owner is asked in the Decision Inbox and the slot is failed;
 * - requested and no reviewer free: tried again on the next check, without
 *   using up an attempt.
 * Everything is in the review store, so a restart carries on where it stopped.
 */
import type { ProjectConfig } from "../../shared/types.js";
import { backoffMs } from "../agents/config.js";
import { isActive } from "../agents/types.js";
import { getPromptsDir } from "../routes/controls.js";
import type { ReviewSettings } from "./config.js";
import type { Clock } from "./service.js";
import { buildReviewPrompt } from "./prompt.js";
import { hashToken, newAssignmentToken } from "./tokens.js";
import type { DecisionSink, ReviewAssigner, ReviewAssignment, ReviewerRuns } from "./ports.js";
import type { AgentAssignmentRecord, ReviewStore } from "./store.js";

/** How often check() runs, by default */
export const CHECK_INTERVAL_MS = 15_000;
/** The request channel of reviews by agents */
export const AGENTS_CHANNEL = "agents";

const short = (id: string) => id.slice(0, 8);
const iso = (ms: number) => new Date(ms).toISOString();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const oneLine = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

/** The agents module task of a slot's review: review-<pr>-<head8>, and -<n> for the n-th slot (n > 1). */
export function reviewTaskId(pr: number, headSha: string, slot: number): string {
  return `review-${pr}-${headSha.slice(0, 8)}${slot > 0 ? `-${slot + 1}` : ""}`;
}

export interface AgentReviewProject {
  config: ProjectConfig;
  settings: ReviewSettings;
}

export interface AgentReviewAssignerOptions {
  agents: ReviewerRuns;
  store: ReviewStore;
  clock: Clock;
  /** Where a slot no agent could review goes */
  decisions: DecisionSink;
  /** For what this assigner doesn't take: self-checks, and projects without review.prompt_file */
  fallback: ReviewAssigner;
  /** The server's URL, given to reviewer runs as LAIR_URL (where `lair review submit` posts) */
  serverUrl?: string;
  /** The PR's state and head now, from the git host (before a retry starts a run); null when it can't say */
  pullRequest: (project: string, pr: number) => Promise<{ state: string; headSha: string } | null>;
}

type AssignResult = Awaited<ReturnType<ReviewAssigner["assign"]>>;

interface Candidate {
  id: string;
  model: string | null;
}

export class AgentReviewAssigner implements ReviewAssigner {
  private projects = new Map<string, AgentReviewProject>();
  private queue: Promise<unknown> = Promise.resolve();
  private checking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  lastError: string | null = null;

  constructor(private readonly o: AgentReviewAssignerOptions) {}

  addProject(name: string, project: AgentReviewProject): void {
    this.projects.set(name, project);
  }

  /** Reviews by agents are on for the project (review.prompt_file). */
  handles(project: string): boolean {
    return Boolean(this.projects.get(project)?.settings.agentReviews.promptFile);
  }

  /** Assignments and checks run one at a time, so two of them never start runs for one slot. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  assign(a: ReviewAssignment): Promise<AssignResult> {
    if (!this.handles(a.project) || a.role !== "review") return this.o.fallback.assign(a);
    return this.exclusive(() => this.assignNow(a));
  }

  /** Follow every open assignment once. Concurrent calls share the check in progress; it never rejects. */
  check(): Promise<void> {
    if (!this.checking) {
      this.checking = this.exclusive(() => this.checkNow())
        .catch((e) => {
          this.lastError = message(e);
        })
        .finally(() => {
          this.checking = null;
        });
    }
    return this.checking;
  }

  /** Check soon, then every `intervalMs`, until stop(). */
  start(intervalMs = CHECK_INTERVAL_MS): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      await this.check();
      if (this.stopped) return;
      this.timer = setTimeout(loop, intervalMs);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, Math.min(1000, intervalMs));
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.o.clock.now();
  }

  private save(record: AgentAssignmentRecord): void {
    record.updatedAt = iso(this.now());
    this.o.store.saveAgentAssignment(record);
  }

  private async assignNow(a: ReviewAssignment): Promise<AssignResult> {
    const existing = this.o.store.getAgentAssignment(a.project, a.pr, a.headSha, a.slot);
    if (existing && (existing.state === "requested" || existing.state === "assigned")) {
      // One run per slot: this one is being taken care of
      return { assigned: false, agent: null, detail: `already ${existing.state}: ${existing.detail}`, channel: AGENTS_CHANNEL };
    }
    const now = this.now();
    const record: AgentAssignmentRecord = {
      project: a.project,
      pr: a.pr,
      headSha: a.headSha,
      slot: a.slot,
      state: "requested",
      agent: null,
      runId: null,
      chainId: null,
      attempts: 0,
      notBefore: now,
      detail: "requested",
      spec: {
        tier: a.tier,
        reviewer: a.reviewer,
        exclude: a.exclude,
        author: a.author,
        pool: a.pool,
        differentModel: a.differentModel,
        authorModel: a.differentModelFrom,
        repo: a.repo,
        base: a.base,
        url: a.url,
        label: a.reason,
        tried: [],
      },
      updatedAt: iso(now),
    };
    // The service records this token's hash with the agent picked here
    const outcome = await this.start(record, a.token, false);
    this.save(record);
    return outcome;
  }

  private variables(project: string, token: string): Record<string, string> {
    return {
      LAIR_REVIEW_TOKEN: token,
      LAIR_REVIEW_PROJECT: project,
      ...(this.o.serverUrl ? { LAIR_URL: this.o.serverUrl } : {}),
    };
  }

  /**
   * Pick a reviewer and start its run with `token`. `reissue`: the request
   * record gets this token's hash and the agent (a retry, or a run started
   * after none was free); otherwise the caller records them.
   */
  private async start(record: AgentAssignmentRecord, token: string, reissue: boolean): Promise<AssignResult> {
    const fail = (detail: string): AssignResult => {
      record.state = "failed";
      record.agent = null;
      record.detail = detail;
      return { assigned: false, agent: null, detail, channel: AGENTS_CHANNEL };
    };
    const project = this.projects.get(record.project);
    if (!project?.settings.agentReviews.promptFile) return fail("reviews by agents are off for the project");
    const settings = project.settings.agentReviews;
    const pick = this.candidates(record);
    if ("blocked" in pick) return fail(pick.blocked);
    const spec = record.spec;
    const prompt = buildReviewPrompt(getPromptsDir(project.config), settings.promptFile!, {
      pr: record.pr,
      head: record.headSha,
      repo: spec.repo,
      tier: spec.tier,
      base: spec.base,
      url: spec.url,
    });
    if (!prompt.ok) return fail(prompt.reason);

    const refused = [...pick.waiting];
    for (const candidate of pick.free) {
      if (reissue) {
        const bound = this.o.store.reissueRequest(record.project, record.pr, record.headSha, record.slot, {
          reviewer: candidate.id,
          tokenHash: hashToken(token),
          model: candidate.model,
          detail: `${candidate.id}: reviews by agents`,
        });
        if (!bound) {
          const request = this.o.store.getRequest(record.project, record.pr, record.headSha, record.slot);
          if (request?.usedBy) {
            record.state = "reviewed";
            record.detail = `reviewed by ${request.usedBy}`;
            return { assigned: false, agent: request.usedBy, detail: record.detail, channel: AGENTS_CHANNEL };
          }
          return fail("its review request is gone");
        }
      }
      try {
        const run = await this.o.agents.requestRun(record.project, {
          agent: candidate.id,
          task: reviewTaskId(record.pr, record.headSha, record.slot),
          prompt: prompt.prompt,
          variables: this.variables(record.project, token),
        });
        record.state = "assigned";
        record.agent = candidate.id;
        record.runId = run.id;
        record.chainId = run.chainId;
        record.attempts++;
        record.detail = `run ${short(run.id)} (attempt ${record.attempts} of ${settings.maxAttempts})`;
        return { assigned: true, agent: candidate.id, detail: record.detail, model: candidate.model, channel: AGENTS_CHANNEL };
      } catch (e) {
        refused.push(`${candidate.id}: ${oneLine(message(e))}`);
      }
    }
    record.state = "requested";
    record.agent = null;
    record.runId = null;
    record.chainId = null;
    record.notBefore = this.now();
    record.detail = `waiting for a free reviewer (${refused.join("; ")})`;
    return { assigned: false, agent: null, detail: record.detail, channel: AGENTS_CHANNEL };
  }

  /**
   * The agents that may take the slot now (`free`, not-yet-tried ones first),
   * and why the others don't; `blocked` when none ever can as configured.
   */
  private candidates(record: AgentAssignmentRecord): { free: Candidate[]; waiting: string[] } | { blocked: string } {
    const spec = record.spec;
    const status = this.o.agents.status(record.project);
    if (!status.enabled) return { blocked: `the agents module is off for ${record.project} (agents.enabled)` };
    if (!spec.reviewer && !spec.author) {
      return {
        blocked:
          "the PR's author is unknown, so no agent can be told apart from it: map it (review.authors.branches, " +
          "review.authors.from_tasks_file or review.authors.branch_pattern)",
      };
    }
    if (spec.differentModel && !spec.authorModel) {
      return { blocked: "the slot needs a model other than the author's, and the author's model is unknown" };
    }
    const pool = spec.reviewer ? [spec.reviewer] : (spec.pool ?? []);
    if (pool.length === 0) return { blocked: `no reviewer pool: set review.reviewers_pool.${spec.tier} or the slot's pool` };

    const views = new Map(status.agents.map((view) => [view.id, view]));
    const busy = this.o.agents.managedRuns(record.project);
    const reviewing = new Set(this.o.store.agentsReviewing(record.project, record.pr));
    const reviewedHere = new Set(
      this.o.store
        .listReviews(record.project, record.pr)
        .filter((r) => r.headSha === record.headSha && r.reviewer.kind === "agent")
        .map((r) => r.reviewer.id),
    );
    const free: Candidate[] = [];
    const waiting: string[] = [];
    const never: string[] = [];
    for (const id of pool) {
      const view = views.get(id);
      if (id === spec.author || spec.exclude.includes(id)) {
        never.push(`${id}: the PR's author`);
        continue;
      }
      if (!view) {
        never.push(`${id}: not an agent of this project`);
        continue;
      }
      const models = view.profiles.map((p) => p.model ?? null);
      if (spec.differentModel) {
        if (models.length === 0 || models.includes(null)) {
          never.push(`${id}: the model of one of its profiles is unknown`);
          continue;
        }
        if (models.includes(spec.authorModel)) {
          never.push(`${id}: can run on the author's model ${spec.authorModel}`);
          continue;
        }
      }
      if (reviewedHere.has(id)) {
        never.push(`${id}: already reviewed this head`);
        continue;
      }
      if (reviewing.has(id)) {
        waiting.push(`${id}: already reviewing this PR`);
        continue;
      }
      if (busy.has(id)) {
        waiting.push(`${id}: busy (${oneLine(view.detail, 100)})`);
        continue;
      }
      if (view.state === "over_budget") {
        waiting.push(`${id}: over budget`);
        continue;
      }
      free.push({ id, model: models[0] ?? null });
    }
    if (free.length === 0 && waiting.length === 0) return { blocked: `no agent can review it: ${never.join("; ")}` };
    // Stable: pool order, with the agents whose runs already ended without a review last
    free.sort((a, b) => Number(spec.tried.includes(a.id)) - Number(spec.tried.includes(b.id)));
    return { free, waiting: [...waiting, ...never] };
  }

  private async checkNow(): Promise<void> {
    for (const record of this.o.store.openAgentAssignments()) {
      try {
        await this.follow(record);
      } catch (e) {
        this.lastError = `${record.project} #${record.pr}: ${message(e)}`;
      }
    }
  }

  private stale(record: AgentAssignmentRecord, why: string): void {
    record.state = "stale";
    record.detail = `${why}: nothing more is started for ${record.headSha.slice(0, 7)}`;
    this.save(record);
  }

  private async follow(record: AgentAssignmentRecord): Promise<void> {
    const project = this.projects.get(record.project);
    if (!project?.settings.agentReviews.promptFile) return; // turned off: left as it was
    const settings = project.settings.agentReviews;
    const now = this.now();

    const request = this.o.store.getRequest(record.project, record.pr, record.headSha, record.slot);
    if (request?.usedBy) {
      record.state = "reviewed";
      record.agent = request.usedBy;
      record.detail = `reviewed by ${request.usedBy}`;
      return this.save(record);
    }
    if (!request) {
      record.state = "failed";
      record.detail = "its review request is gone";
      return this.save(record);
    }
    const seen = this.o.store.currentHead(record.project, record.pr);
    if (seen && seen !== record.headSha) return this.stale(record, `the PR moved to ${seen.slice(0, 7)}`);

    if (record.state === "assigned") {
      const chain = record.chainId ? (this.o.agents.getStore()?.chainRuns(record.chainId) ?? []) : [];
      if (chain.some((run) => isActive(run.state))) return; // still reviewing
      const last = chain[chain.length - 1];
      const ended = last ? `run ${short(last.id)} ended ${last.state} (${oneLine(last.detail)})` : "run is gone";
      const agent = record.agent ?? "the reviewer";
      if (record.agent) record.spec.tried.push(record.agent);
      if (record.attempts >= settings.maxAttempts) return this.giveUp(record, `${agent}'s ${ended}`);
      record.state = "requested";
      record.notBefore = now + backoffMs(record.attempts, settings.backoffSeconds, settings.maxBackoffSeconds);
      record.detail = `${agent}'s ${ended} without a review: attempt ${record.attempts + 1} of ${settings.maxAttempts} at ${iso(record.notBefore)}`;
      record.agent = null;
      record.runId = null;
      record.chainId = null;
      return this.save(record);
    }

    // requested: start a run once its time has come and the PR is still open at this head
    if (record.notBefore > now) return;
    const pr = await this.o.pullRequest(record.project, record.pr);
    if (!pr) {
      record.detail = "the git host didn't say whether the PR is still open: trying again";
      return this.save(record);
    }
    if (pr.state !== "open") return this.stale(record, `the PR is ${pr.state}`);
    if (pr.headSha !== record.headSha) return this.stale(record, `the PR moved to ${pr.headSha.slice(0, 7)}`);
    await this.start(record, newAssignmentToken(), true);
    this.save(record);
  }

  /** The last attempt ended without a review: the slot fails and the owner is asked. */
  private async giveUp(record: AgentAssignmentRecord, last: string): Promise<void> {
    const spec = record.spec;
    record.state = "failed";
    record.agent = null;
    record.runId = null;
    record.chainId = null;
    record.detail = `no review after ${record.attempts} run(s); the last: ${last}`;
    try {
      const raised = await this.o.decisions.raise({
        project: record.project,
        question: `No agent reviewed PR #${record.pr} at ${record.headSha.slice(0, 7)} after ${record.attempts} run(s)`,
        context: [
          `${spec.label}.`,
          "",
          `Reviewers tried: ${spec.tried.join(", ") || "none"}.`,
          `The last: ${last}.`,
          "",
          "Review it in Lair's Reviews view, or request the missing reviews there to start agent reviews again.",
        ].join("\n"),
        options: ["Review it yourself", "Request agent reviews again"],
        recommended: "Review it yourself",
        why: `Every reviewer run ended without a review, and the ${spec.tier} tier needs one before it can merge.`,
        kind: "escalation",
        reversible: true,
        requestedBy: "review",
        links: spec.url ? [{ label: `PR #${record.pr}`, url: spec.url }] : [],
      });
      record.detail = `${record.detail}; the owner was asked (${raised.channel})`;
    } catch (e) {
      record.detail = `${record.detail}; the Decision Inbox refused it (${oneLine(message(e))})`;
    }
    this.save(record);
  }
}
