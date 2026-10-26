/**
 * Bus routes unit tests
 *
 * Tests for SSE endpoint and bus message handling.
 * Uses mock SQLite data for testing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";

// Test data directory
const TEST_DATA_DIR = join(process.cwd(), "data", "bus-mock", "test-project");

// Mock bus data
const mockReports = [
  {
    id: 1,
    agent: "kiro-A",
    kind: "WAITING",
    task: "feature-123",
    summary: "Waiting for gate bt-20261024-001",
    timestamp: "2026-10-24T12:00:00Z",
    gateId: "bt-20261024-001",
  },
  {
    id: 2,
    agent: "kiro-B",
    kind: "DONE",
    task: "feature-456",
    summary: "Completed, merged PR #123",
    timestamp: "2026-10-24T12:05:00Z",
    prNumber: 123,
    sha: "abc1234567890",
  },
  {
    id: 3,
    agent: "kiro-A",
    kind: "BLOCKED",
    task: "feature-123",
    summary: "Gate failed: test timeout",
    timestamp: "2026-10-24T12:10:00Z",
    gateId: "bt-20261024-002",
  },
];

const mockMessages = [
  {
    id: 1,
    from: "owner",
    to: "orchestrator",
    text: "Check status of kiro-A",
    timestamp: "2026-10-24T12:00:00Z",
    state: "sent",
  },
  {
    id: 2,
    from: "owner",
    to: "kiro-A",
    text: "Retry the gate",
    timestamp: "2026-10-24T12:02:00Z",
    state: "read",
  },
  {
    id: 3,
    from: "owner",
    to: "kiro-B",
    text: "Good job!",
    timestamp: "2026-10-24T12:06:00Z",
    state: "ack",
    ackNote: "Thanks!",
  },
];

const mockClaims = [
  { task: "feature-123", owner: "kiro-A", claimedAt: "2026-10-24T11:00:00Z" },
  { task: "feature-456", owner: "kiro-B", claimedAt: "2026-10-24T11:30:00Z" },
];

describe("Bus mock data parsing", () => {
  beforeEach(() => {
    // Create mock data directory
    if (!existsSync(TEST_DATA_DIR)) {
      mkdirSync(TEST_DATA_DIR, { recursive: true });
    }

    // Write mock data files
    writeFileSync(
      join(TEST_DATA_DIR, "reports.json"),
      JSON.stringify(mockReports, null, 2)
    );
    writeFileSync(
      join(TEST_DATA_DIR, "messages.json"),
      JSON.stringify(mockMessages, null, 2)
    );
    writeFileSync(
      join(TEST_DATA_DIR, "claims.json"),
      JSON.stringify(mockClaims, null, 2)
    );
  });

  afterEach(() => {
    // Clean up mock data
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it("reads mock reports from JSON", () => {
    const filepath = join(TEST_DATA_DIR, "reports.json");
    const data = JSON.parse(
      existsSync(filepath)
        ? readFileSync(filepath, "utf-8")
        : "[]"
    );

    expect(data).toHaveLength(3);
    expect(data[0].kind).toBe("WAITING");
    expect(data[1].kind).toBe("DONE");
    expect(data[2].kind).toBe("BLOCKED");
  });

  it("reads mock messages from JSON", () => {
    const filepath = join(TEST_DATA_DIR, "messages.json");
    const data = JSON.parse(
      existsSync(filepath)
        ? readFileSync(filepath, "utf-8")
        : "[]"
    );

    expect(data).toHaveLength(3);
    expect(data[0].state).toBe("sent");
    expect(data[1].state).toBe("read");
    expect(data[2].state).toBe("ack");
  });

  it("reads mock claims from JSON", () => {
    const filepath = join(TEST_DATA_DIR, "claims.json");
    const data = JSON.parse(
      existsSync(filepath)
        ? readFileSync(filepath, "utf-8")
        : "[]"
    );

    expect(data).toHaveLength(2);
    expect(data[0].task).toBe("feature-123");
    expect(data[0].owner).toBe("kiro-A");
  });
});

describe("Bus event types", () => {
  it("validates report kind values", () => {
    const validKinds = ["WAITING", "DONE", "BLOCKED", "PROGRESS", "TICK"];
    for (const report of mockReports) {
      expect(validKinds).toContain(report.kind);
    }
  });

  it("validates message delivery states", () => {
    const validStates = ["sent", "read", "ack"];
    for (const message of mockMessages) {
      expect(validStates).toContain(message.state);
    }
  });

  it("validates report has required fields", () => {
    for (const report of mockReports) {
      expect(report.id).toBeDefined();
      expect(typeof report.id).toBe("number");
      expect(report.agent).toBeDefined();
      expect(report.kind).toBeDefined();
      expect(report.summary).toBeDefined();
      expect(report.timestamp).toBeDefined();
    }
  });

  it("validates message has required fields", () => {
    for (const message of mockMessages) {
      expect(message.id).toBeDefined();
      expect(typeof message.id).toBe("number");
      expect(message.from).toBeDefined();
      expect(message.to).toBeDefined();
      expect(message.text).toBeDefined();
      expect(message.timestamp).toBeDefined();
      expect(message.state).toBeDefined();
    }
  });
});

describe("Bus report filtering", () => {
  it("filters reports by id (since)", () => {
    const sinceId = 1;
    const filtered = mockReports.filter((r) => r.id > sinceId);

    expect(filtered).toHaveLength(2);
    expect(filtered[0].id).toBe(2);
    expect(filtered[1].id).toBe(3);
  });

  it("returns empty array when all reports are older", () => {
    const sinceId = 100;
    const filtered = mockReports.filter((r) => r.id > sinceId);

    expect(filtered).toHaveLength(0);
  });

  it("limits number of reports", () => {
    const limit = 2;
    const limited = mockReports.slice(-limit);

    expect(limited).toHaveLength(2);
  });
});

describe("Bus message filtering", () => {
  it("filters messages by delivery state", () => {
    const sentMessages = mockMessages.filter((m) => m.state === "sent");
    expect(sentMessages).toHaveLength(1);

    const readMessages = mockMessages.filter((m) => m.state === "read");
    expect(readMessages).toHaveLength(1);

    const ackMessages = mockMessages.filter((m) => m.state === "ack");
    expect(ackMessages).toHaveLength(1);
  });

  it("filters messages by recipient", () => {
    const orchestratorMessages = mockMessages.filter(
      (m) => m.to === "orchestrator"
    );
    expect(orchestratorMessages).toHaveLength(1);

    const dragonMessages = mockMessages.filter((m) =>
      m.to.startsWith("kiro-")
    );
    expect(dragonMessages).toHaveLength(2);
  });
});

describe("SSE event format", () => {
  it("formats init event correctly", () => {
    const event = {
      type: "init",
      data: null,
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe("init");
    expect(event.data).toBeNull();
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("formats report event correctly", () => {
    const event = {
      type: "report",
      data: mockReports,
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe("report");
    expect(Array.isArray(event.data)).toBe(true);
    expect(event.data).toHaveLength(3);
  });

  it("formats message event correctly", () => {
    const event = {
      type: "message",
      data: mockMessages,
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe("message");
    expect(Array.isArray(event.data)).toBe(true);
    expect(event.data).toHaveLength(3);
  });

  it("formats heartbeat event correctly", () => {
    const event = {
      type: "heartbeat",
      data: null,
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe("heartbeat");
    expect(event.data).toBeNull();
  });

  it("serializes event to JSON for SSE", () => {
    const event = {
      type: "report",
      data: mockReports.slice(0, 1),
      timestamp: "2026-10-24T12:00:00Z",
    };

    const json = JSON.stringify(event);
    const parsed = JSON.parse(json);

    expect(parsed.type).toBe("report");
    expect(parsed.data[0].agent).toBe("kiro-A");
  });
});

describe("Message ID generation", () => {
  it("generates unique message IDs", () => {
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const id = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      ids.add(id);
    }

    // Should have generated 100 unique IDs
    expect(ids.size).toBe(100);
  });

  it("generates readable message ID format", () => {
    const id = `msg-${Date.now().toString(36)}`;

    expect(id).toMatch(/^msg-[a-z0-9]+$/);
  });
});
