/**
 * Tests for the genericity guard script.
 *
 * These tests verify that the check-generic script correctly detects
 * project-specific strings in source files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

const SCRIPT_PATH = join(__dirname, "check-generic.ts");

describe("Genericity guard", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "generic-guard-test-"));
    // Create the required directories
    mkdirSync(join(tempDir, "src"));
    mkdirSync(join(tempDir, "docs"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runCheck(): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execSync(`npx tsx ${SCRIPT_PATH}`, {
        cwd: tempDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (error: unknown) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { code: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("passes when no project-specific strings are found", () => {
    writeFileSync(
      join(tempDir, "src", "example.ts"),
      `// A clean file with no private details
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`,
    );

    const result = runCheck();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No project-specific strings found");
  });

  it("fails on home directory paths with real usernames", () => {
    writeFileSync(
      join(tempDir, "src", "bad-path.ts"),
      `// This file contains a real home path
const configPath = "/Users/johnsmith/project/config.json";
`,
    );

    const result = runCheck();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Home path");
    expect(result.stdout).toContain("/Users/johnsmith");
  });

  it("fails on Linux home paths", () => {
    writeFileSync(
      join(tempDir, "src", "linux-path.ts"),
      `const path = "/home/developer/app";`,
    );

    const result = runCheck();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Home path");
    expect(result.stdout).toContain("/home/developer");
  });

  it("allows generic /home/user/ path in documentation", () => {
    writeFileSync(
      join(tempDir, "docs", "example.md"),
      `# Example
Configure the path as \`/home/user/project\`.
`,
    );

    const result = runCheck();
    expect(result.code).toBe(0);
  });

  it("fails on non-noreply email addresses", () => {
    writeFileSync(
      join(tempDir, "src", "contact.ts"),
      `const email = "john.doe@company.com";`,
    );

    const result = runCheck();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Non-noreply email");
    expect(result.stdout).toContain("john.doe@company.com");
  });

  it("allows noreply email addresses", () => {
    writeFileSync(
      join(tempDir, "src", "author.ts"),
      `const author = "user@users.noreply.github.com";`,
    );

    const result = runCheck();
    expect(result.code).toBe(0);
  });

  it("allows example.com email addresses (RFC 2606)", () => {
    writeFileSync(
      join(tempDir, "src", "test-data.ts"),
      `const testEmail = "test@example.com";
const anotherTest = "user@example.org";`,
    );

    const result = runCheck();
    expect(result.code).toBe(0);
  });

  it("fails on denylisted words when denylist exists", () => {
    // Create a denylist with hash of "secretproject"
    // SHA-256 of "secretproject" (lowercase)
    const hash =
      "a3c9e8b7d6f5e4c3b2a1908776655443322110ffeeddccbbaa9988776655443";
    // Actually compute it properly
    const crypto = require("crypto");
    const realHash = crypto
      .createHash("sha256")
      .update("secretproject")
      .digest("hex");
    writeFileSync(
      join(tempDir, ".generic-denylist"),
      `# Denylisted project names (as SHA-256 hashes)
${realHash}
`,
    );

    writeFileSync(
      join(tempDir, "src", "config.ts"),
      `// Reference to secretproject here
const name = "secretproject";`,
    );

    const result = runCheck();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Denylisted word");
  });

  it("skips node_modules directory", () => {
    mkdirSync(join(tempDir, "src", "node_modules"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "node_modules", "bad.ts"),
      `const path = "/Users/badpath/secret";`,
    );

    // Also add a clean file so we have something to check
    writeFileSync(join(tempDir, "src", "clean.ts"), `export const x = 1;`);

    const result = runCheck();
    expect(result.code).toBe(0);
  });

  it("reports multiple violations in the same file", () => {
    writeFileSync(
      join(tempDir, "src", "multiple.ts"),
      `const path1 = "/Users/alice/project";
const path2 = "/Users/bob/project";
const email = "private@company.com";`,
    );

    const result = runCheck();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("3 violation");
  });

  it("checks .md files in docs directory", () => {
    writeFileSync(
      join(tempDir, "docs", "setup.md"),
      `# Setup Guide
Clone the repo to /Users/myname/projects/
`,
    );

    const result = runCheck();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Home path");
  });

  it("ignores comments in denylist file", () => {
    writeFileSync(
      join(tempDir, ".generic-denylist"),
      `# This is a comment
# Another comment
`,
    );

    writeFileSync(join(tempDir, "src", "clean.ts"), `export const clean = true;`);

    const result = runCheck();
    expect(result.code).toBe(0);
  });
});
