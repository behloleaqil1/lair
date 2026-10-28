/**
 * Tests for lair bus-mcp CLI.
 */
import { describe, it, expect } from "vitest";
import {
  BUS_MCP_USAGE,
  DEFAULT_SERVER_URL,
  EXIT_OK,
  EXIT_USAGE,
  httpBusClient,
  type BusCallResult,
  type BusMcpDeps,
} from "./bus-mcp.js";
import { newBusToken, BUS_TOKEN_PREFIX } from "../server/bus/tokens.js";

class Capture {
  stderr = "";
  err(line: string): void {
    this.stderr += line + "\n";
  }
}

describe("bus-mcp", () => {
  describe("usage errors", () => {
    it("rejects missing LAIR_BUS_TOKEN", async () => {
      const capture = new Capture();
      const deps: BusMcpDeps = {
        env: {},
        fetch: async () => ({ status: 200, text: async () => "{}" }),
        err: (line) => capture.err(line),
      };

      // Dynamically import to avoid module-level MCP setup
      const { runBusMcp } = await import("./bus-mcp.js");
      const code = await runBusMcp(deps);

      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("LAIR_BUS_TOKEN is not set");
    });

    it("rejects invalid LAIR_BUS_TOKEN format", async () => {
      const capture = new Capture();
      const deps: BusMcpDeps = {
        env: { LAIR_BUS_TOKEN: "not-a-valid-token" },
        fetch: async () => ({ status: 200, text: async () => "{}" }),
        err: (line) => capture.err(line),
      };

      const { runBusMcp } = await import("./bus-mcp.js");
      const code = await runBusMcp(deps);

      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("LAIR_BUS_TOKEN is not set to a bus token");
    });

    it("rejects invalid LAIR_URL", async () => {
      const capture = new Capture();
      const token = newBusToken();
      const deps: BusMcpDeps = {
        env: { LAIR_BUS_TOKEN: token, LAIR_URL: "not-a-url" },
        fetch: async () => ({ status: 200, text: async () => "{}" }),
        err: (line) => capture.err(line),
      };

      const { runBusMcp } = await import("./bus-mcp.js");
      const code = await runBusMcp(deps);

      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("LAIR_URL is not a URL");
    });

    it("rejects non-http LAIR_URL", async () => {
      const capture = new Capture();
      const token = newBusToken();
      const deps: BusMcpDeps = {
        env: { LAIR_BUS_TOKEN: token, LAIR_URL: "ftp://server/path" },
        fetch: async () => ({ status: 200, text: async () => "{}" }),
        err: (line) => capture.err(line),
      };

      const { runBusMcp } = await import("./bus-mcp.js");
      const code = await runBusMcp(deps);

      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("http(s)");
    });
  });

  describe("httpBusClient", () => {
    it("makes POST requests with the token", async () => {
      const token = newBusToken();
      let capturedRequest: { url: string; headers: Record<string, string>; body: string } | null = null;

      const mockFetch = async (
        url: string,
        init: { method: string; headers: Record<string, string>; body: string },
      ) => {
        capturedRequest = { url, ...init };
        return {
          status: 200,
          text: async () => JSON.stringify({ success: true, data: { agent: "test" } }),
        };
      };

      const client = httpBusClient(new URL("http://localhost:4777"), token, mockFetch);
      const result = await client.call("whoami", {});

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.url).toBe("http://localhost:4777/api/bus/call");
      expect(capturedRequest!.headers.authorization).toBe(`Bearer ${token}`);
      expect(capturedRequest!.headers["content-type"]).toBe("application/json");

      const body = JSON.parse(capturedRequest!.body);
      expect(body.tool).toBe("whoami");
      expect(body.args).toEqual({});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({ agent: "test" });
      }
    });

    it("handles server errors", async () => {
      const token = newBusToken();
      const mockFetch = async () => ({
        status: 403,
        text: async () => JSON.stringify({ success: false, error: "forbidden" }),
      });

      const client = httpBusClient(new URL("http://localhost:4777"), token, mockFetch);
      const result = await client.call("report", { kind: "DONE", task: "x", summary: "y" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.error).toBe("forbidden");
      }
    });

    it("handles network errors", async () => {
      const token = newBusToken();
      const mockFetch = async () => {
        throw new Error("Connection refused");
      };

      const client = httpBusClient(new URL("http://localhost:4777"), token, mockFetch);
      const result = await client.call("whoami", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(0);
        expect(result.error).toContain("could not be reached");
      }
    });

    it("redacts token from error messages", async () => {
      const token = newBusToken();
      const mockFetch = async () => ({
        status: 401,
        text: async () => JSON.stringify({ success: false, error: `Invalid token: ${token}` }),
      });

      const client = httpBusClient(new URL("http://localhost:4777"), token, mockFetch);
      const result = await client.call("whoami", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain(token);
        expect(result.error).toContain("[bus-token]");
      }
    });
  });
});
