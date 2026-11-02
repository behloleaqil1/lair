# Project setup and configuration

- **Status:** Draft
- **Plan lines / issues:** C4 (#122), B2 (#113), GitHub issue #263
- **Owner questions:**
  1. Should the first multi-project cutover preserve existing task ids, or should each project get its own id namespace?
  2. For merge identity, should Lair support bot accounts (a GitHub App) alongside user tokens, or user tokens only for now?
  3. Should the tracker binding be mandatory for a project, or optional (some projects may not use issues or boards)?

## 1. Problem

Today Lair configures a project as a flat YAML file under `projects/`. Each project names one repository, one queue
file, one agents directory and one gates directory. There is no way to:

- configure VCS auth, CI signals or merge methods per repository (multi-repo projects are not supported);
- bind a project to its tracker (issues, milestones, boards);
- run multiple independent projects on one Lair instance with separate agent pools and budgets;
- configure environments and deploy targets from the UI.

An owner who wants to run Lair on their application and on Lair itself at the same time must pick one project per
Lair instance, or share agents and budgets in ways that are hard to reason about. A team with multiple repositories
in one product (a backend, a frontend and infrastructure) cannot configure them as one project with per-repo settings.

This design describes how an owner creates and configures a Lair project end to end—from VCS through agents and gates
to deploy targets—and how multiple projects run on one Lair with isolation.

## 2. Users and stories

- As an **owner**, I create a project from the UI by naming a repository and its VCS provider, so that Lair connects
  to it without my editing YAML.
- As an **owner**, I add a second repository to an existing project (a frontend alongside the backend), so that both
  share the same agents and gates but each has its own base branch and CI signal.
- As an **owner**, I configure which agents belong to a project and set a cap on how many may run at once, so that one
  project cannot starve another.
- As an **owner**, I bind the project to its GitHub Issues and Projects boards, so that the planner can create and
  close issues and move cards.
- As an **owner**, I configure preview, staging and production environments with their deploy targets, so that merges
  flow through the delivery pipeline.
- As an **owner**, I split one project into two (my app and Lair itself) without losing in-flight work, so that each
  has its own task list, agents and budgets.
- As an **owner**, I see the spec-first rule enforced: a feature task cannot start until its spec PR is approved.
- As an **admin** (future: teams), I grant a team member access to one project but not another.

## 3. Scope

### In

1. **VCS provider and auth (§4.1):** GitHub first, a generic interface for GitLab/Bitbucket/plain git later.
2. **Repositories per project (§4.2):** one or more, each with its base branch, CI signal (on/off/observe), merge
   identity and merge method.
3. **Tracker binding (§4.3):** issues, milestones, Projects boards per repository.
4. **Agents per project (§4.4):** agent assignment, caps (`max_active`), fallbacks, profiles.
5. **Gates and machines (§4.5):** lanes, machine assignment, cloud preference, the money guard.
6. **Environments and deploy targets (§4.6):** preview, staging, production; rollout strategies; health checks.
7. **Design docs and specs (§4.7):** the spec-first rule, where docs live, task-to-acceptance-test links.
8. **Multi-project on one Lair (§4.8):** separate task files, agent pools, budgets; safe cutover.

### Out (non-goals)

- **SSO and RBAC:** teams and scale are roadmap C11, after the core is stable. This design describes project-level
  isolation, not user roles within a project.
- **Self-hosted git servers:** plain git over SSH is in scope; GitLab self-hosted and Bitbucket Server are follow-ups.
- **Real-time issue sync:** the tracker binding is write-mostly (Lair creates, closes and moves issues); two-way sync
  is a follow-up.
- **Per-repository agents:** agents belong to a project, not to a repository within it. A task names its repository;
  the agent checks it out.

## 4. Design

### 4.1 VCS provider and auth

A **VCS provider** is a git host Lair knows how to authenticate against. Each provider has:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique id (`github`, `gitlab`, `bitbucket`, `git`) |
| `name` | string | Display name |
| `auth_method` | enum | `app` (GitHub/GitLab App), `token` (PAT or deploy key), `ssh` (key only, no API) |
| `api_base` | string | API endpoint (cloud default, overridable for self-hosted) |

**GitHub App** (recommended): the owner installs a GitHub App that Lair operates; the App has repository, issues and
pull-request permissions. The owner never handles tokens; Lair requests installation tokens as needed. The App's
webhook delivers push, issue and PR events. This is the merge identity for commits Lair makes.

**Token:** a fine-grained PAT with contents:write, issues:write, pull-requests:write, actions:read. Stored in the
secrets broker, never in config. The merge identity is the token's owner.

**SSH key only:** for plain git, no API. Read-only or write if the key has push access. No issue or PR integration.

**Where it lives:** `providers/<id>.yaml` in `data/` (not in `projects/`), or the project's `vcs.provider` block when
the provider is used by one project only. The provider's `auth:` never appears in project config; it is a reference.

**Routes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/vcs/providers` | owner | List configured providers |
| `POST` | `/api/vcs/providers` | owner | Add or update a provider (validated, credentials to secrets broker) |
| `DELETE` | `/api/vcs/providers/:id` | owner | Remove a provider (fails if projects use it) |
| `POST` | `/api/vcs/providers/:id/test` | owner | Test connection (clone a test repo, list repos, verify webhook) |

**Config key (project):**

```yaml
vcs:
  provider: github          # reference to a providers/*.yaml, or inline
  # inline form (single-project provider):
  provider:
    id: github
    api_base: https://api.github.com
    auth: app               # the secrets broker holds the App credentials
```

### 4.2 Repositories per project

A project has one or more **repositories**. Each repository:

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | `owner/repo` on the provider |
| `role` | enum | `primary` | `primary` (the main repo; one per project), `secondary`, `infra` |
| `base_branch` | string | `main` | The branch Lair treats as the default for merges and gates |
| `ci_signal` | enum | `on` | `on` (Lair gates), `off` (external CI, Lair observes), `observe` (Lair runs gates but doesn't block) |
| `merge_method` | enum | `squash` | `squash`, `merge`, `rebase` |
| `merge_identity` | string | (provider default) | Who commits the merge: `app` (the GitHub App), `token` (the token owner), or a named identity in `identities:` |
| `protected_paths` | array | `[]` | Glob patterns that require human review regardless of risk tier |

**Merge identity** can be a GitHub App (commits show as the App), a PAT owner, or a bot account. The `identities:`
block at project level defines named identities the owner may choose:

```yaml
identities:
  deploy-bot:
    provider: github
    auth: token             # references a secret in the broker
```

**CI signal:** with `on`, Lair's gate pipelines are the required check; the control plane merges only when the
pipeline passes at the head. With `off`, Lair reads the repository's own CI status (GitHub Actions or an external
system) and treats a green status as "gate passed"; it never starts its own pipelines. With `observe`, Lair runs its
pipelines but they do not block the merge: the PR can merge from the git host's own UI.

**Where it lives:** `project.yaml`:

```yaml
repositories:
  - name: example/backend
    role: primary
    base_branch: main
    ci_signal: on
    merge_method: squash
  - name: example/frontend
    role: secondary
    base_branch: main
    ci_signal: observe       # external CI for now
```

**Routes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/projects/:project/repositories` | owner | List repositories |
| `POST` | `/api/projects/:project/repositories` | owner | Add a repository (validates remote exists, sets up webhook) |
| `PUT` | `/api/projects/:project/repositories/:name` | owner | Update settings |
| `DELETE` | `/api/projects/:project/repositories/:name` | owner | Remove (fails if open tasks reference it) |

### 4.3 Tracker binding

A **tracker** is the issue and project-board system for a repository. For GitHub, it is GitHub Issues and Projects
(classic or new). For GitLab, it is GitLab Issues and Boards.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Whether the planner may create and close issues |
| `issue_labels` | object | `{}` | Labels Lair adds: `{ feature: "enhancement", bug: "bug", task: "task" }` |
| `milestone_pattern` | string | `null` | A regex to match milestone titles to phases in the plan |
| `board_id` | string | `null` | A Projects board id; the planner moves cards when tasks change state |
| `create_issues` | boolean | `true` | Whether Lair may create new issues |
| `close_issues` | boolean | `true` | Whether Lair may close issues when a task is done |

**Flow:**

1. The planner creates an issue for each task card that has no linked issue.
2. When a task's PR merges, the planner closes the issue (or moves it to Done on the board).
3. The planner comments on an issue when the task is blocked or waiting on the owner.

**Where it lives:** under each repository:

```yaml
repositories:
  - name: example/backend
    tracker:
      enabled: true
      create_issues: true
      close_issues: true
      board_id: PVT_kwDO...
```

**Routes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/projects/:project/repositories/:name/tracker` | owner | Tracker settings |
| `PUT` | `/api/projects/:project/repositories/:name/tracker` | owner | Update settings |
| `POST` | `/api/projects/:project/repositories/:name/tracker/test` | owner | Test: list issues, list boards |

### 4.4 Agents per project

Agents are assigned to a project. An agent may belong to only one project at a time. The project sets:

| Field | Type | Default | Description |
|---|---|---|---|
| `agents` | array | `[]` | Agent ids assigned to this project |
| `max_active` | number | (capacity-based) | At most this many agents may run at once for this project |
| `roles` | object | `{}` | Role assignments: `{ build: [agent-a, agent-b], review: { amber: [rev-1] } }` |

**Caps and budgets:**

- `max_active` is a hard cap. If 5 agents are assigned and `max_active` is 3, at most 3 run at once; the rest wait.
- Per-project budgets (tokens, cost) are in `agents.budgets` as today, scoped to the project.

**Failover:** when an agent's provider rate-limits, it fails over to the next profile in its role (§4.4 roles). If all
profiles are exhausted, the task waits; the project's other agents continue.

**Where it lives:**

```yaml
agents:
  agents: [kiro-A, kiro-B, kiro-C]
  max_active: 2
  roles:
    build: [kiro-A, kiro-B]
    review:
      amber: [kiro-C]
```

**Routes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/projects/:project/agents` | owner | List agents, their state and assignments |
| `PUT` | `/api/projects/:project/agents` | owner | Update agent list and caps |
| `POST` | `/api/projects/:project/agents/:id/move` | owner | Move an agent to this project (fails if it has an active run) |

### 4.5 Gates and machines

Gates are configured per project. A project may use a subset of the machines Lair knows about.

| Field | Type | Default | Description |
|---|---|---|---|
| `machines` | array | `[local]` | Machine ids this project may use |
| `lanes` | object | `{}` | Lane definitions: `{ heavy: { machines: [local], timeout: 3600 } }` |
| `cloud` | object | `null` | Cloud burst settings: `{ provider: aws, max_instances: 2, ... }` |
| `money_guard` | object | `{}` | Budget and alerts: `{ limit: 500, alert_thresholds: [50, 80, 100], hard_stop: true }` |

**Lanes:** a lane is a queue with machines that serve it. A gate job names a lane; the scheduler picks a machine.
Lanes are project-scoped: the same machine can serve different lanes for different projects.

**Cloud burst:** when local machines are saturated, Lair may start cloud instances (roadmap C7). The money guard
applies first.

**Where it lives:**

```yaml
gates:
  machines: [local, build-server]
  lanes:
    heavy:
      machines: [local, build-server]
      timeout: 3600
    light:
      machines: [local]
      timeout: 600
  money_guard:
    limit: 200
    alert_thresholds: [50, 80, 100]
    hard_stop: true
```

**Routes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/projects/:project/gates` | owner | Gate settings |
| `PUT` | `/api/projects/:project/gates` | owner | Update settings |

### 4.6 Environments and deploy targets

A project may have **environments**: `local`, `preview`, `staging`, `production`. Each environment has a **deploy
target** (how to run the application there).

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | `local`, `preview`, `staging`, `production` |
| `target` | enum | required | `compose`, `ecs`, `kubernetes`, `ssh` |
| `config` | object | `{}` | Target-specific settings (compose file path, ECS cluster, k8s namespace) |
| `strategy` | enum | `rolling` | `rolling`, `blue-green`, `canary` |
| `health_check` | object | `{}` | `{ endpoint: "/health", timeout: 30, interval: 10 }` |
| `auto_deploy` | boolean | `false` | Deploy automatically after a merge to the base branch |
| `budget` | object | `{}` | Per-environment spend limit and alerts |

**Flow:**

1. A merge to the base branch triggers a deploy to `local` (if configured).
2. A deploy to `staging` is manual or scheduled.
3. A deploy to `production` is a Decision Inbox item (`go_no_go`).

**Where it lives:**

```yaml
environments:
  - name: local
    target: compose
    config:
      file: docker-compose.yml
    auto_deploy: true
  - name: staging
    target: ecs
    config:
      cluster: staging-cluster
      service: app-service
    strategy: rolling
    health_check:
      endpoint: /health
      timeout: 30
    budget:
      limit: 200
      alert_thresholds: [80, 100]
```

**Routes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/projects/:project/environments` | owner | List environments |
| `POST` | `/api/projects/:project/environments` | owner | Add an environment |
| `PUT` | `/api/projects/:project/environments/:name` | owner | Update settings |
| `DELETE` | `/api/projects/:project/environments/:name` | owner | Remove (fails if active deploys) |
| `POST` | `/api/projects/:project/environments/:name/deploy` | owner | Trigger a deploy |

### 4.7 Design docs and specs

The spec-first rule: a feature task cannot start until its spec PR is approved.

| Field | Type | Default | Description |
|---|---|---|---|
| `specs_path` | string | `docs/design/` | Where spec documents live in the repository |
| `spec_required` | array | `[feature]` | Task types that require a spec before implementation |
| `spec_template` | string | `null` | Path to the spec template file |
| `acceptance_link` | boolean | `true` | Tasks must name their acceptance tests; the test integrity check verifies them |

**Flow:**

1. A feature request becomes a spec task.
2. The spec agent writes a document at `specs_path/<name>.md`.
3. A reviewer agent reviews the spec.
4. The owner approves the spec PR.
5. Only then may the planner create implementation tasks.

**Where it lives:**

```yaml
specs:
  specs_path: docs/design/
  spec_required: [feature]
  spec_template: docs/templates/spec.md
  acceptance_link: true
```

### 4.8 Multi-project on one Lair

Multiple projects run on one Lair instance with isolation.

**Isolation guarantees:**

- Each project has its own task file, queue file and agents directory.
- Agents belong to one project at a time.
- Budgets are per project; one project exhausting its budget does not affect another.
- The store (`data/lair.db`) holds all projects; rows are keyed by `project_id`.

**Safe cutover (splitting a project):**

1. The owner creates a new project from the Settings view.
2. The owner moves agents from the old project to the new one. A move waits until the agent is idle (no active run).
3. The owner assigns repositories to each project.
4. In-flight tasks stay with their original project until done.

**Restart adoption:** a restart must not orphan runs. Today, adoption matches a running process to a run by pid and
start time. With multi-project, adoption also checks that the run's project matches the agent's current project. A run
whose agent moved to a different project between start and restart is marked `lost_project_mismatch`; its task becomes
free in the original project.

**Where it lives:** each project is a file in `projects/`, as today. The store's `runs`, `tasks` and `events` tables
gain a `project_id` column.

**Routes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/projects` | owner | List all projects |
| `POST` | `/api/projects` | owner | Create a project |
| `DELETE` | `/api/projects/:id` | owner | Delete a project (fails if agents assigned or tasks open) |
| `POST` | `/api/projects/:id/agents/:agent/move` | owner | Move an agent here from another project |

## 5. Acceptance tests

1. **AT-1 `createProjectFromUi`:** Given no projects exist, when the owner opens Settings and clicks New project and
   enters a GitHub repository name and completes the flow, then a project file exists and the repository is connected.
2. **AT-2 `addSecondRepository`:** Given a project with one repository, when the owner adds a second repository with a
   different base branch, then both appear in the project's repositories list and each has its own base branch.
3. **AT-3 `agentCapEnforced`:** Given a project with 3 agents and `max_active: 2`, when 3 tasks are ready, then at most
   2 agents run at once and the third waits.
4. **AT-4 `trackerIssueCreated`:** Given a project with tracker enabled, when the planner creates a task, then an issue
   is created in the repository with the configured labels.
5. **AT-5 `specFirstBlocks`:** Given a project with `spec_required: [feature]`, when a feature task has no approved
   spec, then the planner does not create implementation tasks for it.
6. **AT-6 `multiProjectIsolation`:** Given two projects A and B with separate agent pools, when project A exhausts its
   budget, then project B's agents continue running.
7. **AT-7 `safeAgentMove`:** Given agent X running a task in project A, when the owner requests a move to project B,
   then the move waits until the run completes before reassigning.
8. **AT-8 `restartAdoptionProjectMismatch`:** Given agent X running in project A, when the agent is moved to project B
   and Lair restarts, then the run is marked lost and the task is freed in project A.
9. **AT-9 `ciSignalOff`:** Given a project with `ci_signal: off` on a repository, when a PR's external CI status turns
   green, then Lair treats the gate as passed without running its own pipelines.
10. **AT-10 `deployToStagingDecision`:** Given a project with a staging environment, when a deploy is triggered, then a
    Decision Inbox item of kind `go_no_go` is raised; approving it starts the deploy.

## 6. Rollout

1. **Phase 1 (observe):** The new config schema is accepted but the old flat schema continues to work. No behaviour
   change.
2. **Phase 2 (act):** New projects use the new schema. Existing projects migrate on first edit in Settings.
3. **Phase 3 (multi-project):** The `projects/` directory and store support multiple projects. A migration tool
   handles splitting.

**Switch:** `LAIR_PROJECT_SCHEMA=v2` (default `v1` in phase 1, `v2` in phase 2).

## 7. PR split

| PR | Scope | ATs covered | Lines (est.) |
|---|---|---|---|
| 1 | **VCS providers:** the providers store, routes, test-connection, the secrets broker integration | — | ~400 |
| 2 | **Repositories per project:** the `repositories:` block, webhook setup, base branch and CI signal | AT-2, AT-9 | ~350 |
| 3 | **Tracker binding:** the `tracker:` block, issue create/close, board moves | AT-4 | ~300 |
| 4 | **Agent caps:** the `agents:` block with `max_active`, the scheduler respects it | AT-3 | ~250 |
| 5 | **Gates config per project:** the `gates:` block with lanes and machines | — | ~300 |
| 6 | **Environments:** the `environments:` block, deploy routes, health checks | AT-10 | ~400 |
| 7 | **Spec-first rule:** the `specs:` block, the planner blocks tasks without a spec | AT-5 | ~200 |
| 8 | **Multi-project store:** `project_id` columns, migration, the projects list route | AT-6 | ~350 |
| 9 | **Safe agent move:** the move route, wait-until-idle logic | AT-7 | ~200 |
| 10 | **Restart adoption with project check:** the adoption code checks project, `lost_project_mismatch` | AT-8 | ~150 |
| 11 | **Settings UI: New project wizard:** the form, validation, completion | AT-1 | ~400 |

Total: ~3,300 lines across 11 PRs.

## 8. Open risks

1. **GitHub App quotas:** a project with many repositories may hit API rate limits. Mitigation: cache API calls,
   batch where possible, show the limit in the UI.
2. **Webhook reliability:** GitHub may drop or delay webhooks. Mitigation: a polling fallback for critical events
   (PR status, CI status).
3. **Multi-project data migration:** splitting a project with thousands of runs may take time. Mitigation: migrate
   incrementally, with a progress bar and the ability to cancel.
4. **Agent reassignment races:** moving an agent while it is starting a run could cause a mismatch. Mitigation: the
   move acquires the agent's lock before checking its state.

## References

- [configuration.md](../configuration.md) — current project config reference
- [autonomy.md](autonomy.md) — planner and agents modules
- [deploy-aws.md](deploy-aws.md) — cloud deployment
- [settings-v2.md](settings-v2.md) — Settings UI
- [ai-roles.md](ai-roles.md) — profiles and roles
- [platform.md](platform.md) — architecture and milestones
