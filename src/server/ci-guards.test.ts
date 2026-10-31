/**
 * CI guards: static tests that fail the build when common review findings
 * are introduced. Each guard scans the server source and fails if it finds
 * a pattern that has caused rework before.
 *
 * 1. Timeout guard: every fetch(), execFile() and spawn() must have a timeout
 * 2. Wiring guard: every module directory under src/server/ must be imported
 *    from the server startup path
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)));

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ============================================================================
// TIMEOUT GUARD: every network call and child process has a timeout
// ============================================================================

/**
 * fetch() calls that are allowed without an explicit timeout in the call,
 * because a caller passes the signal or the code is a type/interface only.
 * Each entry: file path relative to src/server/, line content substring, reason.
 */
const FETCH_TIMEOUT_ALLOWED: Array<{ file: string; match: string; reason: string }> = [
  // Type definitions and interfaces (no actual call)
  { file: "gates/executors/types.ts", match: "signal?: AbortSignal", reason: "type definition, not a call" },
  { file: "gates/executors/types.ts", match: "signal: AbortSignal", reason: "type definition, not a call" },
  { file: "gates/gate-executor.ts", match: "signal?: AbortSignal", reason: "type definition, not a call" },
  { file: "agents/fill.ts", match: "signal: AbortSignal", reason: "parameter type, caller provides signal" },
  // Callers that receive the signal from their caller or use injectable fetch
  { file: "gates/executors/github-api.ts", match: "await this.options.fetch", reason: "receives signal from caller via options" },
  { file: "gates/pipeline-service.ts", match: "fetchImpl:", reason: "type definition for injectable fetch" },
  { file: "review/github.ts", match: "this.fetchFn", reason: "injectable fetch, caller controls timeout" },
  { file: "notifications/mount.ts", match: "fetch:", reason: "injectable fetch option, not a call" },
  { file: "notifications/senders.ts", match: "this.options.fetch", reason: "injectable fetch, caller controls timeout" },
  // Injectable fetch with timeout on next line or in options
  { file: "brain-bench/models.ts", match: "o.fetch(url", reason: "has AbortSignal.timeout in the same call object (signal: AbortSignal.timeout)" },
  // Wrapped with AbortController setTimeout
  { file: "services/managed-process.ts", match: "await fetch(config.url", reason: "uses AbortController with setTimeout for timeout (see lines above the call)" },
  // Wrapped with AbortSignal.timeout directly in call
  { file: "delivery/probes.ts", match: "fetch(url", reason: "has AbortSignal.timeout in the same call" },
];

/**
 * execFile/spawn calls that are allowed without an explicit timeout option,
 * because a caller provides it or the code is a type/interface only.
 */
const EXEC_TIMEOUT_ALLOWED: Array<{ file: string; match: string; reason: string }> = [
  // Type definitions and interfaces
  { file: "agents/probes.ts", match: "spawn(argv:", reason: "interface definition, not a call" },
  { file: "gates/executors/local.ts", match: "spawn(file, args,", reason: "the spawn wrapper that enforces timeouts for all callers" },
  { file: "gates/executors/local.ts", match: 'spawn("taskkill"', reason: "taskkill for cleanup, bounded by the caller's abort signal" },
  { file: "gates/pipeline-service.ts", match: "spawner?:", reason: "type definition for injectable spawner" },
  { file: "plan-sandbox/service.ts", match: "spawner:", reason: "type definition, not a call" },
  // Has timeout option
  { file: "settings/service.ts", match: "timeout:", reason: "has timeout option" },
  { file: "plan-sandbox/spawners.ts", match: "timeout:", reason: "has timeout option" },
  { file: "core/process-cache.ts", match: "timeout:", reason: "has timeout option" },
  { file: "cleanup/probes.ts", match: "timeout:", reason: "has timeout option" },
  { file: "cleanup/worktree.ts", match: "timeout:", reason: "has timeout option" },
  { file: "cleanup/retention.ts", match: "timeout:", reason: "has timeout option" },
  // Uses ProcessSpawner.run which enforces timeouts
  { file: "agents/probes.ts", match: "const child = spawn(file, args,", reason: "detached agent process in its own process group, managed by supervisor not timeouts" },
  { file: "agents/service.ts", match: "this.probes.spawner.spawn", reason: "uses injected spawner which enforces timeouts" },
  // AI runner has its own timeout handling
  { file: "ai/runner.ts", match: "child = spawn(file, args,", reason: "has AbortController-based timeout handling" },
  // Fleet/machines SSH with bounded waits
  { file: "fleet/machine-manager.ts", match: 'spawn("ssh"', reason: "SSH probe with manual timeout via setTimeout and destroy" },
  { file: "machines/health.ts", match: 'spawn("ssh"', reason: "SSH probe with manual timeout via setTimeout and destroy" },
  // Testing harnesses (not production code)
  { file: "planner/testing/harness.ts", match: "async spawn(argv", reason: "test harness fake, not production code" },
  { file: "review/testing/agent-fakes.ts", match: "async spawn(argv", reason: "test harness fake, not production code" },
  // Restart controller has timeout handling
  { file: "restart/restart.ts", match: "child = spawn(file, args,", reason: "has AbortController-based timeout via child.kill" },
  // Review check runner has timeout handling
  { file: "review/check.ts", match: "child = spawn(file, args,", reason: "has AbortController-based timeout via AbortSignal" },
  // Git operations with timeout
  { file: "review/git.ts", match: "execFile(", reason: "has timeout option in execFile call" },
  // Command service has manual timeout handling
  { file: "services/command.ts", match: "spawn(cmd, args,", reason: "has manual timeout via setTimeout and proc.kill" },
  // Data cache git operations
  { file: "services/data-cache.ts", match: "execFile(", reason: "has timeout option in execFile call" },
  // Managed process has timeout via destroy
  { file: "services/managed-process.ts", match: "this.child = spawn(cmd, args,", reason: "has timeout handling via setTimeout and destroy" },
  { file: "services/managed-process.ts", match: "const child = spawn(cmd, args,", reason: "has timeout handling via AbortController" },
  // Remote gate with timeout handling
  { file: "services/remote-gate.ts", match: 'spawn("ssh"', reason: "SSH with manual timeout via setTimeout and proc.kill" },
  { file: "services/remote-gate.ts", match: "spawn(gateScript", reason: "has manual timeout via setTimeout and proc.kill" },
  // Settings git operations
  { file: "settings/service.ts", match: "execFile(", reason: "has timeout option" },
  // Watchdog probes with timeout
  { file: "watchdog/probes.ts", match: "execFile(", reason: "has timeout option" },
];

interface FetchCall {
  file: string;
  line: number;
  code: string;
}

function findFetchCalls(dir: string): FetchCall[] {
  const calls: FetchCall[] = [];
  for (const file of sourceFiles(dir)) {
    const relPath = relative(dir, file);
    const source = readFileSync(file, "utf8");
    const text = stripComments(source);
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match fetch( calls but not type annotations, imports, or property assignments
      if (/\bfetch\s*\(/.test(line) && !/:\s*typeof\s+fetch/.test(line) && !/import.*fetch/.test(line)) {
        calls.push({ file: relPath, line: i + 1, code: line.trim() });
      }
    }
  }
  return calls;
}

function findExecCalls(dir: string): FetchCall[] {
  const calls: FetchCall[] = [];
  for (const file of sourceFiles(dir)) {
    const relPath = relative(dir, file);
    const source = readFileSync(file, "utf8");
    const text = stripComments(source);
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match execFile( or spawn( calls
      if (/\b(execFile|spawn)\s*\(/.test(line) && !/import.*\b(execFile|spawn)\b/.test(line)) {
        calls.push({ file: relPath, line: i + 1, code: line.trim() });
      }
    }
  }
  return calls;
}

function isAllowedFetch(call: FetchCall): boolean {
  return FETCH_TIMEOUT_ALLOWED.some(
    (allowed) => call.file === allowed.file && call.code.includes(allowed.match),
  );
}

function isAllowedExec(call: FetchCall): boolean {
  return EXEC_TIMEOUT_ALLOWED.some(
    (allowed) => call.file === allowed.file && call.code.includes(allowed.match),
  );
}

describe("timeout guard", () => {
  it("requires every fetch() to have an AbortSignal/timeout or be on the allow-list", () => {
    const fetchCalls = findFetchCalls(SERVER_DIR);
    const unguarded = fetchCalls.filter((call) => {
      if (isAllowedFetch(call)) return false;
      // Check if the same line or nearby context has AbortSignal.timeout or signal:
      return !call.code.includes("AbortSignal.timeout") && !call.code.includes("signal:");
    });

    const formatted = unguarded.map((c) => `${c.file}:${c.line} - ${c.code.slice(0, 80)}`);
    expect(
      formatted,
      "fetch() calls need AbortSignal.timeout or signal option, or add to FETCH_TIMEOUT_ALLOWED with a reason",
    ).toEqual([]);
  });

  it("requires every execFile/spawn to have a timeout or be on the allow-list", () => {
    const execCalls = findExecCalls(SERVER_DIR);
    const unguarded = execCalls.filter((call) => {
      if (isAllowedExec(call)) return false;
      // Check if the same line has timeout:
      return !call.code.includes("timeout:");
    });

    const formatted = unguarded.map((c) => `${c.file}:${c.line} - ${c.code.slice(0, 80)}`);
    expect(
      formatted,
      "execFile/spawn calls need a timeout option, or add to EXEC_TIMEOUT_ALLOWED with a reason",
    ).toEqual([]);
  });

  it("keeps every allow-list entry valid: the file and match exist", () => {
    for (const entry of FETCH_TIMEOUT_ALLOWED) {
      const file = join(SERVER_DIR, entry.file);
      expect(statSync(file, { throwIfNoEntry: false })?.isFile(), `${entry.file} does not exist`).toBe(true);
      const content = readFileSync(file, "utf8");
      expect(content.includes(entry.match), `${entry.file} no longer contains "${entry.match}"`).toBe(true);
    }
    for (const entry of EXEC_TIMEOUT_ALLOWED) {
      const file = join(SERVER_DIR, entry.file);
      expect(statSync(file, { throwIfNoEntry: false })?.isFile(), `${entry.file} does not exist`).toBe(true);
      const content = readFileSync(file, "utf8");
      expect(content.includes(entry.match), `${entry.file} no longer contains "${entry.match}"`).toBe(true);
    }
  });

  it("fails for a fetch without timeout (fixture)", () => {
    const source = `
      const response = await fetch(url);
      const guarded = await fetch(url, { signal: AbortSignal.timeout(5000) });
    `;
    const lines = source.split("\n");
    const unguarded = lines
      .map((line, i) => ({ line: i + 1, code: line.trim() }))
      .filter((l) => /\bfetch\s*\(/.test(l.code) && !l.code.includes("AbortSignal.timeout") && !l.code.includes("signal:"));
    expect(unguarded.map((u) => u.code)).toEqual(["const response = await fetch(url);"]);
  });
});

// ============================================================================
// WIRING GUARD: every module directory is imported from the server startup
// ============================================================================

/**
 * Directories under src/server/ that are not modules (utilities, shared code,
 * or intentionally not wired to the server). Each needs a reason.
 */
const UNWIRED_ALLOWED: Readonly<Record<string, string>> = {
  core: "shared utilities (event-bus, process-cache) imported by multiple modules",
  parsers: "parser utilities imported by other modules, not a standalone module",
  routes: "route files registered directly from index.ts, not a module with its own index",
  services: "service utilities imported by other modules, not a standalone module",
  store: "store utilities imported by other modules, not a standalone module",
  "human-auth": "imported directly from index.ts, not through a module index",
  diagnostics: "development-only routes, not mounted in production",
  "brain-bench": "imported from brain-trainer, not directly from index.ts",
  jobs: "scheduler job types, imported by scheduler module",
  machines: "machine status parsing, imported by services",
  nodes: "node manager, initialized directly in index.ts startup",
  scheduler: "scheduler module, initialized directly in index.ts startup",
  bus: "bus routes registered from routes/bus.js; the bus/ directory holds message types and WebSocket logic",
  cleanup: "cleanup module not mounted in production; routes only registered by tests (see UNMOUNTED in route-ownership.test.ts)",
  policy: "merge policy utilities imported by review module, not a standalone server module",
  "ready-guard": "ready guard utilities imported by agents and review modules, not a standalone server module",
};

function moduleDirectories(dir: string): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      dirs.push(entry.name);
    }
  }
  return dirs;
}

describe("wiring guard", () => {
  it("imports every module directory from index.ts or lists it in UNWIRED_ALLOWED", () => {
    const indexPath = join(SERVER_DIR, "index.ts");
    const indexSource = readFileSync(indexPath, "utf8");
    const modules = moduleDirectories(SERVER_DIR);

    const unwired: string[] = [];
    for (const mod of modules) {
      // Check if the module is imported in index.ts (directly or via re-export)
      const importPattern = new RegExp(`from\\s+['"]\\./${mod}(/|['"])|import.*['"]\\./${mod}`);
      const isImported = importPattern.test(indexSource);
      const isAllowed = mod in UNWIRED_ALLOWED;

      if (!isImported && !isAllowed) {
        unwired.push(mod);
      }
    }

    expect(
      unwired,
      "Module directories must be imported from index.ts (wired to server startup), or listed in UNWIRED_ALLOWED with a reason",
    ).toEqual([]);
  });

  it("keeps every UNWIRED_ALLOWED entry valid: the directory exists and has a reason", () => {
    for (const [dir, reason] of Object.entries(UNWIRED_ALLOWED)) {
      const fullPath = join(SERVER_DIR, dir);
      expect(statSync(fullPath, { throwIfNoEntry: false })?.isDirectory(), `${dir} does not exist`).toBe(true);
      expect(reason.trim().length, `${dir} needs a reason`).toBeGreaterThan(10);
    }
  });

  it("fails for an unwired module directory (fixture)", () => {
    // Simulate a module that would not be imported
    const indexSource = `
      import { foo } from "./agents/index.js";
      import { bar } from "./triage/index.js";
    `;
    const modules = ["agents", "triage", "brand-new-module"];
    const unwired = modules.filter((mod) => {
      const pattern = new RegExp(`from\\s+['"]\\./${mod}(/|['"])|import.*['"]\\./${mod}`);
      return !pattern.test(indexSource) && !(mod in UNWIRED_ALLOWED);
    });
    expect(unwired).toEqual(["brand-new-module"]);
  });
});
