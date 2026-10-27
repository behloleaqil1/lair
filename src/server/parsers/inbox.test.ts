/**
 * Inbox/Outbox parser unit tests
 */
import { describe, it, expect } from "vitest";
import {
  parseInboxLine,
  parseOutboxLine,
  parseInboxFile,
  formatInboxEntry,
  parseOwnerDecision,
  getOwnerDecisions,
} from "./inbox.js";

describe("parseInboxLine", () => {
  it("parses a valid inbox line", () => {
    const line =
      "- OWNER 2026-10-24T12:34:56Z [abc123]: Start the pricing task";
    const result = parseInboxLine(line);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("abc123");
    expect(result!.timestamp).toBe("2026-10-24T12:34:56Z");
    expect(result!.text).toBe("Start the pricing task");
    expect(result!.status).toBe("pending");
  });

  it("parses short timestamp format", () => {
    const line = "- OWNER 12:34Z [def456]: Check status";
    const result = parseInboxLine(line);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("def456");
    expect(result!.timestamp).toBe("12:34Z");
    expect(result!.text).toBe("Check status");
  });

  it("returns null for non-owner lines", () => {
    expect(parseInboxLine("- DONE task by kiro-A")).toBeNull();
    expect(parseInboxLine("Some random text")).toBeNull();
    expect(parseInboxLine("")).toBeNull();
  });

  it("returns null for malformed owner lines", () => {
    expect(parseInboxLine("- OWNER no brackets")).toBeNull();
    expect(parseInboxLine("- OWNER 12:34Z []: empty id")).toBeNull();
  });

  it("handles text with special characters", () => {
    const line = "- OWNER 12:00Z [x1]: Run `npm test` and check the [results]";
    const result = parseInboxLine(line);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("Run `npm test` and check the [results]");
  });
});

describe("parseOutboxLine", () => {
  it("parses a valid reply line", () => {
    const line =
      "- REPLY abc123 2026-10-24T12:35:00Z by kiro-A: Task completed";
    const result = parseOutboxLine(line);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("abc123");
    expect(result!.timestamp).toBe("2026-10-24T12:35:00Z");
    expect(result!.agent).toBe("kiro-A");
    expect(result!.text).toBe("Task completed");
  });

  it("returns null for non-reply lines", () => {
    expect(parseOutboxLine("- OWNER 12:34Z [x]: test")).toBeNull();
    expect(parseOutboxLine("- DONE task")).toBeNull();
  });

  it("reads a bracketed reply id, as OWNER lines write it, without the brackets", () => {
    const result = parseOutboxLine("- REPLY [2] 22:17Z by Claude: assigned to a dragon");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("2");
    expect(result!.agent).toBe("Claude");
    expect(parseInboxFile("- OWNER 22:09Z [2]: please do it", "- REPLY [2] 22:17Z by Claude: done")[0].status).toBe("answered");
  });

  it("handles multi-word reply text", () => {
    const line =
      "- REPLY x1 12:00Z by kiro-B: The task is done, rc=0, merged PR #123";
    const result = parseOutboxLine(line);

    expect(result!.text).toBe("The task is done, rc=0, merged PR #123");
  });
});

describe("parseInboxFile", () => {
  it("matches inbox items with their replies", () => {
    const inbox = `- OWNER 12:00Z [a1]: Start task A
- OWNER 12:10Z [a2]: Start task B
- OWNER 12:20Z [a3]: Check status`;

    const outbox = `- REPLY a1 12:05Z by kiro-A: Task A started
- REPLY a2 12:15Z by kiro-B: Task B started`;

    const items = parseInboxFile(inbox, outbox);

    expect(items).toHaveLength(3);

    expect(items[0].id).toBe("a1");
    expect(items[0].status).toBe("answered");
    expect(items[0].reply?.agent).toBe("kiro-A");

    expect(items[1].id).toBe("a2");
    expect(items[1].status).toBe("answered");
    expect(items[1].reply?.agent).toBe("kiro-B");

    expect(items[2].id).toBe("a3");
    expect(items[2].status).toBe("pending");
    expect(items[2].reply).toBeUndefined();
  });

  it("handles empty files", () => {
    expect(parseInboxFile("", "")).toEqual([]);
    expect(parseInboxFile("", "- REPLY x 12:00Z by k: test")).toEqual([]);
  });

  it("ignores non-inbox lines", () => {
    const inbox = `# Inbox file
- OWNER 12:00Z [x1]: Do something
Some other text
- OWNER 12:10Z [x2]: Do more`;

    const items = parseInboxFile(inbox, "");
    expect(items).toHaveLength(2);
  });
});

describe("formatInboxEntry", () => {
  it("formats an instruction with id and timestamp", () => {
    const { line, id } = formatInboxEntry("Start the build");

    expect(id).toMatch(/^[a-f0-9]{8}$/);
    expect(line).toMatch(/^- OWNER \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(line).toContain(`[${id}]`);
    expect(line).toContain("Start the build");
  });

  it("preserves special characters in text", () => {
    const { line } = formatInboxEntry('Run "npm test" && check [logs]');
    expect(line).toContain('Run "npm test" && check [logs]');
  });
});

describe("parseOwnerDecision", () => {
  it("extracts decision question", () => {
    const result = parseOwnerDecision(
      "- OWNER? Should we use approach A or B?",
    );
    expect(result).toBe("Should we use approach A or B?");
  });

  it("returns null for non-decision lines", () => {
    expect(parseOwnerDecision("- OWNER 12:00Z [x]: instruction")).toBeNull();
    expect(parseOwnerDecision("- DONE task")).toBeNull();
    expect(parseOwnerDecision("OWNER? no dash")).toBeNull();
  });
});

describe("getOwnerDecisions", () => {
  it("extracts all owner decisions from queue content", () => {
    const content = `- DONE task by kiro-A
- OWNER? Should we merge PR #123?
- WAITING gate xyz
- OWNER? Is the design approved?
- TICK 12:00Z`;

    const decisions = getOwnerDecisions(content);

    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toBe("Should we merge PR #123?");
    expect(decisions[1]).toBe("Is the design approved?");
  });

  it("returns empty array when no decisions", () => {
    expect(getOwnerDecisions("- DONE task")).toEqual([]);
    expect(getOwnerDecisions("")).toEqual([]);
  });
});
