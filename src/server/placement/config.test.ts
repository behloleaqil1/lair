import { describe, expect, it } from "vitest";
import { buildMoveArgv, compilePattern, parsePlacementConfig } from "./config.js";
import { classify, requestCommand } from "./queue.js";
import { parseLoad } from "./service.js";

const valid = {
  enabled: true,
  machines: { a: { probe: ["true"] }, b: { probe: ["ssh", "b.example", "echo", "ok"], expect: "ok" } },
  lanes: { main: { machine: "a" }, spare: { machine: "b", slots: 2, limits: { big: 1 } } },
  classes: { small: ["*targeted*"], big: ["*suite*"] },
  eligible: { main: ["small", "big"], spare: ["big"] },
  move_cmd: ["./mover", "{id}", "{from}", "{to}"],
};

function errors(raw: unknown): string[] {
  const parsed = parsePlacementConfig(raw);
  return parsed.ok ? [] : parsed.errors;
}

describe("placement config", () => {
  it("is off without a block, and applies the defaults", () => {
    const off = parsePlacementConfig(undefined);
    expect(off.ok && off.settings.enabled).toBe(false);
    const parsed = parsePlacementConfig(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings).toMatchObject({
      mode: "observe",
      intervalSeconds: 60,
      maxMovesPerTick: 2,
      minGainSeconds: 600,
      cooldownSeconds: 1800,
      commandLine: 1,
    });
    expect(parsed.settings.machines[0]).toMatchObject({ id: "a", minUpSeconds: 240 });
    expect(parsed.settings.lanes.map((l) => [l.name, l.slots, l.eligible])).toEqual([
      ["main", 1, ["small", "big"]],
      ["spare", 2, ["big"]],
    ]);
  });

  it("refuses references to unknown machines, lanes and classes", () => {
    expect(
      errors({
        ...valid,
        lanes: { main: { machine: "nowhere", limits: { huge: 1 } }, extra: { machine: "a", serves: ["missing"] } },
        eligible: { main: ["tiny"], ghost: ["big"] },
      }),
    ).toEqual([
      "placement.lanes.main.machine: nowhere is not in placement.machines",
      "placement.lanes.main.limits: huge is not in placement.classes",
      "placement.lanes.extra.serves: missing is not in placement.lanes",
      "placement.eligible.main: tiny is not in placement.classes",
      "placement.eligible.ghost: ghost is not in placement.lanes",
    ]);
  });

  it("refuses act mode without move_cmd, unknown placeholders, bad patterns and unknown keys", () => {
    expect(errors({ ...valid, mode: "act", move_cmd: undefined })).toEqual([
      "placement.mode is act but placement.move_cmd is not set",
    ]);
    expect(errors({ ...valid, move_cmd: ["./mover", "{gate}"] })[0]).toMatch(/unknown placeholder \{gate\}/);
    expect(errors({ ...valid, classes: { small: ["/([a-z/"] } , eligible: {}, lanes: { main: { machine: "a" } } })[0]).toMatch(
      /placement\.classes\.small: .* is not a valid regular expression/,
    );
    expect(errors({ ...valid, shell: "sh -c" })[0]).toMatch(/Unrecognized key/);
    expect(errors({ ...valid, machines: { a: { probe: "true" } } })[0]).toMatch(/^placement\.machines\.a\.probe/);
  });

  it("reads globs and /regex/ patterns, first class in the order written", () => {
    expect(compilePattern("*gate.sh*backend*").test("x scripts/gate.sh full-backend {WT}")).toBe(true);
    expect(compilePattern("*gate.sh*backend*").test("gate.sh docs")).toBe(false);
    expect(compilePattern("a?c").test("abc")).toBe(true);
    expect(compilePattern("a.c").test("abc")).toBe(false);
    expect(compilePattern("/^BACKEND_TESTS=\\S+ run$/").test("BACKEND_TESTS=*Foo run")).toBe(true);
    const parsed = parsePlacementConfig({ ...valid, classes: { small: ["*targeted*"], big: ["*suite*", "*targeted*"] } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(classify("run targeted suite", parsed.settings.classes)).toBe("small");
    expect(classify("run suite", parsed.settings.classes)).toBe("big");
    expect(classify("run docs", parsed.settings.classes)).toBeNull();
  });

  it("takes a request's command from command_line on", () => {
    expect(requestCommand("track\nabc123\nBACKEND_TESTS=x run\n", 3)).toBe("BACKEND_TESTS=x run");
    expect(requestCommand("run all\n", 1)).toBe("run all");
  });

  it("fills move_cmd as argv and refuses a value that would read as an option", () => {
    expect(buildMoveArgv(["./mover", "{id}", "--to={to}"], { id: "j1", to: "spare" })).toEqual({
      argv: ["./mover", "j1", "--to=spare"],
    });
    expect(buildMoveArgv(["./mover", "{id}"], { id: "-rf" })).toHaveProperty("error");
    expect(buildMoveArgv(["./mover", "{nope}"], {})).toHaveProperty("error");
  });

  it("parses load output: the first number is the load, the last the cpu count", () => {
    expect(parseLoad("{ 3.21 2.98 2.76 }\n10\n")).toEqual({ load: 3.21, cpus: 10 });
    expect(parseLoad("0.52 0.58 0.59 1/345 1234\n8\n")).toEqual({ load: 0.52, cpus: 8 });
    expect(parseLoad("1.5\n")).toEqual({ load: 1.5, cpus: null });
    expect(parseLoad("no numbers")).toEqual({ load: null, cpus: null });
  });
});
