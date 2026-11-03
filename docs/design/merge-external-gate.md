# Merging on an external gate signal

Status: design for `review.merge.external_gate` (off by default).

## Problem

Some projects don't merge on their hosted CI. Their merge signal is a signed gate result from their own gate system,
at the PR's exact head (`review.merge.gate.source: signed`), and `pr_health.repos.<owner/name>.ci_signal: false` says the
hosted CI is not a signal. Such projects often merge with an outside script and a watcher loop instead of Lair, for three
reasons:

1. **The default-branch hold stops every merge.** With `hold_when_default_red`, any failed required gate at the default
   branch's tip holds every PR. A project whose gate system also runs nightly or scheduled pipelines on the tip sees one
   failure there hold all merges, though the merge signal (the gate at each PR's head) is green.
2. **One gate result can't satisfy a stricter rule.** An outside script typically picks the first verified gate at the
   head, then applies stricter rules to that one only, for example "a PR that adds HTTP routes needs a gate that ran the
   access-control tests". When a later gate at the same head ran those tests, the PR is still refused.
3. **No dry run.** `merge.auto` merges at once. There is no way to see what Lair would merge before letting it.

## What exists today

Line numbers are at the branch point of this PR on `main`.

| Area | Where | What it does |
| --- | --- | --- |
| Signed gate at the exact head | `src/server/review/gate-source.ts:104-149` | `checksAt(sha)` verifies the signed results stored for exactly that commit; the newest trusted result per pipeline decides |
| Any-of gate groups | `src/server/review/gate-source.ts:86-102`, `config.ts:95-104` | `{any_of: [...]}` is satisfied by one passed pipeline |
| Default-branch hold | `src/server/review/service.ts:524-550`, `policy/merge-policy.ts:188-194` | a failed required gate at the default tip adds a hold to every PR (exempt: a proven revert with a listed label) |
| Target branch must be the default branch | `src/server/policy/merge-policy.ts:73-84` | a PR whose base is another branch (a stacked PR) is refused by the policy, for every merge path |
| Periodic sweep of open PRs | `src/server/review/service.ts:1170-1209`, called from the scan at `:1835-1862` | `autoMerge()` rotates through every open, non-draft PR (`MAX_AUTO_EVALUATIONS` per scan, `:144`), gate first, then the full policy; at most one merge per scan |
| Refused-at-head memory | `src/server/review/store.ts:1171-1213`, `service.ts:1191-1192` | `review_auto_merges` keeps one row per PR and head; a `failed` or `interrupted` attempt is not tried again until the head changes; `skipped` (head moved, policy changed) may be |
| Hold list | `src/server/review/store.ts:738-775`, `routes.ts:332-345`, `service.ts:661` | `POST /api/review/holds` holds one PR (or every merge) until the owner releases it; the policy refuses while it lasts |
| Pre-merge check | `src/server/review/service.ts:1565-1578`, `check.ts` | `merge.check_cmd` runs before every merge (for example migration-order or deleted-test checks); non-zero refuses |
| Test integrity | `src/server/review/integrity.ts` | deleted tests and added skips become blocking findings in `integrity.blocking_tiers` |
| Reviews closed at the head | `src/server/policy/merge-policy.ts:108-162` | required slots filled at the head, no request for changes at the head, no open blocking finding |
| Per-repo hosted CI signal | `src/server/pr-health/config.ts:52-57,143` | `pr_health.repos.<repo>.ci_signal` (default true) |

So the target-branch rule, the sweep, the refused-at-head memory and the hold list exist. This design adds the three
gaps above and reuses the rest unchanged.

## Configuration

```yaml
review:
  merge:
    gate: { source: signed, ... }          # required while external_gate is on
    auto: false                            # act replaces merge.auto (both on is a config error)
    external_gate:
      mode: observe                        # off (default) | observe | act
      tiers: [amber, green]                # optional; default every tier
      gate_rules:
        - id: routes
          paths: ["server/src/main/**/*.java"]
          added_line_contains: ["@GetMapping", "@PostMapping"]   # optional; plain substrings, no regex
          needs_any:
            - { pipelines: [backend-full] }
            - { reports: [AccessControlTest] }
```

- `mode: off` changes nothing anywhere.
- `mode: observe`: the sweep runs (even with `merge.auto: false`) and records, for every open PR whose gate passed at the
  head, whether Lair would merge it and why not. Nothing merges through it, and the policy every other merge path uses
  is unchanged.
- `mode: act`: the same sweep merges (at most one PR per scan, `auto_min_interval_seconds` apart), and the rules below
  become part of the policy for every merge of the project, the owner's merge button included.

## Rules

**R1, merge signal.** When the review repository is listed with `pr_health.repos.<repo>.ci_signal: false`, the signal is
the signed gate at the exact head, and the default-branch hold does not apply: a red default branch neither holds a PR nor
asks for the red tier's reviews. With `ci_signal` true (or unlisted), `hold_when_default_red` keeps its meaning.
`external_gate` with `gate.source: checks` is a config error (host checks are what such a project doesn't trust).

**R2, gate rules.** A rule applies to a PR when one of its changed files matches `paths` and, with
`added_line_contains`, one of that file's added lines contains one of the strings. A file whose patch the host omits
(too large) counts as matching: an unknown diff fails closed. An applying rule is met when **any** signed result at the
head is a trusted pass (known node, valid signature, this project, the configured pipeline version) that satisfies one
`needs_any` option: its pipeline is in `pipelines` (when given) and each `reports` string is part of one of its signed
report names (when given). A pass whose pipeline has a newer trusted failure at the head doesn't count. An unmet rule is
the policy condition `gate_rules` ("Gate rules: routes needs a passed gate at <head> with pipeline backend-full, or
reports AccessControlTest").

**R3, target branch.** Unchanged (`merge-policy.ts:73-84`); the sweep records a stacked PR as "would not merge" with that
reason and never merges it.

**R4, sweep.** The existing `autoMerge()` scan, run when `mode` is observe or act.

**R5, refused-at-head.** Unchanged: an attempt that failed at a head is not retried until the head changes. A PR refused
at its head is not observed again either.

**R6, hold list.** Unchanged: a held PR is recorded "would not merge" with the hold's reason.

## Observation records

`review_merge_observations` (review store schema 6), one row per project, PR and head: `would_merge`, `reasons` (at most
20), `observed_at`. A sweep rewrites the row; the event `review.merge_observed` is emitted only when the verdict or the
reasons changed, so a quiet project emits nothing per scan. `GET /api/review/prs/:n` shows the same verdict, computed
fresh, as `externalGate: {mode, wouldMerge, reasons, defaultRedExempt}`.

## Failure modes

- Host errors during a sweep: the scan logs and stops, as today (`service.ts:1846-1856`); nothing is recorded as
  "would merge" from partial facts.
- An unverifiable result never satisfies a rule (R2). A rule with no trusted pass is unmet.
- A restart mid-merge: unchanged (the attempt row is written first and reported as interrupted).
- Observe never calls `merge()`, never starts a pre-merge check, never raises a decision.

## Acceptance tests

All in `src/server/review/external-gate.test.ts`, through `ReviewManager` with the fake host and really signed results.

| AT | Name | Asserts |
| --- | --- | --- |
| AT-1 | `externalGate_signal_default_red_exempt` | act, `ci_signal: false`, default tip has a failed signed gate: the PR merges; with `ci_signal` true the same PR is held |
| AT-2 | `externalGate_gate_rule_any_gate` | a route-adding PR with an older passed gate lacking the report and a newer passed gate with it merges; with only the first it is refused with the rule's reason; a newer failure of the satisfying pipeline makes it unmet |
| AT-2b | `externalGate_gate_rule_fail_closed` | a matching file with no patch makes the rule apply; an untrusted (wrong pipeline version) pass doesn't satisfy it |
| AT-3 | `externalGate_stacked_never_merges` | base is not the default branch: observe records it with the target reason, act doesn't merge it |
| AT-4 | `externalGate_sweep_without_auto` | observe with `merge.auto: false` records every gated PR in one scan and merges none |
| AT-5 | `externalGate_refused_head_not_retried` | act: a check_cmd refusal at a head is not tried again on the next scan; a new head is |
| AT-6 | `externalGate_hold_list` | a held PR is recorded "would not merge" with the hold reason and not merged; released, it merges |
| AT-7 | `externalGate_observe_writes_nothing` | observe: no merge, no check run, no decision; the event fires once per changed verdict |
| AT-8 | `externalGate_config` | off by default; checks source, act with `merge.auto`, an empty `needs_any` option, an unknown pipeline are config errors |

## PR split

One PR: config (`config.ts`), the rule evaluation (`gate-rules.ts`), the sweep and policy wiring (`service.ts`), the
observation store (`store.ts`, schema 6), docs (`docs/configuration.md`). Off by default.
