# Lair phase 3: the fleet bus (a direct pipeline between the owner, the orchestrator and the agents)

Today everything flows through shared text files: slow (agents read them only when they wake or reach a checkpoint) and
loose (free-text lines that agents misread). Phase 3 adds a structured, instant, vendor-neutral message bus. Status:
built (`src/bus/`, plus `src/server/routes/bus.ts` for the UI side); see [docs/agents.md](../agents.md) for setup.

## 1. `lair-bus`: a local MCP server
- A stdio MCP server in this repo (`src/bus/`, TypeScript, `@modelcontextprotocol/sdk`), started by each agent's MCP
  config: `npm run --silent bus -- --project <name>` from the Lair checkout (or `node dist/bus/cli.js` after a build). Any MCP-capable agent can use it (Kiro, Claude Code,
  Codex, …). The agent's identity comes from env `LAIR_AGENT_ID` (set by the project's agent launcher).
- Storage: one SQLite file per project in Lair's `data/` (as built: sql.js, an in-process WebAssembly SQLite that
  writes the file back after each change; the original design called for WAL mode with every write in a transaction,
  so several agents and the Lair server could use it at once).
- Tools (all inputs validated with zod; every call recorded):
  - `whoami()` → agent id, display name, current claims.
  - `claim(task)` / `release(task)`: one owner per task, enforced atomically (two agents claiming the same task: exactly
    one wins, the other gets the owner's id).
  - `report(kind, task, summary, gate_id?, pr?, sha?)` with kind WAITING | DONE | BLOCKED | PROGRESS | TICK.
  - `inbox()` → unread messages for this agent; `ack(message_id, note)`.
  - `send(to, text, priority?)`: to an agent id, "orchestrator" or "owner". Agents may send only to the orchestrator
    and the owner; the orchestrator and the owner may send to anyone.
  - `board()` → the latest structured facts (tasks, owners, last report per task) for the orchestrator.
- **Mirror to the text files:** every `report` and `send` is also appended to the project's existing files in their
  current line formats (`queue_file`, `inbox_file`, per-agent mailbox `mail_dir/<id>.md`), so scripts and agents that
  don't use the bus keep working and the text files stay the audit log.
- **Wake-ups:** a message to the orchestrator, a DONE or BLOCKED report and an owner message touch the project's
  `wake_file`, which the project's orchestrator loop watches, so it reacts within seconds.

## 2. Lair UI on the bus
- The Lair server reads the bus (SQLite polling every 2 s or a change feed) and pushes events to the browser over
  Server-Sent Events: a live activity feed, per-dragon message threads, claims.
- The command bar's "Instruct the orchestrator" and "Message a dragon" send through the bus (`send` as owner), with
  delivery state: sent → read (inbox fetched) → acknowledged (ack note shown).
- Reports render as structured cards (gate id and PR links), not raw text.

## 3. Rollout for a project (documented in [docs/agents.md](../agents.md))
- Add the server to the agent's MCP config (Kiro: `mcpServers` in `.kiro/agents/<agent>.json`; Claude Code:
  `.mcp.json`), with `LAIR_AGENT_ID` from the launcher. The project's agent rules say: call `inbox()` at every
  checkpoint, `report()` instead of writing queue lines by hand, `claim()` before starting a task.
- For your project: document the exact config snippets and rule text in your project's docs (gitignored);
  the project owner installs them (agent configs are the owner's to change).

## 4. Quality bar
Unit tests for every tool; a concurrency test (20 parallel claims of one task: exactly one winner); schema tests (bad
input refused with a clear error); a mirror test (bus writes produce exactly the expected text lines); an end-to-end
test with two fake agents and a fake orchestrator over stdio; the SSE feed test. `npm test`, lint and typecheck pass.

## 5. Bus consumers (PR 2a), as built

Per project, `bus.consume: off | observe | on` (default `off`; [configuration.md](../configuration.md#fleet-bus)). The
server wires the bus at startup (`src/server/index.ts`): the consumers (`src/server/bus/consumers.ts`), a bus token per
run (`src/server/bus/wiring.ts`), and the bus routes with their options.

| Mode | What changes |
|------|--------------|
| `off` | Nothing: no run gets a bus token, every bus route answers 404 for the project, fill and the planner read the queue file's lines with their patterns |
| `observe` | Runs get a bus token and `LAIR_URL` and post reports; fill and the planner still read the lines with their patterns, and keep in memory, for Home → Health, what each mirrored line's report says next to what the patterns read. Nothing is written |
| `on` | A mirrored line is read by its report's fields, never by the patterns; reports and run ends wake fill and the planner at once |

### 5.1 One read path, no double counting

- `BusService.report` stores the report, appends the mirrored line (ending `[bus:<id>]`) to the queue file, then emits
  `bus.report`. The line is where the report sits in the queue's order: a run's window, an agent's latest line.
- `QueueLines` (fill's reader, shared with the planner's done check) looks up the reports of the marked lines in the bus
  store (one read, then kept in memory: a report never changes). A line that is the report's mirrored line
  (`- <KIND> <task> by <agent> `) carries the report; in `on` mode it matches a query only by the report's kind, its
  task (exactly the line's task) and, when the pattern names the agent, its agent. A WAITING report's gate id is what the
  run waits on; a DONE report's PR and sha go to the ready guard as they are (nothing is parsed from text). A second
  copy of the line is not read again. A marker that names no report, or a line that isn't the report's, is read as a
  hand-written line and audited.
- The planner's queue events take the report's kind, agent and task (its summary is a BLOCKED report's reason); the
  task is the one the report names, or none.
- The event changes no state: `bus.report` (DONE, WAITING, BLOCKED) and `agent.run.ended` make fill check
  (`checkSoon`) and the planner run a cycle (`cycleSoon`) now; one in progress is followed by one more. So the event and
  the line can't count twice.

### 5.2 Exactly once across restarts

What each module did is kept in its own store, with the change: fill's `fill_done` keeps its key per task, run and
tasks-file line; a hold that stands on a report records `fill_held` once per report, run and hold (its key names the
report), where a hold from a hand-written line is recorded again after a restart, as before; decisions keep their keys.
The planner keeps the ids of the reports it handled (with its cursor). Tests: the report, then the line read again and
again, a copied line, and a new server on the same files: one `fill_done`, one `fill_held`, one decision, one
`planner.blocked`.

### 5.3 Latency

A DONE over the bus counts once its run has ended (as a DONE line does): the run's end (`agent.run.ended`) makes fill
check at once, so the task is done one tick after the agent exits, not at fill's next interval. The acceptance test
reports, exits one second later on the fake clock, and sees the task done with fill's interval at an hour.

### 5.4 Refused and ignored

A `bus.report` or `bus.message` event is checked field by field (no casts); an invalid one, or one that doesn't match
the report the bus stored under its id, is refused with the reason. A report for a task that isn't in fill's tasks
file, or by an agent fill doesn't run, is ignored. Each is logged, emitted as `bus.consume_refused` and listed on Home
→ Health (`GET /api/bus/consumers`, read-only). The bus itself refuses a report for a task the run doesn't hold, a run
that is no longer active, and arguments that fail its schema, with the reason.
