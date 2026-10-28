/**
 * Fixture answers for the dashboard's API routes, for tests that render the
 * whole app in a DOM (a11y.test.tsx): a small project with a few agents, a
 * failed gate, a pull request and two decisions. `fixtureFetch` answers by
 * path; a route without a fixture answers as a server error would, so the
 * view shows its error state (which is checked too).
 */
import type { Dragon, Gate, GateResult, MachineStatus, OverviewData, PullRequest } from "../shared/types";
import type { DashboardModules, ModuleFlags } from "../shared/dashboard-types";
import type { Decision } from "../shared/decision-types";
import type { ConfigStatusView, RestartStatusView } from "../shared/lifecycle-types";
import type { ChatStatusView, DigestView } from "../shared/supervisor-types";
import type { DecisionSummary } from "./decisions-api";

export const FIXTURE_NOW = "2026-10-27T10:00:00Z";

export const FIXTURE_MODULES: ModuleFlags = {
  agents: false,
  fill: false,
  planner: false,
  review: false,
  triage: false,
  placement: false,
  pipelines: false,
  delivery: false,
  watchdog: false,
  processes: false,
  github: true,
  machines: true,
  nodes: false,
};

const decisions: Decision[] = [
  {
    id: "0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b",
    project: "demo",
    kind: "escalation",
    attention: "action",
    title: "worker-a is paused: its last run failed while Lair was restarting",
    context: "The run's process was gone after the restart.",
    options: [
      { id: "start_again", label: "Start it again", consequences: "Fill starts it on its next check." },
      { id: "keep_held", label: "Keep it paused", consequences: "Fill leaves it until you release it." },
    ],
    recommended: { optionId: "keep_held", reasoning: "" },
    source: { module: "agents", ref: "fill:feat-x" },
    key: "k1",
    blocks: [],
    links: [],
    createdAt: FIXTURE_NOW,
    overdue: false,
    status: "open",
    raisedVia: "server",
  } as Decision,
  {
    id: "7f1d9a40-2b8e-4c7a-9f3e-5a6b7c8d9e0f",
    project: "demo",
    kind: "escalation",
    attention: "notice",
    title: "No merge for 4.2 h",
    context: "",
    options: [{ id: "stand_down", label: "Leave it to me", consequences: "Nothing changes." }],
    recommended: { optionId: "stand_down", reasoning: "" },
    source: { module: "watchdog", ref: "merge-gap" },
    key: "k2",
    blocks: [],
    links: [],
    createdAt: FIXTURE_NOW,
    overdue: false,
    status: "open",
    raisedVia: "server",
  } as Decision,
];

const dragons: Dragon[] = [
  { id: "worker-a", name: "worker-a", task: "feat-x", running: true, lastLogTime: FIXTURE_NOW, lastLogLine: "running tests" },
  { id: "worker-b", name: "worker-b", task: "", running: false },
];

const queue: Gate[] = [
  { id: "g-2", lane: "heavy", priority: 1, status: "running", branch: "feat-x", track: "feat-x", startTime: FIXTURE_NOW, currentStep: "test" },
  { id: "g-3", lane: "light", priority: 2, status: "queued", branch: "feat-y", track: "feat-y" },
];

const results: GateResult[] = [{ id: "g-1", rc: 1, finishedAt: FIXTURE_NOW, failedSteps: ["test"], duration: 600 }];

const machines: MachineStatus[] = [
  { name: "local", type: "local", up: true, lastCheck: FIXTURE_NOW },
  { name: "build-2", type: "ssh", up: false, lastCheck: FIXTURE_NOW },
];

const prs: PullRequest[] = [
  {
    number: 7,
    title: "feat: the export button",
    headRefName: "feat-x",
    headRefOid: "abc1234def5678",
    mergeable: "MERGEABLE",
    updatedAt: FIXTURE_NOW,
    mergeReady: true,
  },
];

const overview: OverviewData = {
  project: "demo",
  mainHead: "abc1234",
  mainDate: "2026-10-27 09:00:00 +0000",
  recentMerges: [{ number: 6, title: "fix: the retry budget", mergedAt: FIXTURE_NOW }],
  problems: [{ type: "no_runner", severity: "warning", message: "No runner on build-2", details: "It has not answered for 10 minutes." }],
  agentCounts: { running: 1, idle: 1 },
  gateCounts: { queued: 1, running: 1 },
};

const restart: RestartStatusView = {
  state: "idle",
  startedAt: FIXTURE_NOW,
  configFile: "data/server.yaml",
  configError: null,
  update: { configured: true, steps: [["git", "pull"]], timeoutSeconds: 600 },
  serviceManager: { name: "launchd", source: "detected", note: "" },
  output: [],
  error: null,
  requestedAt: null,
};

const chat: ChatStatusView = {
  project: "demo",
  enabled: true,
  digest: { enabled: true, time: "08:00" },
  agent: "worker-a",
  problem: null,
  limits: { maxRunsPerDay: 20, minIntervalSeconds: 60, maxConversationTurns: 10, answerTimeoutMinutes: 15 },
  runsToday: 1,
  nextRunAt: null,
  conversations: [],
  repoUrl: "https://github.com/example-org/demo",
};

const digest: DigestView = { project: "demo", enabled: true, time: "08:00", latest: null };

const summary: DecisionSummary = { open: 2, overdue: 0, action: 1, notices: 1, secretStore: "server memory only" };

const config: ConfigStatusView = { watching: true, problems: [], recent: [] };

const modules: DashboardModules = { project: "demo", readOnly: false, error: null, modules: FIXTURE_MODULES };

/** The data of each GET route, by path (no query) */
export const FIXTURE_ROUTES: Record<string, unknown> = {
  "/api/projects": ["demo"],
  "/api/projects/default": "demo",
  "/api/controls/status": { readOnly: false, orchestratorPaused: true, tickRunning: false },
  "/api/dashboard/modules": modules,
  "/api/owner/session": { signedIn: true, session: { id: "s-1", createdAt: FIXTURE_NOW, lastUsedAt: FIXTURE_NOW, userAgent: "test" } },
  "/api/owner/sessions": { session: "session-value", info: { id: "s-1", createdAt: FIXTURE_NOW, lastUsedAt: FIXTURE_NOW, userAgent: "test" } },
  "/api/owner/restart": restart,
  "/api/supervisor/chat": chat,
  "/api/supervisor/digest": digest,
  "/api/decisions/summary": summary,
  "/api/decisions": decisions,
  "/api/config/status": config,
  "/api/overview": overview,
  "/api/dragons": dragons,
  "/api/gates": { queue, results },
  "/api/machines": machines,
  "/api/prs": prs,
};

/** A fetch that answers from FIXTURE_ROUTES (and `extra`, which wins) */
export function fixtureFetch(extra: Record<string, unknown> = {}): typeof fetch {
  const routes = { ...FIXTURE_ROUTES, ...extra };
  return async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lair.test");
    const data = routes[url.pathname];
    const body = data === undefined ? { success: false, error: `No fixture for ${url.pathname}` } : { success: true, data };
    return new Response(JSON.stringify(body), { status: data === undefined ? 500 : 200, headers: { "Content-Type": "application/json" } });
  };
}
