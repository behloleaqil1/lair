/**
 * One training run: rebuild the labelled set, split it by time, fit the
 * classifier in a container, score it on the brain bench against the newest
 * window, and keep it as a new version. A run with too few labels only
 * reports. Nothing here answers a decision or promotes a model.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { runBench } from "../brain-bench/run.js";
import type { ModelReport } from "../brain-bench/types.js";
import type { TrainerContainer } from "./container.js";
import { splitLabels, toBenchCase } from "./examples.js";
import { featuresOf } from "./features.js";
import { avoidSet, classifierBenchModel, MAX_MODEL_BYTES, parseModel, recommendedBenchModel } from "./model.js";
import { timeSplit } from "./split.js";
import type { ModelStore } from "./store.js";
import type { Example, RunReport, TrainParams, TrainingRow } from "./types.js";

export interface TrainerSettings {
  /** Fewer usable labels than this: report and do nothing else */
  minLabels: number;
  testFraction: number;
  minTest: number;
  /** A proposal below this confidence is an abstain */
  confidenceFloor: number;
  image: string;
  timeoutMs: number;
  params: TrainParams;
}

export const DEFAULT_PARAMS: TrainParams = { nEstimators: 100, maxDepth: 3, learningRate: 0.1, seed: 0 };

export interface TrainerDeps {
  settings: TrainerSettings;
  /** The labelled examples, answered and (where known) with their outcome */
  loadExamples(): { examples: Example[]; unusable: number };
  store: ModelStore;
  container: TrainerContainer;
  /** A directory where a run keeps its input and output; removed after */
  workRoot: string;
  now(): Date;
}

function better(a: ModelReport, b: ModelReport): boolean {
  const x = a.overall;
  const y = b.overall;
  return x.accuracy > y.accuracy || (x.accuracy === y.accuracy && x.wrongConfidentRate < y.wrongConfidentRate);
}

function readFileBounded(path: string, max: number): string {
  if (statSync(path).size > max) throw new Error("the container wrote a file over the size limit");
  return readFileSync(path, "utf8");
}

export async function runTraining(deps: TrainerDeps): Promise<RunReport> {
  const { settings, store } = deps;
  const at = deps.now().toISOString();
  const { examples, unusable } = deps.loadExamples();
  const sets = splitLabels(examples);
  const labels = {
    total: examples.length + unusable,
    used: sets.positive.length,
    negative: sets.negative.length,
    pending: sets.pending.length,
    unusable,
  };
  const base = { at, labels, confidenceFloor: settings.confidenceFloor, version: null };
  const finish = (report: RunReport): RunReport => {
    store.appendRun(report);
    return report;
  };

  if (sets.positive.length < settings.minLabels) {
    return finish({
      ...base,
      status: "too_few_labels",
      reason: `${sets.positive.length} usable labels, the floor is ${settings.minLabels}`,
    });
  }
  const split = timeSplit(sets.positive, { testFraction: settings.testFraction, minTest: settings.minTest });
  if (!split.ok) return finish({ ...base, status: "split_too_small", reason: split.reason });

  const rows: TrainingRow[] = split.train.map((e) => ({ features: featuresOf(toBenchCase(e)), label: e.label }));
  mkdirSync(deps.workRoot, { recursive: true, mode: 0o700 });
  const workdir = mkdtempSync(join(deps.workRoot, "run-"));
  try {
    writeFileSync(join(workdir, "input.json"), JSON.stringify({ rows, params: settings.params }), { mode: 0o600 });
    const result = await deps.container.run({ image: settings.image, workdir, timeoutMs: settings.timeoutMs });
    if (result.timedOut) return finish({ ...base, status: "failed", reason: "the trainer container timed out" });
    if (result.exitCode !== 0) {
      return finish({ ...base, status: "failed", reason: `the trainer container exited with ${result.exitCode}: ${result.stderr.trim().slice(-300)}` });
    }
    let model;
    try {
      model = parseModel(readFileBounded(join(workdir, "model.json"), MAX_MODEL_BYTES));
    } catch (e) {
      return finish({ ...base, status: "failed", reason: `the trainer's model was refused: ${e instanceof Error ? e.message : String(e)}` });
    }

    // Answers marked bad before the cutoff veto a repeat; later ones are not looked at
    const older = sets.negative.filter((e) => Date.parse(e.at) < Date.parse(split.cutoffAt));
    const avoid = avoidSet(older, (e) => featuresOf(toBenchCase(e)));
    const version = store.newVersion(deps.now());
    const bench = await runBench(
      split.test.map(toBenchCase),
      [classifierBenchModel(version, model, avoid), recommendedBenchModel()],
      { threshold: settings.confidenceFloor },
    );
    const report: RunReport = {
      ...base,
      version,
      status: "trained",
      cutoffAt: split.cutoffAt,
      trainCount: split.train.length,
      testCount: split.test.length,
      classifier: bench.models[0],
      baseline: bench.models[1],
    };
    store.saveModel(version, model, report);
    const currentBest = store.best();
    const currentReport = currentBest ? store.loadReport(currentBest.version)?.classifier : undefined;
    if (!currentReport || (report.classifier && better(report.classifier, currentReport))) store.setBest(version, at);
    return finish(report);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
