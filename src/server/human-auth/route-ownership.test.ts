/**
 * Every route the server registers is owner-only or on a short, reviewed
 * public list. A route family added without either fails here, not in review.
 *
 * The routes are read from the server's source: each `<object>.get|post|put|
 * patch|delete|all("/path", …)` call outside the tests. index.ts starts the
 * server when it is imported, so the routes cannot be listed by loading it.
 * A path built from a constant in its own file (`${OWNER_PREFIX}/x`) is
 * resolved; one that cannot be resolved is reported as unclassified.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OWNER_ONLY_PREFIXES, isUnder } from "./cors.js";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Routes that are open to a browser page on purpose. A prefix covers the
 * routes under it. Add an entry only with a reason a reviewer can check; a
 * route that takes the owner session belongs in OWNER_ONLY_PREFIXES instead.
 */
export const PUBLIC_ROUTE_PREFIXES: Readonly<Record<string, string>> = {
  "/api/health": "liveness probe; reports only that the server answers",
  "/api/projects": "the project names the dashboard offers; no paths or file contents",
  "/api/overview": "read-only dashboard summary of one project",
  "/api/dragons": "read-only list of the project's agents and their queue lines",
  "/api/gates": "read-only gate queue and results",
  "/api/queue": "read-only view of the project's task queue",
  "/api/prs": "read-only list of the project's pull requests",
  "/api/machines": "read-only list of the project's machines",
  "/api/orchestrator": "read-only orchestrator status",
  "/api/config/status": "read-only: whether the configuration loaded and when it last reloaded",
  "/api/watchdog": "read-only watchdog status, breaches and runs",
  "/api/bus/board": "read-only message board; the owner's message route /api/bus/send is owner-only",
  "/api/bus/events": "read-only event stream; the owner's message route /api/bus/send is owner-only",
  "/api/triage": "failure triage reads; a posted result must be signed by a trusted node; owner changes are under /api/triage/owner",
  "/api/placement": "read-only placement status",
  "/api/bus/messages": "read-only message lists for the dashboard; the owner's message route /api/bus/send is owner-only",
  "/api/nodes": "scheduler node reads; the scheduler's hook asks for the owner on every change",
  "/api/jobs": "scheduler job reads; the scheduler's hook asks for the owner on every change",
  "/api/stats": "scheduler statistics reads; the scheduler's hook asks for the owner on every change",
  "/api/host-services": "read-only host services status; owner tick is checked in the route handler",
};

/**
 * Route files whose register function the server does not call, so their
 * routes do not exist at run time. If the server starts calling one, the
 * test below fails until the entry is removed and the routes are classified.
 */
const UNMOUNTED: Readonly<Record<string, { symbol: string; reason: string }>> = {
  "cleanup/routes.ts": { symbol: "cleanupRoutes", reason: "registered only by its own test, with a prefix" },
  "routes/diagnostics.ts": { symbol: "registerDiagnosticsRoutes", reason: "not called by the server" },
};

export interface FoundRoute {
  file: string;
  method: string;
  path: string;
}

const ROUTE_CALL = /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete|all)(?:<[^>]*>)?\(\s*(["'`])([^"'`]*)\2/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The routes a source text registers; `${NAME}` is resolved from `const NAME = "…"` in the same text. */
export function routesIn(file: string, source: string): FoundRoute[] {
  const text = stripComments(source);
  const constants = new Map<string, string>();
  for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]*)"/g)) constants.set(m[1], m[2]);
  const found: FoundRoute[] = [];
  for (const m of text.matchAll(ROUTE_CALL)) {
    let path = m[3];
    path = path.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (whole, name: string) => constants.get(name) ?? whole);
    if (!path.startsWith("/")) continue; // Map.get("key"), a git ref in a test fake
    found.push({ file, method: m[1].toUpperCase(), path });
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

function registeredRoutes(): FoundRoute[] {
  return sourceFiles(SERVER_DIR)
    .map((file) => relative(SERVER_DIR, file))
    .filter((file) => !(file in UNMOUNTED))
    .flatMap((file) => routesIn(file, readFileSync(join(SERVER_DIR, file), "utf8")));
}

const publicPrefixes = Object.keys(PUBLIC_ROUTE_PREFIXES);

/** The routes that are neither owner-only nor public. */
export function unclassified(routes: FoundRoute[]): FoundRoute[] {
  return routes.filter((r) => !isUnder(r.path, OWNER_ONLY_PREFIXES) && !isUnder(r.path, publicPrefixes));
}

describe("route ownership", () => {
  const routes = registeredRoutes();

  it("finds the server's routes (guards the scan itself)", () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.map((r) => r.path)).toContain("/api/health");
    expect(routes.map((r) => r.path)).toContain("/api/triage/owner/protected");
    expect(routes.every((r) => r.path.startsWith("/"))).toBe(true);
  });

  it("puts every registered route under OWNER_ONLY_PREFIXES or the public list", () => {
    const loose = [...new Set(unclassified(routes).map((r) => `${r.path.split("/").slice(0, 3).join("/")} (${r.file})`))].sort();
    expect(loose, "add the route's prefix to OWNER_ONLY_PREFIXES, or to PUBLIC_ROUTE_PREFIXES with a reason").toEqual([]);
  });

  it("fails for a route family under a new prefix that is on neither list", () => {
    const source = [
      `fastify.get("/api/health", handler);`,
      `fastify.post("/api/brand-new/things", handler);`,
      "fastify.get(`/api/other/${NEW_PREFIX}`, handler);",
      `const flags = new Map(); flags.get("key");`,
      `// fastify.get("/api/commented-out", handler);`,
    ].join("\n");
    expect(unclassified(routesIn("fake.ts", source)).map((r) => r.path)).toEqual([
      "/api/brand-new/things",
      "/api/other/${NEW_PREFIX}",
    ]);
  });

  it("resolves a prefix constant and treats an owner-only one as classified", () => {
    const source = `const OWNER_PREFIX = "/api/owner";\nfastify.post(\`\${OWNER_PREFIX}/x\`, handler);`;
    const found = routesIn("fake.ts", source);
    expect(found.map((r) => r.path)).toEqual(["/api/owner/x"]);
    expect(unclassified(found)).toEqual([]);
  });

  it("keeps a route file off the scan only while the server does not call its register function", () => {
    const sources = sourceFiles(SERVER_DIR).map((file) => ({ file: relative(SERVER_DIR, file), text: readFileSync(file, "utf8") }));
    for (const [file, { symbol, reason }] of Object.entries(UNMOUNTED)) {
      expect(reason.trim().length, `${file} needs a reason`).toBeGreaterThan(5);
      expect(sources.some((s) => s.file === file && s.text.includes(symbol)), `${file} no longer defines ${symbol}`).toBe(true);
      const dir = dirname(file);
      const users = sources
        .filter((s) => s.file !== file && s.file !== join(dir, "index.ts") && s.text.includes(symbol))
        .map((s) => s.file);
      expect(users, `${symbol} is called now: remove ${file} from UNMOUNTED and classify its routes`).toEqual([]);
    }
  });

  it("gives every public entry a reason, a real route, and no overlap with the owner-only list", () => {
    for (const [prefix, reason] of Object.entries(PUBLIC_ROUTE_PREFIXES)) {
      expect(reason.trim().length, `${prefix} needs a reason`).toBeGreaterThan(10);
      expect(reason.includes("\n"), `${prefix}: one line`).toBe(false);
      expect(
        routes.some((r) => isUnder(r.path, [prefix])),
        `${prefix} matches no registered route: remove the stale entry`,
      ).toBe(true);
      expect(isUnder(prefix, OWNER_ONLY_PREFIXES), `${prefix} is both public and owner-only`).toBe(false);
    }
  });
});
