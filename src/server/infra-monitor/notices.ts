/**
 * A finding becomes one notice in the Decision Inbox (act mode only): for
 * information, nothing to choose, never counted or notified. Deduped by the
 * finding's key while open; withdrawn once the cause has stayed gone.
 */
import type { RaiseDecisionInput } from "../decisions/types.js";
import { oneLine } from "./detectors.js";
import type { InfraFinding } from "./types.js";

export const NOTICE_MODULE = "infra_monitor";
export const NOTICE_CLASS = "infra_monitor.notice";
export const NOTICE_NOTED = "noted";

const MAX_CONTEXT = 4000;

export function noticeFor(project: string, finding: InfraFinding, clearMinutes: number): RaiseDecisionInput {
  const context = [
    `**${finding.type}**`,
    "",
    ...finding.evidence.map((line) => `- ${oneLine(line, 300)}`),
    "",
    `Lair withdraws this notice once the cause has been gone for ${clearMinutes} min. GET /api/infra-monitor/status shows it live.`,
  ].join("\n");
  return {
    project,
    kind: "other",
    attention: "notice",
    title: oneLine(finding.summary, 200),
    context: context.slice(0, MAX_CONTEXT),
    options: [
      {
        id: NOTICE_NOTED,
        label: "Noted",
        effect: "reversible",
        consequences: "The notice closes. Lair raises it again only when the problem clears and comes back.",
      },
    ],
    recommended: {
      optionId: NOTICE_NOTED,
      reasoning: "Nothing is decided here: the fix is on the machine or its runner, and the notice goes by itself once the problem clears.",
    },
    source: { module: NOTICE_MODULE, ref: finding.key },
    key: finding.key,
    class: NOTICE_CLASS,
    evidence: { code: finding.type, facts: finding.facts, cause_cleared: false, linked_issue: null },
  };
}
