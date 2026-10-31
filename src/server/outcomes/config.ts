/**
 * The `outcome_tracker:` section of data/server.yaml, Lair's own config
 * (never a project's YAML). Read once when the server starts. Off when the
 * section is missing or refused.
 *
 *   outcome_tracker:
 *     enabled: true
 *     check_minutes: 10       # how often answered decisions are looked at
 *     restart_hours: 24       # window after an agent restart answer
 *     hold_hours: 6           # window after a wait / hold answer
 *     release_hours: 24       # window after a release / stand-down answer
 *     planner_hours: 72       # window after a planner proposal answer
 *     merge_hours: 24         # window after a merge
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { readCheckedFile, type ServerConfigFileOptions } from "../restart/server-config.js";
import type { WindowHours } from "./types.js";

export interface OutcomeTrackerSettings {
  enabled: boolean;
  checkMinutes: number;
  windows: WindowHours;
}

export const OUTCOME_TRACKER_OFF: OutcomeTrackerSettings = {
  enabled: false,
  checkMinutes: 10,
  windows: { restart: 24, hold: 6, release: 24, planner: 72, merge: 24 },
};

export type OutcomeTrackerConfigResult =
  | { ok: true; settings: OutcomeTrackerSettings }
  | { ok: false; errors: string[]; settings: OutcomeTrackerSettings };

const hours = (fallback: number) => z.number().min(0.1).max(24 * 30).default(fallback);

const Schema = z
  .object({
    enabled: z.boolean().default(false),
    check_minutes: z.number().min(1).max(24 * 60).default(OUTCOME_TRACKER_OFF.checkMinutes),
    restart_hours: hours(OUTCOME_TRACKER_OFF.windows.restart),
    hold_hours: hours(OUTCOME_TRACKER_OFF.windows.hold),
    release_hours: hours(OUTCOME_TRACKER_OFF.windows.release),
    planner_hours: hours(OUTCOME_TRACKER_OFF.windows.planner),
    merge_hours: hours(OUTCOME_TRACKER_OFF.windows.merge),
  })
  .strict();

export function parseOutcomeTrackerConfig(raw: unknown): OutcomeTrackerConfigResult {
  const section = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).outcome_tracker : undefined;
  if (section === undefined || section === null) return { ok: true, settings: OUTCOME_TRACKER_OFF };
  const parsed = Schema.safeParse(section);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `outcome_tracker.${i.path.join(".") || "(section)"}: ${i.message}`),
      settings: OUTCOME_TRACKER_OFF,
    };
  }
  const v = parsed.data;
  return {
    ok: true,
    settings: {
      enabled: v.enabled,
      checkMinutes: v.check_minutes,
      windows: { restart: v.restart_hours, hold: v.hold_hours, release: v.release_hours, planner: v.planner_hours, merge: v.merge_hours },
    },
  };
}

/** Read and parse the section from data/server.yaml. A refused file is off, with the reason. */
export function loadOutcomeTrackerConfig(configPath: string, options: ServerConfigFileOptions = {}): OutcomeTrackerConfigResult {
  const read = readCheckedFile(configPath, options);
  if (!read.ok) return { ok: false, errors: [`data/server.yaml ${read.error}`], settings: OUTCOME_TRACKER_OFF };
  if (read.text === null) return { ok: true, settings: OUTCOME_TRACKER_OFF };
  let raw: unknown;
  try {
    raw = parseYaml(read.text);
  } catch (e) {
    return { ok: false, errors: [`data/server.yaml: ${e instanceof Error ? e.message : String(e)}`], settings: OUTCOME_TRACKER_OFF };
  }
  return parseOutcomeTrackerConfig(raw);
}
