/**
 * The supervisor's chat in the dashboard, rendered to markup with the real
 * components: a question while its run looks, an answer rendered from
 * untrusted Markdown (no HTML, no image, links only to the dashboard and the
 * repository's host) with its evidence collapsed, no answer with the
 * reason, Home's "Ask Lair" card and the digest card.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatStatusView, ConversationTurn, DigestView } from "../../shared/supervisor-types";
import { askGoesToSupervisor, chatHint, hasPending, LOOKING, turnStatus } from "../supervisor-chat";
import { SafeMarkdown } from "./SafeMarkdown";
import { AskLairCardView, DigestCardView, TurnView } from "./SupervisorChat";

const policy = { repoUrl: "https://github.com/example-org/demo" };
const noop = () => undefined;

const turn = (over: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id: "t-1",
  seq: 1,
  question: "Why is worker-a held?",
  askedAt: "2026-10-28T09:00:00.000Z",
  state: "pending",
  runId: "r-1",
  agent: "sup",
  deadlineAt: "2026-10-28T09:15:00.000Z",
  answer: null,
  evidence: [],
  answeredAt: null,
  reason: null,
  ...over,
});

const status = (over: Partial<ChatStatusView> = {}): ChatStatusView => ({
  project: "demo",
  enabled: true,
  digest: { enabled: false, time: "08:00" },
  agent: "sup",
  problem: null,
  limits: { maxRunsPerDay: 20, minIntervalSeconds: 30, maxConversationTurns: 10, answerTimeoutMinutes: 15 },
  runsToday: 3,
  nextRunAt: null,
  conversations: [],
  repoUrl: policy.repoUrl,
  ...over,
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("an answer is rendered as untrusted Markdown", () => {
  const HOSTILE = [
    "# Held <script>alert(1)</script>",
    "",
    "It **failed** while Lair restarted: see [its run](#/work/worker-a) and [PR 7](https://github.com/example-org/demo/pull/7).",
    '<img src=x onerror="alert(1)"> <a href="https://evil.example.com">click</a> [phish](https://evil.example.com/login)',
    "[js](javascript:alert(1)) ![pixel](https://evil.example.com/p.png) <https://evil.example.com/a>",
    "",
    "- **For the owner**: answer [the decision](#/decisions/abc)",
    "- **Lair can do**: release the hold",
    "",
    "```",
    "<b>kept as text</b>",
    "```",
  ].join("\n");

  it("makes no HTML of it, loads no image, and links only to the dashboard and the repository", () => {
    const html = render(createElement(SafeMarkdown, { text: HOSTILE, policy }));
    expect(html).not.toMatch(/<script|<img|<b>|onerror="|javascript:|href="https:\/\/evil/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<h3>Held ");
    expect(html).toContain("<strong>failed</strong>");
    expect(html).toContain('<a href="#/work/worker-a">its run</a>');
    expect(html).toContain('<a href="https://github.com/example-org/demo/pull/7" target="_blank" rel="noopener noreferrer nofollow">PR 7</a>');
    expect(html).toContain('<a href="#/decisions/abc">the decision</a>');
    expect(html).toContain("phish");
    expect(html).toContain("pixel");
    expect(html).toContain("<ul><li><strong>For the owner</strong>: answer");
    expect(html).toContain("<pre><code>&lt;b&gt;kept as text&lt;/b&gt;</code></pre>");
    const links = html.match(/<a /g) ?? [];
    expect(links).toHaveLength(3);
    // Without a repository, only the dashboard's routes are links
    expect(render(createElement(SafeMarkdown, { text: HOSTILE, policy: { repoUrl: null } })).match(/<a /g)).toHaveLength(2);
  });
});

describe("a question in the chat panel", () => {
  it("shows Lair is looking while its run reads, then the answer with its evidence collapsed, or why there is none", () => {
    const looking = render(createElement(TurnView, { turn: turn(), policy }));
    expect(looking).toContain("Why is worker-a held?");
    expect(looking).toContain(LOOKING);
    expect(looking).toContain('data-turn="pending"');

    const answered = render(
      createElement(TurnView, {
        turn: turn({
          state: "answered",
          answer: "Held: see [its run](#/work/worker-a). <img src=x onerror=alert(1)>",
          answeredAt: "2026-10-28T09:02:00.000Z",
          evidence: [{ tool: "events.query", args: { agent: "worker-a" }, note: "escalated at 08:50" }],
        }),
        policy,
      }),
    );
    expect(answered).not.toContain(LOOKING);
    expect(answered).toContain('<a href="#/work/worker-a">its run</a>');
    expect(answered).not.toContain("<img");
    expect(answered).toContain('<details class="chat-evidence" data-evidence="1"><summary>Evidence (1)</summary>');
    expect(answered).toContain("<code>events.query</code>");
    expect(answered).toContain("escalated at 08:50");

    const none = render(
      createElement(TurnView, { turn: turn({ state: "no_answer", reason: "no answer within 15 minutes: Lair stopped its run" }), policy }),
    );
    expect(none).toContain("No answer");
    expect(none).toContain("no answer within 15 minutes: Lair stopped its run");
  });

  it("is read again while a question waits, and the Ask tab goes to the supervisor only when it can answer", () => {
    const view = { id: "c", project: "demo", kind: "chat" as const, digestDate: null, createdAt: "", updatedAt: "", repoUrl: null };
    expect(hasPending({ ...view, turns: [turn({ state: "answered" }), turn({ state: "pending" })] })).toBe(true);
    expect(hasPending({ ...view, turns: [turn({ state: "no_answer" })] })).toBe(false);
    expect(hasPending(null)).toBe(false);
    expect(turnStatus(turn({ state: "answered" }))).toEqual({ label: "Answered", tone: "success" });
    expect(askGoesToSupervisor(status())).toBe(true);
    expect(askGoesToSupervisor(status({ enabled: false }))).toBe(false);
    expect(askGoesToSupervisor(status({ problem: "no supervisor agent" }))).toBe(false);
    expect(askGoesToSupervisor(null)).toBe(false);
  });
});

describe("Home's cards", () => {
  it("Ask Lair: a box and the recent conversations, or how to turn questions on", () => {
    const on = render(
      createElement(AskLairCardView, {
        status: status({
          conversations: [
            { id: "c1", kind: "chat", title: "Why is nothing merging?", createdAt: "", updatedAt: "2026-10-28T09:00:00.000Z", turns: 2, state: "answered" },
          ],
        }),
        onAsk: noop,
        onOpen: noop,
      }),
    );
    expect(on).toContain('data-card="ask-lair"');
    expect(on).toContain("<input");
    expect(on).toContain("Why is nothing merging?");
    expect(on).toContain("3 of 20 supervisor runs in the last 24 hours, answered by sup");
    const off = render(createElement(AskLairCardView, { status: status({ enabled: false }), onAsk: noop, onOpen: noop }));
    expect(off).not.toContain("<input");
    // React writes ' as &#x27;
    expect(off).toContain(chatHint(status({ enabled: false }))!.replace(/'/g, "&#x27;"));
    expect(off).toContain("supervisor.chat.enabled: true");
  });

  it("the digest: the latest one rendered safely, nothing when it is off and there is none", () => {
    const digest = (over: Partial<DigestView> = {}): DigestView => ({ project: "demo", enabled: true, time: "08:00", latest: null, ...over });
    expect(render(createElement(DigestCardView, { view: digest({ enabled: false }) }))).toBe("");
    expect(render(createElement(DigestCardView, { view: digest() }))).toContain("No digest yet: the supervisor writes one every day at 08:00");
    const latest = {
      id: "d1",
      project: "demo",
      kind: "digest" as const,
      digestDate: "2026-10-28",
      createdAt: "",
      updatedAt: "",
      repoUrl: policy.repoUrl,
      turns: [turn({ state: "answered", answer: "## Moved\n\n[PR 7](https://github.com/example-org/demo/pull/7) merged. <script>x</script>" })],
    };
    const html = render(createElement(DigestCardView, { view: digest({ latest }) }));
    expect(html).toContain("Today&#x27;s digest (2026-10-28)");
    expect(html).toContain("<h4>Moved</h4>");
    expect(html).toContain('href="https://github.com/example-org/demo/pull/7"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("Why is worker-a held?");
  });
});
