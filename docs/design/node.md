# lair-node: the compiled host daemon

Goal: lair-node becomes a compiled binary so Lair can run everything on a host, autonomous and application agnostic,
so any application can be added and Lair manages its AI agent orchestration. This refines [platform.md](platform.md)
§1–2 and milestones M1/M3; where they differ, this file wins. Status: planned. Today only the experimental TypeScript
daemon in `src/node/` exists; the Go binary, `contract/` fixtures and the commands below are not built. Nothing in the
binary or this repo names a private project, machine, path or person (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).

## 1. Why a separate compiled binary, and why Go
- lair-server runs in a container. A container can't start or supervise processes on the host, and agent CLIs, gates
  and builds run on the host. lair-node is the only Lair component on the host: one per machine, server machine included.
- **Go, standard library only.** Many developers block Node/npm/Python on their hosts after supply-chain attacks
  (trojaned npm packages). A host daemon bundled from npm packages would bring that risk back. Go's standard library
  covers everything the node needs (HTTP, TLS, ed25519, os/exec, JSON), and Go builds static binaries for every OS
  from one machine.
- **Enforced, not promised:** `node/go.mod` has no `require` lines; a test runs `go list -m all` and fails if anything
  besides the main module appears. The build uses `CGO_ENABLED=0 GOTOOLCHAIN=local -trimpath -buildvcs=false` in a
  container whose Go image is pinned by digest. Two builds of the same commit must be byte-identical (tested).
- Targets: darwin/arm64, darwin/amd64, linux/amd64, linux/arm64 (WSL2 included), windows/amd64.
- The TypeScript `src/node/` stays as the reference and test double until the Go node passes the same contract tests;
  then it's deleted.

## 2. The protocol is a contract
- **Today:** the WebSocket messages the TypeScript daemon (`src/node/index.ts`) and the server
  (`src/server/nodes/node-manager.ts`) actually exchange are defined in `src/shared/server-types.ts`
  (`NodeToServerMessage`, `ServerToNodeMessage`, `NodeRegistration`, `NodeHeartbeat`, `JobAssignment`, `JobResult`).
  `src/shared/node-types.ts` holds the daemon's local types (`NodeConfig`, `NodeStatusOutput`, capacity and job-runner
  types) plus a richer message set that is not used on the wire. Messages carry no protocol version yet.
- **Planned:** one protocol file is the contract. Every message gets a JSON fixture in `contract/`, and both the
  server's tests and the Go tests decode and re-encode every fixture. Every message carries
  `protocol: <major>.<minor>`, and each side refuses an unknown major with a clear error.
- Transport: HTTPS + WebSocket with mutual TLS. Container to host uses `host.docker.internal` or the configured URL.

## 3. Commands
`lair-node join <server-url> <one-time-token>` · `run` (foreground) · `install` / `uninstall` · `status` · `version` ·
`update`.
- `install` registers the node as a **user-level** OS service: a LaunchAgent on macOS, `systemd --user` on Linux, and
  a per-user logon task on Windows. It never needs root or a password. On Linux, `install` enables lingering when
  allowed and otherwise says once what to run.
- `join` creates the node's ed25519 key, gets its certificate from the server, and stores both in the user's config
  directory with mode 0600.

## 4. Autonomy (no human, no AI judgment in the node)
- **Capacity, measured:** cores, total and free RAM, load, disk, OS, WSL or not, container runtime, sleep state, and
  which tools are on PATH (git, docker, java, any agent CLI an app declares). Sent with a heartbeat every 15 s. The
  node also learns each job type's measured CPU/RAM cost from its own history. The server's scheduler, not the node,
  decides how many jobs run.
- **Job kinds:**
  - `agent`: an agent CLI run through the app's adapter.
  - `check`: a gate, dev-check or test command.
  - `process`: a long-running service the node supervises, with exponential-backoff restarts. More than 5 restarts in
    an hour means `crashloop`: it reports and stops retrying until the next hour or a server command.
- **Hang vs wait:** a job is HUNG only when it AND every descendant use < 1% CPU and print nothing for the job type's
  limit (default 30 min). A job whose child is busy (a running test suite) is WAITING, never HUNG. On HUNG, the node
  applies the job's policy (report, kill, or kill and requeue), and the server reschedules.
- **Resilience:** jobs keep running when the server restarts. The node reconnects with backoff, buffers logs and
  results on disk (size-capped, rotated) and replays them in order. After sleep/wake it re-measures and re-heartbeats.
- **Results** are signed with the node key (feeds M2: an unsigned or partial result can never lead to a merge).
- **Self-update:** `update`, or an update the server announces, downloads the new binary and verifies its ed25519
  signature against the release keys pinned in the binary. It swaps atomically, health-checks for 60 s and rolls back
  automatically on failure.

## 5. Security
- The node runs as the user, never as root, and never calls sudo.
- Commands come only from the app pack's command templates, which the node loaded and pinned. The server sends a
  template name plus arguments, never a command line. Commands run as argv arrays, never through a shell, and user
  text is always one argument.
- Environment variables pass only through an allowlist, and working directories must be inside the app's declared
  roots. Secrets are never logged.
- The node never touches OS services it didn't create, except through `adopt` (§7) for the services the app pack
  names.

## 6. Application agnostic
The node knows nothing about any application. An **app pack** (the project config, see
[platform.md](platform.md)) declares:
- the app's roots, agents and adapters, checks, processes, and the services to adopt;
- capacity hints (optional);
- hang limits per job type.

The public repo ships a demo pack: a tiny app with stub agents and checks, so `lair install` + the demo shows
everything working on a fresh laptop. Private packs live in `projects/local/` (gitignored).

## 7. Adopting existing services (migration with no downtime)
`lair adopt` moves an app's existing launchd/systemd/Windows services that are named in its pack under lair-node:
1. **Shadow** (default 24 h): the node watches the service, starts nothing, and reports what it would have done.
2. **Cutover**, one service at a time, only while that service is idle (e.g. no job running on that lane):
   - disable the OS unit and start the same command under the node;
   - health-check for 5 min, and automatically re-enable the OS unit if the check fails.
3. Report per service: adopted / rolled back (with the reason).
- Services not named in the pack are never touched.

## 8. Acceptance tests (M1 + M3 for the node)
- Standard library only (`go list -m all`), and the build is reproducible.
- Every contract fixture round-trips on both sides.
- A fake agent that sleeps silently while its child burns CPU is WAITING, and a silent idle one is HUNG.
- A process that crashes 6 times in an hour is `crashloop`, with no further restarts.
- Kill the server mid-job: the job finishes, and its signed result arrives after the server returns.
- Run the node on Linux in a container with systemd: `install` → service up → `uninstall` → nothing left behind.
- Adopt a demo service: shadow → cutover → forced health failure → automatic rollback to the OS unit.
- A server request naming a command outside the pack is refused and logged.
- A tampered update binary is refused, and the old version keeps running.
