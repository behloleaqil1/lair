/**
 * Reviews and policy merge for one project (docs/design/autonomy.md §5):
 * evaluates a PR (risk tier, required reviews at the head, findings, the gate
 * at the head, mergeability, holds), records reviews, asks for missing
 * reviewers, and merges only when the policy allows it.
 *
 * ReviewManager holds one ReviewService per project with `review.enabled`.
 */
import { resolve } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type {
  ClientInfo,
  FindingSeverity,
  MergeResponse,
  PrReviewStatus,
  PrSummary,
  ReviewerRef,
  ReviewFinding,
  ReviewMergeRecord,
  ReviewProjectInfo,
  ReviewRecord,
  MergeHold,
  SlotAssignmentView,
  SlotStatus,
  Tier,
  Verdict,
} from "../../shared/review-types.js";
import type { EventBus } from "../core/event-bus.js";
import { assessRisk } from "../policy/risk-rules.js";
import { matchSlots } from "../policy/reviewer-slots.js";
import { evaluateMergePolicy } from "../policy/merge-policy.js";
import { parseReviewConfig, type ReviewSettings } from "./config.js";
import { mapAuthor } from "./authors.js";
import { AGENTS_CHANNEL, AgentReviewAssigner, CHECK_INTERVAL_MS } from "./agent-assigner.js";
import { hashToken, newAssignmentToken } from "./tokens.js";
import { ACTIVE_STATES } from "../agents/types.js";
import { checkTestIntegrity, isTestFile, type IntegrityFile } from "./integrity.js";
import { GitHubHost, tokenFrom, type FetchLike, type TokenSource } from "./github.js";
import type { GitHost, HostFile, HostPullRequest, HostRepo } from "./host.js";
import { systemGit, type GitRunner } from "./git.js";
import { LocalMerger, mergeOnHost, planMerge, type MergeExecution } from "./executor.js";
import { ReviewStore, type AssignmentRecord, type StoredReview } from "./store.js";
import { hostChecksGate, signedGate, type GateSource } from "./gate-source.js";
import {
  eventBusAssigner,
  eventBusDecisionSink,
  unwiredAssigner,
  unwiredDecisionSink,
  type DecisionSink,
  type ReviewAssigner,
  type ReviewerRuns,
} from "./ports.js";
import type { SignedGateResult } from "../../shared/policy-types.js";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** The reviewer id Lair's test integrity check records its findings under. */
export const INTEGRITY_REVIEWER: ReviewerRef = { id: "lair:test-integrity", kind: "check" };

/** Test files whose full content is fetched per evaluation (the rest are checked from the diff). */
const MAX_CONTENT_FETCHES = 50;
const REPO_INFO_TTL_MS = 10 * 60_000;

/** An error with the HTTP status the routes answer with. */
export class ReviewError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

export interface ReviewInput {
  reviewer: ReviewerRef;
  headSha: string;
  verdict: Verdict;
  summary: string;
  findings: { severity: FindingSeverity; file: string | null; line: number | null; text: string; blocking: boolean }[];
}

export interface RequestOutcome {
  slot: string;
  channel: string;
  detail: string;
}

export interface ReviewServiceOptions {
  project: string;
  config: ProjectConfig;
  settings: ReviewSettings;
  store: ReviewStore;
  host: GitHost;
  git: GitRunner;
  clock: Clock;
  events?: EventBus;
  decisions: DecisionSink;
  assigner: ReviewAssigner;
  /**
   * The agents module's run chain a review by agents was started in: whether
   * a run of it is active now, its agent, and the model of the profile it
   * runs on. Null when the agents module doesn't know the chain.
   */
  reviewRun?: (chainId: string) => { active: boolean; agent: string; model: string | null } | null;
  /** `Authorization` header for https clones (local merges) */
  authHeader: () => Promise<string | null>;
  /** Relative work dirs resolve against this */
  cwd: string;
}

/** Who asked for the missing reviews: the owner (the route), or the review module's own scan of open PRs. */
export type RequestOrigin = "owner" | "auto";

/** An automatic round for a PR starts at most this often (a new head waits until then). */
export const AUTO_REQUEST_MIN_INTERVAL_MS = 5 * 60_000;

function short(sha: string): string {
  return sha.slice(0, 7);
}

export class ReviewService {
  readonly project: string;
  readonly settings: ReviewSettings;
  private readonly gateSource: GateSource;
  private repoInfo: { at: number; repo: HostRepo | null } | null = null;
  private integrityRuns = new Map<string, Promise<void>>();
  /** requestReviews in progress per PR: a second call shares it, so a slot is never asked for twice at once */
  private requesting = new Map<number, Promise<RequestOutcome[]>>();
  private merging = false;
  /** Set by drain() (a config reload): no merge starts here any more */
  private closing = false;
  /** Called when the merge in progress ends */
  private mergeWaiters: (() => void)[] = [];

  constructor(private readonly o: ReviewServiceOptions) {
    this.project = o.project;
    this.settings = o.settings;
    const gate = o.settings.merge.gate;
    this.gateSource =
      gate.source === "checks"
        ? hostChecksGate(o.host, gate.required, gate.statusCreators)
        : signedGate(o.store, o.project, gate);
  }

  get readOnly(): boolean {
    return this.o.config.read_only === true;
  }

  private now(): string {
    return new Date(this.o.clock.now()).toISOString();
  }

  private emit(type: Parameters<EventBus["emit"]>[0], data: Record<string, unknown>): void {
    void this.o.events?.emit(type, { project: this.project, ...data });
  }

  private async repo(): Promise<HostRepo | null> {
    const t = this.o.clock.now();
    if (this.repoInfo && t - this.repoInfo.at < REPO_INFO_TTL_MS) return this.repoInfo.repo;
    let repo: HostRepo | null;
    try {
      repo = await this.o.host.getRepo();
    } catch {
      repo = null;
    }
    this.repoInfo = { at: t, repo };
    return repo;
  }

  /** Fill in an agent's model from the config when the caller didn't give it. */
  private withModel(ref: ReviewerRef): ReviewerRef {
    if (ref.model || ref.kind !== "agent") return ref;
    const model = this.settings.authors.models[ref.id] ?? this.o.config.dragons?.[ref.id]?.model;
    return model ? { ...ref, model } : ref;
  }

  /**
   * The PR's author: the one Lair's modules registered, else what the branch
   * mappings agree on (authors.ts; agents that disagree leave it unknown).
   */
  private authorOf(pr: HostPullRequest): {
    author: ReviewerRef | null;
    source: PrReviewStatus["authorSource"];
    note: string | null;
  } {
    const stored = this.o.store.getAuthor(this.project, pr.number);
    if (stored) return { author: this.withModel(stored), source: "lair", note: null };
    const mapped = mapAuthor(this.settings.authors, pr.headRef, this.o.config);
    if (mapped.agent) {
      return { author: this.withModel({ id: mapped.agent, kind: "agent" }), source: mapped.source, note: mapped.note };
    }
    return { author: null, source: null, note: mapped.note };
  }

  /** The PR's state and head now, from the git host (recorded as the head seen), or null when it can't say. */
  async currentPullRequest(n: number): Promise<{ state: string; headSha: string } | null> {
    try {
      const pr = await this.o.host.getPullRequest(n);
      this.noteHead(pr);
      return { state: pr.state, headSha: pr.headSha };
    } catch {
      return null;
    }
  }

  /** Where each slot's request stands at `headSha`: reviews by agents, else the request record. */
  private assignmentViews(n: number, headSha: string, slots: SlotStatus[]): SlotAssignmentView[] {
    const rows = new Map(this.o.store.agentAssignments(this.project, n, headSha).map((r) => [r.slot, r]));
    const views: SlotAssignmentView[] = [];
    slots.forEach((_slot, index) => {
      const row = rows.get(index);
      if (row) {
        views.push({
          slot: index,
          state: row.state,
          channel: AGENTS_CHANNEL,
          agent: row.agent,
          runId: row.runId,
          attempts: row.attempts,
          maxAttempts: this.settings.agentReviews.maxAttempts,
          detail: row.detail,
          notBefore: row.state === "requested" ? new Date(row.notBefore).toISOString() : null,
          updatedAt: row.updatedAt,
        });
        return;
      }
      const request = this.o.store.getRequest(this.project, n, headSha, index);
      if (!request) return;
      views.push({
        slot: index,
        state: request.usedBy ? "reviewed" : "requested",
        channel: request.channel,
        agent: request.usedBy ?? request.reviewer,
        runId: null,
        attempts: 0,
        maxAttempts: null,
        detail: request.detail,
        notBefore: null,
        updatedAt: request.requestedAt,
      });
    });
    return views;
  }

  /** Record the head; a new one makes every review at an older head stale. */
  private noteHead(pr: HostPullRequest): void {
    const previous = this.o.store.observeHead(this.project, pr.number, pr.headSha, this.now());
    if (previous) {
      const stale = this.o.store
        .listReviews(this.project, pr.number)
        .filter((r) => r.headSha !== pr.headSha && r.reviewer.kind !== "check").length;
      this.emit("review.invalidated", { pr: pr.number, previousHead: previous, headSha: pr.headSha, staleReviews: stale });
    }
  }

  /** Reviews with `stale` (older head) and `superseded` (a later review by the same reviewer). */
  private annotate(stored: StoredReview[], headSha: string): ReviewRecord[] {
    const latest = new Map<string, number>();
    for (const r of stored) latest.set(r.reviewer.id, Math.max(latest.get(r.reviewer.id) ?? 0, r.seq));
    return stored.map((r) => {
      const superseded = (latest.get(r.reviewer.id) ?? r.seq) > r.seq;
      const findings: ReviewFinding[] = r.findings.map((f) => ({
        id: f.id,
        reviewId: f.reviewId,
        pr: f.pr,
        headSha: f.headSha,
        reviewer: f.reviewer,
        severity: f.severity,
        file: f.file,
        line: f.line,
        text: f.text,
        blocking: f.blocking,
        rule: f.rule,
        status: f.status,
        resolvedBy: f.resolvedBy,
        resolvedAt: f.resolvedAt,
        resolution: f.resolution,
        resolvedClient: f.resolvedClient,
        superseded,
      }));
      return {
        id: r.id,
        project: r.project,
        pr: r.pr,
        headSha: r.headSha,
        reviewer: r.reviewer,
        verdict: r.verdict,
        summary: r.summary,
        createdAt: r.createdAt,
        client: r.client,
        findings,
        stale: r.headSha !== headSha,
        superseded,
      };
    });
  }

  /** Run the test integrity check once per head and tier, recorded as a review by INTEGRITY_REVIEWER. */
  private async ensureIntegrity(pr: HostPullRequest, files: HostFile[], tier: Tier): Promise<void> {
    const settings = this.settings.integrity;
    if (!settings.enabled) return;
    const last = [...this.o.store.listReviews(this.project, pr.number)]
      .reverse()
      .find((r) => r.reviewer.id === INTEGRITY_REVIEWER.id);
    if (last && last.headSha === pr.headSha && last.context.tier === tier) return;

    const key = `${pr.number}:${pr.headSha}:${tier}`;
    const running = this.integrityRuns.get(key);
    if (running) return running;
    const run = (async () => {
      const options = {
        testFiles: settings.testFiles,
        productionImports: settings.productionImports,
        ignore: settings.ignore,
      };
      const inputs: IntegrityFile[] = [];
      let fetched = 0;
      for (const f of files) {
        let content: string | null = null;
        if (f.status !== "removed" && fetched < MAX_CONTENT_FETCHES && isTestFile(f.path, options)) {
          fetched++;
          try {
            content = await this.o.host.getFileContent(f.path, pr.headSha);
          } catch {
            content = null;
          }
        }
        inputs.push({ path: f.path, previousPath: f.previousPath, status: f.status, patch: f.patch, content });
      }
      const findings = checkTestIntegrity(inputs, options);
      // Heuristics: only high and critical findings block, and only in the blocking tiers
      const blockingTier = settings.blockingTiers.includes(tier);
      const blocks = (severity: string) => blockingTier && (severity === "high" || severity === "critical");
      const blockingCount = findings.filter((f) => blocks(f.severity)).length;
      this.o.store.addReview({
        project: this.project,
        pr: pr.number,
        headSha: pr.headSha,
        reviewer: INTEGRITY_REVIEWER,
        verdict: blockingCount > 0 ? "request_changes" : "approve",
        summary:
          findings.length === 0
            ? `No test integrity findings in ${files.length} changed file(s)`
            : `${findings.length} test integrity finding(s), ${blockingCount} blocking in the ${tier} tier`,
        context: { tier, files: files.length },
        findings: findings.map((f) => ({
          severity: f.severity,
          file: f.file,
          line: f.line,
          text: f.text,
          blocking: blocks(f.severity),
          rule: f.rule,
        })),
        client: null,
        at: this.now(),
      });
    })();
    this.integrityRuns.set(key, run);
    try {
      await run;
    } finally {
      this.integrityRuns.delete(key);
    }
  }

  private async defaultBranchRed(
    pr: HostPullRequest,
    defaultBranch: string | null,
    baseTip: string | null,
  ): Promise<string | null> {
    const merge = this.settings.merge;
    if (!merge.holdWhenDefaultRed || !defaultBranch) return null;
    let tip = pr.baseRef === defaultBranch ? baseTip : null;
    if (!tip) {
      try {
        tip = await this.o.host.branchHead(defaultBranch);
      } catch {
        return null;
      }
    }
    const failed = (await this.gateSource.checksAt(tip)).filter((c) => c.status === "failed");
    if (failed.length === 0) return null;
    const red = `the default branch ${defaultBranch} is red at ${short(tip)} (${failed.map((c) => c.name).join(", ")} failed)`;

    const exempt = merge.holdExemptLabels.map((l) => l.toLowerCase());
    const label = pr.labels.find((l) => exempt.includes(l.toLowerCase()));
    if (exempt.length === 0) return `${red}: nothing merges until it is green`;
    if (!label) return `${red}: only a revert labelled ${merge.holdExemptLabels.join(" or ")} may merge`;
    // A label is easy to add: the PR must also be a revert
    const notRevert = await this.notARevert(pr);
    return notRevert ? `${red}: the ${label} label doesn't apply, ${notRevert}` : null;
  }

  /**
   * Why the PR is not a plain revert, or null when it is: its title starts
   * with `Revert "` and every commit says `This reverts commit <sha>`.
   */
  private async notARevert(pr: HostPullRequest): Promise<string | null> {
    if (!/^Revert "/.test(pr.title)) return 'its title does not start with Revert "';
    const commits = await this.o.host.listCommits(pr.number);
    if (commits.length === 0) return "it has no commits";
    const plain = commits.find((c) => !/This reverts commit [0-9a-f]{40}/.test(c.message));
    return plain ? `commit ${short(plain.sha)} does not say which commit it reverts` : null;
  }

  /** Evaluate a PR: everything the merge policy looks at, and its verdict. */
  async status(n: number): Promise<PrReviewStatus> {
    const host = this.o.host;
    const pr = await host.getPullRequest(n);
    this.noteHead(pr);
    const repo = await this.repo();
    const defaultBranch = this.settings.defaultBranch ?? repo?.defaultBranch ?? null;

    const files = await host.listFiles(n);
    const risk = assessRisk(
      {
        files: files.map((f) => ({
          path: f.path,
          previousPath: f.previousPath,
          additions: f.additions,
          deletions: f.deletions,
        })),
        labels: pr.labels,
      },
      this.settings.tiers.rules,
      this.settings.tiers.fileKinds,
      this.settings.tiers.default,
    );
    if (pr.state === "open") await this.ensureIntegrity(pr, files, risk.tier);

    const { author, source, note } = this.authorOf(pr);
    const reviews = this.annotate(this.o.store.listReviews(this.project, n), pr.headSha);
    const findings = reviews.flatMap((r) => r.findings);
    const openBlocking = findings.filter((f) => f.status === "open" && f.blocking && !f.superseded);
    const current = reviews.filter((r) => !r.stale && !r.superseded && r.reviewer.kind !== "check");
    const slots = matchSlots(
      this.settings.reviewers[risk.tier],
      reviews
        .filter((r) => r.reviewer.kind !== "check")
        .map((r) => ({
          id: r.id,
          reviewer: r.reviewer,
          verdict: r.verdict,
          headSha: r.headSha,
          superseded: r.superseded,
        })),
      author,
      pr.headSha,
    );

    const gate = await this.gateSource.checksAt(pr.headSha);
    let baseTip: string | null = null;
    let behindBy: number | null = null;
    try {
      baseTip = await host.branchHead(pr.baseRef);
      behindBy = (await host.compare(baseTip, pr.headSha)).behindBy;
    } catch {
      behindBy = null;
    }
    const holds = this.o.store.activeHolds(this.project, n);
    const red = await this.defaultBranchRed(pr, defaultBranch, baseTip);

    const policy = evaluateMergePolicy({
      pr: {
        state: pr.state,
        draft: pr.draft,
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        mergeable: pr.mergeable,
        behindBy,
      },
      defaultBranch,
      requireUpToDate: this.settings.merge.requireUpToDate,
      gate,
      slots,
      verdictsAtHead: current.map((r) => ({ reviewer: r.reviewer, verdict: r.verdict })),
      openBlocking,
      holds,
      defaultBranchRed: red,
    });

    const plan = planMerge(this.settings.merge);
    const reasons = [...policy.reasons];
    if (plan.refusal) reasons.push(`Merge method: ${plan.refusal}`);
    if (this.readOnly) reasons.push("Read-only: the project sets read_only: true, so Lair does not merge");
    const status: PrReviewStatus = {
      project: this.project,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      draft: pr.draft,
      headSha: pr.headSha,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      defaultBranch,
      author,
      authorSource: source,
      authorNote: note,
      labels: pr.labels,
      risk,
      slots,
      assignments: this.assignmentViews(n, pr.headSha, slots),
      reviews,
      findings,
      gate,
      holds,
      conditions: policy.conditions,
      hostUser: pr.user,
      canMerge: policy.allowed && !plan.refusal && !this.readOnly,
      reasons,
      plan,
      readOnly: this.readOnly,
      evaluatedAt: this.now(),
    };
    this.o.store.saveSummary(this.project, n, {
      headSha: pr.headSha,
      tier: risk.tier,
      canMerge: status.canMerge,
      reasons,
      evaluatedAt: status.evaluatedAt,
    });
    return status;
  }

  /** Open PRs, with the verdict of their last evaluation at the current head. */
  async list(): Promise<PrSummary[]> {
    const pulls = await this.o.host.listOpenPullRequests();
    const summaries = this.o.store.summaries(this.project);
    return pulls.map((p) => {
      const s = summaries.get(p.number);
      const current = s && s.headSha === p.headSha ? s : null;
      return {
        number: p.number,
        title: p.title,
        headSha: p.headSha,
        headRef: p.headRef,
        baseRef: p.baseRef,
        draft: p.draft,
        updatedAt: p.updatedAt,
        tier: current?.tier ?? null,
        canMerge: current?.canMerge ?? null,
        reasons: current?.reasons ?? [],
        evaluatedAt: current?.evaluatedAt ?? null,
      };
    });
  }

  /** Record a review. It counts only while `headSha` is the PR's head. */
  async submitReview(
    n: number,
    input: ReviewInput,
    /** `owner`: the request carried the owner's session (required for a human review) */
    context: { assignmentToken: string | null; client: ClientInfo | null; owner?: boolean },
  ): Promise<{ review: ReviewRecord; stale: boolean }> {
    if (input.reviewer.kind === "check") {
      throw new ReviewError("reviewer.kind check is reserved for Lair's own checks", 400);
    }
    if (input.reviewer.kind === "human" && context.owner !== true) {
      throw new ReviewError("A human review needs the owner's session (the dashboard, signed in as the owner)", 403);
    }
    if (input.verdict === "approve" && input.findings.some((f) => f.blocking)) {
      throw new ReviewError("An approval can't carry blocking findings: use request_changes", 400);
    }
    const assignment =
      input.reviewer.kind === "agent" ? this.assignmentFor(n, input.reviewer.id, input.headSha, context.assignmentToken) : null;
    const pr = await this.o.host.getPullRequest(n);
    this.noteHead(pr);
    if (pr.state !== "open") throw new ReviewError(`PR #${n} is ${pr.state}`, 409);
    let reviewer = this.withModel(input.reviewer);
    if (assignment) {
      // Who reviewed is the assignment's agent; for a run Lair started, its model is the one the run runs on, never a claim
      const model = assignment.byAgents
        ? (assignment.runModel ?? assignment.record.model)
        : (assignment.record.model ?? input.reviewer.model);
      reviewer = this.withModel({ id: assignment.record.reviewer ?? input.reviewer.id, kind: "agent", ...(model ? { model } : {}) });
      const a = assignment.record;
      if (!this.o.store.markAssignmentUsed(this.project, n, a.headSha, a.slot, a.round, reviewer.id)) {
        throw new ReviewError("This assignment was already used: a token counts for one review", 403);
      }
    }
    const stored = this.o.store.addReview({
      project: this.project,
      pr: n,
      headSha: input.headSha,
      reviewer,
      verdict: input.verdict,
      summary: input.summary,
      context: {},
      findings: input.findings.map((f) => ({ ...f, rule: null })),
      client: context.client,
      at: this.now(),
    });
    const review = this.annotate(this.o.store.listReviews(this.project, n), pr.headSha).find(
      (r) => r.id === stored.id,
    )!;
    this.emit("review.submitted", {
      pr: n,
      headSha: input.headSha,
      reviewer: reviewer.id,
      verdict: input.verdict,
      blockingFindings: input.findings.filter((f) => f.blocking).length,
      stale: review.stale,
    });
    return { review, stale: review.stale };
  }

  /**
   * The assignment an agent's review is made under. An agent may review
   * only with the token Lair issued (through the assigner) for this PR and
   * head, for this agent (or for any agent but the excluded ones), once, in
   * the slot's latest round. A review by agents also needs its run to be
   * running still, as the agent the run is for.
   */
  private assignmentFor(
    n: number,
    reviewer: string,
    headSha: string,
    token: string | null,
  ): { record: AssignmentRecord; runModel: string | null; byAgents: boolean } {
    if (!token) {
      throw new ReviewError(
        "An agent's review needs the assignment_token Lair issued when it asked for the review",
        403,
      );
    }
    const assignment = this.o.store.findAssignment(this.project, n, hashToken(token));
    if (!assignment) throw new ReviewError(`No review of PR #${n} was assigned with this token`, 403);
    if (assignment.headSha !== headSha) {
      throw new ReviewError(`This assignment is for head ${short(assignment.headSha)}, not ${short(headSha)}`, 403);
    }
    const allowed = assignment.reviewer ? assignment.reviewer === reviewer : !assignment.exclude.includes(reviewer);
    if (!allowed) {
      throw new ReviewError(
        assignment.reviewer
          ? `This assignment is for ${assignment.reviewer}, not ${reviewer}`
          : `${reviewer} may not take this assignment (the PR's author)`,
        403,
      );
    }
    if (assignment.usedBy) {
      throw new ReviewError(`This assignment was already used (by ${assignment.usedBy}): a token counts for one review`, 403);
    }
    const latest = this.o.store.getRequest(this.project, n, assignment.headSha, assignment.slot);
    if (latest && latest.round !== assignment.round) {
      throw new ReviewError("This assignment was replaced by a later request for the same review", 403);
    }
    // A review by agents (the agent assigner keeps a record of the round): only from the run Lair started for it, while it runs
    const agents = this.o.store.agentAssignmentOfRound(this.project, n, assignment.headSha, assignment.slot, assignment.round);
    if (!agents) return { record: assignment, runModel: null, byAgents: false };
    const run = agents.chainId && this.o.reviewRun ? this.o.reviewRun(agents.chainId) : null;
    if (agents.state !== "assigned" || !run || !run.active) {
      throw new ReviewError("The review run this assignment was given to is not running: its token no longer counts", 403);
    }
    if (run.agent !== assignment.reviewer) {
      throw new ReviewError(`This assignment's run is ${run.agent}'s, not ${assignment.reviewer}'s`, 403);
    }
    return { record: assignment, runModel: run.model, byAgents: true };
  }

  /** Register the agent (or person) that wrote the PR. */
  setAuthor(n: number, author: ReviewerRef): ReviewerRef {
    if (author.kind === "check") throw new ReviewError("An author is a human or an agent", 400);
    this.o.store.setAuthor(this.project, n, author);
    return this.withModel(author);
  }

  /**
   * Resolve or dismiss a finding: only the owner (the routes check its
   * session), never the PR's author. A reviewer agent withdraws its own
   * finding by reviewing again, which replaces its earlier review.
   */
  async resolveFinding(
    id: string,
    by: ReviewerRef,
    status: "resolved" | "dismissed",
    note: string,
    client: ClientInfo | null = null,
  ): Promise<ReviewFinding> {
    const prNumber = this.o.store.findingPr(this.project, id);
    if (prNumber === null) throw new ReviewError(`No finding ${id} in ${this.project}`, 404);
    const pr = await this.o.host.getPullRequest(prNumber);
    const finding = this.annotate(this.o.store.listReviews(this.project, prNumber), pr.headSha)
      .flatMap((r) => r.findings)
      .find((f) => f.id === id)!;
    if (finding.status !== "open") throw new ReviewError(`Finding ${id} is already ${finding.status}`, 409);

    const { author } = this.authorOf(pr);
    if (author && by.id === author.id) {
      throw new ReviewError("The PR's author can't resolve findings on their own PR", 403);
    }
    if (by.kind !== "human") {
      throw new ReviewError("Only the owner resolves findings; a reviewer withdraws its own by reviewing again", 403);
    }
    this.o.store.resolveFinding(this.project, id, { status, by: by.id, note, at: this.now(), client });
    return this.annotate(this.o.store.listReviews(this.project, prNumber), pr.headSha)
      .flatMap((r) => r.findings)
      .find((f) => f.id === id)!;
  }

  addHold(pr: number | null, reason: string, by: string): MergeHold {
    return this.o.store.addHold(this.project, pr, reason, by, this.now());
  }

  releaseHold(id: string, by: string): MergeHold {
    if (!this.o.store.releaseHold(this.project, id, by, this.now())) {
      const hold = this.o.store.getHold(this.project, id);
      throw new ReviewError(hold ? `Hold ${id} is already released` : `No hold ${id}`, hold ? 409 : 404);
    }
    return this.o.store.getHold(this.project, id)!;
  }

  listHolds(): MergeHold[] {
    return this.o.store.listHolds(this.project);
  }

  listMerges(): ReviewMergeRecord[] {
    return this.o.store.listMerges(this.project);
  }

  addGateResult(signed: SignedGateResult): void {
    if (this.settings.merge.gate.source !== "signed") {
      throw new ReviewError("This project's gate is read from the git host's checks (review.merge.gate.source)", 409);
    }
    this.o.store.addGateResult(this.project, signed, this.now());
  }

  /**
   * Ask for every missing review at the head, once per head: a named or peer
   * agent through the assigner, the author's self-check through the
   * assigner, and a human through the Decision Inbox. No agent is asked
   * while the PR's author is unknown. `origin`: the owner (POST
   * ./request-reviews, owner only) also asks again for a slot whose reviews
   * by agents failed; the automatic scan never does.
   */
  requestReviews(n: number, origin: RequestOrigin = "owner"): Promise<RequestOutcome[]> {
    const running = this.requesting.get(n);
    if (running) return running;
    const request = this.requestNow(n, origin).finally(() => this.requesting.delete(n));
    this.requesting.set(n, request);
    return request;
  }

  /** Last automatic round per PR: which head, and when */
  private autoRequested = new Map<number, { headSha: string; at: number }>();

  /**
   * The automatic path (reviews by agents): request the missing reviews of
   * every open, non-draft PR when it is first seen or its head changed, at
   * most once per AUTO_REQUEST_MIN_INTERVAL_MS per PR. A failed round waits
   * for the owner. Returns the PRs it asked for.
   */
  async requestOpenPullRequests(): Promise<number[]> {
    if (this.closing) return [];
    const asked: number[] = [];
    for (const pr of await this.o.host.listOpenPullRequests()) {
      this.noteHead(pr);
      if (pr.draft) continue;
      const now = this.o.clock.now();
      const last = this.autoRequested.get(pr.number);
      if (last && (last.headSha === pr.headSha || now - last.at < AUTO_REQUEST_MIN_INTERVAL_MS)) continue;
      this.autoRequested.set(pr.number, { headSha: pr.headSha, at: now });
      try {
        await this.requestReviews(pr.number, "auto");
        asked.push(pr.number);
      } catch (e) {
        console.warn(`[review] ${this.project} #${pr.number}: automatic review request failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return asked;
  }

  private async requestNow(n: number, origin: RequestOrigin): Promise<RequestOutcome[]> {
    const status = await this.status(n);
    const outcomes: RequestOutcome[] = [];
    for (const [index, slot] of status.slots.entries()) {
      if (slot.satisfiedBy) continue;
      // Once per head; again when the assignee reviewed without filling the slot, or (the owner) when reviews by agents failed
      const previous = this.o.store.getRequest(this.project, n, status.headSha, index);
      const agents = this.o.store.getAgentAssignment(this.project, n, status.headSha, index);
      const failedRound = previous && !previous.usedBy && agents?.round === previous.round && agents.state === "failed";
      if (previous && !previous.usedBy && !(failedRound && origin === "owner")) {
        outcomes.push({
          slot: slot.label,
          channel: "already requested",
          detail: failedRound ? `at ${short(status.headSha)}: it failed, and only the owner asks again` : `at ${short(status.headSha)}`,
        });
        continue;
      }
      const options = slot.slot.anyOf;
      const named = options.find((o) => o.kind === "agent");
      const peer = options.some((o) => o.kind === "peer");
      const self = options.some((o) => o.kind === "self");
      let channel: string;
      let detail: string;
      if (named || peer || self) {
        const role = named || peer ? "review" : "self-check";
        // An unknown author may be any agent, the named one included: no agent reviews such a PR
        if (!status.author) {
          outcomes.push({
            slot: slot.label,
            channel: "none",
            detail: `the PR's author is unknown${status.authorNote ? ` (${status.authorNote})` : ""}: no agent reviews it`,
          });
          continue;
        }
        const reviewer = named && named.kind === "agent" ? named.agent : role === "self-check" ? status.author.id : null;
        const exclude = role === "review" ? [status.author.id] : [];
        const token = newAssignmentToken();
        // The token's hash is recorded first, so no token is ever handed out that Lair doesn't know
        const round = this.o.store.recordRequest(this.project, n, status.headSha, index, "requesting", "requesting", this.now(), {
          reviewer,
          exclude,
          tokenHash: hashToken(token),
        });
        const result = await this.o.assigner.assign({
          project: this.project,
          pr: n,
          headSha: status.headSha,
          tier: status.risk.tier,
          reviewer,
          exclude,
          role,
          differentModelFrom: slot.slot.differentModel ? (status.author.model ?? null) : null,
          differentModel: slot.slot.differentModel,
          slot: index,
          round,
          author: status.author.id,
          pool: slot.slot.pool ?? this.settings.agentReviews.pools[status.risk.tier] ?? null,
          repo: this.settings.repo,
          base: status.baseRef,
          url: status.url,
          reason: `The ${status.risk.tier} tier needs ${slot.label}`,
          token,
        });
        // The assigner may name the agent it picked; an excluded pick binds nobody
        const picked = reviewer ?? (result.agent && !exclude.includes(result.agent) ? result.agent : null);
        channel = result.channel ?? "assigner";
        detail = result.agent ? `${result.agent}: ${result.detail}` : result.detail;
        this.o.store.completeRequest(this.project, n, status.headSha, index, round, {
          channel,
          detail,
          reviewer: picked,
          model: picked && picked === result.agent ? (result.model ?? null) : null,
        });
        outcomes.push({ slot: slot.label, channel, detail });
        continue;
      } else {
        const result = await this.o.decisions.raise({
          project: this.project,
          question: `Review PR #${n} (${status.risk.tier} tier) at ${short(status.headSha)}`,
          context: [
            `**${status.title}**`,
            "",
            `Tier ${status.risk.tier}: ${status.risk.rules.map((r) => `${r.id} (${r.reasons[0] ?? r.tier})`).join(", ") || "default tier"}.`,
            `Review it in Lair's Reviews view; the review binds to ${status.headSha}.`,
          ].join("\n"),
          options: ["Review now", "Not now"],
          recommended: "Review now",
          why: `The ${status.risk.tier} tier needs ${slot.label} before it can merge.`,
          kind: "other",
          reversible: true,
          requestedBy: "review",
          links: status.url ? [{ label: `PR #${n}`, url: status.url }] : [],
          key: `review:human:${n}:${status.headSha}:${index}`,
        });
        channel = "decision";
        detail = result.channel;
      }
      this.o.store.recordRequest(this.project, n, status.headSha, index, channel, detail, this.now());
      outcomes.push({ slot: slot.label, channel, detail });
    }
    return outcomes;
  }

  private refuse(n: number, headSha: string, reasons: string[]): MergeResponse {
    this.emit("review.merge_refused", { pr: n, headSha, reasons });
    return { merged: false, record: null, reasons };
  }

  /**
   * Merge, if the policy allows it at the head the caller confirmed. Every
   * refusal lists the conditions that failed.
   */
  async merge(
    n: number,
    request: { confirm: boolean; headSha: string; by: string; client?: ClientInfo | null },
  ): Promise<MergeResponse> {
    if (this.readOnly) throw new ReviewError("The project is read-only (read_only: true): Lair does not merge", 403);
    if (request.confirm !== true) throw new ReviewError("Confirm the merge: send confirm: true", 400);
    if (this.closing) throw new ReviewError("Reviews are reloading this project's config: try again in a moment", 503);
    if (this.merging) throw new ReviewError("Another merge is running for this project", 409);
    this.merging = true;
    try {
      const status = await this.status(n);
      if (status.headSha !== request.headSha) {
        return this.refuse(n, status.headSha, [
          `The head is now ${short(status.headSha)}, not ${short(request.headSha)} as confirmed: check the new head first`,
        ]);
      }
      if (!status.canMerge) return this.refuse(n, status.headSha, status.reasons);

      const merge = this.settings.merge;
      const plan = status.plan;
      const approvers = status.slots.flatMap((s) => (s.satisfiedBy ? [s.satisfiedBy.reviewer.id] : []));
      const title = `${status.title} (#${n})`;
      const body = [
        `Merged by Lair at ${status.headSha}.`,
        `Tier: ${status.risk.tier}. Gate: ${status.gate.map((g) => g.name).join(", ")}.`,
        `Reviews: ${approvers.length > 0 ? approvers.join(", ") : "none required"}.`,
      ].join("\n");

      let execution: MergeExecution;
      if (plan.method === "host") {
        const strategy = plan.strategy;
        if (strategy === "ff-only") throw new ReviewError("ff-only is a local merge strategy", 500);
        execution = await mergeOnHost(this.o.host, {
          pr: n,
          headSha: status.headSha,
          strategy,
          title,
          body,
          allowedEmails: merge.allowedEmails,
          prUser: status.hostUser,
        });
      } else {
        const strategy = plan.strategy;
        if (strategy !== "ff-only" && strategy !== "squash") {
          throw new ReviewError(`${strategy} is not a local merge strategy`, 500);
        }
        const merger = new LocalMerger({
          git: this.o.git,
          workDir: resolve(this.o.cwd, merge.workDir),
          authHeader: this.o.authHeader,
        });
        execution = await merger.merge({
          cloneUrl: merge.cloneUrl,
          baseRef: status.baseRef,
          headSha: status.headSha,
          fetchRef: this.o.host.pullHeadRef(n),
          strategy,
          identity: merge.identity,
          allowedEmails: merge.allowedEmails,
          title,
          body,
        });
        if (execution.merged && strategy === "squash") {
          try {
            await this.o.host.closePullRequest(n, `Merged as ${execution.resultSha} (squash) after Lair's policy checks.`);
          } catch {
            // The merge is on the branch; a PR left open is only cosmetic
          }
        }
      }

      if (!execution.merged) {
        if (execution.emailViolations.length > 0) {
          try {
            await this.o.decisions.raise({
              project: this.project,
              question: `Merge of PR #${n} refused: its commits would publish emails outside the allow-list`,
              context: execution.reasons.map((r) => `- ${r}`).join("\n"),
              options: [
                "Rewrite the commits with an allowed identity",
                "Add the address to review.merge.allowed_emails",
              ],
              recommended: "Rewrite the commits with an allowed identity",
              why: "A published commit keeps its author and committer emails in the history for good.",
              kind: "security",
              reversible: false,
              requestedBy: "review",
              links: status.url ? [{ label: `PR #${n}`, url: status.url }] : [],
              key: `review:emails:${n}:${status.headSha}`,
            });
          } catch {
            // The refusal stands whether or not the inbox took it
          }
        }
        return this.refuse(n, status.headSha, execution.reasons);
      }

      const record = this.o.store.recordMerge({
        project: this.project,
        pr: n,
        headSha: status.headSha,
        method: plan.method,
        strategy: plan.strategy,
        resultSha: execution.resultSha,
        initiatedBy: request.by,
        at: this.now(),
        commitsChecked: execution.commitsChecked,
        conditions: status.conditions,
        client: request.client ?? null,
      });
      this.emit("review.merged", {
        pr: n,
        headSha: status.headSha,
        resultSha: execution.resultSha,
        method: plan.method,
        strategy: plan.strategy,
        tier: status.risk.tier,
      });
      return { merged: true, record, reasons: [] };
    } finally {
      this.merging = false;
      for (const done of this.mergeWaiters.splice(0)) done();
    }
  }

  /** True while a merge runs (a restart waits for it) */
  get mergeInProgress(): boolean {
    return this.merging;
  }

  /**
   * Stop for a config reload or a shutdown: a merge in progress and the
   * test integrity checks running now finish; a merge asked for from now on
   * gets 503.
   */
  async drain(): Promise<void> {
    this.closing = true;
    if (this.merging) await new Promise<void>((resolve) => this.mergeWaiters.push(resolve));
    await Promise.allSettled([...this.integrityRuns.values()]);
  }
}

// ============ MANAGER ============

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  error?: string;
}

export interface ReviewManagerOptions {
  /** SQLite path, or ":memory:" */
  dbPath: string;
  events?: EventBus;
  clock?: Clock;
  git?: GitRunner;
  /** For the GitHub provider; tests pass a stand-in for the API */
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** Relative work dirs resolve against this (default: the working directory) */
  cwd?: string;
  /** Build the git host for a project (default: GitHub) */
  hostFactory?: (settings: ReviewSettings, token: TokenSource) => GitHost;
  decisions?: DecisionSink;
  assigner?: ReviewAssigner;
  /**
   * The agents module (AgentsManager), for reviews by agents: a project that
   * sets review.prompt_file has its agent reviews done by agents it starts
   * (agent-assigner.ts). Without it, requests go to `assigner`.
   */
  agents?: ReviewerRuns;
  /** This server's URL, given to reviewer runs as LAIR_URL */
  serverUrl?: string;
  /** How often reviews by agents are followed, in ms (0: only through agentReviews.check()). Default 15 s */
  agentCheckMs?: number;
  /** How often open PRs are scanned for missing reviews by agents, in ms (0: only through requestOpenPullRequests()). Default 60 s */
  autoRequestMs?: number;
}

/** How often open PRs are scanned for missing reviews by agents, by default */
export const AUTO_REQUEST_INTERVAL_MS = 60_000;

export class ReviewManager {
  private services = new Map<string, ReviewService>();
  private problems = new Map<string, string[]>();
  private configs = new Map<string, ProjectConfig>();
  private store: ReviewStore | null = null;
  private closed = false;
  private agentAssigner: AgentReviewAssigner | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private scanning: Promise<void> | null = null;

  constructor(private readonly options: ReviewManagerOptions) {}

  /** The agent assigner, when a project has reviews by agents on. */
  get agentReviews(): AgentReviewAssigner | null {
    return this.agentAssigner;
  }

  /**
   * Apply a project's new config (src/server/reload/): a merge in progress
   * finishes on the old settings (a new one gets 503 meanwhile), then the
   * project's reviews use the new ones. Other projects are not touched.
   * Reviews by agents in progress carry on: their state is in the store,
   * and the assigner follows them with the new settings (with reviews by
   * agents turned off, it leaves them as they are).
   */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.closed) return;
    await this.services.get(entry.name)?.drain();
    if (this.closed) return;
    this.services.delete(entry.name);
    this.problems.delete(entry.name);
    this.configs.delete(entry.name);
    this.agentAssigner?.removeProject(entry.name);
    this.load([entry]);
  }

  /**
   * The automatic path: every project with reviews by agents requests the
   * missing reviews of its open PRs (ReviewService.requestOpenPullRequests).
   * Concurrent calls share the scan in progress; it never rejects.
   */
  requestOpenPullRequests(): Promise<void> {
    this.scanning ??= (async () => {
      for (const [project, service] of [...this.services.entries()]) {
        if (!this.agentAssigner?.handles(project)) continue;
        try {
          await service.requestOpenPullRequests();
        } catch (e) {
          console.warn(`[review] ${project}: scanning open PRs failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    })().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private startScanning(): void {
    const every = this.options.autoRequestMs ?? AUTO_REQUEST_INTERVAL_MS;
    if (this.autoTimer || every <= 0) return;
    const loop = async () => {
      if (this.closed) return;
      await this.requestOpenPullRequests();
      if (this.closed) return;
      this.autoTimer = setTimeout(loop, every);
      this.autoTimer.unref();
    };
    this.autoTimer = setTimeout(loop, Math.min(5000, every));
    this.autoTimer.unref();
  }

  /** The chain's active run, as the agents module has it (for a review by agents). */
  private reviewRun(chainId: string): { active: boolean; agent: string; model: string | null } | null {
    const chain = this.options.agents?.getStore()?.chainRuns(chainId) ?? [];
    if (chain.length === 0) return null;
    const active = [...chain].reverse().find((run) => ACTIVE_STATES.includes(run.state));
    const run = active ?? chain[chain.length - 1];
    return { active: active !== undefined, agent: run.agent, model: run.profile.model ?? null };
  }

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }
      this.configs.set(entry.name, entry.config);
      const parsed = parseReviewConfig(entry.config.review, entry.config);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[review] ${entry.name}: off: ${parsed.errors.join("; ")}`);
        continue;
      }
      const settings = parsed.settings;
      if (!settings.enabled) continue;
      this.store ??= new ReviewStore(this.options.dbPath);
      const token = tokenFrom(settings.tokenEnv, settings.tokenCmd, this.options.env ?? process.env);
      const host = this.options.hostFactory
        ? this.options.hostFactory(settings, token)
        : new GitHubHost({ repo: settings.repo, apiUrl: settings.apiUrl, token, fetch: this.options.fetch });
      const events = this.options.events;
      const clock = this.options.clock ?? systemClock;
      const decisions = this.options.decisions ?? (events ? eventBusDecisionSink(events) : unwiredDecisionSink);
      let assigner = this.options.assigner ?? (events ? eventBusAssigner(events) : unwiredAssigner);
      if (this.options.agents && settings.agentReviews.promptFile) {
        this.agentAssigner ??= new AgentReviewAssigner({
          agents: this.options.agents,
          store: this.store,
          clock,
          decisions,
          fallback: assigner,
          serverUrl: this.options.serverUrl,
          pullRequest: (project, n) => this.services.get(project)?.currentPullRequest(n) ?? Promise.resolve(null),
        });
        this.agentAssigner.addProject(entry.name, { config: entry.config, settings });
        assigner = this.agentAssigner;
      }
      this.services.set(
        entry.name,
        new ReviewService({
          project: entry.name,
          config: entry.config,
          settings,
          store: this.store,
          host,
          git: this.options.git ?? systemGit(),
          clock,
          events,
          decisions,
          assigner,
          reviewRun: (chainId) => this.reviewRun(chainId),
          authHeader: async () => {
            const t = await token();
            return t ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${t}`).toString("base64")}` : null;
          },
          cwd: this.options.cwd ?? process.cwd(),
        }),
      );
    }
    const every = this.options.agentCheckMs ?? CHECK_INTERVAL_MS;
    if (this.agentAssigner && every > 0) this.agentAssigner.start(every);
    if (this.agentAssigner) this.startScanning();
  }

  get(project: string): ReviewService | undefined {
    return this.services.get(project);
  }

  /** Names of the projects with reviews on. */
  enabled(): string[] {
    return [...this.services.keys()];
  }

  info(project: string): ReviewProjectInfo {
    const service = this.services.get(project);
    return {
      project,
      enabled: service !== undefined,
      errors: this.problems.get(project) ?? [],
      repo: service ? service.settings.repo : null,
      readOnly: this.configs.get(project)?.read_only === true,
    };
  }

  /** The merges running now, as "a merge in <project>" (a restart waits for them). */
  busy(): string[] {
    return [...this.services.entries()].filter(([, s]) => s.mergeInProgress).map(([project]) => `a merge in ${project}`);
  }

  /**
   * Shut down: every merge in progress finishes (new ones get 503), so its
   * record is written before the store closes; then close().
   */
  async stop(): Promise<void> {
    this.closed = true;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.agentAssigner?.stop();
    await Promise.all([...this.services.values()].map((s) => s.drain()));
    // The scan and the check in progress finish before the store closes
    await this.scanning;
    await this.agentAssigner?.idle();
    this.close();
  }

  close(): void {
    this.closed = true;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    this.agentAssigner?.stop();
    this.agentAssigner = null;
    this.store?.close();
    this.store = null;
    this.services.clear();
  }
}
