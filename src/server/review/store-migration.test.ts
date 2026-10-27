/**
 * review.db schema 1 -> 2 on a populated file: a v1 database written with
 * the schema as it shipped, then opened by the current ReviewStore. Every
 * row is kept, the request rows become round 1 (with their token hashes and
 * uses), and the new tables work.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ReviewStore, SCHEMA_1, SCHEMA_VERSION } from "./store.js";

const HEAD = "a".repeat(40);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A review.db at schema version 1 with a review, a PR, two requests (one used) and a hold. */
function v1Database(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-review-v1-"));
  dirs.push(dir);
  const path = join(dir, "review.db");
  const db = new Database(path);
  db.exec(SCHEMA_1);
  db.pragma("user_version = 1");
  db.prepare(
    `INSERT INTO review_reviews (id, project, pr, head_sha, reviewer_id, reviewer_kind, reviewer_model, verdict, summary, context, client, created_at)
     VALUES ('rv-1', 'demo', 7, ?, 'worker-b', 'agent', 'model-b', 'approve', 'fine', '{}', NULL, '2026-03-01T10:00:00.000Z')`,
  ).run(HEAD);
  db.prepare(`INSERT INTO review_prs (project, pr, head_sha, head_seen_at, author_id, author_kind) VALUES ('demo', 7, ?, '2026-03-01T09:00:00.000Z', 'worker-a', 'agent')`).run(HEAD);
  const request = db.prepare(
    `INSERT INTO review_requests (project, pr, head_sha, slot, channel, detail, requested_at, reviewer, exclude, token_hash, used_by)
     VALUES ('demo', 7, ?, ?, ?, ?, '2026-03-01T09:30:00.000Z', ?, ?, ?, ?)`,
  );
  request.run(HEAD, 0, "assigner", "worker-b: queued", "worker-b", '["worker-a"]', sha256("token-zero-0000000"), "worker-b");
  request.run(HEAD, 1, "decision", "inbox", null, "[]", null, null);
  db.prepare(
    `INSERT INTO review_holds (id, project, pr, reason, created_by, created_at) VALUES ('hold-1', 'demo', 7, 'freeze', 'owner', '2026-03-01T08:00:00.000Z')`,
  ).run();
  db.close();
  return path;
}

describe("review.db: schema 1 to 2", () => {
  it("keeps every row of a populated v1 file; its requests become round 1", () => {
    const path = v1Database();
    const store = new ReviewStore(path);
    try {
      const reader = new Database(path);
      const version = reader.pragma("user_version", { simple: true });
      reader.close();
      expect(version).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(2);

      const used = store.getRequest("demo", 7, HEAD, 0)!;
      expect(used).toMatchObject({
        round: 1,
        channel: "assigner",
        detail: "worker-b: queued",
        reviewer: "worker-b",
        exclude: ["worker-a"],
        usedBy: "worker-b",
        model: null,
        requestedAt: "2026-03-01T09:30:00.000Z",
      });
      // Its token's hash still finds it (and it is still used, so it counts no more)
      expect(store.findAssignment("demo", 7, sha256("token-zero-0000000"))).toMatchObject({ slot: 0, round: 1, usedBy: "worker-b" });
      expect(store.getRequest("demo", 7, HEAD, 1)).toMatchObject({ round: 1, channel: "decision", reviewer: null, usedBy: null });
      expect(store.decisionSlots("demo", 7, HEAD)).toEqual([1]);

      // The other tables are untouched
      expect(store.listReviews("demo", 7)).toEqual([
        expect.objectContaining({ id: "rv-1", reviewer: { id: "worker-b", kind: "agent", model: "model-b" }, verdict: "approve" }),
      ]);
      expect(store.getAuthor("demo", 7)).toEqual({ id: "worker-a", kind: "agent" });
      expect(store.currentHead("demo", 7)).toBe(HEAD);
      expect(store.activeHolds("demo", 7)).toEqual([expect.objectContaining({ id: "hold-1", reason: "freeze" })]);

      // A new request for slot 0 is round 2, next to round 1; the agent table works
      const round = store.recordRequest("demo", 7, HEAD, 0, "agents", "rev-b: run", "2026-03-02T12:00:00.000Z", {
        reviewer: null,
        exclude: ["worker-a"],
        tokenHash: sha256("token-one-11111111"),
      });
      expect(round).toBe(2);
      expect(store.requestRounds("demo", 7, HEAD, 0).map((r) => [r.round, r.usedBy])).toEqual([
        [1, "worker-b"],
        [2, null],
      ]);
      store.saveAgentAssignment(
        {
          project: "demo",
          pr: 7,
          headSha: HEAD,
          slot: 0,
          round: 2,
          state: "assigned",
          agent: "rev-b",
          runId: "run-1",
          chainId: "chain-1",
          attempts: 1,
          notBefore: 0,
          detail: "run run-1",
          spec: {
            tier: "amber",
            reviewer: null,
            exclude: ["worker-a"],
            author: "worker-a",
            pool: ["rev-b"],
            differentModel: false,
            authorModel: null,
            repo: "example-org/demo",
            base: "main",
            url: null,
            label: "The amber tier needs a peer",
            tried: [],
          },
          updatedAt: "2026-03-02T12:00:00.000Z",
        },
        { reviewer: "rev-b", model: "model-b" },
      );
      expect(store.getRequest("demo", 7, HEAD, 0)).toMatchObject({ round: 2, reviewer: "rev-b", model: "model-b" });
      expect(store.getAgentAssignment("demo", 7, HEAD, 0)).toMatchObject({ round: 2, state: "assigned", agent: "rev-b" });
    } finally {
      store.close();
    }

    // Opening it again doesn't migrate again: the rows stay as they are
    const again = new ReviewStore(path);
    try {
      expect(again.requestRounds("demo", 7, HEAD, 0).map((r) => r.round)).toEqual([1, 2]);
      expect(again.listReviews("demo", 7)).toHaveLength(1);
    } finally {
      again.close();
    }
  });
});
