/**
 * Tests for lair bus CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  busCli,
  USAGE,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  EXIT_UNAVAILABLE,
  type BusCliDeps,
} from "./bus.js";
import { newBusToken, BUS_TOKEN_PREFIX } from "../server/bus/tokens.js";

class Capture {
  stdout = "";
  stderr = "";
  out(line: string): void {
    this.stdout += line + "\n";
  }
  err(line: string): void {
    this.stderr += line + "\n";
  }
}

describe("bus CLI", () => {
  let tempDir: string;
  let capture: Capture;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bus-cli-test-"));
    capture = new Capture();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  function deps(overrides: Partial<BusCliDeps> = {}): BusCliDeps {
    return {
      env: { LAIR_BUS_TOKEN: newBusToken() },
      fetch: async () => ({ status: 200, text: async () => '{"success":true,"data":{}}' }),
      out: (line) => capture.out(line),
      err: (line) => capture.err(line),
      ...overrides,
    };
  }

  describe("usage errors", () => {
    it("rejects missing LAIR_BUS_TOKEN", async () => {
      const code = await busCli(["whoami"], deps({ env: {} }));
      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("LAIR_BUS_TOKEN is not set");
    });

    it("rejects invalid LAIR_BUS_TOKEN format", async () => {
      const code = await busCli(["whoami"], deps({ env: { LAIR_BUS_TOKEN: "invalid" } }));
      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("LAIR_BUS_TOKEN is not set");
    });

    it("rejects missing command", async () => {
      const code = await busCli([], deps());
      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("missing command");
    });

    it("rejects unknown command", async () => {
      const code = await busCli(["unknown-cmd"], deps());
      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("unknown command");
    });

    it("rejects invalid LAIR_URL", async () => {
      const code = await busCli(["whoami"], deps({ env: { LAIR_BUS_TOKEN: newBusToken(), LAIR_URL: "not-a-url" } }));
      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("LAIR_URL is not a URL");
    });
  });

  describe("whoami", () => {
    it("calls the whoami tool", async () => {
      let capturedBody: { tool: string; args: unknown } | null = null;
      const code = await busCli(["whoami"], deps({
        fetch: async (_url, init) => {
          capturedBody = JSON.parse(init.body);
          return { status: 200, text: async () => '{"success":true,"data":{"agent":"worker-a","task":"feat-x"}}' };
        },
      }));

      expect(code).toBe(EXIT_OK);
      expect(capturedBody).toEqual({ tool: "whoami", args: {} });
      expect(capture.stdout).toContain("worker-a");
    });
  });

  describe("report", () => {
    it("requires --kind, --task, --summary-file", async () => {
      const code = await busCli(["report"], deps());
      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("--kind is required");
    });

    it("reads summary from file", async () => {
      const summaryFile = join(tempDir, "summary.txt");
      writeFileSync(summaryFile, "Task completed successfully\n");

      let capturedBody: { tool: string; args: Record<string, unknown> } | null = null;
      const code = await busCli(
        ["report", "--kind", "DONE", "--task", "feat-search", "--summary-file", summaryFile],
        deps({
          fetch: async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return { status: 200, text: async () => '{"success":true,"data":{"id":1}}' };
          },
        }),
      );

      expect(code).toBe(EXIT_OK);
      expect(capturedBody!.tool).toBe("report");
      expect(capturedBody!.args.kind).toBe("DONE");
      expect(capturedBody!.args.task).toBe("feat-search");
      expect(capturedBody!.args.summary).toBe("Task completed successfully");
    });

    it("accepts optional --gate, --pr, --sha", async () => {
      const summaryFile = join(tempDir, "summary.txt");
      writeFileSync(summaryFile, "Waiting");

      let capturedBody: { tool: string; args: Record<string, unknown> } | null = null;
      const code = await busCli(
        ["report", "--kind", "WAITING", "--task", "feat-x", "--summary-file", summaryFile, "--gate", "gate-123", "--pr", "42", "--sha", "abc123"],
        deps({
          fetch: async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return { status: 200, text: async () => '{"success":true,"data":{"id":2}}' };
          },
        }),
      );

      expect(code).toBe(EXIT_OK);
      expect(capturedBody!.args.gate_id).toBe("gate-123");
      expect(capturedBody!.args.pr).toBe(42);
      expect(capturedBody!.args.sha).toBe("abc123");
    });

    it("rejects invalid --kind", async () => {
      const summaryFile = join(tempDir, "summary.txt");
      writeFileSync(summaryFile, "Test");

      const code = await busCli(
        ["report", "--kind", "INVALID", "--task", "t", "--summary-file", summaryFile],
        deps(),
      );
      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("--kind must be one of");
    });

    it("rejects non-existent summary file", async () => {
      const code = await busCli(
        ["report", "--kind", "DONE", "--task", "t", "--summary-file", "/nonexistent/file.txt"],
        deps(),
      );
      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("does not exist");
    });
  });

  describe("inbox", () => {
    it("calls the inbox tool", async () => {
      let capturedBody: { tool: string } | null = null;
      const code = await busCli(["inbox"], deps({
        fetch: async (_url, init) => {
          capturedBody = JSON.parse(init.body);
          return { status: 200, text: async () => '{"success":true,"data":[]}' };
        },
      }));

      expect(code).toBe(EXIT_OK);
      expect(capturedBody!.tool).toBe("inbox");
    });
  });

  describe("ack", () => {
    it("requires --message", async () => {
      const code = await busCli(["ack"], deps());
      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("--message is required");
    });

    it("calls ack with message id and optional note", async () => {
      let capturedBody: { tool: string; args: Record<string, unknown> } | null = null;
      const code = await busCli(
        ["ack", "--message", "msg-123", "--note", "Done!"],
        deps({
          fetch: async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return { status: 200, text: async () => '{"success":true,"data":{"message_id":"msg-123"}}' };
          },
        }),
      );

      expect(code).toBe(EXIT_OK);
      expect(capturedBody!.tool).toBe("ack");
      expect(capturedBody!.args.message_id).toBe("msg-123");
      expect(capturedBody!.args.note).toBe("Done!");
    });
  });

  describe("send", () => {
    it("requires --to and --text", async () => {
      const code = await busCli(["send", "--to", "orchestrator"], deps());
      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("--text is required");
    });

    it("rejects invalid --to", async () => {
      const code = await busCli(["send", "--to", "worker-b", "--text", "Hello"], deps());
      expect(code).toBe(EXIT_USAGE);
      expect(capture.stderr).toContain("--to must be orchestrator or owner");
    });

    it("calls send with correct args", async () => {
      let capturedBody: { tool: string; args: Record<string, unknown> } | null = null;
      const code = await busCli(
        ["send", "--to", "orchestrator", "--text", "Need help", "--priority", "8"],
        deps({
          fetch: async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return { status: 200, text: async () => '{"success":true,"data":{"message_id":"x","to":"orchestrator"}}' };
          },
        }),
      );

      expect(code).toBe(EXIT_OK);
      expect(capturedBody!.tool).toBe("send");
      expect(capturedBody!.args.to).toBe("orchestrator");
      expect(capturedBody!.args.text).toBe("Need help");
      expect(capturedBody!.args.priority).toBe(8);
    });
  });

  describe("board", () => {
    it("calls the board tool", async () => {
      let capturedBody: { tool: string } | null = null;
      const code = await busCli(["board"], deps({
        fetch: async (_url, init) => {
          capturedBody = JSON.parse(init.body);
          return { status: 200, text: async () => '{"success":true,"data":{"tasks":[],"agents":[]}}' };
        },
      }));

      expect(code).toBe(EXIT_OK);
      expect(capturedBody!.tool).toBe("board");
    });
  });

  describe("server responses", () => {
    it("handles 4xx as EXIT_REFUSED", async () => {
      const code = await busCli(["whoami"], deps({
        fetch: async () => ({ status: 403, text: async () => '{"success":false,"error":"forbidden"}' }),
      }));
      expect(code).toBe(EXIT_REFUSED);
      expect(capture.stderr).toContain("refused");
    });

    it("handles 5xx as EXIT_UNAVAILABLE", async () => {
      const code = await busCli(["whoami"], deps({
        fetch: async () => ({ status: 500, text: async () => '{"success":false,"error":"internal error"}' }),
      }));
      expect(code).toBe(EXIT_UNAVAILABLE);
      expect(capture.stderr).toContain("HTTP 500");
    });

    it("handles network error as EXIT_UNAVAILABLE", async () => {
      const code = await busCli(["whoami"], deps({
        fetch: async () => { throw new Error("Connection refused"); },
      }));
      expect(code).toBe(EXIT_UNAVAILABLE);
      expect(capture.stderr).toContain("could not reach");
    });

    it("redacts token from error output", async () => {
      const token = newBusToken();
      const code = await busCli(["whoami"], deps({
        env: { LAIR_BUS_TOKEN: token },
        fetch: async () => ({ status: 401, text: async () => `{"success":false,"error":"Invalid token: ${token}"}` }),
      }));
      expect(code).toBe(EXIT_REFUSED);
      expect(capture.stderr).not.toContain(token);
      expect(capture.stderr).toContain("[bus-token]");
    });
  });
});
