/**
 * PR health (docs/configuration.md#pr-health, docs/design/pr-health.md).
 *
 * Reads each listed repository's open pull requests and finds the ones that
 * conflict with their base, fall far behind it, get no CI run or go red, and
 * the agent whose task line (or branch) owns each. Off unless a project sets
 * `pr_health.enabled: true`; observe only: it emits events and serves a
 * read-only status, and writes nothing.
 */
export { PrHealth, PrHealthManager, startedLine, type PrHealthOptions, type PrHealthManagerOptions, type ProjectEntry } from "./service.js";
export { parsePrHealthConfig, actBlockedReason, KINDS, NOTE_PLACEHOLDERS, type Kind, type PrHealthSettings } from "./config.js";
export { findingKey } from "./detect.js";
export { ownerOf, type FillSource, type OwnerInputs, type OwnerResult } from "./owner.js";
export { registerPrHealthRoutes } from "./routes.js";
export type { ClearedWhy, FindingView, OwnerView, Planned, PrFacts, PrHealthStatus, PrHealthTick, RepoView } from "./types.js";
