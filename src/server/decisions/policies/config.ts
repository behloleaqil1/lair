/**
 * The `decision_policies:` section of data/server.yaml, Lair's own config
 * (never a project's YAML). Read once when the server starts. Off when the
 * section is missing or refused.
 *
 *   decision_policies:
 *     enabled: true    # write shadow proposals into the policy trace, and let modules update a raised decision's evidence
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { readCheckedFile, type ServerConfigFileOptions } from "../../restart/server-config.js";

export interface DecisionPoliciesSettings {
  enabled: boolean;
}

export const DECISION_POLICIES_OFF: DecisionPoliciesSettings = { enabled: false };

export type DecisionPoliciesConfigResult =
  | { ok: true; settings: DecisionPoliciesSettings }
  | { ok: false; errors: string[]; settings: DecisionPoliciesSettings };

const Schema = z.object({ enabled: z.boolean().default(false) }).strict();

export function parseDecisionPoliciesConfig(raw: unknown): DecisionPoliciesConfigResult {
  const section = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).decision_policies : undefined;
  if (section === undefined || section === null) return { ok: true, settings: DECISION_POLICIES_OFF };
  const parsed = Schema.safeParse(section);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `decision_policies.${i.path.join(".") || "(section)"}: ${i.message}`),
      settings: DECISION_POLICIES_OFF,
    };
  }
  return { ok: true, settings: { enabled: parsed.data.enabled } };
}

/** Read and parse the section from data/server.yaml. A refused file is off, with the reason. */
export function loadDecisionPoliciesConfig(configPath: string, options: ServerConfigFileOptions = {}): DecisionPoliciesConfigResult {
  const read = readCheckedFile(configPath, options);
  if (!read.ok) return { ok: false, errors: [`data/server.yaml ${read.error}`], settings: DECISION_POLICIES_OFF };
  if (read.text === null) return { ok: true, settings: DECISION_POLICIES_OFF };
  let raw: unknown;
  try {
    raw = parseYaml(read.text);
  } catch (e) {
    return { ok: false, errors: [`data/server.yaml: ${e instanceof Error ? e.message : String(e)}`], settings: DECISION_POLICIES_OFF };
  }
  return parseDecisionPoliciesConfig(raw);
}
