/**
 * Tests for answer-file.ts: parsing, validation, and per-run folder management
 * for answer.json files that supervisor runs write.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  readAnswerFile,
  createRunFolder,
  answerFilePath,
  takenAnswerFilePath,
  takeAnswerFile,
  answerFileExists,
  cleanupRunFolder,
  MAX_ANSWER_TEXT_BYTES,
  MAX_ANSWER_FILE_BYTES,
  MAX_EVIDENCE_ITEMS,
} from "./answer-file.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-answer-file-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("readAnswerFile", () => {
  it("accepts a valid answer.json with all fields", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(
      path,
      JSON.stringify({
        answer: "The agent is held because Redis was down.",
        evidence: [{ tool: "events.query", args: { agent: "worker-a" }, note: "restart event at 08:30" }],
        confidence: "high",
      }),
    );
    const result = readAnswerFile(path, dir);
    expect(result).toEqual({
      ok: true,
      content: {
        answer: "The agent is held because Redis was down.",
        evidence: [{ tool: "events.query", args: { agent: "worker-a" }, note: "restart event at 08:30" }],
        confidence: "high",
      },
    });
  });

  it("accepts answer.json without optional confidence field", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, JSON.stringify({ answer: "All clear.", evidence: [] }));
    const result = readAnswerFile(path, dir);
    expect(result).toEqual({
      ok: true,
      content: { answer: "All clear.", evidence: [], confidence: undefined },
    });
  });

  it("rejects missing answer field", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, JSON.stringify({ evidence: [] }));
    const result = readAnswerFile(path, dir);
    expect(result).toEqual({ ok: false, error: "answer: required, must be a string" });
  });

  it("rejects empty answer", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, JSON.stringify({ answer: "", evidence: [] }));
    const result = readAnswerFile(path, dir);
    expect(result).toEqual({ ok: false, error: "answer: cannot be empty" });
  });

  it("rejects answer exceeding max size in bytes (not UTF-16 code units)", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    // Use multi-byte characters: each emoji is 4 bytes in UTF-8
    const emoji = "😀";
    const count = Math.ceil(MAX_ANSWER_TEXT_BYTES / 4) + 1;
    writeFileSync(path, JSON.stringify({ answer: emoji.repeat(count), evidence: [] }));
    const result = readAnswerFile(path, dir);
    expect(result).toEqual({ ok: false, error: `answer: exceeds ${MAX_ANSWER_TEXT_BYTES} bytes` });
  });

  it("rejects missing evidence field", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, JSON.stringify({ answer: "Something" }));
    const result = readAnswerFile(path, dir);
    expect(result).toEqual({ ok: false, error: "evidence: required (use [] if none)" });
  });

  it("rejects evidence that is not an array", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, JSON.stringify({ answer: "Something", evidence: "not an array" }));
    const result = readAnswerFile(path, dir);
    expect(result).toEqual({ ok: false, error: "evidence: must be an array" });
  });

  it("rejects evidence exceeding max items", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    const evidence = Array(MAX_EVIDENCE_ITEMS + 1)
      .fill(null)
      .map(() => ({ tool: "status.agents", args: {}, note: "x" }));
    writeFileSync(path, JSON.stringify({ answer: "Something", evidence }));
    const result = readAnswerFile(path, dir);
    expect(result).toEqual({ ok: false, error: `evidence: exceeds ${MAX_EVIDENCE_ITEMS} items` });
  });

  it("rejects invalid evidence item (unknown tool)", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, JSON.stringify({ answer: "Something", evidence: [{ tool: "not.a.tool", args: {}, note: "x" }] }));
    const result = readAnswerFile(path, dir);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("evidence[0].tool");
  });

  it("rejects non-string confidence", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, JSON.stringify({ answer: "Something", evidence: [], confidence: 123 }));
    const result = readAnswerFile(path, dir);
    expect(result).toEqual({ ok: false, error: "confidence: must be a string if provided" });
  });

  it("rejects unknown fields", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, JSON.stringify({ answer: "Something", evidence: [], extra: "field" }));
    const result = readAnswerFile(path, dir);
    expect(result).toEqual({ ok: false, error: "unknown field: extra" });
  });

  it("rejects file that is not valid JSON", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, "{ not valid json }");
    const result = readAnswerFile(path, dir);
    expect(result).toEqual({ ok: false, error: "the file is not valid JSON" });
  });

  it("rejects file that does not exist", () => {
    const dir = tempDir();
    const result = readAnswerFile(join(dir, "nope.json"), dir);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("cannot be read or does not exist");
  });

  it("rejects file exceeding max size", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    // Write a file larger than MAX_ANSWER_FILE_BYTES
    writeFileSync(path, "x".repeat(MAX_ANSWER_FILE_BYTES + 1));
    const result = readAnswerFile(path, dir);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("larger than");
  });

  it("rejects file outside the run directory via symlink", () => {
    const runDir = tempDir();
    const outsideDir = tempDir();
    const outsidePath = join(outsideDir, "secret.json");
    writeFileSync(outsidePath, JSON.stringify({ answer: "stolen", evidence: [] }));

    const symlinkPath = join(runDir, "answer.json");
    try {
      symlinkSync(outsidePath, symlinkPath);
    } catch {
      // Symlinks may not be supported on all platforms
      return;
    }

    const result = readAnswerFile(symlinkPath, runDir);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/outside the run directory|symlink/i);
  });

  it("accepts file when runDir is null (no path check)", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, JSON.stringify({ answer: "ok", evidence: [] }));
    const result = readAnswerFile(path, null);
    expect(result.ok).toBe(true);
  });
});

describe("createRunFolder", () => {
  it("creates a folder with mode 0700", () => {
    const dataDir = tempDir();
    const runFolder = createRunFolder(dataDir, "test-run-id");
    expect(runFolder).not.toBeNull();
    expect(existsSync(runFolder!)).toBe(true);

    // Check parent directory exists
    const parentDir = dirname(runFolder!);
    expect(existsSync(parentDir)).toBe(true);

    // Check folder mode (on Unix-like systems)
    if (process.platform !== "win32") {
      const stats = statSync(runFolder!);
      expect(stats.mode & 0o777).toBe(0o700);
    }
  });

  it("creates folders with unguessable names", () => {
    const dataDir = tempDir();
    const folder1 = createRunFolder(dataDir, "run-1");
    const folder2 = createRunFolder(dataDir, "run-1");
    expect(folder1).not.toBeNull();
    expect(folder2).not.toBeNull();
    expect(folder1).not.toBe(folder2);
  });

  it("includes run ID prefix in folder name", () => {
    const dataDir = tempDir();
    const runFolder = createRunFolder(dataDir, "abcdefgh-1234");
    expect(runFolder).not.toBeNull();
    expect(runFolder!).toContain("run-abcdefgh");
  });
});

describe("answerFilePath and takenAnswerFilePath", () => {
  it("returns the correct paths", () => {
    const runFolder = "/data/supervisor-runs/run-abc-123";
    expect(answerFilePath(runFolder)).toBe("/data/supervisor-runs/run-abc-123/answer.json");
    expect(takenAnswerFilePath(runFolder)).toBe("/data/supervisor-runs/run-abc-123/answer.taken.json");
  });
});

describe("takeAnswerFile", () => {
  it("reads, validates, and renames the answer file", () => {
    const runFolder = tempDir();
    const path = answerFilePath(runFolder);
    writeFileSync(path, JSON.stringify({ answer: "Test answer", evidence: [], confidence: "high" }));

    const result = takeAnswerFile(runFolder);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.answer).toBe("Test answer");
      expect(result.content.confidence).toBe("high");
      expect(result.renamed).toBe(true);
    }

    // Original file should be renamed
    expect(existsSync(path)).toBe(false);
    expect(existsSync(takenAnswerFilePath(runFolder))).toBe(true);
  });

  it("returns error for invalid file", () => {
    const runFolder = tempDir();
    writeFileSync(answerFilePath(runFolder), "not json");

    const result = takeAnswerFile(runFolder);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("not valid JSON");
  });

  it("returns error when file does not exist", () => {
    const runFolder = tempDir();
    const result = takeAnswerFile(runFolder);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("cannot be read or does not exist");
  });
});

describe("answerFileExists", () => {
  it("returns true when file exists", () => {
    const runFolder = tempDir();
    writeFileSync(answerFilePath(runFolder), "{}");
    expect(answerFileExists(runFolder)).toBe(true);
  });

  it("returns false when file does not exist", () => {
    const runFolder = tempDir();
    expect(answerFileExists(runFolder)).toBe(false);
  });
});

describe("cleanupRunFolder", () => {
  it("removes the answer files and folder", () => {
    const runFolder = tempDir();
    writeFileSync(answerFilePath(runFolder), "{}");
    writeFileSync(takenAnswerFilePath(runFolder), "{}");

    cleanupRunFolder(runFolder);

    expect(existsSync(runFolder)).toBe(false);
  });

  it("does not throw when folder does not exist", () => {
    expect(() => cleanupRunFolder("/nonexistent/folder")).not.toThrow();
  });
});
