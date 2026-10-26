# Lair phase 4: SSH machine fleet, distributed gates, and full agent management

This phase makes Lair a multi-machine gate runner coordinator AND a full agent fleet manager. Status: partly built
(SSH machines, gate distribution, agent adapters, budgets, self-healing); the manager chat view (§10) is not built,
and adapters other than `kiro` are untested. The adapter examples below are design sketches, not the shipped defaults
(see [docs/agents.md](../agents.md)). No private details in examples (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).

## 0. Agent-Agnostic Architecture

Lair is an **AI agent orchestration platform**, not a tool-specific solution. Any AI coding agent that can:
1. Run as a CLI process (stdin/stdout or file-based)
2. Read a prompt/task file
3. Write status to files (queue, logs)

...can be orchestrated by Lair.

### Agent adapter interface

Each AI tool is configured as an "agent adapter":
```yaml
agent_adapters:
  kiro:
    name: Kiro CLI
    start_cmd: kiro-cli chat --no-interactive --trust-all-tools --agent {agent_profile} --model {model} {prompt_file}
    stop_cmd: touch {session_dir}/STOP
    # How the agent reports status
    status_method: file        # file | stdout | mcp
    queue_file: agents/queue.md
    log_dir: agents/logs/
    # Session management
    session_id_env: KIRO_SESSION_ID
    resume_flag: --resume-id {session_id}
    
  claude-code:
    name: Claude Code (Anthropic)
    start_cmd: claude-code --task {prompt_file} --output {output_dir}
    stop_cmd: kill -TERM {pid}
    status_method: stdout
    # Claude Code might output JSON status lines
    status_pattern: '^\{"status":'
    
  aider:
    name: Aider
    start_cmd: aider --yes --message-file {prompt_file}
    stop_cmd: kill -INT {pid}
    status_method: file
    queue_file: .aider/status.md
    
  cursor-agent:
    name: Cursor Agent
    start_cmd: cursor-agent run {prompt_file}
    stop_cmd: cursor-agent stop {agent_id}
    status_method: mcp
    mcp_endpoint: stdio
    
  custom:
    name: Custom Script
    start_cmd: ./my-agent.sh {agent_id} {task} {prompt_file}
    stop_cmd: ./my-agent-stop.sh {agent_id}
    status_method: file
    queue_file: logs/agent-status.md
```

### Template variables

Commands use these placeholders (Lair substitutes at runtime):
- `{agent_id}` - The agent's ID (e.g., `agent-A`, `kiro-B`)
- `{agent_name}` - Display name (e.g., `Smaug`, `Builder-1`)
- `{task}` - Task/branch name
- `{prompt_file}` - Path to the task prompt file
- `{model}` - AI model ID
- `{session_id}` - Session ID for resume
- `{session_dir}` - Session directory
- `{output_dir}` - Output directory
- `{pid}` - Process ID (for stop commands)
- `{agent_profile}` - Agent profile/persona name

### Status reporting methods

**`file`** (most compatible): Agent writes to a queue/log file in a known format. Lair polls the file.
```markdown
- WAITING task-123 gate-id-456 by agent-A 12:34Z
- DONE task-123 by agent-A 12:45Z: sha abc123, gate passed
- BLOCKED task-123 by agent-A 12:50Z: tests failing, need human input
```

**`stdout`**: Agent streams JSON status to stdout. Lair captures and parses.
```json
{"status": "working", "task": "task-123", "progress": "writing tests"}
{"status": "done", "task": "task-123", "result": {"sha": "abc123"}}
```

**`mcp`**: Agent connects to Lair's MCP bus and uses the claim/report tools directly.
This is the richest integration — agents can send messages, receive instructions, claim tasks atomically.

### Backward compatibility

The "dragons" terminology is the DEFAULT naming:
- `dragons:` in config → displayed as "Dragons" in UI
- `agent_adapters.kiro` is pre-configured

But users can rename everything:
```yaml
# For a different project using Aider
terminology:
  agent_singular: worker
  agent_plural: workers
  orchestrator: coordinator
  
agents:  # Instead of "dragons"
  worker-1:
    name: Alice
    adapter: aider
    model: claude-sonnet
  worker-2:
    name: Bob
    adapter: claude-code
    model: claude-opus
```

### Project templates

Lair ships with project templates for common setups:
- `full` - Full setup with gates, dragons, orchestrator
- `simple` - Basic agent orchestration, no gates
- `ci-agents` - Agents triggered by CI events
- `blank` - Empty template for custom setups

```bash
lair init --template simple my-project
```

### Migration path for existing Kiro users

1. Existing `dragons.txt`, queue files, gate scripts continue to work unchanged
2. Adding `agent_adapters:` to config enables multi-tool support
3. The MCP bus (`src/bus/`) is adapter-agnostic — any tool can connect
4. UI shows adapter icon/badge next to each agent

## 1. Machine management in config and UI

### Config (`projects/<name>.yaml`)
```yaml
machines:
  local:
    name: Local Workstation
    type: local
    runners: [heavy, light]
  build-server:
    name: Build Server
    type: ssh
    host: 198.51.100.10
    user: deploy
    key: ~/.ssh/example_key
    runners: [remote]
    connect_timeout: 4
    # Optional: paths on the remote machine
    work_dir: /home/deploy/my-project
    gate_script: work/bin/gate.sh
```

Each machine has:
- `type`: `local` (commands run directly) or `ssh` (commands run via SSH)
- `runners`: which gate lanes this machine handles (one lane = one concurrent gate)
- For `ssh`: `host`, `user`, `key` (path to private key), `connect_timeout` (seconds)
- Optional `work_dir` (defaults to same as local), `gate_script` (defaults to project's)

### UI: Machines view (extends phase 1)
- List all machines with status: online/offline/unknown, last check time, current load
- For each machine: configured runners, running gates, queued gates for its lanes
- **Add machine button** (phase 2 controls enabled): opens a form for SSH details, tests connection, saves to config
- **Edit/remove machine**: with confirmation; cannot remove while gates are running on it
- **Test connection**: runs the health check command and shows output

### Health checks
- Local: always up
- SSH: `ssh -i <key> -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=<timeout> <user>@<host> "echo up && uptime"`
- Checked: on Lair start, when a gate is about to be assigned, and on manual "test" click
- Cache: result valid for 60 seconds (configurable per machine)

## 2. Gate runner distribution

### Lane-to-machine mapping
The existing gate queue uses lanes (`heavy`, `light`, `remote`). Each machine declares which lanes it handles:
```yaml
machines:
  local:
    runners: [heavy, light]   # Local handles heavy and light lanes
  build-server:
    runners: [remote]         # Build server handles remote lane
  ci-server:
    runners: [heavy]          # Another heavy runner = 2 concurrent heavy gates
```

When multiple machines handle the same lane, gates are distributed round-robin among online machines.

### Gate assignment flow
1. Gate request arrives in `queue/<lane>.<pri>.<id>.req`
2. Lair (or the existing runner) picks the highest-priority request for an available lane
3. Lair selects an online machine that handles this lane (round-robin, or least-recently-used)
4. For local machine: run gate directly (existing behavior)
5. For SSH machine:
   - Sync the worktree to the remote (rsync or git clone/fetch)
   - Run the gate script on the remote via SSH
   - Stream output back to the log
   - Fetch results back to local `results/`

### Remote execution
For SSH machines, Lair runs:
```bash
ssh -i <key> -o IdentitiesOnly=yes -o BatchMode=yes <user>@<host> \
  "cd <work_dir> && <gate_script> <conf> <worktree> [env vars]"
```

Worktree sync options (configurable per machine):
- `sync: rsync` — rsync the worktree before each gate (good for small changes)
- `sync: git` — the remote has a clone; fetch and checkout the branch (better for large repos)
- `sync: none` — assume the remote already has the code (shared filesystem or manual sync)

### Fallback
If an SSH machine is offline when its lane has queued gates:
- Lair marks the machine as offline
- If another machine handles the same lane, reassign to it
- If no machine available, the gate stays queued (existing behavior)
- Notify in the UI: "Machine X offline, gate Y waiting"

## 3. New config commands

For projects that want Lair to manage gate distribution (optional; existing `gate-run.sh` can still work):
```yaml
gate_runner:
  enabled: true           # Lair manages gate distribution
  poll_interval: 5        # seconds between queue checks
  sync_method: rsync      # default for SSH machines
  rsync_exclude:
    - node_modules/
    - .gradle/
    - target/
```

When `gate_runner.enabled` is false, Lair only shows the queue and machines; the project's own runners do the work.

## 4. UI additions

### Gates view (extends phase 1)
- Show which machine is running each gate
- For SSH gates: show sync status, remote execution status
- Machine column in queue: assigned machine or "pending assignment"

### Activity view (phase 2)
- Machine online/offline events
- Gate assignments with machine selection reason
- Sync start/complete/fail events

## 5. Quality bar

- Unit tests: machine config parsing, lane-to-machine mapping, round-robin selection, health check caching
- Integration test: a fake SSH server (or mocked SSH command) that receives gate commands
- Sync tests: rsync command builder, git fetch/checkout command builder
- Failure tests: machine goes offline mid-gate (cleanup, reassign if possible, mark failed if not)
- Config validation: duplicate lanes across machines (allowed), no machine for a lane (warning), invalid SSH key path (error on add)
- `npm test`, `npm run lint`, `npm run typecheck` pass

## 6. Security

- SSH keys are paths in the config; Lair never stores key contents
- BatchMode=yes prevents password prompts (would hang)
- IdentitiesOnly=yes prevents agent key confusion
- Lair runs only the configured commands; user text never reaches a shell on the remote
- The UI shows machine host/user but never the key path or key contents
- Audit log records all remote commands with their exit codes

## 7. Full agent management

(Note: "dragons" is the default terminology; users can configure their own via `terminology:` in config)

### Agent registry in config
```yaml
# Default style (backward compatible)
dragons:
  kiro-A:
    name: Smaug
    adapter: kiro              # Which agent adapter to use (default: kiro)
    model: claude-opus-4.5    # AI model to use
    machine: local            # Which machine runs this agent
    instructions: |           # Extra instructions prepended to every prompt
      Focus on backend work. Always run the project's checks before committing.
  kiro-B:
    name: Saphira
    adapter: kiro
    model: claude-sonnet-4-20250514
    machine: local
    instructions: ""

# Or with custom terminology
agents:
  worker-1:
    name: Builder One
    adapter: aider
    model: gpt-4
    machine: cloud-vm-1
  worker-2:
    name: Builder Two
    adapter: claude-code
    model: claude-opus-4.5
    machine: local
```

### Agent management UI (extends Dragons/Agents view)
- **Agent list:** all configured agents with: name, id, adapter, model, machine, status (running/idle), current task
- **Adapter badge:** shows which AI tool (Kiro, Aider, Claude Code, etc.)
- **Start agent:** select agent + task id + prompt (from templates or free text) + optional extra instructions
- **Stop agent:** graceful stop (adapter-specific) or force (kills process)
- **Edit agent config:** change adapter, model, machine assignment, standing instructions
- **Add agent:** new id, name, adapter, model, machine, instructions

### Model selection
Available models (configurable per project):
```yaml
available_models:
  - id: claude-opus-4.5
    name: Claude Opus 4.5
    description: Most capable, higher cost
  - id: claude-sonnet-4-20250514
    name: Claude Sonnet 4
    description: Fast and capable, lower cost
  - id: claude-haiku  
    name: Claude Haiku
    description: Fastest, lowest cost
```

When starting a dragon:
1. Use the dragon's configured model by default
2. Allow override in the start dialog
3. Pass model to the agent launcher: `--model <model-id>`

### Extra instructions
Three levels of instructions (combined in order):
1. **Project-level:** in `projects/<name>.yaml` under `default_instructions`
2. **Dragon-level:** in the dragon's config under `instructions`
3. **Task-level:** entered when starting the dragon (the prompt dialog)

Combined as:
```
[Project instructions]
[Dragon instructions]
[Task prompt]
```

### Remote dragon execution
When a dragon's `machine` is an SSH machine:
1. The dragon process runs on that machine via SSH
2. Lair streams the output back to the local log
3. The dragon uses the remote machine's resources (CPU, memory)
4. Requires: the remote has the agent CLI installed and configured

```yaml
machines:
  build-server:
    type: ssh
    host: 198.51.100.10
    # ...
    kiro_cli: /home/deploy/.local/bin/kiro-cli  # Path to agent CLI on remote
```

### Commands for dragon management
```yaml
dragon_start_cmd: work/bin/dragon-start.sh {dragon} {task} {prompt_file}
dragon_stop_cmd: work/bin/dragon-stop.sh {dragon}
dragon_release_cmd: work/bin/release.sh {task}
```

For remote dragons, Lair wraps these in SSH.

## 8. Dependencies on earlier phases

- Phase 1: Machines view (extended), Gates view (extended), Dragons view (extended)
- Phase 2: Add/edit/remove machine buttons, gate_runner config, dragon start/stop controls
- Phase 3: Not required (the bus is for agent messaging; dragon management is separate)

Can be built in parallel with phase 3; the UI extends phase 1/2.

## 9. Implementation chunks

### Chunk 1: Machine config and health checks ✓
- Machine config schema, health checker, SSH command builder
- Tests for config parsing, no actual SSH

### Chunk 2: Agent config and model selection ✓
- Agent registry schema, model config
- Agent list UI with model/machine display
- Tests for config parsing

### Chunk 3: Agent start/stop controls (in progress)
- Start dialog: agent picker, task input, prompt editor, model override, extra instructions
- Stop button with confirmation
- Integration with agent_start_cmd/agent_stop_cmd

### Chunk 4: Gate distribution ✓
- Lane-to-machine mapping, gate assignment logic
- Remote gate execution via SSH
- Fallback handling

### Chunk 5: Remote agent execution (stretch)
- Run agents on SSH machines
- Stream output back to Lair
- Requires agent CLI on remote

### Chunk 6: Manager chat integration
- Manager session display and interaction
- Orchestrator control panel
- Multi-orchestrator support

### Chunk 7: Agent adapter system (NEW)
- `AgentAdapter` interface and built-in adapters (kiro, aider, claude-code)
- Adapter config validation
- Start/stop command templating with variable substitution
- Status parser plugins (file, stdout, mcp)
- Tests for each built-in adapter
- UI: adapter picker in "Add agent" dialog, adapter badge in list

## 10. Manager chat integration

The "manager" is a special session that coordinates dragons and orchestrators. Lair
should display the manager session and allow the owner to interact with it.

### Manager vs Orchestrator vs Dragon

| Role | What it does | How many | Runs as |
|------|--------------|----------|---------|
| **Manager** | Coordinates orchestrators, reviews merges, makes design decisions, responds to owner | 1 per project | Interactive agent chat |
| **Orchestrator** | Runs the tick loop: starts dragons, processes gates, merges PRs | 1 active (can have standby) | Headless agent, scheduled/launchd |
| **Dragon** | Builds code, writes tests, submits gates | Up to N active | Headless agent, started by orchestrator or manager |

### Config
```yaml
manager:
  enabled: true
  session_id: sess_abc123...          # Current manager session ID
  log_file: /path/to/manager.log      # Where to tail manager output
  inbox_file: agents/owner-inbox.md    # Owner → Manager messages
  outbox_file: agents/owner-outbox.md  # Manager → Owner replies

orchestrators:
  - id: agent-O
    name: Orchestrator
    role: primary
    tick_interval: 300          # seconds
    launchd_label: com.example.orchestrator-tick
    state_file: agents/orchestrator-state.txt
    inbox_file: agents/orchestrator-inbox.md
```

### Manager view (new top-level view)

**Header:**
- Manager status: Active (session_id) / Inactive
- "Send instruction" button (opens command bar pre-filled with manager target)

**Main panel — Manager conversation:**
- Stream the manager's conversation (read-only display)
- Show: owner messages (from inbox), manager responses (from outbox), manager actions (from queue lines)
- Auto-scroll with "pause auto-scroll" toggle
- Message types styled differently:
  - Owner instructions: blue left border
  - Manager responses: green left border
  - Manager actions (TICK, merge, start dragon): gray, compact

**Sidebar — Manager tools:**
- **Instruct manager:** Text input, sends to `inbox_file` as `- OWNER <time> [<id>]: <text>`
- **View pending:** List of instructions without replies
- **Recent actions:** Last 10 actions from queue (filtered to manager's entries)

### Orchestrator panel (within Manager view or separate)

**For each orchestrator:**
- Status: Running (PID) / Stopped / Scheduled (next tick at X)
- Last tick: time, summary from queue
- Controls:
  - "Tick now" — runs one tick immediately (existing phase 2 feature)
  - "Pause" — creates STOP file to pause after current tick
  - "Resume" — removes STOP file
  - "View log" — shows recent orchestrator output

**Orchestrator list (if multiple):**
- Primary orchestrator (runs ticks)
- Standby orchestrators (can take over)
- "Promote to primary" button (swaps roles)

### Manager-orchestrator relationship

The manager can:
1. **Give instructions** to the orchestrator via `orchestrator-inbox.md`
2. **Override orchestrator decisions** (e.g., "don't merge PR #X yet")
3. **Take direct actions** that the orchestrator would normally do (merge a PR, start a dragon)
4. **Review orchestrator's work** (the orchestrator logs everything to the queue)

The orchestrator reads manager instructions at the start of each tick (existing OWNER INBOX behavior).

### UI implementation

**ManagerView.tsx:**
```typescript
// Displays the manager session and orchestrator controls
- useManagerSession() hook: polls session status, streams conversation
- useOrchestrators() hook: polls orchestrator status from state files
- ConversationPanel: renders inbox/outbox/queue as threaded conversation
- OrchestratorsPanel: status + controls for each orchestrator
- InstructionForm: sends to inbox_file via POST /api/controls/instruct
```

**Routes:**
- `GET /api/manager/status` — session active, last activity, pending instructions
- `GET /api/manager/conversation` — inbox + outbox + relevant queue lines, merged chronologically
- `POST /api/manager/instruct` — append to inbox_file (reuses phase 2 instruct)
- `GET /api/orchestrators` — list with status, last tick, next scheduled
- `POST /api/orchestrators/:id/tick` — run one tick (reuses phase 2)
- `POST /api/orchestrators/:id/pause` / `resume`

### Session streaming (stretch)

If the manager is an agent CLI session, Lair can:
1. Tail the session log file for live output
2. Send input via the session's stdin (requires session to support this)
3. Show tool calls and their results as they happen

This requires understanding the agent's session format. For now, the inbox/outbox file-based approach works.

### Security

- Manager instructions are appended to files, never executed directly
- The manager interprets and acts on them per its rules
- Lair cannot make the manager do anything the manager's rules forbid
- All manager actions are logged to the queue file (audit trail)
- Read-only mode disables instruction sending

### Quality bar

- Tests: inbox/outbox parsing, conversation merging, orchestrator status parsing
- UI: conversation panel scrolls correctly, instructions send correctly
- Integration: instruction appears in manager's context within one poll cycle
