/**
 * The watchdog's HTTP routes: read-only, validated queries, and no clash with
 * GET /api/health.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { WatchdogManager } from "./service.js";
import { registerWatchdogRoutes } from "./routes.js";
import { NodeFileSystem, type CommandOutput } from "./probes.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");

let app: FastifyInstance | null = null;
let manager: WatchdogManager | null = null;
let dir: string | null = null;

afterEach(async () => {
  await app?.close();
  manager?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = null;
  manager = null;
  dir = null;
});

function project(name: string, watchdog: Record<string, unknown> | undefined): ProjectConfig {
  const root = join(dir!, name);
  mkdirSync(join(root, "agents"), { recursive: true });
  return {
    name,
    repo: root,
    github: "example/demo",
    queue_file: join(root, "queue.md"),
    agents_dir: join(root, "agents"),
    gates_dir: join(root, "gates"),
    machines: {},
    inbox_file: join(root, "inbox.md"),
    dragons: { "worker-b": { name: "B", model: "m", machine: "local", instructions: "" } },
    watchdog,
  };
}

async function build(): Promise<{ app: FastifyInstance; manager: WatchdogManager }> {
  dir = mkdtempSync(join(tmpdir(), "lair-watchdog-routes-"));
  manager = new WatchdogManager({
    dbPath: ":memory:",
    probes: {
      processes: { list: async () => [] },
      fs: new NodeFileSystem(),
      runner: { run: async (): Promise<CommandOutput> => ({ code: 0, stdout: "", stderr: "" }) },
      clock: { now: () => NOW, sleep: async () => {} },
    },
  });
  const watched = project("watched", { enabled: true, agent_command: "agent-cli --agent {agent}" });
  const claim = join(watched.agents_dir, "worker-b.running");
  mkdirSync(claim);
  utimesSync(claim, new Date(NOW - 30 * 60000), new Date(NOW - 30 * 60000));
  manager.load([
    { name: "watched", config: watched },
    { name: "off", config: project("off", undefined) },
    { name: "broken", config: project("broken", { enabled: true, mode: "fix-everything" }) },
  ]);
  app = Fastify();
  await registerWatchdogRoutes(app, manager, () => "watched");
  await app.ready();
  return { app, manager };
}

describe("watchdog routes", () => {
  it("serves breaches, runs, escalations and SLO status after a tick", async () => {
    const { app, manager } = await build();
    await manager.get("watched")!.tick();

    const breaches = (await app.inject({ url: "/api/watchdog/breaches?project=watched" })).json();
    expect(breaches.success).toBe(true);
    expect(breaches.data).toHaveLength(1);
    expect(breaches.data[0]).toMatchObject({ detector: "orphan_claim", status: "open" });

    const open = await app.inject({ url: "/api/watchdog/breaches?status=resolved" });
    expect(open.json().data).toEqual([]);

    const runs = (await app.inject({ url: "/api/watchdog/runs?limit=5" })).json();
    expect(runs.data).toMatchObject([{ playbookId: "orphan_claim", mode: "observe" }]);

    const escalations = (await app.inject({ url: "/api/watchdog/escalations" })).json();
    expect(escalations.data).toHaveLength(1);

    const status = (await app.inject({ url: "/api/watchdog/status" })).json();
    expect(status.data).toMatchObject({ project: "watched", enabled: true, mode: "observe" });
    expect(status.data.actBlocked).toBe("watchdog.mode is observe");
    expect(status.data.slos).toHaveLength(9);
    expect(status.data.slos.find((s: { detector: string }) => s.detector === "orphan_claim")).toMatchObject({
      state: "breached",
      openBreaches: 1,
    });
  });

  it("reports a disabled project and a project with an invalid watchdog block", async () => {
    const { app } = await build();
    const off = (await app.inject({ url: "/api/watchdog/status?project=off" })).json();
    expect(off.data).toMatchObject({ enabled: false, errors: [], slos: [] });
    const broken = (await app.inject({ url: "/api/watchdog/status?project=broken" })).json();
    expect(broken.data.enabled).toBe(false);
    expect(broken.data.errors[0]).toContain("watchdog.mode");
  });

  it("refuses invalid query values with 400", async () => {
    const { app } = await build();
    expect((await app.inject({ url: "/api/watchdog/breaches?status=bogus" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/watchdog/runs?limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/watchdog/runs?limit=abc" })).statusCode).toBe(400);
  });

  it("registers only GET routes, and not GET /api/health", async () => {
    const { app } = await build();
    expect(app.hasRoute({ method: "GET", url: "/api/health" })).toBe(false);
    for (const url of ["/api/watchdog/status", "/api/watchdog/breaches", "/api/watchdog/runs"]) {
      expect(app.hasRoute({ method: "GET", url })).toBe(true);
      expect((await app.inject({ method: "POST", url })).statusCode).toBe(404);
    }
  });
});
