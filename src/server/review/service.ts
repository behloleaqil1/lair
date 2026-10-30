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
  MergeRefusal,
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
import type { GitHost, HostCheck, HostFile, HostPullRequest, HostRepo } from "./host.js";
import type { ReadyFacts } from "../ready-guard/guard.js";
import { systemGit, type GitRunner } from "./git.js";
import { LocalMerger, mergeOnHost, planMerge, type MergeExecution } from "./executor.js";
import { ReviewStore, type AssignmentRecord, type AutoMergeState, type StoredReview } from "./store.js";
import { checkEnvironment, runPreMergeCheck, systemCheckRunner, type CheckRunner } from "./check.js";
import { hostChecksGate, signedGate, type GateSource } from "./gate-source.js";
import { verifySignedGateResult } from "../gates/signature.js";
import {
  eventBusAssigner,
  eventBusDecisionSink,
  unwiredAssigner,
  unwiredDecisionSink,
  type DecisionSink,
  type ReviewAssigner,
  type ReviewAssignment,
  type ReviewerRuns,
} from "./ports.js";
import type { SignedGateResult } from "../../shared/policy-types.js";
import { asContextText, HoldDecisions, type OwnerHold } from "../decisions/holds.js";
import type { DecisionProducer } from "../decisions/types.js";
import { aiProfiles, resolvePool } from "../ai/profiles.js";
import { loadKnownDragons } from "../services/dragon-registry.js";

/** The module merge holds' decisions are raised as (apart from review's other questions, which nobody follows) */
export const HOLD_DECISION_MODULE = "review-holds";
/**
 * One decision per PR on hold (and one for holds of every merge), however
 * many holds it has: keyed by what it holds and its oldest unreleased hold,
 * so more holds join it, and a PR held again after all were released asks again.
 */
export const holdGroupKey = (group: readonly Pick<MergeHold, "id" | "pr">[]) =>
  `holds:${group[0].pr === null ? "all" : `pr:${group[0].pr}`}:${group[0].id}`;

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
  /** Relative work dirs resolve against this; the pre-merge check runs here */
  cwd: string;
  /** Runs merge.check_cmd (no shell) */
  checks: CheckRunner;
  /** merge.check_cmd's whole environment: Lair's minimal one, never the server's tokens */
  checkEnv: Record<string, string>;
}

/** What an automatic merge (review.merge.auto) is recorded as initiated by. */
export const AUTO_MERGE_ACTOR = "lair:policy";
/** The automatic path evaluates at most this many PRs in full per scan (each costs several host API calls). */
export const MAX_AUTO_EVALUATIONS = 10;
/** With merge.gate.source: checks, the automatic path reads at most this many PRs' gates from the host per scan. */
export const MAX_AUTO_GATE_READS = 20;
/**
 * A signed result triage hands over is kept only up to this size: its
 * signature covers every byte, so it can't be cut (POST
 * /api/review/gate-results takes bodies up to 1 MiB).
 */
export const MAX_TRIAGE_RESULT_BYTES = 8 * 1024 * 1024;

/** The Decision Inbox key of an automatic merge's failure (or interruption) at one head: one per PR and head. */
export function autoMergeDecisionKey(pr: number, headSha: string): string {
  return `review:auto-merge:${pr}:${headSha}`;
}

/** What one automatic merge attempt did. */
export interface AutoMergeOutcome {
  pr: number;
  headSha: string;
  state: Exclude<AutoMergeState, "started" | "interrupted">;
  reasons: string[];
}

/** Who asked for the missing reviews: the owner (the route), or the review module's own scan of open PRs. */
export type RequestOrigin = "owner" | "auto";

/** An automatic round for a PR starts at most this often (a new head waits until then). */
export const AUTO_REQUEST_MIN_INTERVAL_MS = 5 * 60_000;

/** A request round's channel from its token's hash being written until the assigner answers */
const REQUESTING = "requesting";
/** The channel of a round whose assigner threw */
const REQUEST_ERROR = "error";
/** The channel of a human review round whose inbox item was withdrawn when the PR moved off its head */
const REQUEST_WITHDRAWN = "withdrawn";
/**
 * A round still `requesting` after this long was interrupted (Lair stopped
 * between writing its token's hash and the assigner's answer): the slot may
 * be asked for again. An assigner answers in seconds.
 */
export const REQUESTING_EXPIRY_MS = 10 * 60_000;

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** The Decision Inbox key of a human review asked for one slot at one head. */
export function humanReviewKey(pr: number, headSha: string, slot: number): string {
  return `review:human:${pr}:${headSha}:${slot}`;
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

  /** One decision per merge hold: only the owner releases one */
  private readonly holdDecisions: HoldDecisions;

  constructor(private readonly o: ReviewServiceOptions) {
    this.project = o.project;
    this.settings = o.settings;
    this.holdDecisions = new HoldDecisions(HOLD_DECISION_MODULE, o.project);
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

  /**
   * A slot's pool as agent ids: each `role:<role>` entry becomes the agents
   * whose ai.profiles profile is in that role, in the role's order (read now,
   * so dragons.txt and a reload count).
   */
  private reviewerPool(pool: string[] | null): string[] | null {
    if (!pool) return null;
    if (!pool.some((entry) => entry.startsWith("role:"))) return pool;
    return resolvePool(pool, this.o.config, loadKnownDragons(this.o.config).values());
  }

  /** Fill in an agent's model from the config when the caller didn't give it (its own, or its own profile's). */
  private withModel(ref: ReviewerRef): ReviewerRef {
    if (ref.model || ref.kind !== "agent") return ref;
    const own = this.o.config.dragons?.[ref.id];
    const profile = own?.profile ? aiProfiles(this.o.config).get(own.profile) : undefined;
    const model = this.settings.authors.models[ref.id] ?? own?.model ?? profile?.model;
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
    /** Agents that may be the author too (the tasks file chose the author among them): none of them reviews */
    others: string[];
  } {
    const stored = this.o.store.getAuthor(this.project, pr.number);
    if (stored) return { author: this.withModel(stored), source: "lair", note: null, others: [] };
    const mapped = mapAuthor(this.settings.authors, pr.headRef, this.o.config);
    if (mapped.agent) {
      return {
        author: this.withModel({ id: mapped.agent, kind: "agent" }),
        source: mapped.source,
        note: mapped.note,
        others: mapped.others,
      };
    }
    return { author: null, source: null, note: mapped.note, others: [] };
  }

  /** The PR's state and head now, from the git host (recorded as the head seen), or null when it can't say. */
  async currentPullRequest(n: number): Promise<{ state: string; headSha: string } | null> {
    try {
      const pr = await this.o.host.getPullRequest(n);
      await this.noteHead(pr);
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

  /**
   * Record the head; a new one makes every review at an older head stale,
   * and withdraws the human reviews asked for at the old head from the
   * Decision Inbox (a review there would bind to a head that is gone).
   */
  private async noteHead(pr: HostPullRequest): Promise<void> {
    const previous = this.o.store.observeHead(this.project, pr.number, pr.headSha, this.now());
    if (!previous) return;
    const stale = this.o.store
      .listReviews(this.project, pr.number)
      .filter((r) => r.headSha !== pr.headSha && r.reviewer.kind !== "check").length;
    this.emit("review.invalidated", { pr: pr.number, previousHead: previous, headSha: pr.headSha, staleReviews: stale });
    const why = `PR #${pr.number} moved from ${short(previous)} to ${short(pr.headSha)}: a review must bind to the new head`;
    for (const slot of this.o.store.decisionSlots(this.project, pr.number, previous)) {
      try {
        await this.o.decisions.withdraw?.(this.project, humanReviewKey(pr.number, previous, slot), why);
      } catch (e) {
        console.warn(
          `[review] ${this.project} #${pr.number}: withdrawing the old head's review request failed: ${e instanceof Error ? e.message : e}`,
        );
      }
      // The round no longer counts: if the head comes back, the human review is asked for again
      this.o.store.markRequestWithdrawn(this.project, pr.number, previous, slot, why);
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

  /**
   * With hold_when_default_red: whether the default branch's gate is red,
   * and the hold that puts on this PR (null for a proven revert with an
   * exempt label).
   */
  private async defaultBranchRed(
    pr: HostPullRequest,
    defaultBranch: string | null,
    baseTip: string | null,
  ): Promise<{ red: boolean; hold: string | null }> {
    const merge = this.settings.merge;
    const green = { red: false, hold: null };
    if (!merge.holdWhenDefaultRed || !defaultBranch) return green;
    let tip = pr.baseRef === defaultBranch ? baseTip : null;
    if (!tip) {
      try {
        tip = await this.o.host.branchHead(defaultBranch);
      } catch {
        return green;
      }
    }
    const failed = (await this.gateSource.checksAt(tip)).filter((c) => c.status === "failed");
    if (failed.length === 0) return green;
    const red = `the default branch ${defaultBranch} is red at ${short(tip)} (${failed.map((c) => c.name).join(", ")} failed)`;

    const exempt = merge.holdExemptLabels.map((l) => l.toLowerCase());
    const label = pr.labels.find((l) => exempt.includes(l.toLowerCase()));
    if (exempt.length === 0) return { red: true, hold: `${red}: nothing merges until it is green` };
    if (!label) return { red: true, hold: `${red}: only a revert labelled ${merge.holdExemptLabels.join(" or ")} may merge` };
    // A label is easy to add: the PR must also be a revert
    const notRevert = await this.notARevert(pr);
    return { red: true, hold: notRevert ? `${red}: the ${label} label doesn't apply, ${notRevert}` : null };
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

  /**
   * What the ready guard (src/server/ready-guard/) checks a DONE report
   * against, read fresh from the host: the PR, every check at its head (the
   * newest run of each name), the gate at that head (null when the project
   * requires none), and the ids of the review findings the PR carries.
   */
  async readyFacts(n: number): Promise<ReadyFacts> {
    const host = this.o.host;
    const pr = await host.getPullRequest(n);
    const baseTip = await host.branchHead(pr.baseRef);
    const behindBy = (await host.compare(baseTip, pr.headSha)).behindBy;
    const newest = new Map<string, HostCheck>();
    for (const c of await host.listChecks(pr.headSha)) {
      const key = `${c.kind}:${c.name}`;
      const seen = newest.get(key);
      if (!seen || Date.parse(c.at ?? "") > Date.parse(seen.at ?? "")) newest.set(key, c);
    }
    const required = await this.gateSource.checksAt(pr.headSha);
    const findingIds = this.annotate(this.o.store.listReviews(this.project, n), pr.headSha)
      .flatMap((r) => r.findings)
      .filter((f) => f.blocking && !f.superseded)
      .map((f) => f.id);
    return {
      state: pr.state,
      headSha: pr.headSha,
      baseRef: pr.baseRef,
      mergeable: pr.mergeable,
      behindBy,
      body: pr.body ?? "",
      checks: [...newest.values()].map((c) => ({ name: c.name, state: c.state })),
      commitShas: (await host.listCommits(n)).map((c) => c.sha),
      gate: required.length === 0 ? null : required.map((g) => ({ name: g.name, status: g.status })),
      findingIds,
    };
  }

  /** Evaluate a PR: everything the merge policy looks at, and its verdict. */
  async status(n: number): Promise<PrReviewStatus> {
    return (await this.evaluate(n)).status;
  }

  /**
   * status(), plus what only the automatic path reads: whether the default
   * branch is red (also when a proven revert is exempt from its hold), and
   * the red tier's slots as the reviews at the head fill them.
   */
  private async evaluate(n: number): Promise<{ status: PrReviewStatus; defaultBranchRed: boolean; redSlots: SlotStatus[] }> {
    const host = this.o.host;
    const pr = await host.getPullRequest(n);
    await this.noteHead(pr);
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

    const { author, source, note, others } = this.authorOf(pr);
    const reviews = this.annotate(this.o.store.listReviews(this.project, n), pr.headSha);
    const findings = reviews.flatMap((r) => r.findings);
    const openBlocking = findings.filter((f) => f.status === "open" && f.blocking && !f.superseded);
    const current = reviews.filter((r) => !r.stale && !r.superseded && r.reviewer.kind !== "check");
    const candidates = reviews
      .filter((r) => r.reviewer.kind !== "check")
      .map((r) => ({
        id: r.id,
        reviewer: r.reviewer,
        verdict: r.verdict,
        headSha: r.headSha,
        superseded: r.superseded,
      }));
    const slots = matchSlots(this.settings.reviewers[risk.tier], candidates, author, pr.headSha, others);
    const redSlots =
      risk.tier === "red" ? slots : matchSlots(this.settings.reviewers.red, candidates, author, pr.headSha, others);

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
      defaultBranchRed: red.hold,
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
      authorExcluded: others,
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
      autoMergeStatus: this.autoMergeStatusFor(risk.tier),
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
    return { status, defaultBranchRed: red.red, redSlots };
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
    await this.noteHead(pr);
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

  /**
   * Hold merges (of one PR, or all). Anyone may; `byOwner` says the server
   * found the owner's session on the request (`by` is only the caller's
   * word). The PR's holds have one decision: an action item when one of them
   * is the owner's, else a notice (an agent's hold never pushes the owner).
   */
  async addHold(pr: number | null, reason: string, by: string, byOwner = false): Promise<MergeHold> {
    const hold = this.o.store.addHold(this.project, pr, reason, by, this.now(), byOwner);
    await this.reconcileHolds();
    return hold;
  }

  /** Release a hold (the owner only: the route checks the session); the PR's decision follows. */
  async releaseHold(id: string, by: string): Promise<MergeHold> {
    if (!this.o.store.releaseHold(this.project, id, by, this.now())) {
      const hold = this.o.store.getHold(this.project, id);
      throw new ReviewError(hold ? `Hold ${id} is already released` : `No hold ${id}`, hold ? 409 : 404);
    }
    await this.reconcileHolds();
    return this.o.store.getHold(this.project, id)!;
  }

  /**
   * Ask through the Decision Inbox: every PR with unreleased holds (and the
   * project, for holds of every merge) gets its one decision, also for holds
   * added while Lair was down; answering "Release the hold" releases them as
   * the owner, as the Release button does.
   */
  async useDecisions(producer: DecisionProducer): Promise<void> {
    this.holdDecisions.use(producer, async (key) => {
      // Only the group the decision is about, as it still is (a hold added or released since changes its key)
      const group = this.holdGroups().find((g) => holdGroupKey(g) === key);
      for (const hold of group ?? []) this.o.store.releaseHold(this.project, hold.id, "owner", this.now());
      await this.reconcileHolds();
    });
    await this.reconcileHolds();
  }

  /** Stop following the hold decisions' answers (a reload or shutdown); they wait in the inbox. */
  stopDecisions(): void {
    this.holdDecisions.close();
  }

  /** The unreleased holds by what they hold (a PR, or every merge), oldest first. */
  private holdGroups(): MergeHold[][] {
    const groups = new Map<string, MergeHold[]>();
    for (const hold of this.o.store.unreleasedHolds(this.project)) {
      const scope = hold.pr === null ? "all" : String(hold.pr);
      groups.set(scope, [...(groups.get(scope) ?? []), hold]);
    }
    return [...groups.values()];
  }

  private reconcileHolds(): Promise<void> {
    return this.holdDecisions.reconcile(
      this.holdGroups().map((group) => this.holdQuestion(group)),
      () => "The holds it was about changed: released, or the one it was raised for is no longer the oldest.",
    );
  }

  /** A PR's holds' decision, in plain words: what the holders wrote stays in the context, as data. */
  private holdQuestion(group: MergeHold[]): OwnerHold {
    const first = group[0];
    const what = first.pr === null ? `Every merge in ${this.project}` : `PR #${first.pr}`;
    const by = group.length === 1 ? first.createdBy : `${first.createdBy} and ${group.length - 1} more`;
    const shown = group.slice(0, 20);
    return {
      key: holdGroupKey(group),
      ref: first.pr === null ? `holds:${this.project}` : `pr:${first.pr}`,
      // Anyone may add a hold: one added without the owner's session is for their information only
      attention: group.some((hold) => hold.byOwner === true) ? "action" : "notice",
      title: `${what} ${first.pr === null ? "is" : "can't merge: it is"} held by ${by}`,
      context: [
        `${what} ${group.length === 1 ? "has one hold" : `has ${group.length} holds`}. What the holders wrote:`,
        ...shown.flatMap((hold) => [
          "",
          `${hold.createdBy}${hold.byOwner ? " (you)" : ""}, at ${hold.createdAt}:`,
          "```text",
          asContextText(hold.reason, 500),
          "```",
        ]),
        ...(group.length > shown.length ? ["", `... and ${group.length - shown.length} more (see PRs).`] : []),
        "",
        "Only you release a hold. Nothing merges while one is on, by the policy or by you.",
      ].join("\n"),
      releaseLabel: "Release the hold",
      releaseConsequences: `Lair releases every hold on ${first.pr === null ? "every merge" : `PR #${first.pr}`} (as the Release button in PRs does), so it may merge again once the policy allows it.`,
      keepLabel: "Keep it held",
      keepConsequences: "The holds stay until you release them in PRs. Nothing more is asked about them.",
      blocks: [first.pr === null ? `review:${this.project}:merges` : `review:${this.project}:pr:${first.pr}`],
    };
  }

  listHolds(): MergeHold[] {
    return this.o.store.listHolds(this.project);
  }

  listMerges(): ReviewMergeRecord[] {
    return this.o.store.listMerges(this.project);
  }

  /**
   * Store a signed gate result posted over HTTP (POST
   * /api/review/gate-results), which any local process can reach. Refused
   * (403) unless its node is in node_keys, the signature verifies with that
   * key (whatever key the body names), and it is for this project. The first
   * result kept under an id stays (the store's rule), so nobody can replace
   * a newer failure to let an older pass decide. The gate verifies every
   * stored result again each time it is read. True when it was new.
   */
  addGateResult(signed: SignedGateResult): boolean {
    const gate = this.settings.merge.gate;
    if (gate.source !== "signed") {
      throw new ReviewError("This project's gate is read from the git host's checks (review.merge.gate.source)", 409);
    }
    const nodeId = signed.result.nodeId;
    const key = Object.prototype.hasOwnProperty.call(gate.nodeKeys, nodeId) ? gate.nodeKeys[nodeId] : undefined;
    if (!key) {
      throw new ReviewError(`Node ${asContextText(nodeId, 80)} is not in review.merge.gate.node_keys: the result was not stored`, 403);
    }
    const trusted: SignedGateResult = { result: signed.result, signature: signed.signature, nodePublicKey: key };
    if (!verifySignedGateResult(trusted, key).valid) {
      throw new ReviewError(`The signature does not verify with node_keys.${nodeId}: the result was not stored`, 403);
    }
    if (signed.result.projectId !== this.project) {
      throw new ReviewError(
        `The result was signed for project ${asContextText(signed.result.projectId, 80)}, not ${this.project}: it was not stored`,
        403,
      );
    }
    return this.o.store.addGateResult(this.project, trusted, this.now());
  }

  /**
   * A signed result triage accepted for this project, handed over in-process
   * (review.merge.gate.from_triage). Triage verified its signature with a
   * key from triage.trusted_nodes; that proves nothing to the review side,
   * so the gate checks it with node_keys each time it is read, as every
   * stored result. It is kept even when node_keys don't verify it, so the
   * gate can say why it doesn't count. The first result per id stays.
   */
  acceptTriageResult(signed: SignedGateResult): { stored: boolean; detail: string } {
    const gate = this.settings.merge.gate;
    if (gate.source !== "signed" || !gate.fromTriage) {
      return { stored: false, detail: "review.merge.gate.from_triage is off" };
    }
    const bytes = Buffer.byteLength(JSON.stringify(signed));
    if (bytes > MAX_TRIAGE_RESULT_BYTES) {
      return { stored: false, detail: `the result is ${bytes} bytes, more than review keeps (${MAX_TRIAGE_RESULT_BYTES})` };
    }
    const stored = this.o.store.addGateResult(this.project, signed, this.now());
    return { stored, detail: stored ? "stored" : "already stored" };
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
      await this.noteHead(pr);
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

  /** The last PR number the automatic path looked at: the next scan starts after it, so its caps starve no PR */
  private autoCursor = 0;

  private runningKey(pr: number, headSha: string): string {
    return `${this.project}:${pr}:${headSha}`;
  }

  /**
   * The automatic path (review.merge.auto), from the periodic scan of open
   * PRs: merge at most one PR whose status allows it at its current head,
   * through merge() exactly as the owner's route does (that head bound,
   * check_cmd included), recorded as AUTO_MERGE_ACTOR. Nothing starts within
   * auto_min_interval_seconds of the project's last real attempt.
   *
   * A scan reads at most MAX_AUTO_GATE_READS gates from the git host (with
   * source: checks) and evaluates at most MAX_AUTO_EVALUATIONS PRs in full,
   * starting after the PR the last scan stopped at.
   *
   * Each attempt is written to the store before it starts; one still there
   * from before a restart is reported (reportInterruptedAutoMerges) and never
   * run again. A failed one raises one decision and is not tried again at
   * that head (merge it from its page, or push a new head). With
   * hold_when_default_red, while the default branch is red, a PR its hold
   * exempts (a proven revert) merges automatically only with every red-tier
   * slot filled at the head.
   */
  async autoMerge(): Promise<AutoMergeOutcome | null> {
    await this.reportInterruptedAutoMerges();
    const merge = this.settings.merge;
    if (!merge.auto || this.readOnly || this.closing || this.merging) return null;
    const last = this.o.store.lastAutoMergeStart(this.project);
    if (last !== null && this.o.clock.now() - last < merge.autoMinIntervalSeconds * 1000) return null;

    const open = (await this.o.host.listOpenPullRequests()).filter((p) => !p.draft).sort((a, b) => a.number - b.number);
    const start = open.findIndex((p) => p.number > this.autoCursor);
    const pulls = start <= 0 ? open : [...open.slice(start), ...open.slice(0, start)];
    // With source: checks, each gate read is a host call
    const hostGate = merge.gate.source === "checks";
    let gateReads = 0;
    let evaluated = 0;
    for (const pr of pulls) {
      if (this.closing || this.merging) return null;
      const tried = this.o.store.getAutoMerge(this.project, pr.number, pr.headSha);
      if (tried && tried.state !== "skipped") continue;
      if (evaluated >= MAX_AUTO_EVALUATIONS || (hostGate && gateReads >= MAX_AUTO_GATE_READS)) break;
      this.autoCursor = pr.number;
      if (hostGate) gateReads++;
      // The gate first: signed results come from the store, so a PR waiting for its gate costs no host calls
      const gate = await this.gateSource.checksAt(pr.headSha);
      if (gate.length === 0 || gate.some((g) => g.status !== "passed")) continue;
      evaluated++;
      const { status, defaultBranchRed, redSlots } = await this.evaluate(pr.number);
      if (!status.canMerge || status.headSha !== pr.headSha) continue;
      // Check if this tier is in auto_tiers (null means all tiers allowed)
      if (!this.isAutoMergeTier(status.risk.tier)) continue;
      if (this.autoMergeHeld(defaultBranchRed, redSlots)) continue;
      // At most one per scan
      return this.attemptAutoMerge(status);
    }
    return null;
  }

  /**
   * Why the automatic path leaves a PR the policy allows to the owner, or
   * null: with hold_when_default_red, while the default branch is red, a PR
   * its hold exempts (a proven revert) also needs every slot of the red tier
   * filled at the head. (A red-tier PR's own slots are the red tier's, which
   * the policy already requires.)
   */
  private autoMergeHeld(defaultBranchRed: boolean, redSlots: SlotStatus[]): string | null {
    if (!this.settings.merge.holdWhenDefaultRed || !defaultBranchRed) return null;
    const missing = redSlots.filter((s) => s.satisfiedBy === null);
    if (missing.length === 0) return null;
    return `the default branch is red: the red tier's reviews are missing (${missing.map((s) => s.label).join("; ")})`;
  }

  /**
   * Whether a tier is in auto_tiers (null means all tiers allowed, the default).
   * When auto_tiers is set, only listed tiers merge automatically.
   */
  private isAutoMergeTier(tier: Tier): boolean {
    const autoTiers = this.settings.merge.autoTiers;
    return autoTiers === null || autoTiers.includes(tier);
  }

  /**
   * The auto-merge status for a PR of the given tier:
   * - "auto": merge.auto is on and the tier would auto-merge
   * - "manual": merge.auto is on but the tier is not in auto_tiers
   * - null: merge.auto is off
   */
  private autoMergeStatusFor(tier: Tier): "auto" | "manual" | null {
    if (!this.settings.merge.auto) return null;
    return this.isAutoMergeTier(tier) ? "auto" : "manual";
  }

  private async attemptAutoMerge(status: PrReviewStatus): Promise<AutoMergeOutcome> {
    const n = status.number;
    const head = status.headSha;
    const outcome = (state: AutoMergeOutcome["state"], reasons: string[]): AutoMergeOutcome => {
      this.o.store.finishAutoMerge(this.project, n, head, state, reasons, this.o.clock.now());
      return { pr: n, headSha: head, state, reasons };
    };
    const running = this.runningKey(n, head);
    this.o.store.runningAutoMerges.add(running);
    try {
      // Written before anything runs, so a restart finds it
      if (!this.o.store.startAutoMerge(this.project, n, head, this.o.clock.now())) {
        return { pr: n, headSha: head, state: "skipped", reasons: ["an automatic merge at this head already ran"] };
      }
      let result: MergeResponse;
      try {
        result = await this.merge(n, { confirm: true, headSha: head, by: AUTO_MERGE_ACTOR, client: null });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        // Another merge running, or a config reload: nothing was tried
        if (e instanceof ReviewError && (e.statusCode === 409 || e.statusCode === 503)) return outcome("skipped", [reason]);
        await this.raiseAutoMergeFailure(status, [reason]);
        return outcome("failed", [reason]);
      }
      if (result.merged) return outcome("merged", []);
      // The head moved, or the policy changed, since the evaluation: the next scan looks again
      if (result.refusedBy === "head" || result.refusedBy === "policy") return outcome("skipped", result.reasons);
      // An email refusal raised its own security decision in merge()
      if (result.refusedBy !== "emails") await this.raiseAutoMergeFailure(status, result.reasons, result.refusedBy);
      return outcome("failed", result.reasons);
    } finally {
      this.o.store.runningAutoMerges.delete(running);
    }
  }

  /**
   * Automatic merges still `started` while this process runs none of them:
   * a restart interrupted them. Each is reported once (the store marks it
   * interrupted for one caller only), whether merge.auto is still on or not
   * and on a read-only project too: the manager calls this when it loads a
   * project and on every scan.
   */
  async reportInterruptedAutoMerges(): Promise<void> {
    for (const attempt of this.o.store.autoMergesInState(this.project, "started")) {
      if (this.o.store.runningAutoMerges.has(this.runningKey(attempt.pr, attempt.headSha))) continue;
      const why = "Lair stopped while it ran (a restart or a crash): it is not tried again at this head";
      if (!this.o.store.interruptAutoMerge(this.project, attempt.pr, attempt.headSha, [why], this.o.clock.now())) continue;
      try {
        await this.o.decisions.raise({
          project: this.project,
          question: `Automatic merge of PR #${attempt.pr} at ${short(attempt.headSha)} was interrupted`,
          context: [
            `An automatic merge (review.merge.auto) of PR #${attempt.pr} at ${attempt.headSha} started, and Lair stopped before it ended.`,
            "",
            "It may or may not have landed. Lair does not run it again at this head: check the target branch's history,",
            "and merge the PR from its page in PRs if it is still open.",
          ].join("\n"),
          options: ["Check the target branch", "Leave it"],
          recommended: "Check the target branch",
          why: "A merge that a restart cut short is never repeated blindly.",
          kind: "other",
          reversible: true,
          requestedBy: "review",
          links: [],
          key: autoMergeDecisionKey(attempt.pr, attempt.headSha),
        });
      } catch (e) {
        console.warn(`[review] ${this.project} #${attempt.pr}: could not report an interrupted automatic merge: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /**
   * One decision per PR and head for an automatic merge that was refused or failed.
   * @param refusedBy What refused the merge: "check" for the pre-merge check_cmd,
   *   "executor" for clone/push/host errors, or undefined for exceptions.
   *   When the refusal is from check_cmd, merging manually would hit the same block;
   *   for transient failures (executor, exceptions), a manual merge may succeed.
   */
  private async raiseAutoMergeFailure(
    status: PrReviewStatus,
    reasons: string[],
    refusedBy?: MergeRefusal,
  ): Promise<void> {
    const n = status.number;
    // A check_cmd refusal is intentional: the pre-merge check blocked this PR.
    // Recommending a manual merge would bypass what the check refused.
    const isDeliberateRefusal = refusedBy === "check";
    const recommended = isDeliberateRefusal ? "Leave it unmerged" : "Merge it from the PR's page";
    const guidance = isDeliberateRefusal
      ? "The pre-merge check (merge.check_cmd) blocked this PR. Fix the cause and push a new head, or remove the check."
      : "Lair does not try again at this head. Merge it from its page in PRs once the cause is fixed, or push a new head.";
    try {
      await this.o.decisions.raise({
        project: this.project,
        question: `Automatic merge of PR #${n} failed at ${short(status.headSha)}`,
        context: [
          `**${asContextText(status.title, 200)}**`,
          "",
          `The policy allowed PR #${n} at ${status.headSha}, and the automatic merge (review.merge.auto) was refused:`,
          "",
          "```text",
          asContextText(reasons.join("\n"), 2000),
          "```",
          "",
          guidance,
        ].join("\n"),
        options: ["Merge it from the PR's page", "Leave it unmerged"],
        recommended,
        why: "An automatic merge that failed is not retried at the same head.",
        kind: "other",
        reversible: true,
        requestedBy: "review",
        links: status.url ? [{ label: `PR #${n}`, url: status.url }] : [],
        key: autoMergeDecisionKey(n, status.headSha),
      });
    } catch (e) {
      console.warn(`[review] ${this.project} #${n}: could not raise the automatic merge's failure: ${e instanceof Error ? e.message : e}`);
    }
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
      // A round whose hand-over never finished (a crash after its token's hash was written, or an assigner error),
      // or whose inbox item was withdrawn when the PR left this head, doesn't count
      const handedOn = agents?.round === previous?.round && (agents?.state === "requested" || agents?.state === "assigned");
      const interrupted =
        previous &&
        !previous.usedBy &&
        !handedOn &&
        (previous.channel === REQUEST_ERROR ||
          previous.channel === REQUEST_WITHDRAWN ||
          (previous.channel === REQUESTING && this.o.clock.now() - Date.parse(previous.requestedAt) >= REQUESTING_EXPIRY_MS));
      if (previous && !previous.usedBy && !interrupted && !(failedRound && origin === "owner")) {
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
        // The author, and the agents the branch mappings also matched when the tasks file chose between them
        const exclude = role === "review" ? [status.author.id, ...(status.authorExcluded ?? [])] : [];
        if (reviewer && role === "review" && exclude.includes(reviewer)) {
          outcomes.push({
            slot: slot.label,
            channel: "none",
            detail: `${reviewer} may be the PR's author (${status.authorNote ?? "the branch mappings matched it"}): it reviews nothing here`,
          });
          continue;
        }
        const token = newAssignmentToken();
        // The token's hash is recorded first, so no token is ever handed out that Lair doesn't know
        const round = this.o.store.recordRequest(this.project, n, status.headSha, index, REQUESTING, REQUESTING, this.now(), {
          reviewer,
          exclude,
          tokenHash: hashToken(token),
        });
        const assignment = {
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
          pool: this.reviewerPool(slot.slot.pool ?? this.settings.agentReviews.pools[status.risk.tier] ?? null),
          repo: this.settings.repo,
          base: status.baseRef,
          url: status.url,
          reason: `The ${status.risk.tier} tier needs ${slot.label}`,
          token,
        } satisfies ReviewAssignment;
        let result: Awaited<ReturnType<ReviewAssigner["assign"]>>;
        try {
          result = await this.o.assigner.assign(assignment);
        } catch (e) {
          // Recorded as an error, so the slot can be asked for again
          const why = `the assigner failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
          this.o.store.completeRequest(this.project, n, status.headSha, index, round, {
            channel: REQUEST_ERROR,
            detail: why,
            reviewer: null,
            model: null,
          });
          outcomes.push({ slot: slot.label, channel: REQUEST_ERROR, detail: why });
          continue;
        }
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
          key: humanReviewKey(n, status.headSha, index),
        });
        channel = "decision";
        detail = result.channel;
      }
      this.o.store.recordRequest(this.project, n, status.headSha, index, channel, detail, this.now());
      outcomes.push({ slot: slot.label, channel, detail });
    }
    return outcomes;
  }

  private refuse(n: number, headSha: string, reasons: string[], refusedBy: MergeRefusal, by: string): MergeResponse {
    this.emit("review.merge_refused", { pr: n, headSha, reasons, refusedBy, by });
    return { merged: false, record: null, reasons, refusedBy };
  }

  /**
   * Merge, if the policy allows it at the head the caller confirmed, and
   * merge.check_cmd (when set) passes at that head. Every refusal lists the
   * conditions that failed. The owner's route and the automatic path
   * (autoMerge) both merge only through here.
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
        return this.refuse(
          n,
          status.headSha,
          [`The head is now ${short(status.headSha)}, not ${short(request.headSha)} as confirmed: check the new head first`],
          "head",
          request.by,
        );
      }
      if (!status.canMerge) return this.refuse(n, status.headSha, status.reasons, "policy", request.by);

      const merge = this.settings.merge;
      if (merge.checkCmd) {
        // The project's own check, at the head the policy allowed; the executor still binds that head
        const refusal = await runPreMergeCheck(
          {
            runner: this.o.checks,
            template: merge.checkCmd,
            cwd: this.o.cwd,
            env: this.o.checkEnv,
            timeoutSeconds: merge.checkTimeoutSeconds,
          },
          { pr: n, head: status.headSha, base: status.baseRef, repo: this.settings.repo },
        );
        if (refusal) return this.refuse(n, status.headSha, [refusal], "check", request.by);
      }
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
        return this.refuse(
          n,
          status.headSha,
          execution.reasons,
          execution.emailViolations.length > 0 ? "emails" : "executor",
          request.by,
        );
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
        by: request.by,
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
  /**
   * How often open PRs are scanned for missing reviews by agents and for
   * automatic merges (review.merge.auto), in ms (0: only through
   * requestOpenPullRequests()). Default 60 s
   */
  autoRequestMs?: number;
  /** Runs review.merge.check_cmd (default: spawn, no shell); tests pass a fake spawner */
  checks?: CheckRunner;
}

/** How often open PRs are scanned for missing reviews by agents and automatic merges, by default */
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
  /** The Decision Inbox, once useDecisions() connected it */
  private producer: DecisionProducer | null = null;

  constructor(private readonly options: ReviewManagerOptions) {}

  /** The agent assigner, when a project has reviews by agents on. */
  get agentReviews(): AgentReviewAssigner | null {
    return this.agentAssigner;
  }

  /**
   * Follow the merge holds through the Decision Inbox (src/server/index.ts
   * calls this once the inbox is mounted): each project's unreleased holds
   * get their one decision, and answering one releases its hold. Projects
   * loaded later (a reload) follow it too.
   */
  useDecisions(producer: DecisionProducer): Promise<void> {
    this.producer = producer;
    return Promise.all([...this.services.values()].map((service) => this.follow(service))).then(() => undefined);
  }

  private async follow(service: ReviewService): Promise<void> {
    if (!this.producer) return;
    try {
      await service.useDecisions(this.producer);
    } catch (e) {
      console.warn(`[review] ${service.project}: could not follow its holds' decisions: ${e instanceof Error ? e.message : e}`);
    }
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
    this.services.get(entry.name)?.stopDecisions();
    this.services.delete(entry.name);
    this.problems.delete(entry.name);
    this.configs.delete(entry.name);
    this.agentAssigner?.removeProject(entry.name);
    this.load([entry]);
  }

  /**
   * The automatic path: every project with reviews by agents requests the
   * missing reviews of its open PRs (ReviewService.requestOpenPullRequests),
   * and every project with review.merge.auto merges at most one PR its
   * policy allows (ReviewService.autoMerge). Automatic merges a restart
   * interrupted are reported for every project, auto or not. Concurrent
   * calls share the scan in progress; it never rejects.
   */
  requestOpenPullRequests(): Promise<void> {
    this.scanning ??= (async () => {
      for (const [project, service] of [...this.services.entries()]) {
        if (this.agentAssigner?.handles(project)) {
          try {
            await service.requestOpenPullRequests();
          } catch (e) {
            console.warn(`[review] ${project}: scanning open PRs failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        try {
          // autoMerge() reports them first itself
          if (!service.settings.merge.auto) await service.reportInterruptedAutoMerges();
        } catch (e) {
          console.warn(`[review] ${project}: reporting interrupted automatic merges failed: ${e instanceof Error ? e.message : e}`);
        }
        if (service.settings.merge.auto) {
          try {
            await service.autoMerge();
          } catch (e) {
            console.warn(`[review] ${project}: the automatic merge scan failed: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
    })().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  /**
   * A signed result triage accepted for `project` (src/server/triage/, its
   * `review` option): kept for the project's gate when
   * review.merge.gate.from_triage is on, and verified there as any signed
   * result is. In-process only; never throws.
   */
  acceptSignedResult(project: string, signed: SignedGateResult): { stored: boolean; detail: string } {
    const service = this.services.get(project);
    if (!service) return { stored: false, detail: `reviews are off for ${project}` };
    try {
      return service.acceptTriageResult(signed);
    } catch (e) {
      return { stored: false, detail: e instanceof Error ? e.message : String(e) };
    }
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
          checks: this.options.checks ?? systemCheckRunner(),
          // Never the server's environment: the token above stays out of the check's reach
          checkEnv: checkEnvironment(this.options.env ?? process.env),
        }),
      );
      // A project loaded after the inbox was connected (a reload) follows its holds' decisions too
      const loaded = this.services.get(entry.name);
      if (loaded && this.producer) void this.follow(loaded);
      // An automatic merge a crash cut short is reported at once, whatever merge.auto says now
      if (loaded) {
        loaded.reportInterruptedAutoMerges().catch((e) => {
          console.warn(`[review] ${entry.name}: reporting interrupted automatic merges failed: ${e instanceof Error ? e.message : e}`);
        });
      }
    }
    const every = this.options.agentCheckMs ?? CHECK_INTERVAL_MS;
    if (this.agentAssigner && every > 0) this.agentAssigner.start(every);
    if (this.agentAssigner || [...this.services.values()].some((s) => s.settings.merge.auto)) this.startScanning();
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
    for (const service of this.services.values()) service.stopDecisions();
    this.store?.close();
    this.store = null;
    this.services.clear();
  }
}
