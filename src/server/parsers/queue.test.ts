/**
 * Queue parser unit tests
 */
import { describe, it, expect } from "vitest";
import {
  parseQueueLine,
  parseQueueFile,
  detectLineType,
  filterByType,
  filterByAgent,
  getTickLines,
  calculateAgentStats,
} from "./queue.js";

describe("detectLineType", () => {
  it("detects WAITING lines", () => {
    expect(
      detectLineType("WAITING search-panel 20261024T152000Z by kiro-B"),
    ).toBe("WAITING");
  });

  it("detects DONE lines", () => {
    expect(detectLineType("DONE fix-login task by kiro-A 14:35Z")).toBe("DONE");
  });

  it("detects BLOCKED lines", () => {
    expect(detectLineType("BLOCKED build-config by kiro-C")).toBe("BLOCKED");
  });

  it("detects PROGRESS lines", () => {
    expect(detectLineType("PROGRESS refactoring by kiro-D 17:00Z")).toBe(
      "PROGRESS",
    );
  });

  it("detects TICK lines", () => {
    expect(detectLineType("TICK 18:00Z: all runners healthy")).toBe("TICK");
  });

  it("detects ORCHESTRATOR lines", () => {
    expect(
      detectLineType("(orchestrator, 18:15Z) ORCHESTRATOR: assigning kiro-F"),
    ).toBe("ORCHESTRATOR");
    expect(detectLineType("(kiro-A, 18:15Z) checking status")).toBe(
      "ORCHESTRATOR",
    );
    expect(detectLineType("(orchestrator, 9:05Z) tick skipped")).toBe(
      "ORCHESTRATOR",
    );
    expect(detectLineType("Note ORCHESTRATOR: paused for review")).toBe(
      "ORCHESTRATOR",
    );
  });

  it("does not treat other parenthesised text as an orchestrator line", () => {
    expect(detectLineType("(see above) more text")).toBe("OTHER");
    expect(detectLineType("(orchestrator) no time")).toBe("OTHER");
  });

  it("detects OTHER for unknown patterns", () => {
    expect(detectLineType("Some random text")).toBe("OTHER");
  });
});

describe("parseQueueLine", () => {
  it("returns null for empty lines", () => {
    expect(parseQueueLine("")).toBeNull();
    expect(parseQueueLine("   ")).toBeNull();
  });

  it("returns null for lines not starting with -", () => {
    expect(parseQueueLine("DONE task by kiro-A")).toBeNull();
    expect(parseQueueLine("## Header")).toBeNull();
  });

  it("parses DONE line with gate id and rc", () => {
    const line =
      "- DONE fix-login task by kiro-A 14:35Z: head abc1234d, gate 20261024T143500Z-fix-login-abc1234d-12345 rc=0";
    const result = parseQueueLine(line);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("DONE");
    expect(result!.agent).toBe("kiro-A");
    expect(result!.timestamp).toBe("14:35Z");
    expect(result!.gateId).toBe("20261024T143500Z-fix-login-abc1234d-12345");
    expect(result!.task).toBe("fix-login task");
  });

  it("parses WAITING line", () => {
    const line =
      "- WAITING search-panel 20261024T152000Z-search-panel-def5678e-23456 by kiro-B 15:20Z";
    const result = parseQueueLine(line);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("WAITING");
    expect(result!.agent).toBe("kiro-B");
    expect(result!.timestamp).toBe("15:20Z");
    expect(result!.gateId).toBe("20261024T152000Z-search-panel-def5678e-23456");
  });

  it("parses BLOCKED line", () => {
    const line = "- BLOCKED build-config by kiro-C 16:05Z: missing config file";
    const result = parseQueueLine(line);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("BLOCKED");
    expect(result!.agent).toBe("kiro-C");
    expect(result!.timestamp).toBe("16:05Z");
  });

  it("parses TICK line", () => {
    const line = "- TICK 18:00Z: all runners healthy, 2 gates queued";
    const result = parseQueueLine(line);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("TICK");
    expect(result!.timestamp).toBe("18:00Z");
  });
});

describe("parseQueueFile", () => {
  it("parses multiple lines from fixture", () => {
    const content = `# Test Queue File

- DONE fix-login task by kiro-A 14:35Z: head abc1234d
- WAITING search-panel by kiro-B 15:20Z
- BLOCKED build-config by kiro-C 16:05Z
`;
    const results = parseQueueFile(content);

    expect(results).toHaveLength(3);
    expect(results[0].type).toBe("DONE");
    expect(results[1].type).toBe("WAITING");
    expect(results[2].type).toBe("BLOCKED");
  });

  it("skips non-list lines", () => {
    const content = `# Header
Some paragraph text
- DONE task by kiro-A
## Another header
- WAITING another by kiro-B
`;
    const results = parseQueueFile(content);
    expect(results).toHaveLength(2);
  });
});

describe("filterByType", () => {
  it("filters lines by single type", () => {
    const lines = [
      { type: "DONE", raw: "", message: "" },
      { type: "WAITING", raw: "", message: "" },
      { type: "DONE", raw: "", message: "" },
    ] as any;

    const filtered = filterByType(lines, ["DONE"]);
    expect(filtered).toHaveLength(2);
  });

  it("filters lines by multiple types", () => {
    const lines = [
      { type: "DONE", raw: "", message: "" },
      { type: "WAITING", raw: "", message: "" },
      { type: "BLOCKED", raw: "", message: "" },
    ] as any;

    const filtered = filterByType(lines, ["DONE", "BLOCKED"]);
    expect(filtered).toHaveLength(2);
  });
});

describe("filterByAgent", () => {
  it("filters lines by agent id (case insensitive)", () => {
    const lines = [
      { agent: "kiro-A", raw: "", type: "DONE", message: "" },
      { agent: "kiro-B", raw: "", type: "WAITING", message: "" },
      { agent: "kiro-A", raw: "", type: "DONE", message: "" },
    ] as any;

    const filtered = filterByAgent(lines, "kiro-a");
    expect(filtered).toHaveLength(2);
  });
});

describe("getTickLines", () => {
  it("returns only TICK lines", () => {
    const lines = [
      { type: "DONE", raw: "", message: "" },
      { type: "TICK", raw: "", message: "" },
      { type: "WAITING", raw: "", message: "" },
      { type: "TICK", raw: "", message: "" },
    ] as any;

    const ticks = getTickLines(lines);
    expect(ticks).toHaveLength(2);
    expect(ticks.every((t) => t.type === "TICK")).toBe(true);
  });

  it("respects limit parameter", () => {
    const lines = Array(50).fill({ type: "TICK", raw: "", message: "" }) as any;
    const ticks = getTickLines(lines, 10);
    expect(ticks).toHaveLength(10);
  });
});

describe("calculateAgentStats", () => {
  it("calculates stats for an agent", () => {
    const lines = [
      { agent: "kiro-A", type: "DONE", gateId: "gate-1", raw: "", message: "" },
      { agent: "kiro-A", type: "DONE", gateId: "gate-2", raw: "", message: "" },
      { agent: "kiro-A", type: "WAITING", raw: "", message: "" },
      { agent: "kiro-A", type: "BLOCKED", raw: "", message: "" },
      { agent: "kiro-B", type: "DONE", gateId: "gate-3", raw: "", message: "" },
    ] as any;

    const stats = calculateAgentStats(lines, "kiro-A");
    expect(stats.doneCount).toBe(2);
    expect(stats.waitingCount).toBe(1);
    expect(stats.blockedCount).toBe(1);
    expect(stats.gateIds).toEqual(["gate-1", "gate-2"]);
  });

  it("returns unique gate ids", () => {
    const lines = [
      { agent: "kiro-A", type: "DONE", gateId: "gate-1", raw: "", message: "" },
      {
        agent: "kiro-A",
        type: "WAITING",
        gateId: "gate-1",
        raw: "",
        message: "",
      },
    ] as any;

    const stats = calculateAgentStats(lines, "kiro-A");
    expect(stats.gateIds).toEqual(["gate-1"]);
  });
});

describe("parseQueueLine agent IDs", () => {
  it("extracts non-kiro agent IDs after 'by'", () => {
    expect(
      parseQueueLine("- DONE fix-login by aider-1 14:35Z: merged")!.agent,
    ).toBe("aider-1");
    expect(
      parseQueueLine("- WAITING search-panel by worker_b (Saphira) 15:20Z: queued")!.agent,
    ).toBe("worker_b");
    expect(parseQueueLine("- BLOCKED build-config by agent-2")!.agent).toBe(
      "agent-2",
    );
  });

  it("does not treat prose after 'by' as an agent", () => {
    expect(
      parseQueueLine("- BLOCKED build-config: blocked by missing config")!.agent,
    ).toBeUndefined();
  });

  it("still finds kiro IDs anywhere in the line", () => {
    expect(
      parseQueueLine("- (orchestrator, 18:15Z) ORCHESTRATOR: assigning kiro-F")!.agent,
    ).toBe("kiro-F");
  });

  it("detects orchestrator-style lines from any hyphenated agent ID", () => {
    expect(detectLineType("(aider-1, 18:15Z) checking status")).toBe("ORCHESTRATOR");
    expect(parseQueueLine("- (aider-1, 18:15Z) checking status")!.agent).toBe("aider-1");
  });
});
