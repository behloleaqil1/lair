/**
 * The Decision Inbox on its real store (SQLite, in memory or in a temp file
 * for restarts), with a fixed clock. Producers are the inbox's own
 * interface: raise(), blockedOn(), onResolved(), withdraw().
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../core/event-bus.js";
import type { Event } from "../../shared/server-types.js";
import { DecisionInbox } from "./service.js";
import { DecisionStore } from "./store.js";
import { MemorySecretStore, SecretStoreUnavailableError, type SecretStore } from "./secrets.js";
import type { DecisionResolution, RaiseDecisionInput } from "./types.js";
import { DecisionError } from "./validate.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

class FakeClock {
  t = NOW;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const dirs: string[] = [];
const stores: DecisionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-decisions-"));
  dirs.push(dir);
  return dir;
}

function setup(options: { dbPath?: string; secrets?: SecretStore; clock?: FakeClock } = {}) {
  const store = new DecisionStore(options.dbPath ?? ":memory:");
  stores.push(store);
  const clock = options.clock ?? new FakeClock();
  const secrets = options.secrets ?? new MemorySecretStore();
  const bus = new EventBus();
  const events: Event[] = [];
  bus.on("*", (event) => {
    events.push(event);
  });
  const inbox = new DecisionInbox({ store, secrets, events: bus, clock });
  return { inbox, store, clock, secrets, events };
}

function spend(overrides: Partial<RaiseDecisionInput> = {}): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "spend",
    title: "Raise the monthly hosting budget",
    context: "The staging deploy needs a larger database plan.\nIt stays blocked until the budget allows it.",
    options: [
      { id: "approve", label: "Approve the larger plan", consequences: "Costs more each month; the deploy goes ahead." },
      { id: "decline", label: "Keep the current plan", consequences: "The deploy stays blocked." },
    ],
    recommended: { optionId: "approve", reasoning: "Staging can't start on the current plan." },
    source: { module: "delivery", ref: "env:staging" },
    key: "budget:staging-db",
    blocks: ["deploy:staging"],
    ...overrides,
  };
}

function other(overrides: Partial<RaiseDecisionInput> = {}): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "other",
    title: "Pick the default page size",
    context: "The list view needs a page size.",
    options: [
      { id: "small", label: "20 rows", consequences: "Faster pages, more paging." },
      { id: "large", label: "100 rows", consequences: "Slower pages, less paging." },
    ],
    recommended: { optionId: "small", reasoning: "Most lists are short." },
    source: { module: "planner", ref: "card-12" },
    key: "page-size",
    blocks: ["card:12"],
    ...overrides,
  };
}

const SECRET = "example-token-value-7f3c9a1e";

function credentials(overrides: Partial<RaiseDecisionInput> = {}): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "credentials",
    title: "Connect the git host",
    context: "Opening pull requests needs a token for the git host.",
    options: [
      { id: "supply", label: "Enter the token", consequences: "Lair can open pull requests.", suppliesSecret: true },
      { id: "later", label: "Not now", consequences: "Pull requests stay blocked." },
    ],
    recommended: { optionId: "supply", reasoning: "Nothing merges without it." },
    source: { module: "delivery", ref: "git-host" },
    key: "git-host-token",
    blocks: ["prs:open"],
    secretName: "GIT_HOST_TOKEN",
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<DecisionError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(DecisionError);
    return e as DecisionError;
  }
  throw new Error("expected a DecisionError");
}

describe("model and store", () => {
  it("keeps every field, open, with the raise in its audit trail and a decision.raised event", async () => {
    const { inbox, events } = setup();
    const { decision, created } = await inbox.raise(
      spend({ expiresAt: "2026-03-02T18:00:00Z", links: [{ label: "Plan", url: "https://example.com/plans" }] }),
    );
    expect(created).toBe(true);
    expect(decision).toMatchObject({
      project: "demo",
      kind: "spend",
      title: "Raise the monthly hosting budget",
      context: expect.stringContaining("stays blocked"),
      options: [
        { id: "approve", label: "Approve the larger plan", consequences: expect.any(String) },
        { id: "decline", label: "Keep the current plan", consequences: "The deploy stays blocked." },
      ],
      recommended: { optionId: "approve", reasoning: "Staging can't start on the current plan." },
      source: { module: "delivery", ref: "env:staging" },
      key: "budget:staging-db",
      blocks: ["deploy:staging"],
      links: [{ label: "Plan", url: "https://example.com/plans" }],
      createdAt: "2026-03-02T12:00:00.000Z",
      expiresAt: "2026-03-02T18:00:00.000Z",
      overdue: false,
      status: "open",
    });
    expect(decision.answer).toBeUndefined();
    expect(inbox.get(decision.id)?.audit).toEqual([
      {
        at: "2026-03-02T12:00:00.000Z",
        action: "raised",
        actor: "delivery",
        detail:
          "spend decision raised by delivery (env:staging), recommending approve; expires 2026-03-02T18:00:00.000Z, then it keeps waiting",
      },
    ]);
    expect(events.map((e) => e.type)).toEqual(["decision.raised"]);
    expect(events[0].data).toMatchObject({ decisionId: decision.id, kind: "spend", module: "delivery" });
  });

  it("survives a restart: the reopened file has the decision, what it blocks, its answer and audit", async () => {
    const dbPath = join(tempDir(), "decisions.db");
    const first = setup({ dbPath });
    const { decision } = await first.inbox.raise(other());
    await first.inbox.answer(decision.id, { optionId: "large", note: "Lists grow." });
    const before = first.inbox.get(decision.id);
    first.store.close();

    const second = setup({ dbPath });
    expect(second.inbox.get(decision.id)).toEqual(before);
    expect(second.inbox.get(decision.id)).toMatchObject({
      status: "answered",
      answer: { optionId: "large", note: "Lists grow." },
      answeredBy: "owner",
      answeredAt: "2026-03-02T12:00:00.000Z",
      blocks: ["card:12"],
    });
    expect(second.inbox.get(decision.id)?.audit?.map((a) => a.action)).toEqual(["raised", "answered"]);
  });

  it("refuses invalid input with 400, naming the fields", async () => {
    const { inbox } = setup();
    const error = await rejection(inbox.raise(other({ title: "", recommended: { optionId: "medium", reasoning: "r" } })));
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("title:");
    expect(inbox.list()).toEqual([]);
  });
});

describe("blocking, resume and dedupe", () => {
  it("the same project, module and key returns the open decision and adds the new blocked work", async () => {
    const { inbox, events } = setup();
    const first = await inbox.raise(spend());
    const again = await inbox.raise(spend({ blocks: ["deploy:staging", "migrate:staging"] }));
    expect(again.created).toBe(false);
    expect(again.decision.id).toBe(first.decision.id);
    expect(again.decision.blocks).toEqual(["deploy:staging", "migrate:staging"]);
    expect(await inbox.raise(spend())).toMatchObject({ created: false });
    expect(inbox.list()).toHaveLength(1);
    expect(inbox.get(first.decision.id)?.audit?.map((a) => a.action)).toEqual(["raised", "raised_again"]);
    expect(events.filter((e) => e.type === "decision.raised")).toHaveLength(1);

    // Another key, another project or another module is another decision
    await inbox.raise(spend({ key: "budget:other" }));
    await inbox.raise(spend({ project: "shop" }));
    await inbox.raise(spend({ source: { module: "agents", ref: "budget" } }));
    expect(inbox.list()).toHaveLength(4);
  });

  it("parks blocked work until the answer, then resumes the producer with it, once", async () => {
    const { inbox, events } = setup();
    const resumed: DecisionResolution[] = [];
    inbox.onResolved("delivery", (resolution) => {
      resumed.push(resolution);
    });
    const { decision } = await inbox.raise(spend());

    expect(inbox.blockedOn("deploy:staging")?.id).toBe(decision.id);
    expect(inbox.blockedOn("deploy:production")).toBeNull();
    expect(resumed).toEqual([]);

    const answered = await inbox.answer(decision.id, { optionId: "approve", confirm: true, note: "Within budget." });
    expect(answered).toMatchObject({
      status: "answered",
      answer: { optionId: "approve", note: "Within budget." },
      answeredBy: "owner",
      deliveredAt: "2026-03-02T12:00:00.000Z",
    });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      outcome: "answered",
      optionId: "approve",
      note: "Within budget.",
      secretSupplied: false,
      by: "owner",
      decision: { id: decision.id, status: "answered" },
    });
    expect(inbox.blockedOn("deploy:staging")).toBeNull();
    expect(answered.audit?.map((a) => a.action)).toEqual(["raised", "answered", "delivered"]);
    expect(events.map((e) => e.type)).toEqual(["decision.raised", "decision.answered"]);

    await inbox.deliverPending();
    expect(resumed).toHaveLength(1);

    // Answered: the same key raises a new decision
    expect(await inbox.raise(spend())).toMatchObject({ created: true });
  });

  it("delivers an answer given while nobody listened once the producer registers, also after a restart", async () => {
    const dbPath = join(tempDir(), "decisions.db");
    const first = setup({ dbPath });
    const { decision } = await first.inbox.raise(other());
    const answered = await first.inbox.answer(decision.id, { optionId: "large" });
    expect(answered.deliveredAt).toBeUndefined();
    first.store.close();

    const second = setup({ dbPath });
    const resumed: DecisionResolution[] = [];
    second.inbox.onResolved("planner", (resolution) => {
      resumed.push(resolution);
    });
    await second.inbox.deliverPending();
    expect(resumed.map((r) => [r.decision.id, r.optionId])).toEqual([[decision.id, "large"]]);
    expect(second.inbox.get(decision.id)?.deliveredAt).toBe("2026-03-02T12:00:00.000Z");
    await second.inbox.deliverPending();
    expect(resumed).toHaveLength(1);
  });

  it("keeps an answer the producer couldn't take, and retries it every sweep until it can", async () => {
    const { inbox } = setup();
    let failing = true;
    const resumed: string[] = [];
    inbox.onResolved("planner", (resolution) => {
      if (failing) throw new Error("planner store is locked");
      resumed.push(resolution.optionId);
    });
    const { decision } = await inbox.raise(other());
    const answered = await inbox.answer(decision.id, { optionId: "small" });
    expect(answered.deliveredAt).toBeUndefined();
    await inbox.sweep();
    await inbox.sweep();
    expect(resumed).toEqual([]);
    const failures = inbox.get(decision.id)?.audit?.filter((a) => a.action === "delivery_failed") ?? [];
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("planner store is locked");

    failing = false;
    await inbox.sweep();
    expect(resumed).toEqual(["small"]);
    expect(inbox.get(decision.id)?.deliveredAt).toBeDefined();
  });

  it("sends each project's answers to the handler registered for that project", async () => {
    const { inbox } = setup();
    const got: string[] = [];
    inbox.onResolved("watchdog", (r) => void got.push(`one:${r.decision.project}`), { project: "one" });
    inbox.onResolved("watchdog", (r) => void got.push(`two:${r.decision.project}`), { project: "two" });
    const source = { module: "watchdog", ref: "breach-1" };
    const a = await inbox.raise(other({ project: "one", source }));
    const b = await inbox.raise(other({ project: "two", source }));
    await inbox.answer(b.decision.id, { optionId: "small" });
    await inbox.answer(a.decision.id, { optionId: "small" });
    expect(got).toEqual(["two:two", "one:one"]);
  });

  it("withdraw: only the module that raised it, only while open; nothing is delivered", async () => {
    const { inbox, events } = setup();
    const resumed: DecisionResolution[] = [];
    inbox.onResolved("delivery", (r) => {
      resumed.push(r);
    });
    const { decision } = await inbox.raise(spend());

    const wrong = await rejection(inbox.withdraw(decision.id, { module: "planner", reason: "not mine" }));
    expect(wrong.statusCode).toBe(403);

    const withdrawn = await inbox.withdraw(decision.id, { module: "delivery", reason: "Moved to a cheaper region." });
    expect(withdrawn).toMatchObject({ status: "withdrawn", withdrawnReason: "Moved to a cheaper region." });
    expect(inbox.blockedOn("deploy:staging")).toBeNull();
    expect(events.map((e) => e.type)).toEqual(["decision.raised", "decision.withdrawn"]);

    expect((await rejection(inbox.answer(decision.id, { optionId: "approve", confirm: true }))).statusCode).toBe(409);
    expect((await rejection(inbox.withdraw(decision.id, { module: "delivery", reason: "again" }))).statusCode).toBe(
      409,
    );
    await inbox.deliverPending();
    expect(resumed).toEqual([]);
  });

  it("checks answers against the decision: its options, open status and existence", async () => {
    const { inbox } = setup();
    const { decision } = await inbox.raise(other());
    const unknown = await rejection(inbox.answer(decision.id, { optionId: "medium" }));
    expect(unknown.statusCode).toBe(400);
    expect(unknown.message).toBe("optionId: not an option of this decision (small, large)");
    await inbox.answer(decision.id, { optionId: "small" });
    expect((await rejection(inbox.answer(decision.id, { optionId: "large" }))).statusCode).toBe(409);
    expect(
      (await rejection(inbox.answer("0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b", { optionId: "small" }))).statusCode,
    ).toBe(404);
  });

  it("spend and go/no-go answers need confirm: true; other kinds don't", async () => {
    const { inbox } = setup();
    const budget = await inbox.raise(spend());
    const unconfirmed = await rejection(inbox.answer(budget.decision.id, { optionId: "approve" }));
    expect(unconfirmed).toMatchObject({
      statusCode: 400,
      message: "confirm: answering a spend decision needs confirm: true",
    });
    expect(inbox.get(budget.decision.id)?.status).toBe("open");
    expect((await inbox.answer(budget.decision.id, { optionId: "approve", confirm: true })).status).toBe("answered");

    const release = await inbox.raise(spend({ kind: "go_no_go", key: "launch", title: "Launch the beta" }));
    expect((await rejection(inbox.answer(release.decision.id, { optionId: "decline" }))).statusCode).toBe(400);
    expect((await inbox.answer(release.decision.id, { optionId: "decline", confirm: true })).status).toBe("answered");

    const plain = await inbox.raise(other());
    expect((await inbox.answer(plain.decision.id, { optionId: "small" })).status).toBe("answered");
  });
});

describe("expiry and defaults", () => {
  it("applies a decision's default at expiry: expired, the default as its answer, delivered, in the audit trail", async () => {
    const { inbox, clock, events } = setup();
    const resumed: DecisionResolution[] = [];
    inbox.onResolved("planner", (r) => {
      resumed.push(r);
    });
    const { decision } = await inbox.raise(other({ expiresAt: "2026-03-02T13:00:00Z", defaultOptionId: "large" }));

    clock.advance(30 * MIN);
    expect(await inbox.expireDue()).toEqual({ expired: 0, overdue: 0 });
    expect(inbox.get(decision.id)?.status).toBe("open");

    clock.advance(31 * MIN);
    expect(await inbox.expireDue()).toEqual({ expired: 1, overdue: 0 });
    const expired = inbox.get(decision.id)!;
    expect(expired).toMatchObject({
      status: "expired",
      answer: { optionId: "large" },
      answeredBy: "lair",
      closedAt: "2026-03-02T13:01:00.000Z",
    });
    expect(expired.audit?.map((a) => a.action)).toEqual(["raised", "expired", "delivered"]);
    expect(expired.audit?.[1].detail).toBe(
      "unanswered at its expiry (2026-03-02T13:00:00.000Z); its default large (100 rows) applies",
    );
    expect(resumed).toMatchObject([{ outcome: "expired", optionId: "large", by: "lair" }]);
    expect(events.map((e) => e.type)).toEqual(["decision.raised", "decision.expired"]);
    expect(inbox.blockedOn("card:12")).toBeNull();
  });

  it("refuses a default for the kinds that always wait", async () => {
    const { inbox } = setup();
    for (const input of [
      spend({ expiresAt: "2026-03-02T13:00:00Z", defaultOptionId: "decline" }),
      spend({ kind: "legal", expiresAt: "2026-03-02T13:00:00Z", defaultOptionId: "decline" }),
      credentials({ expiresAt: "2026-03-02T13:00:00Z", defaultOptionId: "later" }),
    ]) {
      const error = await rejection(inbox.raise(input));
      expect(error.statusCode).toBe(400);
      expect(error.message).toContain(`defaultOptionId: ${input.kind} decisions can't have a default`);
    }
    expect(inbox.list()).toEqual([]);
  });

  it("a decision without a default keeps waiting past its expiry, marked overdue once", async () => {
    const { inbox, clock } = setup();
    const resumed: DecisionResolution[] = [];
    inbox.onResolved("delivery", (r) => {
      resumed.push(r);
    });
    const { decision } = await inbox.raise(spend({ expiresAt: "2026-03-02T13:00:00Z" }));
    clock.advance(2 * HOUR);
    expect(await inbox.expireDue()).toEqual({ expired: 0, overdue: 1 });
    expect(await inbox.expireDue()).toEqual({ expired: 0, overdue: 0 });

    const waiting = inbox.get(decision.id)!;
    expect(waiting).toMatchObject({ status: "open", overdue: true });
    expect(waiting.audit?.map((a) => a.action)).toEqual(["raised", "overdue"]);
    expect(waiting.audit?.[1].detail).toBe(
      "past its expiry (2026-03-02T13:00:00.000Z) and still waiting for an answer: spend decisions never default",
    );
    expect(inbox.counts()).toEqual({ open: 1, overdue: 1, action: 1, notices: 0 });
    expect(inbox.blockedOn("deploy:staging")?.id).toBe(decision.id);
    expect(resumed).toEqual([]);
  });

  it("lists open decisions first by urgency (soonest expiry, then oldest), then the closed ones, newest first", async () => {
    const { inbox, clock } = setup();
    const a = await inbox.raise(other({ key: "a", title: "A" }));
    clock.advance(MIN);
    const b = await inbox.raise(other({ key: "b", title: "B", expiresAt: "2026-03-02T17:00:00Z" }));
    const c = await inbox.raise(other({ key: "c", title: "C", expiresAt: "2026-03-02T13:00:00Z" }));
    const d = await inbox.raise(other({ key: "d", title: "D" }));
    const e = await inbox.raise(other({ key: "e", title: "E" }));
    const f = await inbox.raise(other({ key: "f", title: "F" }));
    await inbox.answer(e.decision.id, { optionId: "small" });
    clock.advance(MIN);
    await inbox.answer(f.decision.id, { optionId: "small" });

    expect(inbox.list().map((x) => x.title)).toEqual(["C", "B", "A", "D", "F", "E"]);
    expect(inbox.list({ status: "open" }).map((x) => x.id)).toEqual([
      c.decision.id,
      b.decision.id,
      a.decision.id,
      d.decision.id,
    ]);
    expect(inbox.list({ status: "closed" })).toHaveLength(2);
    expect(inbox.list({ project: "elsewhere" })).toEqual([]);
  });
});

describe("credentials", () => {
  it("hands the secret to the secret store and keeps it out of the database, the audit trail, events and answers", async () => {
    const dir = tempDir();
    const secrets = new MemorySecretStore();
    const { inbox, events, store } = setup({ dbPath: join(dir, "decisions.db"), secrets });
    const resumed: DecisionResolution[] = [];
    inbox.onResolved("delivery", (r) => {
      resumed.push(r);
    });
    const { decision } = await inbox.raise(credentials());

    const answered = await inbox.answer(
      decision.id,
      { optionId: "supply", secret: SECRET },
      { remoteAddress: "127.0.0.1", userAgent: "ExampleBrowser/1.0" },
    );
    expect(await secrets.get("GIT_HOST_TOKEN")).toBe(SECRET);
    expect(answered).toMatchObject({
      status: "answered",
      secretName: "GIT_HOST_TOKEN",
      answer: { optionId: "supply", secretSupplied: true },
      answeredBy: "owner",
    });
    expect(answered.audit?.[1]).toMatchObject({
      action: "answered",
      actor: "owner",
      detail:
        "chose supply (Enter the token); the secret went to the secret store as GIT_HOST_TOKEN; from 127.0.0.1 (ExampleBrowser/1.0)",
    });
    expect(resumed).toMatchObject([{ optionId: "supply", secretSupplied: true, by: "owner" }]);

    expect(JSON.stringify(answered)).not.toContain(SECRET);
    expect(JSON.stringify(inbox.list())).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(resumed)).not.toContain(SECRET);
    store.close();
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file)).includes(Buffer.from(SECRET))).toBe(false);
    }
  });

  it("takes a secret only with an option that supplies it, needs one there, and takes no note at all", async () => {
    const secrets = new MemorySecretStore();
    const { inbox } = setup({ secrets });
    const { decision } = await inbox.raise(credentials());

    const missing = await rejection(inbox.answer(decision.id, { optionId: "supply" }));
    expect(missing).toMatchObject({ statusCode: 400, message: "secret: this option supplies the secret, so it needs the value" });
    const extra = await rejection(inbox.answer(decision.id, { optionId: "later", secret: SECRET }));
    expect(extra.message).toBe("secret: only an option that supplies the secret takes a value");
    const inNote = await rejection(
      inbox.answer(decision.id, { optionId: "supply", secret: SECRET, note: `token is ${SECRET.slice(0, 10)} ...` }),
    );
    expect(inNote.message).toBe("note: credentials decisions take no note (a secret could end up in it)");
    const anyNote = await rejection(inbox.answer(decision.id, { optionId: "later", note: "maybe next week" }));
    expect(anyNote.statusCode).toBe(400);
    for (const error of [missing, extra, inNote]) expect(error.message).not.toContain(SECRET);
    expect(await secrets.has("GIT_HOST_TOKEN")).toBe(false);
    expect(inbox.get(decision.id)?.status).toBe("open");

    const budget = await inbox.raise(spend());
    const notCredentials = await rejection(
      inbox.answer(budget.decision.id, { optionId: "approve", confirm: true, secret: SECRET }),
    );
    expect(notCredentials.message).toBe("secret: only credentials decisions take a secret");

    expect((await inbox.answer(decision.id, { optionId: "later" })).answer).toEqual({ optionId: "later" });
    expect(await secrets.has("GIT_HOST_TOKEN")).toBe(false);
  });

  it("reopens the decision (503) when the secret store can't take the value, and delivers nothing", async () => {
    const unavailable: SecretStore = {
      description: "a broker that is down",
      put: async () => {
        throw new SecretStoreUnavailableError("the broker is not reachable");
      },
      has: async () => false,
      get: async () => undefined,
    };
    const { inbox, events } = setup({ secrets: unavailable });
    const resumed: DecisionResolution[] = [];
    inbox.onResolved("delivery", (r) => {
      resumed.push(r);
    });
    const { decision } = await inbox.raise(credentials());
    const error = await rejection(inbox.answer(decision.id, { optionId: "supply", secret: SECRET }));
    expect(error).toMatchObject({
      statusCode: 503,
      message: "The secret store could not take the secret: the broker is not reachable",
    });
    const reopened = inbox.get(decision.id)!;
    expect(reopened).toMatchObject({ status: "open" });
    expect(reopened.answer).toBeUndefined();
    expect(reopened.answeredAt).toBeUndefined();
    expect(reopened.audit?.map((a) => a.action)).toEqual(["raised"]);
    await inbox.deliverPending();
    expect(resumed).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["decision.raised"]);

    // Still answerable another way
    expect((await inbox.answer(decision.id, { optionId: "later" })).status).toBe("answered");
    expect(resumed.map((r) => r.optionId)).toEqual(["later"]);
  });

  it("closes the decision before storing the secret: a second answer or a withdrawal loses, and its secret is never stored", async () => {
    const stored = new Map<string, string>();
    const puts: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: SecretStore = {
      description: "a slow broker",
      put: async (name, value) => {
        puts.push(value);
        await gate;
        stored.set(name, value);
      },
      has: async (name) => stored.has(name),
      get: async (name) => stored.get(name),
    };
    const { inbox } = setup({ secrets: gated });
    const resumed: DecisionResolution[] = [];
    inbox.onResolved("delivery", (r) => {
      resumed.push(r);
    });
    const { decision } = await inbox.raise(credentials());

    // The first answer closes the decision and waits on the secret store
    const first = inbox.answer(decision.id, { optionId: "supply", secret: "first-secret-value-1a2b" });
    expect(puts).toEqual(["first-secret-value-1a2b"]);

    const second = await rejection(inbox.answer(decision.id, { optionId: "supply", secret: "second-secret-value-3c4d" }));
    expect(second.statusCode).toBe(409);
    const withdrawal = await rejection(inbox.withdraw(decision.id, { module: "delivery", reason: "not needed" }));
    expect(withdrawal.statusCode).toBe(409);
    // While the secret is being stored, the answer is not delivered
    await inbox.deliverPending();
    expect(resumed).toEqual([]);

    release();
    expect((await first).status).toBe("answered");
    expect(puts).toEqual(["first-secret-value-1a2b"]);
    expect(stored.get("GIT_HOST_TOKEN")).toBe("first-secret-value-1a2b");
    expect(resumed.map((r) => r.optionId)).toEqual(["supply"]);
  });
});

describe("limits and origins", () => {
  it("refuses a new decision with 429 once a module has the maximum open in a project", async () => {
    const store = new DecisionStore(":memory:");
    stores.push(store);
    const inbox = new DecisionInbox({
      store,
      secrets: new MemorySecretStore(),
      clock: new FakeClock(),
      maxOpenPerSource: 2,
    });
    await inbox.raise(other({ key: "a" }));
    const b = await inbox.raise(other({ key: "b" }));
    const capped = await rejection(inbox.raise(other({ key: "c" })));
    expect(capped.statusCode).toBe(429);
    expect(capped.message).toBe(
      "planner already has 2 open decisions in demo (the limit is 2): wait for answers or withdraw some first",
    );
    // The same key is still the open decision, another project or module has its own count
    expect(await inbox.raise(other({ key: "a" }))).toMatchObject({ created: false });
    expect(await inbox.raise(other({ key: "c", project: "shop" }))).toMatchObject({ created: true });
    expect(await inbox.raise(other({ key: "c", source: { module: "intake", ref: "r" } }))).toMatchObject({
      created: true,
    });
    // An answer frees a place
    await inbox.answer(b.decision.id, { optionId: "small" });
    expect(await inbox.raise(other({ key: "c" }))).toMatchObject({ created: true });
  });

  it("records where an answer came from, and always the owner as who answered", async () => {
    const { inbox } = setup();
    const { decision } = await inbox.raise(other());
    const answered = await inbox.answer(
      decision.id,
      { optionId: "large", note: "ok" },
      { remoteAddress: "::1", userAgent: "Example\u0007Browser" },
    );
    expect(answered.answeredBy).toBe("owner");
    expect(answered.audit?.[1]).toMatchObject({
      actor: "owner",
      detail: "chose large (100 rows); note: ok; from ::1 (Example Browser)",
    });
  });

  it("caps HTTP-raised decisions per project whatever module they name; producers in the server have their own cap", async () => {
    const store = new DecisionStore(":memory:");
    stores.push(store);
    const inbox = new DecisionInbox({
      store,
      secrets: new MemorySecretStore(),
      clock: new FakeClock(),
      maxOpenHttpPerProject: 2,
    });
    const from = (module: string, key: string) => other({ key, source: { module, ref: "r" } });
    await inbox.raiseFromHttp(from("alpha", "a"));
    await inbox.raiseFromHttp(from("beta", "b"));
    const capped = await rejection(inbox.raiseFromHttp(from("gamma", "c")));
    expect(capped).toMatchObject({ statusCode: 429 });
    expect(capped.message).toContain("HTTP callers already have 2 open decisions in demo (the limit is 2)");
    // Another project has its own count; producers inside the server aren't counted or capped by it
    expect(
      await inbox.raiseFromHttp(other({ project: "shop", key: "c", source: { module: "gamma", ref: "r" } })),
    ).toMatchObject({ created: true });
    expect(await inbox.raise(from("watchdog", "w1"))).toMatchObject({ created: true });
    expect(await inbox.raise(from("watchdog", "w2"))).toMatchObject({ created: true });
    expect(inbox.list({ project: "demo", status: "open" }).map((d) => d.raisedVia).sort()).toEqual([
      "http",
      "http",
      "server",
      "server",
    ]);
  });
});

describe("delivering credentials answers", () => {
  it("reopens an answer whose secret is gone by the time it is delivered (a restart), instead of resuming the producer", async () => {
    const dbPath = join(tempDir(), "decisions.db");
    const first = setup({ dbPath });
    const { decision } = await first.inbox.raise(credentials());
    const answered = await first.inbox.answer(decision.id, { optionId: "supply", secret: SECRET });
    expect(answered).toMatchObject({ status: "answered", deliveredAt: undefined });
    first.store.close();

    // A restart: the in-memory secret store is empty again
    const second = setup({ dbPath, secrets: new MemorySecretStore() });
    const resumed: DecisionResolution[] = [];
    second.inbox.onResolved("delivery", (r) => {
      resumed.push(r);
    });
    await second.inbox.deliverPending();
    expect(resumed).toEqual([]);
    const reopened = second.inbox.get(decision.id)!;
    expect(reopened).toMatchObject({ status: "open" });
    expect(reopened.answer).toBeUndefined();
    expect(reopened.audit?.map((a) => a.action)).toEqual(["raised", "answered", "reopened"]);
    expect(reopened.audit?.[2].detail).toBe(
      "the secret store has no GIT_HOST_TOKEN any more, so the answer can't be used: answer again",
    );

    // Answered again, with the secret there, it is delivered
    await second.inbox.answer(decision.id, { optionId: "supply", secret: SECRET });
    expect(resumed.map((r) => r.optionId)).toEqual(["supply"]);
  });
});
