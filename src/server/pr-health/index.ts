/**
 * PR health (docs/configuration.md#pr-health, docs/design/pr-health.md).
 *
 * Reads each listed repository's open pull requests and finds the ones that
 * conflict with their base, fall far behind it, get no CI run or go red, and
 * the agent whose task line (or branch) owns each. Off unless a project sets
 * `pr_health.enabled: true`. Observe mode (the default) emits events and
 * serves a read-only status, and writes nothing; act mode sends each owner
 * one note per problem through notify_cmd (act-once, through the delivery
 * ledger), withdraws it once the problem clears, and raises a Decision Inbox
 * notice only when nobody owns the PR or a note could not be delivered.
 */
export { PrHealth, PrHealthManager, startedLine, type PrHealthOptions, type PrHealthManagerOptions, type ProjectEntry } from "./service.js";
export { parsePrHealthConfig, actBlockedReason, KINDS, NOTE_PLACEHOLDERS, OWNER_RULES, type Kind, type OwnerRule, type PrHealthSettings } from "./config.js";
export { findingKey } from "./detect.js";
export { DeliveryLedger, MAX_COMMANDS_PER_TICK } from "./act.js";
export { NOTICE_CLASS, NOTICE_MODULE, type NoticeCode } from "./notices.js";
export { ownerOf, type FillSource, type OwnerInputs, type OwnerResult, type ReviewAuthorSource } from "./owner.js";
export { registerPrHealthRoutes } from "./routes.js";
export type { ClearedWhy, FindingView, NoteRecord, OwnerView, Planned, PrFacts, PrHealthStatus, PrHealthTick, RepoView, WithdrawState } from "./types.js";
