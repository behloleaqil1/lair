/**
 * Start-control helpers for the Dragons view.
 *
 * `startable` is the `dragons` map from GET /api/controls/dragon/config: every
 * dragon the server accepts for start/stop (YAML `dragons:` plus dragons.txt).
 */
import type { DragonConfig } from "../shared/types";

type Startable = Record<string, DragonConfig> | undefined;

/** True if the server lists at least one dragon that can be started. */
export function hasStartableDragons(startable: Startable): boolean {
  return !!startable && Object.keys(startable).length > 0;
}

/** True if the server accepts a start request for this dragon. */
export function canStartDragon(dragonId: string, startable: Startable): boolean {
  return !!startable && Object.prototype.hasOwnProperty.call(startable, dragonId);
}

/**
 * The machine/model line under the dialog's dragon picker. A dragon listed
 * only in dragons.txt has no machine or model.
 */
export function dragonSummary(dragon: Pick<DragonConfig, "machine" | "model">): string {
  return `Machine: ${dragon.machine || "-"} | Model: ${dragon.model || "not set"}`;
}
