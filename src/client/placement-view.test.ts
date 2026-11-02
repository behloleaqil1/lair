import { describe, expect, it } from "vitest";
import {
  adviceText,
  eta,
  laneSlots,
  latestMoves,
  machineBadge,
  machineLoad,
  machineState,
  modeText,
  onDemandText,
} from "./placement-view";
import type { PlacementJob, PlacementMachine, PlacementStatus } from "../shared/placement-types";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");

function job(overrides: Partial<PlacementJob> = {}): PlacementJob {
  return {
    id: "q1",
    lane: "heavy",
    priority: 5,
    status: "queued",
    class: "big",
    expectedStart: null,
    expectedFinish: null,
    held: null,
    advice: null,
    ...overrides,
  };
}

function machine(overrides: Partial<PlacementMachine> = {}): PlacementMachine {
  return {
    id: "laptop",
    state: "up",
    passingSince: null,
    upSince: "2026-03-02T11:00:00.000Z",
    downSince: null,
    lastProbeAt: null,
    lastError: null,
    load: null,
    cpus: null,
    utilization: null,
    factor: 1,
    onDemand: null,
    ...overrides,
  };
}

function status(overrides: Partial<PlacementStatus> = {}): PlacementStatus {
  return {
    project: "demo",
    enabled: true,
    running: true,
    mode: "observe",
    actBlocked: "placement.mode is observe",
    errors: [],
    intervalSeconds: 60,
    lastTick: null,
    lastError: null,
    machines: [],
    lanes: [],
    jobs: [],
    moves: [],
    durations: [],
    ...overrides,
  };
}

describe("placement view", () => {
  it("shows the advice, or why a job stays", () => {
    const advice = { to: "remote", gainSeconds: 34 * 60, explanation: "x", quiet: false, stuck: false };
    expect(adviceText(job({ advice }), "observe")).toBe("would move to remote: −34 min");
    expect(adviceText(job({ advice: { ...advice, gainSeconds: -12 * 60, quiet: true } }), "observe")).toBe(
      "would move to remote: +12 min (quiet re-check)",
    );
    expect(adviceText(job({ advice: { ...advice, gainSeconds: 0, stuck: true } }), "act")).toBe(
      "moving to remote: heavy never runs it",
    );
    expect(adviceText(job({ held: "taken by the quick lane" }), "act")).toBe("taken by the quick lane");
    expect(adviceText(undefined, "act")).toBe("-");
  });

  it("shows expected times from now", () => {
    expect(eta(new Date(NOW + 90 * 60_000).toISOString(), NOW)).toBe("in 90 min");
    expect(eta(new Date(NOW + 150 * 60_000).toISOString(), NOW)).toBe("in 2 h 30 min");
    expect(eta(new Date(NOW - 60_000).toISOString(), NOW)).toBe("now");
    expect(eta(null, NOW)).toBe("-");
  });

  it("shows a machine's probe state and load, and a lane's slots", () => {
    expect(machineState(machine({ state: "down", downSince: null }))).toBe("down since ?");
    expect(machineState(machine({ state: "unknown" }))).toBe("not probed yet");
    expect(machineLoad(machine())).toBe("-");
    expect(machineLoad(machine({ load: 31, cpus: 10, factor: 3.1 }))).toBe("31.00 on 10 cpus (3.1×)");
    expect(
      laneSlots({
        name: "remote",
        machine: "laptop",
        slots: 2,
        inUse: 1,
        queued: 3,
        limits: [{ class: "big", limit: 1, inUse: 1 }],
        serves: [],
      }),
    ).toBe("1/2 in use, 3 queued; big 1/1");
  });

  it("shows an on-demand machine's power state and a move back out of it", () => {
    const onDemand = {
      powerState: "stopped" as const,
      availability: "available" as const,
      unavailableReason: null,
      guardOk: true,
      lastCheckAt: null,
      bootSeconds: 150,
      costPerHour: 0.35,
      lastTouchAt: null,
      touchError: null,
    };
    const stopped = machine({ id: "aws", state: "down", downSince: null, onDemand });
    expect(machineState(stopped)).toBe("down since ? · on demand: stopped, guard ok, 150 s boot");
    expect(machineBadge(stopped)).toBe("badge-neutral");
    const refused = machine({
      state: "down",
      downSince: null,
      onDemand: { ...onDemand, availability: "unavailable", guardOk: false, unavailableReason: "guard refused: spend 181 >= 180" },
    });
    expect(onDemandText(refused)).toBe("on demand: refused (guard refused: spend 181 >= 180)");
    expect(machineBadge(refused)).toBe("badge-error");
    expect(onDemandText(machine({ onDemand: { ...onDemand, availability: "unavailable", powerState: "pending" } }))).toBe(
      "on demand: starting",
    );
    expect(onDemandText(machine({ onDemand: { ...onDemand, availability: "unavailable", powerState: "running" } }))).toBe(
      "on demand: running",
    );
    expect(onDemandText(machine())).toBeNull();
    expect(machineState(machine({ state: "unknown" }))).toBe("not probed yet");

    const advice = { to: "heavy", gainSeconds: 0, explanation: "x", quiet: false, stuck: false, back: "aws guard refused: spend" };
    expect(adviceText(job({ lane: "aws", advice }), "observe")).toBe("would move to heavy: aws guard refused: spend");
  });

  it("names the mode and lists the newest moves first", () => {
    expect(modeText(status())).toBe("observe: advice only");
    expect(modeText(status({ mode: "act", actBlocked: "the project is read_only" }))).toBe(
      "observe: advice only (the project is read_only)",
    );
    expect(modeText(status({ mode: "act", actBlocked: null }))).toBe("act: moves jobs");
    const move = (id: string, at: string) => ({
      id,
      gateId: id,
      from: "heavy",
      to: "remote",
      mode: "act" as const,
      status: "moved" as const,
      gainSeconds: 600,
      explanation: "",
      argv: null,
      error: null,
      at,
      completedAt: null,
    });
    const moves = latestMoves(status({ moves: [move("a", "2026-03-02T10:00:00Z"), move("b", "2026-03-02T11:00:00Z")] }));
    expect(moves.map((m) => m.id)).toEqual(["b", "a"]);
  });
});
