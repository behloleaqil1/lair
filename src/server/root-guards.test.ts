/**
 * Root guards (cross-site and Host checks, ?project= and :id validation)
 * together with the static UI and its SPA fallback, wired as in index.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerRootGuards, requireValidIdParam } from "./root-guards.js";
import { registerClientStatic } from "./static.js";
import { isSafeGateId } from "./services/data.js";
import { isValidDragonId } from "./parsers/dragon-config.js";

const LOCAL = { host: "127.0.0.1:4777" };

describe("root guards with the static UI", () => {
  let dir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lair-guards-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Lair</title>");

    app = Fastify();
    registerRootGuards(app);
    app.get("/api/overview", async () => ({ success: true }));
    app.get(
      "/api/gates/:id/log",
      { preHandler: requireValidIdParam(isSafeGateId, "gate") },
      async () => ({ success: true }),
    );
    app.get(
      "/api/dragons/:id",
      { preHandler: requireValidIdParam(isValidDragonId, "dragon") },
      async () => ({ success: true }),
    );
    expect(await registerClientStatic(app, dir)).toBe(true);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the UI and client-side routes to a same-origin browser without an Origin header", async () => {
    for (const url of ["/", "/some/client/route", "/gates?project=anything"]) {
      const res = await app.inject({ method: "GET", url, headers: LOCAL });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("<title>Lair</title>");
    }
  });

  it("accepts the dashboard's own origins", async () => {
    for (const origin of ["http://127.0.0.1:4777", "http://localhost:5173"]) {
      const res = await app.inject({
        method: "GET",
        url: "/",
        headers: { ...LOCAL, origin },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("refuses cross-site requests and foreign Host headers with 403", async () => {
    const crossSite = await app.inject({
      method: "GET",
      url: "/",
      headers: { ...LOCAL, origin: "http://attacker.example" },
    });
    expect(crossSite.statusCode).toBe(403);

    const rebinding = await app.inject({
      method: "GET",
      url: "/api/overview",
      headers: { host: "attacker.example:4777" },
    });
    expect(rebinding.statusCode).toBe(403);
  });

  it("validates ?project= on API routes", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/overview?project=example", headers: LOCAL });
    expect(ok.statusCode).toBe(200);

    const missing = await app.inject({ method: "GET", url: "/api/overview", headers: LOCAL });
    expect(missing.statusCode).toBe(200);

    for (const project of ["..%2F..%2Fetc", "no-such-project"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/overview?project=${project}`,
        headers: LOCAL,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().success).toBe(false);
    }
  });

  it("refuses unsafe gate and dragon ids with 400", async () => {
    const goodGate = await app.inject({
      method: "GET",
      url: "/api/gates/20260101T000000Z-example-abcdef12-1/log",
      headers: LOCAL,
    });
    expect(goodGate.statusCode).toBe(200);

    const badGate = await app.inject({
      method: "GET",
      url: "/api/gates/..%2F..%2Fsecret/log",
      headers: LOCAL,
    });
    expect(badGate.statusCode).toBe(400);

    const goodDragon = await app.inject({ method: "GET", url: "/api/dragons/aider-1", headers: LOCAL });
    expect(goodDragon.statusCode).toBe(200);

    const badDragon = await app.inject({ method: "GET", url: "/api/dragons/.hidden", headers: LOCAL });
    expect(badDragon.statusCode).toBe(400);
  });
});
