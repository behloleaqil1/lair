/**
 * Decision Inbox (docs/design/autonomy.md §1): the only place Lair asks a
 * human. Mounted by src/server/index.ts with mountDecisions(); other modules
 * use the DecisionProducer interface to raise decisions, park the work they
 * block, and resume when they are answered. See docs/configuration.md#decision-inbox.
 */
export { DecisionInbox } from "./service.js";
export type { DecisionInboxOptions } from "./service.js";
export { DecisionStore } from "./store.js";
export { registerDecisionRoutes } from "./routes.js";
export { maxOpenFromEnv, maxOpenHttpFromEnv, mountDecisions } from "./mount.js";
export { InboxDecisionHook, listenForDecisionRequests, toDecisionInput } from "./request-bridge.js";
export { HOLD_KEEP, HOLD_RELEASE, HoldDecisions } from "./holds.js";
export type { OwnerHold } from "./holds.js";
export type { MountDecisionsOptions, DecisionConsumer } from "./mount.js";
export { MemorySecretStore, SecretStoreUnavailableError } from "./secrets.js";
export type { SecretStore } from "./secrets.js";
export { DecisionError, isDecisionId, parseRaiseInput, parseAnswerInput } from "./validate.js";
export type {
  AnswerContext,
  AnswerInput,
  Clock,
  DecisionProducer,
  DecisionResolution,
  RaiseDecisionInput,
  RaiseResult,
  ResolutionHandler,
  WithdrawInput,
} from "./types.js";
