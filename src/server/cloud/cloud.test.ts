/**
 * Cloud machines, step 1 (docs/design/cloud-runners.md §2, §4, §11): the
 * AWS EC2 provider, the meter and the money guard, through the manager the
 * server wires (CloudManager), its live-reload module and its route. Only
 * the AWS SDK clients are fake (FakeAws: an EC2 client and a Cost Explorer
 * client that answer like AWS), with a fake clock and a real store in a
 * temp dir.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Fastify, { type FastifyInstance } from "fastify";
import {
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  type EC2Client,
} from "@aws-sdk/client-ec2";
import { GetCostAndUsageCommand, type CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import type { ProjectConfig } from "../../shared/types.js";
import type { CloudStatus } from "../../shared/cloud-types.js";
import { EventBus } from "../core/event-bus.js";
import { HumanAuth, OWNER_ONLY_PREFIXES, OWNER_SESSION_HEADER, isUnder } from "../human-auth/index.js";
import { serverModules } from "../reload/modules.js";
import { CloudManager, type CloudMachines } from "./service.js";
import { parseCloudConfig } from "./config.js";
import { registerCloudRoutes } from "./routes.js";
import { providerText, type AwsClients } from "./provider.js";

const PROJECT = "shop";
const INSTANCE = "i-0123456789abcdef0";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 10 March 2027, 12:00 UTC: the third month of a 2027 budget */
const NOW = Date.UTC(2027, 2, 10, 12, 0, 0);
/** A same-origin request from the dashboard */
const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

interface FakeInstance {
  state: string;
  launch: Date;
  reason: string;
  tags: Record<string, string>;
}

interface Sent {
  name: string;
  region?: string;
  input: any;
}

/** An EC2 and a Cost Explorer client that answer like AWS: the only fake in these tests. */
class FakeAws {
  instances = new Map<string, FakeInstance>();
  sent: Sent[] = [];
  profiles: string[] = [];
  describeError: Error | null = null;
  /** The cost of the period before credits and refunds, or an error to throw */
  cost: string | Error = "0";

  readonly clients = (profile: string, _timeoutMs: number): AwsClients => {
    this.profiles.push(profile);
    return {
      ec2: (region) => ({ send: async (command: unknown) => this.ec2(region, command) }) as unknown as Pick<EC2Client, "send">,
      costExplorer: () => ({ send: async (command: unknown) => this.costExplorer(command) }) as unknown as Pick<CostExplorerClient, "send">,
    };
  };

  named(name: string): Sent[] {
    return this.sent.filter((s) => s.name === name);
  }

  private async ec2(region: string, command: unknown): Promise<unknown> {
    if (command instanceof DescribeInstancesCommand) {
      this.sent.push({ name: "DescribeInstances", region, input: command.input });
      if (this.describeError) throw this.describeError;
      const filters = command.input.Filters ?? [];
      const found = (command.input.InstanceIds ?? []).flatMap((id) => {
        const i = this.instances.get(id);
        if (!i) return [];
        // EC2 applies the filters: an instance without the tag is not returned
        const tagged = filters.every((f) => (f.Values ?? []).includes(i.tags[(f.Name ?? "").replace(/^tag:/, "")]));
        if (!tagged) return [];
        return [
          {
            InstanceId: id,
            State: { Name: i.state },
            LaunchTime: i.launch,
            StateTransitionReason: i.reason,
            Tags: Object.entries(i.tags).map(([Key, Value]) => ({ Key, Value })),
          },
        ];
      });
      return { Reservations: found.length > 0 ? [{ Instances: found }] : [] };
    }
    if (command instanceof StartInstancesCommand) {
      this.sent.push({ name: "StartInstances", region, input: command.input });
      const id = (command.input.InstanceIds ?? [])[0];
      const i = this.instances.get(id);
      if (i) i.state = "pending";
      return { StartingInstances: [{ InstanceId: id, CurrentState: { Name: "pending" } }] };
    }
    if (command instanceof StopInstancesCommand) {
      this.sent.push({ name: "StopInstances", region, input: command.input });
      const id = (command.input.InstanceIds ?? [])[0];
      const i = this.instances.get(id);
      if (i) i.state = "stopping";
      return { StoppingInstances: [{ InstanceId: id, CurrentState: { Name: "stopping" } }] };
    }
    throw new Error(`unexpected EC2 command ${String(command)}`);
  }

  private async costExplorer(command: unknown): Promise<unknown> {
    if (!(command instanceof GetCostAndUsageCommand)) throw new Error("unexpected Cost Explorer command");
    this.sent.push({ name: "GetCostAndUsage", input: command.input });
    if (this.cost instanceof Error) throw this.cost;
    return { ResultsByTime: [{ Total: { UnblendedCost: { Amount: this.cost, Unit: "USD" } }, Estimated: true }] };
  }
}

function stopReason(ms: number): string {
  return `User initiated (${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} GMT)`;
}

function cloudBlock(budget: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    machines: {
      "cloud-1": {
        provider: "aws-ec2",
        region: "us-east-1",
        profile: "gates",
        instance: { id: INSTANCE, tag: { key: "role", value: "gate-server" } },
        price_per_hour: 0.5,
        storage_per_month: 6,
      },
    },
    budget: { limit: 100, period: { start: "2027-01-01", end: "2027-12-31" }, ...budget },
    ...extra,
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

class Harness {
  readonly aws = new FakeAws();
  readonly bus = new EventBus();
  readonly dir = mkdtempSync(join(tmpdir(), "lair-cloud-"));
  now = NOW;
  manager: CloudManager;

  constructor(cloud: Record<string, unknown> | undefined) {
    // Cleanups run last first: the stores close before their folder goes
    cleanups.push(() => rmSync(this.dir, { recursive: true, force: true }));
    this.manager = this.open(cloud);
  }

  /** A manager as src/server/index.ts makes one, on this harness's store file */
  open(cloud: Record<string, unknown> | undefined): CloudManager {
    const manager = new CloudManager({
      dbPath: join(this.dir, "cloud.db"),
      clients: this.aws.clients,
      clock: { now: () => this.now },
      events: this.bus,
    });
    manager.load([{ name: PROJECT, config: this.config(cloud) }]);
    cleanups.push(() => manager.stop());
    return manager;
  }

  config(cloud: Record<string, unknown> | undefined): ProjectConfig {
    return { name: PROJECT, repo: "/tmp/shop", ...(cloud ? { cloud } : {}) } as ProjectConfig;
  }

  /** Restart: the old manager stops and a new one opens the same store */
  async restart(cloud: Record<string, unknown>): Promise<void> {
    await this.manager.stop();
    this.manager = this.open(cloud);
  }

  get machines(): CloudMachines {
    const machines = this.manager.get(PROJECT);
    if (!machines) throw new Error("cloud is off for the project");
    return machines;
  }

  instance(state: string, launch: number, stop: number | null = null, tags: Record<string, string> = { role: "gate-server" }): void {
    this.aws.instances.set(INSTANCE, { state, launch: new Date(launch), reason: stop === null ? "" : stopReason(stop), tags });
  }

  status(): CloudStatus {
    return this.manager.status(PROJECT);
  }

  trips(): unknown[] {
    return this.bus.getRecentEvents("cloud.guard_tripped").map((e) => e.data);
  }

  /** The cloud routes as the server mounts them, and the headers of a browser signed in as the owner */
  async serve(): Promise<{ app: FastifyInstance; owner: Record<string, string>; sessionId: string }> {
    const tokenPath = join(this.dir, "owner.token");
    const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
    const app = Fastify();
    cleanups.push(async () => {
      await app.close();
      auth.close();
    });
    await registerCloudRoutes(app, this.manager, () => PROJECT, auth);
    const session = auth.createSession(readFileSync(tokenPath, "utf-8").trim());
    if (!session) throw new Error("no owner session");
    return { app, owner: { ...BROWSER, [OWNER_SESSION_HEADER]: session.session }, sessionId: session.info.id };
  }
}

describe("cloud: the AWS EC2 provider and the meter", () => {
  it("describes the tagged instance through the profile's EC2 client and meters each run from launch to stop", async () => {
    const h = new Harness(cloudBlock());
    h.instance("running", NOW - 2 * HOUR);
    const verdict = await h.machines.check();

    expect(h.aws.profiles).toEqual(["gates"]);
    expect(h.aws.named("DescribeInstances")[0]).toEqual({
      name: "DescribeInstances",
      region: "us-east-1",
      input: { InstanceIds: [INSTANCE], Filters: [{ Name: "tag:role", Values: ["gate-server"] }] },
    });
    expect(verdict).toMatchObject({ state: "ok", allowed: true });
    let status = h.status();
    expect(status.machines).toEqual([
      expect.objectContaining({ id: "cloud-1", state: "running", instanceId: INSTANCE, tag: "role=gate-server", lastError: null }),
    ]);
    expect(status.machines[0].launchedAt).toBe(new Date(NOW - 2 * HOUR).toISOString());
    // 2 h at $0.50, storage for January, February and March at $6
    expect(status.budget?.meter).toEqual({ total: 19, compute: 1, storage: 18, start: 0, today: 1 });

    // Stopped half an hour later (the stop time comes from the provider), checked an hour later
    h.instance("stopped", NOW - 2 * HOUR, NOW + HOUR / 2);
    h.now = NOW + HOUR;
    await h.machines.check();
    status = h.status();
    expect(status.machines[0]).toMatchObject({ state: "stopped", stoppedAt: new Date(NOW + HOUR / 2).toISOString() });
    expect(status.budget?.meter).toMatchObject({ total: 19.25, compute: 1.25 });

    // A stop the provider does not date counts up to when Lair saw it stopped
    h.instance("running", NOW + 2 * HOUR);
    h.now = NOW + 3 * HOUR;
    await h.machines.check();
    h.instance("stopped", NOW + 2 * HOUR);
    h.now = NOW + 4 * HOUR;
    await h.machines.check();
    expect(h.status().budget?.meter?.compute).toBe(2.25);
  });

  it("starts a stopped instance and stops a running one; a running one is not started again", async () => {
    const h = new Harness(cloudBlock());
    h.instance("stopped", NOW - 5 * HOUR, NOW - 4 * HOUR);
    const started = await h.machines.startMachine("cloud-1");
    expect(started).toMatchObject({ allowed: true, state: "pending" });
    expect(h.aws.named("StartInstances").map((s) => s.input)).toEqual([{ InstanceIds: [INSTANCE] }]);

    h.instance("running", NOW);
    expect(await h.machines.startMachine("cloud-1")).toMatchObject({ allowed: true, state: "running" });
    expect(h.aws.named("StartInstances")).toHaveLength(1);

    expect(await h.machines.stopMachine("cloud-1")).toBe("stopping");
    expect(h.aws.named("StopInstances").map((s) => s.input)).toEqual([{ InstanceIds: [INSTANCE] }]);
  });

  it("reads the cost before credits and refunds at most every spend_check_hours, across a restart", async () => {
    const h = new Harness(cloudBlock());
    h.instance("stopped", NOW - 5 * HOUR, NOW - 4 * HOUR);
    h.aws.cost = "12.5";
    await h.machines.check();
    expect(h.aws.named("GetCostAndUsage").map((s) => s.input)).toEqual([
      {
        TimePeriod: { Start: "2027-01-01", End: "2027-03-11" },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        Filter: { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } },
        NextPageToken: undefined,
      },
    ]);
    // Spend is the larger reading: the provider's $12.50 over the meter's $18.50
    expect(h.status().budget).toMatchObject({ spend: 18.5, provider: [{ profile: "gates", state: "amount", amount: 12.5 }] });

    h.now = NOW + HOUR;
    await h.machines.check();
    await h.restart(cloudBlock());
    await h.machines.check();
    expect(h.aws.named("GetCostAndUsage")).toHaveLength(1);

    h.now = NOW + 6 * HOUR;
    h.aws.cost = "30";
    await h.machines.check();
    expect(h.aws.named("GetCostAndUsage")).toHaveLength(2);
    expect(h.status().budget?.spend).toBe(30);
  });
});

describe("cloud: the money guard", () => {
  it("refuses a start at the limit, records one trip, and no start happens while it stands", async () => {
    // Storage $18 + 2 h at $0.50 + $1 before the meter = $20: the limit
    const block = cloudBlock({ limit: 20, meter_start: 1 });
    const h = new Harness(block);
    h.instance("stopped", NOW - 28 * HOUR, NOW - 26 * HOUR);
    h.aws.cost = "3";

    const refused = await h.machines.startMachine("cloud-1");
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("spend $20.00 reached the limit $20.00 (provider $3.00, meter $20.00)");
    expect(h.aws.named("StartInstances")).toHaveLength(0);
    expect(h.trips()).toEqual([expect.objectContaining({ project: PROJECT, limit: 20, spend: 20 })]);
    expect(h.status().budget?.guard).toMatchObject({
      state: "tripped",
      allowed: false,
      trip: { limit: 20, spend: 20, period: { start: "2027-01-01", end: "2027-12-31" }, at: new Date(NOW).toISOString() },
    });

    // Lower readings later (the provider says $0, a period's meter can't fall) don't clear it: no start
    h.aws.cost = "0";
    h.now = NOW + 7 * HOUR;
    const again = await h.machines.startMachine("cloud-1");
    expect(again).toMatchObject({ allowed: false });
    expect(again.reason).toMatch(/^tripped on 2027-03-10T12:00:00.000Z: .*; only the owner clears it/);
    expect(h.aws.named("StartInstances")).toHaveLength(0);

    // A restart keeps the trip, and records it once
    await h.restart(block);
    expect((await h.machines.startMachine("cloud-1")).allowed).toBe(false);
    expect(h.aws.named("StartInstances")).toHaveLength(0);
    expect(h.trips()).toHaveLength(1);

    // Stopping is never refused (started from the provider's console meanwhile)
    h.instance("running", NOW + 7 * HOUR + 2 * MINUTE);
    h.now = NOW + 7 * HOUR + 5 * MINUTE;
    expect(await h.machines.stopMachine("cloud-1")).toBe("stopping");
    h.instance("stopped", NOW + 7 * HOUR + 2 * MINUTE, NOW + 7 * HOUR + 10 * MINUTE);

    // A higher limit or a new period, by hand in the YAML (live reload), does not clear it
    h.now = NOW + 8 * HOUR;
    const reload = serverModules({ clouds: h.manager }).find((m) => m.name === "cloud");
    expect(reload?.blocks).toEqual(["cloud"]);
    await reload?.reload({ name: PROJECT, config: h.config(cloudBlock({ limit: 50, meter_start: 1 })) });
    expect(await h.machines.startMachine("cloud-1")).toMatchObject({ allowed: false, reason: expect.stringMatching(/^tripped on /) });
    const newPeriod = cloudBlock({ limit: 50, meter_start: 1, period: { start: "2027-02-01", end: "2027-12-31" } });
    await reload?.reload({ name: PROJECT, config: h.config(newPeriod) });
    expect(await h.machines.startMachine("cloud-1")).toMatchObject({ allowed: false, reason: expect.stringMatching(/^tripped on /) });
    expect(h.aws.named("StartInstances")).toHaveLength(0);

    // Only the owner clears it, naming the trip; nobody else can
    const { app, owner, sessionId } = await h.serve();
    const url = `/api/cloud/trip/clear?project=${PROJECT}`;
    const trippedAt = h.status().budget?.guard.trip?.at;
    expect(trippedAt).toBe(new Date(NOW).toISOString());
    expect(isUnder(url, OWNER_ONLY_PREFIXES)).toBe(true);
    for (const headers of [{}, BROWSER, { ...BROWSER, [OWNER_SESSION_HEADER]: "x".repeat(43) }]) {
      expect((await app.inject({ method: "POST", url, headers, payload: { trippedAt } })).statusCode).toBe(403);
    }
    // Another trip's time (a stale page) clears nothing
    const stale = await app.inject({ method: "POST", url, headers: owner, payload: { trippedAt: new Date(NOW - HOUR).toISOString() } });
    expect(stale.statusCode).toBe(409);
    expect(await h.machines.startMachine("cloud-1")).toMatchObject({ allowed: false });
    expect(h.bus.getRecentEvents("cloud.trip_cleared")).toEqual([]);

    const cleared = await app.inject({ method: "POST", url, headers: owner, payload: { trippedAt, note: "raised the limit\nto 50" } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data).toEqual({
      cleared: { limit: 20, period: { start: "2027-01-01", end: "2027-12-31" }, spend: 20, at: trippedAt, reason: expect.any(String) },
      by: sessionId,
    });
    expect(h.bus.getRecentEvents("cloud.trip_cleared").map((e) => e.data)).toEqual([
      { project: PROJECT, trippedAt, limit: 20, spend: 20, by: sessionId, note: "raised the limit to 50" },
    ]);
    expect(h.status().budget?.guard.trip).toBeNull();
    // Cleared once: the same request again finds no trip
    expect((await app.inject({ method: "POST", url, headers: owner, payload: { trippedAt } })).statusCode).toBe(409);

    // Under the new limit the next start is allowed
    const allowed = await h.machines.startMachine("cloud-1");
    expect(allowed).toMatchObject({ allowed: true, state: "pending" });
    expect(h.aws.named("StartInstances").map((s) => s.input)).toEqual([{ InstanceIds: [INSTANCE] }]);
  });

  it("a trip cleared while the spend is still at the limit trips again at the next check", async () => {
    const h = new Harness(cloudBlock({ limit: 20, meter_start: 1 }));
    h.instance("stopped", NOW - 28 * HOUR, NOW - 26 * HOUR);
    expect(await h.machines.startMachine("cloud-1")).toMatchObject({ allowed: false });
    const { app, owner } = await h.serve();
    const trippedAt = h.status().budget?.guard.trip?.at;
    const url = `/api/cloud/trip/clear?project=${PROJECT}`;
    expect((await app.inject({ method: "POST", url, headers: owner, payload: { trippedAt } })).statusCode).toBe(200);

    h.now = NOW + HOUR;
    const again = await h.machines.startMachine("cloud-1");
    expect(again).toMatchObject({ allowed: false, reason: expect.stringContaining("reached the limit $20.00") });
    expect(h.aws.named("StartInstances")).toHaveLength(0);
    expect(h.trips()).toHaveLength(2);
    expect(h.status().budget?.guard.trip?.at).toBe(new Date(NOW + HOUR).toISOString());
  });

  it("a provider with no data yet leaves the meter to decide; a meter at the limit refuses even when the provider says less", async () => {
    const h = new Harness(cloudBlock({ limit: 25 }));
    h.instance("stopped", NOW - 4 * HOUR, NOW - 2 * HOUR);
    h.aws.cost = Object.assign(new Error("Data is not available"), { name: "DataUnavailableException" });
    const started = await h.machines.startMachine("cloud-1");
    expect(started.allowed).toBe(true);
    expect(h.status().budget?.provider[0]).toMatchObject({ state: "unknown", amount: null });
    expect(h.aws.named("StartInstances")).toHaveLength(1);

    const low = new Harness(cloudBlock({ limit: 19 }));
    low.instance("stopped", NOW - 4 * HOUR, NOW - 2 * HOUR);
    low.aws.cost = "1";
    const refused = await low.machines.startMachine("cloud-1");
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("meter $19.00");
    expect(low.aws.named("StartInstances")).toHaveLength(0);
  });

  it("fails closed: a spend it can't tell, an untagged instance or a day outside the period means no start", async () => {
    const cases: [string, (h: Harness) => void, RegExp][] = [
      [
        "describe fails",
        (h) => {
          h.aws.describeError = Object.assign(new Error("not authorized to perform ec2:DescribeInstances"), { name: "UnauthorizedOperation" });
        },
        /^spend unknown: describe failed for cloud-1: not authorized/,
      ],
      [
        "cost reading fails",
        (h) => {
          h.aws.cost = Object.assign(new Error("not authorized to perform ce:GetCostAndUsage"), { name: "AccessDeniedException" });
        },
        /^spend unknown: the cost reading for profile gates failed: not authorized/,
      ],
      [
        "instance without the tag",
        (h) => h.instance("stopped", NOW - 4 * HOUR, NOW - 2 * HOUR, { role: "web" }),
        /^spend unknown: describe failed for cloud-1: i-0123456789abcdef0 with tag role=gate-server not found in us-east-1/,
      ],
      [
        "before the period",
        (h) => {
          h.now = Date.UTC(2026, 11, 31, 23, 0, 0);
        },
        /^the budget period starts on 2027-01-01$/,
      ],
      [
        "after the period",
        (h) => {
          h.now = Date.UTC(2028, 0, 1, 0, 0, 0);
        },
        /^the budget period ended on 2027-12-31$/,
      ],
    ];
    for (const [name, arrange, reason] of cases) {
      const h = new Harness(cloudBlock());
      h.instance("stopped", NOW - 4 * HOUR, NOW - 2 * HOUR);
      arrange(h);
      const result = await h.machines.startMachine("cloud-1");
      expect(result.allowed, name).toBe(false);
      expect(result.reason, name).toMatch(reason);
      expect(h.aws.named("StartInstances"), name).toHaveLength(0);
      expect(h.status().budget?.guard, name).toMatchObject({ state: "refused", allowed: false });
      // A spend Lair can't tell is not a trip: it starts again once the readings come back
      expect(h.trips(), name).toEqual([]);
    }
  });
});

describe("cloud: the meter never counts short", () => {
  it("with this machine's clock behind the provider's: a run counts a minute at least, a later stop is kept, a launch over a minute ahead refuses", async () => {
    // Launched 30 s after this machine's clock: a minute at $0.50, not nothing
    const ahead = new Harness(cloudBlock());
    ahead.instance("running", NOW + 30_000);
    await ahead.machines.check();
    expect(ahead.status().budget?.meter?.compute).toBe(0.01);

    // A stop dated 30 s after now: 60.5 minutes billed as 61, not cut back to 60
    const stopped = new Harness(cloudBlock());
    stopped.instance("stopped", NOW - HOUR, NOW + 30_000);
    await stopped.machines.check();
    expect(stopped.status().budget?.meter?.compute).toBe(0.51);

    // Two minutes ahead: the clock is wrong, so the spend can't be told and nothing starts
    const wrong = new Harness(cloudBlock());
    wrong.instance("stopped", NOW + 2 * 60_000, NOW + 3 * 60_000);
    const result = await wrong.machines.startMachine("cloud-1");
    expect(result).toMatchObject({ allowed: false });
    expect(result.reason).toMatch(/^spend unknown: describe failed for cloud-1: the provider dates its last launch or stop 180 s after this machine's clock/);
    expect(wrong.status().budget?.meter).toBeNull();
    expect(wrong.aws.named("StartInstances")).toHaveLength(0);
    expect(wrong.trips()).toEqual([]);
  });
});

describe("cloud: only the current instance starts, and only through the guard", () => {
  it("a stopped or replaced instance starts and stops nothing, a start queued before its stop included", async () => {
    const h = new Harness(cloudBlock());
    h.instance("stopped", NOW - 28 * HOUR, NOW - 26 * HOUR);
    const old = h.machines;
    const reload = serverModules({ clouds: h.manager }).find((m) => m.name === "cloud");
    // Queued first, its turn comes after the reload stopped the instance
    const queued = old.startMachine("cloud-1");
    const reloaded = reload?.reload({ name: PROJECT, config: h.config(cloudBlock({ limit: 50 })) });
    expect(await queued).toMatchObject({ allowed: false, reason: expect.stringMatching(/was stopped \(its config was reloaded/) });
    await reloaded;
    expect(h.machines).not.toBe(old);

    const sent = h.aws.sent.length;
    expect(await old.startMachine("cloud-1")).toMatchObject({ allowed: false });
    await expect(old.stopMachine("cloud-1")).rejects.toThrow(/was stopped/);
    expect(await old.check()).toMatchObject({ state: "refused", allowed: false });
    old.start();
    expect(old.running).toBe(false);
    // Not one provider call from the old instance
    expect(h.aws.sent).toHaveLength(sent);
    expect(h.aws.named("StartInstances")).toHaveLength(0);

    // The current one, from the manager, starts
    expect(await h.machines.startMachine("cloud-1")).toMatchObject({ allowed: true, state: "pending" });
    expect(h.aws.named("StartInstances")).toHaveLength(1);
  });

  it("the module exports no provider or SDK clients: nothing outside it can call a provider's start", async () => {
    const barrel = await import("./index.js");
    expect(Object.keys(barrel).sort()).toEqual([
      "CloudMachines",
      "CloudManager",
      "CloudSchema",
      "CloudStore",
      "parseCloudConfig",
      "registerCloudRoutes",
    ]);
  });
});

describe("cloud: configuration", () => {
  it("is off by default: no client is made and nothing is called", async () => {
    for (const cloud of [undefined, {}, { ...cloudBlock(), enabled: false }]) {
      const h = new Harness(cloud);
      expect(h.manager.start()).toEqual([]);
      expect(h.manager.get(PROJECT)).toBeUndefined();
      expect(h.status()).toMatchObject({ enabled: false, machines: [], budget: null, errors: [] });
      expect(h.aws.profiles).toEqual([]);
    }
    expect(parseCloudConfig(undefined)).toMatchObject({ ok: true, settings: { enabled: false } });
  });

  it("refuses credentials in the YAML without repeating them, and a block that is on without a budget", () => {
    const withKey = cloudBlock();
    (withKey.machines as Record<string, Record<string, unknown>>)["cloud-1"].secret_access_key = "zzzzzzzz";
    const keyed = parseCloudConfig(withKey);
    expect(keyed.ok).toBe(false);
    const keyErrors = keyed.ok ? [] : keyed.errors;
    expect(keyErrors).toEqual([
      "cloud.machines.cloud-1.secret_access_key: credentials never go in the project YAML; name a profile from your AWS config files with profile:",
    ]);
    expect(keyErrors.join(" ")).not.toContain("zzzzzzzz");

    // An access key id written where the profile goes (built here so no scanner mistakes this file for a leak)
    const keyId = ["AK", "IA", "Q".repeat(16)].join("");
    const asProfile = cloudBlock();
    (asProfile.machines as Record<string, Record<string, unknown>>)["cloud-1"].profile = keyId;
    const leaked = parseCloudConfig(asProfile);
    expect(leaked.ok ? [] : leaked.errors).toEqual([
      "cloud.machines.cloud-1.profile: looks like an AWS access key; credentials never go in the project YAML, name a profile instead",
    ]);

    const noBudget = cloudBlock();
    delete noBudget.budget;
    const h = new Harness(noBudget);
    expect(h.manager.get(PROJECT)).toBeUndefined();
    expect(h.status().errors).toEqual(["cloud.budget: a limit and a period are needed (no start happens without them)"]);
    expect(h.manager.validate(h.config(noBudget))).toHaveLength(1);
  });

  it("a start never rests on a cost reading older than a day: spend_check_hours is 24 at most", async () => {
    expect(parseCloudConfig(cloudBlock({ spend_check_hours: 24 }))).toMatchObject({ ok: true, settings: { budget: { spendCheckHours: 24 } } });
    const longer = parseCloudConfig(cloudBlock({ spend_check_hours: 25 }));
    expect(longer.ok ? [] : longer.errors).toEqual(["cloud.budget.spend_check_hours: Number must be less than or equal to 24"]);

    // At 24 the reading is read again a day after the last one, and a start waits for it
    const h = new Harness(cloudBlock({ spend_check_hours: 24 }));
    h.instance("stopped", NOW - 28 * HOUR, NOW - 26 * HOUR);
    await h.machines.check();
    h.now = NOW + 24 * HOUR - 1;
    await h.machines.check();
    expect(h.aws.named("GetCostAndUsage")).toHaveLength(1);
    h.now = NOW + 24 * HOUR;
    expect(await h.machines.startMachine("cloud-1")).toMatchObject({ allowed: true });
    expect(h.aws.named("GetCostAndUsage")).toHaveLength(2);
    expect(h.status().budget?.provider[0].readAt).toBe(new Date(NOW + 24 * HOUR).toISOString());
  });
});

describe("cloud: status route", () => {
  it("GET /api/cloud/status is the owner's: no session, a browser not signed in or an invalid session gets 403", async () => {
    const h = new Harness(cloudBlock());
    h.instance("stopped", NOW - 4 * HOUR, NOW - 2 * HOUR);
    await h.machines.check();
    const { app, owner } = await h.serve();
    const url = `/api/cloud/status?project=${PROJECT}`;
    // The whole prefix: no CORS for the dashboard's dev origin, and a later route under it is covered too
    expect(isUnder(url, OWNER_ONLY_PREFIXES)).toBe(true);
    expect(isUnder("/api/cloud/machines/cloud-1/start", OWNER_ONLY_PREFIXES)).toBe(true);
    const strangers: [string, Record<string, string>][] = [
      ["no session", {}],
      ["a browser not signed in", BROWSER],
      ["an invalid session", { ...BROWSER, [OWNER_SESSION_HEADER]: "x".repeat(43) }],
    ];
    for (const [who, headers] of strangers) {
      const res = await app.inject({ method: "GET", url, headers });
      expect(res.statusCode, who).toBe(403);
      expect(res.body, who).not.toContain(INSTANCE);
    }
    const res = await app.inject({ method: "GET", url, headers: owner });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: CloudStatus }).data.machines[0].instanceId).toBe(INSTANCE);
  });

  it("hides the account in provider errors: no ARN, account id or key id in the status, the guard's reason or the log", async () => {
    const h = new Harness(cloudBlock());
    h.instance("stopped", NOW - 4 * HOUR, NOW - 2 * HOUR);
    const account = "123456789012";
    const role = `arn:aws:sts::${account}:assumed-role/gate-runner-role/session-1`;
    const keyId = ["AS", "IA", "Q".repeat(16)].join("");
    h.aws.describeError = Object.assign(
      new Error(`User: ${role} is not authorized to perform: ec2:DescribeInstances with key ${keyId}`),
      { name: "UnauthorizedOperation" },
    );
    h.aws.cost = Object.assign(
      new Error(`User: ${role} is not authorized to perform: ce:GetCostAndUsage on resource: arn:aws:ce:us-east-1:${account}:/GetCostAndUsage`),
      { name: "AccessDeniedException" },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    cleanups.push(() => {
      warn.mockRestore();
      error.mockRestore();
    });

    const result = await h.machines.startMachine("cloud-1");
    expect(result.allowed).toBe(false);
    expect(h.aws.named("StartInstances")).toHaveLength(0);
    const { app, owner } = await h.serve();
    const res = await app.inject({ method: "GET", url: `/api/cloud/status?project=${PROJECT}`, headers: owner });
    const shown = [res.body, JSON.stringify(result), JSON.stringify(warn.mock.calls), JSON.stringify(error.mock.calls)].join("\n");
    for (const secret of [account, "arn:aws", "gate-runner-role", keyId]) expect(shown).not.toContain(secret);
    expect(warn).toHaveBeenCalled();
    const status = (res.json() as { data: CloudStatus }).data;
    expect(status.machines[0].lastError).toBe(
      "User: arn:(hidden) is not authorized to perform: ec2:DescribeInstances with key (key id hidden)",
    );
    expect(status.budget?.provider[0].detail).toBe(
      "User: arn:(hidden) is not authorized to perform: ce:GetCostAndUsage on resource: arn:(hidden)",
    );
    expect(status.budget?.guard.reason).toContain("describe failed for cloud-1: User: arn:(hidden) is not authorized");
    // An account id on its own is hidden too; an instance id is not an account id
    expect(providerText(`account ${account} has no access to ${INSTANCE}`)).toBe(`account (account id hidden) has no access to ${INSTANCE}`);
  });

  it("GET /api/cloud/status shows each machine's state, the spend and the guard, and nothing else answers", async () => {
    const h = new Harness(cloudBlock({ limit: 20, meter_start: 1 }));
    h.instance("stopped", NOW - 4 * HOUR, NOW - 2 * HOUR);
    h.aws.cost = "3";
    await h.machines.check();
    const { app, owner } = await h.serve();

    const res = await app.inject({ method: "GET", url: `/api/cloud/status?project=${PROJECT}`, headers: owner });
    expect(res.statusCode).toBe(200);
    const data = (res.json() as { data: CloudStatus }).data;
    expect(data).toMatchObject({
      project: PROJECT,
      enabled: true,
      checkSeconds: 300,
      machines: [{ id: "cloud-1", provider: "aws-ec2", state: "stopped", pricePerHour: 0.5 }],
      budget: {
        limit: 20,
        period: { start: "2027-01-01", end: "2027-12-31" },
        spend: 20,
        percent: 100,
        meter: { total: 20, compute: 1, storage: 18, start: 1 },
        provider: [{ profile: "gates", state: "amount", amount: 3 }],
        guard: { state: "tripped", allowed: false, trip: { limit: 20, spend: 20 } },
      },
    });
    const other = await app.inject({ method: "GET", url: "/api/cloud/status?project=other", headers: owner });
    expect((other.json() as { data: CloudStatus }).data).toMatchObject({ enabled: false, budget: null });

    // No route starts a machine or changes the budget, for the owner either
    for (const [method, url] of [
      ["POST", "/api/cloud/status"],
      ["POST", "/api/cloud/machines/cloud-1/start"],
      ["PUT", "/api/cloud/budget"],
      ["DELETE", "/api/cloud/trip"],
    ] as const) {
      expect((await app.inject({ method, url, headers: owner })).statusCode, `${method} ${url}`).toBe(404);
    }
    expect(h.aws.named("StartInstances")).toHaveLength(0);
  });
});
