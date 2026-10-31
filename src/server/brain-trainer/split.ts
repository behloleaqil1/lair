/** The time split: train on older decisions, test on the newest window. */
import type { Example } from "./types.js";

export interface SplitOptions {
  /** Share of the newest examples held out, 0 to 1 exclusive */
  testFraction: number;
  /** The smallest test window worth scoring */
  minTest: number;
}

export type SplitResult =
  | { ok: true; train: Example[]; test: Example[]; cutoffAt: string }
  | { ok: false; reason: string };

/**
 * Sort by time (then id, so a tie is stable) and cut at a time: every example
 * strictly before the cutoff trains, every example at or after it tests. A
 * cutoff is a time, not an index, so examples of the same instant never fall
 * on both sides and no newer decision can reach the training set.
 */
export function timeSplit(examples: Example[], options: SplitOptions): SplitResult {
  const sorted = [...examples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (sorted.length === 0) return { ok: false, reason: "no labelled decisions" };
  const index = Math.floor(sorted.length * (1 - options.testFraction));
  const cutoff = Date.parse(sorted[Math.min(index, sorted.length - 1)].at);
  const train = sorted.filter((e) => Date.parse(e.at) < cutoff);
  const test = sorted.filter((e) => Date.parse(e.at) >= cutoff);
  if (train.length === 0) return { ok: false, reason: "every labelled decision shares the newest time: nothing older to train on" };
  if (test.length < options.minTest) return { ok: false, reason: `the newest window holds ${test.length} decisions, under the minimum of ${options.minTest}` };
  return { ok: true, train, test, cutoffAt: new Date(cutoff).toISOString() };
}
