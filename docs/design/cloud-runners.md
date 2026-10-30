# Cloud runners: machines that exist only while gates run, within a hard money limit

Goal: when the developer's machines are busy or too small, Lair runs gates on a cloud machine it starts on demand and
stops as soon as the work is done, and it never spends past the limit the human set. Everything is generic: a provider
interface with AWS EC2 first, any project, any gate system. This extends [runners.md](runners.md) (executor order,
budgets, one result format), the placement module (machines, lanes, slots) and [node.md](node.md) (running work on
another host). Status: step 1 built (provider, meter and guard, §11); the rest planned. A reference implementation
outside Lair (shell scripts beside a project's own gate queue) proved the design in October 2026; this document is what
Lair builds so no project needs those scripts.

## 0. Principles
1. **Off unless working.** The machine starts when a job needs it and stops when no job is queued or running. It also
   powers itself off when idle, so a dead Lair server never leaves it running.
2. **Never past the limit.** Two independent guards (§4) and the provider's own budget action stop spending before the
   limit. When Lair cannot tell what has been spent, it does not start the machine.
3. **A network blip is not a failed gate.** A job cut off by a lost connection is infrastructure: it runs again (§5.4),
   and is never reported as a code failure.
4. **Free first.** Free executors (CI free tiers, the project's own machines) take work first. A paid cloud machine
   takes the overflow (§7), unless the project says otherwise.
5. **Nothing reachable from outside.** The machine has no inbound ports. Lair reaches it over the project's private
   network (a tailnet or VPN) or through lair-node's outbound connection. Runtime credentials can only start, stop and
   describe the tagged machines and read costs.
6. **One result format.** A step that ran on a cloud machine produces the same `GateResult`, the same logs and the same
   test reports as a local run, so triage, review and merge policies do not change.

## 1. Where it fits
- **Pipelines (runners.md §1):** a new executor kind, `cloud`, in the configurable executor order. Default order: CI
  runners, own Lair machines, cloud, local.
- **External gate queues (placement):** a cloud machine is a placement machine with `cost` and `role: overflow`, and
  lanes with slots like any other machine.
- **Machines view:** cloud machines appear beside SSH machines and nodes, with state (stopped, starting, running,
  stopping), today's and this period's spend, and the guard's state.

## 2. Provider interface
One interface per provider (AWS EC2 first; GCP, Azure and Hetzner can follow without changing callers):
- `describe(machine)`: state, last launch time, last stop time (from the provider, not from Lair's memory).
- `start(machine)`, `stop(machine)`, `waitRunning(machine, timeout)`.
- `resize(machine, size)`: only while stopped.
- `quota(size)`: whether the account may run that size now. On AWS a new account allows few vCPUs. A refused start
  names the quota and raises a Decision Inbox item with the console steps to raise it.
- `spend(period)`: cost before credits and refunds since the period start, or "unknown" (a new AWS account has no
  Cost Explorer data for up to a day).
- `price(size)`: the hourly price, from configuration (rounded up) or the provider's price list.

Tests fake only this boundary (Lair rule: fake remote APIs, the clock and the process spawner).

## 3. Lifecycle
1. **Start on demand.** A job routed to a stopped machine starts it: guard (§4), `start`, `waitRunning`, then wait
   until the machine answers (ssh, or its lair-node connects). A start that fails twice sends the job to the next
   executor and marks the machine unavailable for a while (`cooldown_minutes`).
2. **Stop when idle.** When no job for that machine is queued or running for `idle_stop_seconds` (default 120), Lair
   stops it. A stop that fails, for example while the developer's network is down, is retried for a few minutes.
3. **Self power-off (backstop).** Setup (§8) installs a timer on the machine. Every minute it checks for running jobs
   (build tools, test JVMs, containers, open sessions from Lair) and an activity stamp every job step touches. After
   `self_poweroff_minutes` (default 3) with none of them, the machine powers itself off. The provider is told to stop,
   not terminate, on power-off.
4. **Resize** is a stop, resize, start. A size above the account's quota is refused with the quota Decision (§2).

## 4. The money guard
- **Spend** is the larger of two readings:
  1. the provider's cost reading (`spend`), cached for hours (each call may cost money; provider data lags);
  2. Lair's own meter: every run's launch and stop times from `describe` (so a stop by the backstop or in the console
     still counts, and an unknown stop time counts up to now), times the hourly price, plus storage for each month of
     the period, plus a starting amount for spend before the meter existed.
- **Refuse at the limit.** At `limit` or above, Lair does not start the machine; it records the trip, moves the
  machine's jobs to the next executor and raises a `spend` Decision. Only a human clears a trip, and only by an
  authenticated owner action: the owner session's `POST /api/cloud/trip/clear` (Clear the trip in the Machines view),
  recorded with the session and a note. Editing `budget.limit` or `budget.period` never clears it (decided in the
  review of step 1: the project file can be written by an agent or a bad merge, and live reload applies it at once).
- **The provider's own guard.** Setup creates a provider budget for the same limit with automatic actions: stop the
  machine and deny starts to the runtime credentials. If Lair is wrong or down, the provider still stops.
- **Credits.** For promotional credits the budget counts usage before credits over a custom period that covers the
  credits' validity, so it never resets while credits remain.
- **Alerts** at 80% (provider email and a Lair notification). Spend is shown in the Machines view and the daily digest.
- Raising the limit (new credits) is a human setting, changed in Lair and in the provider budget together.

## 5. Running work on the machine
### 5.1 Phase A: over SSH (no agent on the machine)
- **Code:** Lair pushes the gated commit and the base branch to a bare repository on the machine; the machine never
  holds forge credentials. Each job checks out into its own folder; a job that only scans (static analysis, hooks)
  uses a throwaway worktree, so it never touches a folder a build is using.
- **Steps:** the expensive steps run on the machine: builds and tests, container-based scanners, pre-commit hooks. Cheap
  steps that need the developer's checkout (commit message checks, secret scans of the local range) may stay local.
  The gate passes only when every step passes, wherever it ran.
- **Results:** test reports and logs come back into the job's local snapshot, so failure hints, triage and reviews
  read them as usual.
- **Cleanup:** leftover processes of a dropped run are stopped by their working directory, never machine-wide, so a
  parallel job is never touched.
### 5.2 Phase B: lair-node on the machine
lair-node ([node.md](node.md)) on the cloud machine replaces SSH: it connects out to the server, keeps running jobs
through network blips, streams logs and returns results. Phase A remains for machines where the node is not installed.
### 5.3 Toolchains
The machine needs the project's toolchain (for example a JDK, a container runtime, the language runtimes). Setup
detects it from the repository and the pipeline config (§8); a missing tool fails the setup check, not a gate.
### 5.4 Infrastructure failures
A remote step that loses its connection, or finds the machine not answering, prints a fixed infrastructure marker and
exits with the infrastructure code. Lair re-queues the job once on the same machine (a blip passes), then sends it to
the next executor. Keep-alive tolerance is minutes, not seconds: the remote work keeps running while the link is down.

## 6. Parallel slots
- A machine has `slots`: jobs it runs at once. Job classes come from the pipeline (`big` for full suites, `small` for
  targeted runs).
- **Memory rules:** `big_alone: true` (a big job runs with nothing beside it, for small machines) and `limits: { big: 1 }`
  (never two big jobs at once).
- **Test parallelism per class:** for example 4 test JVMs for a big job alone, 2 for a small job sharing the machine.
- Jobs are claimed under one lock, so two slots never both start work that breaks the rules. Only when no slot has a
  queued or running job does the machine stop.
- Each job has its own folder and its own ref in the machine's repository, so concurrent pushes and checkouts never
  collide (pushes of the shared base branch are retried).

## 7. Routing
- Per project, an ordered list with overflow rules: own free machines first, the cloud machine when a job already waits
  for them, the developer's machine when the cloud machine's own queue reaches `overflow_after` or the cloud is refused
  (guard, quota, unreachable).
- Placement learns each job type's duration per machine, so it can also prefer the cloud machine when it would finish a
  job much sooner and the project allows it (`prefer_when_faster`).
- Every routing decision and fallback is recorded on the job ("ran on cloud-1: the self-hosted runner had 2 waiting").

## 8. Setup (Settings, guided)
The account, credentials, network baseline, budget and its actions come from [cloud-accounts.md §1](cloud-accounts.md)
(a generated template the owner creates in their own console; no admin keys in Lair). Gate machines add:
1. **Machine:** a size recommended from the project's measured gate durations (a speed and price table per size,
   checked against the account's quotas), region, disk; stop (not terminate) on power-off.
2. **Reach:** the provider's control channel by default ([cloud-accounts.md §3](cloud-accounts.md)); a private network
   with SSH or lair-node otherwise.
3. **Toolchain:** the project's machine image ([cloud-accounts.md §4](cloud-accounts.md)), with the self power-off timer.
4. **Proof:** one targeted gate and one full suite on the machine; the results are compared with the same gates on the
   project's usual executor.

## 9. Configuration sketch
```yaml
cloud:
  machines:
    cloud-1:
      provider: aws-ec2
      region: us-east-1
      instance: { id: i-..., size: c7g.2xlarge, tag: { role: gate-server } }
      reach: { ssh_host: cloud-1 }          # phase A; phase B: node
      slots: 2
      big_alone: true
      limits: { big: 1 }
      test_parallelism: { big: 4, small: 2 }
      idle_stop_seconds: 120
      self_poweroff_minutes: 3
      price_per_hour: 0.35                  # rounded up; used by the meter
      storage_per_month: 6
  budget:
    limit: 100                              # provider budget acts at the same amount
    period: { start: 2027-01-01, end: 2027-12-31 }
    meter_start: 1
  routing:
    order: [self-hosted, cloud-1, local]
    overflow_after: { self-hosted: 1, cloud-1: 2 }
```

## 10. Security
- No inbound ports; no forge credentials on the machine; runtime credentials limited to the tagged machine and cost
  reads; setup credentials deleted after setup.
- The machine runs only commits Lair pushed, from the project's own repository. Public repositories never route to a
  machine that holds anything private (same rule as self-hosted runners, runners.md §0.5).
- Logs and reports that come back are treated as untrusted data, as with every executor.

## 11. Build order (one PR each, reviewed before the next)
1. **Provider + guard (built):** the provider interface, the AWS EC2 provider, the meter and the money guard; read-only
   state, spend and guard in the API and the Machines view. Configuration: `cloud.enabled` (off by default),
   `cloud.machines.<id>` with `provider: aws-ec2`, `region`, `profile`, `instance.id`, `instance.tag`, `price_per_hour`,
   `storage_per_month`, and `cloud.budget` with `limit`, `period`, `meter_start`, `spend_check_hours`, `warn_percent`.
   As built:
   - the provider (`src/server/cloud/provider.ts`) has `describe`, `start`, `stop` and `spend`; `waitRunning` and
     `quota` come with step 2, `resize` later, and `price` is `price_per_hour` from the configuration;
   - credentials come only from the named profile in the AWS config files (`fromIni`), never from the YAML, the
     server's environment or an instance role; a credential-shaped key or value in `cloud:` is a config error;
   - an instance is found by its id and its tag together, so a wrong id never reaches an untagged instance;
   - the provider's reading is Cost Explorer's unblended cost with credits and refunds left out, for the whole account,
     cached for `spend_check_hours` (24 at most) in `data/cloud.db` across restarts; `DataUnavailableException`, or an
     answer with no cost in it, is "unknown", which leaves the meter to decide only for a new account (two days from
     its first reading, before any amount, and for an answer with no cost only while nothing is metered), then counts
     as a failed reading (§12 "no data yet" bounded);
   - the meter records each launch the provider describes; a stop it does not date ends at the check that saw it
     stopped, and an open run ends at the next launch at the latest;
   - the guard refuses (fails closed) when a machine could not be described in the check, a cost reading failed, or the
     day is outside the period; a trip stands per project, whatever the limit or period says later, until the owner
     clears it with `POST /api/cloud/trip/clear` (owner session, naming the trip's time; recorded with the session id
     and a note, `cloud.trip_cleared`); `cloud.guard_tripped` is emitted once per trip;
   - `startMachine` runs the check on fresh readings before the provider's start, one at a time with checks and
     stops; nothing calls it yet (step 2 does); a stopped or replaced instance starts nothing, and the module exports
     no provider. Every route is the owner's (`/api/cloud` in `OWNER_ONLY_PREFIXES`): `GET /api/cloud/status`, and the
     trip's clear; none starts or stops a machine. Provider error text is kept with ARNs and account ids hidden.

   See docs/configuration.md Cloud machines.
2. **Lifecycle:** start on demand, idle stop with retries, the self power-off install, quota and spend Decisions.
3. **Phase A execution:** the `cloud` executor for pipelines (bare repository push, per-job folders, remote build and
   test steps, results back, infrastructure retry).
4. **Placement and routing (external phase, built):** cloud machines as placement machines with overflow rules for
   external gate queues. The external phase uses project commands (`state_cmd`, `guard_cmd`, `touch_cmd`) and the
   project's runner starts the machine when a job lands in its lane; Lair does not call the provider directly yet.
   Configuration: `placement.machines.<id>.on_demand` with `state_cmd`, `guard_cmd`, `boot_seconds`, `cost_per_hour`,
   `check_seconds`, `speed_factor`, `touch_cmd`, `touch_seconds`; `placement.routing.<lane>` with `overflow_to`,
   `prefer_when_faster`, `min_gain_seconds`. As built:
   - a stopped machine whose guard says ok is a target only through routing, and only for a real gain (boot time
     counted once): an overflow moves a job that waits, `prefer_when_faster` also one that would start now;
   - the guard runs again right before a move that starts the machine (a cached verdict may be `check_seconds` old);
   - a job queued in the machine's lane while its guard refuses or its state is unknown moves back to the lane that
     overflows to it;
   - while a job runs in its lanes, `touch_cmd` keeps the machine's idle timer from stopping it (act mode only: in
     observe mode or on a read-only project nothing keeps a paid machine on); a machine found stopped under a
     running job raises `placement.machine_stopped_under_job` once per job (at the next state check, up to
     `check_seconds` later), and the job moves back once when its runner queues it there again.

   See docs/configuration.md Placement.
5. **Slots and remote scans:** parallel slots with the memory rules; container scanners and hooks on the machine.
6. **Setup wizard** in Settings (§8).
7. **Phase B:** lair-node on cloud machines.

## 12. Acceptance tests
- A queued job starts a stopped machine, runs, and the machine is stopped within `idle_stop_seconds` after the queue
  empties; with the server killed mid-job, the machine powers itself off within `self_poweroff_minutes`.
- At the limit no start happens, the jobs move to the next executor and one `spend` Decision is raised; a provider spend
  reading of "unknown" with a meter under the limit still starts; a meter at the limit refuses even when the provider
  says less.
- A start refused for quota raises one quota Decision naming the size and the quota; the job runs elsewhere.
- A connection dropped mid-step re-queues the job once on the same machine, then elsewhere; no code failure is recorded.
- Two slots: a big job never runs beside another big job; with `big_alone`, beside nothing; leftover processes of one
  job's dropped run are stopped without touching the other job.
- A result from the cloud machine is byte-for-byte the same format as a local one (same parsers, same triage record).
