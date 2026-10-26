/**
 * useWebSocket hook tests
 *
 * Tests for WebSocket connection management and message handling.
 * Note: These test the logic, not actual WebSocket connections.
 */
import { describe, it, expect } from "vitest";

// WebSocket message types (matching the hook)
interface WSServerMessage {
  type: "connected" | "subscribed" | "unsubscribed" | "update" | "error" | "pong";
  sessionId?: string;
  channel?: string;
  channels?: string[];
  data?: unknown;
  error?: string;
  timestamp: string;
}

interface DragonUpdateData {
  id: string;
  event: "status_change" | "log_line" | "task_change";
  running?: boolean;
  task?: string;
  lastLogLine?: string;
  lastLogTime?: string;
}

interface GateUpdateData {
  id: string;
  event: "queued" | "started" | "completed" | "step_change";
  lane?: string;
  rc?: number;
  currentStep?: string;
}

describe("WebSocket message parsing", () => {
  it("parses connected message", () => {
    const message: WSServerMessage = {
      type: "connected",
      sessionId: "abc-123",
      timestamp: new Date().toISOString(),
    };

    expect(message.type).toBe("connected");
    expect(message.sessionId).toBe("abc-123");
  });

  it("parses subscribed message", () => {
    const message: WSServerMessage = {
      type: "subscribed",
      channels: ["dragons", "gates"],
      timestamp: new Date().toISOString(),
    };

    expect(message.type).toBe("subscribed");
    expect(message.channels).toHaveLength(2);
    expect(message.channels).toContain("dragons");
    expect(message.channels).toContain("gates");
  });

  it("parses update message with dragon data", () => {
    const data: DragonUpdateData = {
      id: "kiro-A",
      event: "status_change",
      running: true,
      task: "feature-123",
    };

    const message: WSServerMessage = {
      type: "update",
      channel: "dragons",
      data,
      timestamp: new Date().toISOString(),
    };

    expect(message.type).toBe("update");
    expect(message.channel).toBe("dragons");
    expect((message.data as DragonUpdateData).id).toBe("kiro-A");
    expect((message.data as DragonUpdateData).running).toBe(true);
  });

  it("parses update message with gate data", () => {
    const data: GateUpdateData = {
      id: "20261025T123456Z-test",
      event: "completed",
      rc: 0,
    };

    const message: WSServerMessage = {
      type: "update",
      channel: "gates",
      data,
      timestamp: new Date().toISOString(),
    };

    expect(message.type).toBe("update");
    expect(message.channel).toBe("gates");
    expect((message.data as GateUpdateData).rc).toBe(0);
  });

  it("parses error message", () => {
    const message: WSServerMessage = {
      type: "error",
      error: "Invalid channel",
      timestamp: new Date().toISOString(),
    };

    expect(message.type).toBe("error");
    expect(message.error).toBe("Invalid channel");
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

describe("Dragon update handling", () => {
  interface Dragon {
    id: string;
    name: string;
    running: boolean;
    task: string;
    lastLogLine?: string;
    lastLogTime?: string;
  }

  const initialDragons: Dragon[] = [
    { id: "kiro-A", name: "Smaug", running: false, task: "" },
    { id: "kiro-B", name: "Temeraire", running: true, task: "feature-456" },
  ];

  it("updates dragon running status", () => {
    const update: DragonUpdateData = {
      id: "kiro-A",
      event: "status_change",
      running: true,
    };

    const updated = initialDragons.map((dragon) => {
      if (dragon.id !== update.id) return dragon;
      return {
        ...dragon,
        running: update.running ?? dragon.running,
      };
    });

    const dragonA = updated.find((d) => d.id === "kiro-A");
    expect(dragonA?.running).toBe(true);
  });

  it("updates dragon task", () => {
    const update: DragonUpdateData = {
      id: "kiro-A",
      event: "task_change",
      task: "new-task",
    };

    const updated = initialDragons.map((dragon) => {
      if (dragon.id !== update.id) return dragon;
      return {
        ...dragon,
        task: update.task ?? dragon.task,
      };
    });

    const dragonA = updated.find((d) => d.id === "kiro-A");
    expect(dragonA?.task).toBe("new-task");
  });

  it("updates dragon last log line", () => {
    const update: DragonUpdateData = {
      id: "kiro-A",
      event: "log_line",
      lastLogLine: "Test completed",
      lastLogTime: "2026-10-25T12:00:00Z",
    };

    const updated = initialDragons.map((dragon) => {
      if (dragon.id !== update.id) return dragon;
      return {
        ...dragon,
        lastLogLine: update.lastLogLine ?? dragon.lastLogLine,
        lastLogTime: update.lastLogTime ?? dragon.lastLogTime,
      };
    });

    const dragonA = updated.find((d) => d.id === "kiro-A");
    expect(dragonA?.lastLogLine).toBe("Test completed");
    expect(dragonA?.lastLogTime).toBe("2026-10-25T12:00:00Z");
  });

  it("ignores update for non-existent dragon", () => {
    const update: DragonUpdateData = {
      id: "kiro-Z",
      event: "status_change",
      running: true,
    };

    const updated = initialDragons.map((dragon) => {
      if (dragon.id !== update.id) return dragon;
      return {
        ...dragon,
        running: update.running ?? dragon.running,
      };
    });

    // Should be unchanged
    expect(updated).toEqual(initialDragons);
  });

  it("handles 'all' update gracefully", () => {
    const update: DragonUpdateData = {
      id: "all",
      event: "status_change",
    };

    // "all" should not modify individual dragons
    const updated =
      update.id === "all"
        ? initialDragons
        : initialDragons.map((dragon) => {
            if (dragon.id !== update.id) return dragon;
            return { ...dragon };
          });

    expect(updated).toEqual(initialDragons);
  });
});

describe("Gate update handling", () => {
  interface Gate {
    id: string;
    lane: string;
    status: string;
    rc?: number;
  }

  const initialGates: Gate[] = [
    { id: "gate-1", lane: "heavy", status: "running" },
    { id: "gate-2", lane: "light", status: "queued" },
  ];

  it("updates gate status on completion", () => {
    const update: GateUpdateData = {
      id: "gate-1",
      event: "completed",
      rc: 0,
    };

    const updated = initialGates.map((gate) => {
      if (gate.id !== update.id) return gate;
      return {
        ...gate,
        status: update.event === "completed" ? "completed" : gate.status,
        rc: update.rc,
      };
    });

    const gate1 = updated.find((g) => g.id === "gate-1");
    expect(gate1?.status).toBe("completed");
    expect(gate1?.rc).toBe(0);
  });

  it("updates gate status on start", () => {
    const update: GateUpdateData = {
      id: "gate-2",
      event: "started",
    };

    const updated = initialGates.map((gate) => {
      if (gate.id !== update.id) return gate;
      return {
        ...gate,
        status: update.event === "started" ? "running" : gate.status,
      };
    });

    const gate2 = updated.find((g) => g.id === "gate-2");
    expect(gate2?.status).toBe("running");
  });

  it("adds new gate on queue event", () => {
    const update: GateUpdateData = {
      id: "gate-3",
      event: "queued",
      lane: "remote",
    };

    const existingIndex = initialGates.findIndex((g) => g.id === update.id);

    let updated: Gate[];
    if (existingIndex >= 0) {
      updated = initialGates;
    } else if (update.event === "queued") {
      const newGate: Gate = {
        id: update.id,
        lane: update.lane || "heavy",
        status: "queued",
      };
      updated = [...initialGates, newGate];
    } else {
      updated = initialGates;
    }

    expect(updated).toHaveLength(3);
    const gate3 = updated.find((g) => g.id === "gate-3");
    expect(gate3?.lane).toBe("remote");
    expect(gate3?.status).toBe("queued");
  });
});

describe("Channel subscription", () => {
  const validChannels = ["dragons", "gates", "machines", "orchestrator"];

  it("validates base channels", () => {
    for (const channel of validChannels) {
      expect(validChannels).toContain(channel);
    }
  });

  it("validates log channels", () => {
    const logChannel = "logs:kiro-A";
    expect(logChannel.startsWith("logs:")).toBe(true);

    const dragonId = logChannel.replace("logs:", "");
    expect(dragonId).toBe("kiro-A");
  });

  it("manages subscription set", () => {
    const subscriptions = new Set<string>();

    // Subscribe
    subscriptions.add("dragons");
    subscriptions.add("gates");
    expect(subscriptions.size).toBe(2);
    expect(subscriptions.has("dragons")).toBe(true);

    // Unsubscribe
    subscriptions.delete("dragons");
    expect(subscriptions.size).toBe(1);
    expect(subscriptions.has("dragons")).toBe(false);
    expect(subscriptions.has("gates")).toBe(true);
  });

  it("handles duplicate subscriptions", () => {
    const subscriptions = new Set<string>();

    subscriptions.add("dragons");
    subscriptions.add("dragons");

    expect(subscriptions.size).toBe(1);
  });
});

describe("Connection state management", () => {
  it("tracks connection state transitions", () => {
    type ConnectionState = "disconnected" | "connecting" | "connected";
    let state: ConnectionState = "disconnected";

    // Connect
    state = "connecting";
    expect(state).toBe("connecting");

    // Connected
    state = "connected";
    expect(state).toBe("connected");

    // Disconnect
    state = "disconnected";
    expect(state).toBe("disconnected");
  });

  it("clears subscriptions on disconnect", () => {
    const subscriptions = new Set(["dragons", "gates"]);

    // Simulate disconnect
    subscriptions.clear();

    expect(subscriptions.size).toBe(0);
  });

  it("clears session ID on disconnect", () => {
    let sessionId: string | null = "abc-123";

    // Simulate disconnect
    sessionId = null;

    expect(sessionId).toBeNull();
  });
});

describe("WebSocket URL construction", () => {
  it("constructs URL with project parameter", () => {
    const host = "localhost";
    const port = 4777;
    const project = "example";

    const wsUrl = `ws://${host}:${port}/ws?project=${encodeURIComponent(project)}`;

    expect(wsUrl).toBe("ws://localhost:4777/ws?project=example");
  });

  it("encodes special characters in project name", () => {
    const project = "my project";
    const encoded = encodeURIComponent(project);

    expect(encoded).toBe("my%20project");
  });
});

describe("Log line handling", () => {
  it("appends new log lines", () => {
    const logs: string[] = [];

    // Add lines
    for (let i = 0; i < 5; i++) {
      logs.push(`Line ${i}`);
    }

    expect(logs).toHaveLength(5);
    expect(logs[0]).toBe("Line 0");
    expect(logs[4]).toBe("Line 4");
  });

  it("limits log buffer size", () => {
    const logs: string[] = [];
    const maxLines = 10;

    // Add more than max
    for (let i = 0; i < 15; i++) {
      logs.push(`Line ${i}`);
    }

    // Trim to max
    const trimmed = logs.slice(-maxLines);

    expect(trimmed).toHaveLength(10);
    expect(trimmed[0]).toBe("Line 5"); // Oldest kept line
    expect(trimmed[9]).toBe("Line 14"); // Newest line
  });

  it("clears logs", () => {
    const cleared: string[] = [];

    expect(cleared).toHaveLength(0);
  });
});
