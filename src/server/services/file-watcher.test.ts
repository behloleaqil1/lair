import { describe, it, expect } from "vitest";
import { dragonIdFromLogFile } from "./file-watcher.js";

describe("dragonIdFromLogFile", () => {
  it("reads kiro IDs with and without a timestamp", () => {
    expect(dragonIdFromLogFile("kiro-A-20261025T123456Z.log")).toBe("kiro-A");
    expect(dragonIdFromLogFile("kiro-A.log")).toBe("kiro-A");
  });

  it("reads generic agent IDs", () => {
    expect(dragonIdFromLogFile("aider-1-20260101T000000Z.log")).toBe("aider-1");
    expect(dragonIdFromLogFile("worker_b.log")).toBe("worker_b");
  });

  it("ignores files that aren't dragon logs", () => {
    expect(dragonIdFromLogFile("dragons.txt")).toBeNull();
    expect(dragonIdFromLogFile(".hidden.log")).toBeNull();
    expect(dragonIdFromLogFile("1-run.log")).toBeNull();
  });
});
