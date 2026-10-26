/**
 * Classification and the action for each class, through the production
 * path: TriageManager -> TriageService.ingest -> parsers -> classifier ->
 * real SQLite store -> command adapters. Only the command runner (which
 * records argv), the clock and git are fake.
 */
import { afterEach, describe, expect, it } from "vitest";
import { actingTriage, fixture, gate, harness, MIN, sha, step, type Harness } from "./test-harness.js";
import type { IngestContext } from "./service.js";

let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const OrderApiIT = "com.example.shop.api.OrderApiIT";
const PaymentApiIT = "com.example.shop.api.PaymentApiIT";

/** A one-test JUnit report: `test` in `suite` failed with `message`. */
function junitOne(suite: string, test: string, message: string): string {
  const simple = suite.split(".").pop();
  return `<testsuite name="${suite}"><testcase classname="${suite}" name="${test}">
<failure message="${message}" type="java.lang.AssertionError">java.lang.AssertionError: ${message}
	at ${suite}.${test.replace(/\(\)$/, "")}(${simple}.java:10)
</failure></testcase></testsuite>`;
}

function contextFailure(t: Harness, commit: string, context: IngestContext = {}) {
  return t.service.ingest({
    result: gate({ sha: commit, branch: "feat/orders", steps: [step("lint", "passed"), step("test", "failed")] }),
    reports: [{ step: "test", content: fixture("junit-context-failure.xml") }],
    context: { agent: "worker-a", ...context },
  });
}

describe("classifier", () => {
  it("infra: a context failure whose Caused by chain is a connection timeout, with the matching line as evidence", async () => {
    h = harness(actingTriage());
    const out = await contextFailure(h, sha("p1"));
    expect(out.record.causes).toHaveLength(1);
    const [c] = out.record.causes;
    expect(c.cause.testCount).toBe(4);
    expect(c.verdict).toMatchObject({ class: "infra", rule: "infra-pattern:connection-timeout", infraKind: "network" });
    expect(c.verdict.evidence[0]).toBe(
      "Caused by: java.net.SocketTimeoutException: connect timed out (matches infra pattern connection-timeout)",
    );
    expect(c.verdict.evidence).toContain(
      "one context failure for 4 test(s): the tests never ran, so this is not the change",
    );
    expect(out.record).toMatchObject({ verdict: "infra", blocking: true });
    expect(h.events.getRecentEvents("triage.classified")).toHaveLength(1);
  });

  it("infra patterns are configurable: a project pattern adds one, default_infra_patterns: false drops the built-ins", async () => {
    h = harness(
      actingTriage({
        infra_patterns: [{ id: "license-server", kind: "network", pattern: "license server .* unreachable" }],
        default_infra_patterns: false,
      }),
    );
    const own = await h.service.ingest({
      result: gate({ sha: sha("p1"), branch: "feat/a", steps: [step("build", "failed", "error: license server lic.example unreachable\n", 2)] }),
    });
    expect(own.record.causes[0].verdict).toMatchObject({ class: "infra", rule: "infra-pattern:license-server" });

    const builtin = await contextFailure(h, sha("p2"));
    expect(builtin.record.causes[0].verdict.class).toBe("code");
  });

  it("pre-existing: the same test failed in the base commit's latest result", async () => {
    h = harness(actingTriage());
    const base = sha("b0");
    await h.service.ingest({
      result: gate({ sha: base, branch: "feat/base" }),
      reports: [{ content: junitOne("com.example.shop.CartTest", "addsItem()", "expected 2 items") }],
    });
    const out = await h.service.ingest({
      result: gate({ sha: sha("p1"), branch: "feat/stacked" }),
      reports: [{ content: junitOne("com.example.shop.CartTest", "addsItem()", "expected 2 items") }],
      context: { baseSha: base, agent: "worker-a", changedFiles: ["src/main/java/com/example/shop/Cart.java"] },
    });
    const [c] = out.record.causes;
    expect(c.verdict).toMatchObject({ class: "pre-existing", rule: "failed-on-base" });
    expect(c.verdict.evidence[0]).toMatch(/^CartTest#addsItem\(\) also failed on the base commit 6230/);
    expect(out.record).toMatchObject({ verdict: "pre-existing", blocking: false });
  });

  it("flaky: the test passed at the same commit within the window; outside the window it is not", async () => {
    h = harness(actingTriage({ flaky: { window_minutes: 60 } }));
    const at = sha("s1");
    const report = junitOne("com.example.shop.CartTest", "addsItem()", "expected 2 items");
    // An earlier run at the same commit failed for another reason, but its report shows the test passing
    await h.service.ingest({
      result: gate({ sha: at, branch: "feat/cart", steps: [step("lint", "failed", "", 1), step("test", "passed")] }),
      reports: [{ content: `<testsuite name="com.example.shop.CartTest"><testcase classname="com.example.shop.CartTest" name="addsItem()"/></testsuite>` }],
    });
    h.clock.advance(10 * MIN);
    const flaky = await h.service.ingest({ result: gate({ sha: at, branch: "feat/cart" }), reports: [{ content: report }] });
    expect(flaky.record.causes[0].verdict).toMatchObject({ class: "flaky", rule: "passed-at-same-sha" });
    expect(flaky.record.blocking).toBe(false);

    h.clock.advance(120 * MIN);
    const late = await h.service.ingest({ result: gate({ sha: at, branch: "feat/cart" }), reports: [{ content: report }] });
    expect(late.record.causes[0].verdict.class).toBe("code");
  });

  it("code: near the changed files, with the files and the base comparison as evidence", async () => {
    h = harness(actingTriage());
    const base = sha("m0");
    await h.service.ingest({ result: gate({ sha: base, branch: "main", status: "passed" }) });
    const out = await h.service.ingest({
      result: gate({ sha: sha("p1"), branch: "feat/tax" }),
      reports: [{ content: fixture("junit-assertion.xml") }],
      context: { baseSha: base, agent: "worker-a", changedFiles: ["app/src/main/java/com/example/shop/orders/OrderService.java"] },
    });
    const [assertion] = out.record.causes;
    expect(assertion.verdict).toMatchObject({ class: "code", rule: "near-change", confidence: "high" });
    expect(assertion.verdict.evidence).toHaveLength(3);
    expect(assertion.verdict.evidence[0]).toBe("near the change: app/src/main/java/com/example/shop/orders/OrderService.java");
    expect(assertion.verdict.evidence[1]).toMatch(new RegExp(`^the base commit passed at ${base.slice(0, 8)} \\(result [0-9a-f]{8}\\)$`));
    expect(assertion.verdict.evidence[2]).toBe("org.opentest4j.AssertionFailedError: expected: <108> but was: <100>");
    expect(out.record).toMatchObject({ verdict: "code", blocking: true });
  });

  it("code: the changed files come from git when only the base is given", async () => {
    h = harness(actingTriage());
    const base = sha("m0");
    const head = sha("p1");
    h.git.changed.set(`${base}...${head}`, ["app/src/main/java/com/example/shop/orders/OrderService.java"]);
    const out = await h.service.ingest({
      result: gate({ sha: head, branch: "feat/tax" }),
      reports: [{ content: fixture("junit-assertion.xml") }],
      context: { baseSha: base },
    });
    expect(h.git.calls).toContain(`diff ${base}...${head}`);
    expect(out.record.changedFiles).toEqual(["app/src/main/java/com/example/shop/orders/OrderService.java"]);
    expect(out.record.causes[0].verdict.rule).toBe("near-change");
  });

  it("infra is decided before pre-existing: the base failing the same way doesn't make it the base's problem", async () => {
    h = harness(actingTriage());
    const base = sha("b0");
    await contextFailure(h, base, { agent: undefined });
    const out = await contextFailure(h, sha("p1"), { baseSha: base });
    expect(out.record.causes[0].verdict.class).toBe("infra");
  });

  it("a timeout while the machine was overloaded is infra (load)", async () => {
    h = harness(actingTriage({ overload_per_core: 1.5 }));
    const out = await h.service.ingest({
      result: gate({ sha: sha("p1"), branch: "feat/a" }),
      reports: [{ content: junitOne("com.example.shop.SearchIT", "findsItems()", "Timed out after 30 seconds waiting for the index") }],
      context: { loadPerCore: 3.2 },
    });
    expect(out.record.causes[0].verdict).toMatchObject({ class: "infra", rule: "timeout-under-load", infraKind: "load" });
  });
});

describe("actions: infra", () => {
  it("re-checks ONLY the failed classes at the same commit, once, and unblocks when it passes", async () => {
    h = harness(actingTriage());
    const p1 = sha("p1");
    const out = await contextFailure(h, p1);
    expect(out.rechecks).toHaveLength(1);
    const [recheck] = out.rechecks;
    expect(recheck).toMatchObject({ purpose: "infra", status: "requested", attempt: 1, sha: p1, steps: ["test"] });
    expect(recheck.classes).toEqual([OrderApiIT, PaymentApiIT]);
    expect(recheck.tests).toEqual([
      `${OrderApiIT}#createsOrder()`,
      `${OrderApiIT}#listsOrders()`,
      `${OrderApiIT}#cancelsOrder()`,
      `${PaymentApiIT}#refundsPayment()`,
    ]);
    // Never the passing MoneyTest, never the whole suite
    expect(h.runner.callsTo("./bin/recheck")).toEqual([
      ["./bin/recheck", `--sha=${p1}`, `--request=${recheck.id}`, "--steps=test", OrderApiIT, PaymentApiIT],
    ]);
    expect(out.record).toMatchObject({ blocking: true, retries: 1 });

    const answer = await h.service.ingest({
      result: gate({ id: "recheck-1", sha: p1, branch: "feat/orders", status: "passed", steps: [step("test", "passed")] }),
      context: { recheckId: recheck.id },
    });
    expect(answer.record).toMatchObject({ purpose: "recheck", status: "passed", blocking: false, originId: out.record.id });
    const origin = h.manager.getStore()!.getRecord(out.record.id)!;
    expect(origin.blocking).toBe(false);
    expect(origin.resolution).toBe("re-check 1 passed at the same commit: it was infrastructure");
    expect(h.manager.getStore()!.getRecheck(recheck.id)!.status).toBe("passed");
    expect(h.runner.callsTo("./bin/recheck")).toHaveLength(1);
  });

  it("waits for capacity, then re-checks", async () => {
    h = harness(actingTriage({ recheck: { capacity_cmd: ["./bin/capacity"] } }));
    let busy = true;
    h.runner.when(
      (argv) => argv[0] === "./bin/capacity",
      () => (busy ? { code: 1, stdout: "", stderr: "load 9.5 per core" } : { code: 0, stdout: "ok", stderr: "" }),
    );
    const out = await contextFailure(h, sha("p1"));
    expect(out.rechecks[0]).toMatchObject({
      status: "waiting_capacity",
      reason: "waiting for capacity: ./bin/capacity exited 1: load 9.5 per core",
    });
    expect(h.runner.callsTo("./bin/recheck")).toHaveLength(0);

    await h.service.tick();
    expect(h.runner.callsTo("./bin/recheck")).toHaveLength(0);
    busy = false;
    await h.service.tick();
    expect(h.runner.callsTo("./bin/recheck")).toHaveLength(1);
    expect(h.manager.getStore()!.getRecheck(out.rechecks[0].id)!.status).toBe("requested");
  });

  it("runs at most max_concurrent re-checks at a time", async () => {
    h = harness(actingTriage());
    const first = await contextFailure(h, sha("p1"));
    const second = await contextFailure(h, sha("p2"));
    expect(second.rechecks[0]).toMatchObject({ status: "waiting_capacity" });
    expect(second.rechecks[0].reason).toContain("1 re-check(s) running (max_concurrent 1)");
    await h.service.ingest({
      result: gate({ sha: sha("p1"), branch: "feat/orders", status: "passed", steps: [step("test", "passed")] }),
      context: { recheckId: first.rechecks[0].id },
    });
    expect(h.runner.callsTo("./bin/recheck").map((c) => c[1])).toEqual([`--sha=${sha("p1")}`, `--sha=${sha("p2")}`]);
  });

  it("stops after max_retries and asks the human when the base can't show the environment works", async () => {
    h = harness(actingTriage());
    const p1 = sha("p1");
    const out = await contextFailure(h, p1);
    const again = await h.service.ingest({
      result: gate({ sha: p1, branch: "feat/orders", steps: [step("test", "failed")] }),
      reports: [{ step: "test", content: fixture("junit-context-failure.xml") }],
      context: { recheckId: out.rechecks[0].id },
    });
    expect(again.record.causes[0].verdict.class).toBe("infra");
    expect(h.runner.callsTo("./bin/recheck")).toHaveLength(1);
    expect(h.manager.getStore()!.getRecord(out.record.id)!.retries).toBe(1);
    expect(again.record.resolution).toBe("infra: still failing after 1 re-check(s); asked the human");
    expect(h.inbox()).toMatch(
      /^- OWNER\? 2026-03-02T12:00:00\.000Z \[triage:infra:[0-9a-f]{8}\] demo: Gate gate-703100 at 70310000 on feat\/orders still fails with an infrastructure error after 1 re-check\(s\)\./,
    );
    // Asked once per failure
    await h.service.tick();
    expect(h.inbox().match(/OWNER\?/g)).toHaveLength(1);
  });

  it("after max_retries, routes to the author when the base passes", async () => {
    h = harness(actingTriage());
    const base = sha("m0");
    await h.service.ingest({ result: gate({ sha: base, branch: "main", status: "passed" }) });
    const p1 = sha("p1");
    const out = await contextFailure(h, p1, { baseSha: base, changedFiles: ["src/main/resources/application.yml"] });
    await h.service.ingest({
      result: gate({ sha: p1, branch: "feat/orders", steps: [step("test", "failed")] }),
      reports: [{ step: "test", content: fixture("junit-context-failure.xml") }],
      context: { recheckId: out.rechecks[0].id },
    });
    const notes = h.runner.callsTo("./bin/notify");
    expect(notes).toHaveLength(1);
    expect(notes[0][1]).toBe("worker-a");
    expect(notes[0][2]).toContain(`still failing after 1 re-check(s) at the same commit while ${base.slice(0, 8)} passes`);
    expect(h.inbox()).toBe("");
  });

  it("re-checks only the failed step when the failure has no tests (never a full re-run)", async () => {
    h = harness(actingTriage());
    const p2 = sha("p2");
    const out = await h.service.ingest({
      result: gate({
        sha: p2,
        branch: "feat/infra",
        steps: [
          step("lint", "passed"),
          step("integration", "failed", "starting services\nCannot connect to the Docker daemon at unix:///var/run/docker.sock\n", 1),
          step("e2e", "skipped"),
        ],
      }),
    });
    expect(out.record.causes[0].verdict).toMatchObject({ class: "infra", rule: "infra-pattern:container-start" });
    expect(h.runner.callsTo("./bin/recheck")).toEqual([
      ["./bin/recheck", `--sha=${p2}`, `--request=${out.rechecks[0].id}`, "--steps=integration"],
    ]);
  });

  it("in observe mode records the re-check it would run and runs nothing", async () => {
    h = harness({ ...actingTriage(), mode: "observe" });
    const out = await contextFailure(h, sha("p1"));
    expect(out.rechecks[0].status).toBe("planned");
    expect(h.runner.calls).toEqual([]);
    const planned = out.actions.find((a) => a.kind === "recheck" && a.status === "planned");
    expect(planned?.argv?.[0]).toBe("./bin/recheck");
    expect(planned?.detail).toContain("not run: triage.mode is observe");
  });
});

describe("actions: pre-existing, flaky, code", () => {
  it("pre-existing doesn't block, and creates ONE fix task on the default branch however many PRs hit it", async () => {
    h = harness(actingTriage());
    const m1 = sha("m1");
    const report = junitOne("com.example.shop.CartTest", "addsItem()", "expected 2 items");
    const main = await h.service.ingest({ result: gate({ sha: m1, branch: "main" }), reports: [{ content: report }] });
    expect(main.record).toMatchObject({ verdict: "code", blocking: true });
    expect(main.incident?.status).toBe("open");

    const pr1 = await h.service.ingest({
      result: gate({ sha: sha("p1"), branch: "feat/one" }),
      reports: [{ content: report }],
      context: { baseSha: m1, agent: "worker-a" },
    });
    const pr2 = await h.service.ingest({
      result: gate({ sha: sha("p2"), branch: "feat/two" }),
      reports: [{ content: report }],
      context: { baseSha: m1, agent: "worker-b" },
    });
    for (const pr of [pr1, pr2]) {
      expect(pr.record).toMatchObject({ verdict: "pre-existing", blocking: false, resolution: "not blocking: pre-existing on the default branch" });
      expect(pr.record.causes[0].verdict.evidence[0]).toContain("the default branch is red with the same tests");
    }
    const tasks = h.runner.callsTo("./bin/task");
    expect(tasks).toEqual([["./bin/task", "fix", "Fix on main: CartTest#addsItem(): java.lang.AssertionError: expected 2 items"]]);
    expect(h.manager.getStore()!.listTasks("demo")).toHaveLength(1);
    expect(pr2.actions.some((a) => a.kind === "fix_task" && a.status === "skipped")).toBe(true);
    // Nothing goes back to the PRs' agents
    expect(h.runner.callsTo("./bin/notify")).toEqual([]);
  });

  it("flaky: recorded each time; flaky twice in a row opens ONE reliability task and quarantines the test", async () => {
    h = harness(actingTriage());
    const report = junitOne("com.example.shop.CartTest", "addsItem()", "expected 2 items");
    const store = () => h!.manager.getStore()!;

    const failThenPass = async (label: string) => {
      const at = sha(label);
      const failed = await h!.service.ingest({ result: gate({ sha: at, branch: `feat/${label}` }), reports: [{ content: report }], context: { agent: "worker-a" } });
      expect(failed.record.verdict).toBe("code");
      await h!.service.ingest({ result: gate({ sha: at, branch: `feat/${label}`, status: "passed" }) });
      return store().getRecord(failed.record.id)!;
    };

    const first = await failThenPass("s1");
    expect(first).toMatchObject({ verdict: "flaky", blocking: false });
    expect(first.causes[0].verdict.rule).toBe("passed-at-same-sha");
    expect(store().getFlaky("demo", "CartTest#addsItem()")?.occurrences).toBe(1);
    expect(h.runner.callsTo("./bin/task")).toEqual([]);

    await failThenPass("s2");
    expect(h.runner.callsTo("./bin/task")).toEqual([["./bin/task", "reliability", "Flaky test: CartTest#addsItem()"]]);
    const flaky = store().getFlaky("demo", "CartTest#addsItem()")!;
    expect(flaky.occurrences).toBe(2);
    expect(flaky.quarantinedAt).toBeDefined();
    expect(store().listTasks("demo", "open")[0].body).toContain("Make it reliable by 2026-03-09T12:00:00.000Z");

    // Quarantined: it still runs, it no longer blocks, and no second task is opened
    const third = await h.service.ingest({ result: gate({ sha: sha("s3"), branch: "feat/s3" }), reports: [{ content: report }] });
    expect(third.record.causes[0].verdict).toMatchObject({ class: "flaky", rule: "quarantined" });
    expect(third.record.blocking).toBe(false);
    expect(h.runner.callsTo("./bin/task")).toHaveLength(1);
    expect(store().getFlaky("demo", "CartTest#addsItem()")?.occurrences).toBe(3);
  });

  it("a test that failed and passed on a rerun inside one run is recorded as flaky", async () => {
    h = harness(actingTriage());
    await h.service.ingest({
      result: gate({ sha: sha("p1"), branch: "feat/a", status: "passed", steps: [step("test", "passed")] }),
      reports: [{ content: fixture("junit-assertion.xml") }],
    });
    expect(h.manager.getStore()!.getFlaky("demo", "OrderServiceTest#appliesDiscount()")?.occurrences).toBe(1);
  });

  it("code goes back to the author agent with the failing tests and a log excerpt", async () => {
    h = harness(actingTriage());
    const out = await h.service.ingest({
      result: gate({ id: "gate-tax-1", sha: sha("p5"), branch: "feat/tax" }),
      reports: [{ content: fixture("junit-assertion.xml") }],
      context: { agent: "worker-a", pr: 42, changedFiles: ["app/src/main/java/com/example/shop/orders/OrderService.java"] },
    });
    expect(out.record).toMatchObject({ verdict: "code", blocking: true, resolution: "code: back to the author" });
    const notes = h.runner.callsTo("./bin/notify");
    expect(notes).toHaveLength(1);
    const [, agent, text] = notes[0];
    expect(agent).toBe("worker-a");
    expect(text.split("\n")[0]).toBe(`Gate gate-tax-1 failed at ${sha("p5").slice(0, 8)} on feat/tax. 2 cause(s) to fix:`);
    expect(text).toContain("failing tests (1): com.example.shop.orders.OrderServiceTest#totalIncludesTax()");
    expect(text).toContain("| org.opentest4j.AssertionFailedError: expected: <108> but was: <100>");
    expect(text).toContain("at: com/example/shop/orders/OrderService.java:88");
    expect(text).toContain("Field error in object 'orderRequest' on field 'quantity'");
    expect(text).toContain("why: near the change: app/src/main/java/com/example/shop/orders/OrderService.java");
    expect(out.actions.find((a) => a.kind === "route")).toMatchObject({ status: "done", argv: notes[0] });
  });

  it("with no notify command, the route is still recorded and emitted for the agents module", async () => {
    h = harness({ enabled: true, mode: "act" });
    const out = await h.service.ingest({
      result: gate({ sha: sha("p5"), branch: "feat/tax" }),
      reports: [{ content: fixture("junit-assertion.xml") }],
      context: { agent: "worker-a" },
    });
    expect(out.actions.find((a) => a.kind === "route")).toMatchObject({ status: "recorded" });
    const [event] = h.events.getRecentEvents("triage.routed");
    expect(event.data).toMatchObject({ project: "demo", agent: "worker-a", recordId: out.record.id });
    expect(String(event.data.text)).toContain("OrderServiceTest#totalIncludesTax()");
  });
});
