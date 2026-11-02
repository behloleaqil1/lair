/**
 * AI spend's record of a supervisor run (docs/design/ai-spend.md §4.2): SupervisorStore.spendVerdict, which the server
 * wires into the agents module's classes (src/server/index.ts), on a real store.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SupervisorStore, type StoredConversation, type StoredTurn } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-03-02T12:00:00.000Z");

describe("AI spend: a supervisor run's record", () => {
  it("answered is productive, closed without an answer idle, waiting pending; another project's run or none is null", () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-supervisor-spend-"));
    dirs.push(dir);
    const store = new SupervisorStore(join(dir, "supervisor.db"));
    const conversation: StoredConversation = { id: "c-1", project: "demo", kind: "chat", digestDate: null, createdAt: NOW, updatedAt: NOW };
    const turn = (n: number, runId: string): StoredTurn => ({
      id: `t-${n}`,
      conversationId: "c-1",
      seq: n,
      question: "Why is the gate red?",
      askedAt: NOW,
      state: "pending",
      runId,
      agent: "sup",
      task: `supervisor-ask-c1-${n}`,
      deadlineAt: NOW + 600_000,
      answer: null,
      evidence: [],
      answeredAt: null,
      reason: null,
    });
    store.addTurn(conversation, turn(1, "run-answered"), true);
    store.addTurn(conversation, turn(2, "run-closed"), false);
    store.addTurn(conversation, turn(3, "run-waiting"), false);
    expect(store.answerTurn("t-1", "The lint step failed.", [], NOW + 60_000)).toBe(true);
    expect(store.closeTurn("t-2", "its run ended without an answer", NOW + 60_000)).toBe(true);
    expect(store.spendVerdict("demo", "run-answered")).toBe("productive");
    expect(store.spendVerdict("demo", "run-closed")).toBe("idle");
    expect(store.spendVerdict("demo", "run-waiting")).toBe("pending");
    expect(store.spendVerdict("other", "run-answered")).toBeNull();
    expect(store.spendVerdict("demo", "run-unknown")).toBeNull();
    store.close();
  });
});
