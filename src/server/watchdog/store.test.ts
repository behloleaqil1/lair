/**
 * The watchdog store's Decision Inbox links, and the upgrade of a file
 * written before they existed (schema version 1).
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WatchdogStore } from "./store.js";
import type { Finding } from "./types.js";

const AT = "2026-03-02T12:00:00.000Z";
const finding: Finding = {
  detector: "orphan_claim",
  key: "orphan_claim:worker-b.running",
  summary: "Claim worker-b.running has no live agent process",
  evidence: ["claim is 20 min old"],
  vars: { agent: "worker-b", claim: "/home/user/project/agents/worker-b.running" },
};

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("WatchdogStore decision links", () => {
  it("upgrades a version 1 file: its breaches stay and decision links work", () => {
    dir = mkdtempSync(join(tmpdir(), "lair-watchdog-store-"));
    const path = join(dir, "watchdog.db");
    const original = new WatchdogStore(path);
    const breach = original.createBreach("demo", finding, AT);
    original.close();

    // Turn it back into a version 1 file
    const raw = new Database(path);
    raw.exec("DROP TABLE watchdog_breach_decisions");
    raw.pragma("user_version = 1");
    raw.close();

    const upgraded = new WatchdogStore(path);
    expect(upgraded.getBreach(breach.id)).toMatchObject({ key: finding.key, status: "open" });
    expect(upgraded.breachDecision(breach.id)).toBeNull();
    upgraded.linkDecision(breach.id, "demo", "decision-1", AT);
    expect(upgraded.breachDecision(breach.id)).toEqual({
      breachId: breach.id,
      project: "demo",
      decisionId: "decision-1",
      state: "open",
      updatedAt: AT,
    });
    upgraded.close();
    const check = new Database(path);
    expect(check.pragma("user_version", { simple: true })).toBe(2);
    check.close();
  });

  it("records an answer only for the open link to that decision", () => {
    const store = new WatchdogStore(":memory:");
    const breach = store.createBreach("demo", finding, AT);
    store.linkDecision(breach.id, "demo", "decision-1", AT);

    expect(store.answerDecision("decision-0", "run", AT)).toBe(false);
    expect(store.answerDecision("decision-1", "run", AT)).toBe(true);
    // A repeated delivery changes nothing
    expect(store.answerDecision("decision-1", "stand_down", AT)).toBe(false);
    expect(store.breachDecision(breach.id)?.state).toBe("run");

    expect(store.moveDecision(breach.id, "open", "closed", AT)).toBe(false);
    expect(store.moveDecision(breach.id, "run", "done", AT)).toBe(true);
    expect(store.moveDecision(breach.id, "run", "done", AT)).toBe(false);

    // Asking again replaces the decision and reopens the link; the old one no longer counts
    store.linkDecision(breach.id, "demo", "decision-2", AT);
    expect(store.breachDecision(breach.id)).toMatchObject({ decisionId: "decision-2", state: "open" });
    expect(store.answerDecision("decision-1", "run", AT)).toBe(false);

    store.recordEscalation({ project: "demo", breachId: breach.id, createdAt: AT, text: "- OWNER? ...\n" });
    expect(store.listEscalations("demo")).toMatchObject([{ breachId: breach.id, decisionId: "decision-2" }]);
    store.close();
  });
});
