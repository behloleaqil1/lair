# Lair Design Notes

> **Design notes: much of this is planned, not built.** These files record the intended design and direction. For
> what ships today see the main [README](../../README.md) and the user docs in [docs/](../). Where a note and the code
> disagree, the code is right.

## Documents

| Document | Description | Status |
|----------|-------------|--------|
| [ROADMAP.md](ROADMAP.md) | What is built, what comes next and in which order, and the rules every new module follows | Current |
| [platform.md](platform.md) | Platform direction: architecture, nodes, scheduler, sandboxes, workflow, verification, policy engine | Planned; parts exist (scheduler, store, policy, gate signing, TypeScript node daemon), all experimental |
| [autonomy.md](autonomy.md) | Autonomous operation: decision inbox, watchdog, playbooks, triage, planner, lifecycle | Partly built: the Decision Inbox (§1, `src/server/decisions/`) and the watchdog's detectors and playbooks (§2, `src/server/watchdog/`); the rest is planned |
| [planner.md](planner.md) | The planner: Lair keeps fill's tasks file from plans, backlogs, owner messages and queue lines, with a supervised planner agent whose proposals it checks | Built: `src/server/planner/` (the first step of autonomy.md §4) |
| [runners.md](runners.md) | Where gates run: CI runners (GitHub Actions) first, Lair machines next, the local machine last; minutes budget and fallback | Partly built: pipeline config, GitHub Actions and local executors, the selector, the minutes budget, API and UI; lair-node executors are not built |
| [settings-ui.md](settings-ui.md) | Settings: every project setting from the dashboard, written to the YAML; guided setup actions; auto-detection | Partly built: phase 1 (forms for every module, YAML tab, checks, command confirmation, history and restore, New project); phases 2 and 3 are planned |
| [node.md](node.md) | The lair-node daemon: compiled Go binary, protocol, job execution | Planned; only the experimental TypeScript daemon in `src/node/` exists |
| [quality.md](quality.md) | Quality control: test integrity, contracts, migrations, security, performance | Planned, not built |
| [launch-kit.md](launch-kit.md) | Launch readiness: billing, analytics, compliance, legal, experiments | Planned, not built |
| [phase1-dashboard.md](phase1-dashboard.md) | Phase 1: Read-only dashboard | Built |
| [phase2-controls.md](phase2-controls.md) | Phase 2: Command bar and controls | Partly built: the command bar and config-driven control commands ship; the write-request token is not built (there is no authentication) |
| [phase3-bus.md](phase3-bus.md) | Phase 3: Fleet bus (MCP server) | Built: `src/bus/` is a stdio MCP server (`whoami`, `claim`, `release`, `report`, `inbox`, `ack`, `send`, `board`) with per-project SQLite storage (sql.js) and text-file mirroring; `src/server/routes/bus.ts` serves the board, an SSE live feed and owner messages |
| [phase4-fleet.md](phase4-fleet.md) | Phase 4: SSH machines, distributed gates, agent management | Partly built: SSH machines, gate distribution, agent adapters (only `kiro` is tested), budgets and self-healing; the manager chat view is not built |
| [phase5-deploy.md](phase5-deploy.md) | Phase 5: Deployment, GitHub integration, kickstart | Planned, not built |

## Principles

1. **Nothing manual after install.** Recurring operations are automatic.
2. **Guarantees come from architecture, not instructions.** Isolation and policy-as-code ensure safety.
3. **Agnostic at every layer.** Any AI agent, any OS, any git host, any deploy target.
4. **Evidence over claims.** Status comes from observed events, not agent reports.
5. **Scales down and up.** One laptop or 1,000 nodes.
6. **Deterministic core, AI at the edges.** Scheduling is code; agents do creative work.

. `ROADMAP.md` for what exists and what comes next
1. Start with `platform.md` for the overall direction
2. Read `phase1-dashboard.md` through `phase5-deploy.md` for the implementation phases
3. Read `autonomy.md` for the autonomous operation model
4. Read `node.md` for the compiled daemon design, and `runners.md` for where gates run
5. Read `quality.md` and `launch-kit.md` for quality and launch criteria
- [supervisor.md](supervisor.md): the supervisor, Lair's operator: self-checks, answers, diagnoses and fixes within the autonomy the owner gives it
- [ai-roles.md](ai-roles.md): any AI tool and model, per role; how Lair checks sign-in and keeps API keys
- [settings-v2.md](settings-v2.md): Settings organised by task, and the look and feel of the whole dashboard
- [app-architecture.md](app-architecture.md): the architecture stage for the apps Lair builds: quality attributes, trade-offs, ADRs, the stack, reference architectures and fitness functions
- [importer.md](importer.md): taking over an existing project: discovery and audit, a proposed setup, shadow mode, a staged reversible cutover
