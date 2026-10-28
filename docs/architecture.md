# Architecture

Lair is a control room for AI coding agent fleets. It provides visibility into agent status, gate queues, and infrastructure health through a real-time web interface.

## System diagram

```mermaid
graph TB
    subgraph "Lair Server (port 4777)"
        API["REST API<br/>(Fastify)"]
        Static["Built web UI<br/>(dist/client)"]
        WS["WebSocket /ws"]
        NodeWS["Node WebSocket /ws/node"]
        Store["Store<br/>(SQLite, data/lair.db)"]
        Scheduler["Scheduler"]
        Parsers["Parsers"]
        DataService["Data Service"]
        FileWatcher["File Watcher"]
        NodeManager["Node Manager"]
    end

    subgraph "Frontend"
        UI["React UI<br/>(Vite)"]
    end

    subgraph "External"
        ProjectFiles["Project Files<br/>(queue.md, logs, gates)"]
        Agents["AI Agents<br/>(Kiro, others)"]
        Gates["Gate Runners"]
        Bus["lair-bus<br/>(MCP, stdio)"]
        Nodes["lair-node<br/>(experimental)"]
    end

    UI <-->|REST| API
    UI <-->|events| WS
    Static -.->|serves| UI
    API --> DataService
    DataService --> Parsers
    Parsers --> ProjectFiles
    FileWatcher -->|watches| ProjectFiles
    FileWatcher -->|notifies| WS
    Scheduler --> Store
    Scheduler --> NodeManager
    NodeManager <--> NodeWS
    NodeWS <-->|plain WebSocket| Nodes
    Agents -->|MCP tools| Bus
    Bus -->|bus database + text mirrors| ProjectFiles
    Gates --> ProjectFiles
    Agents --> ProjectFiles
```

In production (`npm run build && npm start`) the server also serves the built UI from `dist/client` on port 4777. In development (`npm run dev`) the UI is served by Vite on port 5173, which proxies `/api` to the server.

## Components

### Server (`src/server/`)

The Fastify-based backend that serves the API and manages state.

- **`index.ts`**: server entry point, route registration, lifecycle and graceful shutdown
- **`static.ts`**: serves the built UI (`dist/client`) with an SPA fallback, only when the build exists; a served file is closed when its response closes, also when the client left before the reply
- **`root-guards.ts`**: root request hooks (cross-site and `Host` checks on every route, `?project=` validation on API routes) and the `:id` path-parameter check
- **`origin.ts`**: allowed browser origins and `Host` names, the cross-site request hook, and the lair-node peer check (`LAIR_NODE_TOKEN`)
- **`config.ts`**: project YAML loader and project-name validation (`projects/<name>.yaml`; a file of the same name in `projects/local/` takes precedence)
- **`websocket.ts`**: WebSocket server for real-time UI updates (`/ws`)
- **`ws-upgrade.ts`**: one HTTP upgrade dispatcher that routes WebSocket handshakes to `/ws` or `/ws/node` by path

#### Routes (`routes/`)

- **`controls.ts`**: command bar and control buttons (ask, instruct, tick, pause/resume, agent run/stop/release, gate submit and mark stuck, merge, dragon start/stop, audit log)
- **`bus.ts`**: HTTP view of the fleet bus storage and an SSE event stream (`/api/bus/*`)
- **`processes.ts`**: process manager endpoints
- **`settings.ts`**: the machine test of the settings (owner only); the Settings API is `settings/`
- **`scheduler.ts`**: scheduler, task and node endpoints
- **`fleet.ts`**: fleet management (machines, self-healing, budgets)
- **`project-guard.ts`**: shared `?project=` validation hook (HTTP 400 for an invalid or unknown project)

Each route module registers its routes in an encapsulated plugin with the cross-site check and the project guard.

#### Parsers (`parsers/`)

Pure functions that parse project files into typed structures:

- **`queue.ts`**: queue markdown into typed lines (WAITING, DONE, BLOCKED, PROGRESS, TICK)
- **`dragons.ts`**: agent status from `dragons.txt`, logs and the queue
- **`gates.ts`**: gate queue filenames, gate logs and results
- **`inbox.ts`**: inbox/outbox markdown
- **`dragon-config.ts`**: dragon registry and models from config
- **`adapter-config.ts`**: agent adapter and terminology configuration

#### Services (`services/`)

- **`data.ts`**: main data service, aggregates parsers for each view (read-only); a gate's record and log path, and a dragon's newest log, for the dashboard's details
- **`log-tail.ts`**: the bounded tail of a log the owner reads (lines, bytes, line length, no symlinks, credentials masked)
- **`command.ts`**: runs configured commands as argument arrays (no shell) and appends each action to `data/audit.log`
- **`dragon-registry.ts`**: the dragons a project has (YAML `dragons:` plus `dragons.txt`); start/stop requests are checked against it and the start dialog lists it
- **`adapters.ts`**: built-in agent adapter definitions and command builders (adapters are listed in the UI; dragons are started with `dragon_start_cmd`)
- **`supervisor.ts`**, **`managed-process.ts`**, **`ring-buffer.ts`**: process manager for long-running services and their logs
- **`file-watcher.ts`**: watches a project's folders (agents_dir, the gate queue and results, the queue file's folder) and broadcasts changes over the WebSocket
- **`dir-watch.ts`**: one folder's watch (fs.watch on the folder, never on its files), with polling where the folder can't be watched; the file watcher and the config reloader use it
- **`gate-runner.ts`**, **`gate-distribution.ts`**, **`remote-gate.ts`**: optional gate runner, lane-to-machine distribution and remote gate execution over SSH (library code with tests; not started by the server yet)

#### Core (`core/`)

- **`event-bus.ts`**: internal event bus that decouples the node manager, scheduler, job manager, machine manager and healer

#### Machines (`machines/`)

- **`ssh.ts`**: SSH command builder. The local `ssh` call is an argument array; the remote command is one string for the remote shell, with every value single-quoted and gate env var names validated
- **`health.ts`**: machine reachability checks
- **`mapper.ts`**: lane-to-machine mapping (round-robin)

#### Fleet (`fleet/`)

- **`machine-manager.ts`**: adding, removing and monitoring machines
- **`healer.ts`**: self-healing (failure detection, job rescheduling)
- **`budget.ts`**: provider cost tracking, rate limits and pausing; cost listeners get each cost with its project and agent

#### Agents (`agents/`)

Agent runs with claims, locks, session recovery, failover and budgets ([configuration](configuration.md#agents)). Off unless a project sets `agents.enabled`.

- **`probes.ts`**: the watchdog's probes plus a `ProcessSpawner` (child_process.spawn, detached, no shell) and `ProcessSnapshot`, which judges an owner by pid and start time
- **`locks.ts`**: pid-owned lock files (exclusive create, hand-over, race-safe removal) and legacy pid-only or pid-less locks
- **`store.ts`**: runs, claims (one per task, claimed in an immediate transaction), events and the usage ledger in SQLite (`data/agents.db`)
- **`failover.ts`**, **`budgets.ts`**, **`sessions.ts`**: profiles and failover patterns; per-agent and per-project budgets per UTC day and month; session directories moved aside and resume summaries
- **`decisions.ts`**: the Decision Inbox interface the agents module raises `spend` and `escalation` decisions through, with an inbox-file fallback
- **`service.ts`**, **`routes.ts`**: the per-project tick (launch, supervise, recover, reap) started and stopped by `index.ts`, and `/api/agents/*`
- **`prompts.ts`**: the prompt files in `prompts_dir` for the Work section's start-run form (owner only): basenames, regular files directly in the directory, capped at a run's prompt size

#### AI tools, profiles and roles (`ai/`)

Any tool, any model, per role ([configuration](configuration.md#ai-tools-profiles-and-roles), [design](design/ai-roles.md)). Every key is optional.

- **`profiles.ts`**: `ai.profiles` and `ai.roles` as the other modules read them: a dragon's tool and model (the dragon registry), its fallbacks along its role (`agents/failover.ts`), and the agents of a `role:<role>` reviewer pool (`review/service.ts`). It imports no other module, so the registry can use it
- **`config.ts`**: the `ai:` schema (the Settings section) and `validateAiConfig`, which `config.ts` runs when a project loads: unknown tools and profiles, a dragon's `profile:`, an adapter's model and sign-in commands (argv, no placeholders), and a review role that no dragon runs while reviews by agents are on
- **`parsers.ts`**: model list readers, bounded (`kiro` for `kiro-cli chat --list-models`, `lines` for one model per line)
- **`runner.ts`**: the one boundary: a tool's own commands as argv, no shell, a timeout, bounded output, the agents' environment only
- **`tools.ts`**: per tool and machine (a PATH lookup here, ssh for an SSH machine), installed, version and sign-in state, and the models (cached: an hour, a minute for statuses and failures); the agents module asks it before each start (`ToolReadiness`) without waiting, from sign-in checks that run in the background, so a signed-out tool starts nothing here, with one decision per tool
- **`scrub.ts`**: what of a tool's output may be shown: sign-in details are fixed words and failures their category; other texts lose URLs, ARNs and long digit runs- **`routes.ts`**: `/api/ai/*`, all the owner's (reads included)

#### Decisions (`decisions/`)

The Decision Inbox ([configuration](configuration.md#decision-inbox)): the one place Lair asks the human. Always mounted.

- **`types.ts`**: the `DecisionProducer` interface other modules use: `raise` (deduplicated per project, module and key), `blockedOn` (is this work parked?), `onResolved` (resume with the answer, delivered again after a restart until the handler takes it) and `withdraw`
- **`validate.ts`**: input validation for decisions, answers and withdrawals; the kinds that can't have a default
- **`service.ts`**: `DecisionInbox`: answers (confirmation for spend and go/no-go; a credentials secret is stored only once the answer has won), expiry with defaults or overdue marks, the open-decision caps (per module, and per project for HTTP raises), delivery to producers (reopening a credentials answer whose secret is gone), the sweep timer
- **`secrets.ts`**: the `SecretStore` interface credentials answers go to, and the in-memory stub
- **`request-bridge.ts`**: decision requests in the design note's shape (`DecisionRequest`, string options, the old kind names) as inbox decisions: `InboxDecisionHook`, and the `decision.needed` listener `mountDecisions()` wires, through which gate pipelines raise their minutes-budget decision
- **`store.ts`**: decisions (and whether each was raised over HTTP), the work they block and their audit trail in SQLite (`data/decisions.db`)
- **`routes.ts`**, **`mount.ts`**: the `/api/decisions` routes (answering only with an owner session; no HTTP withdraw), and `mountDecisions()`, which `index.ts` calls to wire the store, routes, sweeps and producers (the watchdog)

#### Owner credential (`human-auth/`)

Who may use the routes only the human may use: answering decisions, and in reviews merging, human reviews, resolving findings and releasing holds ([configuration](configuration.md#decision-inbox)).

- **`human-auth.ts`**: `HumanAuth`: the owner token (`data/owner.token`, mode 0600) and its one-time setup link, browser sessions stored only as HMACs (`data/owner-sessions.db`), `verifyRequest()` (the `X-Lair-Owner-Session` header, the dashboard `Origin`, `Sec-Fetch-Site: same-origin`), and the `requireOwner()` / `requireDashboard()` route hooks, and `requireOwnerForChanges()`, the module-wide hook that makes every write of a route module (controls, bus messages, processes, settings, scheduler, fleet, delivery, pipelines) owner-only and leaves its reads open
- **`routes.ts`**: `/api/owner/*`: sign a browser in, check, list and sign out browsers
- **`cors.ts`**: the CORS options `index.ts` uses: the dev server's origins, but none for owner-only paths

#### Watchdog (`watchdog/`)

The progress watchdog ([configuration](configuration.md#watchdog)). It is off unless a project sets `watchdog.enabled`, and in observe mode unless it sets `mode: act`.

- **`probes.ts`**: the only system boundary: `ProcessTable` (`ps` via execFile), `FileSystem`, `CommandRunner` (execFile, never a shell) and `Clock`
- **`view.ts`**: one snapshot of a project's queue file, agents dir, gates dir and processes, with memoized reads
- **`detectors.ts`**: the nine detectors (stale locks, duplicate agents, hung agents, orphaned claims, infrastructure failure signatures, orphaned gates, idle capacity, progress stalls, crash loops)
- **`playbooks.ts`**, **`playbook-engine.ts`**, **`executors.ts`**: built-in playbooks (diagnose, act, verify), the engine that runs their steps, and the executors that re-check the breach on fresh data and run the project's configured commands
- **`escalation.ts`**: once-per-breach escalations as Decision Inbox items (run the playbook once more, or leave it to the human), with an `OWNER?` entry in the inbox file when no decision can be raised
- **`store.ts`**: breaches, runs, escalations, SLO status and samples in SQLite (`data/watchdog.db`)
- **`service.ts`**, **`routes.ts`**: the per-project tick loop started and stopped by `index.ts`, and read-only `GET /api/watchdog/*` routes

#### Delivery (`delivery/`)

Environments as docker compose projects ([configuration](configuration.md#delivery)). Off unless a project sets `delivery.enabled`.

- **`config.ts`**: the validated `delivery:` block (environments, services, health checks, start order, crash-loop window, deploy settings)
- **`compose.ts`**: argv builders and the parsers for `docker compose ps --format json` and `docker inspect`
- **`probes.ts`**: the system boundary: the watchdog's `CommandRunner` and `Clock`, and `HttpProbe` for HTTP health checks
- **`environment.ts`**: one environment: status reads (`unknown` when docker can't be read), restart-count sampling and crash-loop marks, Up / Down / Restart / Deploy / Release as recorded operations (a Down may run beside another one), rollback, the deploy after a merge, and the recovery of a deploy interrupted by a stop
- **`redact.ts`**: removes credentials from commands, output and log lines before they are stored or shown
- **`store.ts`**: holds, crash loops, restart samples, operations, the last commit seen, the commit each service was deployed at, and the last container names read, in SQLite (`data/delivery.db`)
- **`service.ts`**, **`routes.ts`**: the per-project tick loop started and stopped by `index.ts`, the `ContainerServices` view the watchdog reads (crash loops and holds), and the `/api/delivery/*` routes

#### Reviews and policy merge (`review/`)

Risk tiers, reviews bound to the head sha, the test integrity check and policy merge ([configuration](configuration.md#reviews-and-policy-merge)). Off unless a project sets `review.enabled`.

- **`config.ts`**: the `review:` block (tier rules, reviewers per tier, integrity options, merge settings)
- **`host.ts`**, **`github.ts`**: the git host interface and its GitHub REST provider (PRs, files, commits, checks, contents, compare, the host's merge)
- **`diff.ts`**, **`integrity.ts`**: unified diff hunks, and the test integrity heuristics (self-asserting tests, skips, weakened assertions, removed tests, loosened suites, swallowed errors)
- **`gate-source.ts`**: the required gate at the exact head, from host checks or from signed gate results (verified by `policy/policy-evaluator.ts`)
- **`git.ts`**, **`executor.ts`**: git through execFile, the merge method choice, the host merge, the local fast-forward or squash in a fresh clone, and the email allow-list check on every commit to be published
- **`ports.ts`**: the interfaces other modules implement (Decision Inbox, reviewer assignment), with event-bus defaults
- **`store.ts`**: reviews, findings, authors, holds, merges and reviewer requests in SQLite (`data/review.db`)
- **`service.ts`**, **`routes.ts`**: per-project evaluation, reviews, holds and merges, started by `index.ts`, and the `/api/review/*` routes
- **`testing/`**: stand-ins for the git host API and git used by the tests (not built)

#### Triage (`triage/`)

Failure triage, bisect and revert ([configuration](configuration.md#triage)). It is off unless a project sets `triage.enabled`, and runs no command unless it sets `mode: act`. `index.ts` calls `mountTriage()` with the owner credential and connects the Decision Inbox; the gate pipelines hand it each job's result (`gate.completed`).

- **`parsers/`**: evidence parsers over bounded input. `junit.ts` (JUnit XML, with a small linear XML reader in `xml.ts`), `gradle.ts`, `js.ts` (vitest and jest), `pytest.ts`; `index.ts` turns a gate result and its reports into causes
- **`text.ts`**: bounded lines, signatures, test keys, `Caused by` chains, stack frames, and grouping a context failure into one cause
- **`classifier.ts`**: the rules (infra, flaky, pre-existing, code), each verdict with its evidence
- **`bisect.ts`**: the bisect state machine over the merges since the last green commit
- **`adapters.ts`**: the interfaces triage needs from other modules (re-check executor, agent router, task sink, decision raiser, revert opener, capacity, the owner guard), the Decision Inbox adapter, and the built-in command, inbox-file and capacity adapters
- **`git.ts`**: read-only git (first-parent merges, a commit's parents and message, changed files, merge base, ancestry)
- **`store.ts`**: results, causes, test observations, actions, re-checks, tasks, flaky tests, incidents and protected merges in SQLite (`data/triage.db`)
- **`service.ts`**: per-project ingest, trust and decisions, each in one store transaction; commands and decisions run from an outbox kept in the store (so they survive a restart), outside the project's queue
- **`manager.ts`**, **`routes.ts`**, **`index.ts`**: the projects' lifecycle and trusted node keys, the `/api/triage/*` routes (signed results; `/api/triage/owner/*` for the owner), and `mountTriage()`
- **`testing/harness.ts`**: the fakes the tests use (command runner, clock, git), a signing node, and result builders

#### Placement (`placement/`)

Which machine runs each queued job of a project's own gate queue ([configuration](configuration.md#placement)). Off unless a project sets `placement.enabled`, and advice only unless it sets `mode: act`.

- **`config.ts`**: the validated `placement:` block (machines, lanes, pseudo-lanes, classes, eligibility, the mover), globs and `/regex/` patterns, and the `move_cmd` argv builder
- **`probes.ts`**: the system boundary: the watchdog's `CommandRunner` (argv, timeouts) and `Clock`, and bounded `QueueFiles` reads
- **`queue.ts`**, **`history.ts`**: the configured lanes' requests with their command and class; results (`.rc` time, the seconds a log prints) and the runner log's finished runs
- **`estimate.ts`**: per-lane simulation (order, slots, class limits, pseudo-lanes) and the greedy move decisions, quiet re-checks included
- **`store.ts`**: moves, the runs Lair saw start, and learned durations in SQLite (`data/placement.db`)
- **`service.ts`**, **`routes.ts`**: the per-project tick (probes, learning, estimates, act or observe, recovery of a move cut short) started and stopped by `index.ts`, and the read-only `GET /api/placement/status`

#### Settings (`settings/`)

Every project setting from the dashboard, written to the project's YAML ([design](design/settings-ui.md)):

- **`registry.ts`**: one entry per module (its block and the zod schema its parser uses) and the core settings' sections (`core-schemas.ts`, descriptive schemas for the keys no module parses); `json-schema.ts` converts them to JSON Schema for the forms
- **`service.ts`**: read, check (`parseProjectConfig` and the modules' parsers through `ConfigReloader.validate`, secrets, commands to confirm), save with the hash check, history, restore, create and the repository check (`git` as argv)
- **`yaml-doc.ts`**: form changes applied with the yaml Document API, so comments, key order and unknown keys stay
- **`files.ts`**, **`history.ts`**: no symlinks, atomic writes, `data/config-history/<project>/`
- **`checks.ts`**: parser messages as errors per field, the command changes and their digest; the rules for commands and secrets are in `src/shared/settings-rules.ts`
- **`routes.ts`**: `/api/settings/*`, all behind `requireOwner()`

#### Dashboard reads (`dashboard/`)

What the dashboard's sections need that the modules' own routes don't expose. Every route only reads; `/api/dashboard` is in `OWNER_ONLY_PREFIXES`.

- **`modules.ts`**: `GET /api/dashboard/modules`: which modules a project's YAML turns on, for the nav
- **`gate-detail.ts`**: a gate's detail from the project's gate queue (the request, its result, the steps and durations its log names: `parsers/gates.ts` `parseGateSteps`), a Lair pipeline run, triage's record and placement's job (`GET /api/dashboard/gates/:id`, open, no log line or test output); and its output: the failing tests with their messages (triage's, else read from the log's console output with triage's parsers) and the log tail
- **`routes.ts`**: the routes. The log and test output (`GET /api/dashboard/gates/:id/output`, `GET /api/dashboard/agents/:id/log`) are the owner's (`requireOwner()`, before anything is read) and bounded (`services/log-tail.ts`: at most 1,000 lines of the last 128 KB, each cut to 2,000 characters, credentials masked, no symlink followed); an agent's log is its latest run's (only inside `agents_dir`) or its newest log there. A project's `readOnly` is `read_only === true`, as every module reads it. A failed read, or a config that can't be read, answers a fixed text: the error, which can name paths, goes to the server log

**Removed routes (a breaking change for external callers).** `GET /api/dragons/:id/log` and `GET /api/gates/:id/log` were open to any local process and returned whole logs. They are gone; their owner-only, bounded replacements are `GET /api/dashboard/agents/:id/log` and `GET /api/dashboard/gates/:id/output` (the gate's log tail with its failing tests). Still open, and tracked separately: `GET /api/triage/failures/:id` returns triage's causes with their messages and evidence lines to any caller.

#### Store (`store/`)

- **`store.ts`**: SQLite store (better-sqlite3) for nodes, tasks, jobs, events and agent runs, at `data/lair.db`
- **`migrations.ts`**: versioned SQL migrations for the store

#### Scheduler and jobs

- **`scheduler/scheduler.ts`**: matches ready tasks to available node capacity
- **`jobs/job-manager.ts`**: task creation, job lifecycle and result processing

#### Nodes (`nodes/`)

- **`node-manager.ts`**: WebSocket handler for lair-node connections (`/ws/node`)

#### Gates and policy (`gates/`, `policy/`)

Gate pipelines from the project config and their executors ([configuration](configuration.md#gate-pipelines), [design](design/runners.md)), started and stopped by `index.ts`:

- **`gates/project-pipelines.ts`**: the `pipelines:` and `executors:` blocks, validated; each lane becomes a gate pipeline
- **`gates/pipeline-service.ts`**: runs, one job per lane; the selector (executor order, availability, the minutes budget, the `spend` decision); attempts, fallback, and resuming in-flight jobs after a restart
- **`gates/executors/`**: `github.ts` and `github-api.ts` (GitHub Actions over the REST API: dispatch, find, poll, cancel, logs, artifacts, minutes), `github-workflow.ts` (the workflow file Lair generates and its log markers), `local.ts` (argv spawner, capacity probe, worktrees), `types.ts` (the Executor interface and the boundaries tests fake)
- **`gates/run-store.ts`**: runs, jobs, attempts, unavailable executors and raised decisions in SQLite (`data/pipelines.db`)
- **`gates/decision-hook.ts`**: the interface the Decision Inbox implements; the default emits `decision.needed`
- **`gates/routes.ts`**: `/api/pipelines/*`; a job's log tail and its steps' output only for the owner's session, other callers get the runs without them

Library modules with tests, not exposed through the API yet:

- **`gates/pipeline-config.ts`**, **`gates/gate-executor.ts`**: gate pipeline configuration and step execution (also used by every pipeline executor, so results have one shape)
- **`gates/signature.ts`**: signing and verification of gate results (not end-to-end yet; see [Status and limitations](../README.md#status-and-limitations))
- **`policy/policy-config.ts`**, **`policy/policy-evaluator.ts`**, **`policy/merge-controller.ts`**: merge policy configuration, evaluation and a control-plane merge controller
- **`policy/risk-rules.ts`**, **`policy/reviewer-slots.ts`**, **`policy/merge-policy.ts`**: risk tiers from rules over paths, file kinds, size and labels; required reviewers per tier; and the merge conditions the review module enforces

### Client (`src/client/`)

React-based frontend built with Vite. No UI framework: its own component kit (`ui/`) on design tokens (`ui/tokens.css`), with light, dark and system themes and two densities ([settings-v2.md](design/settings-v2.md), "Look and feel").

- **`main.tsx`**: entry point
- **`App.tsx`**: the shell: a left nav (the project switcher at the top; the sections; Lair's status, the owner's state, the theme and the density at the bottom; folded behind a Menu button on a narrow screen), the command bar, and the section the URL names; old view ids in the URL are replaced by their section (`router.ts`)
- **`router.ts`**: hash routes, one per section with an optional tab and open detail: `#/work/<agent>`, `#/gates/<id>?tab=triage`, `#/prs/<n>`, `#/decisions/<id>`, `#/machines/<name>`; `&project=<name>` when the server has several projects. `LEGACY_VIEWS` maps the old views (Dragons, Agents, Reviews, Nodes, Health, Activity, Triage, Owner messages, Orchestrator) to where each went; `#owner-token=` (the setup link) is not a route and is left alone
- **`nav.ts`**: the sections and their tabs, and which the nav shows: a section or tab whose module is off for the project (`GET /api/dashboard/modules`) is hidden, and opened by its URL it says what to set to turn it on
- **`time.ts`**: "5 min ago", with the absolute time on hover (`<Time>`); durations
- **`table.ts`**: the sort and keyboard rules of the kit's `Table`
- **`crumbs.ts`**: a detail's breadcrumbs (its section and tab, from the URL)
- **`App.css`**: the shell's and the views' own classes, on the tokens

#### The component kit (`ui/`)

- **`tokens.css`**, **`tokens.ts`**: colour (a neutral base, one accent, success, warning, danger and info), a 4 px spacing scale, type (the system UI and monospace stacks: no font is downloaded), radius, elevation, motion and layers; the light and dark themes and the compact density. `tokens.test.ts` computes the AA contrast of each theme's text, status and border pairs from the values
- **`preferences.ts`**: the theme (system, light, dark) and density, kept in `localStorage` when the browser allows it, set as `data-theme` and `data-density` on `<html>` (`index.html` sets them before the first paint)
- **`base.css`**, **`kit.css`**: the page and the components; reduced motion turns every transition off
- `Button` and `ButtonLink`, `Field` (label, help, error) with `Input` and `TextArea`, `Select`, `Combobox`, `Switch`, `Table` (sortable, sticky header), `Badge` and `StatusBadge` (an icon and a word with every status colour), `Drawer` and `Dialog` (modal: focus in, Tab kept inside, Esc closes, focus back; `focus.ts`), `Tabs` and `TabLinks`, `Toast`, `Tooltip`, `EmptyState`, `CodeBlock`, `Skeleton`, `PageHeader` and `Breadcrumbs`, `Card` and `Callout`, `Icon`
- **`a11y.test.tsx`** (in `src/client/`): renders the app in jsdom with the fixture answers of `a11y-fixtures.ts` and runs axe on every view and detail, and on the supervisor's chat panel, signed in and out; serious and critical violations fail CI

| Section | What it shows | Detail (a row's click, Enter or Space) |
|---|---|---|
| Home | Needs you (open decisions, holds, failed gates, PRs ready to merge, config problems, agents in trouble: `home-view.ts`), one tile per section, problems, merges, recent activity; tabs Activity and Health (watchdog) | each item links to its row's detail |
| Work | every agent once (the project's dragons and the agents module's agents merged: `work-view.ts`); tabs Tasks (fill's tasks file), Planner (`planner.enabled`: `Planner.tsx`, owner only) and Locks and budget | `#/work/<agent>`: task and description, current run (state, model, started, recoveries, claims), what it waits on and since when, holds with Release, its tasks file lines, budget, recent runs, recoveries, reports, the log tail |
| Gates | the gate queue (any lane), results of 24 hours; tabs Pipelines, Triage, Placement | `#/gates/<id>`: track, sha, branch, lane, machine, each step's result and duration, triage's verdict per cause and actions, placement's advice, a pipeline run's jobs and where they ran; the failing tests and the log tail (`gate-detail-view.ts`) |
| PRs | open pull requests with their readiness (the review module's evaluation at the head, or only the gate without it: `pr-view.ts`, `pr-readiness.ts`) | `#/prs/<n>`: tier and the rules that set it, required reviews and who holds each slot, reviews, findings, the gate at the head, holds, merge conditions and Merge, the owner's review |
| Machines | the project's machines with their runners and placement's probes (`machines-view.ts`); tab Nodes | `#/machines/<name>`: probe, lanes, the jobs on them; a node's capacity |
| Decisions | the Decision Inbox; tab Owner messages | `#/decisions/<id>`: the full context, then the answer (or the outcome and history) |
| Delivery, Processes, Settings | as before; Processes only when the project defines processes | |

Logs and test output are the owner's: a detail asks for them only once this browser is signed in as the owner (`useOwnerSignedIn`), with the owner session in the header, and until then says where to sign in (`OwnerOnlyNotice`). Owner-only actions are disabled the same way, and the server refuses them anyway.

#### Components (`components/`)

- **`Section.tsx`**: the props every section gets, and its header (the kit's `PageHeader`: title, actions and tab links)
- **`DataTable.tsx`**: the kit's `Table` under its older name: sortable headers, rows that open their detail, arrow keys between rows
- **`DetailPanel.tsx`**: a detail, in the kit's `Drawer` with breadcrumbs back to its section: it takes the focus and gives it back, Esc closes it, Tab stays inside
- **`ui.tsx`**: `Time`, the loading, error and empty states (each says what to do), `ModuleOff`, `KeyValues`, `Tabs`, `OwnerOnlyNotice`, `useOwnerSignedIn`
- **`Home.tsx`**, **`LiveFeed.tsx`**, **`Activity.tsx`**, **`Health.tsx`**: Home, its recent activity (the bus's reports, linked to their agent, gate and PR), the Activity tab (bus reports and the control audit log) and the Health tab (watchdog SLOs, breaches, playbook runs)
- **`Work.tsx`**, **`AgentDetail.tsx`**, **`StartRunForm.tsx`**, **`Budget.tsx`**, **`Planner.tsx`** (its tab: sources, open tasks, the planner agent, proposals to approve or reject, runs and history; requests in `planner-api.ts`), **`DragonStartDialog.tsx`**, **`DragonStopDialog.tsx`**: Work, an agent's detail (`AgentDetailView` renders what `AgentDetail` reads), the owner's "Start a run" (`agents-actions.ts`), budget lines, and the start and stop commands of a project's own launcher (`dragon-view.ts`, `dragon-start.ts`)
- **`GatesSection.tsx`**, **`GateDetail.tsx`**, **`PipelineRuns.tsx`**, **`Triage.tsx`**, **`Placement.tsx`**: Gates, a gate's detail, the Pipelines tab (executors, minutes, runs, the workflow file; a run's jobs in `PipelineJobs`), the Triage tab (incident, bisect, revert and protect, failures, tasks, flaky tests; what triage did about one failure in `TriageRecordDetail`) and the Placement tab (mode and moves); view logic in `gates-view.ts` and `placement-view.ts`
- **`PullRequests.tsx`**, **`PrDetail.tsx`**: PRs and a PR's detail (requests in `review-api.ts`, view logic in `review-view.ts`)
- **`MachinesSection.tsx`**: Machines and Nodes with their details
- **`DecisionsSection.tsx`**, **`DecisionInbox.tsx`**, **`OwnerSessions.tsx`**, **`Inbox.tsx`**: Decisions (the inbox as a table, a decision's detail with the confirmation step for spend and go/no-go and the password field for credentials, signing in as the owner, the signed-in browsers) and the Owner messages tab (`inbox_file`). Requests and answer rules in `decisions-api.ts`; the owner session (sent as a header; kept in this origin's `localStorage`, or only in the page's memory under the Vite dev server) in `owner-session.ts`
- **`Delivery.tsx`**: environments and services (state, health, restarts, holds, crash loops, error lines) with Up, Down, Restart, Deploy and Release, and the operations log. Its requests are built in `delivery-api.ts`
- **`Processes.tsx`**: managed processes and their logs
- **`SignInHint.tsx`**: the "sign in from Decisions" notice above forms with owner-only actions. Writes go through `owner-actions.ts` (and `delivery-api.ts`), which add the owner session
- **`CommandBar.tsx`**: ask / instruct / task command bar
- **`Settings.tsx`**: the Settings view (owner only): a project's Form, YAML and History tabs and New project. `SettingsForm.tsx` draws each section from its JSON Schema (fields and widgets from `settings-form.ts`), `SettingsReview.tsx` shows a save's diff, errors and commands to confirm, `SettingsHistory.tsx` the versions and Restore, `ProjectWizard.tsx` the new project; requests in `settings-api.ts`

#### Hooks (`hooks/`)

- **`useApi.ts`**: data fetching on the 10-second refresh; keeps its data across refreshes, starts empty for another endpoint or project, sends the owner session for owner-only reads (`owner`), and fetches nothing when told to (`skip`: a module that is off, a reader not signed in)
- **`useWebSocket.ts`**: WebSocket subscription management. The connection is a `LiveSocket` (`live-socket.ts`): when the server goes away (a restart) it reconnects with backoff (`reconnect.ts`: 1 s, doubling, at most 30 s), subscribes again once open, and reports `reconnecting` meanwhile; unmounting closes it for good
- **`useBusEvents.ts`**: SSE subscription to fleet bus events
- **`event-stream.ts`**: the live feed's SSE connection (`LiveFeed.tsx`). Any connection error closes the browser's `EventSource`, whose own retry stops for good after an HTTP error during a restart, and opens a new one with the same backoff; the feed says "Reconnecting…" meanwhile

### Shared (`src/shared/`)

Types shared between server, client, bus and node:

- **`types.ts`**: project config and view types
- **`decision-types.ts`**: Decision Inbox decisions, kinds (and which can't default or need confirming), answers and audit entries
- **`bus-types.ts`**: fleet bus events
- **`server-types.ts`**: nodes, jobs, tasks, scheduler, events, and the node wire protocol
- **`node-types.ts`**: lair-node local configuration and capacity types
- **`fleet-types.ts`**: machines, healing, budgets
- **`policy-types.ts`**: gates, policies, verification
- **`review-types.ts`**: reviews, findings, risk tiers and merge conditions as the review API returns them
- **`process-types.ts`**: process manager
- **`version.ts`**: the Lair version string

`src/types/sql.js.d.ts` and `src/bus/sql-types.d.ts` hold type declarations for sql.js.

### Fleet Bus (`src/bus/`)

MCP server (stdio) for direct agent-to-Lair communication. Run it with `npm run bus -- --project <name>`.

- **`cli.ts`**: CLI entry point (`lair-bus`)
- **`project-config.ts`**: finds and reads `projects/[local/]<name>.yaml` or `.yml` (same lookup order as the server)
- **`server.ts`**: MCP server and its tools (whoami, claim, release, report, inbox, ack, send, board)
- **`storage.ts`**: SQLite storage via sql.js (`data/<project>.db`)
- **`mirror.ts`**: mirrors reports and messages into the project's text files
- **`types.ts`**: bus types and input schemas
- **`index.ts`**: module exports

### Node daemon (`src/node/`, `src/cli/`), experimental

- **`cli/node.ts`**: `lair-node` CLI (`join`, `start`, `stop`, `status`, `keygen`, `gate-result submit`)
- **`cli/gate-result.ts`**: `keygen` (a node's Ed25519 key pair) and `gate-result submit`: an existing gate system's result, signed and sent to triage (not experimental)
- **`node/index.ts`**: the daemon: connects to `/ws/node`, registers, sends heartbeats, runs jobs
- **`node/registration.ts`**: node identity and config in `~/.lair/node/`
- **`node/capacity.ts`**: CPU, memory, disk and container runtime detection
- **`node/job-runner.ts`**: runs jobs as a process or in a container

## Data flow

### Polling (default)

```
UI → API request → DataService → Parsers → Project files
                                    ↓
                              Typed data
                                    ↓
UI ← API response ← JSON response ←
```

The UI polls every 10 seconds by default.

### WebSocket (real-time)

```
Project files change
        ↓
FileWatcher detects
        ↓
WebSocket broadcast
        ↓
UI receives update
```

The UI subscribes to channels (`dragons`, `gates`, `machines`, `orchestrator`, `logs:dragon-id`) and receives instant updates.

Lair watches folders, not files: each watched folder (agents_dir, the gate queue and results folders, the queue file's folder, `projects/` and `projects/local/`) gets one `fs.watch` of the folder itself (inotify on Linux, FSEvents on macOS, so no descriptor per file), and only the names the dashboard uses among the folder's direct entries are looked at, with one `lstat` each, after a 100 ms debounce. Subfolders (archives, prompts, older logs) are not watched, and no file is opened to be watched, so the cost stays one watch per folder however many files the folders hold. A folder that is missing or can't be watched is polled every 5 s instead (one listing, and an `lstat` of the new names and of the 200 most recently changed files) until it can be watched.

### Command execution

```
UI → Control action
        ↓
CommandService checks read_only and the configured command
        ↓
Executes as argument array (no shell)
        ↓
Appends an entry to data/audit.log
        ↓
UI ← Result
```

## Security model

1. **Localhost only**: the server binds to `127.0.0.1:4777` by default
2. **No authentication**: anyone who can reach the port can use the API, so never bind it to a network or wildcard address on an untrusted network
3. **Browser checks**: cross-site requests (foreign `Origin`) and foreign `Host` headers get HTTP 403, on HTTP routes and WebSocket handshakes (`origin.ts`); `LAIR_HOST` extends the allowed names, and a wildcard bind turns the `Host` check off but adds no allowed origin (remote browsers get read-only GETs; their POSTs and WebSockets are refused)
4. **Input validation**: invalid or unknown `?project=` names, unsafe gate or dragon IDs, and dragon start/stop requests for a dragon that is neither in the YAML `dragons:` map nor in `dragons.txt` get HTTP 400
5. **Node peers**: `/ws/node` accepts loopback peers, and remote ones only with `LAIR_NODE_TOKEN`
6. **Read-only default**: controls are disabled until `read_only: false`
7. **Argument arrays, not a shell**: controls, dragon start/stop, the process manager and local gate scripts run as argument arrays, preventing injection. Two exceptions, both for commands from your own config: the legacy `ssh_cmd` machine setting runs through the local shell (`services/data.ts`), and commands sent over SSH, such as remote gates, are one string for the remote shell with every value single-quoted (`machines/ssh.ts` `buildGateCommand`)
8. **No credential storage**: SSH keys are paths, never contents
9. **Audit logging**: control actions are logged to `data/audit.log`

See [SECURITY.md](../SECURITY.md) for details.

## lair-node (experimental)

The lair-node daemon runs on a machine in the fleet and connects to the server:

```
Control plane (lair-server)
        ↕ WebSocket /ws/node
lair-node (machine 1)      lair-node (machine 2)
    ↓                           ↓
Agent sessions             Gate jobs
```

What works today: the node registers, reports capacity (CPU, memory, disk, container runtime), sends heartbeats and receives job assignments. Not done yet: node keys and job signatures are placeholders, the job command is a placeholder, and the connection is not encrypted. Remote nodes must present `LAIR_NODE_TOKEN`; nodes on the server's own machine need no token.

See [docs/design/node.md](design/node.md) for the design.
