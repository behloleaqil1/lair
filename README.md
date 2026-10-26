# Lair

Lair is a local web dashboard and control room for a fleet of AI coding agents ("dragons"). It shows what each agent is doing, the queue of CI gates, open pull requests and the health of your machines, and it can optionally start and stop agents and run your own scripts from one place.

It's for developers who run several AI coding agents in parallel against a repository, with a file-based workflow: agents append status lines to a queue file, gate runners drop result files into a directory, and an orchestrator ties it together. Lair reads those files; it doesn't replace your agents or your CI.

Lair is **agent-agnostic**: agents are started by commands you configure, so any CLI-based agent can be wired in. Kiro is the only agent it has been tested with so far.

## What it shows

- **Overview**: repository status, recent merges and detected problems
- **Decisions**: the Decision Inbox, the one place Lair asks you something (pricing, legal, spend, accounts, credentials, go/no-go, and problems its playbooks couldn't fix). Each decision shows what it blocks, its options with their consequences and a recommendation; the nav shows how many wait for you ([details](docs/configuration.md#decision-inbox))
- **Dragons**: agent status, current tasks, logs and stats
- **Gates**: gate queue by lane, running jobs and recent results
- **PRs**: open pull requests with gate status and merge readiness
- **Orchestrator**: heartbeat ticks, STOP file and service status
- **Machines**: machine health, runners and SSH connectivity
- **Activity and Inbox**: live fleet bus feed, audit log, and messages to and from the orchestrator
- **Processes and Nodes**: services Lair supervises, and connected lair-node daemons (experimental)
- **Health**: the progress watchdog. It is off by default, and observe-only until you opt in. It detects hung or duplicate agents, stale locks and claims, orphaned gates, broken lanes, idle capacity, stalls and crash loops, and recovers through your own commands ([configuration](docs/configuration.md#watchdog))
- **Delivery**: your application's environments (docker compose projects). Bring them, or one service, up and down; Lair deploys changed services after a merge and rolls them back when they aren't healthy in time, never starts a service you stopped until you release it, and stops restarting a crash-looping one ([configuration](docs/configuration.md#delivery))

## Requirements

- macOS or Linux
- Node.js 22 or 24 (the versions CI tests; Node 20 is end-of-life and not supported) and npm
- Git
- A C/C++ toolchain only if npm can't download a prebuilt `better-sqlite3` binary for your platform

The Orchestrator view checks the orchestrator's service with `launchd`/`launchctl`, so that one status field works only on macOS. Everything else works on Linux too.

## Install and first run

```bash
git clone https://github.com/behloleaqil1/lair.git
cd lair
npm install
npm run build
npm start
```

Open `http://localhost:4777`. The server serves the API and the built UI on that port, and starts with the bundled `example` project, which reads the synthetic files in `fixtures/`, so there is something to look at right away. Always start Lair from the repository root: it reads `projects/` and writes its state to `data/` relative to the current directory.

For development with hot reload, run `npm run dev` and open `http://localhost:5173` instead.

## Configure your project

Each monitored project is a YAML file. Put your own in `projects/local/` (gitignored), starting from the example:

```bash
mkdir -p projects/local
cp projects/example.yaml projects/local/myproject.yaml
```

```yaml
# projects/local/myproject.yaml
name: MyProject
repo: /path/to/repo
github: owner/repo-name
queue_file: /path/to/queue.md
agents_dir: /path/to/agents
gates_dir: /path/to/gates

machines:
  local:
    name: Workstation
    type: local
    runners: [heavy, light]
```

Project files end in `.yaml` or `.yml` (both the server and the bus load either; `.yaml` wins if both exist). Restart the server after adding a project. To open your project by default instead of `example`, start the server with `LAIR_PROJECT=myproject` (an unknown name logs a warning and is ignored). See [Getting Started](docs/getting-started.md) for a walkthrough and [Configuration](docs/configuration.md) for every option (machines over SSH, controls, merge bar, dragons, process manager).

## Connect an agent

There are two ways to get an agent's status into Lair:

1. **Queue file**: the agent (or a wrapper script) appends lines such as `- DONE fix-login by kiro-A 14:35Z: summary` to the project's `queue_file`.
2. **Fleet bus**: the agent connects to Lair's MCP server and calls tools such as `claim`, `report` and `send`. The bus isn't published on npm; run it from your Lair checkout:

   ```bash
   LAIR_AGENT_ID=kiro-A npm run --silent bus -- --project myproject
   ```

To start and stop agents from the UI, set `read_only: false` and configure `dragon_start_cmd` and `dragon_stop_cmd`. See [Agents](docs/agents.md) for the queue format, the MCP tools, an MCP client config example and start scripts.

## Controls

By default everything is **read-only**. Set `read_only: false` in a project config to enable controls. Each control runs one command from the project config, as an argument array (never through a shell), and is logged to `data/audit.log`.

In the UI:

- **Command bar**: *Ask* runs `ask_cmd` (read-only query), *Instruct* sends a message to the orchestrator, *Task* starts an agent with `agent_run_cmd`
- **Dragons**: start a dragon with a task (`dragon_start_cmd`) and stop it (`dragon_stop_cmd`)

The API (`/api/controls/*`) also has endpoints without UI buttons yet: orchestrator pause/resume and run a tick now, agent stop and release a task, submit a gate and mark a gate as stuck, and merge a PR (`merge_cmd`). Lair does not check the `merge_bar` before merging, so your merge script should.

Only stopping a dragon asks for confirmation; other controls run when clicked.

## Status and limitations

Lair is early software (0.x). The dashboard, the controls listed above and the fleet bus are the most complete parts; others are experimental or unfinished:

- **lair-node** (`lair-node` / `npm run node`) is a preview. It uses placeholder keys and runs a placeholder job command instead of the real task. It talks to the server over a plain, unencrypted WebSocket; nodes on other machines need `LAIR_NODE_TOKEN` (see [Security](#security)). `lair-node start` runs it in the background (log in `~/.lair/node/daemon.log`), `--foreground` in the terminal.
- **Job and gate signatures** are not end-to-end yet: nodes sign with placeholder signatures, so signed results prove nothing.
- **Agent adapters** other than `kiro` (`aider`, `claude-code`, `cursor-agent`) are untested, and their command templates may not match your installed version. Adapters are descriptive today; agents start through `dragon_start_cmd`.
- **Gate pipelines** from a project's `pipelines:` block run from the Gates view or the API, on GitHub Actions runners first and on the local machine last ([Configuration](docs/configuration.md#gate-pipelines)). lair-node machines can't take pipeline jobs yet, runs start only by hand (no automatic triggers), and their results don't feed the merge policy yet.
- **Gate runner and merge policy** modules (`policy/`, `services/gate-runner.ts`, and the signing in `gates/`) are library code with tests, not yet wired into the running server.
- **Kiro conventions** remain in a few defaults: a dragon without `adapter:` uses the `kiro` adapter; the queue parser finds non-kiro agent IDs only in the `by <agent-id>` position (or a `(<agent-id>, ...)` prefix), while `kiro-X` IDs are recognised anywhere in a line; and the command bar's `tell <dragon-id> ...` form needs an ID with a `-` (`@<dragon-id> ...` works for any ID). Dragon IDs themselves can be any letter-first name (see [Configuration](docs/configuration.md#dragons-agents)).
- The design notes in [docs/design/](docs/design/) describe much more than is built.

**Upgrade note: watchdog escalations moved to the Decision Inbox.** A watchdog escalation is now a decision in the Decisions view, and is **no longer appended to `inbox_file`**. If you set `watchdog.escalation_file`, it still gets a copy of every escalation as an `- OWNER? ...` entry. `inbox_file` gets one only when a decision can't be raised. See [Watchdog](docs/configuration.md#watchdog).

## Security

- The server binds to `127.0.0.1:4777` by default.
- **There is no authentication.** Anyone who can reach the port can read your project data and, with controls enabled, run the configured commands.
- The one exception is **answering decisions**: it needs the answer token in `data/decisions.answer-token` (created at first start, readable only by your OS user; the server prints a one-time setup link). Answers come only from the Decisions view in a browser that unlocked answering with it, so other programs, agents included, can't approve the work a decision holds back. A program running as your OS user can read that file; run agents as a separate OS user to close that gap ([details](docs/configuration.md#decision-inbox)).
- The server refuses (HTTP 403) cross-site browser requests, that is any `Origin` other than its own loopback origins on ports 4777 and 5173, and requests whose `Host` header names another host, which blocks DNS rebinding. WebSocket handshakes get the same `Origin` check. Clients without an `Origin` header (`curl`, lair-node) are allowed.
- `LAIR_HOST` changes the bind address and adds that host to the allowed origins and `Host` headers, so a browser that opens `http://<LAIR_HOST>:4777` gets the full dashboard. A wildcard (`LAIR_HOST=0.0.0.0` or `::`) listens on every interface and switches the `Host` check off, but a wildcard is not an origin, so it adds none: a browser on another machine gets only the read-only GET requests, while its POSTs (every control) get HTTP 403 and its WebSocket is refused (no live updates). To use the dashboard from another machine, set `LAIR_HOST` to the address that machine's browser opens. **Either way this is unsafe on an untrusted network: never set `LAIR_HOST` to a network or wildcard address there.**
- lair-node connections from other machines are refused unless the server has `LAIR_NODE_TOKEN` set and the node sends the same token. The connection is still unencrypted.
- Controls are off by default (`read_only: true`) and run only commands from your config, as argument arrays. The legacy `ssh_cmd` machine setting and remote gate commands over SSH do go through a shell; see [SECURITY.md](SECURITY.md#command-execution-safety).
- Lair never reads `.env` or credential files. SSH keys are paths in the config; Lair never stores key contents.

See [SECURITY.md](SECURITY.md) for details and how to report a vulnerability privately.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server (API + client with hot reload, UI on port 5173) |
| `npm run build` | Build the client and the server into `dist/` |
| `npm start` | Start the built server (API and UI on port 4777) |
| `npm run bus -- --project <name>` | Run the fleet bus MCP server (stdio) |
| `npm run node -- <command>` | lair-node CLI (experimental) |
| `npm test` | Run tests |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run the TypeScript check |

## Documentation

- [Getting Started](docs/getting-started.md): installation and first project setup
- [Configuration](docs/configuration.md): full reference for all config options
- [Agents](docs/agents.md): connecting AI coding tools
- [Architecture](docs/architecture.md): components and data flow
- [Design notes](docs/design/): plans and feature designs (much of it not built yet)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, checks and the no-private-details rule, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT, see [LICENSE](LICENSE).
