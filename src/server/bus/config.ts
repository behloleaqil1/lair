/**
 * The project's `bus:` block (docs/configuration.md#fleet-bus):
 *
 *   bus:
 *     consume: off | observe | on   # default off
 */
import { BUS_CONSUME_MODES, type BusConsumeMode } from "./consumers.js";

export interface BusSettings {
  /** How fill and the planner read the bus's reports: off | observe | on */
  consume: BusConsumeMode;
}

const KEYS = ["consume"];

const isConsumeMode = (value: unknown): value is BusConsumeMode => BUS_CONSUME_MODES.some((mode) => mode === value);

/** The settings, or every reason the block is refused. A missing block is the default (off). */
export function parseBusConfig(raw: unknown): { ok: true; settings: BusSettings } | { ok: false; errors: string[] } {
  if (raw === undefined || raw === null) return { ok: true, settings: { consume: "off" } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["bus must be a mapping"] };
  const block = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(block)) {
    if (!KEYS.includes(key)) errors.push(`bus.${key} is not a known key (known: ${KEYS.join(", ")})`);
  }
  const consume = block.consume ?? "off";
  if (!isConsumeMode(consume)) errors.push(`bus.consume must be one of ${BUS_CONSUME_MODES.join(", ")}; got ${JSON.stringify(consume)}`);
  if (errors.length > 0 || !isConsumeMode(consume)) return { ok: false, errors };
  return { ok: true, settings: { consume } };
}
