# Supervisor: Lair's operator

> Status: design. Phases S1–S4 below; nothing is built yet. Roadmap: [ROADMAP.md](ROADMAP.md). The supervisor runs on whatever AI tool and model `ai.roles.supervise` names ([ai-roles.md](ai-roles.md)).

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
