/**
 * WebSocket handshake security: a web page in the user's browser must not be
 * able to open /ws (live logs) or /ws/node (job dispatch), and remote nodes
 * need LAIR_NODE_TOKEN.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server } from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { LairWebSocketServer } from "./websocket.js";
import { NodeManager } from "./nodes/node-manager.js";
import {
  allowedOrigins,
  isAllowedNodePeer,
  isAllowedOrigin,
  isLoopbackAddress,
} from "./origin.js";

let server: Server;
let port: number;
let dashboard: LairWebSocketServer;
let nodes: NodeManager;

beforeAll(async () => {
  server = createServer();
  // Same order as src/server/index.ts: /ws first, then /ws/node
  dashboard = new LairWebSocketServer(server);
  nodes = new NodeManager(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  dashboard.close();
  nodes.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Try a handshake; resolve "open" or the HTTP status the server answered with. */
function handshake(path: string, origin?: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
    ws.on("open", () => {
      resolve("open");
      ws.close();
    });
    ws.on("unexpected-response", (_req, res) => {
      resolve(String(res.statusCode));
      ws.terminate();
    });
    ws.on("error", () => resolve("error"));
  });
}

describe("/ws (dashboard feed)", () => {
  it("refuses a foreign browser origin", async () => {
    expect(await handshake("/ws?project=example", "http://evil.example")).toBe("401");
  });

  it("refuses the opaque 'null' origin", async () => {
    expect(await handshake("/ws", "null")).toBe("401");
  });

  it("accepts the dashboard origins", async () => {
    expect(await handshake("/ws", "http://localhost:5173")).toBe("open");
    expect(await handshake("/ws", "http://127.0.0.1:4777")).toBe("open");
  });

  it("accepts non-browser clients (no Origin)", async () => {
    expect(await handshake("/ws")).toBe("open");
  });
});

describe("/ws/node (node control channel)", () => {
  it("accepts a local node even though /ws is attached to the same server", async () => {
    expect(await handshake("/ws/node")).toBe("open");
  });

  it("refuses a foreign browser origin", async () => {
    expect(await handshake("/ws/node", "http://evil.example")).toBe("401");
  });

  it("answers unknown WebSocket paths with 404", async () => {
    expect(await handshake("/ws/other")).toBe("404");
  });
});

describe("origin helpers", () => {
  it("allows only loopback dashboard origins by default", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:4777")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(false);
    expect(isAllowedOrigin("http://localhost.evil.example:5173")).toBe(false);
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("not a url")).toBe(false);
  });

  it("adds LAIR_HOST, but not a wildcard bind address", () => {
    expect(isAllowedOrigin("http://lair.lan:5173", { LAIR_HOST: "lair.lan" })).toBe(true);
    expect([...allowedOrigins({ LAIR_HOST: "0.0.0.0" })].some((o) => o.includes("0.0.0.0"))).toBe(
      false,
    );
  });

  it("recognises loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("192.0.2.10")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  function peer(remoteAddress: string, headers: Record<string, string> = {}, url = "/ws/node") {
    return { socket: { remoteAddress }, headers, url } as unknown as IncomingMessage;
  }

  it("refuses remote nodes unless LAIR_NODE_TOKEN is set and presented", () => {
    expect(isAllowedNodePeer(peer("127.0.0.1"), {})).toBe(true);
    expect(isAllowedNodePeer(peer("192.0.2.10"), {})).toBe(false);

    const env = { LAIR_NODE_TOKEN: "s3cret-token" };
    expect(isAllowedNodePeer(peer("192.0.2.10"), env)).toBe(false);
    expect(
      isAllowedNodePeer(peer("192.0.2.10", { authorization: "Bearer wrong" }), env),
    ).toBe(false);
    expect(
      isAllowedNodePeer(peer("192.0.2.10", { authorization: "Bearer s3cret-token" }), env),
    ).toBe(true);
    expect(
      isAllowedNodePeer(peer("192.0.2.10", {}, "/ws/node?token=s3cret-token"), env),
    ).toBe(true);
  });
});
