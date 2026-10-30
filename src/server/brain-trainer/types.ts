/**
 * The brain trainer: shadow training of a small classifier on the answered
 * decisions (docs/design/decision-policies.md §5, §6 stage C). A trained model
 * only ever proposes into a trace; nothing here answers a decision.
 */
import type { BenchOption } from "../brain-bench/types.js";

export type Outcome = "good" | "bad" | "pending" | "unknown";

/** One answered decision, reduced to structured fields. No title, context or note. */
export interface Example {
  id: string;
  /** ISO-8601: when the decision was raised (the time the model would have had to propose) */
  at: string;
  /** The class the decision belongs to: the split, the bench and the report group by it */
  classKey: string;
  kind: string;
  module: string;
  evidence: Record<string, unknown>;
  options: BenchOption[];
  /** The option Lair recommended, if known */
  recommended?: string;
  /** The answered option id */
  label: string;
  outcome: Outcome;
}

/** A numeric feature vector as sparse name -> value. Absent means 0. */
export type Features = Record<string, number>;

export interface TrainingRow {
  features: Features;
  label: string;
}

export interface TreeArrays {
  /** Child index per node, -1 at a leaf */
  left: number[];
  right: number[];
  /** Feature index per node (unused at a leaf) */
  feature: number[];
  threshold: number[];
  /** The leaf's value (unused elsewhere) */
  value: number[];
}

/** The exported model: gradient-boosted regression trees, one tree per class and stage (one per stage when there are two classes). */
export interface TreeModel {
  format: "lair-gbt-1";
  classes: string[];
  featureNames: string[];
  /** Raw score per class before any tree (one value when binary: the log odds of classes[1]) */
  init: number[];
  learningRate: number;
  /** stages[s][k] is the tree for class k at stage s (k = 0 only, when binary) */
  stages: TreeArrays[][];
  trainedOn: number;
}

/** The numbers the trainer container reports about its own fit. It is not the bench. */
export interface FitInfo {
  rows: number;
  classes: number;
  features: number;
  sklearn: string;
  seed: number;
}

export interface TrainParams {
  nEstimators: number;
  maxDepth: number;
  learningRate: number;
  seed: number;
}

export type RunStatus = "trained" | "too_few_labels" | "split_too_small" | "failed";

/** How a run went and what it measured; written beside the model. */
export interface RunReport {
  version: string | null;
  status: RunStatus;
  reason?: string;
  at: string;
  labels: { total: number; used: number; negative: number; pending: number; unusable: number };
  /** The oldest decision in the test window: nothing at or after it was trained on */
  cutoffAt?: string;
  trainCount?: number;
  testCount?: number;
  /** The classifier on the test window, per class (the bench's byKind) */
  classifier?: import("../brain-bench/types.js").ModelReport;
  /** The same window answered with Lair's own recommended option, for the bar to beat */
  baseline?: import("../brain-bench/types.js").ModelReport;
  confidenceFloor: number;
}
