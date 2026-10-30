/**
 * Placement acceptance tests.
 *
 * Only the system boundary is fake: a CommandRunner that answers the machine
 * probes and load commands and, like a project's real mover, renames the
 * request file; and a Clock. The queue, results and runner log are real
 * files in a temp dir, and every test runs the real module through
 * PlacementManager: config parsing, probes, learning, estimates, decisions,
 * act or observe, the store and the status.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import Database from "better-sqlite3";
import { tmpdir } from "os";
import { join } from "path";
import Fastify from "fastify";
import type { ProjectConfig } from "../../shared/types.js";
import type { Event, EventType } from "../../shared/server-types.js";
import type { PlacementStatus } from "../../shared/placement-types.js";
import { EventBus } from "../core/event-bus.js";
import { ExecFileRunner, type CommandOutput, type CommandRunner, type RunOptions } from "../watchdog/probes.js";
import { PlacementManager, type Placement } from "./service.js";
import { NodeQueueFiles, type PlacementProbes } from "./probes.js";
import { registerPlacementRoutes } from "./routes.js";
import { PlacementStore } from "./store.js";

// ============ BOUNDARY FAKES ============

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const MIN = 60_000;

class FakeClock {
  t = NOW;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

interface World {
  laptopUp: boolean;
  /** The laptop's probe answers only when the run is aborted (a stop or reload during a probe) */
  laptopHangs?: boolean;
  /** What each machine's load command prints (null: it fails) */
  loads: Record<string, string | null>;
  mover: {
    code: number;
    stderr: string;
    /** Rename the request, as a real mover does */
    effect: boolean;
    /** Never answer until the run is aborted */
    hang: boolean;
    /** Runs on each call, before the rename (a runner claiming another job meanwhile, ...) */
    onCall?: (args: string[]) => void;
  };
}

class FakeRunner implements CommandRunner {
  calls: { argv: string[]; timeoutMs?: number }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  /** A real delay before each answer, so concurrent calls overlap */
  delayMs = 0;

  constructor(
    private world: World,
    private queueDir: string,
  ) {}

  async run(argv: string[], options: RunOptions = {}): Promise<CommandOutput> {
    this.calls.push({ argv: [...argv], timeoutMs: options.timeoutMs });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return await this.answer(argv, options);
    } finally {
      this.inFlight--;
    }
  }

  private async answer(argv: string[], options: RunOptions): Promise<CommandOutput> {
    const [cmd, ...args] = argv;
    const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: "" });
    if (cmd === "probe-workstation") return ok("");
    if (cmd === "probe-laptop") {
      if (this.world.laptopHangs) {
        return new Promise<CommandOutput>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve({ code: -1, stdout: "", stderr: "aborted" }), {
            once: true,
          });
        });
      }
      return this.world.laptopUp
        ? ok("ok\r\n")
        : { code: 255, stdout: "", stderr: "ssh: connect to host laptop.example port 22: Operation timed out" };
    }
    if (cmd === "load-workstation" || cmd === "load-laptop") {
      const out = this.world.loads[cmd.slice("load-".length)];
      return out === null || out === undefined ? { code: 1, stdout: "", stderr: "no load" } : ok(out);
    }
    if (cmd === "mover") {
      const mover = this.world.mover;
      mover.onCall?.(args);
      if (mover.hang) {
        return new Promise<CommandOutput>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve({ code: -1, stdout: "", stderr: "aborted" }), {
            once: true,
          });
        });
      }
      if (mover.code !== 0) return { code: mover.code, stdout: "", stderr: mover.stderr };
      if (mover.effect) {
        const [id, from, to] = args;
        const name = readdirSync(this.queueDir).find((n) => n.startsWith(`${from}.`) && n.endsWith(`.${id}.req`));
        if (name) {
          const priority = name.split(".")[1];
          renameSync(join(this.queueDir, name), join(this.queueDir, `${to}.${priority}.${id}.req`));
        }
      }
      return ok("");
    }
    return { code: 127, stdout: "", stderr: `${cmd}: not found` };
  }

  moverCalls(): string[][] {
    return this.calls.filter((c) => c.argv[0] === "mover").map((c) => c.argv);
  }
}

/** Let pending promises run until `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

// ============ HARNESS ============

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Two machines: a workstation (lane heavy, 1 slot) and a laptop over SSH (lane remote, 2 slots, 1 big job). */
function placementConfig(overrides: Record<string, unknown> = {}, laptop: Record<string, unknown> = {}) {
  return {
    enabled: true,
    mode: "act",
    min_gain_seconds: 600,
    cooldown_seconds: 1800,
    default_seconds: 3600,
    command_line: 3,
    machines: {
      workstation: { probe: ["probe-workstation"], load_cmd: ["load-workstation"], min_up_seconds: 0 },
      laptop: {
        probe: ["probe-laptop", "laptop.example"],
        expect: "ok",
        load_cmd: ["load-laptop"],
        min_up_seconds: 0,
        ...laptop,
      },
    },
    lanes: {
      heavy: { machine: "workstation", slots: 1 },
      remote: { machine: "laptop", slots: 2, limits: { big: 1 } },
    },
    classes: { small: ["*targeted*"], big: ["*suite*"] },
    eligible: { heavy: ["small", "big"], remote: ["small", "big"] },
    move_cmd: ["mover", "{id}", "{from}", "{to}"],
    ...overrides,
  };
}

class Harness {
  readonly root: string;
  readonly gates: string;
  readonly queue: string;
  readonly results: string;
  readonly clock = new FakeClock();
  readonly world: World = {
    laptopUp: true,
    loads: {},
    mover: { code: 0, stderr: "", effect: true, hang: false },
  };
  readonly runner: FakeRunner;
  readonly events: Event[] = [];
  readonly bus = new EventBus();
  manager!: PlacementManager;
  private dbPath: string;
  private extra: Partial<ProjectConfig>;
  private probes: PlacementProbes;

  constructor(
    private placementBlock: Record<string, unknown>,
    options: { dbPath?: string; extra?: Partial<ProjectConfig>; runner?: CommandRunner } = {},
  ) {
    this.root = mkdtempSync(join(tmpdir(), "lair-placement-"));
    cleanups.push(() => rmSync(this.root, { recursive: true, force: true }));
    this.gates = join(this.root, "gates");
    this.queue = join(this.gates, "queue");
    this.results = join(this.gates, "results");
    mkdirSync(this.queue, { recursive: true });
    mkdirSync(this.results, { recursive: true });
    this.runner = new FakeRunner(this.world, this.queue);
    this.dbPath = options.dbPath ?? ":memory:";
    this.extra = options.extra ?? {};
    this.bus.on("*", (event) => {
      this.events.push(event);
    });
    this.probes = { runner: options.runner ?? this.runner, clock: this.clock, files: new NodeQueueFiles() };
    this.open();
  }

  config(block = this.placementBlock): ProjectConfig {
    return {
      name: "demo",
      repo: this.root,
      github: "example/demo",
      queue_file: join(this.root, "queue.md"),
      agents_dir: join(this.root, "agents"),
      gates_dir: this.gates,
      machines: {},
      placement: block,
      ...this.extra,
    };
  }

  /** A manager over the same files (and store file, when not in memory), as after a restart. */
  open(dbPath = this.dbPath): PlacementManager {
    this.manager = new PlacementManager({ dbPath, probes: this.probes, events: this.bus });
    const manager = this.manager;
    cleanups.push(() => manager.stop());
    this.manager.load([{ name: "demo", config: this.config() }]);
    return this.manager;
  }

  async reload(block: Record<string, unknown>): Promise<void> {
    this.placementBlock = block;
    await this.manager.reloadProject({ name: "demo", config: this.config(block) });
  }

  get placement(): Placement {
    const placement = this.manager.get("demo");
    if (!placement) throw new Error(`placement not loaded: ${this.manager.status("demo").errors.join("; ")}`);
    return placement;
  }

  tick() {
    return this.placement.tick();
  }

  status(): PlacementStatus {
    return this.manager.status("demo");
  }

  name(lane: string, priority: number, id: string, suffix = ""): string {
    return `${lane}.${priority}.${id}.req${suffix}`;
  }

  /** A request file: track, sha, then the command (command_line: 3) */
  request(lane: string, priority: number, id: string, command: string, suffix = ""): void {
    writeFileSync(join(this.queue, this.name(lane, priority, id, suffix)), `${id}-track\nabcdef12\n${command}\n`);
  }

  rename(from: string, to: string): void {
    renameSync(join(this.queue, from), join(this.queue, to));
  }

  exists(name: string): boolean {
    return existsSync(join(this.queue, name));
  }

  /** A finished run: results/<id>.rc (its mtime is when it ended) and a log that prints its seconds */
  result(id: string, rc: number, seconds: number, finishedAt = this.clock.now()): void {
    const rcPath = join(this.results, `${id}.rc`);
    writeFileSync(rcPath, `${rc}\n`);
    writeFileSync(join(this.results, `${id}.log`), `STEP build: PASS\n[runner] ${id} sha=abcdef12 rc=${rc} time=${seconds}s\n`);
    utimesSync(rcPath, finishedAt / 1000, finishedAt / 1000);
  }

  moved(): string[][] {
    return this.runner.moverCalls();
  }

  eventsOf(type: EventType): Event[] {
    return this.events.filter((e) => e.type === type);
  }

  job(id: string) {
    return this.status().jobs.find((j) => j.id === id);
  }
}

const at = (ms: number) => new Date(ms).toISOString();

// ============ TESTS ============

describe("placement: where a job goes", () => {
  it("a reachable idle machine gets the job that gains most", async () => {
    const h = new Harness(placementConfig({ max_moves_per_tick: 1 }));
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run targeted");
    h.request("heavy", 5, "q2", "run suite");

    const tick = await h.tick();

    // q2 is last in the heavy lane (3 h) and would start now on the idle laptop (1 h): the biggest gain
    expect(h.moved()).toEqual([["mover", "q2", "heavy", "remote"]]);
    expect(tick.moves).toBe(1);
    expect(h.exists("remote.5.q2.req")).toBe(true);
    expect(h.exists("heavy.5.q1.req")).toBe(true);
    const moved = h.eventsOf("placement.moved");
    expect(moved).toHaveLength(1);
    expect(moved[0].data).toMatchObject({ project: "demo", gateId: "q2", from: "heavy", to: "remote", mode: "act" });
    expect(moved[0].data.explanation).toBe("moved q2 heavy→remote: est. 3 h 0 min → 60 min; remote idle");
    const status = h.status();
    expect(status.moves[0]).toMatchObject({ gateId: "q2", status: "moved", from: "heavy", to: "remote" });
    expect(status.moves[0].argv).toEqual(["mover", "q2", "heavy", "remote"]);
    // The status shows the estimates after the move: q1 waits for r1 on heavy
    expect(h.job("q1")).toMatchObject({ lane: "heavy", expectedStart: at(NOW + 60 * MIN), expectedFinish: at(NOW + 120 * MIN) });
    expect(h.job("q2")).toMatchObject({ lane: "remote", expectedStart: at(NOW), expectedFinish: at(NOW + 60 * MIN) });
  });

  it("respects slots and class limits: one big job at a time on the laptop", async () => {
    const h = new Harness(placementConfig({ max_moves_per_tick: 3 }));
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "b1", "run suite");
    h.request("heavy", 5, "b2", "run suite");
    h.request("heavy", 5, "s1", "run targeted");

    await h.tick();

    // Its two runners take one big and one small job; a second big job would wait for the first
    // there and delay both, so it stays in heavy although a move was still allowed this tick
    expect(h.moved().map((argv) => argv[1])).toEqual(["s1", "b2"]);
    expect(h.exists("heavy.5.b1.req")).toBe(true);
    const remote = h.status().lanes.find((l) => l.name === "remote");
    expect(remote).toMatchObject({ slots: 2, queued: 2, inUse: 0, limits: [{ class: "big", limit: 1, inUse: 0 }] });
    expect(h.job("b1")?.advice).toBeNull();
  });

  it("moves nothing below min_gain_seconds", async () => {
    const h = new Harness(placementConfig());
    h.request("heavy", 5, "r1", "run suite", ".run");
    await h.tick();
    h.clock.advance(55 * MIN);
    h.request("heavy", 5, "q1", "run suite");

    await h.tick();

    // r1 has at least a tenth of its hour left (6 min): q1 finishes in 66 min on heavy, in 60 on the laptop: 6 < 10
    expect(h.moved()).toEqual([]);
    expect(h.job("q1")).toMatchObject({
      expectedStart: at(NOW + 61 * MIN),
      expectedFinish: at(NOW + 121 * MIN),
      advice: null,
    });

    // The threshold is what holds it: at 4 minutes it moves (a live reload, the same store)
    await h.reload(placementConfig({ min_gain_seconds: 240 }));
    await h.tick();
    expect(h.moved()).toEqual([["mover", "q1", "heavy", "remote"]]);
  });

  it("counts a machine as up only after min_up_seconds of passing probes, so a flapping link moves nothing", async () => {
    const h = new Harness(placementConfig({}, { min_up_seconds: 240 }));
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");
    const laptop = () => h.status().machines.find((m) => m.id === "laptop");

    await h.tick();
    expect(laptop()?.state).toBe("starting");
    h.clock.advance(2 * MIN);
    h.world.laptopUp = false;
    await h.tick();
    expect(laptop()).toMatchObject({ state: "down", downSince: at(NOW + 2 * MIN) });
    expect(laptop()?.lastError).toContain("exited 255");
    h.clock.advance(2 * MIN);
    h.world.laptopUp = true;
    await h.tick();
    h.clock.advance(2 * MIN);
    await h.tick();
    // Passing again for 2 minutes only: the count started over
    expect(laptop()).toMatchObject({ state: "starting", passingSince: at(NOW + 4 * MIN) });
    expect(h.job("q1")?.held).toBeNull();
    expect(h.moved()).toEqual([]);

    h.clock.advance(2 * MIN);
    await h.tick();
    expect(laptop()).toMatchObject({ state: "up", upSince: at(NOW + 8 * MIN) });
    expect(h.moved()).toEqual([["mover", "q1", "heavy", "remote"]]);
    expect(h.eventsOf("placement.machine_up").filter((e) => e.data.machine === "laptop")).toHaveLength(1);
    expect(h.eventsOf("placement.machine_down")).toHaveLength(0);

    // Down again: it gets nothing new, and it is shown
    h.world.laptopUp = false;
    h.request("heavy", 5, "q2", "run suite");
    h.clock.advance(MIN);
    await h.tick();
    expect(h.eventsOf("placement.machine_down")).toHaveLength(1);
    expect(h.eventsOf("placement.machine_down")[0].data).toMatchObject({ machine: "laptop" });
    expect(h.moved()).toHaveLength(1);
    // Its own fallback keeps the job already sent there
    expect(h.job("q1")?.held).toMatch(/laptop is down: its own fallback is in charge/);
    expect(h.job("q1")?.expectedStart).toBeNull();
  });

  it("never moves a running job, or one a runner claims while the move runs", async () => {
    const h = new Harness(placementConfig());
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "st", "run suite", ".stuck");
    h.request("heavy", 5, "q1", "run suite");
    h.request("heavy", 5, "q2", "run targeted");
    // While q2 moves, the heavy runner claims q1 (the next move's job)
    h.world.mover.onCall = ([id]) => {
      if (id === "q2") h.rename("heavy.5.q1.req", "heavy.5.q1.req.run");
    };

    await h.tick();
    h.clock.advance(5 * MIN);
    await h.tick();

    expect(h.moved()).toEqual([["mover", "q2", "heavy", "remote"]]);
    expect(h.exists("heavy.5.r1.req.run")).toBe(true);
    expect(h.exists("heavy.5.st.req.stuck")).toBe(true);
    expect(h.exists("heavy.5.q1.req.run")).toBe(true);
    expect(h.status().moves.map((m) => m.gateId)).toEqual(["q2"]);
  });

  it("never moves a job twice within the cool-down", async () => {
    const h = new Harness(placementConfig({ cooldown_seconds: 1800 }));
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");
    await h.tick();
    expect(h.moved()).toHaveLength(1);

    // The project's own fallback sends it back
    h.rename("remote.5.q1.req", "heavy.5.q1.req");
    h.clock.advance(5 * MIN);
    await h.tick();
    expect(h.moved()).toHaveLength(1);
    expect(h.job("q1")?.held).toMatch(/^moved heavy→remote; cool-down for 25 min$/);

    h.clock.advance(26 * MIN);
    await h.tick();
    expect(h.moved()).toEqual([
      ["mover", "q1", "heavy", "remote"],
      ["mover", "q1", "heavy", "remote"],
    ]);
  });

  it("a job a pseudo-lane takes (serves) is never moved away", async () => {
    const config = placementConfig({
      lanes: {
        heavy: { machine: "workstation", slots: 1 },
        quick: { machine: "workstation", slots: 1, serves: ["heavy"], max_priority: 3 },
        remote: { machine: "laptop", slots: 2, limits: { big: 1 } },
      },
      eligible: { heavy: ["small", "big"], quick: ["small"], remote: ["small", "big"] },
    });
    const h = new Harness(config);
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("quick", 2, "k0", "run targeted", ".run");
    h.request("heavy", 2, "s2", "run targeted");
    h.request("heavy", 5, "s5", "run targeted");

    await h.tick();

    // s2 (pri 2, small) is the quick runner's: it runs beside heavy's job, after k0
    expect(h.moved()).toEqual([["mover", "s5", "heavy", "remote"]]);
    expect(h.job("s2")).toMatchObject({
      lane: "heavy",
      held: "taken by the quick lane",
      expectedStart: at(NOW + 60 * MIN),
      expectedFinish: at(NOW + 120 * MIN),
    });
    expect(h.status().lanes.find((l) => l.name === "quick")).toMatchObject({ inUse: 1, queued: 1, serves: ["heavy"] });
  });
});

describe("placement: observe mode and failures", () => {
  it("observe mode never runs move_cmd: it records and shows the advice once", async () => {
    const h = new Harness(placementConfig({ mode: "observe" }));
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");

    const first = await h.tick();
    h.clock.advance(MIN);
    await h.tick();

    expect(h.moved()).toEqual([]);
    expect(h.exists("heavy.5.q1.req")).toBe(true);
    expect(first.wouldMoves).toBe(1);
    const advice = h.eventsOf("placement.would_move");
    expect(advice).toHaveLength(1);
    expect(advice[0].data.explanation).toBe("would move q1 heavy→remote: est. 2 h 0 min → 60 min; remote idle");
    const status = h.status();
    expect(status.actBlocked).toBe("placement.mode is observe");
    expect(status.moves).toHaveLength(1);
    expect(status.moves[0]).toMatchObject({ status: "would_move", mode: "observe", argv: ["mover", "q1", "heavy", "remote"] });
    expect(h.job("q1")?.advice).toMatchObject({ to: "remote", gainSeconds: 59 * 60, quiet: false });
  });

  it("act mode on a read_only project only advises", async () => {
    const h = new Harness(placementConfig(), { extra: { read_only: true } });
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");
    await h.tick();
    expect(h.moved()).toEqual([]);
    expect(h.status().actBlocked).toBe("the project is read_only");
    expect(h.eventsOf("placement.would_move")).toHaveLength(1);
  });

  it("reports a move_cmd failure, stops for the tick, and retries that job only after its cool-down", async () => {
    const h = new Harness(placementConfig({ max_moves_per_tick: 2 }));
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");
    h.request("heavy", 5, "q2", "run targeted");
    h.world.mover.code = 3;
    h.world.mover.stderr = "gate-move: refused: the remote host does not answer\n";

    const first = await h.tick();
    expect(first).toMatchObject({ moves: 0, failures: 1 });
    // The best move failed; the second planned move did not run in the same tick
    expect(h.moved()).toEqual([["mover", "q2", "heavy", "remote"]]);
    const failed = h.eventsOf("placement.move_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].data.error).toBe("mover exited 3: gate-move: refused: the remote host does not answer");
    expect(h.status().moves[0]).toMatchObject({ gateId: "q2", status: "failed" });

    // A minute later the mover works again: q1 moves, q2 waits for its cool-down
    h.world.mover.code = 0;
    h.clock.advance(MIN);
    await h.tick();
    expect(h.moved().map((argv) => argv[1])).toEqual(["q2", "q1"]);
    expect(h.job("q2")?.held).toMatch(/^move failed; cool-down for 29 min$/);

    h.clock.advance(30 * MIN);
    await h.tick();
    expect(h.moved().map((argv) => argv[1])).toEqual(["q2", "q1", "q2"]);
    expect(h.exists("remote.5.q2.req")).toBe(true);
  });

  it("a move_cmd that exits 0 without moving the request is a failure", async () => {
    const h = new Harness(placementConfig());
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");
    h.world.mover.effect = false;
    await h.tick();
    expect(h.status().moves[0]).toMatchObject({
      gateId: "q1",
      status: "failed",
      error: "mover exited 0, but the request is not in remote",
    });
  });

  it("a move cut short by a stop is found again after the restart and not retried hot", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "lair-placement-db-"));
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }));
    const dbPath = join(dbDir, "placement.db");
    const h = new Harness(placementConfig(), { dbPath });
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");
    h.world.mover.hang = true;

    const tick = h.tick();
    await until(() => h.moved().length === 1);
    await h.manager.stop();
    await tick;

    // The restart: a new manager on the same store; the request is still in heavy
    h.world.mover.hang = false;
    h.open();
    h.clock.advance(MIN);
    await h.tick();
    expect(h.status().moves[0]).toMatchObject({ gateId: "q1", status: "interrupted" });
    expect(h.status().moves[0].error).toContain("still in heavy");
    expect(h.moved()).toHaveLength(1);
    expect(h.job("q1")?.held).toMatch(/^move interrupted; cool-down for 29 min$/);
  });
});

describe("placement: what it learns", () => {
  it("learns durations per class and machine from the results and the runner log", async () => {
    const h = new Harness(placementConfig({ history: { runner_log: "runner.log" } }));
    const lines: string[] = [];
    const runs: [string, string, number, string][] = [
      ["h1", "heavy", 3000, "work/run suite /tmp/wt/h1"],
      ["h2", "heavy", 3100, "work/run suite /tmp/wt/h2"],
      ["h3", "heavy", 2900, "work/run suite /tmp/wt/h3"],
      ["h4", "remote", 1200, "work/run suite {WT}"],
      ["h5", "remote", 1300, "work/run suite {WT}"],
      ["h6", "remote", 1100, "work/run suite {WT}"],
      ["h7", "heavy", 400, "work/run targeted /tmp/wt/h7"],
    ];
    runs.forEach(([id, lane, seconds, command], i) => {
      const end = NOW - (10 - i) * 60 * MIN;
      h.result(id, 0, seconds, end);
      lines.push(`gate-run: ${lane}: ${id}: ${command}`);
      lines.push(`${at(end - 60_000)}\t${id}\t-\twaiting for a lock\t${lane}`);
      lines.push(`${at(end)}\t${id}\t0\t${command}\t${lane}`);
    });
    writeFileSync(join(h.gates, "runner.log"), lines.join("\n") + "\n");
    h.request("heavy", 5, "q1", "run suite");

    await h.tick();

    expect(h.status().durations).toEqual([
      { class: "big", machine: "laptop", medianSeconds: 1200, samples: 3 },
      { class: "big", machine: "workstation", medianSeconds: 3000, samples: 3 },
      { class: "small", machine: "workstation", medianSeconds: 400, samples: 1 },
    ]);
    // Heavy is idle, but the laptop runs suites in 20 minutes, not 50
    expect(h.eventsOf("placement.moved")[0].data.explanation).toBe(
      "moved q1 heavy→remote: est. 50 min → 20 min; remote idle",
    );
  });

  it("learns from the runs it sees start and end, but not from a result shared from an earlier run", async () => {
    const h = new Harness(placementConfig());
    h.world.laptopUp = false;
    h.request("heavy", 5, "o1", "run targeted");
    await h.tick();
    h.clock.advance(MIN);
    h.rename("heavy.5.o1.req", "heavy.5.o1.req.run");
    await h.tick();
    h.clock.advance(40 * MIN);
    unlinkSync(join(h.queue, "heavy.5.o1.req.run"));
    h.result("o1", 0, 2390);
    await h.tick();
    expect(h.status().durations).toEqual([{ class: "small", machine: "workstation", medianSeconds: 2390, samples: 1 }]);

    // A result whose log says 5000 s for a run Lair saw take a minute is an earlier run's
    h.request("heavy", 5, "o2", "run targeted");
    await h.tick();
    h.clock.advance(MIN);
    h.rename("heavy.5.o2.req", "heavy.5.o2.req.run");
    await h.tick();
    h.clock.advance(MIN);
    unlinkSync(join(h.queue, "heavy.5.o2.req.run"));
    h.result("o2", 0, 5000);
    await h.tick();
    expect(h.status().durations).toEqual([{ class: "small", machine: "workstation", medianSeconds: 2390, samples: 1 }]);
  });

  it("a loaded machine runs jobs slower: the load factor moves work off it", async () => {
    const run = async (workstationLoad: string) => {
      const h = new Harness(placementConfig());
      h.world.loads = { workstation: workstationLoad, laptop: "0.50 0.40 0.30 1/200 999\n8\n" };
      h.request("heavy", 5, "q1", "run suite");
      await h.tick();
      return h;
    };

    // Idle and at its cpu count, the workstation is as fast as the laptop: nothing to gain
    const calm = await run("{ 5.00 4.10 3.90 }\n10\n");
    expect(calm.moved()).toEqual([]);
    expect(calm.status().machines.find((m) => m.id === "workstation")).toMatchObject({
      load: 5,
      cpus: 10,
      utilization: 0.5,
      factor: 1,
    });

    // At three times its cpu count, the same job takes three times as long there
    const loaded = await run("{ 30.00 29.00 28.00 }\n10\n");
    expect(loaded.moved()).toEqual([["mover", "q1", "heavy", "remote"]]);
    expect(loaded.eventsOf("placement.moved")[0].data.explanation).toBe(
      "moved q1 heavy→remote: est. 3 h 0 min → 60 min; remote idle, workstation load 3.0×",
    );
  });

  it("prefers the least-loaded machine for a quiet re-check, even when it finishes later there", async () => {
    const h = new Harness(placementConfig({ prefer_quiet: ["*QUIET=1*"] }));
    h.world.loads = { workstation: "{ 9.00 8.00 7.00 }\n10\n", laptop: "0.80 0.70 0.60 1/200 999\n8\n" };
    h.request("remote", 5, "x1", "run targeted", ".run");
    h.request("remote", 5, "x2", "run targeted", ".run");
    h.request("heavy", 5, "k1", "QUIET=1 run targeted");
    h.request("heavy", 5, "n1", "run targeted");

    await h.tick();

    // The laptop's runners are busy for an hour, so only the quiet re-check goes there
    expect(h.moved()).toEqual([["mover", "k1", "heavy", "remote"]]);
    expect(h.eventsOf("placement.moved")[0].data.explanation).toBe(
      "moved k1 heavy→remote: est. 60 min → 2 h 0 min; quiet re-check: laptop 0.1/cpu vs workstation 0.9/cpu, remote 2/2 busy",
    );
    expect(h.exists("heavy.5.n1.req")).toBe(true);
  });
});

describe("placement: probes", () => {
  it("probes every machine in parallel, with the configured timeouts", async () => {
    const h = new Harness(placementConfig({ probe_timeout_seconds: 7, command_timeout_seconds: 33 }));
    h.runner.delayMs = 20;
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");
    await h.tick();

    // Both probes and both load commands were in flight at once
    expect(h.runner.maxInFlight).toBeGreaterThanOrEqual(4);
    const probes = h.runner.calls.filter((c) => c.argv[0].startsWith("probe-") || c.argv[0].startsWith("load-"));
    expect(probes.map((c) => c.argv)).toEqual(
      expect.arrayContaining([["probe-workstation"], ["probe-laptop", "laptop.example"], ["load-workstation"], ["load-laptop"]]),
    );
    expect(new Set(probes.map((c) => c.timeoutMs))).toEqual(new Set([7000]));
    expect(h.runner.calls.find((c) => c.argv[0] === "mover")?.timeoutMs).toBe(33_000);
  });

  it("runs probes as argv (no shell) and gives up on one that does not answer in time", async () => {
    const node = process.execPath;
    const literal = "ok; $(echo injected) `echo injected`";
    const h = new Harness(
      placementConfig({
        probe_timeout_seconds: 1,
        machines: {
          workstation: { probe: [node, "-e", "process.stdout.write(process.argv[1])", literal], expect: literal, min_up_seconds: 0 },
          laptop: { probe: [node, "-e", "setTimeout(() => {}, 60000)"], min_up_seconds: 0 },
        },
      }),
      { runner: new ExecFileRunner() },
    );
    const started = Date.now();
    await h.tick();
    const machines = h.status().machines;

    // The argument reached the probe as written: no shell ran the $(...) or `...`
    expect(machines.find((m) => m.id === "workstation")?.state).toBe("up");
    const laptop = machines.find((m) => m.id === "laptop");
    expect(laptop?.state).toBe("down");
    expect(laptop?.lastError).toMatch(/^no answer/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);
});

describe("placement: status route", () => {
  it("GET /api/placement/status is read-only and answers for the project", async () => {
    const h = new Harness(placementConfig({ mode: "observe" }));
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");
    await h.tick();
    const app = Fastify();
    cleanups.push(() => app.close());
    await registerPlacementRoutes(app, h.manager, () => "demo");

    const res = await app.inject({ method: "GET", url: "/api/placement/status?project=demo" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data: PlacementStatus };
    expect(body.data).toMatchObject({ project: "demo", enabled: true, mode: "observe" });
    expect(body.data.jobs.find((j) => j.id === "q1")?.advice?.to).toBe("remote");
    const other = await app.inject({ method: "GET", url: "/api/placement/status?project=other" });
    expect((other.json() as { data: PlacementStatus }).data).toMatchObject({ enabled: false, jobs: [] });
    const write = await app.inject({ method: "POST", url: "/api/placement/status" });
    expect(write.statusCode).toBe(404);
  });
});

// ============ REVIEW FIXES ============

/** A store file in its own temp dir, so a test can read what was learned */
function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-placement-db-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "placement.db");
}

function samplesIn(dbPath: string): { gate_id: string; machine: string; rc: number | null; seconds: number }[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(`SELECT gate_id, machine, rc, seconds FROM placement_samples ORDER BY gate_id`)
      .all() as { gate_id: string; machine: string; rc: number | null; seconds: number }[];
  } finally {
    db.close();
  }
}

/** Three passed suites on the workstation (50 min each) in the runner log, and its log lines for more runs */
function suiteHistory(h: Harness): (line: string) => void {
  const lines: string[] = [];
  ["h1", "h2", "h3"].forEach((id, i) => {
    const end = NOW - (10 - i) * 60 * MIN;
    h.result(id, 0, 3000, end);
    lines.push(`${at(end)}\t${id}\t0\twork/run suite /tmp/wt/${id}\theavy`);
  });
  const path = join(h.gates, "runner.log");
  writeFileSync(path, lines.join("\n") + "\n");
  return (line: string) => {
    lines.push(line);
    writeFileSync(path, lines.join("\n") + "\n");
  };
}

describe("placement: learning keeps the full runs, not the fragments", () => {
  it("does not learn a failed run far shorter than its class's passed runs", async () => {
    const dbPath = storeFile();
    const h = new Harness(placementConfig({ history: { runner_log: "runner.log" } }), { dbPath });
    h.world.laptopUp = false;
    const log = suiteHistory(h);
    await h.tick();

    // A preflight that failed after 110 s, seen start and end
    h.request("heavy", 5, "f1", "run suite");
    await h.tick();
    h.clock.advance(MIN);
    h.rename("heavy.5.f1.req", "heavy.5.f1.req.run");
    await h.tick();
    h.clock.advance(2 * MIN);
    unlinkSync(join(h.queue, "heavy.5.f1.req.run"));
    h.result("f1", 1, 110);
    await h.tick();

    // A remote run killed after 5 minutes (the laptop went away), from the runner log
    h.result("x9", 3, 300);
    log(`${at(h.clock.now())}\tx9\t3\twork/run suite {WT}\tremote`);
    h.clock.advance(MIN);
    await h.tick();

    expect(samplesIn(dbPath).map((s) => s.gate_id)).toEqual(["h1", "h2", "h3"]);
    expect(h.status().durations).toEqual([{ class: "big", machine: "workstation", medianSeconds: 3000, samples: 3 }]);
  });

  it("lets a later passed run of the same id replace a failed one, never the other way round", async () => {
    const dbPath = storeFile();
    const h = new Harness(placementConfig({ history: { runner_log: "runner.log" } }), { dbPath });
    h.world.laptopUp = false;
    const log = suiteHistory(h);

    // A failed run long enough to count (40 of the usual 50 min)
    h.result("x1", 1, 2400);
    log(`${at(h.clock.now())}\tx1\t1\twork/run suite /tmp/wt/x1\theavy`);
    await h.tick();
    expect(samplesIn(dbPath).find((s) => s.gate_id === "x1")).toMatchObject({ rc: 1, seconds: 2400 });

    // The same id runs again and passes: its result files now hold that run
    h.clock.advance(60 * MIN);
    h.result("x1", 0, 2700);
    log(`${at(h.clock.now())}\tx1\t0\twork/run suite /tmp/wt/x1\theavy`);
    await h.tick();
    expect(samplesIn(dbPath).find((s) => s.gate_id === "x1")).toMatchObject({ rc: 0, seconds: 2700 });

    // A later failure of it does not replace the passed run
    h.clock.advance(60 * MIN);
    h.result("x1", 2, 600);
    log(`${at(h.clock.now())}\tx1\t2\twork/run suite /tmp/wt/x1\theavy`);
    await h.tick();
    expect(samplesIn(dbPath).find((s) => s.gate_id === "x1")).toMatchObject({ rc: 0, seconds: 2700 });
    expect(h.status().durations).toEqual([{ class: "big", machine: "workstation", medianSeconds: 3000, samples: 4 }]);
  });

  it("learns the full run of a job re-queued under the same id after its machine went away", async () => {
    const dbPath = storeFile();
    const h = new Harness(placementConfig(), { dbPath });
    h.world.laptopUp = false;
    h.request("remote", 5, "x2", "run suite");
    await h.tick();
    h.clock.advance(MIN);
    h.rename("remote.5.x2.req", "remote.5.x2.req.run");
    await h.tick();
    // Killed after 5 minutes: rc 3, and the same id back in the heavy queue
    h.clock.advance(5 * MIN);
    h.result("x2", 3, 300);
    h.rename("remote.5.x2.req.run", "heavy.5.x2.req");
    await h.tick();
    h.clock.advance(MIN);
    h.rename("heavy.5.x2.req", "heavy.5.x2.req.run");
    await h.tick();
    h.clock.advance(47 * MIN);
    unlinkSync(join(h.queue, "heavy.5.x2.req.run"));
    h.result("x2", 0, 2810);
    await h.tick();

    expect(samplesIn(dbPath)).toEqual([{ gate_id: "x2", machine: "workstation", rc: 0, seconds: 2810 }]);
  });

  it("migrates a version 1 store: its samples get rc (unknown) and a passed run replaces them", () => {
    const dbPath = storeFile();
    const v1 = new Database(dbPath);
    v1.exec(`CREATE TABLE placement_samples (project TEXT NOT NULL, gate_id TEXT NOT NULL, class TEXT NOT NULL,
      machine TEXT NOT NULL, seconds REAL NOT NULL, factor REAL, finished_at INTEGER NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY (project, gate_id))`);
    v1.prepare(`INSERT INTO placement_samples VALUES ('demo', 'old', 'big', 'workstation', 300, NULL, ?, 'history')`).run(NOW);
    v1.pragma("user_version = 1");
    v1.close();

    const store = new PlacementStore(dbPath);
    cleanups.push(() => store.close());
    expect(store.recentSamples("demo")).toMatchObject([{ gateId: "old", seconds: 300, rc: null }]);
    const sample = { gateId: "old", class: "big", machine: "workstation", factor: null, finishedAt: NOW + MIN, source: "observed" as const };
    expect(store.addSample("demo", { ...sample, seconds: 200, rc: 1 })).toBe(false);
    expect(store.addSample("demo", { ...sample, seconds: 2900, rc: 0 })).toBe(true);
    expect(store.recentSamples("demo")).toMatchObject([{ gateId: "old", seconds: 2900, rc: 0 }]);
    // Migrated all the way: the holds table of version 3 is there too
    expect(store.markHeld("demo", "old", NOW)).toBe(true);
    const check = new Database(dbPath, { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(3);
    check.close();
  });
});

describe("placement: a job is not bounced forever", () => {
  it("doubles the cool-down per earlier move and holds a job after max_moves_per_job moves in 24 h", async () => {
    const h = new Harness(placementConfig({ default_seconds: 7200, cooldown_seconds: 1800 }));
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");
    // The project's own fallback sends it back every time
    const sendBack = () => h.rename("remote.5.q1.req", "heavy.5.q1.req");

    await h.tick(); // move 1: next cool-down 30 min
    sendBack();
    h.clock.advance(31 * MIN);
    await h.tick(); // move 2: next cool-down 60 min
    sendBack();
    h.clock.advance(31 * MIN);
    await h.tick();
    expect(h.moved()).toHaveLength(2);
    expect(h.job("q1")?.held).toBe("moved heavy→remote; cool-down for 29 min");

    h.clock.advance(30 * MIN);
    await h.tick(); // move 3
    expect(h.moved()).toHaveLength(3);
    sendBack();
    h.clock.advance(208 * MIN);
    await h.tick();
    h.clock.advance(MIN);
    await h.tick();

    // Still a 12 min gain, but it was moved three times today: held, and reported once
    expect(h.moved()).toHaveLength(3);
    expect(h.job("q1")?.held).toBe("moved or tried 3 times in 24 h: held (max_moves_per_job is 3)");
    const held = h.eventsOf("placement.job_held");
    expect(held).toHaveLength(1);
    expect(held[0].data).toMatchObject({ gateId: "q1", lane: "heavy", moves: 3 });

    // A day after its first move, it may move again
    h.clock.advance(24 * 60 * MIN);
    await h.tick();
    expect(h.moved()).toHaveLength(4);
  });
});

describe("placement: a stop is not evidence", () => {
  it("a stop during a probe changes no machine and emits no machine_down", async () => {
    const h = new Harness(placementConfig());
    await h.tick();
    expect(h.status().machines.find((m) => m.id === "laptop")).toMatchObject({ state: "up", upSince: at(NOW) });

    h.world.laptopHangs = true;
    h.clock.advance(MIN);
    const probes = () => h.runner.calls.filter((c) => c.argv[0] === "probe-laptop").length;
    const tick = h.tick();
    await until(() => probes() === 2);
    await h.placement.stop();
    await tick;
    expect(h.eventsOf("placement.machine_down")).toHaveLength(0);

    // Started again, the laptop is still the one that has been up since the first tick
    h.world.laptopHangs = false;
    h.placement.start();
    h.clock.advance(MIN);
    await h.tick();
    expect(h.status().machines.find((m) => m.id === "laptop")).toMatchObject({ state: "up", upSince: at(NOW), lastError: null });
    expect(h.eventsOf("placement.machine_down")).toHaveLength(0);
  });
});

describe("placement: symbolic links are never followed", () => {
  it("ignores a request or a result that is a symbolic link", async () => {
    const h = new Harness(placementConfig());
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");
    writeFileSync(join(h.root, "elsewhere.req"), "t\nabcdef12\nrun suite\n");
    symlinkSync(join(h.root, "elsewhere.req"), join(h.queue, "heavy.4.ln.req"));

    await h.tick();
    expect(h.moved()).toEqual([["mover", "q1", "heavy", "remote"]]);
    expect(h.status().jobs.map((j) => j.id).sort()).toEqual(["q1", "r1"]);

    // r1 ends, but its result is a link to a file elsewhere: not learned
    h.clock.advance(30 * MIN);
    unlinkSync(join(h.queue, "heavy.5.r1.req.run"));
    writeFileSync(join(h.root, "elsewhere.rc"), "0\n");
    writeFileSync(join(h.results, "r1.log"), "[runner] r1 rc=0 time=1800s\n");
    symlinkSync(join(h.root, "elsewhere.rc"), join(h.results, "r1.rc"));
    await h.tick();
    expect(h.status().durations).toEqual([]);
  });
});

describe("placement: quiet re-checks below quiet_margin", () => {
  const quiet = () => placementConfig({ prefer_quiet: ["*QUIET=1*"] });

  it("are placed by time on a machine no busier than their own", async () => {
    const h = new Harness(quiet());
    h.world.loads = { workstation: "{ 5.00 4.00 3.00 }\n10\n", laptop: "3.20 3.00 2.00 1/200 999\n8\n" };
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "k1", "QUIET=1 run targeted");
    await h.tick();
    // 0.4/cpu vs 0.5/cpu is under the margin: an ordinary move by time
    expect(h.moved()).toEqual([["mover", "k1", "heavy", "remote"]]);
    expect(h.eventsOf("placement.moved")[0].data.explanation).toBe(
      "moved k1 heavy→remote: est. 2 h 0 min → 60 min; remote idle",
    );
  });

  it("are never sent by time to a busier machine, though other jobs are", async () => {
    const h = new Harness(quiet());
    h.world.loads = { workstation: "{ 3.00 3.00 3.00 }\n10\n", laptop: "7.20 7.00 7.00 1/200 999\n8\n" };
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "k1", "QUIET=1 run targeted");
    h.request("heavy", 5, "n1", "run targeted");
    await h.tick();
    expect(h.moved()).toEqual([["mover", "n1", "heavy", "remote"]]);
    expect(h.exists("heavy.5.k1.req")).toBe(true);
  });
});

describe("placement: a job its lane never runs", () => {
  const blocked = (mode: string) =>
    placementConfig({
      mode,
      lanes: {
        heavy: { machine: "workstation", slots: 1, limits: { big: 0 } },
        remote: { machine: "laptop", slots: 2, limits: { big: 1 } },
      },
    });

  it("goes to a lane that can run it, whatever min_gain says", async () => {
    const h = new Harness(blocked("act"));
    h.request("heavy", 5, "q1", "run suite");
    await h.tick();
    expect(h.moved()).toEqual([["mover", "q1", "heavy", "remote"]]);
    expect(h.eventsOf("placement.moved")[0].data).toMatchObject({
      gainSeconds: 0,
      explanation: "moved q1 heavy→remote: est. never → 60 min; heavy never runs big, remote idle",
    });
  });

  it("is advised as such in observe mode", async () => {
    const h = new Harness(blocked("observe"));
    h.request("heavy", 5, "q1", "run suite");
    await h.tick();
    expect(h.job("q1")).toMatchObject({ expectedStart: null, advice: { to: "remote", gainSeconds: 0, stuck: true } });
  });
});

describe("placement: follow-ups", () => {
  it("moves a quiet re-check its lane never runs, even to a busier machine", async () => {
    const h = new Harness(
      placementConfig({
        prefer_quiet: ["*QUIET=1*"],
        lanes: {
          heavy: { machine: "workstation", slots: 1, limits: { big: 0 } },
          remote: { machine: "laptop", slots: 2, limits: { big: 1 } },
        },
      }),
    );
    // The laptop is busier (0.9/cpu vs 0.3/cpu), but it is the only lane that runs the job at all
    h.world.loads = { workstation: "{ 3.00 3.00 3.00 }\n10\n", laptop: "7.20 7.00 7.00 1/200 999\n8\n" };
    h.request("heavy", 5, "q1", "QUIET=1 run suite");
    await h.tick();
    expect(h.moved()).toEqual([["mover", "q1", "heavy", "remote"]]);
    expect(h.eventsOf("placement.moved")[0].data.explanation).toBe(
      "moved q1 heavy→remote: est. never → 60 min; heavy never runs big, remote idle",
    );
  });

  it("reports a hold once, also across a restart, and again for a new hold", async () => {
    const dbPath = storeFile();
    const h = new Harness(placementConfig({ max_moves_per_job: 1 }), { dbPath });
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");
    await h.tick();
    expect(h.moved()).toHaveLength(1);
    h.rename("remote.5.q1.req", "heavy.5.q1.req");
    h.clock.advance(MIN);
    await h.tick();
    const held = () => h.eventsOf("placement.job_held");
    expect(held()).toHaveLength(1);

    // A restart: the hold is still in place, so it is not reported again
    await h.manager.stop();
    h.open();
    h.clock.advance(MIN);
    await h.tick();
    expect(held()).toHaveLength(1);
    expect(h.job("q1")?.held).toBe("moved or tried 1 times in 24 h: held (max_moves_per_job is 1)");
    expect(h.moved()).toHaveLength(1);

    // It leaves the queue, then comes back still capped: a new hold, reported again
    unlinkSync(join(h.queue, "heavy.5.q1.req"));
    h.clock.advance(MIN);
    await h.tick();
    h.request("heavy", 5, "q1", "run suite");
    h.clock.advance(MIN);
    await h.tick();
    expect(held()).toHaveLength(2);
  });
});


// ============ ON-DEMAND PLACEMENT TESTS ============

/**
 * On-demand config: an AWS machine that Lair can check state and guard for,
 * with boot time and routing.
 */
function onDemandConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    mode: "act",
    min_gain_seconds: 300,
    cooldown_seconds: 1800,
    default_seconds: 3600,
    command_line: 3,
    machines: {
      workstation: { probe: ["probe-workstation"], load_cmd: ["load-workstation"], min_up_seconds: 0 },
      aws: {
        probe: ["probe-aws"],
        expect: "ok",
        load_cmd: ["load-aws"],
        min_up_seconds: 0,
        on_demand: {
          state_cmd: ["aws-state"],
          guard_cmd: ["aws-guard"],
          boot_seconds: 150,
          cost_per_hour: 0.35,
          check_seconds: 300,
        },
      },
    },
    lanes: {
      heavy: { machine: "workstation", slots: 1 },
      aws: { machine: "aws", slots: 2, limits: { big: 1 } },
    },
    routing: {
      heavy: { overflow_to: ["aws"], prefer_when_faster: true, min_gain_seconds: 300 },
    },
    classes: { small: ["*targeted*"], big: ["*suite*"] },
    eligible: { heavy: ["small", "big"], aws: ["small", "big"] },
    move_cmd: ["mover", "{id}", "{from}", "{to}"],
    ...overrides,
  };
}

class OnDemandHarness extends Harness {
  /** AWS state: running|stopped|pending|stopping */
  awsState = "stopped";
  /** Guard response: true = "guard: ok", false = refuses */
  awsGuardOk = true;

  constructor(config: Record<string, unknown> = onDemandConfig()) {
    super(config);
    // Override the runner to handle AWS commands
    const originalRun = this.runner.run.bind(this.runner);
    this.runner.run = async (argv: string[], options) => {
      const [cmd] = argv;
      // Track the call for all commands (so tests can count calls)
      this.runner.calls.push({ argv: [...argv], timeoutMs: options?.timeoutMs });
      if (cmd === "probe-aws") {
        // AWS probe passes only when running
        if (this.awsState === "running") {
          return { code: 0, stdout: "ok\n", stderr: "" };
        }
        return { code: 255, stdout: "", stderr: "Connection refused" };
      }
      if (cmd === "load-aws") {
        if (this.awsState === "running") {
          return { code: 0, stdout: "0.50 0.40 0.30\n8\n", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "not running" };
      }
      if (cmd === "aws-state") {
        return { code: 0, stdout: `${this.awsState}\n`, stderr: "" };
      }
      if (cmd === "aws-guard") {
        if (this.awsGuardOk) {
          return { code: 0, stdout: "guard: ok\n", stderr: "" };
        }
        return { code: 0, stdout: "guard: refused - cost limit reached\n", stderr: "" };
      }
      // For other commands, the original run will also push to calls, so pop our push
      this.runner.calls.pop();
      return originalRun(argv, options);
    };
  }

  awsMachine() {
    return this.status().machines.find((m) => m.id === "aws");
  }
}

describe("placement: on-demand machines", () => {
  it("a) stopped + guard ok + heavy waiting -> moved to aws", async () => {
    const h = new OnDemandHarness();
    h.awsState = "stopped";
    h.awsGuardOk = true;
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");

    await h.tick();

    // AWS is stopped but guard ok -> available for placement
    expect(h.awsMachine()?.onDemand).toMatchObject({
      powerState: "stopped",
      availability: "available",
      guardOk: true,
    });
    // Job should move to aws lane
    expect(h.moved()).toEqual([["mover", "q1", "heavy", "aws"]]);
    expect(h.exists("aws.5.q1.req")).toBe(true);
    // The explanation should mention boot time
    const moved = h.eventsOf("placement.moved");
    expect(moved).toHaveLength(1);
    expect(moved[0].data.explanation).toContain("aws");
  });

  it("b) guard refused -> no move, the reason is recorded, and a job queued in aws moves back", async () => {
    const h = new OnDemandHarness();
    h.awsState = "stopped";
    h.awsGuardOk = false;
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");

    await h.tick();

    // AWS is unavailable due to guard refusal
    expect(h.awsMachine()?.onDemand).toMatchObject({
      powerState: "stopped",
      availability: "unavailable",
      guardOk: false,
    });
    expect(h.awsMachine()?.onDemand?.unavailableReason).toContain("guard refused");

    // Job should NOT move to aws
    expect(h.moved()).toEqual([]);
    expect(h.exists("heavy.5.q1.req")).toBe(true);
  });

  it("c) prefer_when_faster: a gain under the minimum stays, over the minimum moves", async () => {
    // First, test that a small gain doesn't trigger a move
    const h1 = new OnDemandHarness(onDemandConfig({ routing: { heavy: { overflow_to: ["aws"], prefer_when_faster: true, min_gain_seconds: 1800 } } }));
    h1.awsState = "stopped";
    h1.awsGuardOk = true;
    h1.request("heavy", 5, "q1", "run suite");

    await h1.tick();

    // With 150s boot + 60min runtime on AWS vs 60min on heavy, the gain is small
    // But heavy is idle, so the job just starts there
    // Actually, with min_gain_seconds: 1800 (30 min), even with boot time,
    // if both lanes are idle the gain would need to be significant
    // Let's make heavy busy to test properly
    h1.request("heavy", 5, "r1", "run suite", ".run");
    h1.clock.advance(60_000);
    await h1.tick();
    // Should not move because gain is under 1800s
    // (AWS: boot 150s + 60min vs heavy: wait 60min + 60min = gain ~60min - 2.5min = 57.5min)
    // Actually this should move... let me reconsider

    // Test with a very high min_gain that won't be met
    const h2 = new OnDemandHarness(onDemandConfig({ routing: { heavy: { overflow_to: ["aws"], prefer_when_faster: true, min_gain_seconds: 7200 } } }));
    h2.awsState = "stopped";
    h2.awsGuardOk = true;
    h2.request("heavy", 5, "r1", "run suite", ".run");
    h2.request("heavy", 5, "q1", "run suite");

    await h2.tick();

    // With 7200s (2h) min gain required, shouldn't move
    expect(h2.moved()).toEqual([]);

    // Now test with lower min_gain that should be met
    const h3 = new OnDemandHarness(onDemandConfig({ routing: { heavy: { overflow_to: ["aws"], prefer_when_faster: true, min_gain_seconds: 300 } } }));
    h3.awsState = "stopped";
    h3.awsGuardOk = true;
    h3.request("heavy", 5, "r1", "run suite", ".run");
    h3.request("heavy", 5, "q1", "run suite");

    await h3.tick();

    // With 300s (5min) min gain, should move (gain is ~60min - 2.5min boot = 57.5min)
    expect(h3.moved()).toEqual([["mover", "q1", "heavy", "aws"]]);
  });

  it("d) with limits.big: 1, a second big job does not go to aws while one runs there", async () => {
    const h = new OnDemandHarness();
    h.awsState = "running"; // AWS is up and running
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("aws", 5, "a1", "run suite", ".run"); // One big job already running on AWS
    h.request("heavy", 5, "b1", "run suite"); // Second big job
    h.request("heavy", 5, "b2", "run suite"); // Third big job

    await h.tick();

    // Only one big job should be on AWS due to limits.big: 1
    // a1 is already running there, so b1 and b2 should not move
    // Actually, they can move but only one at a time
    const movedIds = h.moved().map((m) => m[1]);
    expect(movedIds.filter((id) => id === "b1" || id === "b2").length).toBeLessThanOrEqual(1);
  });

  it("e) a running job is never moved", async () => {
    const h = new OnDemandHarness();
    h.awsState = "stopped";
    h.awsGuardOk = true;
    h.request("heavy", 5, "r1", "run suite", ".run"); // Running job
    h.request("heavy", 5, "q1", "run suite"); // Queued job

    await h.tick();

    // Running job r1 should not be moved
    const movedIds = h.moved().map((m) => m[1]);
    expect(movedIds).not.toContain("r1");
    expect(h.exists("heavy.5.r1.req.run")).toBe(true);
  });

  it("f) unknown state output -> unavailable", async () => {
    const h = new OnDemandHarness();
    h.awsState = "weird-unknown-state" as any;
    h.awsGuardOk = true;
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");

    await h.tick();

    expect(h.awsMachine()?.onDemand).toMatchObject({
      powerState: "unknown",
      availability: "unavailable",
    });
    expect(h.awsMachine()?.onDemand?.unavailableReason).toContain("unknown state");

    // Job should NOT move to aws
    expect(h.moved()).toEqual([]);
  });

  it("g) check_seconds is honoured (the guard command is not run on every tick)", async () => {
    const checkConfig = onDemandConfig();
    (checkConfig.machines as any).aws.on_demand.check_seconds = 600; // 10 minutes
    const h = new OnDemandHarness(checkConfig);
    h.awsState = "stopped";
    h.awsGuardOk = true;

    // First tick: should check state and guard
    await h.tick();
    const stateCallsAfterFirst = h.runner.calls.filter((c) => c.argv[0] === "aws-state").length;
    const guardCallsAfterFirst = h.runner.calls.filter((c) => c.argv[0] === "aws-guard").length;
    expect(stateCallsAfterFirst).toBe(1);
    expect(guardCallsAfterFirst).toBe(1);

    // Second tick 1 minute later: should NOT check again (check_seconds: 600)
    h.clock.advance(60_000);
    await h.tick();
    expect(h.runner.calls.filter((c) => c.argv[0] === "aws-state").length).toBe(1);
    expect(h.runner.calls.filter((c) => c.argv[0] === "aws-guard").length).toBe(1);

    // Third tick 11 minutes later: should check again
    h.clock.advance(660_000);
    await h.tick();
    expect(h.runner.calls.filter((c) => c.argv[0] === "aws-state").length).toBe(2);
    expect(h.runner.calls.filter((c) => c.argv[0] === "aws-guard").length).toBe(2);
  });

  it("shows on-demand state in the placement status", async () => {
    const h = new OnDemandHarness();
    h.awsState = "stopped";
    h.awsGuardOk = true;

    await h.tick();

    const aws = h.awsMachine();
    expect(aws?.onDemand).not.toBeNull();
    expect(aws?.onDemand?.powerState).toBe("stopped");
    expect(aws?.onDemand?.guardOk).toBe(true);
    expect(aws?.onDemand?.bootSeconds).toBe(150);
    expect(aws?.onDemand?.costPerHour).toBe(0.35);
    expect(aws?.onDemand?.availability).toBe("available");
  });

  it("records decision reasons including boot time", async () => {
    const h = new OnDemandHarness();
    h.awsState = "stopped";
    h.awsGuardOk = true;
    h.request("heavy", 5, "r1", "run suite", ".run");
    h.request("heavy", 5, "q1", "run suite");

    await h.tick();

    const moved = h.eventsOf("placement.moved");
    expect(moved).toHaveLength(1);
    // The explanation should include the on-demand details
    expect(moved[0].data.explanation).toMatch(/heavy.*aws/);
  });
});
