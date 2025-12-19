# WorkRail v2: Gaps + User-Only Dependencies (Closed Sets + Mode Behavior)
**Status:** Draft (intended to be locked)  
**Date:** 2025-12-19

This document locks the v2 design for:
- **User-only dependencies** (a closed set of reasons WorkRail can treat as “only the user can provide/decide”).
- **Gaps** (append-only durable disclosures used to keep `full_auto_never_stop` real without lying).

Goals:
- Make “blocked vs continue” behavior deterministic and explainable across modes.
- Keep the surface area closed-set, typed, and hard to misuse.
- Encode expected failures as data (no throwing across boundaries).
- Preserve auditability without relying on chat transcript history.

Non-goals:
- Define the full preference set beyond autonomy/mode behavior.
- Define UI rendering details beyond what data must support.

---

## Definitions

- **User-only dependency**: a required input/decision/action that WorkRail can classify as something the agent cannot derive reliably or must not assume without explicit user intent.
- **Blocked**: execution cannot advance under the effective mode; WorkRail returns a structured “blocked” response with an explicit `UserOnlyDependency` payload.
- **Gap**: a durable disclosure record that something required or recommended was missing/assumed/skipped. Gaps are append-only truth and can later be “resolved” only by append-only linkage.

---

## Closed sets

### `UserOnlyDependencyReason` (closed enum)

Initial v2 closed set (small on purpose):
- `needs_user_secret_or_token`
- `needs_user_account_access`
- `needs_user_artifact`
- `needs_user_choice`
- `needs_user_approval`
- `needs_user_environment_action`

Notes:
- “User-only” is a strong claim; the system should be conservative about emitting these.
- `needs_user_choice` is special: it only applies when the workflow explicitly marks the choice as **non-assumable** (see below). Otherwise, the agent should assume-with-disclosure in full-auto.

### `NonAssumableChoiceKind` (closed enum)

When a workflow marks a decision as non-assumable, it must specify **why** using a closed enum:
- `preference_tradeoff` (user values/judgement call)
- `scope_boundary` (materially changes scope/cost)
- `irreversible_action` (dangerous / hard-to-undo)
- `external_side_effect` (affects systems outside the repo)
- `policy_or_compliance` (requires explicit user intent)

Rationale:
- Makes “why this blocked” consistent and renderable.
- Avoids “boolean + free-form string” drift.

### `GapSeverity` (closed enum)
- `warning`
- `critical`

### `GapReason` (closed enum)

This is intentionally aligned with user-only dependencies plus a few system-level disclosure cases:
- `user_only_dependency` (with embedded `UserOnlyDependencyReason`)
- `assumption_made`
- `capability_missing`
- `required_output_missing_or_invalid`
- `workflow_divergence`

Rationale:
- Keeps the gap system composable: many different “problems” can become a `gap_recorded` event without needing bespoke event kinds.

---

## Data shapes (typed, versioned)

### `UserOnlyDependency` (data)

Minimum fields:
- `reason: UserOnlyDependencyReason`
- `summary: string` (short, display-friendly)
- `requestedFromUser: string` (what we want the user to provide)
- `whyUserOnly: string` (short explanation; for UX, not an open-ended policy bag)
- `choiceKind?: NonAssumableChoiceKind` (required when `reason == needs_user_choice`)
- `options?: readonly string[]` (optional; used primarily for `needs_user_choice`)
- `remediation?: string` (optional: how to unblock)

Constraints:
- When `reason == needs_user_choice`, `choiceKind` MUST be present.
- `options` is allowed but must remain small and display-friendly (no giant lists).

### `Gap` (data)

Minimum fields:
- `gapId: GapId` (opaque id)
- `reason: GapReason`
- `severity: GapSeverity`
- `summary: string`
- `createdAtEventIndex: EventIndex`
- `relatedStepId?: StepId`
- `howToResolve?: string`
- `resolvedByNodeId?: NodeId`
- `resolvesGapId?: GapId` (append-only resolution linkage)

Append-only invariant:
- Gaps are never mutated. “Resolution” is represented by:
  - emitting a new `gap_recorded` that references `resolvesGapId`, and/or
  - emitting a node that includes `resolvedByNodeId` linkage in its gap payload.

Projection rule (recommended):
- A gap is considered **resolved** if any later gap record references it via `resolvesGapId` or if a later node claims `resolvedByNodeId` for it.
- History remains visible; the “current state” is a projection.

---

## Mode behavior (normative)

WorkRail autonomy/modes must be a closed set, but this table assumes the three key behaviors:
- `guided`
- `full_auto_stop_on_user_deps`
- `full_auto_never_stop`

### Core rule: “blocked” only for user-only deps in stop-capable modes

| Situation | guided | full_auto_stop_on_user_deps | full_auto_never_stop |
|---|---|---|---|
| User-only dependency encountered | **blocked** with `UserOnlyDependency` | **blocked** with `UserOnlyDependency` | **continue**, record `gap_recorded(severity=critical, reason=user_only_dependency)` |
| Non-user-only missing input | do not block by default; prefer step-level contract enforcement | do not block by default; prefer step-level contract enforcement | continue + record `gap_recorded` if it materially affects integrity |
| Non-assumable choice required | **blocked** | **blocked** | continue with conservative default + record critical gap + durable disclosure of assumption |

### Special rule: `needs_user_choice` emission

`needs_user_choice` is only valid when:
- the workflow step explicitly declares the choice as **non-assumable**, and
- provides `choiceKind: NonAssumableChoiceKind`.

Otherwise:
- The agent is expected to choose a conservative default in full-auto and record a gap (`assumption_made`), rather than claiming the decision was user-only.

---

## Relationship to contracts and enforcement

Missing or invalid required step outputs are handled via output contract enforcement:
- In stop-capable modes: return `blocked` with a structured “missing required output” payload.
- In never-stop mode: continue and record a `gap_recorded(reason=required_output_missing_or_invalid, severity=critical)`.

This keeps “user-only deps” for truly user-provided constraints, and uses contracts for “the agent failed to provide required structured output.”

---

## Why this design

- Keeps full-auto real without hiding risk: gaps are durable, structured disclosures.
- Maintains sovereignty: non-assumable decisions are explicit and can block in stop-capable modes.
- Keeps the surface closed: enums over free-form strings; append-only over mutation; projections over pointers.
