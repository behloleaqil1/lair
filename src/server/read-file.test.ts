/**
 * readRegularFile and loadProjectConfig's use of it: one open, a regular
 * file only (a FIFO is refused without waiting for a writer), bounded.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadProjectConfig, MAX_CONFIG_BYTES } from "./config.js";
import { readRegularFile } from "./read-file.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-read-file-"));
  dirs.push(dir);
  return dir;
}

const PROJECT = "name: X\nrepo: /r\nqueue_file: /q\nagents_dir: /a\ngates_dir: /g\n";

describe("readRegularFile", () => {
  it("reads a regular file, and follows a symbolic link unless noFollow", () => {
    const dir = tmp();
    const file = join(dir, "a.yaml");
    writeFileSync(file, "a: 1\n");
    const link = join(dir, "b.yaml");
    symlinkSync(file, link);
    expect(readRegularFile(file, { maxBytes: 100 })).toBe("a: 1\n");
    expect(readRegularFile(link, { maxBytes: 100 })).toBe("a: 1\n");
    expect(() => readRegularFile(link, { maxBytes: 100, noFollow: true })).toThrow("is a symbolic link");
  });

  it("refuses a directory and a file over the limit", () => {
    const dir = tmp();
    const sub = join(dir, "d.yaml");
    mkdirSync(sub);
    expect(() => readRegularFile(sub, { maxBytes: 100 })).toThrow("is not a regular file");
    const big = join(dir, "big.yaml");
    writeFileSync(big, "x".repeat(101));
    expect(() => readRegularFile(big, { maxBytes: 100 })).toThrow("is larger than");
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO at once instead of waiting for a writer", () => {
    const fifo = join(tmp(), "f.yaml");
    execFileSync("mkfifo", [fifo]);
    expect(() => readRegularFile(fifo, { maxBytes: 100 })).toThrow("is not a regular file");
  });
});

describe("loadProjectConfig", () => {
  it("reads a project file and refuses one that is not a regular file or too large", () => {
    const projects = tmp();
    writeFileSync(join(projects, "good.yaml"), PROJECT);
    expect(loadProjectConfig("good", projects)).toMatchObject({ name: "X", repo: "/r" });
    writeFileSync(join(projects, "huge.yaml"), `${PROJECT}# ${"x".repeat(MAX_CONFIG_BYTES)}\n`);
    expect(() => loadProjectConfig("huge", projects)).toThrow(/Invalid project config: .*huge\.yaml is larger than/);
    mkdirSync(join(projects, "dir.yaml"));
    expect(() => loadProjectConfig("dir", projects)).toThrow(/Invalid project config: .*dir\.yaml is not a regular file/);
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO in place of a project file without blocking", () => {
    const projects = tmp();
    execFileSync("mkfifo", [join(projects, "pipe.yaml")]);
    expect(() => loadProjectConfig("pipe", projects)).toThrow(/is not a regular file/);
  });
});
