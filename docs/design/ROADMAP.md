# Lair Roadmap

> What is built, what is next, and in which order. The design notes in this folder say *how* each part works; this
> file says *when* and *what must be true first*. Where this file and the code disagree, the code is right.

Lair's goal is to run the whole development lifecycle with coding agents. A developer describes an application, or
points Lair at a repository, and answers only the questions that are theirs (pricing, legal, spend, accounts,
credentials, go/no-go) in the Decision Inbox. Lair is open source and works with any agent CLI, any gate system and
any machines.

## Built

| Module | Spec | Code | What it does |
|---|---|---|---|
| Watchdog and playbooks | [autonomy.md §2](autonomy.md) | `src/server/watchdog/` | Detects stalls and known failure classes, and runs playbooks (observe or act); escalations become decisions |
| Agents and fill | [autonomy.md §6](autonomy.md) | `src/server/agents/` | Supervised agent runs: claims, locks, recovery, failover, budgets. Fill starts runs from a tasks file: waits on a gate's result, holds blocked work, bounds runs without progress, matches queue lines by agent, judges a run whose exit a restart lost by its queue line |
| Planner | [planner.md](planner.md) | `src/server/planner/` | Keeps fill's tasks file: deterministic done-marking, plus a supervised planner agent whose only output is a validated proposal file (observe or act) |
| Triage and re-checks | [autonomy.md §3](autonomy.md) | `src/server/triage/` | Signed gate results (from Lair's pipelines or a project's own gate system) are classified by root cause; infrastructure and timeout failures are re-checked in the project's gate system |
| Placement | configuration.md "Placement" | `src/server/placement/` | Decides which machine runs each queued job of an external gate queue, from learned durations, load and slots, and moves jobs when that finishes them sooner |
| Reviews by agents and policy merge | [autonomy.md §5](autonomy.md) | `src/server/review/` | Risk tiers, reviewer slots filled by agents with single-use tokens, approvals bound to the head, test integrity check, merge executor |
| Delivery | [autonomy.md §7](autonomy.md), [platform.md §10](platform.md) | `src/server/delivery/` | Docker Compose environments: status, Up/Down/Restart, holds, crash loops, deploy after a merge with rollback |
| Gate pipelines and runners | [runners.md](runners.md) | `src/server/gates/` | Pipelines as config: GitHub Actions first, the local machine last; a minutes budget |
| Decision Inbox and owner credential | [autonomy.md §1](autonomy.md) | `src/server/decisions/`, `src/server/human-auth/` | The one place a human decides; owner-only actions need a signed-in browser session |
| Live reload, Restart and Update | configuration.md "Live config reload" | `src/server/reload/`, `src/server/restart/` | Config changes apply without a restart; the owner restarts or updates Lair from the dashboard |
| Settings | [settings-ui.md](settings-ui.md) | `src/server/settings/` | Every project setting from the dashboard: validated, history and restore, command and sensitive fields confirmed |
| Dashboard | [architecture.md](../architecture.md) | `src/client/`, `src/server/dashboard/` | Eight sections, a detail view with a URL for every row, owner-only logs |
| Needs you and notifications | configuration.md "Needs you", "Notifications" | `src/server/notifications/`, `src/server/decisions/` | One decision per owner hold; action items vs notices; Home "Needs you"; desktop and phone notifications |
| No false holds | configuration.md "Fill", "Agents" | `src/server/agents/` | A wait on a gate still queued is not "too long"; transient provider errors are waited out, with a retry cap and failover first |
| AI roles, part 1 (A6-1) | [ai-roles.md](ai-roles.md) | `src/server/ai/` | Profiles (tool + model) and roles per job; dragons, failover, reviewer pools and the planner agent on them; model lists and sign-in checks per machine; a signed-out tool starts nothing |
| Supervisor, part 1 (S1-1) | [supervisor.md](supervisor.md) | `src/server/supervisor/`, `src/cli/ops-mcp.ts` | Deterministic self-checks of Lair and each project on Home → Health and `GET /api/health/diagnostics`; a check that keeps failing is one notice; the read-only ops API for an AI supervisor (MCP over stdio), on scoped in-memory tokens, every call audited |
| Supervisor, part 2 (S1-2) | [supervisor.md](supervisor.md) | `src/server/supervisor/chat.ts`, `src/cli/ops-call.ts`, `src/cli/supervisor-answer.ts` | Ask Lair: a question from the dashboard is one supervisor run (on `ai.roles.supervise`) that reads Lair through the ops API and answers once with cited evidence, shown sanitised in a chat panel; bounded runs, "no answer" with the reason; the daily digest on Home. Off by default |
| Look and feel (T1) | [settings-v2.md](settings-v2.md) | `src/client/ui/` | Design tokens with light, dark and system themes and two densities (AA contrast checked from the values), a component kit, the app shell (left nav, breadcrumbs and page headers) and every view on them; axe runs on every view in CI |
| Settings v2, part 1 (S2-1) | [settings-v2.md](settings-v2.md) | `src/client/components/Settings*.tsx` | Settings by task: Overview (a setup checklist), AI (tools signed in per machine, profiles with each tool's own models, roles as ordered lists) and Team (agents, bulk moves), the classic form for the rest; a search over every field; one save bar through the phase-1 review |

## Next, in order

Lair now runs its first project's development day to day, so Lair itself is the focus.

**What Lair is for:** Lair builds **enterprise-grade applications from ground zero**:
- **at scale and in the shortest time**, with many agents working in parallel;
- **to a high standard of quality**, with very few bugs: gates, reviews by risk tier, triage and a quality pipeline
  on every change;
- **highly configurable**, with any AI tool and model and every policy a setting;
- **automating the whole of development organically**, from version control, planning and code through tests,
  reviews and merges to deployments and product analytics.

**One place for every level.** Lair runs the whole of building an application, each level with its own stage, its
gates and the human decisions that are the owner's:

| Level | What Lair does | Design |
|---|---|---|
| Design | users, journeys, screens, a design system as code, accessibility and visual checks on every change | [app-design.md](app-design.md) |
| Architecture | requirements to quality attributes, options with prices, ADRs, infrastructure as code, fitness functions | [app-architecture.md](app-architecture.md) |
| Development | parallel agents by AI role, the planner, fill, gates, reviews by risk tier, merges | [ai-roles.md](ai-roles.md), [planner.md](planner.md), [runners.md](runners.md) |
| QA | test integrity, contracts, migrations, security, performance, exploratory testing, triage | [quality.md](quality.md), [autonomy.md](autonomy.md) |
| Deployment | preview, staging and production environments, releases, rollbacks | [phase5-deploy.md](phase5-deploy.md) |
| Cloud and cost | connected accounts, machines that exist only while needed, hard money limits | [cloud-accounts.md](cloud-accounts.md), [cloud-runners.md](cloud-runners.md) |
| Operations and analytics | health, incidents, product analytics, launch readiness | [launch-kit.md](launch-kit.md), [supervisor.md](supervisor.md) |

The engineer, of any level, describes the application (or points Lair at a repository), picks the AI tools and models
they have, and answers only the decisions that are theirs. Every step below is judged against that. The order:

1. **A: unattended operation and the experience of using Lair**: the supervisor, AI roles, the new look and Settings.
2. **C1-C5: from an idea, or an existing repository, to a running app**: documents become work, documents first, a new
   project from scratch, and taking over an existing project.
3. **B: what other engineers need to adopt it**: install, onboarding, adapters, security, docs, releases.
4. **The rest of C**: nodes, deploy targets, learning loop, quality, launch kit, teams.

Each step lists what must exist first. One module per pull request, each with its own acceptance tests.

### A. Unattended operation (now)

| # | Step | Spec | Needs first | Acceptance (summary) |
|---|---|---|---|---|
| A2 | **Reliability**: dashboard probes off the request path (async, cached); retention for results and logs in watched folders | [#38](https://github.com/behloleaqil1/lair/issues/38) | — | No synchronous command on a request; a 30-minute provider outage escalates nothing; a watched folder past its retention limit is archived |
| A3 | **Supervisor S1–S2**: self-checks, the ops API, answers, the daily digest, proposals as decisions (S1-1, the self-checks and the read-only ops API, and S1-2, the supervisor's runs, answers and digest, are built; S1-3, the hourly review and diagnoses, is next) | [supervisor.md](supervisor.md) | A2 | See supervisor.md |
| A6 | **AI roles**: any tool, any model, per role (build, review per tier, plan, supervise); sign-in status per machine; a write-only key store for API-key tools; reviewer calibration | [ai-roles.md](ai-roles.md) | — | See ai-roles.md |
| A7 | **Look and feel, then Settings v2**: design tokens, light/dark, a component kit for every view (T1, built); Settings by task, with plain language, levels, search, templates and test buttons (S2-1 built; S2-2 and S2-3 to do) | [settings-v2.md](settings-v2.md) | T1 first; S2-1 needs A6 | See settings-v2.md |
| A4 | **Supervisor S3**: an allowlist of acting fixes | [supervisor.md](supervisor.md) | A3 | See supervisor.md |
| A5 | **Hands-off day** (end-to-end acceptance) | [autonomy.md §11](autonomy.md) | A2–A4 | A project runs a full day with no human input except Decision Inbox answers |

### B. A proper open-source project

| # | Step | Needs first | Acceptance (summary) |
|---|---|---|---|
| B1 | **Install and upgrade**: `npx lair init`, a container image, `lair service install` (launchd/systemd), upgrade from the dashboard for git and package installs, store backups and restore | — | A clean macOS or Linux machine runs Lair as a service in under ten minutes; an upgrade keeps every store |
| B2 | **Onboarding**: Settings phase 2 (guided setup: node keys, machine and adapter tests, review-tier preview) and phase 3 (detect the repository, CI and gate system, and propose settings); a demo project and tutorial | B1 | A first project with one agent and one gate runs end to end from the wizard alone |
| B3 | **Adapters and gate systems**: an adapter SDK with conformance tests (Kiro, Claude Code, Aider, Cursor, Codex-style CLIs); documented external gate integration | — | A new adapter passes the conformance suite without core changes |
| B4 | **Security hardening**: agents as a separate OS user (sandbox profiles); secrets never on paths agents can read; owner-token rotation; an exported audit log; a threat-model document | [sandbox.md](sandbox.md) | An agent cannot read the owner token, Lair's data or another agent's run environment |
| B5 | **Docs site**: concepts, quickstart, a guide per module, a config reference generated from the schemas, an API reference, troubleshooting | B1 | Every config key and route is documented from code |
| B6 | **Quality of Lair itself**: CI on macOS and Linux; end-to-end tests (Lair with fake agents and a fake gate system for a full cycle); scale tests (5,000-file folders, 50 agents); parser fuzzing | — | The end-to-end suite runs on every PR |
| B7 | **Release** (for Lair itself): semver, a changelog, signed releases, an SBOM, release notes, a deprecation policy | B1, B6 | A tagged release builds, signs and publishes by itself |
| B8 | **Supervisor S4**: repair of Lair's own defects through reviews by agents | A4, B6 | See supervisor.md |

### C. The whole lifecycle

| # | Module | Spec | Needs first | Acceptance (summary) |
|---|---|---|---|---|
| C1 | **Planner: documents become work** | [autonomy.md §4](autonomy.md) | planner (built) | Cards extracted from a versioned document, each tracing to its section; dependencies and merge order |
| C2 | **Intake**: feature requests and bug reports | [autonomy.md §4a](autonomy.md) | C1 | Requests from the UI, an in-app widget and importers become triaged cards or decisions; duplicates merged |
| C3 | **Lifecycle**: documents first | [autonomy.md §4b](autonomy.md), [app-architecture.md](app-architecture.md) | C1, reviews | Audit, plan and designs written by an author agent and critiqued by two reviewer agents; the **architecture stage**: quality attributes, options and trade-offs, ADRs, the stack, a reference architecture and fitness functions, for any style (modular monolith, microservices on Kubernetes, event-driven, serverless, AI-native) |
| C4 | **Kickstart and projects** | [phase5-deploy.md §3](phase5-deploy.md), [platform.md §10](platform.md) | C3, B2 | "New project": create or connect a repository, choose or detect the stack, first plan |
| C5 | **Importer**: take over an existing project | [importer.md](importer.md), [autonomy.md §10](autonomy.md) | C3 (architecture recovery uses the architecture stage) | An existing repository adopted with no downtime: connect read-only, discover and audit (stack, build and test commands, CI, deploys, team rules, health, recovered architecture, risk map), a proposed setup, shadow mode beside the existing CI, then a staged, reversible cutover |
| C6 | **lair-node**: run work on other machines | [node.md](node.md) | runners | Capacity reporting and remote runs without SSH scripts; unplugging a node loses nothing |
| C7 | **Kubernetes and PaaS deploy targets** | [platform.md §10](platform.md) | delivery | Rollouts with checks and rollback; strategies; promotion behind policy |
| C8 | **Knowledge and learning loop** | [autonomy.md §8](autonomy.md) | triage, reviews, A3 | Lessons from incidents and reviews turned into checks, playbooks and brief rules |
| C9 | **Quality** | [quality.md](quality.md) | reviews, triage | Contracts, migration safety, spec conformance, exploratory and UX testing, performance and cost budgets, AI evaluations, a security pipeline |
| C10 | **Launch kit** (for the apps Lair builds) | [launch-kit.md](launch-kit.md) | C9, delivery | Billing, analytics, the customer-facing surface, a feedback loop, launch readiness |
| C11 | **Teams and scale** | [platform.md M6](platform.md) | the rest | Postgres, roles and permissions, SSO, high availability, quotas |

## Rules every new module follows

The reviews of the first modules found the same classes of defect again and again. A new module meets these before
review:

1. **Every state-changing route names its caller.** The caller is one of three things:
   - the owner, through `src/server/human-auth/` (`requireOwner()`, with the route prefix added to
     `OWNER_ONLY_PREFIXES`);
   - an in-process producer interface;
   - a signed result (`gates/signature.ts`).

   A name in the request body, or the absence of an Origin header, proves nothing: any local process, including the
   agents Lair supervises, can send it.
2. **Agents are the untrusted party.** Never pass the server's environment, tokens or secrets to agent processes, and
   never trust text an agent writes (logs, usage lines, trailers, labels) as evidence of anything it gains from.
3. **Commands are argv arrays, never shell strings.** No value from a request, a file, a log or git becomes an option
   (refuse a leading `-`).
4. **Tests go through production code.** Fake only the process spawner, the clock and remote APIs. A test that would
   still pass with the feature removed is a defect, and so is wiring that exists only in tests.
5. **Bounded input.** Truncate lines before regular expressions, cap sizes, use iterative parsers, and give every
   command a timeout.
6. **Restarts are part of the design.** State that matters is in the store with a schema version and a migration.
   Operations interrupted by a restart are resumed or rolled back, never left half done.
7. **No private details and no AI attribution** in code, tests, docs or commits ([CONTRIBUTING.md](../../CONTRIBUTING.md)).
8. **CI is the test runner.** Typecheck, lint, tests and build on Node 22 and 24 must be green before review.

## UI consolidation (built)

The dashboard had grown one view per module (16 nav items, several of them twice: the state a previous launcher keeps
next to Lair's). It now has a section per job the owner does, each shown only when its module is on for the project, and
every list row opens a detail view with a URL (`src/client/router.ts`, [architecture](../architecture.md#client-srcclient)).
Logs and test output are the owner's (`/api/dashboard/*`, `src/server/dashboard/`).

| Before | Now |
|---|---|
| **Overview**, **Health**, **Activity** | **Home**: what needs you, the fleet at a glance, problems, recent activity; Activity and Health (watchdog) are its tabs |
| **Dragons** (the roster; Start and Stop through the project's own start command) and **Agents** (runs Lair supervises) | **Work**: one row per agent (the Planner is its tab when on), Lair's state when it supervises the agent, else the launcher's; the agent's detail has its task, run, claims, holds, fill's wait, recent runs and the log; the launcher's Start and Stop stay for agents Lair doesn't run |
| **Gates** (an external gate queue), **Pipelines**, **Triage**, **Placement** | **Gates**: the queue and results, with Pipelines, Triage and Placement as tabs; one gate detail for a queue gate and a pipeline run |
| **PRs** (mergeable and gate) and **Reviews** (tier, reviewers, findings, merge policy) | **PRs**: one list, "merge ready" from the review policy when it is on; a PR's detail has the tier, slots, findings, gate and merge |
| **Machines** (SSH machines) and **Nodes** (lair-node) | **Machines**, with Nodes as a tab |
| **Inbox** (the owner's message file) and **Decisions** | **Decisions**, with Owner messages as a tab |
| **Orchestrator** (an external orchestration loop) | Removed from the dashboard (`#/orchestrator` opens Home's activity; a pause still shows in the footer); `GET /api/orchestrator` keeps its tick lines, STOP file and launchd state for scripts |
| **Processes** | **Processes**, only when the project defines processes |
| — | **Settings** ([#36](settings-ui.md)) |

The old view ids redirect to their section (`#/dragons` → `#/work`, `#/reviews/42` → `#/prs/42`, ...). Still apart while a
project's gates run outside Lair: the gate queue and Lair's pipelines (two sources in one Gates section).
