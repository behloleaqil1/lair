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
import type { AgentEventKind, RunOrigin, UsageParserKind } from "../../shared/agents-types.js";
import { listAdapters } from "../services/adapters.js";
import { statOrNull } from "../services/async-fs.js";
import type { FleetBudget } from "./budgets.js";
import type { AgentsStore } from "./store.js";
import { isActive, type AgentRun, type RunEndKind, type SpendRow, type UsageRecord } from "./types.js";

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
/** Failed attempts to write a run's row before its mark is dropped (recorded); the first retry waits RETRY_BASE_MS, doubling */
export const MAX_SPEND_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
/** A mark whose run is still active this long after it was made was left by a crash: the run's real end marks it again */
const STALE_MARK_MS = 24 * 3600_000;

/** An adapter's usage parser, resolved: its request pattern compiled once, at config load. */
export interface ResolvedUsageParser {
  kind: UsageParserKind;
  requestPattern?: RegExp;
}

export interface SpendSettings {
  enabled: boolean;
  /** Adapter id -> its parser (every adapter the project can use: the built-ins and agent_adapters) */
  parsers: Record<string, ResolvedUsageParser>;
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
}

const requestContext = createContext({ re: /./, lines: [] as string[], n: 0 });
const requestScript = new Script("n = 0; for (const line of lines) if (re.test(line)) n++;");

/** The lines `re` matches, interrupted after REQUEST_PATTERN_TIMEOUT_MS (a pattern that backtracks badly): null then. */
function countMatchingLines(re: RegExp, lines: string[]): number | null {
  requestContext.re = re;
  requestContext.lines = lines;
  requestContext.n = 0;
  try {
    requestScript.runInContext(requestContext, { timeout: REQUEST_PATTERN_TIMEOUT_MS });
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
    const n = countMatchingLines(scan.pattern!, lines);
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
    while (scan.offset < scan.end && used < budget && !scan.refused) {
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
function endKindOf(run: AgentRun): RunEndKind {
  if (run.endKind) return run.endKind;
  if (run.state === "completed") return "completed";
  if (run.state === "never_started") return "never_started";
  if (run.state === "lost_claim" || run.state === "superseded") return "lost_claim";
  return "crashed";
}

/** The run's own queue line for its task, as fill reads it (null: none). */
export interface QueueOutcome {
  kind: "done" | "waiting" | "blocked";
  line: string;
}

/**
 * The class and reason this part can tell (docs/design/ai-spend.md §4.2): every failed end is no_result with its
 * kind; a DONE or READY line is productive; a BLOCKED line is productive (the repeat rule comes with the
 * classification PR); a builder run (fill, the owner's) that ended with no line is idle. What needs more than the
 * end and the line (a WAITING line's wake, a module run's review, proposals, verdicts or answer) is `unclassified`
 * until that PR classifies it.
 */
export function classifyEnd(run: AgentRun, origin: RunOrigin | "other", outcome: QueueOutcome | null): { class: SpendRow["class"]; reason: string } {
  const kind = endKindOf(run);
  if (kind !== "completed") return { class: "no_result", reason: kind };
  if (outcome?.kind === "done") return { class: "productive", reason: /^\s*-\s+READY\b/.test(outcome.line) ? "ready" : "done" };
  if (outcome?.kind === "blocked") return { class: "productive", reason: "blocked" };
  if (outcome === null && (origin === "fill" || origin === "owner" || origin === "other")) return { class: "idle", reason: "no_line" };
  return { class: "unclassified", reason: "pending" };
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
  warn?: (line: string) => void;
}

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

  constructor(private readonly o: SpendRecorderOptions) {}

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

  /** A run ended (synchronously, as it ends): its row is owed. Never throws. */
  ended(run: AgentRun, at: number): void {
    if (!this.enabled) return;
    try {
      this.o.store.markSpendPending(this.o.project, run.id, at);
    } catch (e) {
      this.o.warn?.(`[agents] ${this.o.project}: run ${run.id.slice(0, 8)}'s spend row is not owed: ${message(e)}`);
    }
  }

  /**
   * Write the owed rows: at most MAX_RUNS_PER_TICK runs and SCAN_BYTES_PER_TICK of log per call; a log that needs
   * more goes on next time. Never throws: a run whose row can't be written is retried, and after
   * MAX_SPEND_ATTEMPTS its mark is dropped with a usage_refused event.
   */
  async drain(): Promise<void> {
    if (!this.enabled) return;
    let budget = SCAN_BYTES_PER_TICK;
    let pending;
    try {
      pending = this.o.store.pendingSpend(this.o.project, this.o.now(), MAX_RUNS_PER_TICK);
    } catch (e) {
      this.o.warn?.(`[agents] ${this.o.project}: the owed spend rows can't be read: ${message(e)}`);
      return;
    }
    for (const owed of pending) {
      if (budget <= 0) break;
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
        const read = await this.usageOf(run, budget);
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
  private async usageOf(run: AgentRun, budget: number): Promise<{ usage: LogUsage | null; used: number }> {
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
      };
      this.scans.set(run.id, scan);
    }
    const step = await stepScan(scan, run.logPath, budget);
    if (!step.done) return { usage: null, used: step.used };
    this.scans.delete(run.id);
    if (scan.kind === "requests") {
      return { usage: scan.refused ? { source: "none", refused: scan.refused } : { source: "requests", requests: scan.requests }, used: step.used };
    }
    return { usage: resultsUsage(scan), used: step.used };
  }

  private async write(run: AgentRun, usage: LogUsage): Promise<void> {
    const now = this.o.now();
    const origin = originOf(run);
    const end = endKindOf(run);
    const outcome = end === "completed" ? await this.o.outcome(run) : null;
    const { class: cls, reason } = classifyEnd(run, origin, outcome);
    const endedAt = run.endedAt ?? now;
    const spawnedAt = run.spawnedAt ?? null;
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
    const row: SpendRow = {
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
      class: cls,
      reason,
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
      pr: null,
      headSha: null,
      blockerKey: null,
      backfilled: false,
      usageRecorded: true,
    };
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
