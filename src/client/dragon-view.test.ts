/**
 * What the Dragons view shows for a dragon (dragon-view.ts): runs of the
 * agents module, the default model and the last log time.
 */
import { describe, expect, it } from "vitest";
import type { Dragon } from "../shared/types";
import { logTimeLabel, modelLabel, runningLabel } from "./dragon-view";

const dragon = (overrides: Partial<Dragon> = {}): Dragon => ({
  id: "kiro-A",
  name: "Smaug",
  task: "fix-login",
  running: false,
  ...overrides,
});

describe("dragons view", () => {
  it("shows a dragon the agents module runs as running, with the run's state and 'managed by Lair'", () => {
    const managed = dragon({
      running: true,
      managedRun: { runId: "1a2b3c4d-0000-4000-8000-000000000000", task: "feat-login", state: "working", detail: "pid 5001" },
    });
    expect(runningLabel(managed)).toEqual({ text: "Running", badge: "badge-success", detail: "working, managed by Lair" });
    const hung = dragon({ running: true, managedRun: { runId: "r", task: "t", state: "hung", detail: "" } });
    expect(runningLabel(hung)).toEqual({ text: "Running", badge: "badge-error", detail: "hung, managed by Lair" });
    const waiting = dragon({ running: true, managedRun: { runId: "r", task: "t", state: "waiting_on_lock", detail: "" } });
    expect(runningLabel(waiting).detail).toBe("waiting on lock, managed by Lair");
    expect(runningLabel(dragon({ running: true }))).toEqual({ text: "Running", badge: "badge-success", detail: null });
    expect(runningLabel(dragon())).toEqual({ text: "Idle", badge: "badge-neutral", detail: null });
  });

  it("marks a model that came from the default", () => {
    expect(modelLabel(dragon({ model: "model-default", modelFromDefault: true }))).toBe("model-default (default)");
    expect(modelLabel(dragon({ model: "model-own", modelFromDefault: false }))).toBe("model-own");
    expect(modelLabel(dragon())).toBe("-");
  });

  it("says when the log time is unknown instead of showing nothing", () => {
    expect(logTimeLabel(dragon())).toBe("log time unknown");
    expect(logTimeLabel(dragon({ lastLogTime: "not a time" }))).toBe("log time unknown");
    const iso = "2026-10-27T04:10:41.000Z";
    expect(logTimeLabel(dragon({ lastLogTime: iso }))).toBe(new Date(iso).toLocaleString());
  });
});
