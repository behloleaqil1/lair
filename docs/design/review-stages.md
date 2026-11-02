# Staged review slots

- **Status:** Approved for build (2026-11-02, against main `9bce85a`)
- **Owner questions:** none.

## 1. Problem

A project that wants a strong (expensive) reviewer today often runs it outside Lair. Lair's merge policy then can't see that reviewer's `request_changes`, so a cheaper reviewer's approval is enough for the policy and the PR can merge against the strong reviewer's verdict. The fix is to make the strong reviewer an ordinary reviewer slot inside Lair (reviews by agents already start reviewer agents with assignment tokens). But Lair asks for every missing slot as soon as it sees a PR or a new head, so an expensive slot would run at every push, including pushes whose gate fails and work no cheaper reviewer has approved yet.

## 2. What exists today

| What | Where |
|------|-------|
| Slot schema: a string, or `{any_of, different_model, pool}` | `src/server/review/config.ts:45-63` |
| Slot parsing; per-tier slot validation (role pools) | `src/server/review/config.ts:341-346`, `:496-501` |
| `ReviewSlot`, `SlotStatus`, `SlotAssignmentState` (the view's states) | `src/shared/review-types.ts:109-132` |
| Slots filled by approvals at the head (maximum matching) | `src/server/policy/reviewer-slots.ts:110` (`matchSlots`) |
| The gate at the head: every required check `passed` and for the head sha | `src/server/policy/merge-policy.ts:85` |
| The gate read (host checks, or signed results from the store) | `src/server/review/gate-source.ts:61`, `:99`; read in `evaluate()` at `src/server/review/service.ts:623` |
| A PR's evaluation: slots, gate, conditions, assignment views | `src/server/review/service.ts:581-699`, `assignmentViews` `:319-357` |
| Asking for missing slots, once per head, per slot | `src/server/review/service.ts:1301-1446` (`requestNow`), `:1037` (`requestReviews`) |
| The automatic path: each open PR when first seen or its head changed, at most once per PR in 5 minutes | `src/server/review/service.ts:1054-1072`, `:184` |
| The scan: every 60 s; reviews by agents followed every 15 s | `src/server/review/service.ts:1680`, `:1795-1807`, `:1889` |
| Gate results arriving: HTTP (signed) and in-process (triage) | `src/server/review/service.ts:985`, `:1016` |
| Reviews arriving | `src/server/review/service.ts:724` (`submitReview`) |
| The owner's "Request missing reviews" (owner only) | `src/server/review/routes.ts:291-295`, `src/client/components/PrDetail.tsx:214` |
| The dashboard's per-slot request label | `src/client/review-view.ts:15-47`, `src/client/pr-view.ts:136-141` |
| Docs | `docs/configuration.md` "Required reviews", "Reviewers and the Decision Inbox", "Reviews by agents" |

## 3. Design

A slot in object form gains an optional `ask_after`, a list with either or both of:

- `gate`: ask only when the merge gate passed at the PR's current head, by the same rule the merge policy uses (every required check `passed`, for the head sha; signed results where the project configures them).
- `earlier_slots`: ask only when every earlier slot in the same tier list is filled by an approval at the current head.

```yaml
review:
  reviewers:
    red:
      - { any_of: [peer], pool: [reviewer-a, reviewer-b] }
      - { any_of: [peer], different_model: true, pool: [strong-reviewer], ask_after: [gate, earlier_slots] }
```

Rules:

1. **Off-safe default.** Without `ask_after` nothing changes. Validation refuses an unknown value, a value listed twice, an empty list and `earlier_slots` on a tier's first slot.
2. **Waiting.** A missing slot whose condition does not hold at the head, and that has no live request there, is `waiting`. It is not asked for: no request round, no token, no attempt, no run, no Decision Inbox item. The PR's status carries the reason on the slot (`slots[i].waiting`, also appended to its `detail`) and as an assignment view with state `waiting`; the dashboard's "Required reviews" table shows it.
3. **Re-evaluation.** The automatic scan (every minute) re-checks a PR's waiting slots at the same head, at most 10 PRs per scan, the ones checked longest ago first. A stored gate result for a head, and a review for a head, re-check that head's waiting slots at once. Only the waiting slots are asked in such a round, so the once-per-head rule for the others is unchanged.
4. **New head.** A new head resets as today; the condition is evaluated at the new head.
5. **Merge rules.** Unchanged: a waiting slot is a missing slot, and a `request_changes` from any slot blocks the merge.
6. **Owner's request.** "Request missing reviews" skips waiting slots too and says so: the outcome's channel is `waiting` with the reason, and the dashboard's message names them.

No store or schema change: waiting is computed at each evaluation.

## 4. Acceptance tests

| # | Setup | Action | Expected |
|---|-------|--------|----------|
| 1 | No `ask_after` | Ask for missing reviews | Every missing slot is asked at once, as today; parsed slots carry no `askAfter` |
| 2 | Slot 2 `ask_after: [gate]`, the gate failing at the head | Ask; then the gate passes and the scan runs; the scan runs again | Slot 2 `waiting` (status, view, outcome), no assignment; then asked once; then not again |
| 3 | Slot 2 `ask_after: [earlier_slots]`, slot 1 not approved | Ask; slot 1's reviewer approves | Slot 2 waits; after the approval it is asked without a scan |
| 4 | `ask_after: [gate, earlier_slots]` | Gate passes but slot 1 unapproved; then slot 1 approves | Waits until both hold, then asked once |
| 5 | Slot 2 asked at head A | A push makes head B, gate pending at B | Slot 2 `waiting` at B; no request at B |
| 6 | Slot 2 waiting | The owner's "Request missing reviews" | Outcome `waiting` with the reason; no assignment |
| 7 | Slot 2 asked and reviews `request_changes` | Evaluate | The merge stays blocked (`changes_requested`) |
| R1 | `ask_after: [ci]` | Load the config | Refused: unknown value |
| R2 | `ask_after: [earlier_slots]` on slot 1 | Load the config | Refused: the first slot has no earlier slot |
| R3 | `ask_after: []` or `[gate, gate]` | Load the config | Refused |

## 5. Files to change

- `src/server/review/config.ts`: schema, validation, parsing.
- `src/shared/review-types.ts`: `ReviewSlot.askAfter`, `SlotStatus.waiting`, state `waiting`.
- `src/server/policy/reviewer-slots.ts`: a pure `slotWaits()` for the reason per slot.
- `src/server/review/service.ts`: waiting in `evaluate()`, `assignmentViews()`, `requestNow()`; the re-check in the scan; re-checks on gate results and reviews.
- `src/client/review-view.ts`, `src/client/components/PrDetail.tsx`: the label and the request message.
- `docs/configuration.md`: the slot row, the waiting state, the example.
- Tests: `config.test.ts`, `service.test.ts` (or a new `review-stages.test.ts`), `review-view` tests.
