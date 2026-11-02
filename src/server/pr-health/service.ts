/**
 * PR health: one PrHealth per project with `pr_health.enabled: true`
 * (docs/configuration.md#pr-health, docs/design/pr-health.md section 4.4).
 *
 * Every interval_seconds, one tick reads each listed repository in config
 * order, each in its own try/catch, under one request budget
 * (max_requests_per_tick) and one deadline (half the interval) per tick:
 * 1. its open PRs (one page of 100) and its base tip;
 * 2. each PR that is not skipped (ignored_prs, ignored_branches, a PR into
 *    another branch), at most max_prs_per_repo, PRs left unread last tick
 *    first: the PR itself (for mergeable) and compare when the head or base
 *    tip moved or mergeable was unknown, and the checks unless they were
 *    settled at this head. An unchanged PR with settled checks costs nothing;
 * 3. its kinds (detect.ts), kept as findings until clear_minutes of
 *    successful reads without them. A moved head, a closed PR and a PR that
 *    became ignored clear at once.
 * A host error (a timeout, a rate-limit answer, any failure) stops that
 * repository for the tick and keeps its findings exactly as they were, so
 * nothing is cleared or found again when it recovers. The budget and the
 * deadline stop it the same way and mark it partial.
 *
 * Observe only: it emits events and serves a status, and writes nothing.
 */
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import { tokenFrom, type FetchLike } from "../review/github.js";
import type { GitHost, HostPullRequest } from "../review/host.js";
import { newestChecks, RepoHosts, type RepoEntry } from "../repos/index.js";
import { actBlockedReason, KINDS, parsePrHealthConfig, type PrHealthSettings } from "./config.js";
import { findingKey, kindsOf, readOrder, skipReason } from "./detect.js";
import type { ClearedWhy, FindingView, PrFacts, PrHealthStatus, PrHealthTick, RepoView } from "./types.js";

type Log = Pick<Console, "warn" | "log">;

const OWNER_PENDING = "this version works out no owner (the owner rule comes next)";
/** A full page of the open-PR list: more PRs may exist */
const LIST_PAGE = 100;

/** The tick's request budget or deadline ran out, or PR health stopped: the repository stops, partial, not in error. */
class Spent extends Error {}

const iso = (ms: number) => new Date(ms).toISOString();
const errorText = (e: unknown) =>
  (e instanceof Error ? (e.name === "TimeoutError" ? `timed out: ${e.message}` : e.message) : String(e)).replace(/\s+/g, " ").trim().slice(0, 300);

export interface PrHealthOptions {
  project: string;
  config: ProjectConfig;
  settings: PrHealthSettings;
  events?: EventBus;
  /** Tests stand in for the git host's API here (the only stand-in) */
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: Log;
  /** Delay of the first tick after start() (default 1 s) */
  firstTickMs?: number;
}

interface RepoState {
  view: RepoView;
  cache: Map<number, PrFacts>;
  /** PRs that were due last tick and not read (the cap, the budget or an error): read first */
  unread: Set<number>;
}

export class PrHealth {
  readonly project: string;
  readonly settings: PrHealthSettings;
  private readonly config: ProjectConfig;
  private readonly events?: EventBus;
  private readonly log: Log;
  private readonly now: () => number;
  private readonly firstTickMs: number;
  private readonly hosts: RepoHosts;
  private readonly repos = new Map<string, RepoState>();
  private readonly findings = new Map<string, FindingView>();
  private budget = { used: 0, deadline: 0 };

  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<PrHealthTick | null> | null = null;
  private stopped = true;
  /** stop() was called: a tick in progress ends at its next request */
  private halted = false;
  private startedAt: number | null = null;
  private lastFinishedAt: number | null = null;
  lastTick: PrHealthTick | null = null;
  lastError: string | null = null;

  constructor(options: PrHealthOptions) {
    this.project = options.project;
    this.config = options.config;
    this.settings = options.settings;
    this.events = options.events;
    this.log = options.log ?? console;
    this.now = options.now ?? (() => Date.now());
    this.firstTickMs = options.firstTickMs ?? 1000;
    const send = options.fetch ?? ((url, init) => fetch(url, init));
    this.hosts = new RepoHosts({
      repos: this.settings.repos,
      apiUrl: this.settings.apiUrl,
      token: tokenFrom(this.settings.tokenEnv, this.settings.tokenCmd, options.env ?? process.env),
      fetch: async (url, init) => {
        this.spend();
        return send(url, init);
      },
      timeoutMs: this.settings.requestTimeoutSeconds * 1000,
      now: this.now,
    });
    for (const entry of this.settings.repos) {
      const view: RepoView = {
        repo: entry.repo,
        base: entry.base,
        ciCounts: entry.ciCounts,
        state: "inactive",
        error: null,
        partial: false,
        truncated: false,
        lastReadAt: null,
        prsRead: 0,
        skipped: [],
      };
      this.repos.set(entry.repo, { view, cache: new Map(), unread: new Set() });
    }
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** Every request of a tick passes here before it goes out. */
  private spend(): void {
    if (this.halted) throw new Spent("PR health stopped");
    if (this.budget.used >= this.settings.maxRequestsPerTick) throw new Spent(`the tick's ${this.settings.maxRequestsPerTick} requests are spent`);
    if (this.now() >= this.budget.deadline) throw new Spent("the tick's deadline (half the interval) passed");
    this.budget.used++;
  }

  // ============ FINDINGS ============

  private open(view: FindingView): void {
    this.findings.set(view.key, view);
    this.log.warn(`[pr-health] ${this.project}: ${view.repo}#${view.pr} ${view.kind} (owner unknown)`);
    void this.events?.emit("pr_health.finding", {
      project: this.project,
      key: view.key,
      repo: view.repo,
      pr: view.pr,
      head: view.head,
      kind: view.kind,
      owner: null,
      ownerSource: null,
      mode: this.settings.mode,
    });
  }

  private clear(view: FindingView, why: ClearedWhy): void {
    this.findings.delete(view.key);
    const { key, repo, pr, head, kind } = view;
    void this.events?.emit("pr_health.cleared", { project: this.project, key, repo, pr, head, kind, why });
  }

  private findingsOf(repo: string, pr?: number): FindingView[] {
    return [...this.findings.values()].filter((f) => f.repo === repo && (pr === undefined || f.pr === pr));
  }

  /** After a successful list: PRs no longer open (when the list is whole) and PRs now skipped lose their findings. */
  private clearGone(state: RepoState, open: HostPullRequest[], skipped: RepoView["skipped"]): void {
    const openNow = new Set(open.map((p) => p.number));
    const skippedNow = new Set(skipped.map((s) => s.pr));
    for (const f of this.findingsOf(state.view.repo)) {
      if (!openNow.has(f.pr)) {
        if (!state.view.truncated) this.clear(f, "closed");
      } else if (skippedNow.has(f.pr)) this.clear(f, "ignored");
    }
    for (const n of state.cache.keys()) if (!openNow.has(n)) state.cache.delete(n);
  }

  /** One read PR's kinds against its open findings. */
  private apply(entry: RepoEntry, pr: HostPullRequest, facts: PrFacts, now: number): void {
    const { found, unknown } = kindsOf(pr, facts, entry, this.settings, now);
    for (const f of this.findingsOf(entry.repo, pr.number)) if (f.head !== facts.headSha) this.clear(f, "head_moved");
    for (const kind of KINDS) {
      const key = findingKey(entry.repo, pr.number, facts.headSha, kind);
      const open = this.findings.get(key);
      if (found.has(kind)) {
        if (open) open.clearingSince = null;
        else {
          const head = facts.headSha;
          this.open({ key, repo: entry.repo, pr: pr.number, head, kind, since: now, clearingSince: null, owner: "unknown", ownerReason: OWNER_PENDING, noticeId: null });
        }
      } else if (open && !unknown.has(kind)) {
        open.clearingSince ??= now;
        if (now - open.clearingSince >= this.settings.clearMinutes * 60_000) this.clear(open, "fixed");
      }
    }
  }

  // ============ READING ============

  /** A PR's facts, from the cache where nothing it depends on moved. */
  private async factsOf(host: GitHost, entry: RepoEntry, pr: HostPullRequest, baseTip: string, cache: Map<number, PrFacts>): Promise<PrFacts> {
    const prev = cache.get(pr.number);
    let facts: PrFacts;
    if (!prev || prev.headSha !== pr.headSha || prev.baseTip !== baseTip || prev.mergeable === null) {
      // The list has no mergeable: only the PR itself says
      const detail = await host.getPullRequest(pr.number);
      const { behindBy } = await host.compare(baseTip, detail.headSha);
      const kept = prev?.checksHead === detail.headSha ? prev : null;
      facts = {
        headSha: detail.headSha,
        baseTip,
        mergeable: detail.mergeable,
        behindBy,
        checks: kept?.checks ?? null,
        checksHead: kept?.checksHead ?? null,
        checksSettled: kept?.checksSettled ?? false,
      };
    } else facts = { ...prev };
    // Pending, missing or red checks are read again every tick (a re-run or a late run is seen)
    if (entry.ciCounts && !(facts.checksSettled && facts.checksHead === facts.headSha)) {
      const checks = newestChecks(await host.listChecks(facts.headSha));
      const settled = checks.length > 0 && checks.every((c) => c.state === "success" || c.state === "skipped");
      facts = { ...facts, checks, checksHead: facts.headSha, checksSettled: settled };
    }
    cache.set(pr.number, facts);
    return facts;
  }

  /** One repository; returns how many PRs were read. Whatever was not read keeps its findings. */
  private async readRepo(entry: RepoEntry, now: number): Promise<number> {
    const state = this.repos.get(entry.repo) as RepoState;
    const { view } = state;
    const wasError = view.state === "error";
    const host = this.hosts.host(entry.repo);
    let read = 0;
    view.partial = false;
    try {
      const base = await this.hosts.base(entry.repo);
      view.base = base;
      const open = await host.listOpenPullRequests();
      Object.assign(view, { state: "ok", error: null, truncated: open.length >= LIST_PAGE, lastReadAt: now });
      const skipped: RepoView["skipped"] = [];
      const due: HostPullRequest[] = [];
      for (const pr of open) {
        const why = skipReason(pr, entry.repo, base, this.settings);
        if (why) skipped.push({ pr: pr.number, why });
        else due.push(pr);
      }
      this.clearGone(state, open, skipped);
      const ordered = readOrder(due, state.unread);
      for (const pr of ordered.slice(this.settings.maxPrsPerRepo)) skipped.push({ pr: pr.number, why: "max_prs_per_repo" });
      view.skipped = skipped;
      state.unread = new Set(ordered.map((p) => p.number));
      const baseTip = await host.branchHead(base);
      for (const pr of ordered.slice(0, this.settings.maxPrsPerRepo)) {
        const facts = await this.factsOf(host, entry, pr, baseTip, state.cache);
        this.apply(entry, pr, facts, now);
        state.unread.delete(pr.number);
        read++;
      }
    } catch (e) {
      if (e instanceof Spent) view.partial = true;
      else {
        view.state = "error";
        view.error = errorText(e);
        if (!wasError) {
          this.log.warn(`[pr-health] ${this.project}: ${entry.repo}: ${view.error}`);
          void this.events?.emit("pr_health.repo_error", { project: this.project, repo: entry.repo, error: view.error });
        }
      }
    }
    view.prsRead = read;
    return read;
  }

  // ============ THE TICK ============

  /** One tick; ticks never overlap (a call during one returns it). */
  tick(): Promise<PrHealthTick | null> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(): Promise<PrHealthTick | null> {
    const now = this.now();
    this.budget = { used: 0, deadline: now + this.settings.intervalSeconds * 500 };
    try {
      let prsRead = 0;
      for (const entry of this.settings.repos) prsRead += await this.readRepo(entry, now);
      this.lastError = null;
      const done = this.now();
      this.lastTick = { at: iso(now), durationMs: done - now, requests: this.budget.used, prsRead, findings: this.findings.size };
      this.lastFinishedAt = done;
      return this.lastTick;
    } catch (e) {
      this.lastError = `tick failed: ${errorText(e)}`;
      this.log.warn(`[pr-health] ${this.project}: ${this.lastError}`);
      return null;
    }
  }

  // ============ LIFECYCLE ============

  /** Start the timer (nothing to watch: no timer). The next tick is scheduled when the last one ends. */
  start(): void {
    if (!this.stopped || this.settings.inactive !== null || this.settings.repos.length === 0) return;
    this.stopped = false;
    this.halted = false;
    this.startedAt = this.now();
    const loop = async () => {
      if (this.stopped) return;
      await this.tick();
      if (this.stopped) return;
      this.timer = setTimeout(() => void loop(), this.settings.intervalSeconds * 1000);
      this.timer.unref();
    };
    this.timer = setTimeout(() => void loop(), this.firstTickMs);
    this.timer.unref();
  }

  /** Stop: a tick in progress ends at its next request. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.halted = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.ticking?.catch(() => undefined);
  }

  status(): PrHealthStatus {
    const now = this.now();
    // The last tick that finished, or when the first one was due
    const since = this.lastFinishedAt ?? (this.startedAt === null ? null : this.startedAt + this.firstTickMs);
    return {
      project: this.project,
      enabled: true,
      running: this.running,
      mode: this.settings.mode,
      actBlocked: actBlockedReason(this.config, this.settings),
      inactive: this.settings.inactive,
      intervalSeconds: this.settings.intervalSeconds,
      lastTick: this.lastTick,
      lastError: this.lastError,
      stale: this.running && since !== null && now - since > 3 * this.settings.intervalSeconds * 1000,
      repos: [...this.repos.values()].map(({ view }) => ({ ...view, skipped: view.skipped.map((s) => ({ ...s })) })),
      findings: [...this.findings.values()].map((f) => ({ ...f })),
      planned: [],
    };
  }
}

// ============ MANAGER ============

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  error?: string;
}

export type PrHealthManagerOptions = Omit<PrHealthOptions, "project" | "config" | "settings">;

/** Every project's PR health. */
export class PrHealthManager {
  private readonly monitors = new Map<string, PrHealth>();
  private readonly problems = new Map<string, string[]>();

  constructor(private readonly options: PrHealthManagerOptions = {}) {}

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }
      const parsed = parsePrHealthConfig(entry.config);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        (this.options.log ?? console).warn(`[pr-health] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (!parsed.settings.enabled) continue;
      this.monitors.set(entry.name, new PrHealth({ ...this.options, project: entry.name, config: entry.config, settings: parsed.settings }));
    }
  }

  /** Start every project's timer; returns the projects that watch something. */
  start(): string[] {
    for (const monitor of this.monitors.values()) monitor.start();
    return [...this.monitors.values()].filter((m) => m.running).map((m) => m.project);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.monitors.values()].map((m) => m.stop()));
    this.monitors.clear();
  }

  get(project: string): PrHealth | undefined {
    return this.monitors.get(project);
  }

  status(project: string): PrHealthStatus {
    const monitor = this.monitors.get(project);
    if (monitor) return monitor.status();
    return {
      project,
      enabled: false,
      running: false,
      mode: null,
      actBlocked: null,
      inactive: null,
      intervalSeconds: null,
      lastTick: null,
      lastError: this.problems.get(project)?.join("; ") ?? null,
      stale: false,
      repos: [],
      findings: [],
      planned: [],
    };
  }
}
