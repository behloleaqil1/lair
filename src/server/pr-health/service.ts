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
 * 4. Then, for each (repo, PR, head) with open findings: its owner (owner.ts)
 *    and what act mode would do (plan.ts). A new finding's event carries it.
 *
 * Observe only: it emits events and serves a status, and writes nothing.
 */
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import { tokenFrom, type FetchLike } from "../review/github.js";
import type { GitHost, HostCommit, HostPullRequest } from "../review/host.js";
import { newestChecks, RepoHosts, type RepoEntry } from "../repos/index.js";
import { actBlockedReason, KINDS, parsePrHealthConfig, type PrHealthSettings } from "./config.js";
import { findingKey, kindsOf, readOrder, skipReason } from "./detect.js";
import { ownerOf, type FillSource, type OwnerInputs } from "./owner.js";
import { plan, type PlanGroup } from "./plan.js";
import type { ClearedWhy, FindingView, Planned, PrFacts, PrHealthStatus, PrHealthTick, RepoView } from "./types.js";

type Log = Pick<Console, "warn" | "log">;

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
  /** The agents module: fill's last check names the owners (none: nobody owns a PR) */
  agents?: FillSource;
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
  /** The open PRs of the last successful list */
  prs: Map<number, HostPullRequest>;
}

export class PrHealth {
  readonly project: string;
  readonly settings: PrHealthSettings;
  private readonly config: ProjectConfig;
  private readonly events?: EventBus;
  private readonly agents?: FillSource;
  private readonly log: Log;
  private readonly now: () => number;
  private readonly firstTickMs: number;
  private readonly hosts: RepoHosts;
  private readonly repos = new Map<string, RepoState>();
  private readonly findings = new Map<string, FindingView>();
  /** Findings opened this tick: their event goes out once their owner is known */
  private opened: FindingView[] = [];
  /** The head commit's committer date per <repo>#<pr>@<head> (null: not known), read once */
  private readonly pushTimes = new Map<string, number | null>();
  private planned: Planned[] = [];
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
    this.agents = options.agents;
    this.log = options.log ?? console;
    this.now = options.now ?? (() => Date.now());
    this.firstTickMs = options.firstTickMs ?? 1000;
    const baseFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
    const timeoutMs = this.settings.requestTimeoutSeconds * 1000;
    this.hosts = new RepoHosts({
      repos: this.settings.repos,
      apiUrl: this.settings.apiUrl,
      token: tokenFrom(this.settings.tokenEnv, this.settings.tokenCmd, options.env ?? process.env),
      fetch: async (url, init) => {
        this.spend();
        // The host passes its own timeout signal; a request without one still ends at the request timeout
        return baseFetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
      },
      timeoutMs,
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
      this.repos.set(entry.repo, { view, cache: new Map(), unread: new Set(), prs: new Map() });
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

  /** Its event goes out at the end of the tick, with its owner. */
  private open(view: FindingView): void {
    this.findings.set(view.key, view);
    this.opened.push(view);
  }

  private announce(view: FindingView): void {
    const owner = view.owner === "unknown" ? null : view.owner;
    this.log.warn(`[pr-health] ${this.project}: ${view.repo}#${view.pr} ${view.kind} (owner ${owner ? (owner.agent ?? "none") : "unknown"})`);
    void this.events?.emit("pr_health.finding", {
      project: this.project,
      key: view.key,
      repo: view.repo,
      pr: view.pr,
      head: view.head,
      kind: view.kind,
      owner: owner?.agent ?? null,
      ownerSource: owner?.source ?? null,
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
    // A PR missing from a full page may still be open: its cached facts stay
    if (!state.view.truncated) for (const n of state.cache.keys()) if (!openNow.has(n)) state.cache.delete(n);
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
          const pending = "the owner is worked out at the end of the tick";
          this.open({ key, repo: entry.repo, pr: pr.number, head, kind, since: now, clearingSince: null, owner: "unknown", ownerReason: pending, noticeId: null });
        }
      } else if (open && !unknown.has(kind)) {
        open.clearingSince ??= now;
        if (now - open.clearingSince >= this.settings.clearMinutes * 60_000) this.clear(open, "fixed");
      }
    }
  }

  // ============ OWNERS ============

  /** The head commit's committer date (epoch ms, or null: not known), read once per (repo, PR, head). */
  private async pushedAt(state: RepoState, pr: number, head: string): Promise<number | null> {
    const key = `${state.view.repo}#${pr}@${head}`;
    if (this.pushTimes.has(key)) return this.pushTimes.get(key) ?? null;
    if (state.view.state === "error") throw new Error("the repository could not be read this tick");
    let commits: HostCommit[];
    try {
      commits = await this.hosts.host(state.view.repo).listCommits(pr);
    } catch (e) {
      throw new Error(errorText(e));
    }
    const ms = Date.parse(commits.find((c) => c.sha === head)?.committedAt ?? "");
    const at = Number.isFinite(ms) ? ms : null;
    this.pushTimes.set(key, at);
    return at;
  }

  /** Each (repo, PR, head) with open findings gets its owner; returns them with the facts a note needs. */
  private async assignOwners(now: number): Promise<PlanGroup[]> {
    const inputs: OwnerInputs = {
      fill: this.agents?.get(this.project)?.fillStatus() ?? null,
      repos: this.settings.repos,
      authors: this.settings.authors,
      branchWindowMinutes: this.settings.branchWindowMinutes,
      config: this.config,
      now,
    };
    const heads = new Map<string, FindingView[]>();
    for (const f of this.findings.values()) {
      const key = `${f.repo}#${f.pr}@${f.head}`;
      heads.set(key, [...(heads.get(key) ?? []), f]);
    }
    for (const key of this.pushTimes.keys()) if (!heads.has(key)) this.pushTimes.delete(key);
    const groups: PlanGroup[] = [];
    for (const list of heads.values()) {
      const { repo, pr, head } = list[0];
      const state = this.repos.get(repo) as RepoState;
      const listed = state.prs.get(pr);
      const result = await ownerOf({ repo, number: pr, headRef: listed?.headRef ?? "" }, inputs, () => this.pushedAt(state, pr, head));
      for (const f of list) {
        f.owner = "owner" in result ? result.owner : "unknown";
        f.ownerReason = "unknown" in result ? result.unknown : null;
      }
      const facts = state.cache.get(pr);
      const updated = Date.parse(listed?.updatedAt ?? "");
      groups.push({
        repo,
        pr,
        head,
        kinds: list.map((f) => f.kind),
        owner: result,
        base: state.view.base,
        behindBy: facts?.behindBy ?? 0,
        failing: facts?.checks?.filter((c) => c.state === "failure").length ?? 0,
        quietMinutes: Number.isFinite(updated) ? Math.max(0, Math.floor((now - updated) / 60_000)) : 0,
      });
    }
    return groups;
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
    let listed = false;
    view.partial = false;
    try {
      const base = await this.hosts.base(entry.repo);
      view.base = base;
      const open = await host.listOpenPullRequests();
      listed = true;
      Object.assign(view, { state: "ok", error: null, truncated: open.length >= LIST_PAGE, lastReadAt: now });
      state.prs = new Map(open.map((p) => [p.number, p]));
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
      // Partial only means some PRs of a list went unread: a tick that never listed reads nothing new
      if (e instanceof Spent) view.partial = listed;
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
      this.planned = plan(await this.assignOwners(now), this.settings);
      for (const view of this.opened.splice(0)) if (this.findings.has(view.key)) this.announce(view);
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
      findings: [...this.findings.values()].map((f) => ({ ...f, owner: f.owner === "unknown" ? f.owner : { ...f.owner } })),
      planned: this.planned.map((p) => ("argv" in p && p.argv ? { ...p, argv: [...p.argv] } : { ...p })),
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

/** The startup log line for the projects PR health watches. */
export function startedLine(projects: string[]): string {
  return projects.length > 0 ? `[pr-health] Watching PRs for: ${projects.join(", ")}` : "[pr-health] Off (no project sets pr_health.enabled)";
}

/** Every project's PR health. */
export class PrHealthManager {
  private readonly monitors = new Map<string, PrHealth>();
  private readonly problems = new Map<string, string[]>();
  private phase: "loaded" | "started" | "stopped" = "loaded";

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
        // A project that does not turn PR health on is not warned about (its errors are in the status)
        const on = (entry.config.pr_health as { enabled?: unknown } | undefined)?.enabled === true;
        if (on) (this.options.log ?? console).warn(`[pr-health] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (!parsed.settings.enabled) continue;
      this.monitors.set(entry.name, new PrHealth({ ...this.options, project: entry.name, config: entry.config, settings: parsed.settings }));
    }
  }

  /** Start every project's timer; returns the projects that watch something. */
  start(): string[] {
    this.phase = "started";
    for (const monitor of this.monitors.values()) monitor.start();
    return [...this.monitors.values()].filter((m) => m.running).map((m) => m.project);
  }

  /** A changed project file: stop the project's instance, then start it from the new config (none: off). */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.phase === "stopped") return;
    await this.monitors.get(entry.name)?.stop();
    this.monitors.delete(entry.name);
    this.problems.delete(entry.name);
    this.load([entry]);
    if (this.phase === "started") this.monitors.get(entry.name)?.start();
  }

  async stop(): Promise<void> {
    this.phase = "stopped";
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
