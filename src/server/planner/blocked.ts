/**
 * BLOCKED reasons, classified (docs/design/planner.md#blocked-handling):
 * owner patterns first, then environment patterns; anything else is a task
 * problem (its wording, its scope, a dependency), which a planner run can
 * act on. The reason is cut before any pattern sees it.
 */
import type { BlockedClass } from "../../shared/planner-types.js";

export interface Classification {
  class: BlockedClass;
  /** The pattern that matched, or "default" */
  rule: string;
}

export function classifyBlocked(reason: string, patterns: { owner: RegExp[]; environment: RegExp[] }): Classification {
  const text = reason.slice(0, 1000);
  for (const pattern of patterns.owner) {
    if (pattern.test(text)) return { class: "owner", rule: pattern.source };
  }
  for (const pattern of patterns.environment) {
    if (pattern.test(text)) return { class: "environment", rule: pattern.source };
  }
  return { class: "task", rule: "default" };
}
