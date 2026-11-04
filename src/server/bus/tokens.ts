/**
 * Bus tokens: per-run authentication for the bus API.
 *
 * Each agent run gets a unique bus token in its environment (LAIR_BUS_TOKEN).
 * The token is:
 * - Random, 32 bytes base64url encoded
 * - Bound to project + agent + run id
 * - Valid only while the run is active
 * - Stored only as a sha256 hash (the token itself is never written to disk)
 * - Never printed in logs or responses
 *
 * The token proves: "I am this run of this agent in this project, and my run
 * is still active." Without it, a process can't act on the bus.
 *
 * An external worker's token (`lair bus token create`, the owner's) is the
 * other kind: prefix `lairext_`, made and hashed the same way, bound to a
 * project, a worker id (its reports' agent is always `ext:<worker>`), an
 * expiry and the report kinds it may send. It only reports: the run token
 * format check refuses it, and the bus refuses it every other tool.
 */
import { createHash, randomBytes } from "crypto";
import type { ReportKind } from "../../bus/types.js";

/** The token prefix, for format validation without revealing the token */
export const BUS_TOKEN_PREFIX = "lairbus_";

/** Generate a new bus token (32 random bytes, base64url) */
export function newBusToken(): string {
  return BUS_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Hash a token for storage (sha256 hex) */
export function hashBusToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Check if a string looks like a bus token (format only, not validity) */
export function isBusTokenFormat(value: string): boolean {
  // prefix + 43 base64url chars (32 bytes)
  return (
    typeof value === "string" &&
    value.startsWith(BUS_TOKEN_PREFIX) &&
    value.length === BUS_TOKEN_PREFIX.length + 43 &&
    /^[A-Za-z0-9_-]+$/.test(value.slice(BUS_TOKEN_PREFIX.length))
  );
}

/** A bound bus token: what it proves */
export interface BusTokenBinding {
  project: string;
  agent: string;
  runId: string;
  tokenHash: string;
  issuedAt: number;
}

/** The prefix of an external worker's token: never a run's */
export const EXT_TOKEN_PREFIX = "lairext_";

/** An external worker's reports carry this agent namespace, `ext:<worker>`: never a fleet agent's id */
export const EXT_AGENT_PREFIX = "ext:";

/** A new external worker token (32 random bytes, base64url); only its hashBusToken() is stored */
export function newExtToken(): string {
  return EXT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Check if a string looks like an external worker's token (format only, not validity) */
export function isExtTokenFormat(value: string): boolean {
  return typeof value === "string" && /^lairext_[A-Za-z0-9_-]{43}$/.test(value);
}

/** What an external worker's token proves (never the token itself) */
export interface ExtTokenBinding {
  /** The token's public id: the list, revoking, the audit */
  id: string;
  project: string;
  worker: string;
  /** Always `ext:<worker>` */
  agent: string;
  kinds: ReportKind[];
  expiresAt: number;
}

/** Remove a token from a string (for safe logging) */
export function redactBusToken(text: string, token: string): string {
  if (!token || token.length === 0) return text;
  return text.split(token).join("[bus-token]");
}

/** Any bus token, a run's or an external worker's, whole or cut short: the prefix and the base64url characters after it */
const BUS_TOKEN_PATTERN = new RegExp(`(?:${BUS_TOKEN_PREFIX}|${EXT_TOKEN_PREFIX})[A-Za-z0-9_-]+`, "g");

/** Remove every bus token from a text other readers see (a report's summary): the writer's own or any other run's */
export function redactBusTokens(text: string): string {
  return text.replace(BUS_TOKEN_PATTERN, "[bus-token]");
}
