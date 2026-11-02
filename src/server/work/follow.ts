/**
 * Work store 2 (docs/design/work-store.md §4.1, §6.4, §7.4): how a project's store keeps up on its own, once the owner
 * applied a first import, in `work_store.mode: observe` with `files: follow`. Nothing here writes a project file.
 *
 * - The consumer: the project's bus reports (by report id) and the agents module's run and claim facts (by event
 *   row), each source with its cursor in work_cursors. Facts are read above the cursors, put in time order across the
 *   two sources, and applied with the cursor moves in one transaction: a fact applies once across restarts, and a
 *   missed event is caught up by the next drain (on the next event, the follower's interval, and at start).
 * - The follower: the import, when a configured file changed (size, mtime, inode): an unchanged file costs a stat.
 */
import type { Stats } from "fs";
import type { AgentsStore } from "../agents/store.js";
import { isActive } from "../agents/types.js";
import type { BusStore } from "../bus/store.js";
import { structuredReport } from "../bus/consumers.js";
import { statOrNull } from "../services/async-fs.js";
import type { ReportAccepted } from "./importer.js";
import type { ClaimFact, CursorMove, Cursors, ReportFact, WorkFact, WorkStore } from "./store.js";

/** The bus store's reads the consumer uses (the project's store when its file exists; never created here) */
export type ReportReader = Pick<BusStore, "reportsAfter" | "lastReportId">;
/** The agents store's reads the consumer uses */
export type ClaimFactReader = Pick<AgentsStore, "claimFactsAfter" | "lastEventSeq" | "latestRunForTask">;

export interface FactSources {
  reports: ReportReader | null;
  runs: ClaimFactReader | null;
  /** Fill's ready guard on a DONE report; absent: every DONE counts (as for the importer) */
  accepted?: ReportAccepted;
}

/** Facts read per source per round, and rounds per drain (the rest waits for the next drain) */
export const FACT_BATCH = 500;
const MAX_ROUNDS = 20;

/** Within one millisecond: a run starts, then reports, then ends */
const RANK = { started: 0, report: 1, completed: 2, claim_released: 2 } as const;
const rank = (fact: WorkFact) => (fact.source === "bus.report" ? RANK.report : RANK[fact.kind]);

/** Where the consumer starts in each source an applied import adopts: read before the files, so nothing between is lost */
export function factMarks(src: FactSources): Cursors {
  // No bus store yet: every report it will hold is newer than the files read now
  return { "bus.report": src.reports?.lastReportId() ?? 0, ...(src.runs ? { "agents.event": src.runs.lastEventSeq() } : {}) };
}

/** Apply every fact above the store's cursors, in time order, a batch per transaction. */
export async function drainFacts(project: string, store: WorkStore, src: FactSources, now: () => number): Promise<{ applied: number; skipped: number }> {
  let cursors = await store.cursors();
  // A source with no cursor (a store adopted before the consumer existed, or the agents module was off) starts at its end
  const start: Cursors = {};
  if (cursors["bus.report"] === undefined && src.reports) start["bus.report"] = src.reports.lastReportId();
  if (cursors["agents.event"] === undefined && src.runs) start["agents.event"] = src.runs.lastEventSeq();
  if (Object.keys(start).length > 0) {
    await store.initCursors(start, now());
    cursors = await store.cursors();
  }
  const total = { applied: 0, skipped: 0 };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const busAt = cursors["bus.report"];
    const runsAt = cursors["agents.event"];
    const busEnd = src.reports && busAt !== undefined ? src.reports.lastReportId() : 0;
    const runsEnd = src.runs && runsAt !== undefined ? src.runs.lastEventSeq() : 0;
    const moves: CursorMove[] = [];
    // A source whose end is behind its cursor had its file replaced: it starts again at its end
    if (src.reports && busAt !== undefined && busEnd < busAt) moves.push({ source: "bus.report", from: busAt, to: busEnd });
    if (src.runs && runsAt !== undefined && runsEnd < runsAt) moves.push({ source: "agents.event", from: runsAt, to: runsEnd });
    const reports = src.reports && busAt !== undefined && busEnd > busAt ? src.reports.reportsAfter(busAt, FACT_BATCH) : [];
    const claims = src.runs && runsAt !== undefined && runsEnd > runsAt ? src.runs.claimFactsAfter(project, runsAt, runsEnd, FACT_BATCH) : [];
    // A full batch may stop mid-time: the other source applies only up to its latest time, so the two stay in order
    const latest = (times: number[]) => (times.length === FACT_BATCH ? Math.max(...times) : Infinity);
    const horizon = Math.min(latest(reports.map((r) => r.createdAt)), latest(claims.map((c) => c.at)));
    const prefix = <T>(items: T[], at: (item: T) => number) => {
      const end = items.findIndex((item) => at(item) > horizon);
      return end === -1 ? items : items.slice(0, end);
    };
    const takenReports = prefix(reports, (r) => r.createdAt);
    const takenClaims = prefix(claims, (c) => c.at);
    if (takenReports.length > 0 && busAt !== undefined) moves.push({ source: "bus.report", from: busAt, to: takenReports[takenReports.length - 1].id });
    if (runsAt !== undefined && runsEnd > runsAt) {
      // Every fact up to the end was read: rows of other projects and kinds are passed over for good
      const to = takenClaims.length === claims.length && claims.length < FACT_BATCH ? runsEnd : takenClaims[takenClaims.length - 1]?.seq;
      if (to !== undefined) moves.push({ source: "agents.event", from: runsAt, to });
    }
    if (moves.length === 0) break;

    const facts: WorkFact[] = [];
    for (const report of takenReports) facts.push(await reportFact(store, report, src.accepted));
    for (const claim of takenClaims) {
      if (claim.kind !== "started" && claim.kind !== "completed" && claim.kind !== "claim_released") continue;
      const run = src.runs?.latestRunForTask(project, claim.task ?? "") ?? null;
      const live = claim.kind === "started" && run !== null && run.id === claim.runId && isActive(run.state);
      facts.push({ source: "agents.event", id: claim.seq, at: claim.at, task: claim.task ?? "", agent: claim.agent ?? null, runId: claim.runId ?? null, kind: claim.kind, live } satisfies ClaimFact);
    }
    facts.sort((a, b) => a.at - b.at || rank(a) - rank(b));
    const result = await store.applyFacts(facts, moves, now());
    // Another drain moved a cursor first: it applied these facts
    if (!result.moved) break;
    total.applied += result.applied;
    total.skipped += result.skipped;
    for (const m of moves) cursors = { ...cursors, [m.source]: m.to };
  }
  return total;
}

async function reportFact(store: WorkStore, report: Parameters<typeof structuredReport>[0], accepted: ReportAccepted | undefined): Promise<ReportFact> {
  const fact: ReportFact = {
    source: "bus.report",
    id: report.id,
    at: report.createdAt,
    task: report.task,
    agent: report.agent,
    runId: report.runId,
    kind: report.kind,
    summary: report.summary,
    gateId: report.gateId,
    pr: report.pr,
    sha: report.sha,
    accepted: false,
  };
  if (report.kind !== "DONE") return fact;
  const task = await store.getTask(report.task);
  if (!task) return fact;
  try {
    // The line as the bus mirror starts it; the guard reads the report's own PR and sha fields
    fact.accepted = !accepted || (await accepted(report.agent, report.task, `- DONE ${report.task} by ${report.agent} ${report.summary}`, task.description, structuredReport(report)));
  } catch {
    // A guard that fails accepts nothing: the follower reads the line again on the next change
    fact.accepted = false;
  }
  return fact;
}

/** The configured files' size, time and inode: the follower reads them again only when this changes */
export async function fileSignature(paths: readonly string[]): Promise<string> {
  const stats = await Promise.all(paths.map((path) => statOrNull(path)));
  return stats.map((st: Stats | null) => (st ? `${st.size}:${st.mtimeMs}:${st.ino}` : "missing")).join("|");
}
