// @vitest-environment jsdom
/**
 * Home → Bus: the feed as it renders (report cards with gate and PR links,
 * claims, message delivery states, texts only for the owner), the tab
 * mounted with its first page and a live update over a fake socket, and the
 * off state, which asks for nothing but the consumers' status and opens no
 * socket. The boundaries faked: fetch and the browser's WebSocket.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { BusFeedView, BusPanel } from "./BusPanel";
import { feedFromActivity } from "../bus-feed";
import type { BusActivity } from "../../shared/bus-live";

const T = (s: number) => new Date(Date.UTC(2026, 2, 2, 12, 0, s)).toISOString();

const ACTIVITY: BusActivity = {
  reports: [{ type: "report", id: 1, at: T(3), agent: "worker-a", task: "feat-x", kind: "WAITING", summary: "waits on its gate", gateId: "gate-1", pr: 7, sha: "abc1234def" }],
  messages: [
    { id: "m1", at: T(2), from: "owner", to: "worker-a", state: "acknowledged" },
    { id: "m2", at: T(1), from: "worker-a", to: "owner", state: "read" },
    { id: "m3", at: T(0), from: "owner", to: "worker-b", state: "sent" },
  ],
  claims: [{ agent: "worker-a", task: "feat-x", at: T(0) }],
  owner: false,
};

const consumers = (mode: "off" | "observe") => ({
  mode,
  received: 4,
  refused: [],
  refusedCount: 0,
  observations: { total: 3, matches: 2, mismatches: 1, recent: [] },
});

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function mount(answers: Record<string, unknown>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const fetchMock = vi.fn(async (url: string) => {
    const route = Object.keys(answers).find((prefix) => url.startsWith(prefix));
    return { json: async () => (route ? { success: true, data: answers[route] } : { success: false, error: `unexpected ${url}` }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(BusPanel, { project: "shop", refreshKey: 0 })));
  await settle();
  return fetchMock;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe("Bus feed view", () => {
  it("renders report cards with gate and PR links, claims, and each message's delivery state", () => {
    const html = renderToStaticMarkup(createElement(BusFeedView, { items: feedFromActivity(ACTIVITY), status: "connected", owner: false, error: null }));
    expect(html).toContain("WAITING");
    expect(html).toContain('href="#/gates/gate-1"');
    expect(html).toContain('href="#/prs/7"');
    expect(html).toContain("abc1234<");
    expect(html).toContain("CLAIMED");
    for (const state of ["Acknowledged", "Read", "Sent"]) expect(html).toContain(state);
    expect(html).toContain('data-bus="no-texts"');
    expect(html.match(/data-bus-item="message"/g)).toHaveLength(3);
  });

  it("shows message texts and ack notes when the owner's first page has them", () => {
    const owned: BusActivity = { ...ACTIVITY, owner: true, messages: [{ id: "m1", at: T(2), from: "owner", to: "worker-a", state: "acknowledged", text: "rebase on main", ackNote: "done" }] };
    const html = renderToStaticMarkup(createElement(BusFeedView, { items: feedFromActivity(owned), status: "connected", owner: true, error: null }));
    expect(html).toContain("rebase on main");
    expect(html).toContain("Note: done");
    expect(html).not.toContain('data-bus="no-texts"');
  });
});

describe("Bus tab", () => {
  it("loads the first page, then merges a live update from the `bus` channel", async () => {
    const fetchMock = await mount({ "/api/bus/consumers": consumers("observe"), "/api/bus/activity": ACTIVITY });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/bus/consumers?project=shop", "/api/bus/activity?limit=100&project=shop"]);
    expect(host!.textContent).toContain("waits on its gate");
    expect(host!.textContent).toContain("different:");
    const [socket] = FakeSocket.instances;
    expect(socket.url).toContain("/ws?project=shop");
    act(() => {
      socket.readyState = 1;
      socket.onopen?.();
    });
    expect(socket.sent.map((s) => JSON.parse(s))).toContainEqual({ type: "subscribe", channels: ["bus"] });
    const update = { events: [{ type: "report", id: 2, at: T(9), agent: "worker-b", task: "feat-y", kind: "DONE", summary: "merged it", gateId: null, pr: 12, sha: null }], dropped: 0 };
    act(() => socket.onmessage?.({ data: JSON.stringify({ type: "update", channel: "bus", data: update, timestamp: T(9) }) }));
    expect(host!.textContent).toContain("merged it");
    expect(host!.querySelector('[data-bus-item="report"] a.feed-pr')?.getAttribute("href")).toBe("#/prs/12");
  });

  it("says the bus is off, asks for nothing but the consumers' status and opens no socket", async () => {
    const fetchMock = await mount({ "/api/bus/consumers": consumers("off") });
    expect(host!.textContent).toContain("The bus is off for this project");
    expect(host!.textContent).toContain("bus.consume");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/bus/consumers?project=shop"]);
    expect(FakeSocket.instances).toHaveLength(0);
  });
});
