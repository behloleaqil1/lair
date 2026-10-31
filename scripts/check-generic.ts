#!/usr/bin/env tsx
/**
 * Genericity guard: fails CI when project-specific strings appear
 * in src/, docs/ or tests/.
 *
 * Checks for:
 * 1. Home paths (/Users/, /home/<name>)
 * 2. Names from a denylist file (.generic-denylist, stored as SHA-256 hashes)
 * 3. Non-noreply email addresses
 *
 * Baseline support:
 * - .generic-baseline lists known violations (one per line: file:line:column:kind)
 * - Only NEW violations (not in baseline) cause failure
 * - Run with --update-baseline to write the baseline file
 *
 * Exit codes:
 *   0 = all files pass (or no new violations beyond baseline)
 *   1 = new violations found
 *   2 = error (bad config, missing file, etc.)
 */
import { createHash } from "crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, relative } from "path";

const DENYLIST_FILE = ".generic-denylist";
const BASELINE_FILE = ".generic-baseline";

// Directories to scan
const SCAN_DIRS = ["src", "docs", "tests"];

// File extensions to check
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".md",
  ".yaml",
  ".yml",
  ".json",
  ".txt",
  ".sh",
  ".html",
  ".css",
]);

// Binary/generated files to skip
const SKIP_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist\//,
  /coverage\//,
  /\.snap$/,
  /package-lock\.json$/,
];

interface Violation {
  file: string;
  line: number;
  column: number;
  kind: "home-path" | "denylisted-word" | "non-noreply-email";
  match: string;
}

/**
 * Pattern for home directory paths.
 * Matches /Users/<name>/ and /home/<name>/
 * Does not match generic /home/user/ which is allowed in docs.
 */
const HOME_PATH_PATTERN = /\/(?:Users|home)\/(?!user\b)[a-zA-Z0-9_-]+/g;

/**
 * Pattern for email addresses.
 * We allow only:
 * - noreply@ addresses (GitHub style)
 * - example.com (RFC 2606)
 * - example@test.com and similar test domains
 */
const EMAIL_PATTERN = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

function isAllowedEmail(email: string): boolean {
  const lower = email.toLowerCase();
  // Allow noreply addresses
  if (lower.includes("noreply@") || lower.includes("@users.noreply.")) {
    return true;
  }
  // Allow RFC 2606 reserved domains
  if (
    lower.endsWith("@example.com") ||
    lower.endsWith("@example.org") ||
    lower.endsWith("@example.net") ||
    lower.endsWith("@test.com") ||
    lower.endsWith("@localhost") ||
    lower.endsWith(".example") // RFC 2606 reserved TLD
  ) {
    return true;
  }
  return false;
}

function sha256(text: string): string {
  return createHash("sha256").update(text.toLowerCase().trim()).digest("hex");
}

function loadDenylist(rootDir: string): Set<string> {
  const denylistPath = join(rootDir, DENYLIST_FILE);
  if (!existsSync(denylistPath)) {
    return new Set();
  }
  const content = readFileSync(denylistPath, "utf-8");
  const hashes = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (trimmed && !trimmed.startsWith("#")) {
      hashes.add(trimmed.toLowerCase());
    }
  }
  return hashes;
}

function extractWords(text: string): string[] {
  // Extract words (including those with hyphens/underscores)
  return text.match(/[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
}

function* walkFiles(dir: string, rootDir: string): Generator<string> {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const relativePath = relative(rootDir, fullPath);

    // Skip patterns
    if (SKIP_PATTERNS.some((p) => p.test(relativePath))) {
      continue;
    }

    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      yield* walkFiles(fullPath, rootDir);
    } else if (stat.isFile()) {
      const ext = entry.slice(entry.lastIndexOf("."));
      if (TEXT_EXTENSIONS.has(ext) || entry === "Makefile") {
        yield fullPath;
      }
    }
  }
}

function checkFile(
  filePath: string,
  rootDir: string,
  denylistHashes: Set<string>,
): Violation[] {
  const violations: Violation[] = [];
  const relativePath = relative(rootDir, filePath);
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    // Check home paths
    for (const match of line.matchAll(HOME_PATH_PATTERN)) {
      violations.push({
        file: relativePath,
        line: lineNum + 1,
        column: match.index! + 1,
        kind: "home-path",
        match: match[0],
      });
    }

    // Check emails
    for (const match of line.matchAll(EMAIL_PATTERN)) {
      if (!isAllowedEmail(match[0])) {
        violations.push({
          file: relativePath,
          line: lineNum + 1,
          column: match.index! + 1,
          kind: "non-noreply-email",
          match: match[0],
        });
      }
    }

    // Check denylisted words (if we have a denylist)
    if (denylistHashes.size > 0) {
      for (const word of extractWords(line)) {
        const hash = sha256(word);
        if (denylistHashes.has(hash)) {
          violations.push({
            file: relativePath,
            line: lineNum + 1,
            column: line.indexOf(word) + 1,
            kind: "denylisted-word",
            match: `[hash: ${hash.slice(0, 8)}...]`,
          });
        }
      }
    }
  }

  return violations;
}

function violationKey(v: Violation): string {
  return `${v.file}:${v.line}:${v.column}:${v.kind}`;
}

function loadBaseline(rootDir: string): Set<string> {
  const baselinePath = join(rootDir, BASELINE_FILE);
  if (!existsSync(baselinePath)) {
    return new Set();
  }
  const content = readFileSync(baselinePath, "utf-8");
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (trimmed && !trimmed.startsWith("#")) {
      keys.add(trimmed);
    }
  }
  return keys;
}

function writeBaseline(rootDir: string, violations: Violation[]): void {
  const baselinePath = join(rootDir, BASELINE_FILE);
  const header = `# Genericity guard baseline - known violations
# Generated by: npm run check:generic -- --update-baseline
# Fix these and remove from baseline to reduce technical debt
#
# Format: file:line:column:kind
`;
  const content =
    header + violations.map((v) => violationKey(v)).join("\n") + "\n";
  writeFileSync(baselinePath, content);
  console.log(`Wrote ${violations.length} violations to ${BASELINE_FILE}`);
}

function main(): void {
  const rootDir = process.cwd();
  const denylistHashes = loadDenylist(rootDir);
  const updateBaseline = process.argv.includes("--update-baseline");

  const allViolations: Violation[] = [];
  let filesChecked = 0;

  for (const scanDir of SCAN_DIRS) {
    const fullDir = join(rootDir, scanDir);
    for (const filePath of walkFiles(fullDir, rootDir)) {
      filesChecked++;
      const violations = checkFile(filePath, rootDir, denylistHashes);
      allViolations.push(...violations);
    }
  }

  console.log(`Checked ${filesChecked} files across ${SCAN_DIRS.join(", ")}`);

  if (updateBaseline) {
    writeBaseline(rootDir, allViolations);
    process.exit(0);
  }

  // Load baseline and filter to only new violations
  const baseline = loadBaseline(rootDir);
  const newViolations = allViolations.filter(
    (v) => !baseline.has(violationKey(v)),
  );
  const baselinedCount = allViolations.length - newViolations.length;

  if (newViolations.length === 0) {
    if (baselinedCount > 0) {
      console.log(
        `✓ No new violations (${baselinedCount} baselined violations remain)`,
      );
    } else {
      console.log("✓ No project-specific strings found");
    }
    process.exit(0);
  }

  console.log(`\n✗ Found ${newViolations.length} NEW violation(s):\n`);

  for (const v of newViolations) {
    const kindLabel =
      v.kind === "home-path"
        ? "Home path"
        : v.kind === "non-noreply-email"
          ? "Non-noreply email"
          : "Denylisted word";
    console.log(`  ${v.file}:${v.line}:${v.column}`);
    console.log(`    ${kindLabel}: ${v.match}\n`);
  }

  if (baselinedCount > 0) {
    console.log(`(${baselinedCount} additional baselined violations remain)`);
  }
  console.log(
    "\nSee CONTRIBUTING.md 'No private details' for what to use instead.",
  );
  console.log(
    "To baseline these violations: npm run check:generic -- --update-baseline",
  );
  process.exit(1);
}

main();
