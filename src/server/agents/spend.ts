/**
 * AI spend, part 1: measure (docs/design/ai-spend.md §4.1 and §4.3). Off
 * unless agents.spend.enabled; off, nothing here reads, writes or shows
 * anything.
 *
 * Every run that ends while it is on gets one agents_spend row: who ran
 * what, for how long, how it ended, the prompt's size, and the usage its
 * adapter reports, read from its log by the adapter's usage_parser once the
 * process is gone:
 * - claude-stream-json / claude-json: the CLI's own `result` events. One
 *   process may write several (one per turn group): their `usage` and
 *   `num_turns` count only since the previous one, while the last one's
 *   `modelUsage` and `total_cost_usd` are the process's totals. So tokens
 *   and cost come from the last result, and turns are summed. The per-message
 *   `usage` of `assistant` events is never counted.
 * - request-lines: the lines matching the adapter's request_pattern (one per
 *   model request). Tokens and cost are not reported, and nothing is estimated.
 * - patterns: agents.usage_patterns, read while the run works (readUsage); the
 *   row takes what the ledger got for the run.
 * - none: tokens and cost not reported; runtime and prompt size still are.
 *
 * The end only marks the run (agents_spend_pending, in the same synchronous
 * step that ends it), so a restart between the end and the next tick loses
 * nothing. Each tick then writes the owed rows, bounded (MAX_RUNS_PER_TICK,
 * SCAN_BYTES_PER_TICK of log per tick, a big log over several ticks), with
 * async reads only. A row and its ledger usage are one transaction keyed by
 * the run, so nothing is counted twice. Logs are the agent's own output:
 * values are parsed with JSON.parse on lines of at most 1 MB, kept only when
 * finite and non-negative, and refused over a cap per run; the request
 * pattern runs in a vm with a timeout. A failure is recorded (usage_refused,
 * or the row's usage `none`), never thrown into the tick.
 */
import { open } from "fs/promises";
import { StringDecoder } from "string_decoder";
import { createContext, Script } from "vm";
import type { ProjectConfig } from "../../shared/types.js";
import type { AgentEventKind, RunOrigin, SpendGuardId, SpendGuardView, UsageParserKind } from "../../shared/agents-types.js";
import { listAdapters } from "../services/adapters.js";
import { statOrNull } from "../services/async-fs.js";
import type { FleetBudget } from "./budgets.js";
import {
  CLASSIFY_LOOKBACK_MS,
  CLASSIFY_PER_TICK,
  CLASSIFY_WAIT_MS,
  SpendClassifier,
  type Classified,
  type QueueOutcome,
  type SpendFacts,
} from "./spend-classify.js";
import { DAY_MS, dayStart, guardModes, spendReportBetween, utcDay } from "./spend-report.js";
import type { AgentsStore } from "./store.js";
import { isActive, type AgentRun, type RunEndKind, type SpendRow, type UsageRecord } from "./types.js";

export type { QueueOutcome } from "./spend-classify.js";

export const USAGE_PARSERS: readonly UsageParserKind[] = ["claude-stream-json", "claude-json", "request-lines", "patterns", "none"];

/**
 * The kiro CLI's line for one finished model request: `[INFO] [KRS] <-- GenerateAssistantResponseCommand done
 * totalEvents=<n>`. With `totalEvents=`, an agent's prose that merely names the command isn't counted.
 */
export const KIRO_REQUEST_PATTERN = "GenerateAssistantResponseCommand done totalEvents=\\d+";

/**
 * Built-in parsers, by adapter id (the built-in adapter, or a project's adapter of that id that sets none). The
 * claude-code preset writes plain text until its start command gains --output-format stream-json (a later PR).
 */
export const BUILTIN_USAGE_PARSERS: Readonly<Record<string, { parser: UsageParserKind; requestPattern?: string }>> = {
  kiro: { parser: "request-lines", requestPattern: KIRO_REQUEST_PATTERN },
};

export const MAX_REQUEST_PATTERN_CHARS = 500;
/** One read of a log */
export const SCAN_CHUNK_BYTES = 1024 * 1024;
/** A longer line (about 1 MB) is skipped, never parsed */
export const MAX_LINE_CHARS = 1024 * 1024;
/** A longer log is not read: its usage is refused */
export const MAX_LOG_BYTES = 256 * 1024 * 1024;
/** Log bytes read per tick, over all owed rows */
export const SCAN_BYTES_PER_TICK = 4 * 1024 * 1024;
/** Owed rows looked at per tick */
export const MAX_RUNS_PER_TICK = 20;
/** Per run: more is refused (an agent can print a fake result line) */
export const MAX_RUN_TOKENS = 1e10;
export const MAX_RUN_COST = 1e5;
/** How long request_pattern may take on one chunk of a log */
export const REQUEST_PATTERN_TIMEOUT_MS = 250;
/** request_pattern time per tick, over all owed rows: past it the rest waits for the next tick */
export const VM_MS_PER_TICK = 300;
/**
 * Lines a request_pattern must get through in PROBE_TIMEOUT_MS when the config loads: runs of one character and a
 * mismatch at the end, where a pattern with nested quantifiers backtracks for seconds
 */
const PROBE_LINES = ["a", "0", " ", "x", "-", "=", ".", "\t", "ab"].map((s) => `${s.repeat(32)}!`);
const PROBE_TIMEOUT_MS = 100;
/** Failed attempts to write a run's row before its mark is dropped (recorded); the first retry waits RETRY_BASE_MS, doubling */
export const MAX_SPEND_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
/** A mark whose run is still active this long after it was made was left by a crash: the run's real end marks it again */
const STALE_MARK_MS = 24 * 3600_000;
/** Failed marks kept for another try at most (a database that stays broken doesn't grow memory) */
const MAX_UNMARKED = 1000;

/** An adapter's usage parser, resolved: its request pattern compiled once, at config load. */
export interface ResolvedUsageParser {
  kind: UsageParserKind;
  requestPattern?: RegExp;
}

export interface SpendSettings {
  enabled: boolean;
  /** Adapter id -> its parser (every adapter the project can use: the built-ins and agent_adapters) */
  parsers: Record<string, ResolvedUsageParser>;
  /** Per-run rows are kept this many days, daily aggregates this many (D4) */
  retentionDays: number;
  aggregateDays: number;
  /** On first enable, runs that ended this many days back get rows classified from what Lair holds */
  backfillDays: number;
  /** The daily summary's time: minutes past 00:00 UTC */
  dailySummaryMinute: number;
  /** Notice thresholds (null: that notice is off) */
  notice: { wasteShare: number | null; minRuns: number; taskAttempts: number | null };
  /** fill follows a WAITING line's wake to a file (fill on, wake.file set) */
  wakeWatched: boolean;
  /** The guards spend counts for: G2 (agents.spend.guards.task_no_result_cap) */
  guards: { taskNoResultCap: { mode: "off" | "observe" | "act"; max: number; windowMs: number } };
}

/**
 * agents.spend's own checks, errors naming the key: notice.waste_share in (0, 1], aggregate_days at least
 * retention_days, daily_summary_utc "HH:MM". The summary's minute past 00:00 UTC.
 */
export function spendConfigErrors(
  spend: { retention_days: number; aggregate_days: number; daily_summary_utc: string; notice: { waste_share?: number } },
  errors: string[],
): number {
  const share = spend.notice.waste_share;
  if (share !== undefined && !(share > 0 && share <= 1)) errors.push(`agents.spend.notice.waste_share: a share in (0, 1] (it is ${share})`);
  if (spend.aggregate_days < spend.retention_days) {
    errors.push(`agents.spend.aggregate_days: at least agents.spend.retention_days (${spend.retention_days}): a day's runs go into its aggregate before they are deleted`);
  }
  const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(spend.daily_summary_utc);
  if (!time) {
    errors.push(`agents.spend.daily_summary_utc: "HH:MM" in UTC, e.g. "00:05"`);
    return 5;
  }
  return Number(time[1]) * 60 + Number(time[2]);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/**
 * Each adapter's usage parser: its own usage_parser, else `patterns` when agents.usage_patterns is set, else the
 * built-in default for its id, else `none`. Errors name the key: an unknown parser, a request_pattern that isn't a
 * case-sensitive regular expression of at most 500 characters (or matches the empty line), a request_pattern on
 * another parser, request-lines without a pattern, and an `estimate` key (nothing is estimated).
 */
export function resolveUsageParsers(project: ProjectConfig | undefined, usagePatternsSet: boolean, errors: string[]): Record<string, ResolvedUsageParser> {
  const raw: unknown = project ? (project as ProjectConfig & { agent_adapters?: unknown }).agent_adapters : undefined;
  const custom = isObject(raw) ? raw : {};
  const parsers: Record<string, ResolvedUsageParser> = {};
  for (const adapter of listAdapters(project)) {
    // A project's adapter may leave `id` out: the key it was given under is its id
    const id = Object.keys(custom).find((key) => custom[key] === adapter) ?? adapter.id;
    const where = `agent_adapters.${String(id).slice(0, 64)}`;
    const own = isObject(custom[id]) ? (custom[id] as Record<string, unknown>) : {};
    if (hasOwn(own, "estimate")) {
      errors.push(`${where}.estimate: Lair never estimates usage (tokens and cost are reported by the adapter or shown as not reported)`);
    }
    const builtin = BUILTIN_USAGE_PARSERS[id];
    const named = own.usage_parser;
    if (named !== undefined && (typeof named !== "string" || !USAGE_PARSERS.includes(named as UsageParserKind))) {
      errors.push(`${where}.usage_parser: one of ${USAGE_PARSERS.join(", ")}`);
      continue;
    }
    const kind: UsageParserKind = (named as UsageParserKind | undefined) ?? (usagePatternsSet ? "patterns" : builtin?.parser ?? "none");
    const ownPattern = own.request_pattern;
    if (ownPattern !== undefined && kind !== "request-lines") {
      errors.push(`${where}.request_pattern: only read with usage_parser: request-lines (this adapter's is ${kind})`);
      continue;
    }
    if (kind !== "request-lines") {
      parsers[id] = { kind };
      continue;
    }
    const source = ownPattern ?? builtin?.requestPattern;
    if (source === undefined) {
      errors.push(`${where}.request_pattern: usage_parser request-lines needs a request_pattern (a regular expression for one model request)`);
      continue;
    }
    const problem = requestPatternProblem(source);
    if (problem) {
      errors.push(`${where}.request_pattern: ${problem}`);
      continue;
    }
    // Case-sensitive, tested line by line (no "g": test() keeps no state between lines)
    parsers[id] = { kind, requestPattern: new RegExp(source as string) };
  }
  return parsers;
}

function requestPatternProblem(source: unknown): string | null {
  if (typeof source !== "string" || source.length === 0) return "a regular expression";
  if (source.length > MAX_REQUEST_PATTERN_CHARS) return `at most ${MAX_REQUEST_PATTERN_CHARS} characters (it has ${source.length})`;
  let re: RegExp;
  try {
    re = new RegExp(source);
  } catch (e) {
    return `not a valid regular expression (${e instanceof Error ? e.message : String(e)})`;
  }
  if (re.test("")) return "it matches an empty line, so it would count every line";
  if (countMatchingLines(re, PROBE_LINES, PROBE_TIMEOUT_MS) === null) {
    return `it takes over ${PROBE_TIMEOUT_MS} ms on a short line (nested quantifiers backtrack): simplify it`;
  }
  return null;
}

/**
 * The guard keys that need agents.spend (docs/design/ai-spend.md §4): a guard's verdicts and counts are written
 * by spend, and the request and minute budgets are counted from it. Read from the raw `agents:` block, so a key
 * whose guard isn't built yet is named with the reason too. budgets.guard_mode isn't one: the token and cost
 * limits work without spend.
 */
const GUARD_MODE_PATHS: readonly (readonly string[])[] = [
  ["failover", "quota", "mode"],
  ["spend", "guards", "task_no_result_cap", "mode"],
  ["fill", "wake", "events", "mode"],
  ["recovery", "hung_repeat", "mode"],
];
const SPEND_BUDGET_METRICS = ["daily_requests", "daily_minutes", "monthly_requests", "monthly_minutes"];

export function guardsNeedSpendErrors(raw: unknown): string[] {
  if (!isObject(raw)) return [];
  const spend = raw.spend;
  if (isObject(spend) && spend.enabled === true) return [];
  const errors: string[] = [];
  for (const path of GUARD_MODE_PATHS) {
    let value: unknown = raw;
    for (const key of path) value = isObject(value) && hasOwn(value, key) ? value[key] : undefined;
    if (value !== undefined && value !== "off") {
      errors.push(`agents.${path.join(".")}: ${String(value).slice(0, 20)} needs agents.spend.enabled: true (a guard's verdicts and counts are written by spend)`);
    }
  }
  const budgets = isObject(raw.budgets) ? raw.budgets : {};
  const scopes: [string, unknown][] = [
    ["agents.budgets.project", budgets.project],
    ["agents.budgets.agent", budgets.agent],
    ...Object.entries(isObject(budgets.per_agent) ? budgets.per_agent : {}).map(
      ([agent, limits]): [string, unknown] => [`agents.budgets.per_agent.${agent.slice(0, 64)}`, limits],
    ),
  ];
  for (const [where, limits] of scopes) {
    if (!isObject(limits)) continue;
    for (const metric of SPEND_BUDGET_METRICS) {
      if (hasOwn(limits, metric)) errors.push(`${where}.${metric}: needs agents.spend.enabled: true (counted from the spend records)`);
    }
  }
  return errors;
}

// ============ READING A LOG ============

interface TokenFields {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * What an ended run's log says about its usage: reported by the CLI (the four token fields, cost, turns), already
 * in the ledger (usage_patterns: a total only), request lines counted, or nothing (with why, when it was refused).
 */
export type LogUsage =
  | { source: "reported"; tokens: TokenFields; cost: number; turns: number; model: string | null }
  | { source: "ledger"; tokens: number; cost: number }
  | { source: "requests"; requests: number }
  | { source: "none"; refused?: string };

/** finite and >= 0, else 0 (the agent writes this text) */
const amount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

interface ResultTotals {
  results: number;
  turns: number;
  /** The `usage` of every result summed: the process's tokens when the last result has no modelUsage */
  summed: TokenFields;
  last: { modelUsage: unknown; cost: unknown } | null;
  /** A line that looked like a result event but wasn't valid JSON */
  unreadable: number;
  /** A line over MAX_LINE_BYTES came after the last result read: it may be the final one */
  oversizeAfterLast: boolean;
}

/** An in-progress read of one ended run's log, over as many ticks as its size needs. */
interface LogScan {
  kind: "results" | "requests";
  pattern?: RegExp;
  offset: number;
  end: number;
  decoder: StringDecoder;
  carry: string;
  /** Inside a line over MAX_LINE_BYTES: skipped up to its end */
  skipping: boolean;
  requests: number;
  totals: ResultTotals;
  refused?: string;
  /** The drain's request_pattern time so far (shared by the scans of one drain) */
  vm: VmTime;
}

/** Time the request_pattern ran in one drain, in ms: past VM_MS_PER_TICK the drain stops for that tick */
interface VmTime {
  spent: number;
}

const requestContext = createContext({ re: /./, lines: [] as string[], n: 0 });
const requestScript = new Script("n = 0; for (const line of lines) if (re.test(line)) n++;");

/** The lines `re` matches, interrupted after `timeoutMs` (a pattern that backtracks badly): null then. */
function countMatchingLines(re: RegExp, lines: string[], timeoutMs = REQUEST_PATTERN_TIMEOUT_MS): number | null {
  requestContext.re = re;
  requestContext.lines = lines;
  requestContext.n = 0;
  try {
    requestScript.runInContext(requestContext, { timeout: timeoutMs });
    return typeof requestContext.n === "number" ? requestContext.n : null;
  } catch {
    return null;
  } finally {
    requestContext.lines = [];
  }
}

function emptyTotals(): ResultTotals {
  return {
    results: 0,
    turns: 0,
    summed: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    last: null,
    unreadable: 0,
    oversizeAfterLast: false,
  };
}

/** One complete log line, for a results scan. */
function resultLine(totals: ResultTotals, line: string): void {
  // The CLI writes each event as one compact JSON object; anything the agent printed is escaped inside one
  if (!line.startsWith("{") || !line.includes('"type":"result"')) return;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    totals.unreadable++;
    return;
  }
  if (!isObject(event) || event.type !== "result") return;
  totals.results++;
  totals.oversizeAfterLast = false;
  totals.turns += amount(event.num_turns);
  const usage = isObject(event.usage) ? event.usage : {};
  totals.summed.input += amount(usage.input_tokens);
  totals.summed.cacheWrite += amount(usage.cache_creation_input_tokens);
  totals.summed.cacheRead += amount(usage.cache_read_input_tokens);
  totals.summed.output += amount(usage.output_tokens);
  totals.last = { modelUsage: event.modelUsage, cost: event.total_cost_usd };
}

/** Complete lines (joined by "\n"), each at most MAX_LINE_CHARS. */
function processLines(scan: LogScan, lines: string[]): void {
  if (lines.length === 0 || scan.refused) return;
  if (scan.kind === "requests") {
    // One run of the pattern over a chunk's lines, in a vm that interrupts it: a pattern that backtracks badly fails
    const started = performance.now();
    const n = countMatchingLines(scan.pattern!, lines);
    scan.vm.spent += performance.now() - started;
    if (n === null) scan.refused = `its request_pattern took over ${REQUEST_PATTERN_TIMEOUT_MS} ms on a part of the log`;
    else scan.requests += n;
    return;
  }
  for (const line of lines) resultLine(scan.totals, line.endsWith("\r") ? line.slice(0, -1) : line);
}

/** A line over MAX_LINE_CHARS is not read. For a results scan it may have been a result event. */
function skipped(scan: LogScan): void {
  if (scan.kind === "results") scan.totals.oversizeAfterLast = true;
}

/**
 * Feed decoded text: complete lines are processed, the last partial line is carried to the next chunk (one that
 * grows over MAX_LINE_CHARS is skipped to its end). `final`: the end of the log, so the carried line is complete.
 */
function feed(scan: LogScan, text: string, final: boolean): void {
  let rest = text;
  if (scan.skipping) {
    const nl = rest.indexOf("\n");
    if (nl < 0) {
      if (final) scan.skipping = false;
      return;
    }
    scan.skipping = false;
    rest = rest.slice(nl + 1);
  }
  const all = scan.carry + rest;
  scan.carry = "";
  const nl = all.lastIndexOf("\n");
  const lines = nl < 0 ? [] : all.slice(0, nl).split("\n");
  const partial = nl < 0 ? all : all.slice(nl + 1);
  if (final) lines.push(partial);
  const kept: string[] = [];
  for (const line of lines) {
    if (line.length <= MAX_LINE_CHARS) kept.push(line);
    else skipped(scan);
  }
  processLines(scan, kept);
  if (final) return;
  if (partial.length > MAX_LINE_CHARS) {
    skipped(scan);
    scan.skipping = true;
  } else {
    scan.carry = partial;
  }
}

/**
 * Read up to `budget` more bytes of the scan's log (async, chunk by chunk). The bytes used, and whether the scan
 * is over: it reached the end of the log, or stopped for good (refused or unreadable).
 */
async function stepScan(scan: LogScan, path: string, budget: number): Promise<{ used: number; done: boolean }> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    scan.refused = "its log can't be read (moved or deleted)";
    return { used: 0, done: true };
  }
  let used = 0;
  try {
    const { size } = await handle.stat();
    if (size < scan.offset) {
      scan.refused = "its log was rewritten while it was read";
      return { used, done: true };
    }
    while (scan.offset < scan.end && used < budget && !scan.refused && scan.vm.spent < VM_MS_PER_TICK) {
      const length = Math.min(SCAN_CHUNK_BYTES, scan.end - scan.offset);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, scan.offset);
      if (bytesRead === 0) {
        scan.end = scan.offset; // shorter than it was: what is there is the log
        break;
      }
      scan.offset += bytesRead;
      used += bytesRead;
      feed(scan, scan.decoder.write(buffer.subarray(0, bytesRead)), false);
    }
    const done = scan.offset >= scan.end || scan.refused !== undefined;
    if (done && !scan.refused) feed(scan, scan.decoder.end(), true);
    return { used, done };
  } catch (e) {
    scan.refused = `its log can't be read (${e instanceof Error ? e.message : String(e)})`;
    return { used, done: true };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The usage a finished results scan reports (or why it is refused). */
function resultsUsage(scan: LogScan): LogUsage {
  const totals = scan.totals;
  if (scan.refused) return { source: "none", refused: scan.refused };
  if (totals.results === 0) {
    if (totals.oversizeAfterLast) return { source: "none", refused: "a line over 1 MB may be its result event: such a line is not read" };
    if (totals.unreadable > 0) return { source: "none", refused: "its result event is not valid JSON" };
    return { source: "none" };
  }
  if (totals.oversizeAfterLast) {
    return { source: "none", refused: "a line over 1 MB came after its last result event: the totals may be in it, and such a line is not read" };
  }
  const last = totals.last!;
  // The last result's modelUsage holds the process's totals per model; without it, the results' own usage summed
  let tokens = totals.summed;
  let model: string | null = null;
  if (isObject(last.modelUsage) && Object.keys(last.modelUsage).length > 0) {
    tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    for (const [name, usage] of Object.entries(last.modelUsage)) {
      if (model === null && MODEL_NAME.test(name)) model = name;
      if (!isObject(usage)) continue;
      tokens.input += amount(usage.inputTokens);
      tokens.cacheWrite += amount(usage.cacheCreationInputTokens);
      tokens.cacheRead += amount(usage.cacheReadInputTokens);
      tokens.output += amount(usage.outputTokens);
    }
  }
  const cost = amount(last.cost);
  const all = tokens.input + tokens.cacheWrite + tokens.cacheRead + tokens.output;
  if (all > MAX_RUN_TOKENS || cost > MAX_RUN_COST) {
    return { source: "none", refused: `its reported usage is over the cap per run (tokens ${MAX_RUN_TOKENS}, cost ${MAX_RUN_COST})` };
  }
  const round = (n: number) => Math.round(n);
  return {
    source: "reported",
    tokens: { input: round(tokens.input), cacheWrite: round(tokens.cacheWrite), cacheRead: round(tokens.cacheRead), output: round(tokens.output) },
    cost,
    turns: round(totals.turns),
    model,
  };
}

// ============ CLASSIFYING AN END ============

/** A run's origin, else its task id's prefix (runs recorded before their module set one), else "other". */
export function originOf(run: Pick<AgentRun, "origin" | "task">): RunOrigin | "other" {
  if (run.origin) return run.origin;
  const prefix = /^(review|planner|verifier|supervisor)-/.exec(run.task);
  return prefix ? (prefix[1] as RunOrigin) : "other";
}

/** How a run ended, for one that ended before its end kind was kept. */
export function endKindOf(run: AgentRun): RunEndKind {
  if (run.endKind) return run.endKind;
  if (run.state === "completed") return "completed";
  if (run.state === "never_started") return "never_started";
  if (run.state === "lost_claim" || run.state === "superseded") return "lost_claim";
  return "crashed";
}

/** The no-result ends G2 counts (§4.2, decision D2): not a Lair restart's (exit_unknown, lost, vars_lost) or a stop */
const CAP_COUNTED: ReadonlySet<RunEndKind> = new Set<RunEndKind>([
  "hung",
  "crashed",
  "dead_on_start",
  "never_started",
  "rate_limit",
  "provider_error",
  "unreachable",
  "lost_claim",
]);

/** Whether an ended run counts toward a task's no-result cap (G2); a superseded run never ran, so it doesn't. */
export function countsTowardCap(run: AgentRun): boolean {
  return run.state !== "superseded" && CAP_COUNTED.has(endKindOf(run));
}

// ============ THE RECORDER ============

export interface SpendRecorderOptions {
  project: string;
  store: AgentsStore;
  settings: SpendSettings;
  now: () => number;
  budget?: FleetBudget;
  /** The run's own queue line for its task (AgentsService.reportedOutcome) */
  outcome: (run: AgentRun) => Promise<QueueOutcome | null>;
  /** Record an agents event (AgentsService.record) */
  record: (kind: AgentEventKind, input: { agent?: string; task?: string; runId?: string; subject?: string; summary: string; evidence?: string[]; data?: Record<string, unknown>; dedupeKey?: string }, at: number) => Promise<boolean>;
  /** What other modules recorded about the runs they asked for (unset: their runs stay unclassified) */
  facts?: () => SpendFacts | undefined;
  /** Each guard's mode, as the project's config sets it */
  guardModes?: () => Record<SpendGuardId, SpendGuardView["mode"]>;
  /** Raise a Decision Inbox notice (attention: notice) once per key; false when it wasn't raised */
  notice?: (notice: SpendNotice) => Promise<boolean>;
  /** Publish on the event bus */
  emit?: (type: "agents.spend.daily", data: Record<string, unknown>) => Promise<void>;
  warn?: (line: string) => void;
}

/** A notice for the owner (attention: notice): titles and numbers only */
export interface SpendNotice {
  key: string;
  /** `spend:<what>`: AgentsService withdraws it once SpendRecorder.moot says its condition cleared */
  ref: string;
  question: string;
  context: string;
  /** Its evidence code and facts (numbers and ids), for the decision's structure (class agents.spend_notice) */
  code?: string;
  facts?: Record<string, string | number | boolean | null>;
}

/** Runs a first enable's backfill classifies per tick */
const BACKFILL_PER_TICK = 200;
/** Days retention aggregates and deletes per tick (each day in one transaction) */
const PRUNE_DAYS_PER_TICK = 31;
/** Tasks over the attempts threshold looked at per tick */
const NOTICE_TASKS_PER_TICK = 50;
const BACKFILL_START = "spend_backfill:start";
const BACKFILL_DONE = "spend_backfill:done";

/** A model call a module made without an agent run (spend.recordCall). */
export interface ModelCall {
  /** The module that made it, e.g. "brain" */
  module: string;
  provider: string;
  tokens?: number;
  cost?: number;
}

const MODULE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export class SpendRecorder {
  /** Reads in progress, by run id (a restart starts a log over: its row isn't written until a read finishes) */
  private scans = new Map<string, LogScan>();
  /** Ends whose mark failed to write, by run id (written again by markAgain) */
  private unmarked = new Map<string, { at: number; attempts: number; why: string; agent: string; task: string }>();
  private readonly classifier: SpendClassifier;
  /** The backfill's place in the run list (from the start again after a restart: a run with a row is skipped) */
  private backfillAfter: { requestedAt: number; id: string } | null = null;
  /** The UTC day retention last finished (it runs at most once a day) */
  private prunedDay: string | null = null;

  constructor(private readonly o: SpendRecorderOptions) {
    this.classifier = new SpendClassifier({
      project: o.project,
      store: o.store,
      wakeWatched: () => o.settings.wakeWatched,
      facts: () => o.facts?.(),
    });
  }

  get enabled(): boolean {
    return this.o.settings.enabled;
  }

  /** The run's adapter's parser (none for an adapter the config doesn't know). */
  parserFor(run: Pick<AgentRun, "profile">): ResolvedUsageParser {
    return this.o.settings.parsers[run.profile.adapter] ?? { kind: "none" };
  }

  /** agents.usage_patterns are read while the run works only for an adapter on the patterns parser (or with spend off). */
  readsPatterns(run: Pick<AgentRun, "profile">): boolean {
    return !this.enabled || this.parserFor(run).kind === "patterns";
  }

  /**
   * A run ended (synchronously, as it ends): its row is owed. Never throws. A mark that can't be written (a busy or
   * full database) is kept here and written again by the next drains; after MAX_SPEND_ATTEMPTS in all, the run is
   * given up with a usage_refused event, so no row is lost without a word.
   */
  ended(run: AgentRun, at: number): void {
    if (!this.enabled) return;
    try {
      this.o.store.markSpendPending(this.o.project, run.id, at);
    } catch (e) {
      this.o.warn?.(`[agents] ${this.o.project}: run ${run.id.slice(0, 8)}'s spend row could not be marked owed (tried again next tick): ${message(e)}`);
      if (this.unmarked.size < MAX_UNMARKED) {
        this.unmarked.set(run.id, { at, attempts: 1, why: message(e), agent: run.agent, task: run.task });
      }
    }
  }

  /** The marks that failed in ended(), written again (each drain, MAX_SPEND_ATTEMPTS in all). Never throws. */
  private async markAgain(): Promise<void> {
    for (const [runId, mark] of [...this.unmarked]) {
      try {
        this.o.store.markSpendPending(this.o.project, runId, mark.at);
        this.unmarked.delete(runId);
        continue;
      } catch (e) {
        mark.attempts++;
        mark.why = message(e);
      }
      if (mark.attempts < MAX_SPEND_ATTEMPTS) continue;
      this.unmarked.delete(runId);
      try {
        await this.o.record(
          "usage_refused",
          {
            agent: mark.agent,
            task: mark.task,
            runId,
            summary: `run ${runId.slice(0, 8)} (${mark.agent} on ${mark.task}) gets no spend row: its end could not be recorded after ${mark.attempts} attempts: ${mark.why}`,
            evidence: [mark.why],
            data: { why: mark.why, stage: "mark", attempts: mark.attempts },
            dedupeKey: `usage_refused:${runId}`,
          },
          this.o.now(),
        );
      } catch (e) {
        this.o.warn?.(`[agents] ${this.o.project}: run ${runId.slice(0, 8)} gets no spend row (${mark.why}), and that could not be recorded: ${message(e)}`);
      }
    }
  }

  /**
   * Write the owed rows: at most MAX_RUNS_PER_TICK runs and SCAN_BYTES_PER_TICK of log per call; a log that needs
   * more goes on next time. Never throws: a run whose row can't be written is retried, and after
   * MAX_SPEND_ATTEMPTS its mark is dropped with a usage_refused event.
   */
  async drain(): Promise<void> {
    if (!this.enabled) return;
    await this.markAgain();
    let budget = SCAN_BYTES_PER_TICK;
    const vm: VmTime = { spent: 0 };
    let pending;
    try {
      pending = this.o.store.pendingSpend(this.o.project, this.o.now(), MAX_RUNS_PER_TICK);
    } catch (e) {
      this.o.warn?.(`[agents] ${this.o.project}: the owed spend rows can't be read: ${message(e)}`);
      return;
    }
    for (const owed of pending) {
      if (budget <= 0 || vm.spent >= VM_MS_PER_TICK) break;
      try {
        const run = this.o.store.getRun(owed.runId);
        if (!run || this.o.store.getSpend(owed.runId)) {
          this.o.store.dropSpendPending(owed.runId);
          this.scans.delete(owed.runId);
          continue;
        }
        if (isActive(run.state)) {
          // Its end isn't saved yet (it is, in the same step that ends it); a mark a crash left behind goes after a day
          if (this.o.now() - owed.endedAt > STALE_MARK_MS) this.o.store.dropSpendPending(owed.runId);
          continue;
        }
        const read = await this.usageOf(run, budget, vm);
        budget -= read.used;
        if (read.usage === null) continue; // more of its log next time
        await this.write(run, read.usage);
      } catch (e) {
        this.scans.delete(owed.runId);
        await this.failed(owed.runId, owed.attempts, message(e));
      }
    }
  }

  /** The usage of an ended run: null while its log is still being read. */
  private async usageOf(run: AgentRun, budget: number, vm: VmTime): Promise<{ usage: LogUsage | null; used: number }> {
    const parser = this.parserFor(run);
    if (parser.kind === "none") return { usage: { source: "none" }, used: 0 };
    if (parser.kind === "patterns") {
      // Read while it worked, into the ledger: the row takes the run's total (patterns don't split tokens)
      const ledger = this.o.store.usageForRun(run.id);
      return { usage: ledger ? { source: "ledger", tokens: ledger.tokens, cost: ledger.cost } : { source: "none" }, used: 0 };
    }
    if (!run.logPath) return { usage: { source: "none" }, used: 0 };
    let scan = this.scans.get(run.id);
    if (!scan) {
      const st = await statOrNull(run.logPath);
      if (!st) return { usage: { source: "none", refused: "its log can't be read (moved or deleted)" }, used: 0 };
      if (st.size > MAX_LOG_BYTES) return { usage: { source: "none", refused: `its log is over ${MAX_LOG_BYTES} bytes: not read` }, used: 0 };
      scan = {
        kind: parser.kind === "request-lines" ? "requests" : "results",
        pattern: parser.requestPattern,
        offset: Math.min(run.logOffset ?? 0, st.size),
        end: st.size,
        decoder: new StringDecoder("utf8"),
        carry: "",
        skipping: false,
        requests: 0,
        totals: emptyTotals(),
        vm,
      };
      this.scans.set(run.id, scan);
    }
    scan.vm = vm;
    const step = await stepScan(scan, run.logPath, budget);
    if (!step.done) return { usage: null, used: step.used };
    this.scans.delete(run.id);
    if (scan.kind === "requests") {
      return { usage: scan.refused ? { source: "none", refused: scan.refused } : { source: "requests", requests: scan.requests }, used: step.used };
    }
    return { usage: resultsUsage(scan), used: step.used };
  }

  /** The row of an ended run: who, how long, how it ended (classified), and its usage. */
  private async rowOf(run: AgentRun, usage: LogUsage, outcome: QueueOutcome | null, backfilled: boolean): Promise<SpendRow> {
    const now = this.o.now();
    const origin = originOf(run);
    const end = endKindOf(run);
    const endedAt = run.endedAt ?? now;
    const spawnedAt = run.spawnedAt ?? null;
    const classified: Classified = this.classifier.atEnd(run, end, origin, outcome, endedAt, backfilled || now - endedAt >= CLASSIFY_WAIT_MS);
    // An end Lair didn't see: the log's last write, not when Lair noticed
    let until = endedAt;
    if ((run.exitUnseen || end === "exit_unknown" || end === "lost") && run.logPath && spawnedAt !== null) {
      const st = await statOrNull(run.logPath);
      if (st && st.mtimeMs >= spawnedAt && st.mtimeMs <= endedAt) until = Math.round(st.mtimeMs);
    }
    const previous = run.previousRunId ? this.o.store.getRun(run.previousRunId) : null;
    const reported = usage.source === "reported" ? usage : null;
    // Tokens as the budgets count them: cache reads are kept in the row only (billed at a fraction of the input
    // price, they would swamp a token budget)
    const tokens = reported
      ? reported.tokens.input + reported.tokens.cacheWrite + reported.tokens.output
      : usage.source === "ledger"
        ? usage.tokens
        : null;
    return {
      runId: run.id,
      project: this.o.project,
      agent: run.agent,
      task: run.task,
      chainId: run.chainId,
      origin,
      adapter: run.profile.adapter,
      provider: run.profile.provider,
      model: run.profile.model ?? reported?.model ?? null,
      startedAt: spawnedAt,
      endedAt,
      runtimeS: spawnedAt === null ? 0 : Math.max(0, Math.round((until - spawnedAt) / 1000)),
      class: classified.class,
      reason: classified.reason,
      sessionMode: run.sessionMode,
      reload: (run.sessionMode === "resume" || run.sessionMode === "fresh") && previous !== null && previous.state !== "completed",
      lairRestart: end === "exit_unknown" || end === "lost" || end === "vars_lost",
      usageSource: usage.source === "ledger" ? "reported" : usage.source,
      inputTokens: reported ? reported.tokens.input : null,
      cacheWriteTokens: reported ? reported.tokens.cacheWrite : null,
      cacheReadTokens: reported ? reported.tokens.cacheRead : null,
      outputTokens: reported ? reported.tokens.output : null,
      tokens,
      requests: usage.source === "requests" ? usage.requests : null,
      turns: reported ? reported.turns : null,
      cost: usage.source === "reported" || usage.source === "ledger" ? usage.cost : null,
      contextBytes: run.contextBytes ?? 0,
      pr: classified.pr,
      headSha: classified.headSha,
      blockerKey: classified.blockerKey,
      backfilled,
      usageRecorded: true,
    };
  }

  private async write(run: AgentRun, usage: LogUsage): Promise<void> {
    const now = this.o.now();
    const outcome = endKindOf(run) === "completed" ? await this.o.outcome(run) : null;
    const row = await this.rowOf(run, usage, outcome, false);
    const reported = usage.source === "reported" ? usage : null;
    const tokens = row.tokens;
    const endedAt = row.endedAt;
    const parserName = this.parserFor(run).kind;
    // usage_patterns' usage is in the ledger already (readUsage); a parser's goes there with the row
    const ledger: UsageRecord | null =
      reported
        ? {
            project: this.o.project,
            agent: run.agent,
            provider: run.profile.provider,
            runId: run.id,
            tokens: tokens ?? 0,
            cost: reported.cost,
            at: endedAt,
            reason: `usage of run ${run.id.slice(0, 8)} (${parserName})`,
          }
        : null;
    const written = this.o.store.recordSpend(row, ledger);
    if (!written) return;
    if (ledger && ledger.cost > 0) {
      // The fleet budget's own provider caps see the cost too (no attribution: the ledger row is written above)
      try {
        this.o.budget?.recordCost(ledger.provider, ledger.cost, ledger.reason);
      } catch (e) {
        this.o.warn?.(`[agents] ${this.o.project}: the fleet budget refused run ${run.id.slice(0, 8)}'s cost: ${message(e)}`);
      }
    }
    if (usage.source === "none" && usage.refused) {
      await this.o.record(
        "usage_refused",
        {
          agent: run.agent,
          task: run.task,
          runId: run.id,
          subject: run.profile.provider,
          summary: `the usage of run ${run.id.slice(0, 8)} (${run.agent} on ${run.task}) is not reported: ${usage.refused}`,
          evidence: [`usage_parser ${parserName}`, usage.refused],
          data: { parser: parserName, why: usage.refused },
          dedupeKey: `usage_refused:${run.id}`,
        },
        now,
      );
    }
  }

  private async failed(runId: string, attempts: number, why: string): Promise<void> {
    try {
      // Tried again after 30 s, doubling (at most MAX_SPEND_ATTEMPTS times in all)
      this.o.store.spendAttemptFailed(runId, why, this.o.now() + RETRY_BASE_MS * 2 ** attempts);
      if (attempts + 1 < MAX_SPEND_ATTEMPTS) return;
      this.o.store.dropSpendPending(runId);
      await this.o.record(
        "usage_refused",
        {
          runId,
          summary: `the spend row of run ${runId.slice(0, 8)} was not written after ${MAX_SPEND_ATTEMPTS} attempts: ${why}`,
          evidence: [why],
          data: { why, attempts: attempts + 1 },
          dedupeKey: `usage_refused:${runId}`,
        },
        this.o.now(),
      );
    } catch (e) {
      this.o.warn?.(`[agents] ${this.o.project}: run ${runId.slice(0, 8)}'s spend row: ${message(e)}`);
    }
  }

  // ============ PART 2: CLASSIFY, SUM UP, NOTICE ============

  /**
   * The tick's other spend steps, after drain, each bounded and never throwing: rows whose module had no record yet
   * are classified; a first enable's backfill goes on; the day that ended is summed up (once); retention runs (once a
   * day); the notices are raised.
   */
  async maintain(): Promise<void> {
    if (!this.enabled) return;
    const steps: [string, () => Promise<void> | void][] = [
      ["classify", () => this.classifyPending()],
      ["backfill", () => this.backfill()],
      ["daily summary", () => this.dailySummary()],
      ["retention", () => this.prune()],
      ["notices", () => this.notices()],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (e) {
        this.o.warn?.(`[agents] ${this.o.project}: AI spend ${name}: ${message(e)}`);
      }
    }
  }

  /** Rows written unclassified (their module hadn't recorded its result): classified once it has, or once it's late. */
  private classifyPending(): void {
    const now = this.o.now();
    for (const row of this.o.store.unclassifiedSpend(this.o.project, now - CLASSIFY_LOOKBACK_MS, CLASSIFY_PER_TICK)) {
      const run = this.o.store.getRun(row.runId);
      if (!run) continue;
      const classified = this.classifier.later(row, run, now - row.endedAt >= CLASSIFY_WAIT_MS);
      if (classified) this.o.store.classifySpend(row.runId, classified);
    }
  }

  /**
   * On first enable, the runs that ended in the backfill_days before it get rows (backfilled, usage none: their
   * logs may be gone), classified from the run records and events Lair holds (never the queue file). The window is
   * fixed by its start event, so a restart goes on with the same one; a run with a row is skipped. Bounded per tick.
   */
  private async backfill(): Promise<void> {
    const { store, project } = this.o;
    if (store.hasEvent(project, BACKFILL_DONE)) return;
    const now = this.o.now();
    let start = store.getEventByKey(project, BACKFILL_START);
    if (!start) {
      const from = now - this.o.settings.backfillDays * DAY_MS;
      await this.o.record(
        "spend_backfill",
        { summary: `AI spend: classifying the runs that ended since ${new Date(from).toISOString()}`, data: { from, to: now }, dedupeKey: BACKFILL_START },
        now,
      );
      start = store.getEventByKey(project, BACKFILL_START);
      if (!start) return;
    }
    const from = Number(start.data.from);
    const to = Number(start.data.to);
    // A run requested up to a day before the window may have ended in it
    const runs = store.runsRequestedBetween(project, from - DAY_MS, to, this.backfillAfter, BACKFILL_PER_TICK);
    let written = 0;
    for (const run of runs) {
      this.backfillAfter = { requestedAt: run.requestedAt, id: run.id };
      if (isActive(run.state) || run.endedAt === undefined || run.endedAt < from || run.endedAt >= to || store.getSpend(run.id)) continue;
      const outcome = this.recordedOutcome(run);
      const row = await this.rowOf(run, { source: "none" }, outcome, true);
      // A completed builder run whose line fill never recorded (not a fill task): its line is unknown here, and the
      // queue file isn't read again for it, so it isn't called idle
      if (row.class === "idle" && row.reason === "no_line" && outcome === null && row.origin !== "fill") {
        row.class = "unclassified";
        row.reason = "not_recorded";
      }
      if (store.recordSpend(row, null)) written++;
    }
    if (runs.length < BACKFILL_PER_TICK) {
      await this.o.record(
        "spend_backfill",
        { summary: `AI spend: the runs of the ${this.o.settings.backfillDays} days before it was turned on are classified (usage not reported)`, data: { from, to, written }, dedupeKey: BACKFILL_DONE },
        now,
      );
    }
  }

  /**
   * A run's queue line as Lair recorded it, for the backfill (never read again): fill's fill_done, fill_waiting or
   * fill_blocked, or the line an exit-unknown run was completed by (its `completed` event).
   */
  private recordedOutcome(run: AgentRun): QueueOutcome | null {
    const events = this.o.store.listEvents(this.o.project, { kinds: ["fill_done", "fill_waiting", "fill_blocked", "completed"], task: run.task, runId: run.id, limit: 10 });
    const kindOf = (e: (typeof events)[number]): QueueOutcome["kind"] | null => {
      if (e.kind === "fill_done") return "done";
      if (e.kind === "fill_waiting") return "waiting";
      if (e.kind === "fill_blocked") return "blocked";
      const as = e.data.classifiedAs;
      return as === "done" || as === "waiting" || as === "blocked" ? as : null;
    };
    const seen = events.find((e) => kindOf(e) === "done") ?? events.find((e) => kindOf(e) !== null);
    if (!seen) return null;
    const line = typeof seen.data.line === "string" ? seen.data.line : "";
    return { kind: kindOf(seen)!, line, wake: typeof seen.data.wake === "string" ? seen.data.wake : null };
  }

  /** The day's summary key (and the event bus's dedupe) */
  private dailyKey(day: string): string {
    return `spend_daily:${this.o.project}:${day}`;
  }

  /**
   * At daily_summary_utc, for the UTC day that just ended: its aggregates (written again from its rows), one
   * spend_daily event with the same totals the API gives for that day, and agents.spend.daily on the event bus.
   * Once per day, also across restarts (the event's dedupe key).
   */
  private async dailySummary(): Promise<void> {
    const now = this.o.now();
    const start = dayStart(now - this.o.settings.dailySummaryMinute * 60_000) - DAY_MS;
    const day = utcDay(start);
    const key = this.dailyKey(day);
    if (this.o.store.hasEvent(this.o.project, key)) return;
    this.o.store.aggregateSpendDay(this.o.project, day, start, false);
    const report = spendReportBetween({
      store: this.o.store,
      project: this.o.project,
      window: "today",
      by: "reason",
      now,
      from: start,
      to: start + DAY_MS,
      retentionDays: this.o.settings.retentionDays,
      facts: this.o.facts?.(),
      modes: this.modes(),
    });
    const data: Record<string, unknown> = {
      day,
      unit: report.unit,
      totals: report.totals,
      productive: report.productive,
      idle: report.idle,
      noResult: report.noResult,
      unclassified: report.unclassified,
      waste: report.waste,
      wasteShare: report.wasteShare,
      reloads: report.reloads,
      lairRestarts: report.lairRestarts,
      reasons: report.reasons.map((r) => ({ class: r.class, reason: r.reason, runs: r.totals.runs, minutes: r.totals.minutes, requests: r.totals.requests, cost: r.totals.cost })),
      topTasks: report.topTasks,
      planner: report.planner,
      guards: report.guards.map((g) => ({ guard: g.guard, mode: g.mode, would: g.would, did: g.did })),
    };
    const share = report.wasteShare === null ? "no runs" : `waste ${Math.round(report.wasteShare * 100)} % by ${report.unit}`;
    const recorded = await this.o.record("spend_daily", { summary: `AI spend ${day}: ${report.totals.runs} run(s), ${share}`, data, dedupeKey: key }, now);
    if (recorded) await this.o.emit?.("agents.spend.daily", { project: this.o.project, ...data });
  }

  /**
   * Retention (D4), at most once a UTC day: each whole day whose per-run rows are past retention_days is
   * aggregated again from its rows and its rows deleted, in one transaction per day (a late row is counted, and no
   * day is left half deleted); then the aggregates past aggregate_days go. Bounded per tick: the rest goes on next.
   */
  private prune(): void {
    const now = this.o.now();
    const today = utcDay(now);
    if (this.prunedDay === today) return;
    const { store, project, settings } = this.o;
    // Days that ended before this are wholly past retention
    const cutoff = dayStart(now - settings.retentionDays * DAY_MS);
    for (let i = 0; i < PRUNE_DAYS_PER_TICK; i++) {
      const oldest = store.oldestSpendBefore(project, cutoff);
      if (oldest === null) {
        store.pruneSpendDaily(project, utcDay(now - settings.aggregateDays * DAY_MS));
        this.prunedDay = today;
        return;
      }
      store.aggregateSpendDay(project, utcDay(oldest), dayStart(oldest), true);
    }
  }

  /**
   * The notices (each off until its threshold is set): spend_waste when today's waste share reaches
   * notice.waste_share with at least notice.min_runs runs (one per day); spend_task_attempts when a task's attempts
   * without a completion within 24 h reach notice.task_attempts (one per task and streak).
   */
  private async notices(): Promise<void> {
    const raise = this.o.notice;
    if (!raise) return;
    const { store, project, settings } = this.o;
    const now = this.o.now();
    const { wasteShare, minRuns, taskAttempts } = settings.notice;
    if (wasteShare !== null) {
      const day = utcDay(now);
      const report = spendReportBetween({
        store,
        project,
        window: "today",
        by: "project",
        now,
        from: dayStart(now),
        to: now + 1,
        retentionDays: settings.retentionDays,
        modes: this.modes(),
      });
      const share = report.wasteShare;
      if (report.totals.runs >= minRuns && share !== null && share >= wasteShare) {
        await raise({
          key: `spend_waste:${day}`,
          ref: `spend:waste:${day}`,
          code: "waste_share",
          facts: { day, runs: report.totals.runs, waste_share: Math.round(share * 10_000) / 10_000, unit: report.unit },
          question: `AI spend: ${Math.round(share * 100)} % of today's ${report.unit} went to idle or no-result runs`,
          context: [
            `Today (${day}, UTC): ${report.totals.runs} runs; ${report.productive.runs} productive, ${report.idle.runs} idle, ${report.noResult.runs} with no result.`,
            `The waste share by ${report.unit} is ${Math.round(share * 100)} % (the notice is at ${Math.round(wasteShare * 100)} %, from ${minRuns} runs).`,
            "",
            "The AI spend API (GET /api/agents/spend) has the reasons and the tasks. This notice is withdrawn when the day ends.",
          ].join("\n"),
        });
      }
    }
    if (taskAttempts !== null) {
      for (const streak of store.spendTaskStreaks(project, now - DAY_MS, now + 1, taskAttempts, NOTICE_TASKS_PER_TICK)) {
        const released = this.lastRelease(streak.task);
        let attempts = streak.attempts;
        if (released !== null && released >= streak.firstEndedAt) {
          attempts = store.listSpend(project, { task: streak.task, since: released + 1, limit: 10_000 }).length;
          if (attempts < taskAttempts) continue;
        }
        const marker = Math.max(store.lastSpendCompletion(project, streak.task) ?? 0, released ?? 0);
        await raise({
          key: `spend_task_attempts:${streak.task}:${marker}`,
          ref: `spend:attempts:${marker}:${streak.task}`,
          code: "task_attempts",
          facts: { task: streak.task, attempts, no_result: streak.noResult, chains: streak.chains },
          question: `AI spend: ${streak.task} took ${attempts} runs within 24 h without a completion`,
          context: [
            `${streak.task}: ${attempts} runs since its last completion within 24 h (${streak.noResult} with no result, over ${streak.chains} chain(s)); the notice is at ${taskAttempts}.`,
            "",
            "Its runs are in GET /api/agents/spend/runs. This notice is withdrawn once the task completes or is released.",
          ].join("\n"),
        });
      }
    }
  }

  /** When the task was last released (fill hold or claim), or null */
  private lastRelease(task: string): number | null {
    return this.o.store.listEvents(this.o.project, { kinds: ["fill_released", "claim_released"], task, limit: 1 })[0]?.at ?? null;
  }

  /**
   * Why a spend notice is moot (its ref after `spend:`), or null while it stands: a day's waste notice once the day
   * is over; a task's attempts notice, or a guard's would-park notice (`guard:<at>:<task>`), once the task completed
   * or was released after the streak it was raised for.
   */
  moot(rest: string): string | null {
    if (rest.startsWith("waste:")) {
      const day = rest.slice("waste:".length);
      return day !== utcDay(this.o.now()) ? `the day ${day} is over` : null;
    }
    const streak = rest.startsWith("attempts:") ? "attempts:" : rest.startsWith("guard:") ? "guard:" : null;
    if (streak) {
      const tail = rest.slice(streak.length);
      const at = tail.indexOf(":");
      const marker = Number(tail.slice(0, at));
      const task = tail.slice(at + 1);
      if (at <= 0 || !Number.isFinite(marker)) return null;
      if ((this.o.store.lastSpendCompletion(this.o.project, task) ?? 0) > marker) return `${task} completed`;
      if ((this.lastRelease(task) ?? 0) > marker) return `${task} was released`;
    }
    return null;
  }

  private modes(): Record<SpendGuardId, SpendGuardView["mode"]> {
    return this.o.guardModes?.() ?? guardModes({});
  }

  /**
   * A model call a module made without an agent run: one ledger row (run_id null, reason `call:<module>`), so its
   * tokens and cost count toward the budgets. False, writing nothing, while spend is off or the call is refused
   * (a bad module or provider name, an amount that isn't finite and non-negative, or over the cap). Never throws.
   */
  recordCall(call: ModelCall): boolean {
    if (!this.enabled) return false;
    const tokens = call.tokens ?? 0;
    const cost = call.cost ?? 0;
    const valid = (n: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max;
    if (!MODULE_NAME.test(call.module) || !PROVIDER_NAME.test(call.provider) || !valid(tokens, MAX_RUN_TOKENS) || !valid(cost, MAX_RUN_COST)) {
      return false;
    }
    try {
      this.o.store.addUsage({
        project: this.o.project,
        provider: call.provider,
        tokens,
        cost,
        at: this.o.now(),
        reason: `call:${call.module}`,
      });
      return true;
    } catch (e) {
      this.o.warn?.(`[agents] ${this.o.project}: a ${call.module} call's usage was not recorded: ${message(e)}`);
      return false;
    }
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
