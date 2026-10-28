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
 */
import { createHash, randomBytes } from "crypto";

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

/** Remove a token from a string (for safe logging) */
export function redactBusToken(text: string, token: string): string {
  if (!token || token.length === 0) return text;
  return text.split(token).join("[bus-token]");
}
