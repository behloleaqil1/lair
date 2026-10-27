/**
 * The keys of `triage.recheck` for re-checks in a project's own gate system
 * (docs/configuration.md, "Re-checks for an existing gate system"). They sit
 * beside the Lair-run re-check's keys (max_retries, ...) in the same block.
 */
import { z } from "zod";

/** Placeholders of triage.recheck.command; {tests} is a list */
export const GATE_RECHECK_PLACEHOLDERS = ["sha", "pipeline", "branch", "result_id", "reason", "kind", "tests", "project"] as const;
export type GateRecheckPlaceholder = (typeof GATE_RECHECK_PLACEHOLDERS)[number];

export type GateRecheckKindSetting = "same" | "failed_tests" | "none";

const kindSetting = z.enum(["same", "failed_tests", "none"]);

/** Spread into triage.recheck's (strict) schema */
export const GATE_RECHECK_KEYS = {
  /** off (default) | observe: record "would re-check" with the argv | act: run it */
  mode: z.enum(["off", "observe", "act"]).default("off"),
  /** Enqueues the re-check in the gate system and returns; an argv, no shell */
  command: z.array(z.string().min(1).max(1000)).min(1).max(64).optional(),
  max_per_result: z.number().int().min(1).max(5).default(2),
  cooldown_seconds: z.number().int().min(0).max(86_400).default(120),
  timeout_seconds: z.number().int().min(1).max(600).default(60),
  /** A queued re-check without a result by then expires: reported, never retried */
  expire_hours: z.number().positive().max(168).default(3),
  kinds: z
    .object({
      infra: kindSetting.default("same"),
      timeout: kindSetting.default("failed_tests"),
      flaky: kindSetting.default("failed_tests"),
    })
    .strict()
    .default({}),
  max_tests: z.number().int().min(1).max(100).default(8),
  /** Project-wide: at most this many re-checks running or queued in the gate system at once; more wait their turn */
  max_pending: z.number().int().min(1).max(50).default(3),
};

const GateRecheckSchema = z.object(GATE_RECHECK_KEYS);
type RawGateRecheck = z.infer<typeof GateRecheckSchema>;

export interface GateRecheckSettings {
  mode: "off" | "observe" | "act";
  command?: string[];
  maxPerResult: number;
  cooldownSeconds: number;
  timeoutSeconds: number;
  expireHours: number;
  kinds: { infra: GateRecheckKindSetting; timeout: GateRecheckKindSetting; flaky: GateRecheckKindSetting };
  maxTests: number;
  maxPending: number;
}

/** The settings, or config errors in `errors`. */
export function parseGateRecheck(raw: RawGateRecheck, errors: string[]): GateRecheckSettings {
  const command = raw.command;
  if (raw.mode !== "off" && !command) {
    errors.push(`triage.recheck.command is required with triage.recheck.mode: ${raw.mode}`);
  }
  if (command) {
    const allowed = new Set<string>(GATE_RECHECK_PLACEHOLDERS);
    for (const arg of command) {
      for (const match of arg.matchAll(/\{([A-Za-z_]+)\}/g)) {
        if (!allowed.has(match[1])) {
          errors.push(
            `triage.recheck.command: unknown placeholder {${match[1]}} (allowed: ${GATE_RECHECK_PLACEHOLDERS.map((n) => `{${n}}`).join(", ")})`,
          );
        }
      }
    }
    if (command[0].includes("{")) errors.push("triage.recheck.command: the program (its first item) cannot hold a placeholder");
  }
  return {
    mode: raw.mode,
    command,
    maxPerResult: raw.max_per_result,
    cooldownSeconds: raw.cooldown_seconds,
    timeoutSeconds: raw.timeout_seconds,
    expireHours: raw.expire_hours,
    kinds: { infra: raw.kinds.infra, timeout: raw.kinds.timeout, flaky: raw.kinds.flaky },
    maxTests: raw.max_tests,
    maxPending: raw.max_pending,
  };
}
