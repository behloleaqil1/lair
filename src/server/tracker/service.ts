/**
 * TrackerService: one project's GitHub issues, Projects boards and
 * milestones kept in step with its tasks, runs and pull requests.
 *
 * - Events never wait on GitHub: a handler only queues a job and returns,
 *   so the module that emitted the event is never held up. The jobs run one
 *   at a time per project (so two events for one task never interleave), on
 *   a bounded queue; a job dropped because the queue is full is caught up by
 *   the next reconcile.
 * - The store holds what Lair wants (a task's column, agent, closed state);
 *   writes try to make GitHub match, and the periodic reconcile retries what
 *   failed and fixes what someone changed by hand.
 * - Every write goes through write(): in observe mode it is recorded and
 *   never sent (the client is read-only too); in act mode it is budgeted
 *   (write_budget_per_minute), audited, and refused while the token needs
 *   the owner (a missing scope, a refused token).
 * - An issue is created at most once per task: the create is recorded as
 *   pending before it is sent, its body carries a marker, and a later
 *   attempt finds the issue by that marker in the issues list before it
 *   would create another one.
 * - Every text sent is redacted (redact.ts) and bounded.
 */
import { createHash } from "crypto";
import type { Event } from "../../shared/server-types.js";
import type {
  TrackerLink,
  TrackerOp,
  TrackerRemovedTask,
  TrackerStatus,
  TrackerStatusView,
  TrackerUnmergedPull,
} from "../../shared/tracker-types.js";
import type { EventBus } from "../core/event-bus.js";
import type { DecisionProducer, DecisionResolution } from "../decisions/types.js";
import { optionToStatus, statusToOption, type RepoSettings, type TrackerSettings } from "./config.js";
import { GitHubError, type Board, type BoardItem, type GitHubTrackerClient, type Issue, type Milestone, type Pull } from "./github-projects.js";
import { makeRedactor, oneLine, type Redact } from "./redact.js";
import type { TrackerStore } from "./store.js";
import type { TaskInfo, TaskSource, TasksSnapshot } from "./tasks.js";

/** The module name on its decisions */
export const DECISION_MODULE = "tracker";
export const SCOPES_KEY = "token-scopes";
export const RECHECK = "recheck";

/** Jobs that may wait in a project's queue; more are dropped (a reconcile catches up) */
export const MAX_QUEUE = 500;
/** New links a reconcile makes (the rest wait for the next one) */
const MAX_NEW_LINKS_PER_RECONCILE = 10;
/** Closed PRs a reconcile reads per tracked repository (one page, the newest update first) */
const CLOSED_PULLS_PER_REPO = 100;
/** Tasks a reconcile finishes because their PR merged elsewhere, and tasks it closes because their line was removed (each; the rest wait) */
const MAX_FINISHES_PER_RECONCILE = 10;
/** Reconciles in a row that must miss a linked task's line before it counts as removed */
export const REMOVED_AFTER_RECONCILES = 2;
/** While writes wait on the owner, a reconcile checks the token again at most this often */
const SCOPE_RECHECK_MS = 5 * 60_000;
const TITLE_MAX = 200;
const BODY_MAX = 3000;
const COMMENT_MAX = 600;
const AGENT_MAX = 100;
const KEEP_WRITES_DAYS = 30;
/** Milestones are read again after this */
const MILESTONE_CACHE_MS = 5 * 60_000;
/** A stop waits this long for the job in progress (its requests are aborted at once) */
const STOP_WAIT_MS = 5_000;

const MARKER_PREFIX = "<!-- lair-task:";

export interface TrackerServiceOptions {
  project: string;
  settings: TrackerSettings;
  store: TrackerStore;
  client: GitHubTrackerClient;
  tasks: TaskSource;
  /** Aborts the client's requests in flight; stop() aborts it */
  abort: AbortController;
  events?: EventBus;
  decisions?: DecisionProducer | null;
  now?: () => number;
  redact?: Redact;
  log?: Pick<Console, "warn">;
}

interface RepoState {
  settings: RepoSettings;
  board: Board | null;
  error: string | null;
}

type WriteResult<T> = { sent: true; value: T } | { sent: false; why: "observe" | "budget" | "needs_owner" | "rate_limited" | "failed" };

interface WriteMeta {
  op: TrackerOp;
  task: string | null;
  repo: string | null;
  issueNumber: number | null;
  value: string | null;
  /** What would be sent, recorded in observe mode (already redacted) */
  wouldSend: unknown;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const sha = (text: string, n = 24) => createHash("sha256").update(text).digest("hex").slice(0, n);

/** Issues a PR body closes (`Closes #3`, `fixes owner/name#4`, an issue URL): `#N` alone is the PR's own repository. */
export function closingRefs(body: string, prRepo: string): { repo: string; number: number }[] {
  const out = new Map<string, { repo: string; number: number }>();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:https?:\/\/[^\s/]+\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|([\w.-]+\/[\w.-]+)?#(\d+))/gi;
  for (const m of body.matchAll(re)) {
    const repo = m[1] ?? m[3] ?? prRepo;
    const number = Number(m[2] ?? m[4]);
    if (Number.isSafeInteger(number) && number > 0) out.set(`${repo.toLowerCase()}#${number}`, { repo, number });
  }
  return [...out.values()];
}

/** An issue a task line names on purpose: an issue URL or owner/name#N of a tracked repository, or `Issue: #N` / `Closes #N`. */
export function explicitIssue(text: string, taskRepo: string | null, tracked: string[]): { repo: string; number: number } | null {
  const isTracked = (repo: string) => tracked.find((t) => t.toLowerCase() === repo.toLowerCase()) ?? null;
  const url = /https?:\/\/[^\s/]+\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/i.exec(text);
  if (url) {
    const repo = isTracked(url[1]);
    return repo ? { repo, number: Number(url[2]) } : null;
  }
  const qualified = /(?:^|\s)([\w.-]+\/[\w.-]+)#(\d+)\b/.exec(text);
  if (qualified) {
    const repo = isTracked(qualified[1]);
    return repo ? { repo, number: Number(qualified[2]) } : null;
  }
  const keyword = /\b(?:issue|closes|fixes|resolves|tracks)\b:?\s*#(\d+)\b/i.exec(text);
  if (keyword && taskRepo) return { repo: taskRepo, number: Number(keyword[1]) };
  return null;
}

export class TrackerService {
  readonly project: string;
  readonly settings: TrackerSettings;
  private readonly store: TrackerStore;
  private readonly client: GitHubTrackerClient;
  private readonly tasks: TaskSource;
  private readonly abort: AbortController;
  private readonly events: EventBus | undefined;
  private decisions: DecisionProducer | null;
  private readonly now: () => number;
  private readonly redact: Redact;
  private readonly log: Pick<Console, "warn">;

  private readonly repos = new Map<string, RepoState>();
  private unsubscribes: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;
  private dropped = 0;
  /** Writes that were tried and did not go through (errors and rate limits) */
  private writeFailures = 0;
  private budget = { left: 0, resetAt: 0 };
  private scopes: TrackerStatusView["scopes"] = { checked: false, granted: null, missing: [] };
  private scopesCheckedAt = 0;
  /** Why writes stop until the owner acts (null: they don't) */
  private needsOwner: string | null = null;
  private readonly milestones = new Map<string, { at: number; open: Milestone[] }>();
  private readonly notes = new Set<string>();
  /** Open linked tasks whose line the last reconciles did not find: task -> reconciles in a row */
  private readonly missing = new Map<string, number>();
  /** Linked tasks' PRs the last reconcile saw closed without merging */
  private closedUnmerged: TrackerUnmergedPull[] = [];

  constructor(options: TrackerServiceOptions) {
    this.project = options.project;
    this.settings = options.settings;
    this.store = options.store;
    this.client = options.client;
    this.tasks = options.tasks;
    this.abort = options.abort;
    this.events = options.events;
    this.decisions = options.decisions ?? null;
    this.now = options.now ?? Date.now;
    this.redact = options.redact ?? makeRedactor({ patterns: options.settings.redactPatterns });
    this.log = options.log ?? console;
    for (const repo of options.settings.repos) this.repos.set(repo.repo.toLowerCase(), { settings: repo, board: null, error: null });
    const sync = this.store.getState(this.project);
    const reset = sync?.rateLimitResetAt ? Date.parse(sync.rateLimitResetAt) : 0;
    if (reset > this.now()) this.client.restoreRateLimit(reset);
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  // ============ LIFECYCLE ============

  /** Subscribe and queue the first sync (scopes, boards, a reconcile). Never throws and never waits on GitHub. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const events = this.events;
    if (events) {
      this.unsubscribes.push(
        events.on("planner.changed", (e) => this.onPlannerChanged(e)),
        events.on("planner.blocked", (e) => this.onPlannerBlocked(e)),
        events.on("agent.run.started", (e) => this.onRunStarted(e)),
        events.on("review.submitted", (e) => this.onReviewSubmitted(e)),
        events.on("review.merged", (e) => this.onReviewMerged(e)),
      );
    }
    this.enqueue("start", async () => {
      await this.checkScopes();
      await this.loadBoards();
      await this.reconcile();
    });
  }

  /** Unsubscribe, cancel the timer, cut requests in flight short, and wait (bounded) for the job in progress. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.tail, new Promise<void>((resolve) => (timeout = setTimeout(resolve, STOP_WAIT_MS)))]);
    clearTimeout(timeout);
  }

  get running(): boolean {
    return this.started && !this.stopped;
  }

  useDecisions(decisions: DecisionProducer | null): void {
    this.decisions = decisions;
  }

  /** Resolves once no job is waiting or running (tests, and the owner's reconcile route) */
  async idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const tail = this.tail;
      await tail;
      if (tail === this.tail) return;
    }
  }

  /** Queue a job; false when stopped or the queue is full. */
  private enqueue(label: string, job: () => Promise<void>): boolean {
    if (this.stopped) return false;
    if (this.waiting >= MAX_QUEUE) {
      this.dropped++;
      if (this.dropped === 1 || this.dropped % 100 === 0) {
        this.store.noteError(this.project, `the tracker's queue is full (${MAX_QUEUE} jobs): ${this.dropped} dropped; the next reconcile catches up`);
      }
      return false;
    }
    this.waiting++;
    this.tail = this.tail.then(async () => {
      try {
        if (!this.stopped) await job();
      } catch (e) {
        if (!this.stopped) this.noteError(label, e);
      } finally {
        this.waiting--;
      }
    });
    return true;
  }

  private scheduleReconcile(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const interval = this.settings.reconcileIntervalSeconds * 1000;
    this.store.patchState(this.project, { nextReconcileAt: this.iso(this.now() + interval) });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueue("reconcile", async () => {
        await this.reconcile();
      });
    }, interval);
    this.timer.unref?.();
  }

  /** The owner's "sync now": a reconcile queued after the jobs waiting. */
  requestReconcile(by: string): boolean {
    this.store.recordWrite(
      this.project,
      { task: null, repo: null, issueNumber: null, op: "sync_requested", value: by, mode: this.settings.mode, wouldSend: null, result: "success", error: null },
      this.iso(),
    );
    return this.enqueue("reconcile", async () => {
      if (this.needsOwner || !this.scopes.checked) await this.checkScopes();
      await this.loadBoards();
      await this.reconcile();
    });
  }

  /** An answer to one of the tracker's decisions: "check again" checks the token's scopes again. */
  async followAnswer(resolution: DecisionResolution): Promise<void> {
    if (resolution.decision.source.ref !== SCOPES_KEY || resolution.optionId !== RECHECK) return;
    this.enqueue("scope check", async () => {
      await this.checkScopes();
      await this.loadBoards();
    });
  }

  // ============ EVENTS: each queues a job and returns ============

  private onPlannerChanged(event: Event): void {
    const d = event.data;
    // Only what was written to the tasks file: "planned" is the planner's observe mode (not written)
    if (d.project !== this.project || d.outcome !== "applied") return;
    const task = str(d.task);
    if (!task) return;
    this.noteEvent(event);
    switch (d.op) {
      case "add":
        this.enqueue(`add ${task}`, async () => {
          const info = (await this.tasks.read())?.open.find((t) => t.task === task) ?? null;
          await this.ensureLink(task, info);
        });
        return;
      case "mark_done":
        this.enqueue(`done ${task}`, () => this.finish(task, "completed"));
        return;
      case "drop":
        this.enqueue(`drop ${task}`, () => this.finish(task, "not_planned"));
        return;
      case "unblock":
        this.enqueue(`unblock ${task}`, async () => {
          const link = this.store.getLink(this.project, task);
          if (link) await this.unblock(link);
        });
        return;
      default:
        // reword, reassign: nothing on GitHub changes
        return;
    }
  }

  private onPlannerBlocked(event: Event): void {
    const d = event.data;
    if (d.project !== this.project) return;
    const task = str(d.task);
    if (!task) return;
    this.noteEvent(event);
    const cls = str(d.class) ?? "blocked";
    const rule = str(d.rule);
    this.enqueue(`blocked ${task}`, () => this.block(task, cls, rule));
  }

  private onRunStarted(event: Event): void {
    const d = event.data;
    if (d.project !== this.project || d.kind !== "started") return;
    const task = str(d.task);
    if (!task) return;
    const agent = str(d.agent);
    this.noteEvent(event);
    this.enqueue(`run ${task}`, async () => {
      const link = this.store.getLink(this.project, task);
      if (!link || link.closedAs) return;
      await this.setStatus(link, "in_progress", agent);
      // A new run: whatever blocked it is over
      if (link.blockedKey) await this.unblock(link);
    });
  }

  private onReviewSubmitted(event: Event): void {
    const d = event.data;
    if (d.project !== this.project || typeof d.pr !== "number") return;
    const pr = d.pr;
    this.noteEvent(event);
    this.enqueue(`review #${pr}`, () => this.onPull(pr, "in_review"));
  }

  private onReviewMerged(event: Event): void {
    const d = event.data;
    if (d.project !== this.project || typeof d.pr !== "number") return;
    const pr = d.pr;
    this.noteEvent(event);
    this.enqueue(`merged #${pr}`, () => this.onPull(pr, "merged"));
  }

  private noteEvent(event: Event): void {
    this.store.patchState(this.project, { lastEventAt: event.timestamp });
  }

  // ============ WRITES ============

  private takeBudget(): boolean {
    const now = this.now();
    if (now >= this.budget.resetAt) this.budget = { left: this.settings.writeBudgetPerMinute, resetAt: now + 60_000 };
    if (this.budget.left <= 0) return false;
    this.budget.left--;
    return true;
  }

  /** The one way to change GitHub: observe records, act sends (budgeted, audited). */
  private async write<T>(meta: WriteMeta, send: () => Promise<T>): Promise<WriteResult<T>> {
    const row = { task: meta.task, repo: meta.repo, issueNumber: meta.issueNumber, op: meta.op, value: meta.value };
    if (this.settings.mode !== "act") {
      const wouldSend = JSON.stringify(meta.wouldSend ?? null).slice(0, 4000);
      this.store.recordWrite(
        this.project,
        { ...row, mode: "observe", wouldSend, result: "would_send", error: null, dedupeKey: sha(`${meta.op}\0${meta.repo}\0${meta.issueNumber}\0${meta.task}\0${wouldSend}`) },
        this.iso(),
      );
      return { sent: false, why: "observe" };
    }
    const skip = (result: "skipped" | "rate_limited", error: string, why: "needs_owner" | "budget" | "rate_limited"): WriteResult<T> => {
      this.store.recordWrite(this.project, { ...row, mode: "act", wouldSend: null, result, error }, this.iso());
      return { sent: false, why };
    };
    if (this.needsOwner) return skip("skipped", `not sent: ${this.needsOwner}`, "needs_owner");
    const limited = this.client.rateLimitedUntil;
    if (limited) return skip("rate_limited", `GitHub's rate limit until ${this.iso(limited)}`, "rate_limited");
    if (!this.takeBudget()) return skip("rate_limited", `the write budget (${this.settings.writeBudgetPerMinute} a minute) is spent`, "budget");
    try {
      const value = await send();
      this.store.recordWrite(this.project, { ...row, mode: "act", wouldSend: null, result: "success", error: null }, this.iso());
      return { sent: true, value };
    } catch (e) {
      const rateLimited = e instanceof GitHubError && e.code === "rate_limit";
      this.store.recordWrite(
        this.project,
        { ...row, mode: "act", wouldSend: null, result: rateLimited ? "rate_limited" : "error", error: message(e).slice(0, 300) },
        this.iso(),
      );
      this.writeFailures++;
      this.onApiError(e);
      return { sent: false, why: rateLimited ? "rate_limited" : "failed" };
    }
  }

  /** What an error from GitHub means for the next writes. */
  private onApiError(e: unknown): void {
    if (!(e instanceof GitHubError)) {
      this.store.noteError(this.project, message(e));
      return;
    }
    if (e.code === "rate_limit" && e.retryAt) {
      this.store.patchState(this.project, { rateLimitResetAt: this.iso(e.retryAt) });
    } else if (e.code === "auth" || e.code === "forbidden") {
      this.setNeedsOwner(`GitHub refused the token: ${e.message}`);
    }
    this.store.noteError(this.project, e.message);
  }

  private setNeedsOwner(reason: string | null): void {
    this.needsOwner = reason;
    this.store.patchState(this.project, { needsOwner: reason });
  }

  private noteError(what: string, e: unknown): void {
    if (e instanceof GitHubError) this.onApiError(e);
    else this.store.noteError(this.project, `${what}: ${message(e)}`);
  }

  // ============ TOKEN AND BOARDS ============

  private async checkScopes(): Promise<void> {
    let answer: { token: boolean; scopes: string[] | null };
    this.scopesCheckedAt = this.now();
    try {
      answer = await this.client.scopes();
    } catch (e) {
      this.noteError("the token's scope check", e);
      return;
    }
    const missing: string[] = [];
    if (!answer.token) {
      missing.push("repo", "project");
    } else if (answer.scopes) {
      const has = (s: string) => answer.scopes!.includes(s);
      if (!has("repo") && !has("public_repo")) missing.push("repo");
      // Moving cards needs project; observe mode only reads boards
      if (!has("project") && !(this.settings.mode === "observe" && has("read:project"))) missing.push("project");
    }
    this.scopes = { checked: true, granted: answer.scopes, missing };
    if (missing.length > 0) {
      const why = answer.token
        ? `the GitHub token lacks the scope${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`
        : `no GitHub token (${this.tokenWhere()} is empty)`;
      this.setNeedsOwner(why);
      await this.raiseScopeDecision(missing, answer.token);
      return;
    }
    if (this.needsOwner) this.setNeedsOwner(null);
    await this.withdrawScopeDecision();
  }

  private tokenWhere(): string {
    const { env, cmd } = this.settings.token;
    return cmd ? `the env var ${env} and token_cmd` : `the env var ${env}`;
  }

  private async raiseScopeDecision(missing: string[], tokenFound: boolean): Promise<void> {
    if (!this.decisions) return;
    const list = missing.join(" and ");
    const context = [
      tokenFound
        ? `The token the tracker uses (${this.tokenWhere()}, from ${this.settings.token.from === "tracker" ? "tracker" : this.settings.token.from === "review" ? "review" : "the default"}) does not have the scope${missing.length > 1 ? "s" : ""} ${list}.`
        : `The tracker found no GitHub token: ${this.tokenWhere()} gave none.`,
      "",
      "Until it has them the tracker sends nothing to GitHub (in act mode it would move cards, create and close issues); it keeps recording what it would change.",
      "",
      "What it needs: a classic token with `repo` (or `public_repo` for public repositories only) and `project` (Projects boards); a fine-grained token with Issues: read and write, Pull requests: read, and Projects: read and write on the owner.",
      "Update the token where the tracker reads it, then choose \"I updated the token: check again\".",
    ].join("\n");
    try {
      await this.decisions.raise({
        project: this.project,
        kind: "other",
        title: `The tracker's GitHub token lacks ${list}: it changes nothing on GitHub until it has them`.slice(0, 200),
        context,
        options: [
          {
            id: RECHECK,
            label: "I updated the token: check again",
            effect: "reversible",
            consequences: "The tracker checks the token's scopes again; with them it resumes its writes, without them it asks again.",
          },
        ],
        recommended: { optionId: RECHECK, reasoning: "Only you can change the token; the check costs one request." },
        source: { module: DECISION_MODULE, ref: SCOPES_KEY },
        key: SCOPES_KEY,
        class: "tracker.token_scopes",
        evidence: {
          code: tokenFound ? "missing_scopes" : "no_token",
          facts: { missing: missing.join(","), token_found: tokenFound, token_from: this.settings.token.from, mode: this.settings.mode },
          cause_cleared: false,
          linked_issue: null,
        },
      });
    } catch (e) {
      this.store.noteError(this.project, `the scope decision was not raised: ${message(e)}`);
    }
  }

  private async withdrawScopeDecision(): Promise<void> {
    const open = this.decisions?.find(this.project, DECISION_MODULE, SCOPES_KEY);
    if (!open || open.status !== "open") return;
    try {
      await this.decisions!.withdraw(open.id, { module: DECISION_MODULE, reason: "the token has the scopes now" });
    } catch (e) {
      this.store.noteError(this.project, `the scope decision was not withdrawn: ${message(e)}`);
    }
  }

  private async loadBoards(): Promise<void> {
    for (const state of this.repos.values()) {
      const board = state.settings.board;
      if (!board || state.board) continue;
      try {
        const found = await this.client.getBoard(board.owner, board.number, state.settings.statusField, state.settings.agentField);
        if (!found) {
          state.error = `board ${board.owner}/${board.number} not found (or the token can't see it)`;
          continue;
        }
        state.board = found;
        state.error = found.statusField ? null : `board ${board.owner}/${board.number} has no single-select field named ${state.settings.statusField}`;
      } catch (e) {
        state.error = message(e);
        this.noteError(`board ${board.owner}/${board.number}`, e);
      }
    }
  }

  // ============ TASKS -> ISSUES ============

  private repoState(repo: string): RepoState | undefined {
    return this.repos.get(repo.toLowerCase());
  }

  /** The repository a task goes to: the one its line names, else the first match rule, else the default. */
  private repoFor(task: string, info: TaskInfo | null): RepoState | null {
    const text = info?.description ?? "";
    const named = /\brepo:([\w.-]+\/[\w.-]+)/i.exec(text);
    if (named) return this.repoState(named[1]) ?? null;
    const explicit = explicitIssue(text, null, this.settings.repos.map((r) => r.repo));
    if (explicit) return this.repoState(explicit.repo) ?? null;
    for (const state of this.repos.values()) {
      const m = state.settings.match;
      if (m.tasks.some((re) => re.test(task)) || (info?.agent != null && m.agents.includes(info.agent))) return state;
    }
    for (const state of this.repos.values()) if (state.settings.default) return state;
    return null;
  }

  private marker(task: string): string {
    return `${MARKER_PREFIX}${sha(`${this.project}\0${task}`)} -->`;
  }

  private titleOf(task: string, info: TaskInfo | null): string {
    const description = oneLine(info?.description ?? "").replace(/\brepo:[\w.-]+\/[\w.-]+/gi, "").trim();
    return this.redact(oneLine(description ? `${task}: ${description}` : task), TITLE_MAX);
  }

  private bodyOf(task: string, info: TaskInfo | null): string {
    const description = this.redact(info?.description ?? "", BODY_MAX);
    return [
      description || `Task ${this.redact(task, 128)}.`,
      "",
      `_Tracked by Lair: this issue follows task \`${this.redact(task, 128)}\` of the project's plan (its column, its agent, closed when the task is done)._`,
      "",
      this.marker(task),
    ].join("\n");
  }

  private initialStatus(info: TaskInfo | null): TrackerStatus {
    return info?.agent != null && this.settings.fillAgents.includes(info.agent) ? "ready" : "backlog";
  }

  /**
   * The task's issue: the one linked already, else one its line names, else
   * the one an earlier create made (found by its marker), else an open issue
   * with its exact title, else (create_issues_for_new_tasks) a new one.
   */
  private async ensureLink(task: string, info: TaskInfo | null): Promise<TrackerLink | null> {
    const existing = this.store.getLink(this.project, task);
    if (existing) return existing;
    const state = this.repoFor(task, info);
    if (!state) {
      this.note(`task ${task}: no tracked repository takes it (its line names none, no match rule, no default)`);
      return null;
    }
    const repo = state.settings.repo;
    const status = this.initialStatus(info);

    const named = explicitIssue(info?.description ?? "", repo, this.settings.repos.map((r) => r.repo));
    if (named) {
      const issue = await this.client.getIssue(named.repo, named.number);
      if (issue && issue.state === "open" && !issue.isPullRequest) return this.link(task, named.repo, issue, status);
      this.note(`task ${task} names ${named.repo}#${named.number}, which is ${issue ? (issue.isPullRequest ? "a pull request" : "closed") : "not found"}: not linked`);
      return null;
    }

    const pending = this.store.getPending(this.project, task);
    if (pending) {
      const since = this.iso(Date.parse(pending.since) - 60_000);
      const made = await this.client.findIssueByMarker(pending.repo, pending.marker, since);
      if (made) return this.link(task, pending.repo, made, status);
    }

    // One search: the title Lair would give it starts with the task id
    const title = this.titleOf(task, info);
    const [same] = await this.client.findOpenIssuesByTitle(repo, task, [title, task]);
    if (same) return this.link(task, repo, same, status);

    if (!this.settings.createIssuesForNewTasks) return null;
    const milestone = await this.milestoneFor(state, task);
    const body = this.bodyOf(task, info);
    const marker = this.marker(task);
    const created = await this.write(
      {
        op: "create_issue",
        task,
        repo,
        issueNumber: null,
        value: title,
        wouldSend: { title, body, labels: state.settings.labels, milestone: milestone?.title ?? null },
      },
      async () => {
        // Recorded before it is sent: if the issue is made and the answer is lost, the next attempt finds it by its marker
        this.store.addPending(this.project, task, repo, marker, this.iso());
        return this.client.createIssue(repo, { title, body, labels: state.settings.labels, milestone: milestone?.number ?? null });
      },
    );
    if (!created.sent) return null;
    return this.link(task, repo, created.value, status);
  }

  private async link(task: string, repo: string, issue: Issue, status: TrackerStatus): Promise<TrackerLink> {
    const link: TrackerLink = {
      task,
      repo,
      issueNumber: issue.number,
      issueUrl: issue.url,
      projectItemId: null,
      status,
      agent: null,
      blockedKey: null,
      closedAs: null,
      closedSynced: false,
      linkedAt: this.iso(),
      syncedAt: null,
    };
    // The link is kept before anything else is sent: a failure from here on is retried by the reconcile, never a second issue
    this.store.addLink(this.project, link);
    await this.pushBoard(link, { status: true, agent: false }, issue.nodeId);
    return link;
  }

  private async milestoneFor(state: RepoState, task: string): Promise<Milestone | null> {
    const rule = state.settings.milestones.rules.find((r) => r.tasks.some((re) => re.test(task)));
    if (!rule) return null;
    const open = await this.openMilestones(state.settings.repo);
    const found = open.find((m) => m.title.toLowerCase() === rule.milestone.toLowerCase()) ?? null;
    if (!found) this.note(`milestone "${rule.milestone}" is not an open milestone of ${state.settings.repo}: issues are created without it`);
    return found;
  }

  private async openMilestones(repo: string, fresh = false): Promise<Milestone[]> {
    const cached = this.milestones.get(repo.toLowerCase());
    if (!fresh && cached && this.now() - cached.at < MILESTONE_CACHE_MS) return cached.open;
    const open = await this.client.listMilestones(repo, "open");
    this.milestones.set(repo.toLowerCase(), { at: this.now(), open });
    return open;
  }

  // ============ BOARD ============

  /**
   * Make the card match the link: on the board (added when missing), in
   * its column, with its agent. "failed": a write was tried and did not go
   * through (the reconcile tries again).
   */
  private async pushBoard(
    link: TrackerLink,
    which: { status: boolean; agent: boolean },
    nodeId?: string,
  ): Promise<"sent" | "observe" | "failed" | "no_board"> {
    const state = this.repoState(link.repo);
    const board = state?.board;
    if (!state || !board) return "no_board";
    let outcome: "sent" | "observe" | "failed" = "sent";
    if (!link.projectItemId) {
      let contentId = nodeId;
      if (!contentId) {
        const issue = await this.client.getIssue(link.repo, link.issueNumber);
        if (!issue) return "failed";
        contentId = issue.nodeId;
      }
      const added = await this.write(
        { op: "add_to_board", task: link.task, repo: link.repo, issueNumber: link.issueNumber, value: board.title, wouldSend: { board: board.url } },
        () => this.client.addToBoard(board.id, contentId!),
      );
      if (!added.sent) return added.why === "observe" ? "observe" : "failed";
      link.projectItemId = added.value;
      this.store.updateLink(this.project, link.task, { projectItemId: added.value }, this.iso());
      // A new card: its column and agent are set below whatever the caller changed
      which = { status: true, agent: link.agent !== null };
    }
    if (which.status && link.status && board.statusField) {
      const optionName = statusToOption(link.status, state.settings.statusOptions);
      const option = board.statusField.options.find((o) => o.name.toLowerCase() === optionName.toLowerCase());
      if (!option) {
        this.note(`board ${board.title} has no ${state.settings.statusField} option named ${optionName}`);
      } else {
        const set = await this.write(
          { op: "set_status", task: link.task, repo: link.repo, issueNumber: link.issueNumber, value: optionName, wouldSend: { status: optionName } },
          () => this.client.setSingleSelect(board.id, link.projectItemId!, board.statusField!.id, option.id),
        );
        // A failed write: nothing more for this card now (the reconcile tries it all again)
        if (!set.sent && set.why !== "observe") return "failed";
        if (!set.sent) outcome = "observe";
      }
    }
    if (which.agent && link.agent && board.agentField) {
      const agent = this.redact(oneLine(link.agent), AGENT_MAX);
      const set = await this.write(
        { op: "set_agent", task: link.task, repo: link.repo, issueNumber: link.issueNumber, value: agent, wouldSend: { agent } },
        () => this.client.setText(board.id, link.projectItemId!, board.agentField!.id, agent),
      );
      if (!set.sent && set.why !== "observe") outcome = "failed";
    }
    return outcome;
  }

  /** Lair wants the card in `status` (and with `agent`, when given): kept, then sent. */
  private async setStatus(link: TrackerLink, status: TrackerStatus, agent?: string | null): Promise<"sent" | "observe" | "failed" | "no_board" | "unchanged"> {
    const statusChanged = link.status !== status;
    const agentChanged = agent !== undefined && agent !== link.agent;
    if (!statusChanged && !agentChanged) return "unchanged";
    link.status = status;
    if (agent !== undefined) link.agent = agent;
    this.store.updateLink(this.project, link.task, { status, ...(agent !== undefined ? { agent } : {}) }, this.iso());
    return this.pushBoard(link, { status: statusChanged, agent: agentChanged });
  }

  // ============ DONE, DROPPED, BLOCKED ============

  /** The task is done (Done, issue closed as completed) or dropped (issue closed as not planned). */
  private async finish(task: string, reason: "completed" | "not_planned"): Promise<void> {
    const link = this.store.getLink(this.project, task);
    if (!link) return;
    if (reason === "completed") {
      const moved = await this.setStatus(link, "done");
      if (link.closedAs !== reason) {
        link.closedAs = reason;
        this.store.updateLink(this.project, task, { closedAs: reason }, this.iso());
      }
      // The issue closes after its card is in Done; a failed move leaves both to the reconcile
      if (moved === "failed") return;
    } else if (link.closedAs !== reason) {
      link.closedAs = reason;
      this.store.updateLink(this.project, task, { closedAs: reason }, this.iso());
    }
    await this.closeIssue(link);
  }

  private async closeIssue(link: TrackerLink): Promise<void> {
    if (!link.closedAs || link.closedSynced) return;
    const issue = await this.client.getIssue(link.repo, link.issueNumber);
    if (!issue) return;
    if (issue.state === "closed") {
      link.closedSynced = true;
      this.store.updateLink(this.project, link.task, { closedSynced: true }, this.iso());
      return;
    }
    const reason = link.closedAs;
    const closed = await this.write(
      { op: "close_issue", task: link.task, repo: link.repo, issueNumber: link.issueNumber, value: reason, wouldSend: { state: "closed", state_reason: reason } },
      () => this.client.closeIssue(link.repo, link.issueNumber, reason),
    );
    if (closed.sent) {
      link.closedSynced = true;
      this.store.updateLink(this.project, link.task, { closedSynced: true }, this.iso());
    }
  }

  /** A blocked task: the blocked label and one comment per reason (kept, so a repeat or a restart posts nothing). */
  private async block(task: string, cls: string, rule: string | null): Promise<void> {
    const link = this.store.getLink(this.project, task);
    if (!link || link.closedAs) return;
    const key = sha(`${cls}\0${rule ?? ""}`, 16);
    if (link.blockedKey === key) return;
    const label = this.settings.blockedLabel;
    const labelled = await this.write(
      { op: "add_label", task, repo: link.repo, issueNumber: link.issueNumber, value: label, wouldSend: { labels: [label] } },
      () => this.client.addLabels(link.repo, link.issueNumber, [label]),
    );
    if (!labelled.sent) return;
    const comment = this.redact(
      `Lair: this task is blocked (${cls}${rule ? `, ${rule}` : ""}). It waits for its cause to clear or for the owner; the ${label} label goes when it is released.`,
      COMMENT_MAX,
    );
    const commented = await this.write(
      { op: "add_comment", task, repo: link.repo, issueNumber: link.issueNumber, value: comment.slice(0, 120), wouldSend: { body: comment } },
      () => this.client.addComment(link.repo, link.issueNumber, comment),
    );
    if (!commented.sent) return;
    link.blockedKey = key;
    this.store.updateLink(this.project, task, { blockedKey: key }, this.iso());
  }

  private async unblock(link: TrackerLink): Promise<void> {
    if (!link.blockedKey) return;
    const label = this.settings.blockedLabel;
    const removed = await this.write(
      { op: "remove_label", task: link.task, repo: link.repo, issueNumber: link.issueNumber, value: label, wouldSend: { remove: label } },
      () => this.client.removeLabel(link.repo, link.issueNumber, label),
    );
    if (!removed.sent) return;
    link.blockedKey = null;
    this.store.updateLink(this.project, link.task, { blockedKey: null }, this.iso());
  }

  // ============ PULL REQUESTS ============

  /** The linked tasks a PR is for: the issues its body closes, and a task whose id ends its branch name. */
  private linksOfPull(repo: string, body: string, headRef: string): TrackerLink[] {
    const refs = closingRefs(body, repo);
    const out = new Map<string, TrackerLink>();
    for (const ref of refs) {
      if (!this.repoState(ref.repo)) continue; // never an issue of a repository the tracker doesn't track
      const link = this.store.getLinkByIssue(this.project, ref.repo, ref.number);
      if (link) out.set(link.task, link);
    }
    if (headRef) {
      for (const link of this.store.listLinks(this.project)) {
        if (link.repo.toLowerCase() === repo.toLowerCase() && (headRef === link.task || headRef.endsWith(`/${link.task}`))) out.set(link.task, link);
      }
    }
    return [...out.values()];
  }

  /** A PR the review module reviewed (In review) or merged (Done, issue closed). */
  private async onPull(number: number, what: "in_review" | "merged"): Promise<void> {
    const repo = this.settings.reviewRepo;
    if (!repo) return;
    const pull = await this.client.getPull(repo, number);
    if (!pull) return;
    for (const link of this.linksOfPull(repo, pull.body, pull.headRef)) {
      if (what === "merged") await this.finish(link.task, "completed");
      else if (!link.closedAs && link.status !== "done" && link.status !== "in_review") await this.setStatus(link, "in_review");
    }
  }

  // ============ RECONCILE ============

  /**
   * Make GitHub match: link the tasks that have no issue yet (the ones an
   * event missed, a create cut short), close the done ones, finish the
   * tasks whose PR was merged outside the review module, drop the ones
   * whose line was removed by hand, move the cards of open PRs to In
   * review, put back cards moved by hand, add missing cards, retry failed
   * closes, and close or reopen milestones.
   */
  async reconcile(): Promise<{ fixed: number; errors: string[] }> {
    const errors: string[] = [];
    const failuresBefore = this.writeFailures;
    let fixed = 0;
    try {
      if (!this.scopes.checked || (this.needsOwner && this.now() - this.scopesCheckedAt >= SCOPE_RECHECK_MS)) await this.checkScopes();
      await this.loadBoards();

      // Tasks: new ones linked, done ones finished
      const snapshot = await this.tasks.read().catch((e) => {
        errors.push(`the tasks file: ${message(e)}`);
        return null;
      });
      if (snapshot) {
        let linked = 0;
        for (const info of snapshot.open) {
          if (this.stopped || linked >= MAX_NEW_LINKS_PER_RECONCILE) break;
          if (this.store.getLink(this.project, info.task)) continue;
          linked++;
          await this.ensureLink(info.task, info).catch((e) => errors.push(`${info.task}: ${message(e)}`));
        }
        for (const task of snapshot.done) {
          const link = this.store.getLink(this.project, task);
          if (link && (link.closedAs !== "completed" || !link.closedSynced)) await this.finish(task, "completed").catch((e) => errors.push(`${task}: ${message(e)}`));
        }
      }

      // Merges first: a task whose PR merged is done, even if its line also went
      await this.reconcileMerges(errors);
      if (snapshot && !this.stopped) await this.reconcileRemoved(snapshot, errors);

      for (const state of this.repos.values()) {
        if (this.stopped) break;
        const repo = state.settings.repo;
        // Open PRs: their tasks are in review
        try {
          for (const pull of await this.client.listOpenPulls(repo)) {
            for (const link of this.linksOfPull(repo, pull.body, pull.headRef)) {
              if (!link.closedAs && link.status !== "done" && link.status !== "in_review") await this.setStatus(link, "in_review");
            }
          }
        } catch (e) {
          errors.push(`${repo} pull requests: ${message(e)}`);
        }
        try {
          fixed += await this.reconcileBoard(state);
        } catch (e) {
          errors.push(`${repo} board: ${message(e)}`);
        }
        for (const link of this.store.listLinks(this.project)) {
          if (link.repo.toLowerCase() === repo.toLowerCase() && link.closedAs && !link.closedSynced) {
            await this.closeIssue(link).catch((e) => errors.push(`${link.task}: ${message(e)}`));
          }
        }
        if (state.settings.milestones.closeWhenComplete) {
          await this.reconcileMilestones(repo).catch((e) => errors.push(`${repo} milestones: ${message(e)}`));
        }
      }
    } catch (e) {
      errors.push(message(e));
    } finally {
      const now = this.iso();
      this.store.patchState(this.project, { lastReconcileAt: now });
      this.store.cleanupWrites(this.project, this.iso(this.now() - KEEP_WRITES_DAYS * 86_400_000));
      if (errors.length > 0) for (const error of errors.slice(0, 5)) this.store.noteError(this.project, error);
      // Errors are cleared only by a reconcile in which every write it tried went through
      else if (!this.needsOwner && this.writeFailures === failuresBefore) this.store.clearErrors(this.project);
      this.scheduleReconcile();
    }
    return { fixed, errors };
  }

  /**
   * A PR merged by another path than the review module (a script's push,
   * `gh pr merge`, the web UI) emits no review.merged. For the linked tasks
   * In progress or In review, the closed PRs of each tracked repository are
   * read (one page, the newest update first: one request per repository)
   * and matched as review.submitted matches (the issues a PR closes, a task
   * id ending its branch name). A merged one finishes its tasks as
   * review.merged does (Done, the issue closed as completed), through the
   * write budget; one closed without merging changes nothing and is listed
   * in the status.
   */
  private async reconcileMerges(errors: string[]): Promise<void> {
    const waiting = (link: TrackerLink) => !link.closedAs && (link.status === "in_progress" || link.status === "in_review");
    if (!this.store.listLinks(this.project).some(waiting)) {
      this.closedUnmerged = [];
      return;
    }
    const merged = new Set<string>();
    const unmerged = new Map<string, TrackerUnmergedPull>();
    for (const state of this.repos.values()) {
      if (this.stopped) return;
      const repo = state.settings.repo;
      let pulls: Pull[];
      try {
        pulls = await this.client.listClosedPulls(repo, CLOSED_PULLS_PER_REPO);
      } catch (e) {
        errors.push(`${repo} closed pull requests: ${message(e)}`);
        continue;
      }
      for (const pull of pulls) {
        for (const link of this.linksOfPull(repo, pull.body, pull.headRef)) {
          if (!waiting(link)) continue;
          if (pull.merged) merged.add(link.task);
          else if (!unmerged.has(link.task)) unmerged.set(link.task, { task: link.task, prRepo: repo, pr: pull.number });
        }
      }
    }
    for (const task of merged) unmerged.delete(task);
    this.closedUnmerged = [...unmerged.values()];
    let finished = 0;
    for (const task of merged) {
      if (this.stopped || finished >= MAX_FINISHES_PER_RECONCILE) break;
      finished++;
      await this.finish(task, "completed").catch((e) => errors.push(`${task}: ${message(e)}`));
    }
  }

  /**
   * A linked task whose line left the tasks file and is not done was
   * removed or commented out by hand (the planner's own drop comes as an
   * event). Missed by REMOVED_AFTER_RECONCILES reconciles in a row, it
   * counts as dropped: with close_removed_tasks its issue is closed as not
   * planned (at most MAX_FINISHES_PER_RECONCILE a reconcile); without, a
   * would_close row is recorded and the status lists it. A task on a line
   * fill refuses (malformed, too long) is still in the file; a file with
   * no task line at all is taken for a broken write and counts nothing.
   * The count is kept in memory: a restart starts it again.
   */
  private async reconcileRemoved(snapshot: TasksSnapshot, errors: string[]): Promise<void> {
    const present = new Set<string>([...snapshot.open.map((t) => t.task), ...snapshot.done, ...snapshot.mentioned]);
    if (present.size === 0) return;
    const open = this.store.listLinks(this.project).filter((l) => !l.closedAs);
    const openTasks = new Set(open.map((l) => l.task));
    for (const task of [...this.missing.keys()]) if (!openTasks.has(task)) this.missing.delete(task);
    let closed = 0;
    for (const link of open) {
      if (present.has(link.task)) {
        this.missing.delete(link.task);
        continue;
      }
      const misses = (this.missing.get(link.task) ?? 0) + 1;
      this.missing.set(link.task, misses);
      if (misses < REMOVED_AFTER_RECONCILES) continue;
      if (!this.settings.closeRemovedTasks) {
        this.store.recordWrite(
          this.project,
          {
            task: link.task,
            repo: link.repo,
            issueNumber: link.issueNumber,
            op: "close_issue",
            value: "not_planned",
            mode: this.settings.mode,
            wouldSend: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
            result: "would_close",
            error: null,
            dedupeKey: sha(`would_close\0${link.repo}\0${link.issueNumber}\0${link.task}`),
          },
          this.iso(),
        );
        continue;
      }
      if (this.stopped || closed >= MAX_FINISHES_PER_RECONCILE) continue;
      closed++;
      this.missing.delete(link.task);
      await this.finish(link.task, "not_planned").catch((e) => errors.push(`${link.task}: ${message(e)}`));
    }
  }

  /** Cards moved by hand go back; missing cards are added. Returns the cards put back. */
  private async reconcileBoard(state: RepoState): Promise<number> {
    const board = state.board;
    if (!board) return 0;
    const items = await this.client.listBoardItems(board.id, state.settings.statusField, state.settings.agentField);
    const byIssue = new Map<string, BoardItem>();
    for (const item of items) {
      if (item.kind === "Issue" && item.repo && item.number !== null) byIssue.set(`${item.repo.toLowerCase()}#${item.number}`, item);
    }
    let fixed = 0;
    for (const link of this.store.listLinks(this.project)) {
      if (this.stopped) break;
      if (link.repo.toLowerCase() !== state.settings.repo.toLowerCase()) continue;
      const item = byIssue.get(`${link.repo.toLowerCase()}#${link.issueNumber}`);
      if (!item) {
        // Not on the board (never added, or taken off): added back, in its column
        if (link.projectItemId) {
          link.projectItemId = null;
          this.store.updateLink(this.project, link.task, { projectItemId: null }, this.iso());
        }
        await this.pushBoard(link, { status: true, agent: link.agent !== null });
        continue;
      }
      if (link.projectItemId !== item.id) {
        link.projectItemId = item.id;
        this.store.updateLink(this.project, link.task, { projectItemId: item.id }, this.iso());
      }
      const actual = item.status ? optionToStatus(item.status, state.settings.statusOptions) : null;
      const statusDrift = link.status !== null && actual !== link.status;
      const agentDrift = link.agent !== null && board.agentField !== null && (item.agent ?? "") !== this.redact(oneLine(link.agent), AGENT_MAX);
      if (!statusDrift && !agentDrift) continue;
      const outcome = await this.pushBoard(link, { status: statusDrift, agent: agentDrift });
      if (statusDrift && outcome === "sent") {
        fixed++;
        this.store.incrementDriftFixed(this.project);
      }
    }
    return fixed;
  }

  /** A milestone with closed issues and no open one closes; a closed one with an open issue reopens. Nothing else of it is touched. */
  private async reconcileMilestones(repo: string): Promise<void> {
    for (const m of await this.openMilestones(repo, true)) {
      if (m.openIssues !== 0 || m.closedIssues === 0) continue;
      await this.write(
        { op: "close_milestone", task: null, repo, issueNumber: null, value: m.title, wouldSend: { milestone: m.number, state: "closed" } },
        () => this.client.setMilestoneState(repo, m.number, "closed"),
      );
    }
    for (const m of await this.client.listMilestones(repo, "closed")) {
      if (m.openIssues === 0) continue;
      await this.write(
        { op: "reopen_milestone", task: null, repo, issueNumber: null, value: m.title, wouldSend: { milestone: m.number, state: "open" } },
        () => this.client.setMilestoneState(repo, m.number, "open"),
      );
    }
  }

  private note(text: string): void {
    if (this.notes.size >= 50 || this.notes.has(text)) return;
    this.notes.add(text);
    this.log.warn(`[tracker] ${this.project}: ${text}`);
  }

  // ============ STATUS ============

  status(): Omit<TrackerStatusView, "project" | "enabled" | "errors"> {
    return {
      running: this.running,
      mode: this.settings.mode,
      repos: [...this.repos.values()].map((s) => ({
        repo: s.settings.repo,
        default: s.settings.default,
        board: s.settings.board
          ? { owner: s.settings.board.owner, number: s.settings.board.number, loaded: s.board !== null, title: s.board?.title ?? null, url: s.board?.url ?? null }
          : null,
        error: s.error,
      })),
      scopes: this.scopes,
      syncState: this.store.getState(this.project),
      links: this.store.listLinks(this.project),
      pending: this.store.listPending(this.project),
      recentWrites: this.store.listWrites(this.project, 50),
      queue: { waiting: this.waiting, dropped: this.dropped },
      closedUnmerged: this.closedUnmerged,
      removedTasks: this.removedTasks(),
      warnings: [...this.settings.warnings, ...this.notes],
    };
  }

  private removedTasks(): TrackerRemovedTask[] {
    const out: TrackerRemovedTask[] = [];
    for (const [task, misses] of this.missing) {
      const link = this.store.getLink(this.project, task);
      if (!link || link.closedAs) continue;
      const action = misses < REMOVED_AFTER_RECONCILES ? "waiting" : this.settings.closeRemovedTasks ? "closing" : "would_close";
      out.push({ task, repo: link.repo, issueNumber: link.issueNumber, missedReconciles: misses, action });
    }
    return out;
  }
}
