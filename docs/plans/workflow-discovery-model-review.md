# Workflow Discovery Model: Design Review Findings

## Tradeoff Review

| Tradeoff | Verdict | Condition of failure |
|---|---|---|
| Single-category assignment per workflow | Acceptable | If a workflow genuinely spans two unrelated domains (none currently do) |
| `when` phrases at category level | Acceptable | If phrases written lazily rather than specifically |
| Two-call pattern | Acceptable | Agents already willing to make second calls; first call is cheap |

## Failure Mode Review

| Mode | Risk | Coverage |
|---|---|---|
| `when` phrases too coarse | Medium — content quality risk | Write phrases with concrete examples, not abstractions |
| Descriptions not updated | Medium | A+B ship together in same PR |
| Multi-fit miscategorization | Low | `when` phrases can overlap across categories |

**Highest risk**: lazy `when` phrases. Quality of this content determines whether the first call actually helps agents.

## Runner-Up / Simpler Alternative Review

- Runner-up (C evolved) has nothing to borrow now; it's the pivot condition if B proves insufficient
- Simpler variant (A only) doesn't solve 500-token first call
- **Hybrid opportunity**: add small `examples` array per category (1-2 specific workflow IDs) alongside `when`. Lets experienced agents short-circuit the second call. Low cost, high value.

## Philosophy Alignment

All principles satisfied: determinism (explicitly authored), YAGNI, explicit domain types, validate-at-boundaries.

## Findings

**Yellow — `when` phrase quality is load-bearing**
The entire value of B depends on `when` phrases being written specifically enough for agents to match ('before merging a PR', not 'reviewing code'). No structural enforcement exists. Add authoring guidelines as comments in `spec/workflow-categories.json`.

**Yellow — `examples` field is a low-cost improvement**
Adding 1-2 representative workflow IDs per category in the summary response lets agents short-circuit the second call if they recognize a workflow name. Should be included in the design.

## Recommended Revisions

1. Add `examples: string[]` (1-2 workflow IDs) to each category entry in `spec/workflow-categories.json` and the `categorySummary` response
2. Add authoring guidelines as comments in `spec/workflow-categories.json` explaining how to write good `when` phrases
3. Descriptions (A component) must ship in same PR as B

## Residual Concerns

- Per-workflow triggers (C evolved) remains the right pivot if `when` phrases prove too coarse after real usage
- `workrail://categories` MCP resource should expose `when` phrases so agents can read them before calling `list_workflows`
