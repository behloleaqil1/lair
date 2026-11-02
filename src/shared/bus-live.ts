/**
 * The fleet bus on the dashboard (docs/design/phase3-bus.md §2): the `bus` WebSocket channel
 * (src/server/bus/live.ts), GET /api/bus/activity and the Home → Bus tab. A message's text and ack note are in
 * /api/bus/activity for the owner's session only, never on the socket (it carries no owner session).
 */
import type { ReportKind } from "./types.js";

/** A report's summary is cut to this many characters */
export const BUS_SUMMARY_MAX = 500;
/** GET /api/bus/activity answers at most this many of each kind */
export const BUS_ACTIVITY_MAX_LIMIT = 200;
export const BUS_ACTIVITY_DEFAULT_LIMIT = 50;

export type BusMessageState = "sent" | "read" | "acknowledged";

export interface BusLiveReport {
  type: "report";
  id: number;
  at: string;
  agent: string;
  task: string;
  kind: ReportKind;
  summary: string;
  gateId: string | null;
  pr: number | null;
  sha: string | null;
}

export interface BusLiveMessage {
  type: "message";
  id: string;
  at: string;
  /** Set when it was sent; a read or an acknowledgement names only the recipient */
  from?: string;
  to: string;
  state: BusMessageState;
  /** Only in /api/bus/activity, for the owner's session */
  text?: string;
  ackNote?: string | null;
}

export interface BusLiveClaim {
  type: "claim";
  at: string;
  agent: string;
  task: string;
  claim: "taken" | "released";
}

export type BusLiveEvent = BusLiveReport | BusLiveMessage | BusLiveClaim;

/** A `bus` channel update: one burst's events, oldest first; `dropped` older ones did not fit. */
export interface BusLiveUpdate {
  events: BusLiveEvent[];
  dropped: number;
}

export interface BusActivity {
  reports: BusLiveReport[];
  messages: (Omit<BusLiveMessage, "type"> & { from: string })[];
  claims: { agent: string; task: string; at: string }[];
  /** The request carried the owner's session: message texts are included */
  owner: boolean;
}
