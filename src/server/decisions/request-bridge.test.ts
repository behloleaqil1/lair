/**
 * Decision requests in the design note's shape become inbox decisions: the
 * mapping, and end to end with the real PipelineManager (its GitHub-hosted
 * minutes budget) and the real Decision Inbox, through the `decision.needed`
 * event as the server wires it (mountDecisions) and through InboxDecisionHook.
 * Only the pipeline's boundaries are fake (GitHub's API, the spawner, the
 * capacity probe, the clock).
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../core/event-bus.js";
import { BudgetManager } from "../fleet/budget.js";
import { PipelineManager } from "../gates/pipeline-service.js";
import type { DecisionHook, DecisionRequest } from "../gates/decision-hook.js";
import {
  FakeCapacity,
  FakeClock,
  FakeGitHub,
  FakeSpawner,
  SHA,
  TOKEN,
  projectConfig,
} from "../gates/testing/fakes.js";
import { HumanAuth } from "../human-auth/index.js";
import { mountDecisions } from "./mount.js";
import { InboxDecisionHook, listenForDecisionRequests, toDecisionInput } from "./request-bridge.js";
import { DecisionInbox } from "./service.js";
import { DecisionStore } from "./store.js";
import { MemorySecretStore } from "./secrets.js";
import type { DecisionResolution } from "./types.js";

const MIN = 60_000;
const PIPELINES = { gate: { steps: [{ name: "test", run: ["npm", "test"] }] } };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-decision-bridge-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A private repository with a 10-minute hosted budget; the first hosted job bills 9. */
async function pipelines(events: EventBus, decisions?: DecisionHook) {
  const clock = new FakeClock();
  const github = new FakeGitHub(clock);
  github.repo = { private: true, visibility: "private", default_branch: "main" };
  github.scripts = [{ durationMs: 8.5 * MIN }];
  const manager = new PipelineManager({
    dbPath: ":memory:",
    events,
    budget: new BudgetManager(),
    fetch: github.fetch,
    spawner: new FakeSpawner(),
    capacity: new FakeCapacity(),
    clock,
    env: { PATH: "/usr/bin:/bin", HOME: "/home/user", LAIR_GITHUB_TOKEN: TOKEN },
    lairDir: tempDir(),
    git: { run: async () => ({ code: 0, stdout: `${SHA}\n`, stderr: "" }) },
    decisions,
  });
  cleanups.push(() => manager.stop());
  manager.load([
    { name: "demo", config: projectConfig("demo", "/home/user/example-app", PIPELINES, { github: { monthly_minutes: 10 } }) },
  ]);
  github.commitWorkflow((await manager.workflow("demo")).content);
  return {
    manager,
    github,
    async run() {
      const started = await manager.startRun("demo", { pipeline: "gate", sha: SHA });
      await manager.idle();
      return manager.getRun("demo", started.id);
    },
  };
}

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    key: "pipelines:github-minutes:demo:2026-03",
    project: "demo",
    kind: "spend",
    question: "Allow more GitHub-hosted runner minutes for demo in 2026-03?",
    context: "The private repository has used 9 of its 10 minutes.",
    options: ["Keep the budget (run on self-hosted runners or this machine)", "Raise executors.github.monthly_minutes"],
    recommended: "Keep the budget (run on self-hosted runners or this machine)",
    why: "GitHub bills hosted minutes of private repositories.",
    reversible: true,
    onTimeout: "wait",
    requestedBy: "pipelines",
    ...overrides,
  };
}

describe("toDecisionInput", () => {
  it("maps the design note's shape: kinds, string options, the recommendation, the requester", () => {
    expect(toDecisionInput(request())).toEqual({
      project: "demo",
      kind: "spend",
      title: "Allow more GitHub-hosted runner minutes for demo in 2026-03?",
      context: "The private repository has used 9 of its 10 minutes.\n\nThis can be undone later.",
      options: [
        {
          id: "keep_the_budget_run_on_self_hosted_runne",
          label: "Keep the budget (run on self-hosted runners or this machine)",
          consequences: "Keep the budget (run on self-hosted runners or this machine)",
        },
        {
          id: "raise_executors_github_monthly_minutes",
          label: "Raise executors.github.monthly_minutes",
          consequences: "Raise executors.github.monthly_minutes",
        },
      ],
      recommended: {
        optionId: "keep_the_budget_run_on_self_hosted_runne",
        reasoning: "GitHub bills hosted minutes of private repositories.",
      },
      source: { module: "pipelines", ref: "pipelines:github-minutes:demo:2026-03" },
      key: "pipelines:github-minutes:demo:2026-03",
      blocks: ["pipelines:github-minutes:demo:2026-03"],
    });
    const kinds = ["product", "spend", "legal", "security", "credential", "release", "escalation", "other"] as const;
    expect(kinds.map((kind) => toDecisionInput(request({ kind })).kind)).toEqual([
      "pricing",
      "spend",
      "legal",
      "security",
      "credentials",
      "go_no_go",
      "escalation",
      "other",
    ]);
  });

  it("makes option ids from any labels, unique, and falls back for odd values", () => {
    const input = toDecisionInput(
      request({
        options: ["Yes", "Yes!", "42 more", "§§§"],
        recommended: "not one of them",
        requestedBy: "Not A Module",
        reversible: false,
      }),
    );
    expect(input.options.map((o) => o.id)).toEqual(["yes", "yes_2", "option_3", "option_4"]);
    expect(input.recommended.optionId).toBe("yes");
    expect(input.source.module).toBe("other");
    expect(input.context).toContain("This can't be undone.");
  });
});

describe("gate pipelines' decisions in the Decision Inbox", () => {
  async function mounted() {
    const dir = tempDir();
    const events = new EventBus();
    const app: FastifyInstance = Fastify();
    cleanups.push(() => app.close());
    const humanAuth = HumanAuth.open({ tokenPath: join(dir, "owner.token"), dbPath: ":memory:" });
    app.addHook("onClose", async () => humanAuth.close());
    const inbox = await mountDecisions(app, {
      dbPath: join(dir, "decisions.db"),
      humanAuth,
      defaultProject: () => "demo",
      events,
      sweepSeconds: 3600,
      env: {},
    });
    await app.ready();
    return { events, inbox };
  }

  it("the minutes budget's spend decision raised by the real pipeline arrives in the inbox, once, in the server", async () => {
    const { events, inbox } = await mounted();
    const p = await pipelines(events);

    await p.run(); // bills 9 of 10 hosted minutes
    expect(inbox.list()).toEqual([]);
    const second = await p.run(); // would go over: no hosted dispatch, one spend decision
    expect(second.jobs[0].executor).toBe("local");
    await p.run();

    const [decision, ...more] = inbox.list();
    expect(more).toEqual([]);
    expect(decision).toMatchObject({
      project: "demo",
      kind: "spend",
      status: "open",
      raisedVia: "server",
      title: "Allow more GitHub-hosted runner minutes for demo in 2026-03?",
      source: { module: "pipelines", ref: "pipelines:github-minutes:demo:2026-03" },
      key: "pipelines:github-minutes:demo:2026-03",
      recommended: { optionId: "keep_the_budget_run_on_self_hosted_runne" },
    });
    expect(decision.options.map((o) => o.label)).toEqual([
      "Keep the budget (run on self-hosted runners or this machine)",
      "Raise executors.github.monthly_minutes",
    ]);
    expect(decision.context).toContain("has used 9 of its 10 GitHub-hosted minutes this month");
    expect(decision.defaultOptionId).toBeUndefined();
    expect((await p.manager.status("demo")).decisions).toHaveLength(1);
  });

  it("keeps the answer for the pipelines module, which doesn't listen yet, and delivers it once a handler registers", async () => {
    const { events, inbox } = await mounted();
    const p = await pipelines(events);
    await p.run();
    await p.run();
    const [decision] = inbox.list();

    const answered = await inbox.answer(decision.id, { optionId: decision.recommended.optionId, confirm: true });
    expect(answered).toMatchObject({ status: "answered", answeredBy: "owner" });
    expect(answered.deliveredAt).toBeUndefined();
    // The pipeline goes on as before: the budget is executors.github.monthly_minutes in the project YAML
    const third = await p.run();
    expect(third.jobs[0].executor).toBe("local");
    expect(p.github.dispatches).toHaveLength(1);

    const resumed: DecisionResolution[] = [];
    inbox.onResolved("pipelines", (r) => {
      resumed.push(r);
    });
    await inbox.deliverPending();
    expect(resumed.map((r) => [r.decision.key, r.optionId])).toEqual([
      ["pipelines:github-minutes:demo:2026-03", "keep_the_budget_run_on_self_hosted_runne"],
    ]);
  });

  it("works as the pipeline's DecisionHook too", async () => {
    const store = new DecisionStore(":memory:");
    cleanups.push(() => store.close());
    const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore() });
    const events = new EventBus();
    const seen: unknown[] = [];
    events.on("decision.needed", (e) => {
      seen.push(e);
    });
    const p = await pipelines(events, new InboxDecisionHook(inbox));
    await p.run();
    await p.run();
    expect(inbox.list().map((d) => [d.kind, d.source.module])).toEqual([["spend", "pipelines"]]);
    // Given the hook, the pipeline emits no event
    expect(seen).toEqual([]);
  });

  it("drops malformed decision.needed events, and stops listening when asked", async () => {
    const store = new DecisionStore(":memory:");
    cleanups.push(() => store.close());
    const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore() });
    const events = new EventBus();
    const stop = listenForDecisionRequests(events, inbox);
    await events.emit("decision.needed", { key: "x" });
    await events.emit("decision.needed", { ...request(), options: [] });
    expect(inbox.list()).toEqual([]);
    await events.emit("decision.needed", { ...request() });
    expect(inbox.list()).toHaveLength(1);
    stop();
    await events.emit("decision.needed", { ...request(), key: "another" });
    expect(inbox.list()).toHaveLength(1);
  });
});
