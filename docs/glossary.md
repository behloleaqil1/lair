# Glossary

The words Lair uses, in plain terms. Each links to where it is configured or explained.

| Word | Meaning |
|------|---------|
| **Agent** (or **dragon**) | One AI coding agent run by a CLI (for example Kiro, Claude Code, Cursor or Aider) that works on tasks in your repository. "Dragon" is Lair's name for an agent it knows by ID; it can be any letter-first name ([Configuration](configuration.md#dragons-agents)). |
| **Task** | One unit of work for an agent: a task ID plus a brief. |
| **Claim** | An agent's lock on a task, so no two agents work on the same one. A claim held by a dead process is broken and logged. |
| **Hold** | A pause Lair or you put on an agent or task until something is released, for example while a decision is open. |
| **Fill** | The module that keeps agents busy: it starts an agent on the next task from the tasks file when it has capacity ([Agents](configuration.md#agents)). |
| **Tasks file** | The list of tasks fill works from, one line per agent and task. With the planner on, Lair proposes its changes. |
| **Planner** | The module that keeps the tasks file in line with your plans, backlog and messages, through a supervised planner agent whose proposals are checked ([design](design/planner.md)). |
| **Queue file** | A text file agents (or wrappers) append status lines to (`DONE`, `WAITING`, `BLOCKED`, ...), which Lair reads ([Agents](agents.md#queue-file-format)). |
| **Fleet bus** | Lair's MCP server: agents connect to it to claim tasks, report status and send messages instead of writing the queue file ([Agents](agents.md#fleet-bus-mcp)). |
| **Gate** | One run of your checks (build, tests, linters, scanners) on one commit. Its result decides whether a change can merge. |
| **Lane** | A queue of gates served by one runner, for example a heavy lane for full test suites and a light lane for quick checks. |
| **Runner** | The process that takes gates from a lane and runs them, on a machine. |
| **Pipeline** | A gate defined in the project file and run by Lair itself, on CI runners first and the local machine last ([Configuration](configuration.md#gate-pipelines)). |
| **Triage** | Lair's reading of a failed gate: each cause classified as infrastructure, flaky, pre-existing or a real failure of the change ([Configuration](configuration.md#triage)). |
| **Placement** | Which machine runs each queued gate, from measured durations, load and capacity ([Configuration](configuration.md#placement)). |
| **Risk tier** | How risky a change is (for example by the paths it touches), which decides the reviews it needs before merging. |
| **Decision Inbox** | The one place Lair asks you something: spend, accounts, credentials, go/no-go, and problems it could not fix ([Configuration](configuration.md#decision-inbox)). |
| **Watchdog** | The module that notices stuck or crashed agents, stale locks and stalls, and recovers through your own commands ([Configuration](configuration.md#watchdog)). |
| **lair-node** | A small daemon for running work on other machines; a preview today ([design](design/node.md)). |
| **Owner** | You: the person signed in to answer decisions and change settings. |
