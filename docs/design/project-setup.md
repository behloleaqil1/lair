# Project setup and configuration

- **Status:** Draft (revised 2026-11-02 against main `fce21c4`, after review request-changes)
- **Plan lines / issues:** C4 (#122), B2 (#113), GitHub issue #263
- **Owner questions:** none remaining.
  - ~~Task id namespace on multi-project cutover~~ — Cut: multi-project PRs 8-10 are out of scope (see section 9).
  - ~~Merge identity (App vs token)~~ — Token only for now; GitHub App is out of scope (section 3).
  - ~~Tracker mandatory or optional~~ — Already answered on main: `tracker.enabled` defaults to `false`.

## 1. Problem

Today Lair configures a project as a flat YAML file under `projects/`. Each project names one repository (through
`github:` or `review.repo`), one queue file, one agents directory and one gates directory. There is no UI to:

- connect a repository (the owner must edit YAML and set `LAIR_GITHUB_TOKEN`);
- bind a project to its tracker board (issues, milestones);
- configure which agents belong to a project and set a cap on how many may run at once;
- configure environments and deploy targets from the UI.

This design describes how an owner creates and configures a Lair project end to end — from VCS through agents and gates
to environments — using the Settings UI, building on the wizard that already exists (`ProjectWizard.tsx`,
`POST /api/settings/projects`, `POST /api/settings/repo`).

## 2. What exists today

| Area | What exists (main `fce21c4`) | File / line |
|------|------------------------------|-------------|
| **Token** | `review.token_env` / `token_cmd`, else `LAIR_GITHUB_TOKEN`; Settings refuses secret values | `review/config.ts:451`, `configuration.md:3505` |
| **Repository list** | `repos:` (new in PR #266, pr-health.md §4.3), falls back to `tracker.repos[]` then `review.repo ?? github`; each entry has `repo`, `default`, `base`, `ci_counts`, `refs` | `configuration.md:3108-3116`, `tracker/config.ts:84-87` |
| **Tracker binding** | `tracker.enabled`, `tracker.mode`, `tracker.repos[].{repo, default, project.{owner,number}, status_field, status_options, agent_field, labels, match, milestones}`, `tracker.create_issues_for_new_tasks`, `tracker.close_removed_tasks`, `tracker.redact_patterns` | `configuration.md:3122-3217`, `tracker/config.ts:37-145` |
| **Agents** | `agents.enabled`, `agents.fill.{enabled, agents, max_active, tasks_file, prompt_files, ...}`, `agents.locks`, `agents.env_passthrough`, `agents.fallbacks` | `configuration.md:1663-1948`, `agents/config.ts` |
| **Roles** | `ai.roles.{build, review.{red, amber, green}, plan, supervise}` — ordered profile lists, failover along the role | `configuration.md:355-410` |
| **Gates** | `pipelines.<name>`, `executors.{order, github.*, local.*}`; GitHub and local executors | `configuration.md:500-700`, `pipelines/config.ts` |
| **Environments** | `delivery.environments.<name>` (local stack only), `compose:` services | `configuration.md:1243` |
| **Wizard** | `ProjectWizard.tsx`, `POST /api/settings/projects` (creates `projects/<name>.yaml`), `POST /api/settings/repo` | `src/client/settings/ProjectWizard.tsx`, `src/server/routes/settings.ts` |
| **Store** | `data/lair.db` has `nodes`, `tasks`, `jobs`, `events`, `agent_runs`; `data/agents.db` has `agents_runs`, `agents_claims`, `agents_events` | `store/migrations.ts:17-95`, `agents/store.ts:27-86` |
| **History** | Config edits are versioned in `data/config-history/<project>/` | Settings routes, `configuration.md:3402` |
| **Owner routes** | OWNER_ONLY_PREFIXES pattern | `cors.ts` (needs `{POST /api/vcs/test, POST /api/settings/wizard/steps/*}` added in this spec) |

## 3. Scope

### In

1. **Token check (§4.1):** a Settings step that tests the token's scopes before any repository is added.
2. **Repositories Settings page (§4.2):** a form over the shared `repos:` list (from PR #266); add, edit, remove; migration from `github:` to `repos[0]`.
3. **Tracker binding in Settings (§4.3):** a form over the existing `tracker.repos[].project.{owner,number}`, labels and milestones — no new keys.
4. **Agents Settings (§4.4):** a form over `agents.fill.{agents, max_active, prompt_files}` and `ai.roles` — existing keys only.
5. **Gates Settings (§4.5):** a form over `pipelines.<name>` and `executors` — existing keys only.
6. **Environments Settings (§4.6):** a form over `delivery.environments.<name>` — existing keys only (local compose first).
7. **Spec-first rule (§4.7):** extend the existing ready guard to block implementation PRs until a spec PR is approved.
8. **Extended wizard (§4.8):** additional steps in the existing wizard for the token check, repository, board, agents and modules.

### Out (non-goals for this spec)

- **GitHub App authentication:** a persistent GitHub App with webhook events and installation tokens. Requires a secrets
  broker that does not exist (`MemorySecretStore` is memory-only). This is a separate later spec.
- **Multi-project on one Lair:** Projects are already separate files with their own agents and budgets. PRs 8-10 of the
  original split (multi-project store, agent move, adoption check) are cut.
- **SSO and RBAC:** teams and scale are roadmap C11.
- **Self-hosted git servers / GitLab / Bitbucket:** plain GitHub first.
- **Real-time issue sync:** the tracker binding is write-mostly.
- **Per-repository agents:** agents belong to a project, not to a repository within it.

## 4. Design

### 4.1 Token check

**Purpose:** Before a repository can be added, verify that the configured token has the required scopes.

**What exists:** `GET /api/tracker/status` returns the token's scopes (`tracker/service.ts:234`). The tracker reads
scopes at start and raises a decision when one is missing.

**What this spec adds (new):**
- `GET /api/vcs/token-status` (owner-only): returns `{ok, scopes[], missing[], error?}`. Reads the token from
  `review.token_env`/`token_cmd` else `LAIR_GITHUB_TOKEN`. Required scopes: `repo` (or `public_repo` for public
  repositories), `read:project`, `project` for act mode.
- Settings → Repositories shows the scopes status at the top. A red badge appears when a scope is missing.
- The wizard's repository step checks the token first; it refuses to continue until the scopes are correct, with an
  error message naming each missing scope.

**Security:** `/api/vcs/token-status` is added to OWNER_ONLY_PREFIXES (`cors.ts:25-50`). No secret value is returned.

### 4.2 Repositories page (extends the shared `repos:` from PR #266)

**What exists (after PR #266 merges):** The project-level `repos:` list is read by PR health and the ready guard.
Fallback: `tracker.repos[]` → `review.repo ?? github`. Config keys are in `configuration.md:3108-3116`.

**What this spec adds (new):**
- Settings → Repositories page: a table of `repos:` entries with Add, Edit, Remove.
- Each row shows: `repo` (owner/name), `default` (badge), `base` branch, `ci_counts` toggle, `refs` chips.
- Add/Edit dialog: `repo` (text, validated against `^[A-Za-z0-9-]{1,39}/[A-Za-z0-9_.-]{1,100}$`), `default` (checkbox,
  only one may be checked), `base` (text, default: blank → host's default), `ci_counts` (checkbox), `refs` (chip
  input, ≤8, pattern `^[A-Za-z][A-Za-z0-9_.-]{0,39}$`).
- Validation: duplicate `repo` refused (HTTP 409); duplicate `ref` across entries refused; refs `pr` and `pull`
  refused.
- `github:` migration: on first edit in Settings, if `repos:` is absent but `github:` or `review.repo` is set, offer
  to migrate: add `repos: [{repo: <that value>, default: true}]` and keep `github:` (the tracker fallback still reads
  it).

**Routes (new):**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/settings/repos` | owner | List `repos:` entries |
| `POST` | `/api/settings/repos` | owner | Add an entry (body: the entry fields); returns 409 on duplicate |
| `PUT` | `/api/settings/repos/:index` | owner | Update an entry at index |
| `DELETE` | `/api/settings/repos/:index` | owner | Remove an entry (fails if open tasks reference only this repo) |
| `POST` | `/api/settings/repos/migrate-github` | owner | Create `repos:` from `github:` / `review.repo` |

### 4.3 Tracker binding (existing keys, new UI only)

**What exists:** `tracker.repos[].{project.{owner,number}, status_field, status_options, labels, match, milestones}`
(`configuration.md:3197-3206`). `tracker.create_issues_for_new_tasks` (`configuration.md:3176`). The tracker is off
unless `tracker.enabled: true`, and starts in observe mode.

**What this spec adds (new):**
- Settings → Repositories → each row has a "Board" section that edits:
  - `tracker.repos[i].project.owner` (text)
  - `tracker.repos[i].project.number` (number)
  - `tracker.repos[i].labels` (chip input)
  - `tracker.repos[i].milestones.rules` (table: task globs → milestone title)
- The form validates that the board exists: `GET /api/tracker/test-board` (existing) with `{owner, number}`.
- `tracker.enabled` and `tracker.mode` are in Settings → Modules → Tracker.

**No new config keys.** The tracker already has everything; this spec wires the Settings UI to them.

### 4.4 Agents Settings (existing keys, new UI only)

**What exists:**
- `agents.enabled` — master switch (`configuration.md:1663`)
- `agents.fill.{enabled, agents, max_active, tasks_file, prompt_files}` (`configuration.md:1860-1893`)
- `ai.roles.{build, review.{red,amber,green}, plan, supervise}` (`configuration.md:355-410`)
- `agents.fallbacks.<agent>` — profile failover order

**What this spec adds (new):**
- Settings → Agents page:
  - **Agents list:** `agents.fill.agents` as a checklist of available dragons (from `dragons:` entries).
  - **Max active:** `agents.fill.max_active` number input.
  - **Roles:** a table for `ai.roles`, each row is a role name and an ordered list of profiles. Drag-to-reorder.
  - **Prompt files:** `agents.fill.prompt_files` as a list (path patterns).
- The form validates that each named agent exists in `dragons:`.

**No new config keys.** These keys already drive the agents module.

### 4.5 Gates Settings (existing keys, new UI only)

**What exists:**
- `pipelines.<name>` with `steps`, `timeout_minutes`, `lanes` (`configuration.md:503-520`)
- `executors.{order, github.*, local.*}` (`configuration.md:525-570`)
- `executors.github.monthly_minutes` budget

**What this spec adds (new):**
- Settings → Gates page:
  - **Pipelines table:** list `pipelines:` keys (e.g. `gate`), with Edit to show steps.
  - **Executors:** `executors.order` as a sortable list (`github`, `local`), with each executor's key settings.
  - **GitHub settings:** `github.repo`, `github.workflow`, `github.monthly_minutes`, `github.self_hosted_labels`.
  - **Local settings:** `local.max_parallel`, `local.min_free_ram_mb`, `local.max_load_per_core`.
- Validation: a pipeline with zero steps is refused; an unknown executor in `order` is refused.

**No new config keys.** The gates block already exists.

### 4.6 Environments Settings (existing key `delivery.environments`, new routes)

**What exists:** `delivery.environments.<name>` with `compose:` services, Down/Up in Delivery view, `data/delivery.db`
for held services (`configuration.md:1243`).

**What this spec adds (new):**
- Settings → Environments page:
  - **Environments table:** list `delivery.environments` keys (e.g. `local`).
  - **Add environment:** name (text), `target: compose` (only compose for now), `config.file` (path to
    `docker-compose.yml`).
  - **Edit:** the compose file path, `auto_deploy` (boolean, whether a merge triggers deploy).
  - **Health check:** `health_check.{endpoint, timeout, interval}` for the environment.
- Future targets (`ecs`, `kubernetes`, `ssh`) are out of scope; the UI shows "compose" as the only option.

**Routes (new):**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/settings/environments` | owner | List environments |
| `POST` | `/api/settings/environments` | owner | Add an environment |
| `PUT` | `/api/settings/environments/:name` | owner | Update settings |
| `DELETE` | `/api/settings/environments/:name` | owner | Remove (fails if active deploys) |

### 4.7 Spec-first rule (extends existing ready guard)

**What exists:**
- The ready guard (`ready-guard/guard.ts`) evaluates `evaluateReady(report, source, {agent, ciCounts})` and produces
  refusal items.
- `review.enabled` and the review module track findings and verdicts.
- The test-integrity check (`review/test-integrity.ts`) verifies acceptance tests are named.

**What this spec adds (new):**
- New config key `specs.required_for: [feature]` (array of task-type globs). Default: `[]` (off).
- New config key `specs.path: "docs/design/"` (where spec docs live). Default: `docs/design/`.
- The ready guard checks: if a task's type matches `required_for` and no merged PR under `specs.path` references the
  task or its parent feature, add a refusal item `spec_not_approved`.
- The refusal text: "A spec for `<task>` must be approved before implementation PRs can merge."
- The review module's test-integrity check cites `specs.required_for` tasks when checking acceptance tests.

### 4.8 Extended wizard (extends existing `ProjectWizard.tsx`)

**What exists:** `ProjectWizard.tsx` with steps for project name, `POST /api/settings/projects` creates the file,
`POST /api/settings/repo` sets the repository.

**What this spec adds (new):**
- **Step 1 (new): Token check.** Calls `GET /api/vcs/token-status`. If scopes are missing, shows an error with the
  env var name (`LAIR_GITHUB_TOKEN` or `review.token_env`) and the missing scopes. The user must fix the token
  externally and click "Check again".
- **Step 2 (existing): Project name.** No change.
- **Step 3 (new): Repository.** Text input for `owner/name`, validated. On submit, calls
  `POST /api/settings/repos` to add `repos: [{repo, default: true}]`.
- **Step 4 (new): Board (optional).** Text inputs for `tracker.repos[0].project.{owner, number}`. On submit, updates
  the tracker block. Skip button if no board.
- **Step 5 (new): Agents.** Checkbox list of `dragons:` entries to add to `agents.fill.agents`. Number input for
  `agents.fill.max_active`. Skip if no dragons.
- **Step 6 (new): Modules.** Checkboxes for `tracker.enabled`, `review.enabled`, `agents.fill.enabled` (each starts
  observe or off). Brief explanation of each.
- **Completion:** shows the created project file path and links to Settings.

**Routes (new):**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/settings/wizard/steps/token` | owner | Validate token scopes, return `{ok, missing[]}` |
| `POST` | `/api/settings/wizard/steps/repo` | owner | Add repository to `repos:` |
| `POST` | `/api/settings/wizard/steps/board` | owner | Set tracker board for the repository |
| `POST` | `/api/settings/wizard/steps/agents` | owner | Set `agents.fill.agents` and `max_active` |
| `POST` | `/api/settings/wizard/steps/modules` | owner | Set `tracker.enabled`, `review.enabled`, `agents.fill.enabled` |

All wizard routes are added to OWNER_ONLY_PREFIXES.

## 5. Security and privacy

- **Owner-only routes:** All routes in §4.1-4.8 are in OWNER_ONLY_PREFIXES (`cors.ts:25-50`). A signed-out viewer or
  a non-owner gets 403.
- **Audit:** Every Settings edit is recorded in `data/config-history/<project>/`, as today. The wizard's steps use the
  same path.
- **Redaction:** The tracker's `redact_patterns` apply to any text written to issues or boards. No new redaction
  config.
- **No secrets in responses:** `/api/vcs/token-status` returns scope names, not the token value. Settings refuses to
  store or return secret values (`configuration.md:3505`).
- **Test route bounds:** The wizard's token-check step is the only `/api/vcs/*` route; it is bounded (one call per
  wizard flow, no polling). The existing `/api/tracker/test-board` is already bounded.

## 6. Acceptance tests

### AT-1 `createProjectFromWizard`
**Setup:** No projects exist. `LAIR_GITHUB_TOKEN` is set with `repo` and `project` scopes. A test repository
`test-owner/test-repo` exists (mocked host).
**Action:** Open Settings → New project. Complete all wizard steps: token check passes, enter repository name, skip
board, select one agent, enable tracker in observe mode.
**Expected:** A file `projects/test-repo.yaml` exists with `repos: [{repo: "test-owner/test-repo", default: true}]`,
`tracker.enabled: true`, `tracker.mode: observe`, `agents.fill.agents: [<selected>]`.

### AT-2 `addSecondRepository`
**Setup:** A project with `repos: [{repo: "test-owner/app", default: true}]`.
**Action:** Settings → Repositories → Add → enter `test-owner/lib`, uncheck default, set refs: `[lib]`.
**Expected:** `repos:` now has two entries. `parsePrRefs("lib#42", repos, {mode:"report"})` returns
`{repo: "test-owner/lib", number: 42}`.

### AT-3 `duplicateRepositoryRefused`
**Setup:** A project with `repos: [{repo: "test-owner/app"}]`.
**Action:** Settings → Repositories → Add → enter `test-owner/app`.
**Expected:** HTTP 409 with error `"repository already listed"`. The `repos:` list is unchanged.

### AT-4 `agentCapEnforced`
**Setup:** A project with `agents.fill.agents: [agent-a, agent-b, agent-c]`, `agents.fill.max_active: 2`. Three tasks
are ready.
**Action:** Fill runs a tick.
**Expected:** At most 2 agents have running runs. The third task's line shows `held: capacity`.

### AT-5 `trackerIssueCreated`
**Setup:** A project with `tracker.enabled: true`, `tracker.mode: act`,
`tracker.repos: [{repo: "test-owner/app", labels: ["lair"]}]`, `tracker.create_issues_for_new_tasks: true`.
A task line `agent-a|Agent A|task-1|Build feature X` exists.
**Action:** Tracker reconciles.
**Expected:** The mocked GitHub API received `POST /repos/test-owner/app/issues` with `labels: ["lair"]`. The task has
`issueNumber` in the tracker store.

### AT-6 `specFirstBlocks`
**Setup:** A project with `specs.required_for: ["feature-*"]`, `specs.path: "docs/design/"`. A task line with id
`feature-search-1`. No merged PR under `docs/design/` references `feature-search`.
**Action:** An agent reports `READY feature-search-1 PR #42 at abc1234`.
**Expected:** The ready guard returns `refused: true` with item `spec_not_approved`. The PR does not merge.

### AT-7 `specApprovedAllows`
**Setup:** Same as AT-6, but a merged PR `docs/design/search.md` exists that references `feature-search` (e.g. in its
body or filename).
**Action:** An agent reports `READY feature-search-1 PR #42 at abc1234`.
**Expected:** The ready guard does not include `spec_not_approved`. (Other items like CI may still apply.)

### AT-8 `tokenScopesMissing`
**Setup:** `LAIR_GITHUB_TOKEN` is set but the mocked token endpoint returns scopes `["public_repo"]` (missing
`project`).
**Action:** Open the wizard, reach the token-check step.
**Expected:** The step shows an error: "Missing scopes: project". The Continue button is disabled.

### AT-9 `staleHashRefused`
**Setup:** A project with `repos: [{repo: "test-owner/app", default: true}]`. The config file's hash is `abc123`.
**Action:** A second client edits the same file (hash becomes `def456`). The first client submits
`PUT /api/settings/repos/0` with the old hash.
**Expected:** HTTP 409 with error `"config changed; refresh and retry"`.

### AT-10 `environmentAddedAndDeployed`
**Setup:** A project with no `delivery.environments`.
**Action:** Settings → Environments → Add → name `local`, target `compose`, file `docker-compose.yml`.
Then Delivery → `local` → Up.
**Expected:** `delivery.environments.local` exists in config. The environment starts (mocked compose).

## 7. Rollout

1. **PR 1 (after #266 merges): Repositories page.** Settings form over `repos:`, the `github:` migration, the token
   check route. ATs: AT-1, AT-2, AT-3, AT-8, AT-9.
2. **PR 2: Wizard steps.** Extend `ProjectWizard.tsx` with the new steps. ATs: AT-1, AT-8.
3. **PR 3: Agents Settings.** Form over `agents.fill.*` and `ai.roles`. AT: AT-4.
4. **PR 4: Tracker Settings.** Form over `tracker.repos[].project.*`. AT: AT-5.
5. **PR 5: Gates Settings.** Form over `pipelines` and `executors`. No new AT (existing gates tests cover).
6. **PR 6: Environments Settings.** Form over `delivery.environments`. AT: AT-10.
7. **PR 7: Spec-first rule.** Config keys `specs.required_for` and `specs.path`, ready guard extension. ATs: AT-6,
   AT-7.

Total: ~2,400 lines across 7 PRs (reduced from original 11 by cutting multi-project PRs 8-10 and merging VCS provider
into PR 1).

## 8. Open risks

1. **Token scope check latency:** The token endpoint may be slow. Mitigation: cache the scopes result for 5 minutes;
   show a spinner.
2. **Stale config races:** Two browser tabs editing the same project. Mitigation: the config hash in every PUT; 409 on
   mismatch.
3. **Tracker API rate limits:** Many repositories with many issues. Mitigation: the tracker already has
   `write_budget_per_minute` and rate-limit handling.

## 9. Review finding map

| Finding | Section | Commit |
|---------|---------|--------|
| Must 1: third `repositories:` list | §2, §4.2: use `repos:` from PR #266 | (this revision) |
| Must 2: re-invented tracker keys | §4.3: form over existing `tracker.repos[]` keys | (this revision) |
| Must 3: secrets broker | §3 Out: App is out of scope; §4.1: token_env/cmd only | (this revision) |
| Must 4: phantom keys/routes | §2 "What exists today" table; every new key/route tagged "new" | (this revision) |
| Must 5: untestable ATs | §6: each AT has setup, action, expected; added AT-3, AT-8, AT-9 | (this revision) |
| Should: security section | §5: OWNER_ONLY, audit, redaction, no secrets | (this revision) |
| Should: existing wizard | §4.8: extends `ProjectWizard.tsx` | (this revision) |
| Should: owner question 3 | §header: answered on main (`tracker.enabled: false`) | (this revision) |
| Low: acceptance_link | §4.7: test-integrity check cites spec-first tasks | (this revision) |

## References

- [configuration.md](../configuration.md) — current project config reference
- [pr-health.md](pr-health.md) — the shared `repos:` list (PR #266)
- [tracker.md](tracker.md) — tracker design
- [autonomy.md](autonomy.md) — planner and agents modules
