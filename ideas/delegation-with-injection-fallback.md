# Idea: Engine-Driven Delegation with Inline Injection Fallback

## Status
Backlog

## Problem

Routine delegation in WorkRail is currently NL-driven: the main agent reads a prose instruction ("spawn ONE WorkRail Executor running `routine-X`") and decides whether and how to spawn a subagent. This is fragile — the agent may ignore the instruction, misinterpret it, or fail to spawn correctly depending on the model and client environment.

Additionally, some environments cannot spawn subagents at all:
- MCP clients that don't support nested/recursive tool calls
- Environments where `agenticRoutines` is disabled
- Cost-constrained or embedded contexts
- Models that don't reliably follow delegation instructions

When delegation fails silently, the routine is simply skipped — no error, no fallback, no structured execution. The phase is lost.

`templateCall` exists as a compile-time injection mechanism (main agent executes routine steps inline) but it serves a different purpose: it is for main-agent-owned cognitive work, not independent subagent perspective. Using templateCall for routines that require independence (hypothesis-challenge, plan-analysis, design-review) degrades quality, but it is strictly better than skipping the phase entirely.

## Desired Behavior

A step should be able to declare:
1. A **delegation intent** — spawn a subagent to run this routine (primary, when available)
2. An **injection fallback** — inline the routine steps for the main agent (when subagent unavailable)

The engine resolves at runtime:
- Subagent spawning available → engine-driven delegation (fresh subagent gets routine steps)
- Subagent spawning unavailable → templateCall-style injection (main agent executes inline)

## Proposed Step Shape

```json
{
  "id": "phase-5-diagnosis-validation",
  "title": "Diagnosis Validation",
  "delegation": {
    "routine": "routine-hypothesis-challenge",
    "args": { "deliverableName": "hypothesis-challenge-findings.md" }
  },
  "injectionFallback": {
    "templateId": "wr.templates.routine.hypothesis-challenge",
    "args": { "deliverableName": "hypothesis-challenge-findings.md" }
  }
}
```

## Degradation Spectrum

| Mode | Who executes | Independent? | Reliable? |
|---|---|---|---|
| Engine-driven delegation | Fresh subagent | Yes | Yes |
| NL delegation (current) | Fresh subagent (if agent follows) | Yes | Fragile |
| Injection fallback | Main agent | No | Yes |
| Nothing (current failure mode) | Nobody | No | - |

Independence degrades gracefully — you lose fresh-context isolation but keep structured execution and artifact production.

## What Needs to Be Built

1. **`delegation` step field** in schema and `WorkflowStepDefinition` type
2. **`injectionFallback` step field** in schema — same shape as `templateCall`
3. **Subagent availability detection** in the engine — determine at session start or step execution time whether spawning is supported
4. **Engine-driven delegation execution** — engine spawns subagent, hands it the routine's steps, waits for artifacts, validates output contract
5. **Fallback resolution** — when delegation unavailable, compile/expand injection fallback inline

## Relation to Other Ideas

- **Subagent session linking** (`subagent-session-linking.md`): engine-driven delegation is a prerequisite for session linking — the engine must know a subagent was spawned to link the sessions
- **Extension points** (`docs/design/workflow-extension-points.md`): bindings resolve which routine fills a slot; delegation + fallback determines how that routine executes
- **templateCall**: remains the right primitive for main-agent-owned inline work; injection fallback reuses the same mechanism but as a secondary path, not the primary
