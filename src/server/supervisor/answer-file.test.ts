/**
 * Tests for answer-file.ts: parsing and validation of answer.json files.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readAnswerFile, MAX_ANSWER_TEXT_BYTES, MAX_ANSWER_FILE_BYTES, MAX_EVIDENCE_ITEMS } from "./answer-file.js";

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

  it("rejects answer exceeding max size", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, JSON.stringify({ answer: "x".repeat(MAX_ANSWER_TEXT_BYTES + 1), evidence: [] }));
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
    expect((result as { error: string }).error).toContain("cannot be read");
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
    expect((result as { error: string }).error).toContain("outside the run directory");
  });

  it("accepts file when runDir is null (no path check)", () => {
    const dir = tempDir();
    const path = join(dir, "answer.json");
    writeFileSync(path, JSON.stringify({ answer: "ok", evidence: [] }));
    const result = readAnswerFile(path, null);
    expect(result.ok).toBe(true);
  });
});
