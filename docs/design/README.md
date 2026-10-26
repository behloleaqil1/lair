# Lair Design Notes

> **Design notes: much of this is planned, not built.** These files record the intended design and direction. For
> what ships today see the main [README](../../README.md) and the user docs in [docs/](../). Where a note and the code
> disagree, the code is right.

## Documents

| Document | Description | Status |
|----------|-------------|--------|
| [platform.md](platform.md) | Platform direction: architecture, nodes, scheduler, sandboxes, workflow, verification, policy engine | Planned; parts exist (scheduler, store, policy, gate signing, TypeScript node daemon), all experimental |
| [autonomy.md](autonomy.md) | Autonomous operation: decision inbox, watchdog, playbooks, triage, planner, lifecycle | Planned, not built |
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

## Reading Order

1. Start with `platform.md` for the overall direction
2. Read `phase1-dashboard.md` through `phase5-deploy.md` for the implementation phases
3. Read `autonomy.md` for the autonomous operation model
4. Read `node.md` for the compiled daemon design
5. Read `quality.md` and `launch-kit.md` for quality and launch criteria
