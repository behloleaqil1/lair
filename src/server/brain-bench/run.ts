/** Running a bench: every model over every case, scored per model and per decision kind. */
import type { BenchCase, BenchModel, BenchReport, CaseResult, ModelReport, Stats } from "./types.js";
import { BenchModelError } from "./types.js";

export const DEFAULT_THRESHOLD = 0.5;

export interface RunOptions {
  /** Below this confidence an answer counts as an abstain; a wrong answer at or above it is "wrong but confident" */
  threshold?: number;
  /** Milliseconds, monotonic. Injected so tests control latency. */
  now?: () => number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function statsOf(results: CaseResult[]): Stats {
  const n = results.length;
  const count = (f: (r: CaseResult) => boolean) => results.filter(f).length;
  const correct = count((r) => r.outcome === "correct");
  const wrong = count((r) => r.outcome === "wrong");
  const abstain = count((r) => r.outcome === "abstain");
  const wrongConfident = count((r) => r.wrongConfident);
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const round = (x: number) => Math.round(x * 10000) / 10000;
  return {
    n,
    correct,
    wrong,
    abstain,
    errors: count((r) => r.error),
    wrongConfident,
    accuracy: n ? round(correct / n) : 0,
    answeredAccuracy: correct + wrong ? round(correct / (correct + wrong)) : null,
    abstainRate: n ? round(abstain / n) : 0,
    wrongConfidentRate: n ? round(wrongConfident / n) : 0,
    latencyMeanMs: n ? Math.round(lat.reduce((a, b) => a + b, 0) / n) : 0,
    latencyP50Ms: Math.round(percentile(lat, 0.5)),
    latencyP95Ms: Math.round(percentile(lat, 0.95)),
  };
}

async function runCase(model: BenchModel, c: BenchCase, threshold: number, now: () => number): Promise<CaseResult> {
  const started = now();
  try {
    const answer = await model.decide(c);
    const latencyMs = now() - started;
    if (answer.confidence < threshold) {
      return { caseId: c.id, kind: c.kind, outcome: "abstain", wrongConfident: false, error: false, latencyMs };
    }
    const correct = answer.option === c.label;
    return { caseId: c.id, kind: c.kind, outcome: correct ? "correct" : "wrong", wrongConfident: !correct, error: false, latencyMs };
  } catch (e) {
    // A model that throws something other than its own error is a bug in the model, not a score: let it surface
    if (!(e instanceof BenchModelError)) throw e;
    return { caseId: c.id, kind: c.kind, outcome: "abstain", wrongConfident: false, error: true, latencyMs: now() - started };
  }
}

/** Score each model over the cases, one case at a time per model (a local model serves one request at a time). */
export async function runBench(cases: BenchCase[], models: BenchModel[], opts: RunOptions = {}): Promise<BenchReport> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const now = opts.now ?? (() => performance.now());
  const reports: ModelReport[] = [];
  for (const model of models) {
    const results: CaseResult[] = [];
    for (const c of cases) results.push(await runCase(model, c, threshold, now));
    const byKind: Record<string, Stats> = {};
    for (const kind of [...new Set(cases.map((c) => c.kind))].sort()) {
      byKind[kind] = statsOf(results.filter((r) => r.kind === kind));
    }
    reports.push({ model: model.name, overall: statsOf(results), byKind });
  }
  return { cases: cases.length, threshold, models: reports };
}

const pct = (x: number | null) => (x === null ? "  -  " : `${(x * 100).toFixed(1)}%`.padStart(5));

/** The report as a plain-text table. */
export function formatReport(report: BenchReport): string {
  const lines = [`Brain bench: ${report.cases} cases, abstain below confidence ${report.threshold}`];
  const row = (label: string, s: Stats) =>
    `  ${label.padEnd(34)} n=${String(s.n).padEnd(5)} acc ${pct(s.accuracy)}  answered-acc ${pct(s.answeredAccuracy)}  abstain ${pct(s.abstainRate)}  ` +
    `wrong-confident ${pct(s.wrongConfidentRate)}  errors ${s.errors}  latency p50 ${s.latencyP50Ms}ms p95 ${s.latencyP95Ms}ms`;
  for (const m of report.models) {
    lines.push("", m.model, row("all kinds", m.overall));
    for (const [kind, s] of Object.entries(m.byKind)) lines.push(row(kind, s));
  }
  return lines.join("\n");
}
