/**
 * Detectors: read a ProjectView and report findings. They never act; the
 * playbooks do. Each one reports one finding per subject, keyed so that a
 * condition that persists across ticks stays one breach.
 */
import { createHash } from "crypto";
import { basename, join } from "path";
import type { DetectorId, Finding } from "./types.js";
import type { ProcessInfo } from "./probes.js";
import { isSafeLane, parsePid, type ProjectView, type WatchdogContext } from "./view.js";

export interface DetectorResult {
  findings: Finding[];
  /** One line for the SLO status (e.g. "last merge 2.5 h ago") */
  detail?: string;
}

export interface Detector {
  id: DetectorId;
  title: string;
  /** Why the detector cannot run with this config, or null */
  inactiveReason(ctx: WatchdogContext): string | null;
  detect(view: ProjectView): Promise<DetectorResult>;
}

const NO_AGENT_PATTERN = "watchdog.agent_command is not set, so agent processes can't be attributed";
const LOG_TAIL_BYTES = 256 * 1024;

function minutes(value: number): string {
  return `${Math.round(value)} min`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

// ============ 1. LOCK HOLDER DEAD ============

const lockHolderDead: Detector = {
  id: "lock_holder_dead",
  title: "Locks held by a live process",
  inactiveReason: (ctx) => (ctx.settings.locks.length === 0 ? "no watchdog.locks configured" : null),
  async detect(view) {
    const queued = view.gateRequests().filter((r) => r.gate.status === "queued");
    const waiting = view.waitingAgents();
    const waiters = [
      ...waiting.map((a) => `agent ${a} is WAITING`),
      ...queued.map((r) => `gate request ${r.name} is queued`),
    ];
    const findings: Finding[] = [];
    for (const lock of view.settings.locks) {
      const st = view.stat(lock.path);
      if (!st) continue;
      const pidSource = st.isDirectory ? join(lock.path, lock.pidFile) : lock.path;
      const pid = parsePid(view.readSmall(pidSource));
      if (pid !== null && (await view.isAlive(pid))) continue; // a live holder: never broken
      if (waiters.length === 0) continue; // nobody needs it
      const age = view.minutesSince(st.mtimeMs);
      if (pid === null && age < lock.leaseMinutes) continue;
      const why =
        pid !== null
          ? `holder pid ${pid} (from ${pidSource}) is not running`
          : `no holder pid in ${pidSource} and the lock is ${minutes(age)} old (lease ${lock.leaseMinutes} min)`;
      findings.push({
        detector: "lock_holder_dead",
        key: `lock_holder_dead:${lock.name}`,
        summary: `Lock ${lock.name} is stale: ${why}`,
        evidence: [`lock ${lock.path}: ${why}`, ...waiters.slice(0, 10)],
        vars: { lock: lock.path, lock_name: lock.name, pid: pid === null ? "" : String(pid) },
      });
    }
    return { findings };
  },
};

// ============ 2. DUPLICATE AGENT PROCESSES ============

const duplicateAgent: Detector = {
  id: "duplicate_agent",
  title: "One process per agent",
  inactiveReason: (ctx) => (ctx.settings.agentCommand ? null : NO_AGENT_PATTERN),
  async detect(view) {
    const findings: Finding[] = [];
    for (const agent of view.localAgentIds()) {
      const procs = await view.agentProcesses(agent);
      if (procs.length < 2) continue;
      const [keep, ...extra] = procs;
      for (const proc of extra) {
        findings.push({
          detector: "duplicate_agent",
          key: `duplicate_agent:${agent}:${proc.pid}`,
          summary: `Agent ${agent} runs ${procs.length} processes; pid ${proc.pid} is a duplicate of pid ${keep.pid}`,
          evidence: procs.map(
            (p) => `pid ${p.pid} (up ${minutes(p.elapsedSeconds / 60)}): ${p.command.slice(0, 200)}`,
          ),
          vars: { agent, pid: String(proc.pid), keep_pid: String(keep.pid) },
        });
      }
    }
    return { findings };
  },
};

// ============ 3. HUNG AGENT ============

/**
 * The hung rule for one agent process: it is alive, the agent is not WAITING
 * on a gate that has no result yet (such an agent is never hung), and
 * neither its newest log nor the process itself has changed for `limit`
 * minutes. Null when it isn't hung. The agents module
 * (src/server/agents/) applies the same rule to the runs it starts.
 */
export function hungFinding(
  view: ProjectView,
  agent: string,
  proc: ProcessInfo,
  limit: number = view.settings.hungMinutes,
): Finding | null {
  if (view.waitingOn(agent)) return null; // WAITING on a gate with no result yet: never hung
  const startedAt = view.now - proc.elapsedSeconds * 1000;
  const log = view.newestLog(agent);
  const lastActivity = Math.max(startedAt, log?.mtimeMs ?? startedAt);
  const silent = view.minutesSince(lastActivity);
  if (silent < limit) return null;
  const latest = view.latestLineFor(agent);
  return {
    detector: "agent_hung",
    key: `agent_hung:${agent}`,
    summary: `Agent ${agent} (pid ${proc.pid}) shows no progress for ${minutes(silent)} (limit ${limit} min)`,
    evidence: [
      log
        ? `newest log ${log.name} last changed ${iso(log.mtimeMs)}`
        : `no log for ${agent} in agents_dir since the process started ${iso(startedAt)}`,
      `pid ${proc.pid} alive: ${proc.command.slice(0, 200)}`,
      latest
        ? `latest queue line (${latest.type}, not WAITING on an unfinished gate): ${latest.message.slice(0, 200)}`
        : "no queue line for this agent",
    ],
    vars: { agent, pid: String(proc.pid), log: log?.path ?? "" },
  };
}

const agentHung: Detector = {
  id: "agent_hung",
  title: "Running agents show progress",
  inactiveReason: (ctx) => (ctx.settings.agentCommand ? null : NO_AGENT_PATTERN),
  async detect(view) {
    const findings: Finding[] = [];
    for (const agent of view.localAgentIds()) {
      const procs = await view.agentProcesses(agent);
      if (procs.length === 0) continue;
      const finding = hungFinding(view, agent, procs[0]);
      if (finding) findings.push(finding);
    }
    return { findings };
  },
};

// ============ 4. ORPHAN CLAIM ============

const orphanClaim: Detector = {
  id: "orphan_claim",
  title: "Claims belong to live agents",
  inactiveReason: (ctx) => (ctx.settings.agentCommand ? null : NO_AGENT_PATTERN),
  async detect(view) {
    const findings: Finding[] = [];
    const remote: string[] = [];
    for (const claim of view.claims()) {
      // A remote agent's process is not in the local process table: unknown, never "dead"
      if (!view.isLocalAgent(claim.agent)) {
        remote.push(`${claim.agent} (${view.agentMachine(claim.agent).machine})`);
        continue;
      }
      if ((await view.agentProcesses(claim.agent)).length > 0) continue; // live agent: never touched
      const age = view.minutesSince(claim.mtimeMs);
      if (age < view.settings.claimGraceMinutes) continue;
      findings.push({
        detector: "orphan_claim",
        key: `orphan_claim:${claim.name}`,
        summary: `Claim ${claim.name} has no live agent process`,
        evidence: [
          `claim ${claim.path} is ${minutes(age)} old`,
          `no process matches watchdog.agent_command for ${claim.agent}`,
        ],
        vars: { agent: claim.agent, claim: claim.path },
      });
    }
    return {
      findings,
      detail:
        remote.length > 0
          ? `not checked (remote agents): ${remote.join(", ")}`
          : undefined,
    };
  },
};

// ============ 5. INFRA FAILURE SIGNATURE ============

/**
 * Lines that are never a failure signature: gate step summaries, and test or
 * build totals ("3 failed, 10 passed", "BUILD FAILED in 2m"), which read the
 * same on every red gate whatever the cause.
 */
const SUMMARY_LINES = [
  /^(STEP\s+\S+\s*:\s*(PASS|FAIL|SKIPPED)\b|==\s|\[gate-run\])/i,
  /\b\d+\s+(passed|failed|failing|passing|errors?)\b/i,
  /^BUILD (FAILED|FAILURE)\b/i,
];
const ERROR_TEXT =
  /\b(error|fatal|failed|failure|cannot|can't|unable|refused|timed? ?out|no space|out of memory|oom|killed|denied|unreachable|panic|exception)\b/i;
const GATE_ID = /^(\d{8}T\d{6}Z)-([a-zA-Z0-9-]+)-([a-f0-9]+)-(\d+)$/;

/**
 * Normalise failure text so the same failure on different gates compares
 * equal. Leading dashes are dropped ("--- FAIL: x" -> "fail: x"), so the
 * text never reads as an option when passed to a command as {signature}.
 */
export function normaliseFailure(text: string, tokens: string[] = []): string {
  let s = text;
  for (const token of [...tokens].filter((t) => t.length >= 3).sort((a, b) => b.length - a.length)) {
    s = s.split(token).join("<id>");
  }
  return s
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g, "<time>")
    .replace(/\d{8}T\d{6}Z/g, "<time>")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .replace(/^[\s-]+/, "")
    .trim()
    .toLowerCase()
    .slice(0, 300);
}

/**
 * The failure text of a finished gate: the result JSON's `error`, else the
 * first line of the log that reads like an error (step summary lines are
 * skipped). Null when there is none.
 */
export function failureSignature(log: string, error?: string, tokens: string[] = []): string | null {
  let line = error?.trim() || undefined;
  if (!line) {
    for (const raw of log.split("\n")) {
      const text = raw.trim();
      if (!text || SUMMARY_LINES.some((pattern) => pattern.test(text))) continue;
      if (ERROR_TEXT.test(text)) {
        line = text;
        break;
      }
    }
  }
  if (!line) return null;
  const normalised = normaliseFailure(line, tokens);
  return normalised.length > 0 ? normalised : null;
}

function laneOf(json: Record<string, unknown> | null, log: string): string | null {
  const fromJson = json?.lane;
  if (isSafeLane(fromJson)) return fromJson;
  const header = log.match(/\[gate-run\]\s+([A-Za-z][A-Za-z0-9_-]*)\s+lane\b/);
  if (header && isSafeLane(header[1])) return header[1];
  const field = log.match(/\blane\s*[=:]\s*([A-Za-z][A-Za-z0-9_-]*)/i);
  return field && isSafeLane(field[1]) ? field[1] : null;
}

const infraSignature: Detector = {
  id: "infra_signature",
  title: "Failures are not infrastructure",
  inactiveReason: () => null,
  async detect(view) {
    const s = view.settings;
    const since = view.now - s.infraWindowMinutes * 60000;
    const groups = new Map<string, { lane: string; signature: string; tracks: Map<string, string> }>();
    for (const result of view.gateResults()) {
      if (result.rc === 0 || result.mtimeMs < since) continue;
      const idParts = result.id.match(GATE_ID);
      if (!idParts) continue;
      const [, , track, sha] = idParts;
      const log = view.readTail(result.logPath, LOG_TAIL_BYTES) ?? "";
      let json: Record<string, unknown> | null = null;
      const jsonText = view.readSmall(result.jsonPath);
      if (jsonText) {
        try {
          const parsed = JSON.parse(jsonText) as unknown;
          if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
        } catch {
          // not JSON: ignore
        }
      }
      const lane = laneOf(json, log);
      if (!lane) continue;
      const rawError = json?.error;
      const error = typeof rawError === "string" ? rawError : undefined;
      const signature = failureSignature(log, error, [result.id, track, sha]);
      if (!signature) continue;
      const key = `${lane}\u0000${signature}`;
      const group = groups.get(key) ?? { lane, signature, tracks: new Map() };
      if (!group.tracks.has(track)) group.tracks.set(track, result.id);
      groups.set(key, group);
    }
    const findings: Finding[] = [];
    for (const group of groups.values()) {
      if (group.tracks.size < s.infraMinTracks) continue;
      const gates = [...group.tracks.values()];
      findings.push({
        detector: "infra_signature",
        key: `infra_signature:${group.lane}:${shortHash(group.signature)}`,
        summary: `Lane ${group.lane}: the same failure in ${group.tracks.size} gates of different tracks within ${s.infraWindowMinutes} min`,
        evidence: [`failure: ${group.signature}`, ...gates.map((g) => `gate ${g}`)],
        vars: { lane: group.lane, signature: group.signature, gates: gates.join(",") },
      });
    }
    return { findings };
  },
};

// ============ 6. GATE OWNER GONE ============

const gateOwnerGone: Detector = {
  id: "gate_owner_gone",
  title: "Running gates have a live runner",
  inactiveReason: () => null,
  async detect(view) {
    const findings: Finding[] = [];
    const lease = view.settings.gateLeaseMinutes;
    for (const request of view.gateRequests()) {
      if (request.gate.status !== "running") continue;
      const ownPid = parsePid(view.readSmall(request.path));
      const pid = ownPid ?? view.runnerPid(request.gate.lane);
      if (pid !== null && (await view.isAlive(pid))) continue;
      const lastActivity = Math.max(request.mtimeMs, view.gateLogMtime(request) ?? 0);
      const silent = view.minutesSince(lastActivity);
      if (silent < lease) continue;
      const owner =
        pid === null
          ? `no runner pid (none in ${request.name} or runner-${request.gate.lane}.pid)`
          : `runner pid ${pid} (from ${ownPid !== null ? request.name : `runner-${request.gate.lane}.pid`}) is not running`;
      findings.push({
        detector: "gate_owner_gone",
        key: `gate_owner_gone:${request.gate.id}`,
        summary: `Gate ${request.gate.id} on lane ${request.gate.lane} is orphaned: ${owner}`,
        evidence: [owner, `no log activity for ${minutes(silent)} (lease ${lease} min)`, `request ${request.path}`],
        vars: {
          gate: request.gate.id,
          lane: request.gate.lane,
          file: request.path,
          pid: pid === null ? "" : String(pid),
        },
      });
    }
    return { findings };
  },
};

// ============ 7. IDLE CAPACITY ============

const idleCapacity: Detector = {
  id: "idle_capacity",
  title: "Free capacity is used while work is ready",
  inactiveReason: () => null,
  async detect(view) {
    const s = view.settings;
    const requests = view.gateRequests();
    const queued = requests.filter((r) => r.gate.status === "queued");
    const ready = await view.readyTasks();
    const work = queued.length + ready.length;
    const claims = view.claims();
    // Local agents count by their live process, remote ones by their claim
    const running = view.hasAgentPattern()
      ? (await view.runningAgents()).length
      : new Set(claims.map((c) => c.agent)).size;
    const free = s.maxAgents !== undefined ? running < s.maxAgents : running === 0;
    const holds = work > 0 && free;
    const since = view.conditionSince("idle_capacity", holds);
    const detail = `${work} ready (${queued.length} queued gate requests, ${ready.length} ready tasks), ${running} agent(s) running${s.maxAgents !== undefined ? ` of max ${s.maxAgents}` : ""}`;
    if (!holds || since === null) return { findings: [], detail };

    const starts = [
      ...claims.map((c) => c.mtimeMs),
      ...requests.filter((r) => r.gate.status === "running").map((r) => r.mtimeMs),
    ];
    for (const agent of view.localAgentIds()) {
      for (const proc of await view.agentProcesses(agent)) {
        starts.push(view.now - proc.elapsedSeconds * 1000);
      }
    }
    const lastStart = starts.length > 0 ? Math.max(...starts) : -Infinity;
    const oldestQueued = queued.length > 0 ? Math.min(...queued.map((r) => r.mtimeMs)) : Infinity;
    const idleFrom = Math.max(Math.min(since, oldestQueued), lastStart);
    const idle = view.minutesSince(idleFrom);
    if (idle < s.idleMinutes) return { findings: [], detail };

    const freeSlots =
      s.maxAgents !== undefined ? s.maxAgents - running : Math.max(1, view.agentIds().length - running);
    return {
      detail,
      findings: [
        {
          detector: "idle_capacity",
          key: "idle_capacity",
          summary: `Work is ready and capacity is free, but nothing started for ${minutes(idle)} (limit ${s.idleMinutes} min)`,
          evidence: [
            detail,
            lastStart === -Infinity ? "no start on record" : `last start ${iso(lastStart)}`,
            ...queued.slice(0, 5).map((r) => `queued: ${r.name}`),
            ...ready.slice(0, 5).map((t) => `ready task: ${t}`),
          ],
          vars: {
            free: String(freeSlots),
            ready: String(ready.length),
            queued: String(queued.length),
            running: String(running),
          },
        },
      ],
    };
  },
};

// ============ 8. PROGRESS STALL ============

const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
/** One ISO time (with a zone), for a single queue line */
const ISO_TIME_ONE = new RegExp(ISO_TIME.source);

const progressStall: Detector = {
  id: "progress_stall",
  title: "Merges keep landing while work is queued",
  inactiveReason: () => null,
  async detect(view) {
    const s = view.settings;
    const merges: number[] = [];
    // The queue file's last merge is its LAST "- MERGED" line (the file is
    // appended in time order), and it counts only with a full ISO time: an
    // HH:MMZ time has no date, so an old line could pass for today's.
    let lastMerged: { message: string } | undefined;
    for (const line of view.queueLines()) {
      if (/^MERGED\b/i.test(line.message)) lastMerged = line;
    }
    let undated: string | null = null;
    if (lastMerged) {
      const at = Date.parse(lastMerged.message.match(ISO_TIME_ONE)?.[0] ?? "");
      if (Number.isNaN(at)) undated = lastMerged.message.slice(0, 80);
      else merges.push(at);
    }
    if (undated !== null && !s.mergedCmd) {
      return {
        findings: [],
        detail: `the latest MERGED line has no date ("${undated}"): write ISO times or set merged_cmd`,
      };
    }
    if (s.mergedCmd) {
      const out = await view.ctx.probes.runner.run(s.mergedCmd, {
        timeoutMs: s.commandTimeoutSeconds * 1000,
      });
      if (out.code !== 0) {
        throw new Error(`merged_cmd exited ${out.code}: ${out.stderr.trim().slice(0, 200)}`);
      }
      for (const match of out.stdout.matchAll(ISO_TIME)) {
        const at = Date.parse(match[0]);
        if (!Number.isNaN(at)) merges.push(at);
      }
    }
    const requests = view.gateRequests();
    const ready = await view.readyTasks();
    const claims = view.claims();
    const pending = requests.length + ready.length + claims.length;
    if (merges.length === 0) {
      return { findings: [], detail: "no merge on record (no MERGED line, no merged_cmd result)" };
    }
    const last = Math.max(...merges.filter((m) => m <= view.now), -Infinity);
    if (last === -Infinity) return { findings: [], detail: "no merge on record" };
    const hours = (view.now - last) / 3600000;
    const detail = `last merge ${hours.toFixed(1)} h ago; ${pending} pending item(s)`;
    if (pending === 0 || hours < s.stallHours) return { findings: [], detail };
    return {
      detail,
      findings: [
        {
          detector: "progress_stall",
          key: "progress_stall",
          summary: `No merge for ${hours.toFixed(1)} h (limit ${s.stallHours} h) while work is queued`,
          evidence: [
            `last merge ${iso(last)}`,
            `${requests.length} gate request(s), ${ready.length} ready task(s), ${claims.length} claim(s)`,
            ...requests.slice(0, 5).map((r) => `gate request: ${r.name}`),
            ...claims.slice(0, 5).map((c) => `claim: ${basename(c.path)}`),
          ],
          vars: { hours: hours.toFixed(1), last_merge: iso(last) },
        },
      ],
    };
  },
};

// ============ 9. CRASH LOOP ============

/**
 * Restarts between restart-count samples (oldest first). A count that drops
 * (the container was recreated) counts again from the new value.
 */
export function countRestarts(samples: { restartCount: number }[]): number {
  let restarts = 0;
  for (let i = 1; i < samples.length; i++) {
    restarts += Math.max(0, samples[i].restartCount - samples[i - 1].restartCount);
  }
  return restarts;
}

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * Two sources: the containers in watchdog.containers (sampled here), and the
 * crash loops delivery marked on its environments' services (it samples
 * them). A container whose delivery service a human holds is skipped.
 */
const crashLoop: Detector = {
  id: "crash_loop",
  title: "Containers are not crash-looping",
  inactiveReason: (ctx) =>
    ctx.settings.containers.length === 0 && !ctx.services?.covers(ctx.project)
      ? "no watchdog.containers configured"
      : null,
  async detect(view) {
    const s = view.settings;
    const project = view.ctx.project;
    const services = view.ctx.services;
    const findings: Finding[] = [];
    const errors: string[] = [];
    const held: string[] = [];
    for (const container of s.containers) {
      if (services?.heldReason(project, container.name)) {
        held.push(container.name);
        continue;
      }
      const out = await view.ctx.probes.runner.run(
        [...s.dockerCmd, "inspect", "--format", "{{.RestartCount}}", container.name],
        { timeoutMs: s.commandTimeoutSeconds * 1000 },
      );
      const count = Number.parseInt(out.stdout.trim(), 10);
      if (out.code !== 0 || Number.isNaN(count)) {
        errors.push(`${container.name}: inspect exited ${out.code} ${out.stderr.trim().slice(0, 120)}`);
        continue;
      }
      const store = view.ctx.store;
      store.addContainerSample(view.ctx.project, container.name, view.now, count);
      const samples = store.containerSamples(
        view.ctx.project,
        container.name,
        view.now - container.windowMinutes * 60000,
      );
      const restarts = countRestarts(samples);
      if (restarts < container.maxRestarts) continue;
      findings.push({
        detector: "crash_loop",
        key: `crash_loop:${container.name}`,
        summary: `Container ${container.name} restarted ${restarts} times in ${container.windowMinutes} min (limit ${container.maxRestarts})`,
        evidence: samples.map((x) => `${iso(x.at)} restart count ${x.restartCount}`),
        vars: { container: container.name, restarts: String(restarts) },
      });
    }
    for (const loop of services?.crashLoops(project) ?? []) {
      const key = `crash_loop:${loop.container}`;
      if (!CONTAINER_NAME.test(loop.container) || findings.some((f) => f.key === key)) continue;
      if (services?.heldReason(project, loop.container)) {
        held.push(loop.container);
        continue;
      }
      findings.push({
        detector: "crash_loop",
        key,
        summary: `Service ${loop.service} (delivery environment ${loop.environment}): container ${loop.container} restarted ${loop.restarts} times in ${loop.windowMinutes} min (limit ${loop.maxRestarts}); Lair stopped restarting it`,
        evidence: loop.evidence,
        vars: { container: loop.container, restarts: String(loop.restarts) },
      });
    }
    const details = [...errors, ...(held.length > 0 ? [`held, left alone: ${held.join(", ")}`] : [])];
    return { findings, detail: details.length > 0 ? details.join("; ") : undefined };
  },
};

export const DETECTORS: Detector[] = [
  lockHolderDead,
  duplicateAgent,
  agentHung,
  orphanClaim,
  infraSignature,
  gateOwnerGone,
  idleCapacity,
  progressStall,
  crashLoop,
];

export function getDetector(id: DetectorId): Detector {
  const detector = DETECTORS.find((d) => d.id === id);
  if (!detector) throw new Error(`Unknown detector ${id}`);
  return detector;
}
