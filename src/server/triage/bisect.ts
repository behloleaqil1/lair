/**
 * Bisect over the merges between the last green commit and the red one.
 *
 * The candidates are the first-parent commits after the last green commit,
 * oldest first; the last one is the red commit. `good` is the newest
 * candidate known to pass (-1: the last green commit itself) and `bad` the
 * oldest known to fail with the target cause. Each probe runs only the
 * narrowest failing set at one candidate. A probe that can't decide
 * (infrastructure after its retries, or a different failure) skips that
 * candidate, as `git bisect skip` does.
 *
 * A culprit is PROVEN when it is the only candidate left, its parent is
 * green, and it failed with the same cause twice (the bisect's own probe or
 * the red gate, plus a confirmation run). Anything less is a suspect, and
 * suspects are never reverted automatically.
 */
import type { BisectProbe, BisectState } from "../../shared/triage-types.js";

export type ProbeOutcome = "pass" | "fail" | "skip";

export type BisectStep =
  | { type: "probe"; sha: string; confirm: boolean }
  | { type: "found"; culprit: string; proven: true; detail: string }
  | { type: "inconclusive"; suspects: string[]; detail: string };

/** Probes allowed for n candidates: two per halving, plus confirmations and skips. */
export function maxProbes(candidates: number): number {
  return 2 * Math.ceil(Math.log2(candidates + 1)) + 4;
}

export function startBisect(candidates: string[], redSha: string): BisectState {
  if (candidates.length === 0) {
    return {
      status: "inconclusive",
      candidates,
      good: -1,
      bad: -1,
      skipped: [],
      probes: [],
      proven: false,
      detail: "no commits between the last green commit and the red one",
    };
  }
  return {
    status: "running",
    candidates,
    good: -1,
    bad: candidates.length - 1,
    skipped: [],
    probes: [{ sha: redSha, outcome: "fail", detail: "the red gate result" }],
    proven: false,
    detail: `bisecting ${candidates.length} commit(s) after the last green one`,
  };
}

/** The unskipped candidate between good and bad nearest the middle, or null when none is left. */
function middle(state: BisectState): number | null {
  const open: number[] = [];
  for (let i = state.good + 1; i < state.bad; i++) {
    if (!state.skipped.includes(i)) open.push(i);
  }
  if (open.length === 0) return null;
  const mid = (state.good + state.bad) / 2;
  open.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
  return open[0];
}

/** What to do next: probe a commit, or the result. */
export function nextStep(state: BisectState): BisectStep {
  const measured = state.probes.filter((p) => p.recheckId !== undefined).length;
  if (measured >= maxProbes(state.candidates.length)) {
    return {
      type: "inconclusive",
      suspects: state.candidates.slice(state.good + 1, state.bad + 1),
      detail: `stopped after ${measured} probes`,
    };
  }
  const mid = middle(state);
  if (mid !== null) return { type: "probe", sha: state.candidates[mid], confirm: false };

  if (state.bad - state.good > 1) {
    return {
      type: "inconclusive",
      suspects: state.candidates.slice(state.good + 1, state.bad + 1),
      detail: "the commits in between could not be tested",
    };
  }
  const culprit = state.candidates[state.bad];
  const atCulprit = state.probes.filter((p) => p.sha === culprit);
  const confirmations = atCulprit.filter((p) => p.confirm && p.outcome !== "pending" && !p.retried);
  if (confirmations.some((p) => p.outcome === "pass")) {
    return {
      type: "inconclusive",
      suspects: [culprit],
      detail: "the culprit passed when run again: the failure is not reproducible (flaky)",
    };
  }
  if (atCulprit.filter((p) => p.outcome === "fail").length >= 2) {
    return {
      type: "found",
      culprit,
      proven: true,
      detail: "green before, red after, and the same cause twice",
    };
  }
  if (confirmations.some((p) => p.outcome === "skip")) {
    return { type: "inconclusive", suspects: [culprit], detail: "the confirmation run could not decide" };
  }
  return { type: "probe", sha: culprit, confirm: true };
}

/** Infrastructure failed a probe: mark it retried, so the same commit is probed again. */
export function retryProbe(state: BisectState, probe: BisectProbe, detail: string): BisectState {
  return {
    ...state,
    probes: state.probes.map(
      (p): BisectProbe =>
        p.recheckId !== undefined && p.recheckId === probe.recheckId
          ? { ...p, outcome: "skip", retried: true, detail }
          : p,
    ),
  };
}

/** Record a probe's outcome. */
export function applyProbe(state: BisectState, probe: BisectProbe, outcome: ProbeOutcome, detail: string): BisectState {
  const index = state.candidates.indexOf(probe.sha);
  const probes = state.probes.map(
    (p): BisectProbe =>
      p === probe || (p.recheckId !== undefined && p.recheckId === probe.recheckId) ? { ...p, outcome, detail } : p,
  );
  const next: BisectState = { ...state, probes, skipped: [...state.skipped] };
  if (probe.confirm || index < 0) return next;
  if (outcome === "pass" && index > next.good) next.good = Math.min(index, next.bad - 1);
  if (outcome === "fail" && index < next.bad) next.bad = Math.max(index, next.good + 1);
  if (outcome === "skip" && !next.skipped.includes(index)) next.skipped.push(index);
  return next;
}
