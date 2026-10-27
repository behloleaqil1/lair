/**
 * An agent's detail, rendered to markup with the real component: what it
 * shows of the task and the run, and that the log and every action are the
 * owner's (signed out: a notice, no buttons; signed in: the log and the
 * Release and Fresh session buttons).
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dragon } from "../../shared/types";
import type { AgentRunView, AgentsStatusView } from "../../shared/agents-types";
import { AgentDetailView, type AgentDetailData } from "./AgentDetail";

const noop = () => undefined;

const run: AgentRunView = {
  id: "1a2b3c4d-0000-4000-8000-000000000001",
  project: "demo",
  task: "feat-login",
  agent: "kiro-A",
  chainId: "c",
  attempt: 1,
  profileIndex: 0,
  profile: { adapter: "claude", model: "opus", provider: "anthropic" },
  sessionId: "5e5510n0",
  sessionMode: "new",
  sameSessionRestarts: 0,
  freshSessions: 0,
  startRetries: 0,
  state: "running",
  detail: "alive",
  requestedAt: "2026-10-27T11:00:00.000Z",
  notBefore: "2026-10-27T11:00:00.000Z",
  spawnedAt: "2026-10-27T11:01:00.000Z",
};

const status = {
  project: "demo",
  enabled: true,
  readOnly: false,
  agents: [
    {
      id: "kiro-A",
      state: "working",
      detail: "working",
      run,
      profiles: [run.profile],
      claims: [{ task: "feat-login", runId: run.id, agent: "kiro-A", ownerPid: 5001, ownerStartedAt: "x", ownerAlive: true, claimedAt: run.requestedAt }],
      recoveries: [],
      budget: null,
    },
  ],
  fill: {
    enabled: true,
    lines: [
      {
        line: 3,
        agent: "kiro-A",
        name: null,
        task: "feat-logout",
        description: null,
        state: "held",
        detail: "its last run failed",
        hold: "owner",
        releasable: true,
        runId: null,
      },
    ],
  },
} as unknown as AgentsStatusView;

const dragons: Dragon[] = [{ id: "kiro-A", name: "Smaug", task: "feat-login", running: true }];

function render(signedIn: boolean | null, log: AgentDetailData["log"] = { data: null, loading: false, error: null }): string {
  return renderToStaticMarkup(
    createElement(AgentDetailView, {
      id: "kiro-A",
      project: "demo",
      refreshKey: 0,
      dragons,
      status,
      readOnly: false,
      dragonConfig: null,
      onChanged: noop,
      onClose: noop,
      data: {
        signedIn,
        runs: { data: [run], loading: false, error: null },
        queue: { data: [], loading: false, error: null },
        log,
      },
    }),
  );
}

describe("agent detail", () => {
  it("shows the task, the current run and the hold fill keeps for the owner", () => {
    const html = render(true);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Smaug");
    expect(html).toContain("feat-login");
    expect(html).toContain("claude / opus");
    expect(html).toContain("held: owner");
    expect(html).toContain("its last run failed");
  });

  it("signed out: the log and every action are the owner's, and say where to sign in", () => {
    const html = render(false);
    expect(html).toContain('data-owner-only="signed-out"');
    expect(html).toContain("shown to the owner only");
    expect(html).toContain('href="#/decisions"');
    expect(html).not.toContain(">Release<");
    expect(html).not.toContain(">Fresh session<");
    // Still unknown (the check hasn't answered): no buttons either
    expect(render(null)).not.toContain(">Release<");
  });

  it("signed in: the log tail and the owner's buttons", () => {
    const html = render(true, {
      data: {
        agent: "kiro-A",
        source: "run",
        runId: run.id,
        log: { file: "kiro-A-20261027T110100Z.log", lines: ["started", "working on feat-login"], truncated: true, sizeBytes: 9000, modifiedAt: run.spawnedAt! },
      },
      loading: false,
      error: null,
    });
    expect(html).not.toContain('data-owner-only="signed-out"');
    expect(html).toContain("kiro-A-20261027T110100Z.log");
    expect(html).toContain("started\nworking on feat-login");
    expect(html).toContain("the last 2 lines");
    expect(html).toContain(">Release<");
    expect(html).toContain(">Fresh session<");
  });
});
