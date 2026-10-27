/**
 * One decision per held service: Delivery as the server wires it
 * (useDecisions with the real Decision Inbox on a real store), with only the
 * system boundary fake (FakeDocker, FakeClock). Answers come in as the
 * owner's, through the inbox (its HTTP route's owner check is mount.test.ts's).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import { FakeClock, FakeDocker } from "./fake-docker.js";
import { DELIVERY_DECISION_MODULE, createDelivery, deliveryHoldKey, type Delivery } from "./service.js";
import { DeliveryStore } from "./store.js";
import type { OperationRequest } from "./environment.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");

const ENV = {
  compose_files: ["./deploy/compose.yaml"],
  project_name: "shop-local",
  services: { db: { health: { type: "container" } }, api: {}, web: {} },
  start_order: ["db", "api", "web"],
  start_timeout_seconds: 60,
};

const closers: (() => void)[] = [];
let dir: string | null = null;

afterEach(() => {
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {}
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function deliveryOn(store: DeliveryStore, docker: FakeDocker): Delivery {
  const config: ProjectConfig = {
    name: "Shop",
    repo: "/home/user/shop",
    github: "example/shop",
    queue_file: "/home/user/shop/work/queue.md",
    agents_dir: "/home/user/shop/work/agents",
    gates_dir: "/home/user/shop/work/gates",
    machines: {},
    read_only: false,
    delivery: { enabled: true, environments: { local: ENV } },
  };
  const delivery = createDelivery({ project: "shop", config, store, probes: { runner: docker, clock: new FakeClock(), http: docker.http } });
  closers.push(() => void delivery.stop());
  return delivery;
}

/** The inbox's clock, moved by the tests */
const clock = {
  t: NOW,
  now(): number {
    return this.t;
  },
};

function inboxOn(dbPath: string): DecisionInbox {
  const store = new DecisionStore(dbPath);
  closers.push(() => store.close());
  return new DecisionInbox({ store, secrets: new MemorySecretStore(), clock });
}

function setup() {
  clock.t = NOW;
  dir = mkdtempSync(join(tmpdir(), "lair-delivery-holds-"));
  const deliveryDb = join(dir, "delivery.db");
  const decisionsDb = join(dir, "decisions.db");
  const store = new DeliveryStore(deliveryDb);
  closers.push(() => store.close());
  const docker = new FakeDocker("shop-local", { db: { healthcheck: true }, api: {}, web: {} });
  docker.running("db", "api", "web");
  return { deliveryDb, decisionsDb, store, docker, delivery: deliveryOn(store, docker), inbox: inboxOn(decisionsDb) };
}

/** An operation, finished, and the holds' decisions settled. */
async function run(delivery: Delivery, request: OperationRequest): Promise<void> {
  const env = delivery.environment("local")!;
  const result = env.request(request);
  if (!result.ok) throw new Error(`refused (${result.code}): ${result.error}`);
  await env.idle();
  await delivery.reconcileHolds();
}

const open = (inbox: DecisionInbox) => inbox.list({ project: "shop", status: "open" });

describe("held services: one decision per hold", () => {
  it("a Down asks the owner, in plain words, once: not again on later checks or after a restart", async () => {
    const h = setup();
    await h.delivery.useDecisions(h.inbox);
    await run(h.delivery, { kind: "down", service: "api", by: "human", reason: "profiling a leak" });

    const [asked, ...more] = open(h.inbox);
    expect(more).toEqual([]);
    const hold = h.store.getHold("shop", "local", "api")!;
    expect(asked).toMatchObject({
      attention: "action",
      key: deliveryHoldKey(hold),
      source: { module: DELIVERY_DECISION_MODULE, ref: "local/api" },
      title: "api in local is stopped and held: Up and deploys skip it until you release it",
    });
    expect(asked.options.map((o) => [o.id, o.label])).toEqual([
      ["release", "Release it"],
      ["keep", "Keep it held"],
    ]);
    expect(asked.context).toContain("profiling a leak");
    await h.delivery.reconcileHolds();
    expect(open(h.inbox)).toHaveLength(1);

    // Lair restarts: the same stores, a new Delivery and inbox
    await h.delivery.stop();
    const again = deliveryOn(h.store, h.docker);
    const inbox = inboxOn(h.decisionsDb);
    await again.useDecisions(inbox);
    await again.reconcileHolds();
    expect(open(inbox).map((d) => d.id)).toEqual([asked.id]);
  });

  it("answering 'Release it' releases the service as the owner's Release does; 'Keep it held' asks nothing more", async () => {
    const h = setup();
    await h.delivery.useDecisions(h.inbox);
    await run(h.delivery, { kind: "down", service: "api", by: "human", reason: "profiling" });
    await run(h.delivery, { kind: "down", service: "web", by: "human", reason: "redesign" });
    const byService = (name: string) => open(h.inbox).find((d) => d.source.ref === `local/${name}`)!;

    await h.inbox.answer(byService("api").id, { optionId: "release" });
    await h.delivery.reconcileHolds();
    expect(h.store.getHold("shop", "local", "api")).toBeNull();
    expect(h.store.listOperations("shop", { limit: 1 })[0]).toMatchObject({ kind: "release", requestedBy: "human" });

    const keep = byService("web");
    await h.inbox.answer(keep.id, { optionId: "keep" });
    await h.delivery.reconcileHolds();
    expect(open(h.inbox)).toEqual([]);
    expect(h.store.getHold("shop", "local", "web")).not.toBeNull();
  });

  it("a service released another way withdraws its decision: its Release, or the environment Up of an environment Down", async () => {
    const h = setup();
    await h.delivery.useDecisions(h.inbox);
    await run(h.delivery, { kind: "down", service: "db", by: "human", reason: "maintenance" });
    await run(h.delivery, { kind: "down", by: "human", reason: "end of day" });
    expect(open(h.inbox).map((d) => d.source.ref).sort()).toEqual(["local/api", "local/db", "local/web"]);

    // The environment Up releases the environment Down's holds; db's own hold outlives it
    await run(h.delivery, { kind: "up", by: "human" });
    expect(open(h.inbox).map((d) => d.source.ref)).toEqual(["local/db"]);
    const withdrawn = h.inbox.list({ project: "shop", status: "withdrawn" });
    expect(withdrawn.map((d) => d.withdrawnReason)).toEqual(["The service was released.", "The service was released."]);

    await run(h.delivery, { kind: "release", service: "db", by: "human" });
    expect(open(h.inbox)).toEqual([]);
  });

  it("an HTTP caller can't release a held service or stand in for its decision: its default never applies", async () => {
    const h = setup();
    await run(h.delivery, { kind: "down", service: "api", by: "human", reason: "profiling" });
    const hold = h.store.getHold("shop", "local", "api")!;
    // Before delivery follows its answers, a local process raises a decision under its name and key, defaulting to "release"
    const forgery = (key: string) => ({
      project: "shop",
      kind: "other" as const,
      title: "api in local is held",
      context: "Forged.",
      options: [{ id: "release", label: "Release it", consequences: "Released." }],
      recommended: { optionId: "release", reasoning: "r" },
      source: { module: DELIVERY_DECISION_MODULE, ref: "local/api" },
      key,
      expiresAt: new Date(clock.t + 1000).toISOString(),
      defaultOptionId: "release",
    });
    const forged = await h.inbox.raiseFromHttp(forgery(deliveryHoldKey(hold)));

    await h.delivery.useDecisions(h.inbox);
    const real = open(h.inbox).filter((d) => d.raisedVia === "server");
    expect(real.map((d) => d.key)).toEqual([deliveryHoldKey(hold)]);

    clock.t = NOW + 5000;
    await h.inbox.sweep();
    await h.delivery.reconcileHolds();
    expect(h.inbox.get(forged.decision.id)).toMatchObject({ status: "expired" });
    expect(h.store.getHold("shop", "local", "api")).not.toBeNull();
    expect(open(h.inbox).map((d) => d.id)).toEqual([real[0].id]);
    await expect(h.inbox.raiseFromHttp(forgery("hold:local:web:x"))).rejects.toMatchObject({ statusCode: 403 });
  });
});
