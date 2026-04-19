# Implementation Plan: Late-Bound Goals

**Feature**: Default `goalTemplate: "{{$.goal}}"` when no `goal` and no `goalTemplate` configured.

---

## Problem Statement

Triggers require a static `goal` in `triggers.yml`. This makes dynamic-goal use cases (PR review, incident response) require either a static placeholder goal or a custom `goalTemplate`. The feature enables: `curl -X POST /webhook/my-trigger -d '{"goal": "review PR #42"}'` without any goal pre-configuration.

---

## Acceptance Criteria

1. A trigger with neither `goal` nor `goalTemplate` in `triggers.yml` loads successfully (no `missing_field` error).
2. When the webhook payload contains a `goal` field, the session is started with that value as the goal.
3. When the webhook payload has no `goal` field, the session is started with `'Autonomous task'` as the goal, AND a warning is logged to daemon stderr.
4. Existing triggers with a static `goal` field behave identically to before.
5. TypeScript compiles without errors (no new `any` or `!` assertions on the new code path).

---

## Non-Goals

- No change to `TriggerDefinition` type (`goal: string` stays required).
- No change to `trigger-router.ts` interpolation logic.
- No change to `console-routes.ts` dispatch endpoint.
- No `goalSource` discriminant on `TriggerDefinition` (future enhancement).
- No configurable fallback string other than `'Autonomous task'`.

---

## Philosophy-Driven Constraints

- Validate at boundaries: injection must happen in `trigger-store.ts`, not in `trigger-router.ts`.
- Make illegal states unrepresentable: `TriggerDefinition.goal` must always be a valid `string`.
- YAGNI: minimal change -- named constant + ~8 lines + tests.
- Document why: WHY comment required above the injection block.

---

## Invariants

1. `TriggerDefinition.goal: string` -- never `undefined` or empty string after parse.
2. `trigger.goal` is only used as a display/fallback value, never as a routing key.
3. The interpolated goal (from payload or fallback) flows to the session, not the sentinel.
4. Injection only fires when both `raw.goal` and `raw.goalTemplate` are absent.

---

## Selected Approach

**Candidate A: Parse-time sentinel injection in `validateAndResolveTrigger()`**

1. Remove `'goal'` from `requiredStringFields`.
2. After the required-fields loop, add a block:
   - If `raw.goal` absent AND `raw.goalTemplate` absent: set `resolvedGoal = LATE_BOUND_GOAL_SENTINEL` and `resolvedGoalTemplate = '{{$.goal}}'`. Log an INFO message.
   - If `raw.goal` absent AND `raw.goalTemplate` present: set `resolvedGoal = LATE_BOUND_GOAL_SENTINEL`.
   - Otherwise: `resolvedGoal = raw.goal!.trim()`.
3. Replace `goal: raw.goal!.trim()` on line 974 with `goal: resolvedGoal`.
4. If `resolvedGoalTemplate` was injected, pass it via the `goalTemplate` spread at line 980.

**Runner-up**: Candidate B (optional type) -- rejected because it cascades null checks to 3+ files.

**Rationale**: Exact match to the `concurrencyMode` default pattern at line 756. Zero downstream impact.

---

## Vertical Slices

### Slice 1: Core implementation (~8 lines in trigger-store.ts)

**File**: `src/trigger/trigger-store.ts`

**Changes**:
- Add `const LATE_BOUND_GOAL_SENTINEL = 'Autonomous task';` near the top of the validation section.
- Remove `'goal'` from `requiredStringFields` array.
- Add injection block with WHY comment + INFO log.
- Declare `let resolvedGoal: string;` and `let resolvedGoalTemplate: string | undefined;` before the injection block.
- Replace `goal: raw.goal!.trim()` with `goal: resolvedGoal` in the TriggerDefinition literal.
- Pass `resolvedGoalTemplate` to the `goalTemplate` spread.

**Done when**: TypeScript compiles. `loadTriggerConfig` returns a valid `TriggerDefinition` for a YAML with no `goal` and no `goalTemplate`.

### Slice 2: Tests for trigger-store.ts

**File**: `tests/unit/trigger-store.test.ts`

**New test cases**:
1. Trigger with no `goal` and no `goalTemplate` loads successfully, has `goal = 'Autonomous task'` and `goalTemplate = '{{$.goal}}'`.
2. Trigger with no `goal` but an explicit `goalTemplate` loads successfully, has `goal = 'Autonomous task'` and the specified `goalTemplate`.
3. Trigger with a static `goal` behaves identically to before (regression).

**Done when**: All 3 tests pass.

### Slice 3: Test for trigger-router.ts integration

**File**: `tests/unit/trigger-router.test.ts`

**New test case**:
1. Route a webhook event with payload `{ goal: 'review PR #42' }` to a late-bound trigger. Verify `runWorkflow` is called with `goal = 'review PR #42'`.
2. Route a webhook event with no `goal` field to a late-bound trigger. Verify `runWorkflow` is called with `goal = 'Autonomous task'`.

**Done when**: Both tests pass.

---

## Test Design

All tests use the existing `loadTriggerConfig` (pure function, no I/O) and `TriggerRouter` patterns from the test files. No mocks needed for Slice 2. Slice 3 uses `makeFakeRunWorkflow` pattern already in the test file.

Run: `npx vitest run tests/unit/trigger-store.test.ts tests/unit/trigger-router.test.ts`

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Non-null assertion on line 974 missed | Low | Compile error | TypeScript will catch |
| Slice 3 test fails due to goal not threading through | Low | Test failure | Trace through route() logic |
| Existing trigger-store tests broken by goal no longer being required | Low | Test failure | Regression test in Slice 2 covers this |

---

## PR Packaging

Single PR: `feat/late-bound-goals`. All 3 slices in one commit. ~20-30 lines total (source + tests).

---

## Philosophy Alignment

- validate-at-boundaries -> satisfied (injection in trigger-store.ts)
- make-illegal-states-unrepresentable -> satisfied (goal: string always holds)
- YAGNI -> satisfied (~8 source lines)
- document-why -> satisfied (WHY comment in injection block)
- prefer-explicit-domain-types -> tension (sentinel is stringly-typed; acceptable -- future `goalSource` discriminant tracked)

---

## Plan Confidence

- unresolvedUnknownCount: 0
- planConfidenceBand: High
- estimatedPRCount: 1
- followUpTickets: "Add goalSource discriminant to TriggerDefinition for console UI enhancement"
