/**
 * Bus configuration parsing and validation.
 */
import type { BusConsumeMode } from "./consumers.js";

// ============ Types ============

export interface BusSettings {
  /** How fill and the planner react to bus events: off | observe | on */
  consume: BusConsumeMode;
}

// ============ Defaults ============

const DEFAULT_BUS_SETTINGS: BusSettings = {
  consume: "off",
};

// ============ Parser ============

/**
 * Parse and validate bus configuration from the project config.
 * Invalid values throw with the reason.
 */
export function parseBusConfig(raw: Record<string, unknown> | undefined): BusSettings {
  if (!raw) return { ...DEFAULT_BUS_SETTINGS };

  const settings = { ...DEFAULT_BUS_SETTINGS };

  if ("consume" in raw) {
    const mode = raw.consume;
    if (mode !== "off" && mode !== "observe" && mode !== "on") {
      throw new Error(`bus.consume must be "off", "observe", or "on"; got ${JSON.stringify(mode)}`);
    }
    settings.consume = mode;
  }

  return settings;
}

/**
 * Get the consume mode description for documentation.
 */
export function consumeModeDescription(mode: BusConsumeMode): string {
  switch (mode) {
    case "off":
      return "File reader only: events are not consumed (current behavior)";
    case "observe":
      return "Record what events would do, without acting, for comparison";
    case "on":
      return "Events drive state changes; mirrored lines are skipped";
  }
}
