# Lair platform spec (v1): open-source AI agent orchestration, from laptop to fleet

Goal: automatic and scalable to whatever machines are available, with nothing manual; agnostic and open source, to
manage AI agent orchestration, development and deployment on any machine.

Status: planned direction. Parts exist in experimental form (the scheduler, the store, the event bus, gate pipelines
and signatures, the policy evaluator, budgets, self-healing and the TypeScript lair-node); most of what follows is not
built. This note consolidates the phase notes ([phase4-fleet.md](phase4-fleet.md),
[phase5-deploy.md](phase5-deploy.md)) and supersedes them where they conflict; their details (adapters, bus,
deployment) remain valid inside it. No private details: every project-specific value comes from configuration (see
[CONTRIBUTING.md](../../CONTRIBUTING.md)).

## 0. Principles (every design decision is checked against these)
1. **Nothing manual after install.** `lair install` sets up everything on a machine (services, sandboxes, node
   registration); every recurring operation (scaling, restarts, recovery, cleanup) is automatic. Humans approve
   decisions, they never perform chores.
2. **Guarantees come from architecture, not instructions.** An agent physically cannot merge, deploy, change tooling or
   policy, read secrets, or fake a result, because it runs in a sandbox without those capabilities. Prompts and rules
   improve quality; isolation and policy-as-code guarantee safety.
3. **Agnostic at every layer.** Any AI coding agent (adapters), any OS (macOS, Linux, Windows/WSL), any machine
   (laptop, workstation, server, cloud VM), any git host (GitHub, GitLab, Bitbucket, plain git), any stack (gate
   pipelines are configuration), any deploy target.
4. **Evidence over claims.** Nothing an agent says is trusted; status comes from events the control plane observes or
   from results signed by a node.
5. **Scales down and up.** One laptop with one agent must be as easy as 1,000 nodes with 10,000 agents. Local-first and
   self-hosted; no hosted service is required.
6. **Deterministic core, AI at the edges.** Scheduling, scaling, recovery, policy and merging are code. LLM agents do
   the creative and judgment work: building, reviewing, diagnosing, writing tasks.

## 1. Architecture
```
            ┌──────────────── control plane: lair-server ─────────────────┐
  UI/CLI ──▶│ API · scheduler · policy engine · workflow engine · event bus │──▶ git host / deploy targets
  owner     │ store (SQLite → Postgres) · secrets broker · signer verifier │    (only the control plane holds
            └───────────────▲──────────────────────────────▲───────────────┘     merge/deploy credentials)
                            │ mTLS                          │ mTLS
                  ┌─────────┴────────┐            ┌─────────┴────────┐
                  │ lair-node (host) │    ...     │ lair-node (remote)│   one per machine, auto-registered
                  │ sandboxes: agent │            │ sandboxes: gates  │   reports capacity, runs jobs,
                  │ runs, gate jobs  │            │ dev-checks, deps  │   signs results with its node key
                  └──────────────────┘            └──────────────────┘
```
- **lair-server**: the brain. API (REST + WebSocket), web UI, scheduler, workflow engine, policy engine, event bus,
  store (SQLite by default; Postgres for teams and HA), secrets broker, git-host and deploy adapters.
- **lair-node**: a small daemon on every machine (the server's machine included). It registers with the server,
  reports capacity, runs agent sandboxes and gate/dev-check jobs, streams logs and events, and signs every job result
  with a per-node key the server issued at registration.
- **lair CLI**: `lair install | init | node join | up | status | logs | task | approve`. The UI can do everything the
  CLI does.
- **Agents** never talk to the git host, the deploy targets or the filesystem outside their sandbox directly. They talk
  to the control plane through the MCP fleet tools ([phase3-bus.md](phase3-bus.md)) and a git proxy.

## 2. Install, nodes and machines (zero manual steps)
- `lair install` (macOS/Linux/Windows): installs lair-server and/or lair-node as OS services (launchd, systemd,
  Windows Service, through per-OS service adapters), checks or installs a container runtime (Docker, Podman, or Colima on macOS)
  with the user's consent once, creates the node key, and opens the UI.
- **Adding machines:** from the UI, "Add machine" takes SSH access once; Lair installs lair-node there over SSH,
  registers it, and never needs the SSH password again (it uses the node's mTLS identity). Alternatively
  `lair node join <one-time-token>` on the machine. Cloud: optional providers create and destroy VMs on demand.
- **Capacity model, measured not configured:** each node reports cores, RAM, disk, GPU, load, container runtime,
  network, and the measured cost of each job type (memory and CPU per agent run, per gate type, per dev-check), learned
  from its own history. Users may set caps; the defaults are computed.
- **Health:** heartbeats; a node that misses them is drained; its jobs are rescheduled elsewhere; when it returns it is
  re-admitted automatically. Platform differences (WSL, no `uptime`, sleep) are the node's problem, never the user's.

## 3. Scheduler and autoscaling (the orchestrator, as code)
- The scheduler continuously matches **ready work** (tasks, gate jobs, dev-checks, reviews, deploys) to **capacity**:
  free resources per node, per-job measured cost, priority, dependencies, data locality (the node that has the repo),
  and budgets.
- **Budgets and limits:** model-provider rate limits and tokens or cost per hour/day per provider, project and user;
  the scheduler never exceeds them and spreads work across providers and adapters when allowed.
- **Autoscaling:** number of concurrent agents per node = what its capacity and the budgets allow, recomputed every
  few seconds; queue pressure raises it, load or budget lowers it; scale to zero when idle; optional cloud bursting.
  There is no fixed dragon cap anywhere.
- **Self-healing playbooks (automatic, logged):** silent agent → stop and resume its session; stuck gate → mark
  stuck, requeue on another node; node down → drain and reschedule; repeated identical failures → stop retrying,
  open a diagnosis task for a reviewer agent, notify the owner only if that fails; duplicate claims impossible by
  construction (atomic claims in the store).
- **The LLM orchestrator** (the orchestrator agent's role today) becomes an advisor the scheduler calls for judgment: writing task briefs
  from specs, diagnosing failures from logs, choosing reviewers, splitting big work. It cannot bypass the scheduler.

## 4. Agent sandboxes (why the rules hold without anyone locking anything)
- Every agent run is a sandbox: a container by default (rootless where available), a microVM optionally, or "process
  mode" with a loud warning on machines without containers (trusted single-user only).
- The sandbox gets: its task's git worktree (read-write), read-only project docs it is allowed to read, the adapter's
  CLI and model credentials injected by the secrets broker for that run only, CPU/RAM limits, and network egress only to
  the model provider and the control plane (git goes through the control plane's git proxy, which allows pushing only
  to the task's branch).
- It does NOT get: the git host token, merge or admin rights, deploy credentials, other worktrees, the tooling,
  policies or queue files, the host filesystem, or the ability to start other agents except by asking the API.
- **Prompt-injection safety:** content from repos, issues and web pages is data; an agent that is talked into
  misbehaving still cannot act outside its sandbox's capabilities.

## 5. Workflow engine (how work flows, for any project)
- **Task graph** per feature: spec → (design + review + owner approval for high-risk tiers) → test-author writes failing
  acceptance tests → builder makes them pass (protected tests) → dev-check → gate → review (distinct agent, and a
  different model for high-risk tiers) → policy check → merge → deploy to staging → verify → promote.
- **One owner per task**, atomic claims, dependencies and stacked branches, automatic chunking of tasks above a size
  threshold, priorities, deadlines.
- **Templates per task type** (feature, fix, review, design, test-author, migration, refactor) are versioned; the
  workflow fills them; their performance is measured (§8).

## 6. Verification: dev-checks and gates
- **Gate pipelines are configuration** (per project, per path): steps (static checks, unit, integration, E2E,
  security scans, revert checks), how to compute the affected scope, timeouts, resources, which node capabilities they
  need. Stack-agnostic: commands run in pinned container images.
- **Dev-checks**: the fast scoped subset agents run before a gate (target under 5 minutes), scheduled like any job.
- **Gates** run on nodes in clean sandboxes at an exact commit; results are **signed by the node**; the server only
  accepts a result whose signature, commit, pipeline version and full step list check out. A log that is not a real run
  (a shell error, missing steps) is a failed run, never a pass.
- **Nightly**: full pipelines on the default branch; a red night opens a fix task automatically.

## 7. Policy engine and merging (only the control plane merges)
- **Policy as code** per project: risk tiers by path patterns; required gates at the exact head; required reviews
  (count, distinct agents, distinct models, human for tier X); PR size limits; protected tests; migration ordering
  rules; merge windows; who may approve what.
- The control plane alone holds merge rights (a git-host App or token stored in the secrets broker). It merges only
  when the policy evaluates true, and records why. Optional: it posts a required status check from its App so the git
  host itself refuses merges that bypass Lair.
- **Reverts are automatic** when the post-merge gate or the nightly proves a merge broke the default branch (policy
  configurable), with a fix task for the author.

## 8. Quality at scale (measured and self-improving)
- Scorecards per agent, model, adapter, template and task type: first-time pass rate, fix rounds, review findings,
  reverts, time to merge, cost per merged PR.
- The scheduler routes high-risk work to the best performers and feeds weak ones smaller tasks; A/B tests templates
  and models; retires what underperforms.
- **Incidents** (automatic records with root cause and the guard added) feed back into policies, templates and
  playbooks.

## 9. Communication and observability
- Internal event bus; WebSocket to the UI (no polling); MCP fleet tools for agents (claim, report, inbox, ask);
  structured events only; text-file mirrors only as an optional legacy adapter.
- One UI for everything: fleet, nodes, capacity, budgets, tasks, gates (live step output), PRs and policy verdicts,
  deployments, incidents, costs, audit log; live log streaming; search; troubleshooting views.
- The owner talks to the system in natural language from the UI (the manager agent), and every action it takes goes
  through the same API and policies as everything else.

## 10. Repositories, projects and deployment
- **Projects:** `lair init` or "New project" in the UI: create or connect a repo on any git host, choose a template,
  describe the product; Lair drafts a spec and plan for approval, then runs the workflow (kickstart, see [phase5-deploy.md](phase5-deploy.md)).
- **Deployment:** environments (dev, staging, prod), targets (SSH machines with Docker or systemd, Kubernetes, PaaS
  adapters), strategies (rolling, blue-green, canary), health checks, automatic rollback, secrets from the broker or
  external vaults; promotion is a policy-gated workflow step.

## 11. Security model
- Threats designed for: a misbehaving or prompt-injected agent; a compromised node; leaked logs. Mitigations: sandboxes,
  least privilege, short-lived scoped credentials, signed results, mTLS between server and nodes, secrets never written
  to logs or sandboxes beyond their run, full audit log, RBAC, rate limits.
- Supply chain: pinned container images by digest, SBOM for releases, signed releases.
- Safe defaults: read-only until the owner enables controls; high-risk tiers need a human the first time a project is
  set up.

## 12. Scale, teams and distribution
- Single user: one binary or `npx`, SQLite, zero config. Team: Postgres, RBAC, SSO, quotas, many projects. Large org:
  multiple lair-server replicas behind a load balancer, thousands of nodes, sharded scheduling; nodes keep running
  their jobs if the server restarts.
- Packages: npm, Docker image, Homebrew, Linux packages, Windows installer; config schema versioned with migrations.
- **Plugin SDK:** agent adapters, gate step types, deploy targets, git hosts, cloud providers, notification channels.
- Open-source readiness: docs site, examples, a demo project, opt-in telemetry only, MIT license, CONTRIBUTING,
  governance and security-report policy.

## 13. Migration from existing setups
Lair takes over one function at a time, each behind a feature flag, without stopping the running fleet: (1) observe
(today); (2) nodes and capacity (replace hand-written runners); (3) gates with signed results (replace the shell gate
runner); (4) policy engine and control-plane merging (replace merge scripts); (5) sandboxed agents with the scheduler
(replace the launcher and the tick orchestrator); (6) deployment. An importer reads existing agent lists, queues and
gate configs.

## 14. Milestones (each: tests first, dev-checks, docs, a demo; no milestone ships without its acceptance tests)
- **M1 Core:** lair-server + lair-node on one machine, store, event bus, WebSocket UI, capacity measurement, scheduler
  with autoscaling, container sandboxes, Kiro + Claude Code + Aider adapters, MCP fleet tools. Acceptance: on one
  laptop, 20 queued tasks run with agents scaled automatically to the measured capacity, with no manual step; an agent
  cannot read the git token or write outside its worktree (tested).
- **M2 Verification and policy:** gate pipelines as config, dev-checks, signed results, policy engine, control-plane
  merge, automatic revert. Gates and other heavy jobs run on the repository's CI runners first (GitHub Actions
  first), then the project's Lair machines, and on the developer's machine last ([runners.md](runners.md)).
  Acceptance: a fake or partial gate log can never lead to a merge (tested).
- **M3 Fleet:** add machines over SSH from the UI, auto-install of lair-node, scheduling across nodes, self-healing
  playbooks, budgets. Acceptance: unplugging a node mid-run reschedules its work with no human action.
- **M4 Delivery:** environments, deploy targets, strategies, rollback.
- **M5 Projects:** git-host integrations, templates, kickstart from a description.
- **M6 Teams and scale:** Postgres, RBAC, SSO, HA, quotas.
- **M7 Public release:** packaging, docs, examples, security review, launch.
