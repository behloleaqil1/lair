/**
 * Bus module exports.
 */
export { BusService, ORCHESTRATOR_ID, OWNER_ID } from "./service.js";
export type {
  WhoamiResult,
  ReportResult,
  SendResult,
  InboxMessage,
  BoardTask,
  BoardAgent,
  BoardResult,
  BusError,
  BusResult,
  BusServiceOptions,
} from "./service.js";

export { BusStore, getBusStore, closeBusStores, messageState } from "./store.js";
export type { BusReport, BusMessage, MessageState } from "./store.js";

export {
  newBusToken,
  hashBusToken,
  isBusTokenFormat,
  redactBusToken,
  BUS_TOKEN_PREFIX,
} from "./tokens.js";
export type { BusTokenBinding } from "./tokens.js";

export { BusMirror } from "./mirror.js";
export type { BusMirrorConfig } from "./mirror.js";

export {
  BusConsumers,
  BUS_CONSUME_MODES,
  extractBusId,
  stripBusMarker,
  isMirrorOf,
  mirroredReport,
  structuredReport,
  validateBusReportEvent,
  validateBusMessageEvent,
  eventMismatch,
} from "./consumers.js";
export type {
  BusConsumeMode,
  BusConsumerHealth,
  BusConsumersOptions,
  BusLineSource,
  BusMessageEvent,
  BusObservation,
  BusObservationView,
  BusRefusal,
  BusReportEvent,
  StructuredReport,
} from "./consumers.js";

export { parseBusConfig } from "./config.js";
export type { BusSettings } from "./config.js";
export { agentsBusFor } from "./wiring.js";
export type { AgentsBusOptions } from "./wiring.js";
