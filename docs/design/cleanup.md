# Cleanup Module

> Retention and removal for worktrees and watched folders. Off by default; `observe` mode lists what it would remove,
> `act` mode removes it.

## Why

Agent fleets and gate systems leave checkouts behind: gate snapshots that a runner reuses per track and never deletes,
and agent worktrees for PRs merged long ago. Disk fills, file indexing and backups slow down, and nobody knows what
is safe to delete.

## What it does

1. **Worktrees after a merge.** A worktree is removable when its branch's PR is merged or closed, the worktree is
   clean (no uncommitted or untracked changes), every commit is on the remote, no active agent run uses it, nothing
   in it was modified within a configured idle period, and it isn't the main worktree.

2. **Retention for throwaway folders.** Gate snapshots, result logs and other build artifacts are kept for a
   configured number of days, unless they are referenced by a queued or running gate.

3. **Safety.** Real paths only, inside configured roots; never follow a symlink out; never the repository itself,
   `/`, `$HOME` or a configured root; bounded removals per cycle.

4. **Modes.** `observe` (default) lists what it would remove; `act` removes it. Every removal is recorded with its
   reason and bytes freed.

## Configuration

```yaml
cleanup:
  enabled: true
  mode: observe              # observe | act
  interval_seconds: 3600     # how often the cleanup cycle runs (default 1 hour)
  max_entries_per_cycle: 50  # bound removals per tick

  worktrees:
    repos:
      - /home/user/my-project
    after_merge: true
    min_idle_hours: 24

  retention:
    - path: /home/user/my-project/work/gates/snapshots
      keep_days: 2
      kind: worktree
      skip_if_referenced:
        - /home/user/my-project/work/gates/queue/*.req
        - /home/user/my-project/work/gates/queue/*.req.run

    - path: /home/user/my-project/work/gates/results
      keep_days: 30
      kind: file
```

### Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the cleanup module |
| `mode` | `observe` \| `act` | `observe` | `observe` logs removals without executing; `act` removes |
| `interval_seconds` | number | `3600` | Seconds between cleanup cycles |
| `max_entries_per_cycle` | number | `50` | Maximum entries removed per cycle (safety bound) |

### Worktrees block

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `repos` | string[] | `[]` | Paths to repositories whose worktrees are managed |
| `after_merge` | boolean | `true` | Remove worktrees whose branch's PR is merged or closed |
| `min_idle_hours` | number | `24` | Hours since last modification before a worktree is eligible |

### Retention entries

Each entry in the `retention` array:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `path` | string | required | Directory to scan |
| `keep_days` | number | required | Days to keep entries (based on last use, not mtime) |
| `kind` | `worktree` \| `dir` \| `file` | required | What the entries are |
| `skip_if_referenced` | string[] | `[]` | Glob patterns of files whose content names entries to keep |

For worktree entries, "last use" is the gitdir `HEAD` file's mtime (the last checkout), not the folder's mtime.

## Removability rules

### Worktree after merge

A worktree of a configured repo is removable when ALL of these hold:

1. **Merged or closed.** The worktree's branch has a PR that is merged or closed (git host API, or the review module's
   `review.merged` event).
2. **Clean.** No uncommitted or untracked changes outside ignored files (`git status --porcelain` is empty).
3. **Pushed.** Every commit on the branch is on the remote (`git branch -r --contains <head>` includes the tracking
   branch, or the PR's head matches the worktree's head).
4. **Not in use.** No active agent run uses the worktree (agents module's runs and claims).
5. **Idle.** Nothing in the worktree was modified within `min_idle_hours` (the newest mtime of any file, recursively,
   or if too expensive, the gitdir's HEAD mtime).
6. **Not main.** It isn't the repository's main worktree (the one without `gitdir:`).

Detached worktrees (no branch) are checked only under `retention` entries.

### Retention entry

An entry under a `retention` path is removable when:

1. **Old enough.** Its last use is older than `keep_days` ago.
2. **Not referenced.** Its name (basename) doesn't appear in any file matching `skip_if_referenced` globs.

## Safety checks

Before removing anything:

1. Resolve the path to a real path (`fs.realpath`).
2. Confirm it is inside one of the configured roots (`worktrees.repos` or a `retention.path`).
3. Confirm it is not:
   - `/`
   - `$HOME`
   - The repository root itself (for a worktree entry)
   - A configured root
4. If the path is a symlink, confirm the target is also inside a configured root (never follow out).
5. Bound the cycle: stop after `max_entries_per_cycle` removals.
6. Time-bound the cycle: stop after a configured duration (e.g. 10 minutes).

## Removal operations

- **Worktree:** `git worktree remove --force <path>` (handles the gitdir cleanup).
- **Directory:** `rm -rf` (via Node's `fs.rm` with `recursive: true`).
- **File:** `fs.unlink`.

After all removals in a cycle, run `git worktree prune` once per repo.

## Events and audit

Every removal is recorded:

```typescript
interface CleanupRemoval {
  id: string;
  project: string;
  path: string;
  kind: "worktree" | "dir" | "file";
  reason: string;        // e.g. "merged PR #42, idle 3d"
  bytesFreed: number;
  removedAt: number;     // epoch ms
}
```

Events:

- `cleanup.removed`: emitted for each removal with the entry above.
- `cleanup.cycle`: emitted at the end of each cycle with a summary (entries removed, bytes freed, entries skipped,
  duration).

The audit log (`data/audit.log`) gets one line per removal with the same information.

## Store

SQLite database at `data/cleanup.db`:

```sql
CREATE TABLE cleanup_removals (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  bytes_freed INTEGER NOT NULL,
  removed_at INTEGER NOT NULL
);
CREATE INDEX idx_cleanup_removals_project ON cleanup_removals(project, removed_at);

CREATE TABLE cleanup_cycles (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  entries_removed INTEGER NOT NULL DEFAULT 0,
  bytes_freed INTEGER NOT NULL DEFAULT 0,
  entries_skipped INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL
);
CREATE INDEX idx_cleanup_cycles_project ON cleanup_cycles(project, started_at);
```

A restart mid-cycle: the cycle row has `finished_at` null. The next startup marks it incomplete and starts a fresh
cycle. The `cleanup_removals` table holds what was actually removed, so nothing is removed twice.

## Routes

Read-only routes (no state changes):

- `GET /api/cleanup/status?project=<name>`: current mode, last cycle summary, pending (what the next cycle would
  remove in observe mode).
- `GET /api/cleanup/removals?project=<name>&limit=<n>`: recent removals.
- `GET /api/cleanup/cycles?project=<name>&limit=<n>`: recent cycles.

## Dashboard

A **Health** tab card:

- **Observe mode:** "Would free 14 GB (168 entries)" with a breakdown (worktrees, retention by path).
- **Act mode:** "Last cleanup: 2h ago, freed 1.2 GB (23 entries)" with a link to the removals list.

The card links to a detail view (or a modal) with:

- The removals list with reason, bytes and time.
- The pending list in observe mode.

## Acceptance tests

These are production code in `src/server/cleanup/acceptance.test.ts`; they fake only the process spawner, the clock
and the git host API.

1. **Merged worktree removed.** A merged PR's clean, fully pushed worktree is removed in `act` mode and only listed
   in `observe` mode.

2. **Not removed when unsafe.** A worktree is NOT removed when:
   - It has uncommitted changes.
   - It has untracked files (outside `.gitignore`).
   - A commit isn't on the remote.
   - An agent run is active in it (claim points to it).
   - It was modified within `min_idle_hours`.
   - Its PR is still open.

3. **Retention removes old.** A snapshot whose HEAD mtime is older than `keep_days` and isn't referenced is removed;
   a referenced or recent one is kept.

4. **Safety guards.** A symlink pointing outside a root, a path outside the roots, or the repo root itself is never
   removed (each attempt logged as a safety violation).

5. **Per-cycle bound.** With `max_entries_per_cycle: 5` and 10 eligible entries, only 5 are removed per cycle.

6. **Restart mid-cycle.** A cycle interrupted by a restart: the next startup marks it incomplete, removes nothing
   twice, and loses no record.

7. **Worktree prune.** `git worktree prune` runs once per repo per cycle after removals.

## Module structure

```
src/server/cleanup/
├── index.ts             # export { mountCleanup }
├── config.ts            # CleanupSchema, parseCleanupConfig
├── config.test.ts
├── probes.ts            # ProcessSpawner, FileSystem, Clock, GitHost interfaces
├── worktree.ts          # worktree enumeration and removability checks
├── worktree.test.ts
├── retention.ts         # retention entry enumeration and reference checks
├── retention.test.ts
├── safety.ts            # path validation and safety checks
├── safety.test.ts
├── store.ts             # CleanupStore (SQLite)
├── store.test.ts
├── service.ts           # CleanupService: the tick loop
├── routes.ts            # read-only routes
├── routes.test.ts
└── acceptance.test.ts   # end-to-end acceptance tests
```

## Dependencies on other modules

- **Agents module:** check for active runs using a worktree (`agents.runs` with state in `requested`, `running`).
- **Review module:** `review.merged` event to know when a PR merges (optional; can fall back to git host API).
- **Event bus:** emit `cleanup.removed` and `cleanup.cycle` events.
- **Audit log:** record removals in `data/audit.log`.

The cleanup module does NOT depend on triage, placement, delivery, planner or gate pipelines.

## Configuration in Settings

The Settings section (S2) will have a Cleanup page under the "Maintenance" task group with:

- Enable/disable toggle
- Mode selector (observe/act)
- Interval and bounds
- Repos list for worktrees
- Retention entries (add/edit/remove)

The forms are drawn from `CleanupSchema` through the settings registry.

## Implementation order

1. `config.ts` and `config.test.ts`: the schema and validation.
2. `probes.ts`: the interfaces (reuse watchdog's where possible).
3. `safety.ts` and `safety.test.ts`: path validation.
4. `worktree.ts` and `worktree.test.ts`: worktree enumeration and checks.
5. `retention.ts` and `retention.test.ts`: retention entry enumeration and reference checks.
6. `store.ts` and `store.test.ts`: SQLite store.
7. `service.ts`: the tick loop and removal logic.
8. `routes.ts` and `routes.test.ts`: read-only API.
9. `acceptance.test.ts`: the acceptance tests against the whole module.
10. Wire into `index.ts`, register routes, add to Settings registry.
11. Update `docs/configuration.md` with the cleanup section.
12. Update `docs/design/ROADMAP.md` to mark A2 retention as built.
