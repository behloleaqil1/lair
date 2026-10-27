/**
 * A shutdown or a Restart during a merge: the real ReviewManager, GitHub
 * provider and store; only the host's HTTP API (held at a gate here), git
 * and the clock are stand-ins. The merge in progress finishes on an open
 * store before it closes, a new merge is refused meanwhile, and the owner's
 * Restart answers 409 while it runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { RestartController } from "../restart/index.js";
import { ReviewManager } from "./service.js";
import type { FetchLike } from "./github.js";
import { FakeClock, FakeGit, FakeRemote, fakeGitHubApi, type Person } from "./testing/fakes.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const AGENT: Person = { name: "Fleet Agent", email: "12345+fleet@users.noreply.github.com" };

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lair-review-drain-"));
  const remote = new FakeRemote();
  const base = remote.commit([], AGENT, "initial");
  remote.branches.set("main", base);
  remote.setChecks(base, [["build", "success"]]);
  const head = remote.commit([base], AGENT, "change");
  remote.openPull({
    number: 3,
    title: "A change",
    headRef: "agent/worker-a/change",
    headSha: head,
    files: [{ filename: "docs/usage.md", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }],
  });
  remote.setChecks(head, [["build", "success"]]);

  // The host's API, held while `held` is set
  const api = fakeGitHubApi(remote);
  let release: () => void = () => undefined;
  let held: Promise<void> | null = null;
  let waiting = 0;
  const fetch: FetchLike = async (url, init) => {
    if (held) {
      waiting++;
      await held;
    }
    return api(url, init);
  };
  const hold = () => {
    held = new Promise((resolve) => {
      release = () => {
        held = null;
        resolve();
      };
    });
  };

  const manager = new ReviewManager({
    dbPath: join(dir, "review.db"),
    clock: new FakeClock(NOW),
    git: new FakeGit(remote),
    fetch,
    env: {},
    cwd: dir,
  });
  const config: ProjectConfig = {
    name: "demo",
    repo: "/home/user/demo",
    github: "example-org/demo",
    queue_file: "/home/user/demo/work/queue.md",
    agents_dir: "/home/user/demo/work/agents",
    gates_dir: "/home/user/demo/work/gates",
    machines: {},
    read_only: false,
    review: {
      enabled: true,
      authors: { branch_pattern: "agent/{agent}/**", models: { "worker-a": "model-one" } },
      merge: { gate: { source: "checks", required: ["build"] }, work_dir: join(dir, "work") },
    },
  };
  manager.load([{ name: "demo", config }]);
  return { manager, head, hold, release: () => release(), waiting: () => waiting };
}

describe("review drain on shutdown and Restart", () => {
  it("a merge in progress finishes on an open store before stop() closes it; a new one is refused", async () => {
    const h = setup();
    const service = h.manager.get("demo")!;
    h.hold();
    const merging = service.merge(3, { confirm: true, headSha: h.head, by: "owner" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.waiting()).toBeGreaterThan(0);
    expect(h.manager.busy()).toEqual(["a merge in demo"]);

    // The owner's Restart says not now
    const restart = new RestartController({
      shutdown: async () => undefined,
      exit: () => undefined,
      configPath: join(dir!, "server.yaml"),
      busy: () => h.manager.busy(),
      log: { log: () => undefined, warn: () => undefined, error: () => undefined },
    });
    expect(restart.request({ update: false })).toMatchObject({ ok: false, code: 409, error: expect.stringContaining("a merge in demo") });

    let stopped = false;
    const stopping = h.manager.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // stop() waits for the merge; a new merge is refused
    expect(stopped).toBe(false);
    await expect(service.merge(3, { confirm: true, headSha: h.head, by: "owner" })).rejects.toMatchObject({ statusCode: 503 });

    h.release();
    // It ends as it would have without the shutdown (here: refused, no review yet), reading the store
    const result = await merging;
    expect(result).toMatchObject({ merged: false });
    expect(result.reasons.join("\n")).toContain("Required reviews");
    await stopping;
    expect(stopped).toBe(true);
    expect(h.manager.get("demo")).toBeUndefined();
    expect(h.manager.busy()).toEqual([]);
  });

  it("stop() without a merge in progress closes at once", async () => {
    const h = setup();
    expect(h.manager.busy()).toEqual([]);
    await h.manager.stop();
    expect(h.manager.get("demo")).toBeUndefined();
  });
});
