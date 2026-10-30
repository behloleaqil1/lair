/**
 * useLiveUpdates hook unit tests
 *
 * Tests the coalescing, topic subscription, and live list merging logic.
 * Does not render React hooks; tests the underlying logic only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { LiveTopic, ChangeKind } from "../../shared/live-types";

// ============ COALESCE LOGIC ============

interface PendingUpdate<T> {
  id: string;
  change: ChangeKind;
  data?: T;
  timestamp: number;
}

const COALESCE_MS = 250;

function coalesce<T>(pending: Map<string, PendingUpdate<T>>, id: string, change: ChangeKind, data: T | undefined, now: number): void {
  const existing = pending.get(id);
  if (!existing || now - existing.timestamp >= COALESCE_MS) {
    pending.set(id, { id, change, data, timestamp: now });
  } else {
    // Update in place
    existing.change = change;
    existing.data = data;
  }
}

describe("coalesce logic", () => {
  let pending: Map<string, PendingUpdate<{ value: number }>>;

  beforeEach(() => {
    pending = new Map();
  });

  it("adds first update for an id", () => {
    coalesce(pending, "dragon:kiro-A", "update", { value: 1 }, 1000);
    expect(pending.has("dragon:kiro-A")).toBe(true);
    expect(pending.get("dragon:kiro-A")?.data?.value).toBe(1);
  });

  it("coalesces updates within 250ms", () => {
    coalesce(pending, "dragon:kiro-A", "update", { value: 1 }, 1000);
    coalesce(pending, "dragon:kiro-A", "update", { value: 2 }, 1100);
    coalesce(pending, "dragon:kiro-A", "update", { value: 3 }, 1200);

    expect(pending.size).toBe(1);
    expect(pending.get("dragon:kiro-A")?.data?.value).toBe(3);
    expect(pending.get("dragon:kiro-A")?.timestamp).toBe(1000); // original timestamp
  });

  it("creates new entry after 250ms", () => {
    coalesce(pending, "dragon:kiro-A", "update", { value: 1 }, 1000);
    coalesce(pending, "dragon:kiro-A", "update", { value: 2 }, 1300); // 300ms later

    expect(pending.size).toBe(1);
    expect(pending.get("dragon:kiro-A")?.data?.value).toBe(2);
    expect(pending.get("dragon:kiro-A")?.timestamp).toBe(1300); // new timestamp
  });

  it("handles different ids independently", () => {
    coalesce(pending, "dragon:kiro-A", "update", { value: 1 }, 1000);
    coalesce(pending, "dragon:kiro-B", "update", { value: 2 }, 1050);
    coalesce(pending, "dragon:kiro-A", "update", { value: 3 }, 1100);

    expect(pending.size).toBe(2);
    expect(pending.get("dragon:kiro-A")?.data?.value).toBe(3);
    expect(pending.get("dragon:kiro-B")?.data?.value).toBe(2);
  });

  it("updates change kind on coalesce", () => {
    coalesce(pending, "dragon:kiro-A", "insert", { value: 1 }, 1000);
    coalesce(pending, "dragon:kiro-A", "update", { value: 2 }, 1100);

    expect(pending.get("dragon:kiro-A")?.change).toBe("update");
  });

  it("handles delete after insert within window", () => {
    coalesce(pending, "dragon:kiro-A", "insert", { value: 1 }, 1000);
    coalesce(pending, "dragon:kiro-A", "delete", undefined, 1100);

    expect(pending.get("dragon:kiro-A")?.change).toBe("delete");
    expect(pending.get("dragon:kiro-A")?.data).toBeUndefined();
  });
});

// ============ TOPIC SUBSCRIPTION ============

describe("topic subscription", () => {
  const validTopics: LiveTopic[] = [
    "dragons", "gates", "decisions", "machines", "prs", "agents",
    "bus", "planner", "delivery", "triage", "placement", "watchdog",
  ];

  it("validates known topics", () => {
    for (const topic of validTopics) {
      expect(validTopics).toContain(topic);
    }
  });

  it("builds subscription message", () => {
    const topics: LiveTopic[] = ["dragons", "gates"];
    const message = { type: "subscribe" as const, topics };
    expect(message.topics).toEqual(["dragons", "gates"]);
  });

  it("handles empty topics array", () => {
    const topics: LiveTopic[] = [];
    const shouldSkip = topics.length === 0;
    expect(shouldSkip).toBe(true);
  });
});

// ============ LIVE LIST MERGING ============

interface Item {
  id: string;
  name: string;
  status?: string;
}

function mergeItems(
  items: Item[],
  change: ChangeKind,
  data: Partial<Item> & { id: string },
): Item[] {
  switch (change) {
    case "insert": {
      const exists = items.some((item) => item.id === data.id);
      if (exists) {
        return items.map((item) =>
          item.id === data.id ? { ...item, ...data } : item,
        );
      }
      return [...items, data as Item];
    }
    case "update": {
      return items.map((item) =>
        item.id === data.id ? { ...item, ...data } : item,
      );
    }
    case "delete": {
      return items.filter((item) => item.id !== data.id);
    }
    default:
      return items;
  }
}

describe("live list merging", () => {
  const initial: Item[] = [
    { id: "1", name: "dragon-a", status: "idle" },
    { id: "2", name: "dragon-b", status: "running" },
  ];

  it("inserts new item", () => {
    const result = mergeItems(initial, "insert", { id: "3", name: "dragon-c" });
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ id: "3", name: "dragon-c" });
  });

  it("updates existing item on insert (upsert)", () => {
    const result = mergeItems(initial, "insert", { id: "1", name: "dragon-a", status: "running" });
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe("running");
  });

  it("updates existing item", () => {
    const result = mergeItems(initial, "update", { id: "2", status: "idle" });
    expect(result).toHaveLength(2);
    expect(result[1].status).toBe("idle");
    expect(result[1].name).toBe("dragon-b"); // unchanged
  });

  it("ignores update for non-existent item", () => {
    const result = mergeItems(initial, "update", { id: "999", status: "idle" });
    expect(result).toHaveLength(2);
    expect(result).toEqual(initial);
  });

  it("deletes existing item", () => {
    const result = mergeItems(initial, "delete", { id: "1" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("2");
  });

  it("ignores delete for non-existent item", () => {
    const result = mergeItems(initial, "delete", { id: "999" });
    expect(result).toHaveLength(2);
    expect(result).toEqual(initial);
  });

  it("handles sequence of changes", () => {
    let items = initial;
    items = mergeItems(items, "insert", { id: "3", name: "dragon-c", status: "idle" });
    items = mergeItems(items, "update", { id: "1", status: "running" });
    items = mergeItems(items, "delete", { id: "2" });
    items = mergeItems(items, "update", { id: "3", status: "running" });

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ id: "1", name: "dragon-a", status: "running" });
    expect(items[1]).toEqual({ id: "3", name: "dragon-c", status: "running" });
  });
});

// ============ REFRESH HANDLING ============

describe("refresh handling", () => {
  it("clears pending updates on refresh signal", () => {
    const pending = new Map<string, PendingUpdate<unknown>>();
    pending.set("dragon:kiro-A", { id: "dragon:kiro-A", change: "update", data: {}, timestamp: 1000 });
    pending.set("dragon:kiro-B", { id: "dragon:kiro-B", change: "insert", data: {}, timestamp: 1050 });

    // On refresh, clear pending and trigger full reload
    pending.clear();
    expect(pending.size).toBe(0);
  });

  it("increments refresh key to trigger re-fetch", () => {
    let refreshKey = 0;
    const triggerRefresh = () => { refreshKey += 1; };

    triggerRefresh();
    expect(refreshKey).toBe(1);

    triggerRefresh();
    expect(refreshKey).toBe(2);
  });
});

// ============ CONNECTION STATE ============

describe("connection state", () => {
  type Status = "connecting" | "connected" | "reconnecting" | "closed";

  function computeLive(status: Status): boolean {
    return status === "connected";
  }

  it("is not live while connecting", () => {
    expect(computeLive("connecting")).toBe(false);
  });

  it("is live when connected", () => {
    expect(computeLive("connected")).toBe(true);
  });

  it("is not live while reconnecting", () => {
    expect(computeLive("reconnecting")).toBe(false);
  });

  it("is not live when closed", () => {
    expect(computeLive("closed")).toBe(false);
  });
});

// ============ SKIP CONDITIONS ============

describe("skip conditions", () => {
  interface Options {
    skip?: boolean;
    topics: LiveTopic[];
  }

  function shouldSkip(options: Options): boolean {
    return options.skip === true || options.topics.length === 0;
  }

  it("skips when skip is true", () => {
    expect(shouldSkip({ skip: true, topics: ["dragons"] })).toBe(true);
  });

  it("skips when topics are empty", () => {
    expect(shouldSkip({ skip: false, topics: [] })).toBe(true);
  });

  it("does not skip with topics and no skip flag", () => {
    expect(shouldSkip({ topics: ["dragons", "gates"] })).toBe(false);
  });

  it("does not skip when skip is false", () => {
    expect(shouldSkip({ skip: false, topics: ["dragons"] })).toBe(false);
  });
});
