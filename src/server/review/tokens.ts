/**
 * Assignment tokens: random, handed only to the agent that does the review,
 * and stored only as their sha256 (review_requests.token_hash).
 */
import { createHash, randomBytes } from "crypto";

export function newAssignmentToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
