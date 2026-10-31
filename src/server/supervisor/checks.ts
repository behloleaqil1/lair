/**
 * The self-checks, deterministic and in code. Each one measures one thing
 * and grades it against its thresholds (supervisor.checks.<id>):
 *
 *   server: event_loop_lag, request_latency, open_files, disk_free,
 *           store_size, command_timeouts
 *   project: module_errors, watcher_mode, infra_holds, machines,
 *            gate_queue_age, retention
 *
 * A check's words are Lair's own: counts, names of modules, lanes and
 * config keys, never a line of a log or of a command's output. A check that
 * doesn't apply to a project (no placement, no gate queue) returns null and
 * is not listed. The runner (service.ts) times each one out and keeps one
 * failing check from touching the others.
 */
import type { Dir } from "fs";
import { opendir, readdir, stat } from "fs/promises";
import { basename, join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type { CheckId, CheckResult, CheckStatus, CheckValue } from "../../shared/supervisor-types.js";
import type { PlacementStatus } from "../../shared/placement-types.js";
import type { Decision } from "../../shared/decision-types.js";
import type { AgentsStore } from "../agents/store.js";
import type { CommandTimeoutLog } from "../core/command-timeouts.js";
import type { ChecksSettings } from "./config.js";
import type { RequestLatency } from "./latency.js";
import type { OsMeasures } from "./measures.js";

/** What a project's module says of itself (its config errors and its last error stay server-side) */
export interface ModuleReport {
  module: string;
  /** The project's YAML turns it on */
  on: boolean;
  errors: string[];
  lastError: string | null;
  /** What it runs with but warns about, in Lair's own words (agents: fill patterns that can count a line for the wrong task) */
  warnings?: string[];
}

/** What the checks read, from the modules the server runs. Every source but the config is optional. */
export interface CheckSources {
  /** Lair's data folder (data/): the stores and their WAL files */
  dataDir: string;
  /** The project's config; throws when it can't be read */
  config(project: string): ProjectConfig;
  /** The folders the project's file watcher watches, and how; null without a watcher */
  watchers?(project: string): { dir: string; state: string }[] | null;
  /** Every module of the project, as it reports itself */
  modules?(project: string): ModuleReport[] | Promise<ModuleReport[]>;
  /** The agents module's store (null when no project runs it) */
  agentsStore?(): AgentsStore | null;
  /** Is the agents module on for the project? */
  agentsOn?(project: string): boolean;
  /** The agents module's open decisions in the project (the Decision Inbox) */
  agentDecisions?(project: string): Decision[];
  /** Placement's status (enabled: false when it is off) */
  placement?(project: string): PlacementStatus | null;
}

export interface CheckContext {
  now: number;
  settings: ChecksSettings;
  /** null for the server's own checks */
  project: string | null;
  sources: CheckSources;
  measures: OsMeasures;
  latency: RequestLatency;
  timeouts: CommandTimeoutLog;
  /** This check's previous result in the same scope, if any */
  previous?: CheckResult;
}

export interface Measured {
  status: CheckStatus;
  values: Record<string, CheckValue>;
  thresholds: Record<string, number>;
  explanation: string;
  fix: string | null;
}

export interface CheckDefinition {
  id: CheckId;
  scope: "server" | "project";
  title: string;
  /** null: the check doesn't apply here */
  measure(ctx: CheckContext): Promise<Measured | null>;
}

const MB = 1024 * 1024;
const GIB = 1024 * MB;
/** Entries listed per folder at most (a count past this is "at least") */
const MAX_LISTED = 200_000;
/** Request files looked at in the gate queue at most */
const MAX_QUEUE_FILES = 2000;
/** Stores looked at in data/ at most */
const MAX_STORES = 200;

const round = (n: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Higher is worse: failing at or past `failing`, warning at or past `warning`. */
export function gradeAbove(value: number, warning: number, failing: number): CheckStatus {
  if (value >= failing) return "failing";
  if (value >= warning) return "warning";
  return "ok";
}

/** Lower is worse: failing at or below `failing`, warning at or below `warning`. */
export function gradeBelow(value: number, warning: number, failing: number): CheckStatus {
  if (value <= failing) return "failing";
  if (value <= warning) return "warning";
  return "ok";
}

const ORDER: Record<CheckStatus, number> = { ok: 0, unknown: 1, warning: 2, failing: 3 };

/** The worse of two statuses (unknown is better than warning: it says nothing is known to be wrong) */
export function worse(a: CheckStatus, b: CheckStatus): CheckStatus {
  return ORDER[a] >= ORDER[b] ? a : b;
}

function unknown(explanation: string, values: Record<string, CheckValue> = {}, thresholds: Record<string, number> = {}): Measured {
  return { status: "unknown", values, thresholds, explanation, fix: null };
}

const list = (names: string[], max = 5) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;

// ============ SERVER ============

const eventLoopLag: CheckDefinition = {
  id: "event_loop_lag",
  scope: "server",
  title: "Event-loop lag",
  async measure({ measures, settings }: CheckContext): Promise<Measured | null> {
    const t = settings.event_loop_lag;
    const thresholds = { warning_ms: t.warning_ms, failing_ms: t.failing_ms };
    const delay = measures.eventLoopDelay();
    if (!delay) return unknown("The event loop's delay can't be measured on this system.", {}, thresholds);
    const status = gradeAbove(delay.p99Ms, t.warning_ms, t.failing_ms);
    return {
      status,
      values: { p99_ms: round(delay.p99Ms), max_ms: round(delay.maxMs), mean_ms: round(delay.meanMs) },
      thresholds,
      explanation:
        status === "ok"
          ? `The event loop answered within ${round(delay.p99Ms)} ms (p99) since the last check.`
          : `The event loop was blocked for up to ${round(delay.maxMs)} ms (p99 ${round(delay.p99Ms)} ms) since the last check: every request and timer waited that long.`,
      fix:
        status === "ok"
          ? null
          : "Something in Lair runs synchronously for too long: a large file read or a synchronous command on a request. Look in the server log for what ran then; restarting Lair clears a stuck state, and a lag that comes back is a defect to report.",
    };
  },
};

const requestLatency: CheckDefinition = {
  id: "request_latency",
  scope: "server",
  title: "Request latency (p95)",
  async measure({ latency, settings }: CheckContext): Promise<Measured | null> {
    const t = settings.request_latency;
    const thresholds = { warning_ms: t.warning_ms, failing_ms: t.failing_ms, min_requests: t.min_requests, window_minutes: t.window_minutes };
    const s = latency.summary(t.window_minutes * 60_000);
    const values = { requests: s.count, p95_ms: s.p95Ms, max_ms: s.maxMs, slowest_route: s.slowestRoute };
    if (s.count < t.min_requests || s.p95Ms === null) {
      return {
        status: "ok",
        values,
        thresholds,
        explanation: `${s.count} request(s) in the last ${t.window_minutes} min: too few to judge (${t.min_requests} needed).`,
        fix: null,
      };
    }
    const status = gradeAbove(s.p95Ms, t.warning_ms, t.failing_ms);
    return {
      status,
      values,
      thresholds,
      explanation: `95% of the ${s.count} requests in the last ${t.window_minutes} min answered within ${s.p95Ms} ms; the slowest took ${s.maxMs} ms (${s.slowestRoute}).`,
      fix:
        status === "ok"
          ? null
          : `Look at what ${s.slowestRoute} reads or runs: a command on the request path, a large folder or a busy store. A slow event loop (event_loop_lag) slows every route at once.`,
    };
  },
};

const openFiles: CheckDefinition = {
  id: "open_files",
  scope: "server",
  title: "Open files",
  async measure({ measures, settings }: CheckContext): Promise<Measured | null> {
    const t = settings.open_files;
    const thresholds = { warning_percent: t.warning_percent, failing_percent: t.failing_percent };
    const files = await measures.openFiles();
    if (!files) return unknown("Open files can't be counted on this system (no /proc, /dev/fd or lsof).", {}, thresholds);
    const values: Record<string, CheckValue> = { open: files.open, limit: files.limit, source: files.source };
    if (files.limit === null) {
      return unknown(`Lair has ${files.open} files open; the limit isn't known here, so it can't be judged.`, values, thresholds);
    }
    const percent = round((files.open / files.limit) * 100);
    values.percent = percent;
    const status = gradeAbove(percent, t.warning_percent, t.failing_percent);
    return {
      status,
      values,
      thresholds,
      explanation: `Lair has ${files.open} files open, ${percent}% of its limit (${files.limit}).`,
      fix:
        status === "ok"
          ? null
          : "Restart Lair to release them, and raise the limit (ulimit -n, systemd's LimitNOFILE or launchd's NumberOfFiles) if it fills again. A count that climbs steadily is a leak: report it with this check's history.",
    };
  },
};

const diskFree: CheckDefinition = {
  id: "disk_free",
  scope: "server",
  title: "Free disk",
  async measure({ measures, settings, sources }: CheckContext): Promise<Measured | null> {
    const t = settings.disk_free;
    const thresholds = { warning_percent: t.warning_percent, failing_percent: t.failing_percent, warning_gib: t.warning_gib, failing_gib: t.failing_gib };
    const space = await measures.diskSpace(sources.dataDir);
    if (!space || space.totalBytes <= 0) return unknown("The free space of the data folder's disk can't be read.", {}, thresholds);
    const percent = round((space.freeBytes / space.totalBytes) * 100);
    const gib = round(space.freeBytes / GIB);
    const status = worse(gradeBelow(percent, t.warning_percent, t.failing_percent), gradeBelow(gib, t.warning_gib, t.failing_gib));
    return {
      status,
      values: { free_gib: gib, total_gib: round(space.totalBytes / GIB), free_percent: percent },
      thresholds,
      explanation: `The disk that holds Lair's data folder has ${gib} GiB free (${percent}%).`,
      fix:
        status === "ok"
          ? null
          : "Free space on that disk: old logs and results in the projects' watched folders, old builds and caches. Lair's stores stop writing when it is full.",
    };
  },
};

/** The stores in data/ and their WAL files, by size. */
async function storeSizes(dataDir: string): Promise<{ name: string; bytes: number; walBytes: number }[]> {
  const names = (await readdir(dataDir)).filter((n) => n.endsWith(".db")).slice(0, MAX_STORES);
  const sizes: { name: string; bytes: number; walBytes: number }[] = [];
  for (const name of names) {
    const size = async (path: string) => {
      try {
        const s = await stat(path);
        return s.isFile() ? s.size : 0;
      } catch {
        return 0;
      }
    };
    sizes.push({ name, bytes: await size(join(dataDir, name)), walBytes: await size(join(dataDir, `${name}-wal`)) });
  }
  return sizes;
}

const storeSize: CheckDefinition = {
  id: "store_size",
  scope: "server",
  title: "Store sizes",
  async measure({ settings, sources, previous }: CheckContext): Promise<Measured | null> {
    const t = settings.store_size;
    const thresholds = { warning_mb: t.warning_mb, failing_mb: t.failing_mb, wal_warning_mb: t.wal_warning_mb, wal_failing_mb: t.wal_failing_mb };
    let stores: { name: string; bytes: number; walBytes: number }[];
    try {
      stores = await storeSizes(sources.dataDir);
    } catch {
      return unknown("Lair's data folder can't be listed.", {}, thresholds);
    }
    if (stores.length === 0) return { status: "ok", values: { stores: 0 }, thresholds, explanation: "No store has been written yet.", fix: null };
    const largest = stores.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    const wal = stores.reduce((a, b) => (b.walBytes > a.walBytes ? b : a));
    const totalWal = stores.reduce((n, s) => n + s.walBytes, 0);
    const previousWal = typeof previous?.values.wal_total_mb === "number" ? previous.values.wal_total_mb : null;
    const walTotalMb = round(totalWal / MB);
    const status = worse(gradeAbove(largest.bytes / MB, t.warning_mb, t.failing_mb), gradeAbove(wal.walBytes / MB, t.wal_warning_mb, t.wal_failing_mb));
    return {
      status,
      values: {
        stores: stores.length,
        total_mb: round(stores.reduce((n, s) => n + s.bytes, 0) / MB),
        largest: largest.name,
        largest_mb: round(largest.bytes / MB),
        largest_wal: wal.walBytes > 0 ? wal.name : null,
        wal_mb: round(wal.walBytes / MB),
        wal_total_mb: walTotalMb,
        wal_growth_mb: previousWal === null ? null : round(walTotalMb - previousWal),
      },
      thresholds,
      explanation: `The largest store is ${largest.name} (${round(largest.bytes / MB)} MB); the largest WAL file is ${round(wal.walBytes / MB)} MB${wal.walBytes > 0 ? ` (${wal.name})` : ""}.`,
      fix:
        status === "ok"
          ? null
          : "A store that keeps growing holds history no module prunes: note which one and report it. A WAL file that keeps growing means a reader holds the store open: restarting Lair checkpoints it.",
    };
  },
};

const commandTimeouts: CheckDefinition = {
  id: "command_timeouts",
  scope: "server",
  title: "Commands that time out",
  async measure({ timeouts, settings, now }: CheckContext): Promise<Measured | null> {
    const t = settings.command_timeouts;
    const thresholds = { warning: t.warning, failing: t.failing, window_minutes: t.window_minutes };
    const recent = timeouts.since(now - t.window_minutes * 60_000);
    const by = (kind: string) => recent.filter((e) => e.kind === kind).length;
    const programs = [...new Set(recent.map((e) => e.program))];
    const status = gradeAbove(recent.length, t.warning, t.failing);
    return {
      status,
      values: { timeouts: recent.length, status: by("status"), probe: by("probe"), git: by("git"), tool: by("tool"), programs: programs.length > 0 ? list(programs) : null },
      thresholds,
      explanation:
        recent.length === 0
          ? `No command timed out in the last ${t.window_minutes} min.`
          : `${recent.length} command(s) timed out in the last ${t.window_minutes} min (${list(programs)}).`,
      fix:
        status === "ok"
          ? null
          : "A machine or the network is slow or down, or a command waits for input. Run the program by hand from Lair's machine; the modules' command_timeout_seconds settings set how long Lair waits.",
    };
  },
};

// ============ PROJECT ============

const moduleErrors: CheckDefinition = {
  id: "module_errors",
  scope: "project",
  title: "Module start failures and errors",
  async measure({ sources, project }: CheckContext): Promise<Measured | null> {
    if (!project || !sources.modules) return null;
    const reports = await sources.modules(project);
    const on = reports.filter((r) => r.on);
    const failed = on.filter((r) => r.errors.length > 0).map((r) => r.module);
    const erroring = on.filter((r) => r.errors.length === 0 && r.lastError !== null).map((r) => r.module);
    const warned = on.filter((r) => r.errors.length === 0 && (r.warnings?.length ?? 0) > 0);
    const warnings = warned.flatMap((r) => r.warnings ?? []);
    const status: CheckStatus = failed.length > 0 ? "failing" : erroring.length > 0 || warned.length > 0 ? "warning" : "ok";
    return {
      status,
      values: {
        modules_on: on.length,
        failed: failed.length > 0 ? list(failed) : null,
        erroring: erroring.length > 0 ? list(erroring) : null,
        warned: warned.length > 0 ? list(warned.map((r) => r.module)) : null,
      },
      thresholds: {},
      explanation:
        failed.length > 0
          ? `${list(failed)} did not start: ${failed.length === 1 ? "its" : "their"} config has errors.`
          : erroring.length > 0
            ? `${list(erroring)} reported an error on ${erroring.length === 1 ? "its" : "their"} last round.`
            : warned.length > 0
              ? `${list(warned.map((r) => r.module))} run${warned.length === 1 ? "s" : ""} with a config warning: ${warnings.join("; ")}.`
              : `The ${on.length} module(s) the project turns on run without errors.`,
      fix:
        failed.length > 0
          ? `Open Settings for ${list(failed)}: each module's errors are shown in its section (and in its status route). Saving a valid config reloads it.`
          : erroring.length > 0
            ? `See ${list(erroring)}'s section for the error it reports; it is tried again on its next round.`
            : warned.length > 0
              ? `Change what each warning names in ${list(warned.map((r) => r.module))}'s settings (Settings, or the project's YAML); saving a valid config reloads it.`
              : null,
    };
  },
};

const watcherMode: CheckDefinition = {
  id: "watcher_mode",
  scope: "project",
  title: "File watcher",
  async measure({ sources, project }: CheckContext): Promise<Measured | null> {
    if (!project || !sources.watchers) return null;
    const watched = sources.watchers(project);
    if (!watched || watched.length === 0) return null;
    const polled = watched.filter((w) => w.state === "polling");
    const status: CheckStatus = polled.length > 0 ? "warning" : "ok";
    return {
      status,
      values: { folders: watched.length, watching: watched.filter((w) => w.state === "watching").length, polling: polled.length, polled: polled.length > 0 ? list(polled.map((w) => basename(w.dir))) : null },
      thresholds: {},
      explanation:
        polled.length > 0
          ? `${polled.length} of ${watched.length} watched folder(s) are polled every few seconds instead of watched: a folder that is missing, or one the system can't watch.`
          : `All ${watched.length} folder(s) are watched.`,
      fix:
        polled.length > 0
          ? "Create the missing folders (agents_dir, gates_dir/queue, gates_dir/results) or check their permissions; on Linux, raise fs.inotify.max_user_watches if watches run out. Polling works, only slower."
          : null,
    };
  },
};

/** The agents module's evidence, for one open decision, that its hold comes from the infrastructure. */
function infraEvidence(store: AgentsStore, project: string, decision: Decision): string[] {
  if (decision.key.startsWith("transient:")) return ["transient"];
  const prefix = `agents:${project}:task:`;
  const block = decision.blocks.find((b) => b.startsWith(prefix));
  if (!block) return [];
  const task = block.slice(prefix.length);
  const latest = store.latestRunForTask(project, task);
  if (!latest) return [];
  const chain = store.chainRuns(latest.chainId).slice(-20);
  const ids = new Set(chain.map((r) => r.id));
  const found = new Set<string>();
  if (chain.some((r) => r.detail.toLowerCase().startsWith("exit unknown"))) found.add("restart");
  for (const event of store.listEvents(project, { kinds: ["transient", "exit_unknown", "fill_weak"], task, limit: 50 })) {
    if (event.runId === undefined || !ids.has(event.runId)) continue;
    found.add(event.kind === "transient" ? "transient" : event.kind === "exit_unknown" ? "restart" : "stale_result");
  }
  return [...found];
}

const EVIDENCE_WORDS: Record<string, string> = {
  transient: "a transient provider or network error",
  restart: "a restart of Lair",
  stale_result: "a stale gate result",
};

const infraHolds: CheckDefinition = {
  id: "infra_holds",
  scope: "project",
  title: "Holds caused by the infrastructure",
  async measure({ sources, project, settings }: CheckContext): Promise<Measured | null> {
    if (!project || !sources.agentsOn?.(project)) return null;
    const store = sources.agentsStore?.() ?? null;
    if (!store) return null;
    const t = settings.infra_holds;
    const thresholds = { warning: t.warning, failing: t.failing };
    const open = sources.agentDecisions?.(project) ?? [];
    const kinds = { transient: 0, restart: 0, stale_result: 0 };
    let infra = 0;
    for (const decision of open.slice(0, 200)) {
      const evidence = infraEvidence(store, project, decision);
      if (evidence.length === 0) continue;
      infra++;
      for (const e of evidence) kinds[e as keyof typeof kinds]++;
    }
    const status = infra === 0 ? "ok" : gradeAbove(infra, t.warning, t.failing);
    const causes = Object.entries(kinds)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${EVIDENCE_WORDS[k]} (${n})`);
    return {
      status,
      values: { holds: open.length, infra, ...kinds },
      thresholds,
      explanation:
        infra === 0
          ? `None of the ${open.length} open hold(s) and escalation(s) of the agents points at the infrastructure.`
          : `${infra} hold(s) or escalation(s) wait for you whose evidence points at the infrastructure, not the work: ${causes.join(", ")}.`,
      fix:
        infra === 0
          ? null
          : "If the provider, the network or the machine is back, start them again: answer their decisions in Decisions (Start it again), or Release in Work. One that comes back after that failed for a reason of its own.",
    };
  },
};

const machines: CheckDefinition = {
  id: "machines",
  scope: "project",
  title: "Unreachable machines",
  async measure({ sources, project, settings, now }: CheckContext): Promise<Measured | null> {
    if (!project || !sources.placement) return null;
    const status = sources.placement(project);
    if (!status || !status.enabled || status.machines.length === 0) return null;
    const t = settings.machines;
    const down = status.machines.filter((m) => m.state === "down");
    const longest = down.reduce((n, m) => {
      const since = m.downSince ? Date.parse(m.downSince) : NaN;
      return Number.isFinite(since) ? Math.max(n, (now - since) / 60_000) : n;
    }, 0);
    const graded: CheckStatus = down.length === 0 ? "ok" : longest >= t.failing_minutes ? "failing" : "warning";
    return {
      status: graded,
      values: {
        machines: status.machines.length,
        up: status.machines.filter((m) => m.state === "up").length,
        down: down.length,
        down_ids: down.length > 0 ? list(down.map((m) => m.id)) : null,
        longest_down_minutes: down.length > 0 ? Math.round(longest) : null,
      },
      thresholds: { failing_minutes: t.failing_minutes },
      explanation:
        down.length === 0
          ? `All ${status.machines.length} placement machine(s) answer their probe.`
          : `${list(down.map((m) => m.id))} ${down.length === 1 ? "has" : "have"} failed ${down.length === 1 ? "its" : "their"} probe, for up to ${Math.round(longest)} min.`,
      fix:
        down.length === 0
          ? null
          : "Check that the machine is on and reachable from Lair (its placement probe: ssh, the network, a VPN). Jobs on its lanes wait; placement in act mode moves queued jobs to a machine that is up.",
    };
  },
};

const gateQueueAge: CheckDefinition = {
  id: "gate_queue_age",
  scope: "project",
  title: "Gate queue age",
  async measure({ sources, project, settings, now }: CheckContext): Promise<Measured | null> {
    if (!project) return null;
    const config = sources.config(project);
    if (!config.gates_dir) return null;
    const dir = join(config.gates_dir, "queue");
    const queued = await namesIn(dir, (n) => n.endsWith(".req"), MAX_QUEUE_FILES);
    if (queued === null) return null;
    const t = settings.gate_queue_age;
    const thresholds = { warning_minutes: t.warning_minutes, failing_minutes: t.failing_minutes };
    let oldest: { name: string; at: number } | null = null;
    for (const name of queued) {
      try {
        const s = await stat(join(dir, name));
        if (s.isFile() && (oldest === null || s.mtimeMs < oldest.at)) oldest = { name, at: s.mtimeMs };
      } catch {
        // Taken by a runner meanwhile
      }
    }
    if (!oldest) {
      return { status: "ok", values: { queued: 0, oldest_minutes: null, oldest_lane: null }, thresholds, explanation: "No gate request waits in the queue.", fix: null };
    }
    const minutes = Math.max(0, Math.round((now - oldest.at) / 60_000));
    const lane = oldest.name.split(".")[0] ?? null;
    const status = gradeAbove(minutes, t.warning_minutes, t.failing_minutes);
    return {
      status,
      values: { queued: queued.length, oldest_minutes: minutes, oldest_lane: lane },
      thresholds,
      explanation: `${queued.length} gate request(s) wait; the oldest has waited ${minutes} min on lane ${lane}.`,
      fix:
        status === "ok"
          ? null
          : `The runner of lane ${lane} isn't taking jobs: check that it is alive (the watchdog's gate_owner_gone), that its machine is up, and that the job ahead of it isn't stuck. Placement can move queued jobs to another lane.`,
    };
  },
};

/** The names in `dir` that `accept` takes, at most `cap` of them (the folder is read only that far); null when it can't be read. */
async function namesIn(dir: string, accept: (name: string) => boolean, cap: number): Promise<string[] | null> {
  let handle: Dir;
  try {
    handle = await opendir(dir, { bufferSize: 256 });
  } catch {
    return null;
  }
  const names: string[] = [];
  try {
    for await (const entry of handle) {
      if (accept(entry.name)) names.push(entry.name);
      if (names.length >= cap) break;
    }
  } catch {
    // The folder went away while it was read: what was listed stands
  }
  return names;
}

/** Entries in `dir`, counting up to `cap`; null when it can't be read. */
async function countEntries(dir: string, cap: number): Promise<{ count: number; capped: boolean } | null> {
  let handle: Dir;
  try {
    handle = await opendir(dir, { bufferSize: 256 });
  } catch {
    return null;
  }
  let count = 0;
  try {
    // The loop closes the folder when it ends, also by the return
    for await (const entry of handle) {
      void entry;
      if (++count >= cap) return { count, capped: true };
    }
  } catch {
    // The folder went away while it was read: what was counted stands
  }
  return { count, capped: false };
}

const retention: CheckDefinition = {
  id: "retention",
  scope: "project",
  title: "Files per watched folder",
  async measure({ sources, project, settings }: CheckContext): Promise<Measured | null> {
    if (!project) return null;
    const config = sources.config(project);
    const t = settings.retention;
    const thresholds = { warning_entries: t.warning_entries, failing_entries: t.failing_entries };
    const folders: [string, string][] = [];
    if (config.agents_dir) folders.push(["agents_dir", config.agents_dir]);
    if (config.gates_dir) {
      folders.push(["gates_dir/results", join(config.gates_dir, "results")]);
      folders.push(["gates_dir/queue", join(config.gates_dir, "queue")]);
    }
    const cap = Math.min(MAX_LISTED, t.failing_entries * 2);
    let largest: { name: string; count: number; capped: boolean } | null = null;
    let read = 0;
    for (const [name, dir] of folders) {
      const counted = await countEntries(dir, cap);
      if (!counted) continue;
      read++;
      if (!largest || counted.count > largest.count) largest = { name, ...counted };
    }
    if (!largest) return null;
    const status = gradeAbove(largest.count, t.warning_entries, t.failing_entries);
    const shown = `${largest.capped ? "at least " : ""}${largest.count}`;
    return {
      status,
      values: { folders: read, largest_folder: largest.name, largest_entries: largest.count, capped: largest.capped },
      thresholds,
      explanation: `The fullest watched folder is ${largest.name}, with ${shown} entries.`,
      fix:
        status === "ok"
          ? null
          : `Archive or delete old logs and results from ${largest.name}: every listing the dashboard, the watchdog and fill make reads the whole folder.`,
    };
  },
};

export const CHECKS: readonly CheckDefinition[] = [
  eventLoopLag,
  requestLatency,
  openFiles,
  diskFree,
  storeSize,
  commandTimeouts,
  moduleErrors,
  watcherMode,
  infraHolds,
  machines,
  gateQueueAge,
  retention,
];

export function checkDefinition(id: CheckId): CheckDefinition | undefined {
  return CHECKS.find((c) => c.id === id);
}
