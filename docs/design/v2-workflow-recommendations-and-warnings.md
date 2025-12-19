# WorkRail v2: Workflow Recommendations + Warnings (Pinned, Closed Set)
**Status:** Draft (intended to be locked)  
**Date:** 2025-12-19

This document locks the v2 design for:
- **Workflow recommendations** (suggested safe automation posture)
- **Warnings** (structured, durable, non-blocking feedback when user-selected preferences exceed recommendations)

Goal: preserve user sovereignty (**no hard blocks**) while keeping execution explainable and deterministic across rewinds and export/import.

---

## Core decision (normative)

Workflow recommendations are part of the **compiled workflow snapshot** and therefore part of the pinned determinism surface:
- Recommendations must be included in the fully expanded compiled workflow used to compute `workflowHash`.
- A given run pinned to a `workflowHash` must see the same recommendations and warnings on any machine after export/import.

Rationale:
- If recommendations drift out-of-band, the same run would emit different warnings depending on environment/version, undermining v2’s “deterministic and explainable” feel.

---

## What recommendations can recommend (closed set)

Recommendations are limited to WorkRail-defined closed-set values. No workflow-defined free-form policy bags.

### `recommendedAutonomy` (closed enum)
- `guided`
- `full_auto_stop_on_user_deps`
- `full_auto_never_stop`

### `recommendedRiskPolicy` (closed enum)
- `conservative`
- `balanced`
- `aggressive`

Optional (recommended, still closed):
### `warningCodes` (closed enum set)
WorkRail owns a closed set of warning codes that workflows may reference. Example initial codes:
- `automation_exceeds_recommendation`
- `never_stop_requires_disclosure`
- `capability_required_but_unknown`
- `capability_required_but_unavailable`

Notes:
- Workflows may supply short copy text per warning (for UX), but the warning identity and semantics are keyed by the closed `warningCode`.

---

## When warnings are emitted (normative)

WorkRail emits warnings when user-selected effective preferences are more aggressive than the workflow recommendation.

Definition:
- “More aggressive autonomy” is a partial order:
  - `guided` < `full_auto_stop_on_user_deps` < `full_auto_never_stop`
- “More aggressive risk” is:
  - `conservative` < `balanced` < `aggressive`

Rule:
- If `effective.autonomy` is more aggressive than `workflow.recommendedAutonomy`, emit warning `automation_exceeds_recommendation`.
- If `effective.riskPolicy` is more aggressive than `workflow.recommendedRiskPolicy`, emit the same warning (or a distinct code if we later split).

Non-rule:
- WorkRail must never hard-block a user-selected mode. Warnings must be loud and structured, but user choice wins.

---

## How warnings are represented (structured, durable)

Warnings must be:
- **Structured** (closed code + typed payload)
- **Durable** (recorded on the run graph at the node where they occur)
- **Text-first** (a short textual summary is always provided for agent UX)

Recommended data shape:
- `warningCode`
- `summary` (one line)
- `whyItMatters` (short)
- `recommendedPrefs` (typed snapshot; what WorkRail considers safest)
- `effectivePrefs` (typed snapshot; what the user selected)

Durability:
- Warnings are recorded as node-attached durable data (event or artifact), so Console and exports can render “what happened and why” without transcript access.

---

## Interaction with gaps and user-only dependencies

Warnings do not replace gaps.
- Under `full_auto_never_stop`, user-only dependencies and required output failures produce **gaps** (not blocks).
- Warnings can co-occur with gaps: e.g., user chooses never-stop beyond recommendation; WorkRail warns, then execution continues with durable gaps for any missing user-only inputs.

---

## Guardrails (to prevent drift)

- Recommendations must not affect correctness or engine semantics; they only influence warnings/recommended presets.
- Any expansion of warning codes is an explicit WorkRail change (closed-set discipline).
- Avoid encoding workflow-specific heuristics into generic warning semantics; keep codes small and composable.
