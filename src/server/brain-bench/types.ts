/**
 * The brain bench: replays recorded decisions against a "model" and scores it.
 * A model is anything that answers a case: a language model behind an
 * OpenAI-compatible or Ollama endpoint, or a deterministic rule set.
 */

export interface BenchOption {
  id: string;
  label: string;
}

/** One recorded decision with the answer a person gave. */
export interface BenchCase {
  id: string;
  /** The decision kind, e.g. "escalation" */
  kind: string;
  /** The module that raised it */
  module: string;
  /** Structured fields only (codes, counts, flags): never prose */
  evidence: Record<string, unknown>;
  options: BenchOption[];
  /** The id of the option that was answered */
  label: string;
  /** Why it was answered so (not shown to the model) */
  reason?: string;
}

export interface ModelAnswer {
  /** One of the case's option ids */
  option: string;
  reasonCode: string;
  /** 0..1 */
  confidence: number;
}

export interface BenchModel {
  name: string;
  /** Throws BenchModelError when it has no valid answer (no rule matched, bad output, endpoint down) */
  decide(c: BenchCase): Promise<ModelAnswer>;
}

/** The model gave no usable answer. The bench counts it as an abstain, with the message kept short. */
export class BenchModelError extends Error {}

export type Outcome = "correct" | "wrong" | "abstain";

export interface CaseResult {
  caseId: string;
  kind: string;
  outcome: Outcome;
  /** true: wrong with confidence at or above the threshold */
  wrongConfident: boolean;
  /** true: the model gave no valid answer (a subset of abstain) */
  error: boolean;
  latencyMs: number;
}

export interface Stats {
  n: number;
  correct: number;
  wrong: number;
  abstain: number;
  errors: number;
  wrongConfident: number;
  /** correct / n: an abstain is not a hit */
  accuracy: number;
  /** correct / (correct + wrong); null when nothing was answered */
  answeredAccuracy: number | null;
  abstainRate: number;
  wrongConfidentRate: number;
  latencyMeanMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
}

export interface ModelReport {
  model: string;
  overall: Stats;
  byKind: Record<string, Stats>;
}

export interface BenchReport {
  cases: number;
  /** An answer below this confidence counts as an abstain; a wrong one at or above it is "confident" */
  threshold: number;
  models: ModelReport[];
}
