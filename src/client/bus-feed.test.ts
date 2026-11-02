import { describe, expect, it } from "vitest";
import { MAX_FEED, feedFromActivity, mergeFeed, parseBusUpdate, type FeedItem } from "./bus-feed";
import type { BusActivity } from "../shared/bus-live";

const T = (s: number) => new Date(Date.UTC(2026, 2, 2, 12, 0, s)).toISOString();

const activity: BusActivity = {
  reports: [{ type: "report", id: 1, at: T(1), agent: "worker-a", task: "feat-x", kind: "WAITING", summary: "waits", gateId: "gate-1", pr: null, sha: null }],
  messages: [{ id: "m1", at: T(2), from: "owner", to: "worker-a", state: "sent", text: "rebase please" }],
  claims: [{ agent: "worker-a", task: "feat-x", at: T(0) }],
  owner: true,
};

describe("bus feed", () => {
  it("builds the first page newest first, one item per report, message and claim", () => {
    const items = feedFromActivity(activity);
    expect(items.map((i) => i.key)).toEqual(["message:m1", "report:1", `claim:taken:worker-a:feat-x:${T(0)}`]);
  });

  it("moves a message's state forward only, keeping its text and first time", () => {
    const first = feedFromActivity(activity);
    const read = parseBusUpdate({ events: [{ type: "message", id: "m1", at: T(5), to: "worker-a", state: "read" }], dropped: 0 })!;
    const afterRead = mergeFeed(first, read.items);
    expect(afterRead.find((i) => i.key === "message:m1")).toMatchObject({ state: "read", text: "rebase please", from: "owner", at: T(2) });
    const stale = parseBusUpdate({ events: [{ type: "message", id: "m1", at: T(6), from: "owner", to: "worker-a", state: "sent" }] })!;
    expect(mergeFeed(afterRead, stale.items).find((i) => i.key === "message:m1")).toMatchObject({ state: "read" });
    expect(mergeFeed(afterRead, read.items)).toHaveLength(afterRead.length);
  });

  it("keeps at most MAX_FEED items, the newest", () => {
    const many: FeedItem[] = Array.from({ length: MAX_FEED + 30 }, (_, i) => ({
      key: `claim:taken:a:t${i}:${T(i)}`,
      type: "claim",
      claim: "taken",
      agent: "a",
      task: `t${i}`,
      at: new Date(Date.UTC(2026, 2, 2, 12, 0, 0) + i * 1000).toISOString(),
    }));
    const merged = mergeFeed([], many);
    expect(merged).toHaveLength(MAX_FEED);
    expect(merged[0].type === "claim" && merged[0].task).toBe(`t${MAX_FEED + 29}`);
  });

  it("checks a socket update field by field and leaves out what doesn't check", () => {
    expect(parseBusUpdate(null)).toBeNull();
    expect(parseBusUpdate({ events: "nope" })).toBeNull();
    const update = parseBusUpdate({
      dropped: 3,
      events: [
        { type: "report", id: 2, at: T(9), agent: "worker-b", task: "feat-y", kind: "DONE", summary: "merged", pr: 12, sha: "abc1234" },
        { type: "report", id: 3, at: T(9), agent: "worker-b", task: "feat-y", kind: "MERGED" },
        { type: "message", id: "m2", at: T(9), to: "owner", state: "lost" },
        { type: "claim", at: T(9), agent: "worker-b", task: "feat-y", claim: "released" },
        { type: "unknown", at: T(9) },
      ],
    })!;
    expect(update.dropped).toBe(3);
    expect(update.items.map((i) => i.key)).toEqual(["report:2", `claim:released:worker-b:feat-y:${T(9)}`]);
    expect(update.items[0]).toMatchObject({ gateId: null, pr: 12, sha: "abc1234" });
  });
});
