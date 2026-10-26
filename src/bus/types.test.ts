/**
 * Tests for Zod schema validation (input validation)
 */
import { describe, it, expect } from "vitest";
import {
  ClaimInput,
  ReleaseInput,
  ReportInput,
  AckInput,
  SendInput,
  ReportKind,
} from "./types.js";

describe("ClaimInput schema", () => {
  it("accepts valid input", () => {
    const result = ClaimInput.safeParse({ task: "my-task" });
    expect(result.success).toBe(true);
  });

  it("rejects empty task", () => {
    const result = ClaimInput.safeParse({ task: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing task", () => {
    const result = ClaimInput.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects non-string task", () => {
    const result = ClaimInput.safeParse({ task: 123 });
    expect(result.success).toBe(false);
  });
});

describe("ReleaseInput schema", () => {
  it("accepts valid input", () => {
    const result = ReleaseInput.safeParse({ task: "my-task" });
    expect(result.success).toBe(true);
  });

  it("rejects empty task", () => {
    const result = ReleaseInput.safeParse({ task: "" });
    expect(result.success).toBe(false);
  });
});

describe("ReportInput schema", () => {
  it("accepts DONE with all optional fields", () => {
    const result = ReportInput.safeParse({
      kind: "DONE",
      task: "my-task",
      summary: "completed",
      gate_id: "gate-123",
      pr: 42,
      sha: "abc1234",
    });
    expect(result.success).toBe(true);
  });

  it("accepts minimal WAITING report", () => {
    const result = ReportInput.safeParse({
      kind: "WAITING",
      task: "my-task",
      summary: "submitted",
    });
    expect(result.success).toBe(true);
  });

  it("accepts BLOCKED report", () => {
    const result = ReportInput.safeParse({
      kind: "BLOCKED",
      task: "my-task",
      summary: "missing dependency",
    });
    expect(result.success).toBe(true);
  });

  it("accepts PROGRESS report", () => {
    const result = ReportInput.safeParse({
      kind: "PROGRESS",
      task: "my-task",
      summary: "3 of 8 files",
    });
    expect(result.success).toBe(true);
  });

  it("accepts TICK report", () => {
    const result = ReportInput.safeParse({
      kind: "TICK",
      task: "orchestrator",
      summary: "all healthy",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid kind", () => {
    const result = ReportInput.safeParse({
      kind: "INVALID",
      task: "my-task",
      summary: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty task", () => {
    const result = ReportInput.safeParse({
      kind: "DONE",
      task: "",
      summary: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty summary", () => {
    const result = ReportInput.safeParse({
      kind: "DONE",
      task: "my-task",
      summary: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative pr", () => {
    const result = ReportInput.safeParse({
      kind: "DONE",
      task: "my-task",
      summary: "test",
      pr: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer pr", () => {
    const result = ReportInput.safeParse({
      kind: "DONE",
      task: "my-task",
      summary: "test",
      pr: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("AckInput schema", () => {
  it("accepts message_id only", () => {
    const result = AckInput.safeParse({ message_id: "msg-123" });
    expect(result.success).toBe(true);
  });

  it("accepts message_id with note", () => {
    const result = AckInput.safeParse({
      message_id: "msg-123",
      note: "understood",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty message_id", () => {
    const result = AckInput.safeParse({ message_id: "" });
    expect(result.success).toBe(false);
  });
});

describe("SendInput schema", () => {
  it("accepts minimal send", () => {
    const result = SendInput.safeParse({
      to: "orchestrator",
      text: "hello",
    });
    expect(result.success).toBe(true);
  });

  it("accepts send with priority", () => {
    const result = SendInput.safeParse({
      to: "kiro-A",
      text: "urgent",
      priority: 10,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty to", () => {
    const result = SendInput.safeParse({
      to: "",
      text: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty text", () => {
    const result = SendInput.safeParse({
      to: "orchestrator",
      text: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects priority below 1", () => {
    const result = SendInput.safeParse({
      to: "orchestrator",
      text: "hello",
      priority: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects priority above 10", () => {
    const result = SendInput.safeParse({
      to: "orchestrator",
      text: "hello",
      priority: 11,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer priority", () => {
    const result = SendInput.safeParse({
      to: "orchestrator",
      text: "hello",
      priority: 5.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("ReportKind enum", () => {
  it("validates all valid kinds", () => {
    const validKinds = ["WAITING", "DONE", "BLOCKED", "PROGRESS", "TICK"];
    for (const kind of validKinds) {
      const result = ReportKind.safeParse(kind);
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid kinds", () => {
    const invalidKinds = ["waiting", "done", "FAILED", "RUNNING", ""];
    for (const kind of invalidKinds) {
      const result = ReportKind.safeParse(kind);
      expect(result.success).toBe(false);
    }
  });
});
