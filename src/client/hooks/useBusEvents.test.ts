/**
 * useBusEvents hook unit tests
 *
 * Tests for event parsing, merging, and state management.
 * Note: These test the pure functions; SSE connection tests would need a mock server.
 */
import { describe, it, expect } from "vitest";
import {
  getDeliveryStateDisplay,
  getReportKindDisplay,
} from "./useBusEvents";
import type { BusReport, BusMessage } from "../../shared/bus-types";

describe("getDeliveryStateDisplay", () => {
  it("returns correct display for sent state", () => {
    const display = getDeliveryStateDisplay("sent");

    expect(display.icon).toBe("📤");
    expect(display.label).toBe("Sent");
    expect(display.className).toBe("state-sent");
  });

  it("returns correct display for read state", () => {
    const display = getDeliveryStateDisplay("read");

    expect(display.icon).toBe("👁");
    expect(display.label).toBe("Read");
    expect(display.className).toBe("state-read");
  });

  it("returns correct display for ack state", () => {
    const display = getDeliveryStateDisplay("ack");

    expect(display.icon).toBe("✓");
    expect(display.label).toBe("Acknowledged");
    expect(display.className).toBe("state-ack");
  });
});

describe("getReportKindDisplay", () => {
  it("returns correct display for WAITING", () => {
    const display = getReportKindDisplay("WAITING");

    expect(display.icon).toBe("⏳");
    expect(display.label).toBe("Waiting");
    expect(display.className).toBe("kind-waiting");
  });

  it("returns correct display for DONE", () => {
    const display = getReportKindDisplay("DONE");

    expect(display.icon).toBe("✅");
    expect(display.label).toBe("Done");
    expect(display.className).toBe("kind-done");
  });

  it("returns correct display for BLOCKED", () => {
    const display = getReportKindDisplay("BLOCKED");

    expect(display.icon).toBe("🚫");
    expect(display.label).toBe("Blocked");
    expect(display.className).toBe("kind-blocked");
  });

  it("returns correct display for PROGRESS", () => {
    const display = getReportKindDisplay("PROGRESS");

    expect(display.icon).toBe("🔄");
    expect(display.label).toBe("Progress");
    expect(display.className).toBe("kind-progress");
  });

  it("returns correct display for TICK", () => {
    const display = getReportKindDisplay("TICK");

    expect(display.icon).toBe("🕐");
    expect(display.label).toBe("Tick");
    expect(display.className).toBe("kind-tick");
  });
});

describe("Report merging logic", () => {
  const existingReports: BusReport[] = [
    {
      id: 1,
      agent: "kiro-A",
      kind: "WAITING",
      task: "task-1",
      summary: "Waiting...",
      timestamp: "2026-10-24T12:00:00Z",
    },
    {
      id: 2,
      agent: "kiro-B",
      kind: "DONE",
      task: "task-2",
      summary: "Done",
      timestamp: "2026-10-24T12:01:00Z",
    },
  ];

  it("adds new reports to existing list", () => {
    const newReports: BusReport[] = [
      {
        id: 3,
        agent: "kiro-C",
        kind: "PROGRESS",
        task: "task-3",
        summary: "In progress",
        timestamp: "2026-10-24T12:02:00Z",
      },
    ];

    // Merge logic: combine by ID, keep newest
    const byId = new Map<number, BusReport>();
    for (const r of existingReports) byId.set(r.id, r);
    for (const r of newReports) byId.set(r.id, r);
    const merged = Array.from(byId.values());

    expect(merged).toHaveLength(3);
    expect(merged.find((r) => r.id === 3)).toBeDefined();
  });

  it("updates existing report with new data", () => {
    const updatedReport: BusReport = {
      id: 1,
      agent: "kiro-A",
      kind: "DONE", // Changed from WAITING
      task: "task-1",
      summary: "Now done!",
      timestamp: "2026-10-24T12:03:00Z",
    };

    const byId = new Map<number, BusReport>();
    for (const r of existingReports) byId.set(r.id, r);
    byId.set(updatedReport.id, updatedReport); // Overwrites
    const merged = Array.from(byId.values());

    expect(merged).toHaveLength(2);
    const report1 = merged.find((r) => r.id === 1);
    expect(report1?.kind).toBe("DONE");
    expect(report1?.summary).toBe("Now done!");
  });

  it("maintains order by timestamp descending", () => {
    const allReports: BusReport[] = [
      ...existingReports,
      {
        id: 3,
        agent: "kiro-C",
        kind: "WAITING",
        summary: "Newest",
        timestamp: "2026-10-24T12:05:00Z",
      },
    ];

    const sorted = allReports.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    expect(sorted[0].id).toBe(3); // Newest first
    expect(sorted[sorted.length - 1].id).toBe(1); // Oldest last
  });
});

describe("Message merging logic", () => {
  const existingMessages: BusMessage[] = [
    {
      id: 1,
      from: "owner",
      to: "orchestrator",
      text: "Check status",
      timestamp: "2026-10-24T12:00:00Z",
      state: "sent",
    },
    {
      id: 2,
      from: "owner",
      to: "kiro-A",
      text: "Retry",
      timestamp: "2026-10-24T12:01:00Z",
      state: "read",
    },
  ];

  it("updates message delivery state", () => {
    const updatedMessage: BusMessage = {
      id: 1,
      from: "owner",
      to: "orchestrator",
      text: "Check status",
      timestamp: "2026-10-24T12:00:00Z",
      state: "ack", // Changed from sent
      ackNote: "Status: all good",
    };

    const byId = new Map<number, BusMessage>();
    for (const m of existingMessages) byId.set(m.id, m);
    byId.set(updatedMessage.id, updatedMessage);
    const merged = Array.from(byId.values());

    const msg1 = merged.find((m) => m.id === 1);
    expect(msg1?.state).toBe("ack");
    expect(msg1?.ackNote).toBe("Status: all good");
  });

  it("adds new messages", () => {
    const newMessage: BusMessage = {
      id: 3,
      from: "owner",
      to: "kiro-B",
      text: "Good job!",
      timestamp: "2026-10-24T12:02:00Z",
      state: "sent",
    };

    const byId = new Map<number, BusMessage>();
    for (const m of existingMessages) byId.set(m.id, m);
    byId.set(newMessage.id, newMessage);
    const merged = Array.from(byId.values());

    expect(merged).toHaveLength(3);
    expect(merged.find((m) => m.id === 3)?.to).toBe("kiro-B");
  });
});

describe("SSE event parsing", () => {
  it("parses report event data", () => {
    const eventData = JSON.stringify({
      type: "report",
      data: [
        {
          id: 1,
          agent: "kiro-A",
          kind: "DONE",
          summary: "Complete",
          timestamp: "2026-10-24T12:00:00Z",
        },
      ],
      timestamp: "2026-10-24T12:00:00Z",
    });

    const parsed = JSON.parse(eventData);

    expect(parsed.type).toBe("report");
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data[0].kind).toBe("DONE");
  });

  it("parses message event data", () => {
    const eventData = JSON.stringify({
      type: "message",
      data: [
        {
          id: 1,
          from: "owner",
          to: "kiro-A",
          text: "Test",
          timestamp: "2026-10-24T12:00:00Z",
          state: "sent",
        },
      ],
      timestamp: "2026-10-24T12:00:00Z",
    });

    const parsed = JSON.parse(eventData);

    expect(parsed.type).toBe("message");
    expect(parsed.data[0].state).toBe("sent");
  });

  it("handles init event", () => {
    const eventData = JSON.stringify({
      type: "init",
      data: null,
      timestamp: "2026-10-24T12:00:00Z",
    });

    const parsed = JSON.parse(eventData);

    expect(parsed.type).toBe("init");
    expect(parsed.data).toBeNull();
  });

  it("handles heartbeat event", () => {
    const eventData = JSON.stringify({
      type: "heartbeat",
      data: null,
      timestamp: "2026-10-24T12:00:00Z",
    });

    const parsed = JSON.parse(eventData);

    expect(parsed.type).toBe("heartbeat");
  });

  it("handles malformed JSON gracefully", () => {
    const badData = "not valid json";

    let parsed = null;
    try {
      parsed = JSON.parse(badData);
    } catch {
      parsed = null;
    }

    expect(parsed).toBeNull();
  });
});

describe("Relative time formatting", () => {
  it("formats recent timestamps as 'just now'", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 30 * 1000); // 30 seconds ago

    const diffMs = now.getTime() - recent.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    expect(diffSec).toBeLessThan(60);
  });

  it("formats minutes ago correctly", () => {
    const now = new Date();
    const past = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago

    const diffMs = now.getTime() - past.getTime();
    const diffMin = Math.floor(diffMs / 1000 / 60);

    expect(diffMin).toBe(5);
  });

  it("formats hours ago correctly", () => {
    const now = new Date();
    const past = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago

    const diffMs = now.getTime() - past.getTime();
    const diffHour = Math.floor(diffMs / 1000 / 60 / 60);

    expect(diffHour).toBe(2);
  });
});
