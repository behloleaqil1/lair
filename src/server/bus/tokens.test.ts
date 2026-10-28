/**
 * Tests for bus tokens.
 */
import { describe, it, expect } from "vitest";
import {
  newBusToken,
  hashBusToken,
  isBusTokenFormat,
  redactBusToken,
  BUS_TOKEN_PREFIX,
} from "./tokens.js";

describe("bus tokens", () => {
  describe("newBusToken", () => {
    it("generates a token with the correct prefix", () => {
      const token = newBusToken();
      expect(token.startsWith(BUS_TOKEN_PREFIX)).toBe(true);
    });

    it("generates a token of the expected length", () => {
      const token = newBusToken();
      // prefix (8) + 43 base64url chars (32 bytes)
      expect(token.length).toBe(BUS_TOKEN_PREFIX.length + 43);
    });

    it("generates unique tokens", () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 100; i++) {
        tokens.add(newBusToken());
      }
      expect(tokens.size).toBe(100);
    });

    it("generates tokens with valid base64url characters", () => {
      const token = newBusToken();
      const payload = token.slice(BUS_TOKEN_PREFIX.length);
      expect(/^[A-Za-z0-9_-]+$/.test(payload)).toBe(true);
    });
  });

  describe("hashBusToken", () => {
    it("produces a sha256 hex hash", () => {
      const token = newBusToken();
      const hash = hashBusToken(token);
      // sha256 produces 64 hex chars
      expect(hash.length).toBe(64);
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });

    it("produces the same hash for the same token", () => {
      const token = newBusToken();
      const hash1 = hashBusToken(token);
      const hash2 = hashBusToken(token);
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different tokens", () => {
      const token1 = newBusToken();
      const token2 = newBusToken();
      expect(hashBusToken(token1)).not.toBe(hashBusToken(token2));
    });
  });

  describe("isBusTokenFormat", () => {
    it("accepts a valid token", () => {
      const token = newBusToken();
      expect(isBusTokenFormat(token)).toBe(true);
    });

    it("rejects a token without the prefix", () => {
      const badToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAabc";
      expect(isBusTokenFormat(badToken)).toBe(false);
    });

    it("rejects a token that is too short", () => {
      const shortToken = BUS_TOKEN_PREFIX + "short";
      expect(isBusTokenFormat(shortToken)).toBe(false);
    });

    it("rejects a token that is too long", () => {
      const longToken = BUS_TOKEN_PREFIX + "A".repeat(50);
      expect(isBusTokenFormat(longToken)).toBe(false);
    });

    it("rejects a token with invalid characters", () => {
      const badToken = BUS_TOKEN_PREFIX + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!@#$%ab";
      expect(isBusTokenFormat(badToken)).toBe(false);
    });

    it("rejects non-string values", () => {
      expect(isBusTokenFormat(null as unknown as string)).toBe(false);
      expect(isBusTokenFormat(undefined as unknown as string)).toBe(false);
      expect(isBusTokenFormat(123 as unknown as string)).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isBusTokenFormat("")).toBe(false);
    });
  });

  describe("redactBusToken", () => {
    it("replaces the token with a placeholder", () => {
      const token = newBusToken();
      const text = `Error with token ${token} in request`;
      const redacted = redactBusToken(text, token);
      expect(redacted).not.toContain(token);
      expect(redacted).toContain("[bus-token]");
    });

    it("replaces all occurrences", () => {
      const token = newBusToken();
      const text = `Token ${token} and again ${token}`;
      const redacted = redactBusToken(text, token);
      expect(redacted).toBe("Token [bus-token] and again [bus-token]");
    });

    it("handles text without the token", () => {
      const token = newBusToken();
      const text = "No token here";
      const redacted = redactBusToken(text, token);
      expect(redacted).toBe("No token here");
    });

    it("handles empty token", () => {
      const text = "Some text";
      const redacted = redactBusToken(text, "");
      expect(redacted).toBe("Some text");
    });
  });
});
