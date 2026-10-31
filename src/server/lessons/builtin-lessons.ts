/**
 * Built-in lessons that ship with Lair (L1-L28).
 * These are loaded once when the lessons module starts, if not already present.
 * Generic wording only (no project names, paths, or private details).
 *
 * Versioned: each lesson has a version; on start, missing lessons are inserted
 * and outdated content is updated (preserving owner state: status, match_count,
 * last_match_at, sources).
 */
import type { LessonSignal, LessonSource } from "../../shared/lessons-types.js";
import type { LessonInput } from "./store.js";

interface BuiltInLesson {
  id: string;
  title: string;
  signal: LessonSignal;
  cause: string;
  response: string;
  prevention: string;
  feature: string | null;
  /** Increment when the lesson's content changes */
  version: number;
}

const SEED_SOURCE: LessonSource = { kind: "manual", ref: "builtin-seed", at: "2026-10-30T00:00:00.000Z" };

/**
 * The built-in lessons. Each has a stable id (L1, L2, ...) that never changes.
 * Increment the version when updating a lesson's content.
 */
export const BUILTIN_LESSONS: BuiltInLesson[] = [
  {
    id: "L1",
    title: "A gate runs far longer than it should",
    signal: { kind: "metric", value: "gate_duration_seconds", threshold: 2400, direction: "above" },
    cause: "An overloaded machine, a hung test, or a stuck transfer",
    response: "Cancel the job's own processes (by its working dir, never a shared process group) and re-place it on the fastest free machine",
    prevention: "A slow-gate check every minute, measured from the job's real start",
    feature: "time and process limits",
    version: 1,
  },
  {
    id: "L2",
    title: "An on-demand machine powered off under a running job",
    signal: { kind: "event", value: "machine.stopped" },
    cause: "Its idle timer saw no activity during the job's long local phase; the activity mark was refreshed only at job start and end",
    response: "Restart the machine and retry the job once",
    prevention: "A lease refreshed every minute while a job holds the machine; idle timeout >= the longest local phase",
    feature: "machine placement",
    version: 1,
  },
  {
    id: "L3",
    title: "Every remote start fails no ssh after a reboot",
    signal: { kind: "pattern", value: "no ssh|connection refused" },
    cause: "The user-level tunnel daemon was not restarted after the host rebooted",
    response: "Start the daemon; hold the lanes that need it",
    prevention: "Host services with probe and start commands, checked after boot",
    feature: "remote start checks",
    version: 1,
  },
  {
    id: "L4",
    title: "All gates fail at once in their first step",
    signal: { kind: "pattern", value: "exit 125|Cannot connect to the Docker daemon" },
    cause: "The container engine is not running",
    response: "Hold the gates; probe the engine; re-check after it answers; ONE notice per outage",
    prevention: "An environment failure class in triage",
    feature: "gate first-step checks",
    version: 1,
  },
  {
    id: "L5",
    title: "Two agents work the same task after a restart",
    signal: { kind: "event", value: "agent.duplicate_task" },
    cause: "The old server's runs were orphaned, not stopped; fill started new ones",
    response: "Stop the orphans by process group",
    prevention: "Adopt or stop previous runs before fill's first tick",
    feature: "task duplicate guard",
    version: 1,
  },
  {
    id: "L6",
    title: "A new task closed with no work done",
    signal: { kind: "event", value: "task.closed_by_wrong_report" },
    cause: "Reports matched by agent instead of by task; a DONE line naming another task id closed the agent's open task",
    response: "Reopen under a new task id",
    prevention: "Close only on the exact task id; record unmatched reports",
    feature: "task closing checks",
    version: 1,
  },
  {
    id: "L7",
    title: "Agents redo old merged work",
    signal: { kind: "event", value: "agent.prompt_stale" },
    cause: "A per-agent prompt file went stale; it described a different task than the agent's open line",
    response: "Replace it with 'your open line is your task'",
    prevention: "Warn when a built prompt names another task id",
    feature: "merged work memory",
    version: 1,
  },
  {
    id: "L8",
    title: "Agents idle while capacity exists",
    signal: { kind: "metric", value: "idle_agents_with_ready_work", threshold: 1, direction: "above" },
    cause: "Two launchers with different limits; caps below the agent count",
    response: "Move all agents to one launcher; raise caps",
    prevention: "Every idle agent gets an explanation; never idle without one",
    feature: "idle capacity scheduling",
    version: 1,
  },
  {
    id: "L9",
    title: "Load average says full but agents barely use CPU",
    signal: { kind: "metric", value: "load_per_agent_cpu_ratio", threshold: 10, direction: "above" },
    cause: "Container VM threads and gates inflate load; LLM-bound agents are light",
    response: "Hold only local-heavy work on load",
    prevention: "A per-agent capacity class (local or remote)",
    feature: "load measurement",
    version: 1,
  },
  {
    id: "L10",
    title: "The server stops answering; fill ticks every 10-15 min",
    signal: { kind: "check", value: "event_loop_lag" },
    cause: "Request handlers read a large append-only file synchronously, per agent, under dashboard polling",
    response: "Rotate the file; close the polling tab",
    prevention: "Cache plus async IO; an event-loop-lag Health check; rotation of append-only files",
    feature: "#160",
    version: 1,
  },
  {
    id: "L11",
    title: "A cloud gate takes 35 min while its tests take 4-7",
    signal: { kind: "metric", value: "gate_local_phase_ratio", threshold: 0.5, direction: "above" },
    cause: "The preflight ran on the overloaded local machine beside the remote gate",
    response: "Measure each gate's phases",
    prevention: "Run the whole gate remotely; report the phase breakdown per gate",
    feature: "gate duration tuning",
    version: 1,
  },
  {
    id: "L12",
    title: "Heavy gates still land on the slow machine",
    signal: { kind: "event", value: "placement.wrong_lane" },
    cause: "The routing pattern did not recognise that command kind",
    response: "Fix the pattern",
    prevention: "Routing tests per command kind",
    feature: "heavy gate placement",
    version: 1,
  },
  {
    id: "L13",
    title: "Agents report not authenticated while auth works elsewhere",
    signal: { kind: "pattern", value: "not authenticated|could not read Username" },
    cause: "Keychain or credential-store reads time out under extreme load",
    response: "Retry with backoff; a credential cache; report 'pr-needed', not BLOCKED",
    prevention: "Check each agent's environment health (gh, git) before runs",
    feature: "agent auth checks",
    version: 1,
  },
  {
    id: "L14",
    title: "Edits to a shared file silently disappear",
    signal: { kind: "event", value: "file.reverted_silently" },
    cause: "Act mode makes one writer own the file; the exclusive writer put back outside edits",
    response: "Switch to observe; restore the lost lines",
    prevention: "One writer (a DB-backed work store) or a notice for every revert",
    feature: "#96",
    version: 1,
  },
  {
    id: "L15",
    title: "Gate time spent on code that will change",
    signal: { kind: "event", value: "gate.obsolete_by_review" },
    cause: "The gate ran before the review; a merge gate runs, then review requests changes",
    response: "Cancel the obsolete gate",
    prevention: "Review first; merge gates only after approval at the head",
    feature: "gate scope trimming",
    version: 1,
  },
  {
    id: "L16",
    title: "A narrow passing gate is not enough to merge",
    signal: { kind: "event", value: "gate.scope_too_narrow" },
    cause: "Coverage at the head was narrower than the change; a targeted gate passed for a multi-module risky change",
    response: "Run the affected scope at the head",
    prevention: "The merge gate's scope is derived from the changed modules",
    feature: "C9",
    version: 1,
  },
  {
    id: "L17",
    title: "A PR leaves out part of its approved design",
    signal: { kind: "event", value: "review.missing_from_design" },
    cause: "Scope drift; a required file or test from the design's PR scope is absent",
    response: "Request changes naming the missing item",
    prevention: "The reviewer checks the design's PR scope list (files + required tests) mechanically",
    feature: "design completeness check",
    version: 1,
  },
  {
    id: "L18",
    title: "Commits show a machine user instead of the owner",
    signal: { kind: "event", value: "commit.identity_unallowed" },
    cause: "No identity configured for agent runs; author name or email from the machine's default config",
    response: "Set the identity; squash-merge with the owner identity",
    prevention: "A per-run identity and a Health warning on an unallowed identity",
    feature: "commit identity check",
    version: 2,
  },
  {
    id: "L19",
    title: "A monitor has a blind spot",
    signal: { kind: "event", value: "monitor.missed_incident" },
    cause: "A bug in the monitor (a wrong column, a wrong timestamp); a known incident did not trigger the monitor",
    response: "Fix the monitor and replay the incident",
    prevention: "Every monitor is tested against a recorded incident",
    feature: "C8",
    version: 1,
  },
  {
    id: "L20",
    title: "Durations measured wrong",
    signal: { kind: "event", value: "timing.wrong_source" },
    cause: "The wrong timestamp source; a job's 'age' counted from queue time, not start",
    response: "Use the job's start marker",
    prevention: "Time fields carry their meaning (queued, started, ended)",
    feature: "time and process limits",
    version: 1,
  },
  {
    id: "L21",
    title: "A remote machine is mostly idle yet slow",
    signal: { kind: "metric", value: "remote_idle_but_slow", threshold: 1, direction: "above" },
    cause: "Builds ran on a slow mounted filesystem",
    response: "Run on the machine's native filesystem",
    prevention: "Machine setup checks the filesystem type of the run dir",
    feature: "C6",
    version: 1,
  },
  {
    id: "L22",
    title: "The planner suggests the same work twice",
    signal: { kind: "event", value: "planner.duplicate_proposal" },
    cause: "No dedupe against pending proposals",
    response: "Reject the older duplicate",
    prevention: "Dedupe before raising a decision",
    feature: "#97",
    version: 1,
  },
  {
    id: "L23",
    title: "Acting on an agent claim that was wrong",
    signal: { kind: "event", value: "agent.claim_contradicted" },
    cause: "Agents report what they see in their context only; an agent's diagnosis contradicted by evidence",
    response: "Verify from another context before acting",
    prevention: "Report verification against evidence",
    feature: "claim verification",
    version: 1,
  },
  {
    id: "L24",
    title: "A kill takes down more than the job",
    signal: { kind: "event", value: "process.kill_too_broad" },
    cause: "Jobs share the runner's process group",
    response: "Kill by the job's working dir or pattern",
    prevention: "Each job in its own process group",
    feature: "time and process limits",
    version: 1,
  },
  {
    id: "L25",
    title: "Full test suites time out on the developer machine",
    signal: { kind: "metric", value: "suite_timeout_on_local", threshold: 1, direction: "above" },
    cause: "The developer machine is overloaded by agents and containers",
    response: "Run heavy suites on cloud machines",
    prevention: "Routing prefers cloud for heavy suites",
    feature: "machine placement",
    version: 1,
  },
  {
    id: "L26",
    title: "The server stays slow with no clients connected",
    signal: { kind: "check", value: "event_loop_lag" },
    cause: "Periodic module work (fill, planner, triage, watchers) does synchronous file IO on a disk saturated by agents and containers",
    response: "Lower the host load; the engine's CPU priority",
    prevention: "Async, bounded IO in every periodic tick; an event-loop-lag Health check; ticks degrade gracefully (skip, do not queue)",
    feature: "#160",
    version: 1,
  },
  {
    id: "L27",
    title: "The watchdog reports a live process as gone",
    signal: { kind: "event", value: "watchdog.false_absence" },
    cause: "Under heavy load the process-table probe hit its timeout, and its partial output was used as the complete table",
    response: "Check the process directly; stand the escalation down",
    prevention: "A timed-out probe is incomplete: it may prove a process present, never absent",
    feature: "#162",
    version: 1,
  },
  {
    id: "L28",
    title: "A task runs twice: once by hand, once by the scheduler",
    signal: { kind: "event", value: "task.duplicate_run_manual" },
    cause: "The scheduler cannot see runs it did not start; the task line was still open when it ticked",
    response: "Stop the later run by its process group",
    prevention: "Register manual runs with the orchestrator (claim the task) before starting them; adopt external runs",
    feature: "task duplicate guard",
    version: 1,
  },
];

/**
 * Convert a built-in lesson to a LessonInput for the store.
 */
export function toInput(lesson: BuiltInLesson): LessonInput {
  return {
    id: lesson.id,
    title: lesson.title,
    signal: lesson.signal,
    cause: lesson.cause,
    response: lesson.response,
    prevention: lesson.prevention,
    sources: [SEED_SOURCE],
    status: "active",
    scope: "built-in",
    feature: lesson.feature,
    version: lesson.version,
  };
}

export interface BuiltinStoreInterface {
  add: (input: LessonInput, now: number) => string | null;
  get: (id: string) => { version?: number; status: string; matchCount: number; lastMatchAt: string | null; sources: unknown[] } | null;
  update: (id: string, fields: Partial<LessonInput>, now: number) => boolean;
}

/**
 * Load all built-in lessons into the store.
 * - Missing lessons are inserted.
 * - Existing lessons with a lower version have their content updated
 *   (preserving status, matchCount, lastMatchAt, sources).
 * Returns the number of lessons added or updated.
 */
export function loadBuiltinLessons(store: BuiltinStoreInterface, clock?: () => number): number {
  const now = clock?.() ?? Date.now();
  let changes = 0;
  for (const lesson of BUILTIN_LESSONS) {
    const existing = store.get(lesson.id);
    if (!existing) {
      // New lesson: insert it
      if (store.add(toInput(lesson), now)) {
        changes++;
      }
    } else if ((existing.version ?? 0) < lesson.version) {
      // Existing lesson with older version: update content, preserve owner state
      store.update(
        lesson.id,
        {
          title: lesson.title,
          signal: lesson.signal,
          cause: lesson.cause,
          response: lesson.response,
          prevention: lesson.prevention,
          feature: lesson.feature,
          version: lesson.version,
        },
        now,
      );
      changes++;
    }
  }
  return changes;
}
