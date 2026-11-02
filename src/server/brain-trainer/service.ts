/**
 * The brain trainer as the server runs it: a nightly run (and an owner's
 * "run now"), the shadow subscription, and the status the owner sees. It is
 * handed a read-only view of the Decision Inbox, so no path from here can
 * answer a decision.
 */
import { join } from "path";
import { parseCases, MAX_CASE_FILE_BYTES } from "../brain-bench/cases.js";
import type { EventBus } from "../core/event-bus.js";
import { readCheckedFile, type ServerConfigFileOptions } from "../restart/server-config.js";
import { loadBrainTrainerConfig, type BrainTrainerSettings } from "./config.js";
import type { TrainerContainer } from "./container.js";
import { exampleFromDecision, examplesFromCases, isNotice, queryOf, splitLabels } from "./examples.js";
import { featuresOf } from "./features.js";
import { avoidSet } from "./model.js";
import { readOnlyDecisions, ShadowRecorder, type AgreementRow, type DecisionReader } from "./shadow.js";
import { ModelStore, type BestPointer } from "./store.js";
import { DEFAULT_PARAMS, runTraining } from "./trainer.js";
import type { Example, RunReport } from "./types.js";

/** setTimeout as the service uses it (unref'd); tests drive a fake one. */
export interface Timers {
  set(fn: () => void, ms: number): () => void;
}

export const realTimers: Timers = {
  set(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

const CHECK_EVERY_MS = 15 * 60 * 1000;
const MAX_DECISIONS = 200_000;

export interface BrainTrainerOptions {
  configPath: string;
  /** data/brain */
  dataDir: string;
  decisions: DecisionReader;
  events: EventBus;
  container: TrainerContainer;
  clock?: () => Date;
  timers?: Timers;
  fileOptions?: ServerConfigFileOptions;
  log?: (line: string) => void;
}

export interface BrainTrainerStatus {
  enabled: boolean;
  errors: string[];
  running: boolean;
  image: string;
  confidenceFloor: number;
  minLabels: number;
  best: (BestPointer & { report: RunReport | null }) | null;
  /** Oldest first: accuracy, abstain rate and wrong-but-confident per class over time are drawn from these */
  runs: RunReport[];
  /** Lines in runs.jsonl and shadow-trace.jsonl that could not be read and were skipped */
  skipped: { runs: number; trace: number };
  /** Shadow proposals compared with the answers, per class and model version */
  agreement: AgreementRow[];
}

export class BrainTrainer {
  readonly store: ModelStore;
  private readonly shadow: ShadowRecorder;
  private readonly clock: () => Date;
  private readonly timers: Timers;
  private readonly log: (line: string) => void;
  private running = false;
  private cancelTimer: (() => void) | null = null;
  private vetoCache: ReadonlySet<string> | null = null;

  /** What the trainer reads decisions through: exactly get and list, whatever it was handed */
  private readonly decisions: DecisionReader;

  constructor(private readonly options: BrainTrainerOptions) {
    this.decisions = readOnlyDecisions(options.decisions);
    this.store = new ModelStore(options.dataDir);
    this.clock = options.clock ?? (() => new Date());
    this.timers = options.timers ?? realTimers;
    this.log = options.log ?? (() => undefined);
    this.shadow = new ShadowRecorder(
      this.store,
      this.decisions,
      () => this.settings().settings.confidenceFloor,
      () => this.vetoes(),
      this.clock,
      this.log,
    );
  }

  settings() {
    return loadBrainTrainerConfig(this.options.configPath, this.options.fileOptions);
  }

  private loadExamples(settings: BrainTrainerSettings): { examples: Example[]; unusable: number; notices: number } {
    const examples: Example[] = [];
    let unusable = 0;
    let notices = 0;
    for (const d of this.decisions.list({ status: "answered", limit: MAX_DECISIONS })) {
      if (isNotice(d)) {
        notices++;
        continue;
      }
      const e = exampleFromDecision(d);
      if (e) examples.push(e);
      else unusable++;
    }
    if (settings.casesFile) {
      const read = readCheckedFile(settings.casesFile, this.options.fileOptions, MAX_CASE_FILE_BYTES);
      if (!read.ok) throw new Error(`cases_file ${read.error}`);
      if (read.text !== null) {
        const fromCases = examplesFromCases(parseCases(read.text));
        examples.push(...fromCases.examples);
        unusable += fromCases.unusable;
      }
    }
    return { examples, unusable, notices };
  }

  private vetoes(): ReadonlySet<string> {
    if (this.vetoCache) return this.vetoCache;
    const settings = this.settings().settings;
    let negatives: Example[] = [];
    try {
      negatives = splitLabels(this.loadExamples(settings).examples).negative;
    } catch {
      // No veto list is no reason to stop proposing: the bench already counts the wrong ones
    }
    this.vetoCache = avoidSet(negatives, (e) => featuresOf(queryOf(e)));
    return this.vetoCache;
  }

  /** One run now. Refused while disabled or already running; a failed run is a report, not a throw. */
  async runNow(): Promise<RunReport | { refused: string }> {
    const config = this.settings();
    if (!config.settings.enabled) return { refused: config.ok ? "the brain trainer is off" : config.errors.join("; ") };
    if (this.running) return { refused: "a run is already going" };
    this.running = true;
    const s = config.settings;
    try {
      return await runTraining({
        settings: {
          minLabels: s.minLabels,
          testFraction: s.testFraction,
          minTest: s.minTest,
          confidenceFloor: s.confidenceFloor,
          image: s.image,
          timeoutMs: s.timeoutMinutes * 60_000,
          params: DEFAULT_PARAMS,
        },
        loadExamples: () => this.loadExamples(s),
        store: this.store,
        container: this.options.container,
        workRoot: join(this.options.dataDir, "work"),
        now: this.clock,
      });
    } catch (e) {
      // The detail (a path, a file name) stays in Lair's log; the report and the route carry a fixed sentence
      this.log(`brain trainer: run failed: ${e instanceof Error ? e.message : String(e)}`);
      const report: RunReport = {
        at: this.clock().toISOString(),
        version: null,
        status: "failed",
        reasonCode: "run_error",
        reason: "the run failed before it finished: see Lair's log",
        labels: { total: 0, used: 0, negative: 0, pending: 0, unusable: 0 },
        confidenceFloor: s.confidenceFloor,
      };
      this.store.appendRun(report);
      return report;
    } finally {
      this.running = false;
      this.vetoCache = null;
    }
  }

  /** The nightly check: at the configured local hour, once a day. */
  async tick(): Promise<void> {
    const s = this.settings().settings;
    if (!s.enabled || this.running) return;
    const now = this.clock();
    if (now.getHours() !== s.runHour) return;
    const last = this.store.runs(1)[0];
    if (last && new Date(last.at).toDateString() === now.toDateString()) return;
    await this.runNow();
  }

  start(): void {
    const loop = (): void => {
      this.cancelTimer = this.timers.set(() => {
        void this.tick()
          .catch((e) => this.log(`brain trainer: ${e instanceof Error ? e.message : String(e)}`))
          .finally(loop);
      }, CHECK_EVERY_MS);
    };
    loop();
  }

  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  /** decision.raised: the best model writes its proposal into the trace (when shadow is on). */
  onRaised(data: Record<string, unknown>): void {
    const s = this.settings().settings;
    if (s.enabled && s.shadow) this.shadow.onRaised(data);
  }

  subscribe(events: EventBus = this.options.events): () => void {
    return events.on("decision.raised", (event) => this.onRaised(event.data));
  }

  status(): BrainTrainerStatus {
    const config = this.settings();
    const best = this.store.best();
    const runs = this.store.readRuns(200);
    return {
      enabled: config.settings.enabled,
      errors: config.ok ? [] : config.errors,
      running: this.running,
      image: config.settings.image,
      confidenceFloor: config.settings.confidenceFloor,
      minLabels: config.settings.minLabels,
      best: best ? { ...best, report: this.store.loadReport(best.version) } : null,
      runs: runs.runs,
      skipped: { runs: runs.skipped, trace: this.shadow.readProposals().skipped },
      agreement: this.shadow.agreement(),
    };
  }
}
