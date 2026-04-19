# Design Candidates: Late-Bound Goals

**Feature**: Default `goalTemplate: "{{$.goal}}"` when no static `goal` and no `goalTemplate` is configured, enabling dynamic goals from the webhook payload.

**Date**: 2026-04-18

---

## Problem Understanding

### Core Tensions

1. **Type safety vs relaxed validation**: `TriggerDefinition.goal: string` is a required field by type. Relaxing the YAML validation (allowing `goal` to be absent) must not violate the type. Resolved by injecting a sentinel.

2. **Parse-time vs dispatch-time defaulting**: Injecting at parse time (trigger-store.ts) keeps the router clean. Injecting at dispatch time (trigger-router.ts) would require making `goal` optional in the type or adding defensive null checks everywhere `trigger.goal` is used.

3. **Sentinel vs empty string**: The fallback goal for "payload had no goal field" must be human-readable in logs and the console UI. `'Autonomous task'` is the minimum useful value.

4. **Backward compat**: Existing triggers in `triggers.yml` have a static `goal`. The change must be zero-impact for them.

### Likely Seam

`validateAndResolveTrigger()` in `src/trigger/trigger-store.ts` -- specifically between the `requiredStringFields` check (line 553) and the `goalTemplate` assembly (line 654). The new logic fits naturally there: after required non-goal fields are checked, handle the `goal`/`goalTemplate` pair together.

### What Makes It Hard

Technically simple, but the non-null assertion `goal: raw.goal!.trim()` on line 974 would panic if `goal` is removed from `requiredStringFields` without also ensuring injection. A junior developer might instead make `goal` optional in `TriggerDefinition`, cascading null checks across all consumers.

---

## Philosophy Constraints

- **Validate at boundaries, trust inside** (CLAUDE.md): inject the default at parse time in trigger-store.ts, not at dispatch time in trigger-router.ts.
- **Make illegal states unrepresentable** (CLAUDE.md): `TriggerDefinition.goal` must always be a valid `string`. Sentinel injection preserves this.
- **YAGNI with discipline** (CLAUDE.md): `'Autonomous task'` is the minimum viable fallback. Do not add configurable fallback strings.
- **Repo pattern** (trigger-store.ts line 756): `concurrencyMode` defaults to `'serial'` at parse time -- exactly the pattern to follow.

No philosophy conflicts detected.

---

## Impact Surface

- `src/trigger/trigger-store.ts` line 553: `goal` removed from `requiredStringFields`
- `src/trigger/trigger-store.ts` line 974: `goal: raw.goal!.trim()` must become `goal: resolvedGoal`
- `src/trigger/trigger-router.ts`: no change -- `interpolateGoalTemplate` already handles `{{$.goal}}` and falls back to `staticGoal`
- `src/trigger/types.ts`: no change -- `goal: string` stays required
- `src/v2/usecases/console-routes.ts` line 677: returns `t.goal` in trigger list -- will show `'Autonomous task'` for late-bound triggers (acceptable UX)
- `tests/unit/trigger-store.test.ts`: add 2-3 new test cases
- `tests/unit/trigger-router.test.ts`: add 1 test for `{{$.goal}}` dispatch

---

## Candidates

### Candidate A: Parse-time sentinel injection (recommended)

**Summary**: Remove `goal` from `requiredStringFields`. After the required checks, add a block: if `raw.goal` absent AND `raw.goalTemplate` absent, set `resolvedGoal = 'Autonomous task'` and inject `goalTemplate = '{{$.goal}}'`; if `raw.goal` absent AND `raw.goalTemplate` present, set `resolvedGoal = 'Autonomous task'`; otherwise use `raw.goal.trim()`. Replace `raw.goal!.trim()` on line 974 with `resolvedGoal`.

- **Tensions resolved**: type safety (sentinel ensures `string`), backward compat, parse-time defaulting
- **Tension accepted**: sentinel is synthetic -- `'Autonomous task'` shows in console for unconfigured triggers
- **Boundary**: `validateAndResolveTrigger()` in trigger-store.ts -- the correct validation boundary
- **Why this boundary**: all other defaults (`concurrencyMode`, `referenceUrls`, `agentConfig`) are applied here, not in the router
- **Failure mode**: operators reading the console trigger list see `'Autonomous task'` as the goal for late-bound triggers; acceptable since the real goal comes from the payload
- **Repo pattern**: follows `concurrencyMode` default exactly
- **Gains**: ~8 lines changed, zero downstream changes, fully backward-compatible
- **Losses**: nothing material
- **Scope**: best-fit
- **Philosophy**: honors validate-at-boundaries, make-illegal-states-unrepresentable, YAGNI

### Candidate B: Make `goal` optional in TriggerDefinition

**Summary**: Change `readonly goal: string` to `readonly goal?: string` in `TriggerDefinition`. Remove `goal` from `requiredStringFields`. Update trigger-router.ts and console-routes.ts to handle `goal | undefined`.

- **Tensions resolved**: type honesty -- `goal` really is absent for late-bound triggers
- **Tensions accepted**: type change cascades -- every consumer of `trigger.goal` must handle `undefined`
- **Boundary**: types.ts (type contract) + all consumers
- **Failure mode**: cascading null checks; `trigger.goal ?? ''` as the router fallback is worse UX than `'Autonomous task'`
- **Repo pattern**: departs from existing pattern where all `TriggerDefinition` fields are either required or explicitly optional
- **Gains**: type honesty
- **Losses**: type safety guarantee; cascading changes across router, console-routes, tests
- **Scope**: too broad -- type change touches 3+ files unnecessarily
- **Philosophy**: conflicts with make-illegal-states-unrepresentable, YAGNI

---

## Comparison and Recommendation

| Dimension | Candidate A | Candidate B |
|---|---|---|
| Type safety | Full -- `goal: string` always holds | Weakened -- `goal?: string` propagates |
| Files changed | 1 source + tests | 3+ source files + tests |
| Backward compat | 100% | 100% but requires null guards |
| Repo pattern fit | Exact (concurrencyMode) | Departs from established pattern |
| Reversibility | Trivial | Requires re-tightening type across consumers |

**Recommendation: Candidate A.** Resolves all tensions at the correct boundary with the minimum change surface. Exact match to the established `concurrencyMode` default pattern. Zero downstream impact.

---

## Self-Critique

**Strongest counter-argument**: Candidate B is more type-honest. The sentinel `'Autonomous task'` is a lie -- the goal is really absent at config time. Operators reading the console trigger list may be confused.

**Why it still loses**: The console trigger list already shows `goalTemplate` as a separate field (if set). For late-bound triggers, the UI can be enhanced later to show `goalTemplate` instead of `goal` -- but that is a separate concern. The type lie is contained to display; routing behavior is correct.

**Narrower option**: Only inject `goalTemplate` without a sentinel `goal`, using a conditional on the object literal. But `TriggerDefinition.goal: string` is required, so this path leads back to Candidate B (type change required).

**Broader option**: Add `goalSource: 'static' | 'template' | 'payload'` discriminant to `TriggerDefinition` for explicit tracking. Useful for a future console UI enhancement, but out of scope for this 10-line fix.

**Invalidating assumption**: If `trigger.goal` is used anywhere to make routing decisions (not just as a display value or fallback), the sentinel could cause incorrect behavior. Verified: `trigger.goal` is only used in `interpolateGoalTemplate` as the `staticGoal` fallback and in log messages. Safe.

---

## Open Questions for the Main Agent

1. Should the sentinel string be `'Autonomous task'` or something else (e.g. `'No goal configured'`, `'(goal from payload)'`)? The backlog does not specify. `'Autonomous task'` matches the product language used elsewhere.
2. Should a `console.warn` be emitted when both `goal` and `goalTemplate` are absent, so operators know the trigger is using late-bound goals? This would help debugging misconfigured triggers.
