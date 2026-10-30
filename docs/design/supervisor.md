# Supervisor: Lair's operator

> Status: part built (S1-1 and S1-2, below). Phases S1–S4 below. Roadmap: [ROADMAP.md](ROADMAP.md). The supervisor runs on whatever AI tool and model `ai.roles.supervise` names ([ai-roles.md](ai-roles.md)). Reference: [configuration.md](../configuration.md#supervisor-self-checks-and-the-ops-api) and [Supervisor chat and digest](../configuration.md#supervisor-chat-and-digest).

## What is built, and what remains

| Part | What | State |
|---|---|---|
| **S1-1** | The self-checks below, deterministic and in code, on a schedule off the request path, each with its own timeout (`supervisor.checks`, thresholds per check); `GET /api/health/diagnostics` (owner only) and Home → Health; a check failing for `notice_minutes` raises one notice, withdrawn when it recovers; the ops API's read tools over `POST /api/ops/call`, served to MCP tools by `lair ops-mcp` (stdio), on scoped tokens kept in memory (a run's, bound to its project and ended with the run; or the owner's, for an hour), every call audited in `data/supervisor.db`, answers redacted and bounded | built (`src/server/supervisor/`, `src/cli/ops-mcp.ts`) |
| **S1-2** | Supervisor runs through the agents module, on `supervisor.agent` or the dragon on `ai.roles.supervise`'s first profile, with a run token, `LAIR_URL` and the conversation in the run's environment only: the Ask tab and Home's "Ask Lair" card start a conversation (`POST /api/supervisor/ask`, owner only), each question one run whose prompt is `prompts/supervisor.md` (or `supervisor.prompt_file`) plus the context Lair builds (self-checks, open decisions, the conversation so far, bounded); the run reads Lair with `lair ops call` (or `lair ops-mcp`) and answers by writing `answer.json` (schema: `{answer, evidence, confidence?}`) in its run directory—Lair picks it up as soon as it appears; the CLI path (`lair supervisor answer`) still works for backward compatibility; whichever arrives first wins, and the second is ignored and audited; answers and their evidence cleaned (no HTML, links only to the dashboard and the repository's host) and shown in a chat panel; `supervisor.chat` bounds (runs per day, interval, questions per conversation, answer timeout), "no answer" with the reason and no hot retry; the daily digest (`supervisor.digest`), on Home with one notice when notifications are on; conversations in `data/supervisor.db` (schema 2) | built (`src/server/supervisor/chat.ts`, `src/server/supervisor/answer-file.ts`, `src/cli/ops-call.ts`, `src/cli/supervisor-answer.ts`, `src/client/components/SupervisorChat.tsx`) |
| **S1-3** | The hourly review; diagnoses of failing checks and repeated failure classes; Owner messages answered by the supervisor | next |
| **S2** | `proposals.submit` and proposals as decisions | to do |
| **S3** | `supervisor.act`: the allowlist of acting fixes | to do |
| **S4** | Repair of Lair's own defects | to do |

Not in S1-2: a supervisor run that fails over or is recovered into a new run ends its question (its token was the first run's, and a chain's run variables are fixed when it is requested), so a question is never answered by a second attempt; ACP streaming of the run's progress into the chat (the panel polls the conversation while it waits).

Not in S1-1: the ops API is served over stdio only (`lair ops-mcp` talks to Lair's HTTP route; an MCP endpoint that Lair serves itself over local HTTP can come when a tool needs it), and the retention check measures each watched folder's entries against the check's own limit, since retention itself (roadmap A2) isn't built yet.

A developer running Lair should not need someone at a terminal to answer "why is this agent paused?", to notice that
the server is slow or leaking file handles, or to work around an outage at night. Today the owner, or a coding
assistant in a terminal, does that by reading logs, the queue, the store and the process table. The **supervisor** is
Lair doing it itself. Lair always decides in code what it may do; an AI agent explains, correlates and proposes.

## What it does

1. **Answers questions** about the project and the fleet, from the Ask box or Owner messages. "Why is agent X held?",
   "why is nothing merging?", "which gates failed because of the infrastructure today?" Answers cite their evidence
   (events, runs, results, config lines).
2. **Diagnoses Lair itself.** Deterministic self-checks run all the time (below). When one fails, or a failure class
   repeats, the supervisor correlates it with the rest (events, recent config changes, machines, load) and writes a
   diagnosis: cause, evidence and the fix it recommends.
3. **Supervises.** A periodic review (hourly by default) and a daily digest list:
   - what moved and what is stuck;
   - holds and decisions that are waiting;
   - repeated failures;
   - budget burn;
   - anything trending the wrong way.
4. **Fixes on the run**, within the autonomy the owner gives it:
   - **Observe:** answers and diagnoses only.
   - **Propose:** each fix becomes one Decision Inbox item with the exact change and its evidence. Approving applies it.
   - **Act:** fixes on an allowlist run by themselves. They are reversible and go through the module's own API and
     checks. Anything else is still proposed.
   - **Repair Lair:** a defect in Lair's own code becomes an issue, and then a fix task for a builder agent on Lair's
     repository. That task goes through reviews by agents and the merge policy like any other change. The supervisor
     never edits code or config directly.

## How it is built

- **Self-checks**, deterministic and in code. They run in Lair, are shown on Home and are exposed at
  `GET /api/health/diagnostics` (owner only):
  - event-loop lag and p95 request latency;
  - open file descriptors against the process limit;
  - the watcher's mode (watch or poll) per folder;
  - store sizes and WAL growth;
  - free disk;
  - module start failures and the errors each module reports;
  - commands that time out (status, probes, git);
  - holds and escalations whose evidence points at the infrastructure: a network error in the log tail, a restart, a
    stale result;
  - unreachable machines;
  - the gate queue's age;
  - retention: how many results and logs each watched folder holds against its configured limit.
- **The Lair ops API, an MCP server.** Lair serves a small set of tools over MCP (stdio and local HTTP), so any
  MCP-capable agent can be the supervisor (Kiro, Claude Code, others):
  - **read tools:** `status.<module>`, `events.query`, `decisions.list`, `runs.get`, `logs.tail` (bounded, redacted),
    `gates.result`, `triage.record`, `placement.status`, `config.get` (redacted), `diagnostics.run`;
  - **one write tool:** `proposals.submit`, which takes structured proposals of the form `{op, target, args, reason,
    evidence}`.

  Tokens are per run and scoped to read plus propose. They expire with the run and are never written to disk.
- **Supervisor runs.** The agents module starts a run of the configured supervisor agent (any adapter) on a trigger:
  - an owner question;
  - a failed self-check or a repeated failure class;
  - the schedule.

  The run's prompt is a template plus a context bundle Lair builds. Runs are debounced, have a minimum interval, a cap
  per day and the agents module's budgets.
- **Proposal ops**, validated in code like the planner's. Each op names the existing module route that carries it out,
  with that route's checks:
  - `release_hold`: needs evidence that the cause was infrastructure;
  - `restart_module`;
  - `archive_old_files`: under the retention policy;
  - `pause_starts` and `resume_starts`: during a provider outage;
  - `requeue_gate`;
  - `set_config`: a Settings change, with a diff and the 428 confirmation;
  - `open_issue`;
  - `create_task`: a repair task for a builder agent.

  The allowlist in `supervisor.act` says which ops may run without the owner. The default is none.

## Safety

The supervisor is an agent, so it is untrusted ([ROADMAP rules](ROADMAP.md#rules-every-new-module-follows) 1–2):
- **Owner only:** it never holds the owner's session. Merge, spend, deletes, secrets, owner-only security settings and
  answering the owner's decisions stay the owner's.
- **Fleet text is data:** everything it reads from the fleet (logs, queue lines, PR text) is data, not instructions. Its
  proposals are validated and bounded, and an op's arguments can only name things that exist.
- **Detectors stay deterministic:** the AI never decides alone that something is broken. It explains and proposes on
  top of code checks.
- **Audit:** every tool call and proposal is in the store, with who, when and what. Acting ops are rate-limited and
  never repeated hot. A fix that didn't work escalates instead.

## Phases

| Phase | Delivers | Acceptance (summary) |
|---|---|---|
| S1 | Self-checks on Home; the ops API (read tools); Ask answered by a supervisor run; hourly review and daily digest | A question about a held agent gets a correct answer that cites its events; a leaking or slow server is flagged with the number |
| S2 | `proposals.submit`; proposals become one decision each; approving applies through the module route | A hold caused by an outage is proposed for release with the log evidence; approving lifts it |
| S3 | `supervisor.act` allowlist; acting ops with rate limits and audit | With `release_hold` allowed, an outage-caused hold is released without the owner, and a hold without that evidence is not |
| S4 | Repair: issues and fix tasks for Lair's own code, through reviews by agents and policy merge | A reproduced Lair defect becomes a reviewed, merged fix with a test, with no owner step but the merge policy's |
