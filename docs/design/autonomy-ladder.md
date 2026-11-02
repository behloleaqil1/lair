# The autonomy ladder: from observe to act, per module

- **Status:** design (spec only, no code). Owner questions: none (the choices are made in §9 and can be revisited in
  review).
- **Base:** main `d2b3d8e`.
- **Issue:** #323.
- **Related:** [autonomy.md](autonomy.md) (principles 3 and 4: evidence for every automatic action, reversible by
  default), [decision-policies.md](decision-policies.md) §5 (shadow, suggest, act and the promotion bars for decision
  rules, which this design reuses and does not restate), [ai-spend.md](ai-spend.md) §4.5 (the guards' rollout rule),
  [planner.md](planner.md), [pr-health.md](pr-health.md), [work-store.md](work-store.md) §6, [phase3-bus.md](phase3-bus.md).

Lair has grown many modules that ship in `observe` and have an `act` mode. Each says, in its own design, "flip to act
once observe shows it would have been right". None of them says how that is measured, where the owner sees it, how
the flip is made and recorded, or what flips it back. This spec adds one thin module, `autonomy`, that:

1. **Records evidence** the same way for every module: each time a module in observe reaches a verdict (a *would*),
   and later what really happened (the *did*), in one durable store.
2. **Judges readiness** per module (and per unit inside a module: one spend guard, one decision class) against bars
   in config: enough days, enough samples, agreement over a bar, zero unsafe disagreements.
3. **Flips** a ready unit to act only on the owner's click, through the existing settings save path, with the
   evidence it was flipped on kept next to the change.
4. **Rolls back** a unit in act to observe when the same evidence, still collected in act, falls under the bar or
   shows one unsafe disagreement.
5. **Shows** all of it in one "Ready to act" view.

The `autonomy` module itself ships `enabled: false`, and in `observe` when enabled: it records and shows, and its
rollbacks are only proposed (§4.6).

## 1. Why: what main shows today

- **At least 14 switches** follow the `off | observe | act` pattern on main (§2), each shipped in observe, and each
  module's design defers the flip to "after enough evidence" without a number: ai-spend.md §4.5 says "after a week of
  observe evidence shows its would-verdicts would have been right", work-store.md §6 says mirror mode "lets a
  project observe the new system before retiring file-based tools", and planner.md §"observe" only says every
  accepted proposal waits for the owner.
- **Half the evidence is lost on a restart.** The bus consumers keep their would-vs-did comparison in memory only
  (`src/server/bus/consumers.ts:478`, capped at `MAX_OBSERVED` = 500, `:248`), the work store compares with fill's view only at its
  last check (`src/server/work/manager.ts:86`), and PR health computes what act would do live and records nothing
  (`src/server/pr-health/service.ts:27`, by design: "observe mode writes nothing"). The internal event bus keeps the
  last 1000 events in memory (`src/server/core/event-bus.ts:15`). A week of evidence can't be read back from any of
  them.
- **"Would" is counted, "right" is not.** The spend report counts `guard_would` and `guard_did` per guard
  (`src/server/agents/spend-report.ts:243-249`), but nothing checks whether a would-park was right (the task did not
  later complete unattended), which is the rule ai-spend.md §4.5 sets.
- **Gut feel would flip wrong.** decision-policies.md §5 measured Lair's own recommended option against the owner's
  answers: 62% agreement overall, 44% for planner proposals. A flip made on impression, without a number, would have
  put a 44%-right proposer in charge.
- **No rollback rule exists** except decision-policies' demotion (designed, not built: the policy table accepts only
  `off | shadow`, `docs/configuration.md` Decision policies). A module flipped to act stays in act until someone
  notices and edits the YAML by hand.
- **No record links a flip to its evidence.** A flip is a YAML edit (settings history keeps the diff), with nothing
  saying what the evidence was when it was made.

## 2. What exists today (checked against main at `d2b3d8e`)

### 2.1 The switches and what observe records

| Module (unit) | Switch, default | What observe records | Durable? | Existing comparison |
|---|---|---|---|---|
| Planner | `planner.mode: observe \| act`, `observe` (`src/server/planner/config.ts:167`); `verifier.auto_apply` / `auto_reject` need act (`config.ts:153-156`) | Each deterministic change as `planned`, once (`src/server/planner/service.ts:625-633`); every proposal waits for the owner | Yes: `planner_changes`, `planner_proposals` (`src/server/planner/store.ts:54,73`) | Verifier vs owner, last 7 days (`store.ts:673`, `GET /api/planner/verifier-agreement`, `src/server/planner/routes.ts:115`) |
| PR health | `pr_health.mode: observe \| act`, `observe` (`src/server/pr-health/config.ts:32`); act needs `notify_cmd` (`config.ts:133`) | `pr_health.finding` / `pr_health.cleared` events (`src/server/pr-health/service.ts:225,241`); the plan act would run, live (`src/server/pr-health/plan.ts`, `types.ts:77`) | No (events in memory; plan recomputed) | None |
| Bus consumers | `bus.consume: off \| observe \| on`, `off` (`src/server/bus/config.ts:20-27`) | Per mirrored line: the report's reading next to the patterns' reading, `match` (`src/server/bus/consumers.ts:478-479`) | No (in memory, capped) | `health().observations` total, matches, mismatches (`consumers.ts:344-361`) |
| Work store | `work_store.mode: off \| observe`, `off` (`src/server/work/config.ts:14-17`); `on` not built yet (work-store.md §6, "work store 3") | The store next to fill's view at fill's last check (`src/server/work/manager.ts:86-93`) | No (last check only) | `agree`, `ignored`, `disagree[]` in `GET /api/work/status` |
| Spend guards (9 units) | Each guard's mode, `off` or `observe` by default, the keys listed in `GUARD_KEYS` (`src/server/agents/spend-report.ts:41-51`) | One `guard_would` event per verdict (`src/server/agents/service.ts:2622`, `:2940`; `src/server/agents/budgets.ts:194-200`); act writes `guard_did` (`service.ts:2660`) | Yes (agents store events) | Counts only (`spend-report.ts:243-249`) |
| Decision rules (per class) | Policy `state: off \| shadow` in the policy table; `decision_policies.enabled` in `data/server.yaml` (`src/server/decisions/policies/config.ts:7,23`) | One `policy_trace` row per decision, proposer and table version | Yes (`data/decisions.db`) | `policyAgreement()` with unsafe disagreements (`src/server/decisions/store.ts:633-656`), `GET /api/owner/decision-policies` (`src/server/decisions/policies/index.ts:144`) |

Other modules with the same switch (watchdog, triage and its re-checks, placement, host services, infrastructure
monitor, cleanup, tracker, plan apply) are listed in `docs/configuration.md`. They are not in this spec's first set
(§3, Out); the source interface (§4.3) is how each joins later.

### 2.2 What the flip and rollback would reuse

| Piece | Where | Used for |
|---|---|---|
| Settings save with a base hash, validation, command confirmation, history and live reload | `PUT /api/settings/projects/:id` (`src/server/settings/routes.ts:87`), `SaveRequest.baseHash` / `changes[]` (`src/shared/settings-types.ts:193-198`), history and restore (`routes.ts:111-119`) | Writing the one mode key of a flip or a rollback |
| Owner-only route prefix | `/api/owner` in `OWNER_ONLY_PREFIXES` (`src/server/human-auth/cors.ts:25-26`) | Every route of this module |
| Notices and decisions with a dedupe key | the Decision Inbox (`src/server/decisions/`), as the guards use it (`budgets.ts:200`) | `rollback_due` and `rolled_back` notices |
| Act-once ledger | `src/server/core/act-ledger.ts` | Not reused: a flip is a settings save, idempotent by itself (§4.5) |

`git grep -n -iE "autonomy|ladder|ready to act" -- src` finds only references to autonomy.md in comments; there is no
readiness module, store, route or view.

## 3. Gaps and scope

- **In:**
  - G1, one durable evidence store for would-vs-did samples, written by the `autonomy` module from events, for the
    six modules in §2.1;
  - G2, an outcome check per module that turns a would into agreed, disagreed or unsafe;
  - G3, a readiness verdict per unit with config bars;
  - G4, an owner-only flip that writes the mode key through the settings save path and records its evidence;
  - G5, a rollback trigger in act, observe-first;
  - G6, the "Ready to act" view.
- **Out (non-goals):**
  - Changing any module's act behaviour. The ladder reads and flips switches; it never adds an action to a module.
  - Building a mode a module doesn't have yet (work store `on`, decision rule `suggest` / `act`). The ladder shows
    readiness for it and refuses the flip with the name of the change that adds the mode (§4.5); those modes are
    built by their own designs.
  - The other modules in §2.1's last paragraph: each joins by implementing the source interface (§4.3) in its own PR,
    after this one proves the shape.
  - Flipping up automatically. Promotion is always the owner's click (§4.5); only the safe direction (act to
    observe) can be automatic.

## 4. Design

### 4.1 Units and states

A **unit** is the smallest thing that flips: a module (`planner`, `pr_health`, `bus_consumers`, `work_store`), one
spend guard (`spend_guards/<guard id>`, the ids of `GUARD_KEYS`), or one decision class (`decision_rules/<class>`).
Each unit has a state per project, derived on every read from its config and its evidence, never stored:

| State | When |
|---|---|
| `off` | The unit's switch is `off`, or the module is disabled |
| `collecting` | In observe; fewer than `min_days` since evidence started, or fewer than `min_samples` resolved samples |
| `not_ready` | In observe with enough evidence, and agreement under the bar, or at least one unsafe disagreement, or unresolved samples over `max_unresolved` |
| `ready` | In observe; every bar met (§4.4) |
| `blocked` | Ready, but a precondition fails: the target mode isn't built, `read_only: true`, a key act needs is missing (`notify_cmd`), or a re-flip cooldown runs (§4.6) |
| `acting` | In act; the last `rollback.last_n` resolved samples meet the bar |
| `rollback_due` | In act; a rollback trigger holds (§4.6) |

### 4.2 Evidence: samples

A **sample** is one input on which a unit reached a verdict: what act would do (`would`) and, once known, what really
happened (`did`). In act, `would` is what the unit did, and `did` is still the outcome; so the same check runs
before and after the flip.

Store: `data/autonomy.db` (SQLite, as the other module stores), schema version 1:

```sql
CREATE TABLE samples (
  project TEXT NOT NULL,
  unit TEXT NOT NULL,              -- "planner", "spend_guards/quota", "decision_rules/agents.provider_limit"
  key TEXT NOT NULL,               -- the source's own id for the input (below); unique per unit
  mode TEXT NOT NULL,              -- observe | act: the unit's mode when the verdict was reached
  version TEXT NOT NULL,           -- the evidence version (below)
  at INTEGER NOT NULL,             -- verdict time, ms
  would TEXT NOT NULL,             -- a short verdict code, e.g. "park", "note", "done", "apply:finish"
  outcome TEXT,                    -- null until resolved: agreed | disagreed | unsafe | unresolved
  did TEXT,                        -- what happened, a short code
  resolved_at INTEGER,
  due_at INTEGER NOT NULL,         -- at + the unit's outcome window: after it, an open sample is unresolved
  refs TEXT NOT NULL,              -- JSON, at most 1 KB: ids only (task id, run id, PR number, head sha, decision id)
  PRIMARY KEY (project, unit, key)
);
CREATE INDEX samples_open ON samples(project, outcome, due_at);
CREATE INDEX samples_window ON samples(project, unit, version, at);
CREATE TABLE flips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL, unit TEXT NOT NULL,
  from_mode TEXT NOT NULL, to_mode TEXT NOT NULL,
  by TEXT NOT NULL,                -- "owner" or "autonomy" (an automatic rollback)
  reason TEXT NOT NULL,            -- "ready", "owner", or the rollback trigger code
  evidence TEXT NOT NULL,          -- JSON: the readiness view of the unit at the flip (counts, ratios, window)
  config_hash_before TEXT NOT NULL, config_hash_after TEXT,
  at INTEGER NOT NULL,
  idem TEXT NOT NULL UNIQUE        -- project|unit|to_mode|config_hash_before: a repeat is the same flip
);
```

- **Writing is idempotent.** A sample is written with `INSERT OR IGNORE` on its key; an outcome only moves a sample from
  null to a value, once (`UPDATE ... WHERE outcome IS NULL`). A repeated event, a replay after a restart, or two
  sources seeing the same input write one row.
- **The evidence version** is a hash of the config keys that change the unit's verdict (for a guard, its block; for
  the bus consumers, the project's patterns; for decision rules, the policy table version the trace already keeps).
  A change starts a new window: samples of another version are kept for the view's history but never counted.
  Only switching the mode itself does not change the version.
- **Retention:** samples older than `retention_days` (90) are pruned at each sweep, flips never.
- **What is never stored:** task text, plan text, PR titles, command lines, log lines, tokens. `refs` holds ids only;
  the view links to the module that owns the detail.

### 4.3 Sources: one per module

A source is a small object a module registers with `autonomy` (through the module registry, autonomy.md §0 principle
5). It turns the module's events into samples and resolves outcomes by reading the module's store, read-only:

```ts
interface EvidenceSource {
  unit(project): UnitInfo[];                      // units, their mode, version, preconditions, target mode
  onEvent(event): Sample[];                       // the samples an event starts (pure; no I/O)
  resolve(project, open: Sample[]): Outcome[];    // outcomes known now; bounded batch; no network
}
```

The `autonomy` module, not the source, writes the store. A module in observe still writes nothing of its own: its
events are what it already emits, plus the events §4.3.1 adds where evidence is kept only in memory today.

#### 4.3.1 The per-module evidence (the core of this spec)

| Unit | A sample is | `would` | `did`, and when it resolves | Agreed | Unsafe | Window (`outcome_hours`) |
|---|---|---|---|---|---|---|
| `planner` | each proposal op the verifier judged whose op is in `auto_apply` or `auto_reject`, and each deterministic change recorded `planned` | `apply:<op>` / `reject:<op>` / the planned change | the owner's decision on the proposal (`planner_proposals.status`, `decided_by` owner), or for a planned change: the tasks file reached the same content (the owner made the edit) or the owner declined it | same direction | would apply `finish` or `unblock` and the owner declined (it would have closed or released work wrongly) | 72 h |
| `pr_health` | each planned note or `no_owner` notice, per (repo, PR, head, kinds) (`deliveryId`, `plan.ts:35`) | `note:<owner>` / `notice:no_owner` | the finding still stood after `settle_minutes` (no `pr_health.cleared` for it), and then the PR got a new head or was closed within the window | the finding stood and the PR moved | the note's owner changed for the same head before the window ended (a note would have gone to the wrong person) | 48 h |
| `bus_consumers` | each mirrored line read in observe | the report's reading (kind, task, agent) | the patterns' reading of the same line, at once | equal | a mismatch on a `DONE` or `BLOCKED` kind (one reading closes or blocks a task, the other doesn't) | 0 (immediate) |
| `work_store` | each task compared at a fill check (`WorkComparison`), at most one sample per task and stored-state change | the store's state | fill's state for the task at that check | equal; `ignored` lines are not samples | the store says done or dropped while fill says ready or running, or the store says ready while fill says done (work stopped or started twice) | 0 (immediate) |
| `spend_guards/quota` | each `guard_would` / `guard_did` with verdict `would_cool` | cool until `<reset>` | the provider's next start before the reset: limited again (agreed) or worked (disagreed) | limited again | n/a (a cool-down only delays starts) | until the reset time, at most 24 h |
| `spend_guards/task_no_result_cap`, `hung_repeat` | each `would_park` | park the task | an accepted `DONE` for the task within the window without an owner action after the would-park point (disagreed), or none (agreed) | no unattended completion | the task completed unattended and its chain held a gate or PR in progress (parking would have dropped finished work) | 72 h |
| `spend_guards/wake_events` | each `would_wake` and each timer wake | wake on event | whether the woken check found work to start | the event wake found work, or the timer wake found none | n/a | 1 h |
| `spend_guards/budget` | each `would_block` | hold new runs | the owner raised the limit or answered "run anyway" within the window (disagreed), or not (agreed) | limit kept | n/a (the token and cost limits always block today) | 24 h |
| `spend_guards/planner_*` (4) | each `would_skip` / `would_apply` | skip the run / apply the still-valid proposals | the run that started anyway: it applied or proposed nothing (agreed for a skip); the owner applied those proposals (agreed for an apply) | as said | a `would_skip` whose run applied a `finish` or `unblock` | 24 h |
| `decision_rules/<class>` | each `policy_trace` row with an option (abstentions count only for coverage) | the proposed option | the answer given | equal | the proposal was `irreversible` or `outward` and the answer was not it (`store.ts:649`) | until the decision is answered or expires |

New events (appended to the `EventType` union, `src/shared/server-types.ts`), the only module changes this design
asks for, each emitted only when the module is in observe or act and `autonomy.enabled` is true:

- `bus.consume_observed` `{project, line_key, report: {kind, task, agent}, file: {kind, task, agent}, match}` from
  `consumers.ts:478`, once per line key (the same key that dedupes the map today);
- `work.compared` `{project, fill_checked_at, rows: [{task, fill, store}]}` with at most 500 rows (the rest counted in
  `truncated`), from the work manager's comparison;
- `pr_health.planned` `{project, id, repo, pr, head, kinds, owner | null}` from the plan, once per delivery id (the
  same id act's ledger uses, so observe and act samples share a key).

Everything else (`planner.changed`, proposal decisions, `guard_would`, `guard_did`, the policy trace) is read from
the modules' existing events and stores.

### 4.4 Readiness

Computed per unit over the samples of the current evidence version in the last `window_days`:

- `days` = days since the first counted sample (at most `window_days`); `resolved` = agreed + disagreed + unsafe;
  `agreement` = agreed / resolved; `unresolved_share` = unresolved / (resolved + unresolved).
- **Ready** when all hold: `days >= min_days`; `resolved >= min_samples`; `agreement >= agreement` bar; `unsafe = 0`;
  `unresolved_share <= max_unresolved`; and the last `last_n` resolved samples alone also meet the agreement bar (so a
  recent drift isn't hidden by an old good streak).
- **Decision rules** keep their own bars (decision-policies.md §5: 30 comparisons, 95% for rules, 90% for models,
  coverage 60%, zero unsafe). The ladder reads `policyAgreement()` and applies those numbers; it does not add its
  own. A class's `min_days` still applies.
- **Fail closed:** a source that throws, a store that can't be read, or a unit whose version can't be computed
  shows `not_ready` with the reason, never `ready`.

### 4.5 The flip (observe to act): owner only

1. The view shows **Switch to act** on a `ready` unit only, with the evidence beside it: days, samples, agreement,
   the last disagreements (at most 5, as links), and the exact key and value that will change.
2. The owner confirms. The client sends `POST /api/owner/autonomy/flip`
   `{project, unit, to: "act", configHash}` where `configHash` is the project file hash the view was built on.
3. The server, in order, refusing with a reason at the first failure (nothing is written):
   - `autonomy.mode` is `act` (in `observe` the button is shown disabled with "set autonomy.mode: act to flip from
     here"; the owner can still edit the YAML, and the flip is then recorded by the reload hook below);
   - the unit is `ready` **now**, recomputed, not the view's copy (409 `not_ready` otherwise);
   - the preconditions hold: the target mode is accepted by the module's schema (work store `on` and decision rule
     `suggest`/`act` are refused with "not built yet: see work-store.md §6 / decision-policies.md §5"), the project
     isn't `read_only`, and the keys act needs are set (PR health's `notify_cmd`);
   - the file's hash equals `configHash` (409 `conflict`, nothing written).
4. It writes the one key through the settings service's save (`changes[]` with `baseHash`), so validation, history
   and live reload are the same as an edit in Settings. Decision rules write the class's `state` in
   `data/policies.yaml` with the same known-hash, atomic rename pattern, and need the restart that file needs today.
5. It records the flip row with the evidence snapshot, and emits `autonomy.flipped`.

- **Idempotent:** the flip's `idem` key is project, unit, target and the hash before. A repeated request (a double
  click, a retried request) finds the row and returns it without a second save. A unit already in act returns 200
  with `already: true`.
- **A flip made outside the ladder** (a hand edit of the YAML, a settings save) is noticed by the config reload: the
  module records a flip row `by: "owner"`, `reason: "manual"`, with the evidence as it stood, so the history is
  complete either way. A manual flip of a unit that wasn't ready shows a warning badge in the view; it is never
  reverted for that alone.
- **Never automatic upward.** No code path flips a unit to act except this owner-only route; a test asserts that the
  rollback sweep can only write `observe`.

### 4.6 Rollback (act to observe)

In act the source keeps producing samples (§4.2), so the same evidence runs after the flip. A unit is `rollback_due`
when any trigger holds:

| Trigger code | Holds when |
|---|---|
| `unsafe` | one unsafe sample in act (`rollback.on_unsafe: true`) |
| `agreement` | the last `rollback.last_n` resolved samples in act fall under the unit's agreement bar |
| `act_error` | the module reports its act path broken: an unreadable act ledger (`act-ledger.ts`, its `error`), or act refused for a precondition that held at the flip (`notify_cmd` removed) |
| `owner` | the owner clicks **Back to observe** (always available, in either `autonomy.mode`) |

- With `autonomy.mode: observe` (the default), a due rollback raises **one** notice per unit and trigger
  (dedupe key `autonomy:<project>:<unit>:rollback_due`) with the evidence and a **Back to observe** action; nothing
  is changed by itself. It is withdrawn when the trigger stops holding.
- With `autonomy.mode: act`, the sweep writes the unit's key back to `observe` through the same save path, records a
  flip row (`by: "autonomy"`, the trigger code), emits `autonomy.rolled_back`, and raises one notice saying what it
  did and why. On a hash conflict it re-reads the file once and retries the one-key change; a second conflict leaves
  the notice and retries at the next sweep (bounded by `sweep_seconds`, no tight loop). A unit already in observe is
  not written again.
- After any rollback, the unit can't be flipped up again for `rollback.reflip_cooldown_days` (3), and its evidence
  window starts again at the rollback time.
- Rollback is the safe direction for every unit in §2.1: observe keeps today's behaviour (the bus and the work store go
  back to the file patterns; PR health stops sending; guards stop parking). That is why it is the one direction that
  may be automatic.

### 4.7 The "Ready to act" view

Health → **Autonomy** (and a count on Home: "N units ready to act, M rollbacks due").

- One table per project, a row per unit: module, unit, mode, state badge (`collecting`, `not_ready`, `ready`,
  `blocked`, `acting`, `rollback_due`), days observed / `min_days`, resolved samples / `min_samples`, agreement
  against the bar, unsafe count, unresolved share, the reason when not ready or blocked, and the action
  (**Switch to act**, **Back to observe**, or none).
- Expanding a row shows the last disagreements and unsafe samples (verdict, outcome, links built from `refs` to the
  owning view: the PR page, the task, the decision, the run) and the flip history of the unit.
- Sort: `rollback_due`, then `ready`, then `not_ready`, then `collecting`, `acting`, `off`.
- With `autonomy.enabled: false` the view says how to enable it, like the other optional views (`src/client/nav.ts`).

### 4.8 Routes

All under `/api/owner/autonomy` (owner session; the `/api/owner` prefix is owner-only and gets no CORS,
`cors.ts:26`). Every query takes `project` and reads only that project's rows.

| Method, path | Request | Response | Errors |
|---|---|---|---|
| `GET /api/owner/autonomy/status?project=` | | `{enabled, mode, configHash, units: UnitView[]}` | 400 bad project, 404 unknown project |
| `GET /api/owner/autonomy/samples?project=&unit=&outcome=&limit=` | `limit` 1..200, default 50 | `{samples: SampleView[]}` (ids and codes only) | 400 |
| `POST /api/owner/autonomy/flip` | `{project, unit, to: "act" \| "observe", configHash}`, body at most 1 KB | `{flip: FlipView, already: boolean}` | 400, 403 (`autonomy.mode` observe and `to: act`), 409 `not_ready` / `blocked` / `conflict` / `cooldown` |

`to: "observe"` is the owner's Back to observe; it needs only the hash check.

### 4.9 Configuration

Project YAML; observe first. Defaults:

```yaml
autonomy:
  enabled: false               # off: no samples, no sweep, the view says how to enable it
  mode: observe                # observe: record, judge, show, propose rollbacks | act: the owner may flip from the view, rollbacks are applied
  window_days: 14              # 1..90
  min_days: 7                  # 1..window_days
  max_unresolved: 0.2          # 0..1
  last_n: 20                   # 5..200
  sweep_seconds: 600           # 60..3600: outcome resolution and rollback checks
  retention_days: 90           # 7..365
  units:                       # per-unit bars; a unit not listed uses its module's defaults below
    planner:        { min_samples: 30,  agreement: 0.95 }
    pr_health:      { min_samples: 50,  agreement: 0.95, settle_minutes: 30 }
    bus_consumers:  { min_samples: 200, agreement: 0.99 }
    work_store:     { min_samples: 500, agreement: 0.995 }
    spend_guards:   { min_samples: 10,  agreement: 0.90 }   # applies to each guard; e.g. spend_guards/quota: {...} overrides one
    # decision_rules: bars come from decision-policies.md §5 and aren't set here
  rollback:
    on_unsafe: true
    last_n: 20                 # 5..200
    reflip_cooldown_days: 3    # 0..30
```

- A key outside this list, a value of the wrong type or out of range is refused (the project's config errors, as for
  other blocks); a refused block runs the module `off`, never with partial values.
- `min_samples` 1..10000, `agreement` 0.5..1, `settle_minutes` 1..1440.
- The bars are higher where a mistake is silent and frequent (the bus and the work store read every line), lower where
  each sample is rare and the action is a hold the owner sees (guards).

### 4.10 Flow

1. A module emits an event (§4.3); `autonomy` asks the unit's source for samples and writes them.
2. Every `sweep_seconds`: per project, read open samples (at most 500, oldest `due_at` first), ask each source to
   resolve them, write outcomes; mark samples past `due_at` `unresolved`; prune old samples; compute each unit's state;
   raise or withdraw rollback notices, or apply rollbacks in act.
3. The view reads `status`; the owner flips or rolls back through `flip`.

Failure paths: a source throws: its units show `not_ready` ("evidence source failed: <code>") and their samples stay
open; the store can't be opened: the module logs once, the view shows the error, nothing is flipped or rolled back; a
settings save fails validation: the flip is refused with the save's errors, nothing recorded; the server restarts
mid-flip: the flip row is written after the save, and the reload hook records a manual flip if the save landed
without a row, so one flip is never recorded twice (same `idem`).

## 5. Security and privacy

- Every route is owner-only (`/api/owner`); the flip writes only the mode key of one unit, from a fixed map of unit to
  key path (the `GUARD_KEYS` pattern), never a path from the request.
- Every read and write is scoped by `project`; a unit or sample of another project is a 404, not an empty answer.
- No shell, no network: sources read stores in process; the decision table write uses the existing atomic file
  pattern.
- Stored and returned evidence is ids and codes only (§4.2); logs carry unit, project and codes, never task text or
  command lines.
- Upward flips need the owner's session and a fresh readiness check; an agent (bus token, ops token) can't call
  these routes.

## 6. Reliability

- Writes are idempotent (§4.2, §4.5); a restart replays nothing twice. Events missed while the server was down leave
  no sample; the stores of the planner, the agents and the decisions are re-read at start for the last `window_days`
  (bounded, 10000 rows per unit), so their units lose nothing; the in-memory sources (bus, work store, PR health)
  restart counting, and their gap shows as fewer days.
- Every sweep is bounded (500 samples per project), each source call has a 5 s budget, and a timeout is a failure
  (the samples stay open), never "agreed".
- The rollback save retries once on conflict, then waits for the next sweep; no unbounded retry.

## 7. Acceptance tests

Each drives the module's real entry point (events into the event bus, the routes through the server), with fixture
payloads copied from the emitters named in §2.1, and fakes only the clock.

- **AT-1 `autonomyOffWritesNothing`:** `autonomy.enabled: false`, a `guard_would` and a `bus.consume_observed` event:
  no `data/autonomy.db` is created, status says `enabled: false`.
- **AT-2 `observeModulesStillWriteNothing`:** PR health and the bus consumers in observe with autonomy on: the
  modules write no state of their own (no ledger file, no notice); only `samples` rows appear.
- **AT-3 `sampleIsWrittenOnce`:** the same `guard_would` event three times, then a restart and a replay: one row.
- **AT-4 `quotaWouldCoolResolves`:** a `would_cool` until T; a start on the provider at T-10 min that works: the
  sample is `disagreed`; another with the next start limited again: `agreed`.
- **AT-5 `wouldParkUnsafeWhenWorkFinished`:** a `would_park` for task X, then an accepted `DONE` for X with a PR in
  its chain and no owner action: `unsafe`; the unit is `not_ready` with reason `unsafe`.
- **AT-6 `busMismatchOnDoneIsUnsafe`:** a mirrored line whose report reads `DONE` and whose patterns read `PROGRESS`:
  `unsafe`; a mismatch on `PROGRESS` vs `TICK`: `disagreed`.
- **AT-7 `workComparisonIgnoresHolds`:** a `work.compared` with one agree, one ignored and one disagree row: two
  samples, the ignored line none.
- **AT-8 `plannerSampleFromOwnerDecision`:** an `auto_apply: [add]` proposal with verifier `approve`, applied by the
  owner: `agreed`; a `finish` the verifier approved and the owner declined: `unsafe`.
- **AT-9 `prHealthClearedFindingDisagrees`:** a `pr_health.planned` note, then `pr_health.cleared` for the finding
  within `settle_minutes`: `disagreed`; a finding that stands and the PR gets a new head: `agreed`.
- **AT-10 `readinessNeedsDaysAndSamples`:** 300 agreed bus samples on day 3 of 7: `collecting`; the same on day 7:
  `ready`; one unsafe on day 8: `not_ready`.
- **AT-11 `recentDriftBlocksReady`:** 500 agreed samples, then 20 with 15 agreed: `not_ready` (last 20 under the bar).
- **AT-12 `versionChangeRestartsWindow`:** a ready guard, then its `max` changed: `collecting`; the old samples are in
  the history, not in the counts.
- **AT-13 `flipWritesOneKeyThroughSettings`:** `autonomy.mode: act`, a ready guard, `POST flip`: the YAML changes only
  that guard's mode key, settings history has the version, a flip row holds the evidence; the same request again
  returns `already: true` with no second save.
- **AT-14 `flipRefusals`:** not ready: 409 `not_ready`; stale `configHash`: 409 `conflict`; `work_store` to act: 409
  `blocked` naming work-store.md §6; `pr_health` without `notify_cmd`: 409 `blocked`; `autonomy.mode: observe`: 403;
  no owner session: 401; another project's unit: 404. Nothing is written in any case.
- **AT-15 `rollbackObserveOnlyNotifies`:** a guard in act, one unsafe sample, `autonomy.mode: observe`: one notice
  with the dedupe key, the YAML unchanged; a second unsafe sample adds no notice.
- **AT-16 `rollbackActWritesObserve`:** the same in `autonomy.mode: act`: the key is written to `observe`, a flip row
  `by: autonomy, reason: unsafe`, one notice; the next sweep writes nothing; a flip up within the cooldown is 409
  `cooldown`.
- **AT-17 `rollbackNeverFlipsUp`:** a fuzz of sweeps over units in every state: the sweep's only write target is
  `observe`.
- **AT-18 `manualFlipRecorded`:** the owner edits the YAML to put a not-ready unit in act: one flip row
  `reason: manual`, the view shows the warning badge, the key is not reverted.
- **AT-19 `sourceFailureFailsClosed`:** a source that throws or exceeds 5 s: its units `not_ready` with the reason,
  samples stay open, no flip possible.
- **AT-20 `viewShowsReadyAndDue`:** client: rows sorted rollback_due, ready, ...; Switch to act only on ready rows,
  disabled with the hint in observe; Back to observe on acting rows.

## 8. PR plan

Each PR builds, is wired behind `autonomy.enabled: false`, and merges on its own; each stays under ~600 changed
non-test lines.

| PR | Contents | ATs |
|---|---|---|
| 0 | This spec | |
| 1 | `src/server/autonomy/`: config, store (schema v1), the source interface, the sweep, `GET status` and `GET samples`; sources for the spend guards (from the agents store) and decision rules (from `policyAgreement()`) | 1, 3, 4, 5, 10, 11, 12, 19 |
| 2 | Sources for the bus consumers and the work store, with the `bus.consume_observed` and `work.compared` events | 2, 6, 7 |
| 3 | Sources for the planner and PR health, with the `pr_health.planned` event | 2, 8, 9 |
| 4 | The flip route (up and Back to observe), the settings-save write, the reload hook for manual flips, rollback notices in observe and rollbacks in act | 13, 14, 15, 16, 17, 18 |
| 5 | The view (Health → Autonomy, the Home count) and `docs/configuration.md` | 20 |

## 9. Decisions made here

- **One module reads, the others stay as they are.** The alternative, each module computing its own readiness,
  repeats the window, bar and rollback logic six times and gives six views.
- **Rollback can be automatic, promotion never.** Observe keeps today's behaviour for every unit, so going back is
  safe; going forward is an owner decision even when the numbers are met.
- **The ladder uses decision-policies' bars for decision rules** and its own config for the rest, so there is one
  set of numbers per kind of unit and no second source of truth.
- **The flip goes through the settings save**, not a new config writer, so validation, history and reload are shared.

## 10. Risks

- **Outcome rules can be wrong themselves** (a would-park judged "agreed" because nobody looked). Mitigation: the
  `unresolved` share bar and the last disagreements shown next to every flip button; a reviewer reads them before
  clicking. We would notice through rollbacks soon after flips.
- **In-memory sources restart their count** after a server restart (§6). Mitigation: their `min_days` counts days
  with samples, and the view shows the gap.
- **Low-volume units never reach `min_samples`.** They stay `collecting`; the owner can lower the bar per unit in
  config, which is recorded in the flip's evidence snapshot.
- **The bars are guesses** for the modules without data yet (PR health, work store). They are config, and the first
  weeks of samples will show whether they are too tight.
