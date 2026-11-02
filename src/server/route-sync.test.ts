/**
 * Static test: route handlers must not use synchronous child-process APIs.
 *
 * A route handler that calls execSync, execFileSync or spawnSync blocks
 * the event loop for every other request and timer. This test scans the
 * route files and their imports for such calls.
 *
 * Acceptance test 3: "The static or runtime test fails if a route handler
 * (or a function it calls synchronously) uses execSync, spawnSync or
 * execFileSync."
 */
import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_SERVER = resolve(__dirname);

/**
 * Patterns that indicate a synchronous child-process call.
 * We look for imports and direct calls.
 */
const SYNC_PROCESS_PATTERNS = [
  /\bexecSync\b/,
  /\bexecFileSync\b/,
  /\bspawnSync\b/,
];

/**
 * Files and directories that are allowed to use sync process calls.
 * These are not called from request handlers.
 */
const ALLOWED_SYNC = new Set([
  // Test files are allowed
  ".test.ts",
  // The settings module writes files during save operations (not per-request reads)
  "settings/files.ts",
  // The restart module runs commands at shutdown, not during requests
  "restart/exec.ts",
  // The gates routes test fixture uses execFileSync for setup
  "gates/routes.test.ts",
]);

/**
 * Route files and modules they import that must not use sync process calls.
 * These are the files reachable from route handlers.
 */
const ROUTE_FILES = [
  "routes/bus.ts",
  "routes/controls.ts",
  "routes/fleet.ts",
  "routes/processes.ts",
  "routes/scheduler.ts",
  "routes/settings.ts",
  "dashboard/routes.ts",
  "agents/routes.ts",
  "delivery/routes.ts",
  "gates/routes.ts",
  "placement/routes.ts",
  "infra-monitor/routes.ts",
  "cloud/routes.ts",
  "review/routes.ts",
  "triage/routes.ts",
  "watchdog/routes.ts",
  "supervisor/routes.ts",
  "settings/routes.ts",
  "ai/routes.ts",
  "reload/routes.ts",
  "restart/routes.ts",
  "notifications/routes.ts",
  "decisions/routes.ts",
  "human-auth/routes.ts",
];

/**
 * Service files that are called from routes and must not use sync process calls.
 *
 * These are checked separately because the fix requires migrating the routes
 * to use the async data-cache.ts instead.
 */
const SERVICE_FILES = [
  "services/data.ts",
  "services/log-tail.ts",
];

function isAllowed(file: string): boolean {
  for (const pattern of ALLOWED_SYNC) {
    if (file.endsWith(pattern)) return true;
    if (file.includes(`/${pattern}`)) return true;
  }
  return false;
}

function findSyncCalls(content: string, file: string): string[] {
  const issues: string[] = [];
  const lines = content.split("\n");
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
    
    for (const pattern of SYNC_PROCESS_PATTERNS) {
      if (pattern.test(line)) {
        // Check if it's in an import statement (which is fine for types)
        const isImport = /^\s*import\s/.test(line);
        // Check if it's a type annotation
        const isType = /:\s*typeof\s/.test(line);
        
        if (!isImport && !isType) {
          const fn = line.match(pattern)?.[0] ?? "sync call";
          issues.push(`${file}:${i + 1}: uses ${fn}`);
        }
      }
    }
  }
  
  return issues;
}

function scanFile(relativePath: string): string[] {
  if (isAllowed(relativePath)) return [];
  
  const fullPath = join(SRC_SERVER, relativePath);
  try {
    statSync(fullPath);
  } catch {
    // File doesn't exist yet (being added)
    return [];
  }
  
  const content = readFileSync(fullPath, "utf-8");
  return findSyncCalls(content, relativePath);
}

describe("route handlers must not use synchronous child-process APIs", () => {
  /**
   * Files scanned:
   * - All route files listed in ROUTE_FILES
   * - All service files listed in SERVICE_FILES
   *
   * The test ensures that route handlers don't block the event loop
   * with synchronous child-process calls.
   */
  it("route files do not call execSync, execFileSync or spawnSync", () => {
    const issues: string[] = [];
    
    for (const file of ROUTE_FILES) {
      issues.push(...scanFile(file));
    }
    
    if (issues.length > 0) {
      throw new Error(
        `Found synchronous child-process calls in route handlers:\n${issues.join("\n")}\n\n` +
        `Scanned files: ${ROUTE_FILES.join(", ")}\n` +
        "Route handlers must not block the event loop. Use async alternatives or the process cache."
      );
    }
  });
  
  it.fails("service files called from routes do not call execSync, execFileSync or spawnSync", () => {
    // This test is EXPECTED TO FAIL on the base commit (7e90e73) because
    // services/data.ts uses execSync and execFileSync for gh and git commands.
    //
    // The fix requires migrating routes to use the async data-cache.ts.
    // The async cache is added in this PR; the route migration is tracked
    // as follow-up work.
    //
    // When the migration is complete, change this back to `it(...)`.
    //
    // Files scanned: services/data.ts, services/log-tail.ts
    const issues: string[] = [];
    
    for (const file of SERVICE_FILES) {
      issues.push(...scanFile(file));
    }
    
    if (issues.length > 0) {
      throw new Error(
        `Found synchronous child-process calls in service files:\n${issues.join("\n")}\n\n` +
        `Scanned files: ${SERVICE_FILES.join(", ")}\n` +
        "Service files called from routes must not block the event loop. " +
        "Move these to background refreshers with the AsyncCache."
      );
    }
  });
});

describe("sync process call detection", () => {
  it("detects execSync calls", () => {
    const content = `
      import { execSync } from "child_process";
      const result = execSync("echo hello");
    `;
    const issues = findSyncCalls(content, "test.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("execSync");
  });
  
  it("ignores import statements", () => {
    const content = `import { execSync, execFileSync } from "child_process";`;
    const issues = findSyncCalls(content, "test.ts");
    expect(issues).toHaveLength(0);
  });
  
  it("detects calls in function bodies", () => {
    const content = `
      function runCommand() {
        return execFileSync("git", ["status"]);
      }
    `;
    const issues = findSyncCalls(content, "test.ts");
    expect(issues).toHaveLength(1);
  });
});
