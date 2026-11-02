/**
 * Tests for answer-file.ts: parsing, validation, and per-run folder management
 * for answer.json files that supervisor runs write (supervisor.chat.answer_file).
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  readAnswerFile,
  createRunFolder,
  answerFilePath,
  takenAnswerFilePath,
  takeAnswerFile,
  cleanupRunFolder,
  sweepRunFolders,
  MAX_ANSWER_TEXT_BYTES,
  MAX_ANSWER_FILE_BYTES,
  MAX_EVIDENCE_ITEMS,
  RUN_FOLDERS_DIR,
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

/** answer.json in a fresh run folder, with this content */
function written(content: string): { dir: string; path: string } {
  const dir = tempDir();
  const path = join(dir, "answer.json");
  writeFileSync(path, content);
  return { dir, path };
}

const invalid = (error: string) => ({ ok: false, missing: false, error });

describe("readAnswerFile", () => {
  it("accepts a valid answer.json", async () => {
    const { dir, path } = written(
      JSON.stringify({
        answer: "The agent is held because Redis was down.",
        evidence: [{ tool: "events.query", args: { agent: "worker-a" }, note: "restart event at 08:30" }],
      }),
    );
    expect(await readAnswerFile(path, dir)).toEqual({
      ok: true,
      content: {
        answer: "The agent is held because Redis was down.",
        evidence: [{ tool: "events.query", args: { agent: "worker-a" }, note: "restart event at 08:30" }],
      },
    });
  });

  it("rejects missing answer field", async () => {
    const { dir, path } = written(JSON.stringify({ evidence: [] }));
    expect(await readAnswerFile(path, dir)).toEqual(invalid("answer: required, must be a string"));
  });

  it("rejects empty answer", async () => {
    const { dir, path } = written(JSON.stringify({ answer: "", evidence: [] }));
    expect(await readAnswerFile(path, dir)).toEqual(invalid("answer: cannot be empty"));
  });

  it("rejects answer exceeding max size in bytes (not UTF-16 code units)", async () => {
    // Each emoji is 4 bytes in UTF-8 and 2 UTF-16 code units: under the limit in code units, over it in bytes
    const count = Math.ceil(MAX_ANSWER_TEXT_BYTES / 4) + 1;
    const { dir, path } = written(JSON.stringify({ answer: "😀".repeat(count), evidence: [] }));
    expect(await readAnswerFile(path, dir)).toEqual(invalid(`answer: exceeds ${MAX_ANSWER_TEXT_BYTES} bytes`));
  });

  it("rejects missing evidence field", async () => {
    const { dir, path } = written(JSON.stringify({ answer: "Something" }));
    expect(await readAnswerFile(path, dir)).toEqual(invalid("evidence: required (use [] if none)"));
  });

  it("rejects evidence that is not an array", async () => {
    const { dir, path } = written(JSON.stringify({ answer: "Something", evidence: "not an array" }));
    expect(await readAnswerFile(path, dir)).toEqual(invalid("evidence: must be an array"));
  });

  it("rejects evidence exceeding max items", async () => {
    const evidence = Array.from({ length: MAX_EVIDENCE_ITEMS + 1 }, () => ({ tool: "status.agents", args: {}, note: "x" }));
    const { dir, path } = written(JSON.stringify({ answer: "Something", evidence }));
    expect(await readAnswerFile(path, dir)).toEqual(invalid(`evidence: exceeds ${MAX_EVIDENCE_ITEMS} items`));
  });

  it("rejects invalid evidence item (unknown tool)", async () => {
    const { dir, path } = written(JSON.stringify({ answer: "Something", evidence: [{ tool: "not.a.tool", args: {}, note: "x" }] }));
    const result = await readAnswerFile(path, dir);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("evidence[0].tool");
  });

  it("rejects unknown fields, confidence included (it is not part of the schema)", async () => {
    const extra = written(JSON.stringify({ answer: "Something", evidence: [], extra: "field" }));
    expect(await readAnswerFile(extra.path, extra.dir)).toEqual(invalid("unknown field: extra"));
    const confidence = written(JSON.stringify({ answer: "Something", evidence: [], confidence: "high" }));
    expect(await readAnswerFile(confidence.path, confidence.dir)).toEqual(invalid("unknown field: confidence"));
  });

  it("rejects file that is not valid JSON", async () => {
    const { dir, path } = written("{ not valid json }");
    expect(await readAnswerFile(path, dir)).toEqual(invalid("the file is not valid JSON"));
  });

  it("says a file that does not exist is missing (not invalid)", async () => {
    const dir = tempDir();
    expect(await readAnswerFile(join(dir, "answer.json"), dir)).toEqual({ ok: false, missing: true, error: "the file does not exist" });
  });

  it("rejects file exceeding max size", async () => {
    const { dir, path } = written("x".repeat(MAX_ANSWER_FILE_BYTES + 1));
    const result = await readAnswerFile(path, dir);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("larger than");
  });

  it("rejects a directory at the answer path", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "answer.json"));
    const result = await readAnswerFile(join(dir, "answer.json"), dir);
    expect(result).toMatchObject({ ok: false, missing: false, error: expect.stringContaining("not a regular file") });
  });

  it("rejects file outside the run directory via symlink", async () => {
    const runDir = tempDir();
    const outsideDir = tempDir();
    const outsidePath = join(outsideDir, "secret.json");
    writeFileSync(outsidePath, JSON.stringify({ answer: "stolen", evidence: [] }));
    const symlinkPath = join(runDir, "answer.json");
    symlinkSync(outsidePath, symlinkPath);
    expect(await readAnswerFile(symlinkPath, runDir)).toEqual(invalid("the file is outside the run directory (symlink or path escape)"));
  });

  it("rejects a symlink even when it points inside the run directory (O_NOFOLLOW)", async () => {
    const runDir = tempDir();
    writeFileSync(join(runDir, "real.json"), JSON.stringify({ answer: "ok", evidence: [] }));
    symlinkSync(join(runDir, "real.json"), join(runDir, "answer.json"));
    const result = await readAnswerFile(join(runDir, "answer.json"), runDir);
    expect(result).toMatchObject({ ok: false, missing: false, error: expect.stringContaining("symlink") });
  });
});

describe("createRunFolder", () => {
  it("creates a private folder (mode 0700) under supervisor-runs", async () => {
    const agentsDir = tempDir();
    const runFolder = await createRunFolder(agentsDir, "0f1e2d3c-aaaa-4bbb-8ccc-123456789abc");
    expect(runFolder).not.toBeNull();
    expect(dirname(runFolder!)).toBe(join(agentsDir, RUN_FOLDERS_DIR));
    expect(runFolder!).toMatch(/\/run-0f1e2d3c-[0-9a-f]{16}$/);
    expect(statSync(runFolder!).mode & 0o777).toBe(0o700);
  });

  it("creates folders with unguessable names", async () => {
    const agentsDir = tempDir();
    const id = "0f1e2d3c-aaaa-4bbb-8ccc-123456789abc";
    const a = await createRunFolder(agentsDir, id);
    const b = await createRunFolder(agentsDir, id);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("returns null when the folder can't be made", async () => {
    const agentsDir = tempDir();
    writeFileSync(join(agentsDir, RUN_FOLDERS_DIR), "a file where the folder would go");
    expect(await createRunFolder(agentsDir, "0f1e2d3c-aaaa-4bbb-8ccc-123456789abc")).toBeNull();
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
  it("reads, validates, and moves the answer file aside so it is never read twice", async () => {
    const runFolder = tempDir();
    writeFileSync(answerFilePath(runFolder), JSON.stringify({ answer: "Test answer", evidence: [] }));
    expect(await takeAnswerFile(runFolder)).toEqual({ ok: true, content: { answer: "Test answer", evidence: [] } });
    expect(existsSync(answerFilePath(runFolder))).toBe(false);
    expect(existsSync(takenAnswerFilePath(runFolder))).toBe(true);
    expect(await takeAnswerFile(runFolder)).toMatchObject({ ok: false, missing: true });
  });

  it("returns error for invalid file, and leaves it in place", async () => {
    const runFolder = tempDir();
    writeFileSync(answerFilePath(runFolder), "not json");
    expect(await takeAnswerFile(runFolder)).toEqual(invalid("the file is not valid JSON"));
    expect(existsSync(answerFilePath(runFolder))).toBe(true);
  });

  it("says missing when there is no file", async () => {
    expect(await takeAnswerFile(tempDir())).toMatchObject({ ok: false, missing: true });
  });
});

describe("cleanupRunFolder", () => {
  it("removes the folder and whatever the run left in it", async () => {
    const runFolder = join(tempDir(), "run");
    mkdirSync(join(runFolder, "scratch"), { recursive: true });
    writeFileSync(answerFilePath(runFolder), "{}");
    writeFileSync(takenAnswerFilePath(runFolder), "{}");
    writeFileSync(join(runFolder, "scratch", "notes.txt"), "x");
    await cleanupRunFolder(runFolder);
    expect(existsSync(runFolder)).toBe(false);
  });

  it("removes a symlink in the folder, never what it points to", async () => {
    const outside = tempDir();
    writeFileSync(join(outside, "keep.txt"), "keep");
    const runFolder = join(tempDir(), "run");
    mkdirSync(runFolder);
    symlinkSync(outside, join(runFolder, "link"));
    await cleanupRunFolder(runFolder);
    expect(existsSync(runFolder)).toBe(false);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("does not throw when folder does not exist", async () => {
    await expect(cleanupRunFolder(join(tempDir(), "nonexistent"))).resolves.toBeUndefined();
  });
});

describe("sweepRunFolders", () => {
  it("removes every run folder under supervisor-runs and nothing else", async () => {
    const agentsDir = tempDir();
    const a = (await createRunFolder(agentsDir, "0f1e2d3c-aaaa-4bbb-8ccc-123456789abc"))!;
    const b = (await createRunFolder(agentsDir, "9a8b7c6d-aaaa-4bbb-8ccc-123456789abc"))!;
    writeFileSync(answerFilePath(a), "{}");
    const runs = join(agentsDir, RUN_FOLDERS_DIR);
    mkdirSync(join(runs, "not-a-run-folder"));
    writeFileSync(join(runs, "run-0f1e2d3c-0123456789abcdef"), "a file with a run folder's name");
    const outside = tempDir();
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(runs, "run-11111111-0123456789abcdef"));

    expect(await sweepRunFolders(agentsDir)).toBe(2);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(join(runs, "not-a-run-folder"))).toBe(true);
    expect(existsSync(join(runs, "run-0f1e2d3c-0123456789abcdef"))).toBe(true);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("is a no-op without a supervisor-runs folder", async () => {
    expect(await sweepRunFolders(tempDir())).toBe(0);
  });
});
