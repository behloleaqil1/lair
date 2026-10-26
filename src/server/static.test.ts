/**
 * Static client serving tests
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
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
