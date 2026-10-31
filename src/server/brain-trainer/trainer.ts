/**
 * One training run: rebuild the labelled set, split it by time, fit the
 * classifier in a container, score it on the brain bench against the newest
 * window, and keep it as a new version. A run with too few labels only
 * reports. Nothing here answers a decision or promotes a model.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { runBench } from "../brain-bench/run.js";
import type { ModelReport } from "../brain-bench/types.js";
import type { TrainerContainer } from "./container.js";
import { knownBefore, splitLabels, toBenchCase } from "./examples.js";
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
  loadExamples(): { examples: Example[]; unusable: number; notices?: number };
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

/** The container's output is untrusted: a regular file (never a link to something on the host) under the size limit. */
function readFileBounded(path: string, max: number): string {
  const info = lstatSync(path);
  if (!info.isFile()) throw new Error("the container wrote something that is not a plain file");
  if (info.size > max) throw new Error("the container wrote a file over the size limit");
  return readFileSync(path, "utf8");
}

export async function runTraining(deps: TrainerDeps): Promise<RunReport> {
  const { settings, store } = deps;
  const at = deps.now().toISOString();
  const { examples: loaded, unusable, notices = 0 } = deps.loadExamples();
  let examples = loaded;
  let sets = splitLabels(examples);
  // An outcome recorded at or after the cutoff was not known when the test window began: for this run the answer was
  // still unjudged. The cutoff depends on the labels, so settle it by looking again (a few passes at most).
  for (let pass = 0; pass < 3; pass++) {
    const probe = timeSplit(sets.positive, { testFraction: settings.testFraction, minTest: settings.minTest });
    if (!probe.ok) break;
    const masked = knownBefore(loaded, Date.parse(probe.cutoffAt));
    if (masked.every((e, i) => e.outcome === examples[i].outcome)) break;
    examples = masked;
    sets = splitLabels(examples);
  }
  const labels = {
    total: examples.length + unusable + notices,
    used: sets.positive.length,
    negative: sets.negative.length,
    pending: sets.pending.length,
    unusable,
    notices,
    lateAnswers: 0,
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
      reasonCode: "too_few_labels",
      reason: `${sets.positive.length} usable labels, the floor is ${settings.minLabels}`,
    });
  }
  const split = timeSplit(sets.positive, { testFraction: settings.testFraction, minTest: settings.minTest });
  if (!split.ok) return finish({ ...base, status: "split_too_small", reasonCode: "split_too_small", reason: split.reason });

  // A decision created before the cutoff but answered at or after it: its label was not known when the test window began
  const cutoff = Date.parse(split.cutoffAt);
  const trainable = split.train.filter((e) => e.answeredAt === undefined || Date.parse(e.answeredAt) < cutoff);
  labels.lateAnswers = split.train.length - trainable.length;
  if (trainable.length === 0) return finish({ ...base, status: "split_too_small", reasonCode: "no_rows_before_cutoff", reason: "no training row was answered before the cutoff" });

  const rows: TrainingRow[] = trainable.map((e) => ({ features: featuresOf(toBenchCase(e)), label: e.label }));
  mkdirSync(deps.workRoot, { recursive: true, mode: 0o700 });
  const workdir = mkdtempSync(join(deps.workRoot, "run-"));
  const inputDir = join(workdir, "in");
  const outputDir = join(workdir, "out");
  try {
    mkdirSync(inputDir, { mode: 0o700 });
    mkdirSync(outputDir, { mode: 0o700 });
    writeFileSync(join(inputDir, "input.json"), JSON.stringify({ rows, params: settings.params }), { mode: 0o600 });
    const result = await deps.container.run({ image: settings.image, inputDir, outputDir, timeoutMs: settings.timeoutMs });
    // Reasons are fixed sentences: no path, no container output (the detail would carry host paths)
    if (result.cleanupFailed) return finish({ ...base, status: "failed", reasonCode: "container_not_stopped", reason: "the trainer container could not be stopped: check docker" });
    if (result.timedOut) return finish({ ...base, status: "failed", reasonCode: "timed_out", reason: "the trainer container timed out" });
    if (result.exitCode !== 0) {
      return finish({ ...base, status: "failed", reasonCode: "container_exit", reason: `the trainer container exited with ${result.exitCode}` });
    }
    let model;
    try {
      model = parseModel(readFileBounded(join(outputDir, "model.json"), MAX_MODEL_BYTES));
    } catch {
      return finish({ ...base, status: "failed", reasonCode: "model_refused", reason: "the trainer's model was refused" });
    }

    // Answers raised and judged bad before the cutoff veto a repeat; a decision judged bad later is future knowledge
    const older = sets.negative.filter(
      (e) => Date.parse(e.at) < Date.parse(split.cutoffAt) && (e.outcomeAt === undefined || Date.parse(e.outcomeAt) < Date.parse(split.cutoffAt)),
    );
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
      trainCount: trainable.length,
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
