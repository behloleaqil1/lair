# Lair autonomy: no human in the loop except decisions only a human can make

Goal: Lair manages the whole fleet on its own, and any input a human must give goes through Lair's UI. This builds on
[platform.md](platform.md) (architecture, milestones) and [node.md](node.md) (the host daemon). Where they differ, this
file wins for the behaviour it describes. Status: planned, not built, except §2's detectors and playbook engine
(`src/server/watchdog/`, see [configuration](../configuration.md#watchdog)), §3's triage, bisect and revert
(`src/server/triage/`, see [configuration](../configuration.md#triage)), §6's agent runs with claims, locks, session
recovery, failover and budgets (`src/server/agents/`, see [configuration](../configuration.md#agents)), and §7's
`local` environment as a docker compose project (`src/server/delivery/`, see
[configuration](../configuration.md#delivery)); the watchdog's escalations go to the project's inbox file until the
Decision Inbox (§1) exists. §5's risk tiers, reviews, test integrity check and policy merge are built
(`src/server/review/`, see [configuration](../configuration.md#reviews-and-policy-merge)); its reviewer requests go out
as events until the agents (§6) and Decision Inbox (§1) modules take them, and its weekly audit is not built yet. Keep
everything generic (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).

## 0. Principles
1. **Deterministic core, AI at the edges.** Detection, routing, scheduling, merging and rollback are rules and code.
   Agents write code, reviews, plans and diagnoses, and every agent output is checked by code before it's acted on.
2. **Every stall has an owner that isn't the human.** Every detector has a playbook. A playbook that fails escalates to
   another playbook. Only when the last one fails does Lair ask the human, and then through the Decision Inbox (§1),
   never a terminal.
3. **Evidence or it didn't happen.** Every automatic action records its trigger, its evidence (log lines, test causes,
   metrics), what it did and the outcome, in the store, visible in the Activity view.
4. **Reversible by default.** Every automatic action has an undo (revert PR, rollback, re-enable), and the system
   does it on a failed health check.
5. **Modules, not a monolith.** Each section below is one server module under `src/server/<module>/`, plus a UI view
   under `src/client/`. Modules talk ONLY through the event bus (`src/server/core/event-bus.ts`) and the store
   (`src/server/store/`). A module registers its routes, events, detectors and playbooks through one registry call, so
   parallel work rarely touches shared files. New event names are appended to the `EventType` union (today in
   `src/shared/server-types.ts`).

## 1. Decision Inbox: the only place a human is needed (module `decisions`)
- **Status:** built in `src/server/decisions/` (see [configuration](../configuration.md#decision-inbox)): the store,
  the API and the `DecisionProducer` interface, blocking and resume, expiry with defaults, credentials through a
  `SecretStore`, and the Decisions view with its badge. The watchdog's escalations (§2) are decisions now. Not built
  yet: the MCP tool, notifications, importers and the weekly digest.
- **Any module or agent can raise a decision:** API `POST /api/decisions`, the `DecisionProducer` interface inside the
  server, and (planned) the MCP fleet tool `decision.request`. A decision carries:
  - `{kind, title, context (markdown: what is blocked and why), options[] (each with its consequences), recommended
    {optionId, reasoning}, source {module, ref}, key, blocks[], links[], expiresAt, defaultOptionId}`, plus
    `secretName` for credentials;
  - `kind` is one of: `pricing`, `legal`, `spend`, `account`, `credentials`, `go_no_go`, `security`, `escalation`,
    `other`.
- **Blocking and resume:** one open decision per project, module and `key`. The producer parks the work listed in
  `blocks` (`blockedOn(ref)`) and resumes when the answer is delivered to its `onResolved` handler. An answer it
  couldn't take is delivered again on the next sweep, and after a restart. A producer withdraws a decision that became
  moot (the watchdog does when its breach clears).
- **UI:** an always-visible count badge on the Decisions view, which lists open decisions by expiry, then age. Each
  decision shows its context and gets one-click options, an optional note (none for `credentials`), or a secure
  field. `spend` and `go_no_go` answers are confirmed first. A `credentials` decision, e.g. "connect the git host", writes the value to the secret
  store and never to the store, the audit trail, a log or a response. Answers become events (`decision.answered`),
  and the requester resumes.
- **Timeouts (per kind):** a decision may carry `expiresAt` and a `defaultOptionId`. At expiry the default is applied
  (status `expired`, in the audit trail); without one, the decision keeps waiting and is marked overdue.
  - Only `escalation` and `other` may carry a default, set by the module that raises it. A Settings switch for
    defaults is not built.
  - `pricing`, `legal`, `spend`, `account`, `credentials`, `go_no_go` and `security` refuse a default: they ALWAYS
    wait.
- **Who answers (built, `src/server/human-auth/`, shared with other owner-only routes):** only the human. A browser
  signs in once with the owner token (`data/owner.token`, mode 0600; setup link printed to the server's output at
  first start) and gets a random session, which the server stores only as an HMAC keyed by the token. The dashboard
  keeps it in its own origin's `localStorage` and sends it in `X-Lair-Owner-Session`; there is no cookie, because
  cookies ignore the port and would reach any local listener. Answers also need the dashboard `Origin` and
  `Sec-Fetch-Site: same-origin`, and these routes grant no CORS. Other local processes, other local apps and forged
  headers get 403 before the body is read. The answerer is always recorded as the owner, with the request's address
  and user agent. The Decisions view lists signed-in browsers and signs them out; a new token signs every one out.
  Links in decisions are refused for loopback and private hosts and shown as text, never clickable. A process
  running as the same OS user can still read the token and the server's output; running agents as a separate OS user
  (§6) closes that. HTTP callers have no identity yet, so only producers inside the server withdraw, and HTTP raises
  share one open-decision cap per project.
- **Follow-up: human presence.** Answers to `spend`, `credentials`, `legal`, `go_no_go` and `security` decisions also
  need a WebAuthn assertion (a platform authenticator such as Touch ID, or a security key; WebAuthn works on
  `localhost`), registered once in Settings. Then even a process that holds the token can't answer those kinds.
- **Notifications:** browser push, plus optional plugins (email, Slack, Telegram, webhooks). They fire only for a new
  decision, a deadline within 2 h, and a failed last playbook. Quiet hours are a setting.
- **Importers:** an app adapter can turn its existing human channels into decisions. Examples: lines tagged
  `OWNER?` in a queue file, or an inbox/outbox file pair. The answer is written back the way the app expects, so
  existing agents keep working during migration.
- **Weekly digest:** one page of everything decided automatically, anything still waiting, and anything recommended
  for the human to review.

## 2. Progress watchdog and playbook engine (module `watchdog`)
- **SLOs per project, defaults computed from its own history, all editable:**
  - a merge to the default branch at least every 6 h while tasks are ready;
  - a passing gate at least every 3 h while gates run;
  - every running agent shows progress (a commit, gate, review or WAITING heartbeat) every 45 min;
  - no queue lane stays busy for more than 3× its median job time;
  - every idle machine with free capacity is used within 10 min while work is queued;
  - the default branch is green.
- **Detectors** read events and metrics and emit `slo.breached {slo, evidence}`. The **playbook engine** runs the
  playbooks registered for it in order. Each playbook step is code: diagnose, act, verify, record. On failure it goes
  to the next playbook, and after the last one it raises a Decision Inbox `escalation`. Built-in playbooks:
  - **agent-stuck:** using lair-node's HUNG vs WAITING, kill and restart a HUNG agent from a fresh session with an
    auto-written resume summary (§6). Never restart a WAITING one.
  - **lane-jammed:** a job past its limit that has made no progress is marked stuck, its work is requeued on another
    node, and the lane is freed.
  - **idle-capacity:** queued jobs are moved to idle nodes. Wake sleeping runtimes (e.g. WSL, a stopped container
    engine) through the node.
  - **ready-but-idle:** ready tasks with no running agent are handed to the scheduler to start agents up to the
    measured capacity.
  - **no-merges:** runs failure triage (§3) on every open PR's latest gate and reports the top blocker.
  - **disk-low / memory-low:** GC old gate worktrees, scratch files, build outputs and dangling container images by
    an age and size policy, then drain the node if it's still low.
  - **runtime-down:** restart the container engine or the node's services, then drain and reschedule.
- **UI:** a Health view lists SLOs (green, amber, red), open breaches, and playbook runs with their evidence and
  outcome.

## 3. Failure triage, bisect and revert (module `triage`)
Built ([configuration](../configuration.md#triage)):
- parsers for JUnit XML, Gradle, vitest, jest and pytest, which read only bounded input;
- the rules below as four classes: `code` (`own`), `pre-existing` (`base-red`), `flaky` (`flake`) and `infra` (`infra`
  and `load`);
- one re-check of only the failed tests at the same commit, on spare capacity (where this file says "on a different
  node"). It counts as passed only when its answer lists the requested tests as passed;
- the flaky rule of [quality.md](quality.md) §15 with these defaults: flaky 2 times in a row (`ticket_after: 2`) opens a
  reliability task due in 7 days and quarantines the test. Quarantined, it still runs but no longer blocks a change, and
  it still counts on the default branch. The quarantine ends at the deadline, after 5 passes in a row, or when the owner
  releases it;
- the bisect per pipeline, with revert by policy. A suspect that is not proven is reverted only on the owner's explicit
  decision.

Trust:
- results come in-process from the gate pipelines (`gate.completed`), or signed by a node in `triage.trusted_nodes`;
- the base commit is the result's own (in-process) or `git merge-base`;
- protect, revert and quarantine releases need the owner's session (`src/server/human-auth/`);
- triage's questions go to the Decision Inbox, whose answers it follows.

The re-check executor, the agent mailbox, the task sink and the revert PR are interfaces (`src/server/triage/adapters.ts`)
with command adapters until their modules exist.

Informational until the policy consumes it: nothing reads a failure's `blocking` yet. §5's merge policy will.

Not built: TAP and SARIF parsers, the agent for leftover causes, and the nightly run.
- **Structured causes:** every check result carries `causes[]`, parsed from machine-readable output (JUnit XML
  `Caused by` and field errors, pytest, TAP, SARIF, exit codes) by pluggable parsers. It's never only a log tail. A
  context or bootstrap failure is identified as ONE cause, even when it fails hundreds of tests.
- **Classifier (rules first, an agent only for the leftovers):**
  - `own`: the cause is in files the PR changed, or new since the base;
  - `base-red`: the same cause on the default branch's latest result;
  - `flake`: it passed on a re-run of the same commit, or a known flake signature;
  - `infra`: a container, network, disk or OOM error;
  - `load`: a timeout while the node was overloaded.
- **Routing:**
  - `own` goes back to the PR's agent with the causes in its mailbox.
  - `base-red` links to the open base-red incident; that PR is not the agent's problem.
  - `flake` / `infra` / `load`: one automatic re-run on a different node. A signature that repeats 3 times becomes a
    test-reliability task.
- **Default branch red:** the triage module opens an incident, finds the last green commit and bisects the merges in
  between, on spare capacity, running only the failing tests.
  - A merge that is proven to cause the failure (green before, red after, same cause twice) gets a revert PR, which
    goes through the normal gate and policy merge (§5).
  - The culprit's agent gets the cause, so its PR comes back fixed. Nothing else merges while the branch is red,
    except the revert or a fix (a policy rule).
- **Nightly:** a full suite runs on the default branch every night, and a red nightly opens the same incident.

## 4. Planner: work comes from documents, not prompts (module `planner`)
- **Status:** the first step is built in `src/server/planner/` ([planner.md](planner.md), see
  [configuration](../configuration.md#planner)): Lair keeps fill's tasks file from plans, backlogs, owner messages and
  queue lines; rules mark tasks done, and a planner agent, started on triggers through the agents module, proposes
  changes that code checks before they apply or go to the owner. Task cards, the graph and docs PRs are not built.
- **Inputs (per app pack):** the project plan, design docs with PR plans, specs, issues, and Decision Inbox
  answers. An agent extracts **task cards**; code validates them against the card schema and the dependency graph.
- **A task card holds** `{id, title, source (doc + section), acceptance criteria (tests first), size budget (lines,
  files), depends_on[], conflicts_with[] (same files, migration number ranges), risk tier (§5), branch}`.
- **Graph rules:**
  - a card is READY when its dependencies have merged;
  - stacked branches are rebased automatically when their parent merges;
  - number ranges (e.g. DB migrations) are allocated by the planner, never guessed by agents.
- When a PR merges, the planner marks its card done, makes the next card in that design's PR plan READY, and ticks
  the source document's checklist through a docs PR.
- **UI:** a Plan view with cards by state (blocked, ready, running, in review, merged), the graph, and each card's
  source link.

## 4a. Requests: features and bug reports from the human (module `intake`)
The human also needs a way to request new features and report issues in the managed application.
- **Where to send them:**
  1. **Lair UI:** a "New request" button on every project, plus the command bar (`/bug …`, `/feature …`). Each request
     has a title, a description, screenshots or files, where it happened (page/URL, environment), and severity for
     bugs.
  2. **From inside the managed app:** an optional feedback widget (a tiny script the app pack enables only in local and
     staging builds). It sends the page URL, recent console errors, failed network calls and a screenshot. This is how
     a human testing the app reports bugs without leaving it.
  3. **Importers:** issues from the git host, an email address, or an existing notes document the app pack names.
     Every import links back to its source.
- **Flow (automatic):**
  - An intake agent restates the request in one paragraph and flags duplicates (linked, not dropped).
  - **Bug:** a reproduce card is created FIRST (a failing test or a scripted repro), then the fix card. Severity sets
    priority: `blocker` pre-empts the queue, `high` goes next, the rest follow plan order.
  - **Feature:** if it's small and unambiguous, it becomes cards. If it needs product choices, a design agent writes a
    short design with recommended answers, and those go to the Decision Inbox; one click approves the recommended set.
    Only then does the planner (§4) create cards.
- **Status the human sees:** received, understood (the restatement), planned (cards), in progress, merged, then
  deployed to local/staging with a link. Then **Verify**: the human clicks "fixed" or "reopen" with a note. A reopen
  carries the note and the original request into a new card.
- **Acceptance:** a bug filed from the widget arrives with URL, console errors and screenshot; its first card is a
  failing test; it shows "deployed" with a link after the fix merges; "reopen" creates a linked card.

## 4b. The whole development lifecycle, documents first (module `lifecycle`)
Lair also writes the specs that detail an application's development and manages the whole development cycle. The
planner (§4) turns documents into work; this module WRITES and maintains those documents.
- **Stages per project, each with exit criteria Lair checks:**
  1. Kickstart: from a one-paragraph description (new app) or a repository (existing app).
  2. Audit (existing code): findings with stable IDs, severity and evidence (file:line).
  3. Project plan: phases, tasks, merge gates, user journeys, and a finding-to-phase traceability table.
  4. Architecture: the master doc with diagrams, a "design changes" table, and ADRs.
  5. Feature designs: problem, options, recommended answers, data model, migrations, API, UI, test plan, rollout and
     a PR plan.
  6. Build (§4 planner cards).
  7. Verify: end-to-end tests per journey, then human acceptance testing.
  8. Fix list: issues found during acceptance testing, each fixed or decided before launch.
  9. Launch-readiness checklist.
  10. Release (§9 for Lair, §7 for apps).
  11. Operate: health, incidents, §8.
  12. Feedback (§4a), which loops back to stage 5.
- **Document templates** (pluggable per app pack) fix each type's required sections: audit, project plan,
  architecture, ADR, feature design, runbook, launch checklist.
- **Authoring loop:**
  1. An author agent drafts the document.
  2. Two reviewer agents (one of a different model or vendor) critique it against the template's checklist:
     completeness, consistency with the architecture and ADRs, traceability, testability.
  3. The author revises.
  4. Each open question becomes a Decision Inbox item with a recommended answer. "Approve all recommended" is one
     click.
  5. The document is versioned, and the planner extracts cards from that version.
- **Keeping documents true:**
  - A merge that changes a boundary (schema, API, config names, services, dependencies) triggers a docs PR that
    updates the architecture's affected section and diagram and adds a "design changes" row.
  - A drift check compares documents with code: documented routes, tables, env vars and ports must exist, and
    anything existing must be documented.
  - A traceability report flags findings with no task, journeys with no E2E test, and cards with no source section.
- **Re-planning:** new requests, decisions or incidents re-sequence the plan automatically. Only a change to a
  milestone's scope or date goes to the Decision Inbox, shown as a plan diff.
- **Storage:** documents live in the project's own repository (markdown + diagram sources, optional Word/PDF exports
  through a plugin). Nothing goes to an external document service unless the app pack configures it.
- **Acceptance:** on the demo repository Lair produces an audit, a project plan, an architecture doc and two
  feature designs that pass their reviewer checklists. Every planner card traces to a section. A schema-changing
  merge produces an architecture docs PR. A documented-but-missing route fails the drift check.

## 5. Reviews and policy merge (module `review`, extends `policy`)
- **Risk tiers, set by policy-as-code over paths and labels:** `red` (money, auth, tenancy, security, data loss,
  migrations), `amber` (business logic), `green` (docs, tests, tooling).
  - red: two independent reviewer agents, at least one of them a different model or vendor from the author, plus a
    security checklist;
  - amber: one reviewer of a different model or vendor;
  - green: the author's self-check plus the gate.
- **Reviewer agents** get the diff, the task card and the causes from the latest gate. They answer in a fixed schema
  (findings with file:line, severity, and blocking or not). A blocking finding returns the PR to its author; the
  review module never edits code itself.
- **Policy merge** (`policy/merge-controller.ts`): merge only when the gate is green and signed at the exact head
  commit, every required step is present, the reviews meet the tier, there's no base-red incident (§3), and the
  conflict checks pass. Only the control plane merges. A post-merge health failure (nightly, deploy) leads to an
  automatic revert through §3.
- **Weekly audit:** a reviewer agent re-reads every red-tier merge of the week and files findings as tasks. A
  disagreement between reviewers becomes a Decision Inbox item only when policy says the human must decide.
- **Built:** reviews by agents (`review.prompt_file`): named and peer slots go to free reviewer agents from a pool
  (never the author; with `different_model`, never the author's model in any profile), started through the agents
  module with the assignment token only in the run's environment; runs that end without a review are retried with
  backoff, then the owner is asked; reviewers post with `lair review submit`.

## 6. Agents: budgets, failover and session recovery (module `agents`)
- **Adapters** (Kiro, Claude Code, Aider, Codex and others, as plugins) report usage: tokens, credits, requests and
  rate-limit responses.
- **Budgets:** one monthly budget per provider, entered once in Settings as a `spend` decision. When a provider nears
  its limit or rate-limits, new runs go to the next configured adapter with the same task card. The human hears
  about it only if every adapter is exhausted.
- **Session recovery:** an agent run that produces no output on start, crashes, or loses its session is restarted in
  a FRESH session. It gets an auto-generated resume summary: the task card, the branch state, the last gate causes and
  its last messages. Broken sessions are never resumed in a loop: at most 2 attempts, then a fresh one.
- **Agents report through fleet tools** (`task.status`, `task.waiting`, `task.done`, `task.blocked`), not by
  appending to files. An app adapter mirrors them into the app's legacy files during migration.
- **Agents run as a separate OS user** from the Lair server, without access to Lair's `data/` or the server's output.
  Otherwise an agent can read the owner token (`data/owner.token`, §1) or the setup link, sign itself in, and answer
  the decisions that gate its own work.
- **Built so far** (`src/server/agents/`): Lair starts the runs itself. A task's claim is owned by a pid plus that
  process's start time, and every lock the launch takes is pid-owned; dead owners are released and broken, a waiter
  always names the lock's holder, and a run with no live process in N minutes is never-started and retried with
  backoff. Hung agents (the watchdog's rule) and dead-on-start or crashed ones restart with the same session K times,
  then in a fresh one (the old session moved aside), then escalate. Rate limits and provider errors fail over to the
  agent's next profile, a bounded number of times per task; budgets are per agent and per project, per day and month,
  fed by the fleet budget. Agents get a built environment (never the server's secrets). Fill (`agents.fill`) starts
  runs from a task list for an allowlist of agents, within `max_active` and a capacity command, through the same
  in-process request, so a project needs no launcher loop; a task done since its last start (kept once seen) or left
  to the owner is never started again, and one whose runs keep exiting 0 without the done line backs off, then waits
  on one decision.
- **A restart never leaves two runs of one task** (built): a run's pid, process group, process start time and a
  fingerprint of its start command are stored when it starts. The new server's first tick reconciles every run the
  store says is running before it judges anything, and fill starts nothing until then: a process provably the run's
  (pid and start time match) is adopted with its claim, a different command line only noted; one under a reused pid
  (another start time) is never signalled and the run is lost, its task free; a gone process is classified by its
  queue line. Lost and gone need two readings to agree, the second fresh (never the shared cache's); when it fails
  the run keeps its state and claim until the next tick. Start times count from when a reading was taken (and how
  long `ps` took), and the shared cache never keeps a `ps` table its timeout cut short or one without the server's
  own pid. `agents.on_restart: stop` stops the runs on the server's own shutdown instead (SIGTERM to the group,
  SIGKILL after a bounded wait judged by exit status or fresh readings, each recorded). Fill also refuses to start a
  task while a live process no run owns holds one of the task's run prompt files on its command line, with one
  `fill_conflict` notice.
- **Budgets are advisory until adapters report usage:** today usage is read from run logs by pattern, text the agent
  itself writes, so it can under-report. Budgets become enforcement once providers or adapters report usage to the
  fleet budget directly; until then keep a spending limit at the provider too.

## 7. Delivery (module `delivery`, [platform.md](platform.md) milestone M4 brought forward for environment 1)
- **Environments per app pack:** `local` (the developer's own running stack), `staging`, `production`. Each has a
  deploy job template, a health check and a rollback job.
- **`local`:** after every merge, the node redeploys the developer's local stack, health-checks it and rolls back on
  failure, so nobody has to update the local stack by hand after a merge.
- **staging/production:** promote on green with a strategy (all at once, canary, blue-green) and roll back
  automatically on a failed health check. The first production deploy and any credential needed are Decision Inbox
  items (`go_no_go`, `credentials`).

## 8. Knowledge and learning loop (module `knowledge`)
- **Every incident** (a playbook escalation, a base-red, a revert, a fake or partial gate) gets an auto-written
  record: trigger, evidence, cause, fix, and the rule that would have prevented it.
- **Proposed rules** go to the agent instruction pack only after a check proves them. Either a playbook or policy test
  reproduces the incident and passes with the rule, or a reviewer agent approves a prose rule. Rules carry their
  incident id and are pruned when unused for 90 days.
- **Status documents:** the app's status file, plan ticks and changelog are generated from events via docs PRs, never
  hand-maintained.
- **Brain bench (built):** `lair brain-bench` replays recorded decisions against a model or a rule set and reports
  accuracy, abstain rate, wrong-but-confident rate and latency per decision kind
  ([Brain bench](../configuration.md#brain-bench)). A candidate model must keep wrong-but-confident near zero before
  it may run in shadow mode, which reuses the same scoring.
- **Daily digest** (§1 notifications, and a Digest view): merges, the throughput trend, SLO state, open decisions, the
  top blocker, and the next 24 h of planned work.

## 9. Open-source release pipeline (module `release`, for Lair itself)
- A scrubber fails the build on any private data: paths, hostnames, emails other than noreply, project names from
  `projects/local/`, and secrets (a pattern scan and an entropy check).
- The `public` branch is built from `main` by the pipeline: scrub, tests, license headers, SBOM, reproducible
  lair-node binaries, signed checksums. Publishing is a `go_no_go` decision; the human clicks Publish in the UI.

## 10. Migration of an existing project (module `importer`)
- Read an existing setup and run it under Lair with no downtime: its agent registry, task list, queue/inbox files,
  gate scripts and OS services.
- Order:
  1. mirror read-only;
  2. Lair takes over detection and playbooks;
  3. scheduler and planner take over starting agents;
  4. policy merge takes over merging;
  5. the legacy scripts are retired one at a time, each with a rollback.
- An adapter keeps the legacy files in sync until the last step.

## 11. Acceptance tests (each module ships its own; these are the end-to-end ones)
- **Hands-off day:** a demo project with 20 cards and fake agents runs for a simulated 24 h with injected faults:
  - a hung agent, a jammed lane, an idle node, a red default branch caused by a merge, a flaky test, a provider rate
    limit, a disk filling up, and a broken session.
  - Every fault is fixed by a playbook with zero human actions, and the only Decision Inbox items are the two the
    script raises on purpose (`spend`, `go_no_go`).
- A bootstrap failure appears as one cause, not hundreds of test failures.
- A merge proven to break the default branch is reverted automatically, and a merge not proven to break it is not.
- A fake gate (a command that isn't the declared check, missing steps, an unsigned result) never merges.
- A `spend` decision never auto-resolves, even with timeouts enabled.
- A WAITING agent is never restarted; a HUNG one is restarted from a fresh session with its resume summary.
- The scrubber blocks a commit containing a private path in the public build.

## 12. Build order (parallel, one module per agent, each on its own branch)
- **Wave 1:** decisions (§1), watchdog and playbooks (§2), triage (§3), planner (§4) with intake (§4a), review and policy (§5), agents
  (§6).
- **Wave 2:** lifecycle (§4b), delivery (§7), knowledge and digest (§8), release (§9), importer (§10), then the hands-off-day test
  (§11).
