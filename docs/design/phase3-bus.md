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
