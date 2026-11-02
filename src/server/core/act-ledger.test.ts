/**
 * The generic act-once ledger's pruning (docs/design/pr-health.md section
 * 4.5): records older than 14 days and the oldest over 2000 go, never one
 * the module's keep hook keeps; when kept records alone pass the cap it
 * gives way with a warning. Read back from a real file.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ActLedger, MAX_RECORDS, RETENTION_MS } from "./act-ledger.js";

interface Rec {
  project: string;
  id: string;
  lastAttemptAt: number;
  keep: boolean;
  status: string;
}

const NOW = Date.parse("2026-03-01T00:00:00Z");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ledger(path: string | null) {
  return new ActLedger<Rec>({
    path,
    name: "test ledger",
    stops: "tests stop",
    isRecord: (v): v is Rec => typeof v === "object" && v !== null && typeof (v as Rec).id === "string",
    interrupted: (r) => {
      if (r.status === "running") r.status = "failed";
    },
    keep: (r) => r.keep,
  });
}

const rec = (id: string, ageMs: number, keep = false, status = "done"): Rec => ({ project: "p", id, lastAttemptAt: NOW - ageMs, keep, status });

describe("ActLedger", () => {
  it("prunes records past 14 days unless kept, and reads the file back with interrupted attempts failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-ledger-"));
    dirs.push(dir);
    const path = join(dir, "data", "ledger.json");
    const l = ledger(path);
    await l.load();
    await l.put(rec("old", RETENTION_MS + 1), NOW);
    await l.put(rec("old-kept", 15 * 86_400_000, true), NOW);
    await l.put(rec("new", 1000, false, "running"), NOW);
    expect(l.list("p").map((r) => r.id).sort()).toEqual(["new", "old-kept"]);
    expect(JSON.parse(readFileSync(path, "utf8")).format).toBe(1);
    const again = ledger(path);
    await again.load();
    expect(again.error).toBeNull();
    expect(again.get("p", "new")).toMatchObject({ status: "failed" });
    expect(again.get("p", "old-kept")).not.toBeNull();
  });

  it("keeps the newest 2000; kept records past the cap stay with a warning", async () => {
    const l = ledger(null);
    for (let i = 0; i < MAX_RECORDS + 5; i++) await l.put(rec(`r${i}`, MAX_RECORDS + 5 - i), NOW);
    expect(l.list("p")).toHaveLength(MAX_RECORDS);
    expect(l.get("p", "r0")).toBeNull();
    expect(l.get("p", `r${MAX_RECORDS + 4}`)).not.toBeNull();
    expect(l.warning).toBeNull();

    const full = ledger(null);
    for (let i = 0; i <= MAX_RECORDS; i++) await full.put(rec(`k${i}`, 5000 + i, true), NOW);
    await full.put(rec("loose", 1), NOW);
    expect(full.list("p")).toHaveLength(MAX_RECORDS + 1);
    expect(full.get("p", "loose")).toBeNull();
    expect(full.warning).toMatch(/keeps 2001 records it still needs, over its cap of 2000/);
  });
});
