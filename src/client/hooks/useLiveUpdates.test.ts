/**
 * useLiveUpdates hook unit tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useLiveUpdates, useLiveList, type LiveUpdateHandler } from "./useLiveUpdates";
import type { LiveTopic, ChangeKind } from "../../shared/live-types";

// Mock live-socket
vi.mock("./live-socket", () => ({
  LiveSocket: vi.fn().mockImplementation((options) => {
    const instance = {
      state: { status: "connecting", attempt: 0, retryInMs: null, error: null },
      subscriptions: options.channels || [],
      start: vi.fn(),
      stop: vi.fn(),
      send: vi.fn().mockReturnValue(true),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      reconnectNow: vi.fn(),
      _options: options,
    };
    // Immediately simulate connection
    setTimeout(() => {
      instance.state.status = "connected";
      options.onState?.(instance.state);
    }, 0);
    return instance;
  }),
}));

describe("useLiveUpdates", () => {
  const defaultOptions = {
    project: "test-project",
    topics: ["dragons", "gates"] as LiveTopic[],
    handler: {
      onUpdate: vi.fn(),
      onRefresh: vi.fn(),
    } as LiveUpdateHandler,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in connecting state", () => {
    const { result } = renderHook(() => useLiveUpdates(defaultOptions));
    expect(result.current.status).toBe("connecting");
    expect(result.current.live).toBe(false);
  });

  it("transitions to live when connected", async () => {
    const { result } = renderHook(() => useLiveUpdates(defaultOptions));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => {
      expect(result.current.status).toBe("connected");
      expect(result.current.live).toBe(true);
    });
  });

  it("skips connection when skip is true", () => {
    const { result } = renderHook(() =>
      useLiveUpdates({ ...defaultOptions, skip: true }),
    );
    expect(result.current.status).toBe("closed");
    expect(result.current.live).toBe(false);
  });

  it("skips connection when topics are empty", () => {
    const { result } = renderHook(() =>
      useLiveUpdates({ ...defaultOptions, topics: [] }),
    );
    expect(result.current.status).toBe("closed");
    expect(result.current.live).toBe(false);
  });
});

describe("useLiveList", () => {
  const initial = [
    { id: "1", name: "dragon-a" },
    { id: "2", name: "dragon-b" },
  ];

  const defaultOptions = {
    project: "test-project",
    topics: ["dragons"] as LiveTopic[],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns initial items", () => {
    const { result } = renderHook(() => useLiveList(initial, defaultOptions));
    const [items] = result.current;
    expect(items).toEqual(initial);
  });

  it("updates items when initial changes", () => {
    const { result, rerender } = renderHook(
      ({ items }) => useLiveList(items, defaultOptions),
      { initialProps: { items: initial } },
    );

    const newItems = [
      { id: "3", name: "dragon-c" },
    ];
    rerender({ items: newItems });

    const [items] = result.current;
    expect(items).toEqual(newItems);
  });
});
