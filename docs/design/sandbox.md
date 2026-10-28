# Agent Sandboxing: isolation of agent runs from the owner and from each other

> **Design reviewed against [DESIGN-CHECKLIST.md](/Users/dev/leadforge/work/kiro-runs/DESIGN-CHECKLIST.md).** Every code
> reference verified with `git grep`/`git show` on `github/main` (7e90e73). New items marked "new".

This document is ROADMAP.md item B4: "An agent cannot read the owner token, Lair's data or another agent's run
environment."

## Contents

1. [Why sandboxing matters](#1-why-sandboxing-matters)
2. [Threat model: what an agent can do today](#2-threat-model-what-an-agent-can-do-today)
3. [Isolation options with trade-offs](#3-isolation-options-with-trade-offs)
4. [Recommendation: per-agent OS users with scoped credentials](#4-recommendation-per-agent-os-users-with-scoped-credentials)
5. [How it works end to end](#5-how-it-works-end-to-end)
6. [Migration and rollout](#6-migration-and-rollout)
7. [Acceptance tests](#7-acceptance-tests)
8. [Open questions for the owner](#8-open-questions-for-the-owner)

---

## 1. Why sandboxing matters

Lair's architecture treats agents as the untrusted party (ROADMAP.md rule 2: "Agents are the untrusted party"). Today
this is enforced through:

- **Signed gate results:** a gate result is trusted only when it comes in-process from Lair's pipelines or is signed by
  a node in `triage.trusted_nodes` (`src/server/triage/manager.ts:110`).
- **Owner-only routes:** answering decisions, reviewing, merging and other sensitive actions require a signed-in
  browser session (`src/server/human-auth/human-auth.ts`, `requireOwner()` and `requireOwnerForChanges()` hooks).
- **Built environment:** agents receive only a subset of environment variables (`src/server/agents/probes.ts:26-42`,
  `BASE_ENV` and `env_passthrough`), never the server's secrets.

However, agents run as the **same OS user as Lair**, so they can:

- Read `data/owner.token` and sign themselves in as the owner, then answer decisions that gate their own work.
- Read the server's stdout (where the setup link is printed on first start) or its log files.
- Read or write Lair's stores: `data/lair.db`, `data/agents.db`, `data/decisions.db`, `data/watchdog.db`, etc.
- Read other agents' worktrees, session directories and logs; overwrite their queue lines or mailbox files.
- Read shared credentials (git host tokens, SSH keys, API keys) from well-known paths.

The current comment in `src/server/human-auth/human-auth.ts:20-22` says it plainly:

> Limits: a process running as the same OS user can read data/ (the token) and the server's log (the setup link). Run
> agents as a separate OS user.

This design fulfils that requirement for **both macOS and Linux**.

---

## 2. Threat model: what an agent can do today

An agent is any process Lair starts through `src/server/agents/service.ts` (the agents module) or a project's
`dragon_start_cmd`. It runs as the Lair server's user with full file and network access.

### 2.1 Files an agent can read

| Path | What it contains | Risk if an agent reads it |
|------|-----------------|---------------------------|
| `data/owner.token` | The owner token (mode 0600, but same uid) | Sign in as the owner, answer any decision |
| `data/owner-sessions.db` | HMACs of browser sessions | With the token, verify whether a session is valid |
| `data/lair.db` | Core store (nodes, tasks, jobs) | Know every task and job |
| `data/agents.db` | Runs, claims, events, usage ledger | Claim another agent's task, forge events |
| `data/decisions.db` | Every decision ever raised | See pending decisions before they're answered |
| `data/watchdog.db` | Breaches and playbook runs | Learn what triggered escalations |
| `data/triage.db` | Results, causes, flaky tests, actions | See exactly why gates failed |
| `data/review.db` | Reviews, findings, merges | See every review |
| `data/delivery.db` | Environment state, crash loops | See deployment secrets in logs |
| `data/pipelines.db` | Pipeline runs and jobs | Forge a gate result |
| `data/planner.db` | Planner state and proposals | Change planned work |
| `data/supervisor.db` | Supervisor calls and tokens | Reuse a supervisor's ops token |
| `data/config-history/<project>/` | Config history YAML | See historical credentials |
| `projects/local/<project>.yaml` | Project config (gitignored) | May contain secret paths or passphrases |
| Server stdout / logs | The setup link on first start | Sign in as owner |
| Other agents' worktrees | Code and uncommitted changes | Sabotage another agent's work |
| Other agents' `session_dir` | Session files (STOP, logs) | Stop another agent, read its work |
| Other agents' mailboxes | `mail_dir/<id>.md` | Forge messages, drop instructions |
| Shared queue file (`queue_file`) | All agents' reports | Forge DONE lines for another agent |
| `~/.ssh/`, `~/.gitconfig` | SSH keys, git credentials | Push to any repository the owner can |
| `~/.config/kiro/`, `~/.claude/` | Tool credentials and sessions | Act as the owner in any AI tool |
| Environment passthrough | `ANTHROPIC_API_KEY` etc. | Spend the owner's credits directly |

### 2.2 Files an agent can write

| Path | Effect of writing |
|------|-------------------|
| `data/owner.token` | Replace the token, sign out the real owner |
| `data/*.db` | Corrupt stores, forge records |
| `data/audit.log` | Hide or forge audit entries |
| Other agents' worktrees | Overwrite their code |
| Shared queue file | Append fake reports under any agent's name |
| Other agents' mailboxes | Inject instructions |
| Any file the uid owns | Delete, corrupt, exfiltrate |

### 2.3 Network actions an agent can take

- **Localhost 4777:** call any Lair API endpoint, including owner-only routes if it has the token.
- **Outbound HTTPS:** exfiltrate code, secrets or data.
- **SSH:** connect to any machine the owner's keys unlock.

### 2.4 What each existing defence stops

| Defence | What it stops | What it doesn't stop |
|---------|--------------|----------------------|
| `requireOwner()` (browser session) | Any caller without the session | A caller that read the token and made a session |
| `Origin` + `Sec-Fetch-Site` checks | Cross-site requests from other tabs | A local process crafting HTTP requests |
| Mode 0600 on `owner.token` | Other users | Same user (agents) |
| `agentEnvironment()` filtering | Passing the server's full env | Agents reading files or the shared env vars |
| Signed gate results | Unsigned or tampered results | A compromised agent that has a signing key |
| ROADMAP rule 2 (argv, no shell) | Command injection | File-based attacks |

**Gap:** Same-uid agents can read any file and call any API they have the token for.

---

## 3. Isolation options with trade-offs

### 3.a. One dedicated OS user for all agents (`lair-agents`)

Lair spawns agent processes with `sudo -u lair-agents` or via setuid. All agents share one uid, different from Lair's.

| Aspect | Detail |
|--------|--------|
| **Isolation strength** | Agents cannot read `data/` or the owner token. Agents CAN read each other's worktrees and sessions. |
| **Setup (macOS)** | `sudo sysadminctl -addUser lair-agents`; sudoers line for passwordless `sudo -u lair-agents`. |
| **Setup (Linux)** | `sudo adduser --system --no-create-home lair-agents`; sudoers line. |
| **Performance** | Minimal overhead (~5 ms per spawn for sudo). |
| **What breaks** | Worktree ownership (git complains about untrusted directories); agents need `git config --global safe.directory` for every worktree. Tool sign-ins are per-user, so all agents share one login or each signs in. SSH keys must be in `lair-agents`'s home or passed explicitly. |
| **Lair monitoring** | Log files owned by `lair-agents` are readable by Lair if the group has read; otherwise Lair must be in a shared group or use ACLs. |

**Limitations:** No isolation between agents. A compromised agent-A can still sabotage agent-B's work.

### 3.b. One OS user per agent (`lair-kiro-A`, `lair-kiro-B`, …)

Each agent id maps to its own Unix user. Lair spawns with `sudo -u lair-<agent>`.

| Aspect | Detail |
|--------|--------|
| **Isolation strength** | Agents cannot read Lair's data OR each other's worktrees/sessions. Full mutual isolation. |
| **Setup (macOS)** | Create each user with `sysadminctl`; sudoers wildcard `lair ALL=(lair-*) NOPASSWD: …`. |
| **Setup (Linux)** | `adduser --system --no-create-home lair-<id>` per agent; sudoers wildcard. |
| **Performance** | Same as 3.a. |
| **What breaks** | Same as 3.a, but per agent. Each agent needs its own tool sign-in (or a shared read-only credential). Git worktrees must be per-agent or world-readable. SSH keys per agent. |
| **Lair monitoring** | Lair reads logs via group membership or ACLs. |

**Advantage:** The only option that isolates agents from each other.

### 3.c. Containers (Docker/Podman) per run

Each agent run is a container. The worktree is bind-mounted; `data/` is not.

| Aspect | Detail |
|--------|--------|
| **Isolation strength** | Full filesystem isolation: the container sees only its bind mounts. Network can be restricted. |
| **Setup (macOS)** | Docker Desktop or OrbStack; Lair's spawn calls `docker run …`. |
| **Setup (Linux)** | Docker or rootless Podman. |
| **Performance** | Container startup is 1–3 s per run; volume I/O may be slower on macOS (virtiofs or gRPC-FUSE). |
| **What breaks** | Tool sign-ins inside the container (the host's `~/.kiro/` or `~/.claude/` must be mounted or the tool signs in inside each container). Git credentials must be mounted or passed. Docker socket access for agents that run tests in Docker (nested containers, or Lair's own Docker). |
| **Lair monitoring** | Logs go to a mounted path or `docker logs`. Lair must keep the container ID to read them. |

**Limitations:** Startup latency; Docker-in-Docker complexity; agents that themselves use containers (for tests) need
access to the Docker socket, which is root-equivalent on the host.

### 3.d. OS-level sandboxes (sandbox-exec / namespaces / bubblewrap / Landlock)

#### macOS sandbox-exec

A plist profile says which files and network the process may access. Deprecated but still functional in macOS 15.

| Aspect | Detail |
|--------|--------|
| **Isolation strength** | Fine-grained: allow only specific paths, deny network, deny IPC. |
| **Setup** | Write a `.sb` profile; spawn with `sandbox-exec -f <profile> <command>`. |
| **Performance** | Near-zero overhead (kernel checks). |
| **What breaks** | Deprecated; may be removed in a future macOS. Profiles are complex. Some agent CLIs use undocumented entitlements that a sandbox blocks. |
| **Lair monitoring** | Works normally; the sandbox is per-process. |

#### Linux user namespaces and bubblewrap

Remap uid 0 inside the namespace to an unprivileged uid outside; mount only allowed paths.

| Aspect | Detail |
|--------|--------|
| **Isolation strength** | Full filesystem and optional network namespace isolation. |
| **Setup (bubblewrap)** | `bwrap --ro-bind / / --bind <worktree> <worktree> --unshare-net …`. Requires `CAP_SYS_ADMIN` or unprivileged user namespaces enabled (`sysctl kernel.unprivileged_userns_clone=1`). |
| **Performance** | Near-zero overhead. |
| **What breaks** | Agent CLIs that need network (API calls) require a network namespace with NAT or no `--unshare-net`. Some distros disable unprivileged user namespaces by default. |
| **Lair monitoring** | Works normally. |

#### Linux Landlock

A kernel-level sandboxing API (Linux 5.13+) that restricts file paths without namespaces.

| Aspect | Detail |
|--------|--------|
| **Isolation strength** | File access only; no network isolation (though iptables rules can supplement). |
| **Setup** | Lair calls `landlock_*` syscalls before exec, or uses a Go/Rust wrapper. |
| **Performance** | Minimal. |
| **What breaks** | Requires a new-enough kernel. Doesn't isolate network. |
| **Lair monitoring** | Works normally. |

### 3.e. Combinations

**Recommended combination (see §4):**

| OS | Primary isolation | Secondary |
|----|------------------|-----------|
| macOS | Per-agent OS users (`lair-<id>`) via `sudo -u` | Optional: sandbox-exec profiles to restrict network egress |
| Linux | Per-agent OS users via `sudo -u` | Optional: Landlock for additional file restrictions, or bubblewrap for network |

---

## 4. Recommendation: per-agent OS users with scoped credentials

**Primary mechanism:** One OS user per agent (option 3.b).

**Why:**

1. **Full mutual isolation.** Agent A cannot read agent B's worktree, session or mailbox.
2. **Full isolation from Lair.** Agents cannot read `data/owner.token` or any store.
3. **Cross-platform.** Works identically on macOS and Linux with standard Unix permissions.
4. **No runtime overhead.** `sudo -u` adds ~5 ms per spawn; agents run for minutes or hours.
5. **No Docker dependency.** Many developers run Lair without Docker installed.
6. **Compatible with existing tools.** Agent CLIs (Kiro, Claude Code, Aider) work unmodified.

**Why not containers:**

- Startup latency (1–3 s per run).
- Docker-in-Docker complexity for agents that run containerised tests.
- macOS Docker I/O performance.

**Why not sandbox-exec alone:**

- Deprecated on macOS.
- Doesn't exist on Linux.
- Profiles are fragile when CLIs update.

### 4.1 Scoped credentials (short-lived, per-run tokens)

An agent that needs git access should NOT read the owner's credentials. Instead:

1. **Per-run git token:** Before spawning an agent, Lair requests a short-lived token (GitHub App installation token
   or fine-grained PAT) scoped to the repository and branch. The token is passed as `GIT_ASKPASS` or `GIT_CREDENTIAL`
   environment variable, never written to disk.
2. **No SSH keys:** Agents use HTTPS with the token; the owner's SSH keys stay in `~/.ssh/` owned by the owner.
3. **Tool sign-ins per agent user:** Each `lair-<id>` user signs into Kiro/Claude Code independently. Lair checks
   sign-in status (`src/server/ai/tools.ts`) and raises a decision if a tool is not signed in.

### 4.2 How reports reach Lair

Agents report through the **fleet bus** (`src/bus/`, [phase3-bus.md](phase3-bus.md)):

1. Agent calls MCP tools (`report`, `claim`, `release`, `inbox`, `ack`, `send`).
2. The bus writes to `data/<project>.db` (SQLite, owned by the Lair user, with a socket or a world-writable path the
   agent can connect to).
3. The bus mirrors reports to text files (queue file, mailboxes) for legacy compatibility.

**Alternative (no bus):** Agents append to the queue file. The queue file is group-writable, and both the Lair user
and agent users are in the `lair` group.

### 4.3 Keeping `data/` unreadable

| Path | Owner | Mode | Effect |
|------|-------|------|--------|
| `data/` | lair | 0700 | Agents cannot list or enter |
| `data/owner.token` | lair | 0600 | Agents cannot read |
| `data/*.db` | lair | 0600 | Agents cannot read |
| `data/<project>.db` (bus) | lair | 0660, group `lair` | Agents connect via the bus MCP server, which writes on their behalf |

---

## 5. How it works end to end

### 5.1 Install-time setup

The owner runs `lair sandbox setup` (new CLI command), which:

1. Creates the `lair` group if it doesn't exist.
2. Adds the current user to the `lair` group.
3. Creates system users `lair-<id>` for each agent in the project config's `dragons:` block.
4. Adds each `lair-<id>` to the `lair` group.
5. Creates a sudoers drop-in (`/etc/sudoers.d/lair-agents`) allowing the Lair user to run commands as any `lair-*`
   user without a password.
6. Sets `data/` ownership to `lair:lair`, mode 0750.
7. Sets agent worktree parent directories to group `lair`, mode 2775 (setgid).

**macOS example:**

```bash
# Create group
sudo dseditgroup -o create lair

# Create agent user (no home, no login shell)
sudo sysadminctl -addUser lair-kiro-A -shell /usr/bin/false -home /var/empty

# Add to group
sudo dseditgroup -o edit -a lair-kiro-A -t user lair

# Sudoers (in /etc/sudoers.d/lair-agents)
dev ALL=(lair-*) NOPASSWD: /usr/local/bin/kiro-cli, /bin/kill, /usr/bin/touch
```

**Linux example:**

```bash
# Create group
sudo groupadd lair

# Create agent user
sudo adduser --system --no-create-home --shell /usr/sbin/nologin --ingroup lair lair-kiro-A

# Sudoers
dev ALL=(lair-*) NOPASSWD: /usr/local/bin/kiro-cli, /bin/kill, /usr/bin/touch
```

### 5.2 Run-time spawn

In `src/server/agents/service.ts`, the `spawn()` call changes:

```typescript
// Before (agents/probes.ts ChildProcessSpawner)
spawn(file, args, { env, cwd, detached: true, ... });

// After (new SandboxedSpawner)
const sudoArgs = ["-u", `lair-${agentId}`, "--", file, ...args];
spawn("sudo", sudoArgs, { env: sanitizedEnv, cwd, detached: true, ... });
```

`sanitizedEnv` contains only `BASE_ENV`, `env_passthrough` and the per-run git token.

### 5.3 Per-run git credentials

Lair requests a scoped token from the git host before each run:

1. **GitHub:** call `POST /app/installations/{id}/access_tokens` with `repositories` and `permissions` (e.g.,
   `contents: write` for the one repository).
2. **GitLab:** create a project access token with `write_repository`, short expiry.
3. **Other hosts:** use an existing fine-grained PAT the owner supplies as a credential decision.

The token is passed as `GIT_CREDENTIAL_HELPER=!f() { echo "password=$TOKEN"; }; f` or via `GIT_ASKPASS` pointing to a
script Lair writes to a tempfile the agent user can read (mode 0400, owned by `lair-<id>`), deleted after the run.

### 5.4 Lair reading agent logs

Agent logs are written to `agents_dir/<id>/` (e.g., `work/agents/kiro-A/`). The directory is:

- Owned by `lair-<id>`.
- Group `lair`, mode 2750 (setgid, group read).

Lair (running as `dev`, member of `lair`) can read the logs. The agent can write them.

### 5.5 Stopping an agent

Lair calls `sudo -u lair-<id> kill -TERM <pid>`. The sudoers line allows this.

---

## 6. Migration and rollout

### 6.1 Phases

| Phase | Mode | What happens | When to move on |
|-------|------|--------------|-----------------|
| 0 | Off (default today) | Agents run as the Lair user. No isolation. | — |
| 1 | Observe | Lair logs every file an agent opens outside its worktree (via `dtrace`/`strace` wrapper or `opensnoop`). No enforcement. | After reviewing the log, no unexpected accesses. |
| 2 | Per-agent opt-in | `sandbox: enabled` on one agent in the project config. That agent runs as `lair-<id>`. Others run as before. | That agent works for a full cycle. |
| 3 | Project default | `sandbox.enabled: true` at project level. All agents sandboxed unless `sandbox: false` on a specific one. | All agents work for a full cycle. |
| 4 | Lair default | Sandboxing on by default in new Lair installs. Existing projects unchanged until they opt in. | Release notes document the change. |

### 6.2 Owner checklist (with undo steps)

#### Setup

```bash
# macOS
# 1. Create lair group
sudo dseditgroup -o create lair
#    Undo: sudo dseditgroup -o delete lair

# 2. Add yourself to the group (re-login required)
sudo dseditgroup -o edit -a $(whoami) -t user lair
#    Undo: sudo dseditgroup -o edit -d $(whoami) -t user lair

# 3. Create agent users
for agent in kiro-A kiro-B kiro-C; do
  sudo sysadminctl -addUser lair-$agent -shell /usr/bin/false -home /var/empty
  sudo dseditgroup -o edit -a lair-$agent -t user lair
done
#    Undo: sudo sysadminctl -deleteUser lair-kiro-A

# 4. Create sudoers drop-in
echo "$(whoami) ALL=(lair-*) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/lair-agents
sudo chmod 0440 /etc/sudoers.d/lair-agents
#    Undo: sudo rm /etc/sudoers.d/lair-agents

# 5. Fix data/ ownership
sudo chown -R $(whoami):lair /path/to/lair/data
sudo chmod 0750 /path/to/lair/data
sudo chmod 0600 /path/to/lair/data/owner.token
#    Undo: sudo chmod 0755 /path/to/lair/data

# 6. Fix worktree parent ownership
sudo chown :lair /path/to/worktrees
sudo chmod 2775 /path/to/worktrees
```

```bash
# Linux
# 1. Create lair group
sudo groupadd lair
#    Undo: sudo groupdel lair

# 2. Add yourself to the group
sudo usermod -aG lair $(whoami)
#    Undo: sudo gpasswd -d $(whoami) lair

# 3. Create agent users
for agent in kiro-A kiro-B kiro-C; do
  sudo adduser --system --no-create-home --shell /usr/sbin/nologin --ingroup lair lair-$agent
done
#    Undo: sudo deluser lair-kiro-A

# 4–6: same as macOS (paths may differ)
```

#### Configuration

In the project YAML:

```yaml
# Phase 2: one agent
dragons:
  kiro-A:
    sandbox: enabled

# Phase 3: all agents
sandbox:
  enabled: true
  # Optional: restrict network egress (macOS only, sandbox-exec)
  allow_network:
    - "api.anthropic.com"
    - "api.openai.com"
    - "github.com"
```

---

## 7. Acceptance tests

These tests **must fail on 7e90e73** (where no sandboxing exists) and **pass after the implementation**.

| Test | Command / assertion | Expected on 7e90e73 | Expected after |
|------|---------------------|---------------------|----------------|
| **AT-1:** Agent cannot read owner token | A sandboxed agent process calls `open("/abs/path/to/data/owner.token", O_RDONLY)` | Succeeds (returns fd) | Fails with `EACCES` |
| **AT-2:** Agent cannot read Lair store | A sandboxed agent calls `open("/abs/path/to/data/lair.db", O_RDONLY)` | Succeeds | Fails with `EACCES` |
| **AT-3:** Agent cannot read another agent's worktree | Agent `kiro-A` calls `open("/abs/path/to/worktrees/kiro-B/src/main.ts", O_RDONLY)` | Succeeds | Fails with `EACCES` |
| **AT-4:** Agent cannot write queue line as another agent | Agent `kiro-A` appends `- DONE other-task by kiro-B` to the queue file and Lair attributes it to `kiro-B` | Lair trusts the line | Lair rejects or attributes to `kiro-A` |
| **AT-5:** Agent can write its own log | A sandboxed agent appends to `agents_dir/<own-id>/run.log` | Succeeds | Succeeds |
| **AT-6:** Lair can read agent log | Lair calls `open("/abs/path/to/agents/kiro-A/run.log", O_RDONLY)` | Succeeds | Succeeds |
| **AT-7:** Per-run git token works | Agent clones/pushes using the token; token expires after the run | N/A (not implemented) | Clone succeeds; token invalid 1 hour later |
| **AT-8:** Observe mode logs access | With `sandbox.mode: observe`, agent reads `data/owner.token`; Lair logs the access | No log | Log entry with path and pid |
| **AT-9:** Spawn uses sudo | After enabling sandbox, `ps aux` shows agent process running as `lair-<id>` | Runs as `dev` | Runs as `lair-kiro-A` |
| **AT-10:** Agent tool sign-in decision | Agent `kiro-A` is not signed in; Lair raises a decision instead of starting | N/A (partially exists: `src/server/ai/tools.ts`) | Decision raised with fix command |

### How to verify AT-1 through AT-3 fail on 7e90e73

On the base commit, run a test agent (or a script) that attempts to `open()` the protected paths:

```bash
# In the test harness (before sandboxing is implemented)
node -e "require('fs').readFileSync('/path/to/data/owner.token')"
# → succeeds (file contents printed or returned)
```

After sandboxing:

```bash
sudo -u lair-kiro-A node -e "require('fs').readFileSync('/path/to/data/owner.token')"
# → Error: EACCES: permission denied
```

---

## 8. Open questions for the owner

1. **Should sandboxing be opt-in or opt-out per project?**

   *Recommendation:* Opt-in for existing projects (phase 3), opt-out for new projects in a future release (phase 4).
   Avoids breaking existing setups. The owner enables it when ready.

2. **Should network egress be restricted by default?**

   *Recommendation:* No, because agent CLIs need to call AI provider APIs. A project can enable egress filtering with
   `sandbox.allow_network` (allowlist). This adds complexity (sandbox-exec profiles or iptables rules per agent user)
   and is marked "optional" in the design.

3. **Should Lair auto-create agent users, or require the owner to run `lair sandbox setup`?**

   *Recommendation:* Require the owner to run `lair sandbox setup`. Creating system users needs `sudo`, which Lair
   shouldn't acquire silently. The setup command prints exactly what it will do and asks for confirmation.

4. **Should agents in observe mode be allowed to continue when they access protected paths?**

   *Recommendation:* Yes. Observe mode is for discovery, not enforcement. The log shows what would break if sandboxing
   were enforced, so the owner can fix it before enabling.

5. **How should Windows (WSL2) be handled?**

   *Recommendation:* WSL2 is Linux, so the Linux instructions apply. Native Windows is out of scope for this design;
   Lair's agent support on native Windows is not tested. Document this limitation.

6. **Should the fleet bus run as a separate user?**

   *Recommendation:* No. The bus is an MCP server started by the agent's MCP config (`npm run bus`). It writes to
   `data/<project>.db`, which is owned by the Lair user. The bus inherits the Lair user's permissions. Agents connect
   to it over stdio (the bus is started per agent, not shared).

---

## References

- **ROADMAP.md rule 2:** "Agents are the untrusted party."
- **ROADMAP.md B4:** "An agent cannot read the owner token, Lair's data or another agent's run environment."
- **src/server/human-auth/human-auth.ts:20-22:** Current limitation comment.
- **src/server/agents/probes.ts:26-42:** `BASE_ENV` and `agentEnvironment()`.
- **src/server/agents/service.ts:** Agent spawn logic.
- **docs/design/phase3-bus.md:** Fleet bus design.
- **docs/design/autonomy.md §6:** "Agents run as a separate OS user."
