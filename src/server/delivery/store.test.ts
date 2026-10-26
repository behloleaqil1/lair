/**
 * The delivery store's schema upgrades: a database written by an older Lair
 * opens, keeps its data, gains what the current code reads, and ticks work.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { FakeClock, FakeDocker } from "./fake-docker.js";
import { createDelivery } from "./service.js";
import { DeliveryStore, SCHEMA_VERSION } from "./store.js";

/** The schema of version 1, exactly as the first release of delivery created it */
const V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS delivery_holds (
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,
    held_at TEXT NOT NULL,
    PRIMARY KEY (project, environment, service)
  );

  CREATE TABLE IF NOT EXISTS delivery_crash_loops (
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    container TEXT NOT NULL,
    restarts INTEGER NOT NULL,
    max_restarts INTEGER NOT NULL,
    window_minutes REAL NOT NULL,
    since TEXT NOT NULL,
    evidence TEXT NOT NULL,
    error_lines TEXT NOT NULL,
    PRIMARY KEY (project, environment, service)
  );

  CREATE TABLE IF NOT EXISTS delivery_restart_samples (
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    at INTEGER NOT NULL,
    restart_count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_samples
    ON delivery_restart_samples(project, environment, service, at);

  CREATE TABLE IF NOT EXISTS delivery_operations (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    kind TEXT NOT NULL,
    services TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    reason TEXT,
    sha TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    steps TEXT NOT NULL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_operations
    ON delivery_operations(project, environment, started_at);

  CREATE TABLE IF NOT EXISTS delivery_refs (
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    sha TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (project, environment)
  );
`;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-delivery-store-"));
  dirs.push(dir);
  return join(dir, "delivery.db");
}

function version(path: string): number {
  const db = new Database(path);
  const v = db.pragma("user_version", { simple: true }) as number;
  db.close();
  return v;
}

const config: ProjectConfig = {
  name: "Shop",
  repo: "/home/user/shop",
  github: "example/shop",
  queue_file: "/home/user/shop/work/queue.md",
  agents_dir: "/home/user/shop/work/agents",
  gates_dir: "/home/user/shop/work/gates",
  machines: {},
  delivery: {
    enabled: true,
    environments: {
      local: {
        compose_files: ["./deploy/compose.yaml"],
        project_name: "shop-local",
        services: { db: null, api: { build: true, paths: ["api/"] } },
        deploy: { auto: true },
      },
    },
  },
};

describe("DeliveryStore schema", () => {
  it("upgrades a version 1 database: keeps its data, adds what is new, and ticks work", async () => {
    const path = dbPath();
    const old = new Database(path);
    old.exec(V1_SCHEMA);
    old.pragma("user_version = 1");
    old
      .prepare(
        `INSERT INTO delivery_operations (id, project, environment, kind, services, requested_by, status, started_at, steps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("00000000-0000-4000-8000-000000000001", "shop", "local", "deploy", '["api"]', "auto", "running", "2026-03-01T10:00:00.000Z", "[]");
    old
      .prepare(`INSERT INTO delivery_holds (project, environment, service, reason, source, held_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("shop", "local", "db", "kept across the upgrade", "service", "2026-03-01T09:00:00.000Z");
    old.close();

    const store = new DeliveryStore(path);
    expect(store.getHold("shop", "local", "db")).toMatchObject({ reason: "kept across the upgrade" });
    expect(store.getOperation("00000000-0000-4000-8000-000000000001")).toMatchObject({ kind: "deploy", recoveredBy: undefined });
    expect(store.serviceShas("shop", "local", "api")).toEqual({ deployedSha: null, targetSha: null });
    expect(store.containerNames("shop", "local", "db")).toEqual([]);

    // A tick reads every new column and table: the interrupted deploy, the commits, the container names
    const docker = new FakeDocker("shop-local", { db: {}, api: {} });
    docker.running("db", "api");
    const delivery = createDelivery({ project: "shop", config, store, probes: { runner: docker, clock: new FakeClock(), http: docker.http } });
    await delivery.tick();
    await delivery.idle();
    expect(delivery.lastError).toBeUndefined();
    expect(store.getOperation("00000000-0000-4000-8000-000000000001")).toMatchObject({
      status: "interrupted",
      recoveredBy: "nothing to recover",
    });
    expect(store.containerNames("shop", "local", "api")).toEqual(["shop-local-api-1"]);
    expect(store.serviceShas("shop", "local", "api").deployedSha).toBe("1".repeat(40));
    store.close();
    expect(version(path)).toBe(SCHEMA_VERSION);

    // Opening it again runs nothing twice
    const reopened = new DeliveryStore(path);
    expect(reopened.getHold("shop", "local", "db")).not.toBeNull();
    reopened.close();
  });

  it("creates a new database at the current version, and opens it again", () => {
    const path = dbPath();
    new DeliveryStore(path).close();
    expect(version(path)).toBe(SCHEMA_VERSION);
    const again = new DeliveryStore(path);
    again.markRecovered("none", "x");
    again.close();
  });
});
