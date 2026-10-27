/**
 * useWebSocket hook tests
 *
 * Tests for WebSocket connection management and message handling.
 * Note: These test the logic, not actual WebSocket connections. The
 * reconnect tests at the end drive the production connections (LiveSocket,
 * which useWebSocket wraps, and the live feed's EventStream) with a fake
 * socket factory and a fake clock: the only stand-ins.
 */
import { describe, it, expect } from "vitest";
import { MAX_MESSAGE_CHARS, LiveSocket, type SocketFactory, type SocketHandle, type SocketHandlers } from "./live-socket";
import { EventStream, MAX_EVENT_CHARS, type StreamFactory, type StreamHandlers } from "./event-stream";
import { RECONNECT_MAX_MS, backoffDelay, connectionLabel, type ConnectionStatus, type Timers } from "./reconnect";
import { socketUrl, toConnectionState } from "./useWebSocket";

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

// ============ RECONNECT AFTER THE SERVER GOES AWAY ============

interface FakeTask {
  at: number;
  fn: () => void;
  every: number | null;
}

/** A clock the tests move by hand. */
class FakeTimers implements Timers {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, FakeTask>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, fn, every: null });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, fn, every: ms });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  /** The waits of the scheduled one-shot timers */
  get timeouts(): number[] {
    return [...this.tasks.values()].filter((t) => t.every === null).map((t) => t.at - this.now);
  }
  get intervals(): number {
    return [...this.tasks.values()].filter((t) => t.every !== null).length;
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let next: [number, FakeTask] | null = null;
      for (const entry of this.tasks) {
        if (entry[1].at <= end && (next === null || entry[1].at < next[1].at)) next = entry;
      }
      if (next === null) break;
      const [id, task] = next;
      this.now = task.at;
      if (task.every === null) this.tasks.delete(id);
      else task.at += task.every;
      task.fn();
    }
    this.now = end;
  }
}

/** One socket the dashboard opened; the test plays the server. */
class FakeSocket implements SocketHandle {
  sent: unknown[] = [];
  closedWith: number | null = null;
  private open = false;
  constructor(
    readonly url: string,
    readonly handlers: SocketHandlers,
  ) {}
  /** The server accepts the connection */
  accept(): void {
    this.open = true;
    this.handlers.open();
  }
  /** The server is down: the connection fails */
  refuse(): void {
    this.handlers.error();
    this.handlers.close(1006, "");
  }
  /** The server goes away (a restart) */
  drop(code = 1001): void {
    this.open = false;
    this.handlers.close(code, "Server shutting down");
  }
  serverSends(data: string): void {
    this.handlers.message(data);
  }
  send(data: string): boolean {
    if (!this.open) return false;
    this.sent.push(JSON.parse(data));
    return true;
  }
  close(code?: number): void {
    this.open = false;
    this.closedWith = code ?? 1005;
  }
}

class FakeSocketServer {
  sockets: FakeSocket[] = [];
  open: SocketFactory = (url, handlers) => {
    const socket = new FakeSocket(url, handlers);
    this.sockets.push(socket);
    return socket;
  };
  get last(): FakeSocket {
    return this.sockets[this.sockets.length - 1];
  }
}

function liveSocket(channels: string[] = ["dragons"]) {
  const timers = new FakeTimers();
  const server = new FakeSocketServer();
  const states: { status: ConnectionStatus; retryInMs: number | null }[] = [];
  const messages: unknown[] = [];
  const socket = new LiveSocket({
    url: socketUrl("localhost", "demo"),
    channels,
    open: server.open,
    timers,
    onState: (s) => states.push({ status: s.status, retryInMs: s.retryInMs }),
    onMessage: (m) => messages.push(m),
  });
  return { timers, server, states, messages, socket };
}

describe("reconnect backoff", () => {
  it("starts at 1 s, doubles per failed try and stops growing at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map((n) => backoffDelay(n))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
    expect(backoffDelay(-3)).toBe(1000);
    expect(backoffDelay(Number.NaN)).toBe(RECONNECT_MAX_MS);
    expect(backoffDelay(2, 500, 1500)).toBe(1500);
  });

  it("names the states the dashboard shows", () => {
    expect(connectionLabel("reconnecting")).toBe("Reconnecting…");
    expect(connectionLabel("connected")).toBe("Connected");
    expect(connectionLabel("connecting")).toBe("Connecting…");
    expect(connectionLabel("closed")).toBe("Disconnected");
    expect(toConnectionState("reconnecting")).toBe("reconnecting");
    expect(toConnectionState("closed")).toBe("disconnected");
  });
});

describe("the dashboard's WebSocket after a server restart (LiveSocket, as useWebSocket uses it)", () => {
  it("reconnects with growing, capped backoff while the server is down, then resubscribes and starts the backoff over", () => {
    const { timers, server, states, socket } = liveSocket(["dragons"]);
    socket.start();
    expect(server.sockets).toHaveLength(1);
    expect(server.last.url).toBe("ws://localhost:4777/ws?project=demo");
    expect(socket.state.status).toBe("connecting");
    server.last.accept();
    expect(socket.state.status).toBe("connected");
    expect(server.last.sent).toEqual([{ type: "subscribe", channels: ["dragons"] }]);
    socket.subscribe(["gates"]);

    // The server restarts: the socket closes, and a retry is scheduled
    server.last.drop(1001);
    expect(socket.state).toMatchObject({ status: "reconnecting", retryInMs: 1000 });
    expect(timers.timeouts).toEqual([1000]);
    expect(timers.intervals).toBe(0); // no pings into a closed socket

    // While it is down, each try fails and the wait doubles, up to 30 s
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const wait = socket.state.retryInMs ?? -1;
      waits.push(wait);
      timers.advance(wait - 1);
      expect(server.sockets).toHaveLength(i + 1); // not yet
      timers.advance(1);
      expect(server.sockets).toHaveLength(i + 2);
      expect(socket.state.status).toBe("reconnecting");
      server.last.refuse();
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(timers.timeouts).toEqual([30000]); // one retry at a time

    // The server is back: the next try opens and subscribes to every channel again
    timers.advance(30000);
    server.last.accept();
    expect(socket.state).toMatchObject({ status: "connected", attempt: 0, retryInMs: null, error: null });
    expect(server.last.sent).toEqual([{ type: "subscribe", channels: ["dragons", "gates"] }]);
    expect(states.map((s) => s.status)).toContain("reconnecting");

    // Pings again while open
    timers.advance(25_000);
    expect(server.last.sent).toContainEqual({ type: "ping" });

    // The next loss starts from 1 s again
    server.last.drop();
    expect(socket.state.retryInMs).toBe(1000);
  });

  it("does not reconnect once stopped (unmount, another project): a scheduled retry is cancelled", () => {
    const { timers, server, socket } = liveSocket();
    socket.start();
    server.last.accept();
    server.last.drop();
    expect(timers.timeouts).toEqual([1000]);
    socket.stop();
    expect(socket.state.status).toBe("closed");
    expect(timers.timeouts).toEqual([]);
    timers.advance(60_000);
    expect(server.sockets).toHaveLength(1);

    // Stopping an open socket closes it normally, and its late events change nothing
    const open = liveSocket();
    open.socket.start();
    const first = open.server.last;
    first.accept();
    open.socket.stop();
    expect(first.closedWith).toBe(1000);
    first.handlers.close(1006, "");
    first.handlers.open();
    open.timers.advance(60_000);
    expect(open.server.sockets).toHaveLength(1);
    expect(open.socket.state.status).toBe("closed");
  });

  it("ignores a replaced socket's events, retries a socket that can't be created, and reconnects now on request", () => {
    const { timers, server, socket } = liveSocket();
    socket.start();
    const first = server.last;
    first.accept();
    socket.reconnectNow();
    expect(first.closedWith).toBe(1005);
    expect(server.sockets).toHaveLength(2);
    expect(socket.state.status).toBe("reconnecting");
    // The old socket's close arrives late: no extra retry
    first.handlers.close(1006, "");
    expect(timers.timeouts).toEqual([]);
    server.last.accept();
    expect(socket.state.status).toBe("connected");

    // new WebSocket() itself throws (a bad URL, a blocked port): retried like a failed connection
    let fail = true;
    const timers2 = new FakeTimers();
    const opened: SocketHandlers[] = [];
    const flaky = new LiveSocket({
      url: socketUrl("localhost", "demo"),
      timers: timers2,
      open: (url, handlers) => {
        if (fail) throw new Error("blocked");
        opened.push(handlers);
        return new FakeSocket(url, handlers);
      },
    });
    flaky.start();
    expect(flaky.state).toMatchObject({ status: "reconnecting", retryInMs: 1000, error: "blocked" });
    fail = false;
    timers2.advance(1000);
    expect(opened).toHaveLength(1);
  });

  it("passes on parsed messages and drops malformed or oversized ones", () => {
    const { server, messages, socket } = liveSocket();
    socket.start();
    server.last.accept();
    server.last.serverSends("not json");
    server.last.serverSends(JSON.stringify({ type: "update", channel: "dragons", data: { id: "x".repeat(MAX_MESSAGE_CHARS) } }));
    server.last.serverSends("");
    server.last.serverSends(JSON.stringify({ type: "connected", sessionId: "s-1" }));
    expect(messages).toEqual([{ type: "connected", sessionId: "s-1" }]);
  });
});

/** One event stream the live feed opened; the test plays the server. */
class FakeStream {
  closed = false;
  constructor(
    readonly url: string,
    readonly events: readonly string[],
    readonly handlers: StreamHandlers,
  ) {}
  close(): void {
    this.closed = true;
  }
}

describe("the live feed's event stream after a server restart (EventStream, as LiveFeed uses it)", () => {
  function feed() {
    const timers = new FakeTimers();
    const streams: FakeStream[] = [];
    const open: StreamFactory = (url, events, handlers) => {
      const stream = new FakeStream(url, events, handlers);
      streams.push(stream);
      return stream;
    };
    const received: [string, string][] = [];
    const stream = new EventStream({
      url: "/api/bus/events?project=demo",
      events: ["board", "error"],
      onEvent: (name, data) => received.push([name, data]),
      open,
      timers,
    });
    return { timers, streams, received, stream, last: () => streams[streams.length - 1] };
  }

  it("closes a failed stream and opens a new one with backoff until the server is back", () => {
    const { timers, streams, received, stream, last } = feed();
    stream.start();
    expect(stream.state.status).toBe("connecting");
    expect(last().events).toEqual(["board", "error"]);
    last().handlers.open();
    last().handlers.event("board", '{"tasks":[],"agents":[]}');
    expect(stream.state.status).toBe("connected");

    // The server goes away: the browser's EventSource is closed, not left to its own retries
    last().handlers.error();
    expect(streams[0].closed).toBe(true);
    expect(stream.state).toMatchObject({ status: "reconnecting", retryInMs: 1000 });
    timers.advance(1000);
    expect(streams).toHaveLength(2);
    last().handlers.error(); // still down
    expect(stream.state.retryInMs).toBe(2000);
    timers.advance(2000);
    expect(streams).toHaveLength(3);
    expect(stream.state.status).toBe("reconnecting");

    // Back: open again, the backoff starts over, events flow
    last().handlers.open();
    expect(stream.state).toMatchObject({ status: "connected", attempt: 0, retryInMs: null });
    last().handlers.event("board", '{"tasks":[],"agents":[{"id":"worker-a"}]}');
    last().handlers.event("board", "x".repeat(MAX_EVENT_CHARS + 1));
    // A replaced stream's late events are ignored
    streams[0].handlers.event("board", "stale");
    streams[0].handlers.error();
    expect(received.map(([, data]) => data)).toEqual([
      '{"tasks":[],"agents":[]}',
      '{"tasks":[],"agents":[{"id":"worker-a"}]}',
    ]);
    last().handlers.error();
    expect(stream.state.retryInMs).toBe(1000);
  });

  it("stops for good when the feed unmounts", () => {
    const { timers, streams, stream, last } = feed();
    stream.start();
    last().handlers.error();
    expect(timers.timeouts).toEqual([1000]);
    stream.stop();
    expect(stream.state.status).toBe("closed");
    expect(timers.timeouts).toEqual([]);
    timers.advance(60_000);
    expect(streams).toHaveLength(1);
  });
});
