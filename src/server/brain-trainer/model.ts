/**
 * The trained classifier, evaluated in Lair (no Python at decision time). The
 * file comes from a container, so it is validated as untrusted input. A
 * model proposes an option among the offered ids or abstains; it has no way to
 * act, and the bench scores it through the same BenchModel interface as any other.
 */
import { BenchModelError, type BenchCase, type BenchModel, type ModelAnswer } from "../brain-bench/types.js";
import { featuresOf } from "./features.js";
import type { Example, Features, TreeArrays, TreeModel } from "./types.js";

export const MAX_MODEL_BYTES = 8 * 1024 * 1024;
const MAX_CLASSES = 64;
const MAX_FEATURES = 20_000;
const MAX_STAGES = 2000;
const MAX_NODES = 400_000;
const NAME = /^[\x21-\x7e]{1,200}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numbers(v: unknown, what: string, max: number): number[] {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error(`${what} must be a list of at most ${max} finite numbers`);
  }
  return v as number[];
}

function tree(v: unknown, featureCount: number, budget: { nodes: number }): TreeArrays {
  if (!isRecord(v)) throw new Error("a tree must be an object");
  const left = numbers(v.left, "left", MAX_NODES);
  const right = numbers(v.right, "right", MAX_NODES);
  const feature = numbers(v.feature, "feature", MAX_NODES);
  const threshold = numbers(v.threshold, "threshold", MAX_NODES);
  const value = numbers(v.value, "value", MAX_NODES);
  const n = left.length;
  if (n === 0 || [right, feature, threshold, value].some((a) => a.length !== n)) throw new Error("a tree's arrays must have the same, non-zero length");
  budget.nodes += n;
  if (budget.nodes > MAX_NODES) throw new Error("the model has too many nodes");
  for (let i = 0; i < n; i++) {
    if (left[i] === -1 && right[i] === -1) continue;
    // A child always has a higher index than its parent: the walk ends
    const ok = (c: number) => Number.isInteger(c) && c > i && c < n;
    if (!ok(left[i]) || !ok(right[i])) throw new Error("a tree has a bad child index");
    if (!Number.isInteger(feature[i]) || feature[i] < 0 || feature[i] >= featureCount) throw new Error("a tree names a feature that does not exist");
  }
  return { left, right, feature, threshold, value };
}

/** Parse and check the model file's JSON. Throws with a short reason. */
export function parseModel(text: string): TreeModel {
  if (Buffer.byteLength(text) > MAX_MODEL_BYTES) throw new Error(`the model file is over ${MAX_MODEL_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("the model file is not valid JSON");
  }
  if (!isRecord(raw) || raw.format !== "lair-gbt-1") throw new Error("the model file is not a lair-gbt-1 model");
  const classes = raw.classes;
  if (!Array.isArray(classes) || classes.length < 1 || classes.length > MAX_CLASSES || !classes.every((c) => typeof c === "string" && NAME.test(c))) {
    throw new Error("classes must be 1-64 option ids");
  }
  if (new Set(classes).size !== classes.length) throw new Error("classes must be unique");
  const featureNames = raw.featureNames;
  if (!Array.isArray(featureNames) || featureNames.length > MAX_FEATURES || !featureNames.every((f) => typeof f === "string" && NAME.test(f))) {
    throw new Error("featureNames must be a list of names");
  }
  const perStage = classes.length === 2 ? 1 : classes.length === 1 ? 0 : classes.length;
  const init = numbers(raw.init, "init", MAX_CLASSES);
  if (init.length !== Math.max(perStage, 1)) throw new Error("init must hold one value per class (one when there are two)");
  const learningRate = raw.learningRate;
  if (typeof learningRate !== "number" || !Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 10) throw new Error("learningRate must be a number above 0");
  if (!Array.isArray(raw.stages) || raw.stages.length > MAX_STAGES) throw new Error("stages must be a list");
  const budget = { nodes: 0 };
  const stages = raw.stages.map((stage) => {
    if (!Array.isArray(stage) || stage.length !== perStage) throw new Error("each stage needs one tree per class (one when there are two)");
    return stage.map((t) => tree(t, featureNames.length, budget));
  });
  const trainedOn = raw.trainedOn;
  if (typeof trainedOn !== "number" || !Number.isInteger(trainedOn) || trainedOn < 0) throw new Error("trainedOn must be a count");
  return { format: "lair-gbt-1", classes: classes as string[], featureNames: featureNames as string[], init, learningRate, stages, trainedOn };
}

function walk(t: TreeArrays, x: number[]): number {
  let node = 0;
  // Children have higher indices, so this ends within the node count
  while (t.left[node] !== -1) node = x[t.feature[node]] <= t.threshold[node] ? t.left[node] : t.right[node];
  return t.value[node];
}

/** The probability of each class (summing to 1) for a feature vector. */
export function probabilities(model: TreeModel, features: Features): Record<string, number> {
  const x = model.featureNames.map((n) => features[n] ?? 0);
  const out: Record<string, number> = {};
  if (model.classes.length === 1) return { [model.classes[0]]: 1 };
  if (model.classes.length === 2) {
    let raw = model.init[0];
    for (const stage of model.stages) raw += model.learningRate * walk(stage[0], x);
    const p1 = 1 / (1 + Math.exp(-raw));
    return { [model.classes[0]]: 1 - p1, [model.classes[1]]: p1 };
  }
  const raw = model.init.map((v, k) => model.stages.reduce((sum, stage) => sum + model.learningRate * walk(stage[k], x), v));
  const max = Math.max(...raw);
  const exps = raw.map((r) => Math.exp(r - max));
  const total = exps.reduce((a, b) => a + b, 0);
  model.classes.forEach((c, k) => {
    out[c] = exps[k] / total;
  });
  return out;
}

/** A proposal: an offered option, how sure, and the reason code. Or a refusal to propose. */
export function propose(model: TreeModel, c: Omit<BenchCase, "label">, avoid?: ReadonlySet<string>): ModelAnswer {
  const offered = c.options.map((o) => o.id).filter((id) => model.classes.includes(id));
  if (offered.length === 0) throw new BenchModelError("none of the offered options was seen in training");
  const features = featuresOf(c);
  const probs = probabilities(model, features);
  const total = offered.reduce((s, id) => s + probs[id], 0);
  let best = offered[0];
  for (const id of offered) if (probs[id] > probs[best]) best = id;
  if (avoid?.has(avoidKey(c.kind, best, features))) throw new BenchModelError("this answer was marked bad for the same evidence");
  const confidence = total > 0 ? probs[best] / total : 0;
  return { option: best, reasonCode: "classifier_gbt", confidence: Math.round(confidence * 10000) / 10000 };
}

function avoidKey(classKey: string, option: string, features: Features): string {
  const sorted = Object.keys(features).sort().map((k) => [k, features[k]]);
  return `${classKey}|${option}|${JSON.stringify(sorted)}`;
}

/** The set of answers that turned out bad, to refuse when the same evidence comes again. */
export function avoidSet(negatives: Example[], featuresFor: (e: Example) => Features): Set<string> {
  return new Set(negatives.map((e) => avoidKey(e.classKey, e.label, featuresFor(e))));
}

/** The trained model as a bench model, so it is scored by the same code as every other. */
export function classifierBenchModel(name: string, model: TreeModel, avoid?: ReadonlySet<string>): BenchModel {
  return { name, decide: async (c) => propose(model, c, avoid) };
}

/** Lair's own recommendation as a model: the bar a classifier has to clear. */
export function recommendedBenchModel(): BenchModel {
  return {
    name: "recommended-option",
    decide: async (c) => {
      if (!c.recommended || !c.options.some((o) => o.id === c.recommended)) throw new BenchModelError("no recommended option");
      return { option: c.recommended, reasonCode: "recommended", confidence: 1 };
    },
  };
}
