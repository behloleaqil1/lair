/**
 * What the Work section shows for an agent the project's own launcher runs
 * (work-view.ts), apart from the component so tests check the same rules:
 * its running state (a run of Lair's agents module counts, "managed by
 * Lair") and its effective model ("(default)" when it came from
 * dragon_defaults or the built-in default).
 */
import type { Dragon } from "../shared/types";

export interface RunningLabel {
  text: "Running" | "Idle";
  badge: string;
  /** For a run of the agents module: its state and "managed by Lair", else null */
  detail: string | null;
}

const MANAGED_BADGE: Record<string, string> = {
  hung: "badge-error",
  never_started: "badge-error",
  over_budget: "badge-error",
  waiting_on_lock: "badge-warning",
  stopping: "badge-warning",
  failed_over: "badge-warning",
};

export function runningLabel(dragon: Dragon): RunningLabel {
  if (dragon.managedRun) {
    return {
      text: "Running",
      badge: MANAGED_BADGE[dragon.managedRun.state] ?? "badge-success",
      detail: `${dragon.managedRun.state.replace(/_/g, " ")}, managed by Lair`,
    };
  }
  return dragon.running
    ? { text: "Running", badge: "badge-success", detail: null }
    : { text: "Idle", badge: "badge-neutral", detail: null };
}

/** The model a dragon runs with: its own, or the default marked "(default)"; "-" without one. */
export function modelLabel(dragon: Dragon): string {
  if (!dragon.model) return "-";
  return dragon.modelFromDefault ? `${dragon.model} (default)` : dragon.model;
}

