/**
 * Static client serving tests
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readlinkSync, realpathSync, writeFileSync, rmSync } from "fs";
import { connect, type AddressInfo } from "net";
import { join } from "path";
import { tmpdir } from "os";
import { registerClientStatic } from "./static.js";

describe("registerClientStatic", () => {
  let dir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lair-static-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Lair</title>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log('app');");

    app = Fastify();
    app.get("/api/health", async () => ({ ok: true }));
    const registered = await registerClientStatic(app, dir);
    expect(registered).toBe(true);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves index.html at the root", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Lair</title>");
  });

  it("serves built assets", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log");
  });

  it("falls back to index.html for client-side routes", async () => {
    const res = await app.inject({ method: "GET", url: "/gates?project=x" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<title>Lair</title>");
  });

  it("keeps API routes working", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("returns JSON 404 for unknown API and WebSocket paths", async () => {
    for (const url of ["/api/does-not-exist", "/ws", "/ws/node"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.json().success).toBe(false);
    }
  });

  it("does not fall back for non-GET requests", async () => {
    const res = await app.inject({ method: "POST", url: "/gates" });
    expect(res.statusCode).toBe(404);
  });
});

describe("registerClientStatic without a build", () => {
  it("registers nothing when index.html is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-static-empty-"));
    const app = Fastify();
    try {
      expect(await registerClientStatic(app, dir)).toBe(false);
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Linux: the descriptors open on a path under `root` */
function descriptorsUnder(root: string): string[] {
  const real = realpathSync(root);
  const open: string[] = [];
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      const target = readlinkSync(join("/proc/self/fd", fd));
      if (target.startsWith(real)) open.push(target);
    } catch {
      // Closed meanwhile
    }
  }
  return open;
}

/** Send a GET and leave before the reply, as a reload or a closed tab does. */
function requestAndLeave(port: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 30);
    });
    socket.on("error", reject);
  });
}

describe("registerClientStatic when clients leave early", () => {
  it.skipIf(!existsSync("/proc/self/fd"))(
    "closes the file of every request whose client left before the reply",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "lair-static-left-"));
      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "index.html"), "<!doctype html><title>Lair</title>");
      // Larger than a read stream's buffer, so it can't be read in one go
      writeFileSync(join(dir, "assets", "app.js"), "x".repeat(512 * 1024));
      const app = Fastify();
      // A busy server: each reply starts after its client is gone
      app.addHook("onRequest", async () => {
        await sleep(200);
      });
      expect(await registerClientStatic(app, dir)).toBe(true);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = app.server.address() as AddressInfo;
      try {
        for (const url of ["/assets/app.js", "/gates?project=x", "/"]) {
          for (let i = 0; i < 3; i++) await requestAndLeave(port, url);
        }
        // Every reply ran (and found its client gone)
        await sleep(1000);
        const until = Date.now() + 5000;
        while (descriptorsUnder(dir).length > 0 && Date.now() < until) await sleep(50);
        expect(descriptorsUnder(dir)).toEqual([]);

        // A client that waits still gets the whole file
        const res = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
        expect((await res.text()).length).toBe(512 * 1024);
      } finally {
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
