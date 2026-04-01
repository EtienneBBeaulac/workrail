# Idea: Subagent Session Linking

## Status
Backlog

## Problem

When the main agent spawns a WorkRail Executor to run a routine or sub-workflow, that sub-session is completely disconnected from the parent session. There is no link between them in any durable or observable sense.

This means:
- The parent session has no record that a sub-session was spawned
- The sub-session has no record of who spawned it or why
- No traceability from parent to child executions
- No way to surface sub-session findings back into the parent session's durable record
- Debugging requires manually correlating session IDs across separate session files
- The WorkRail dashboard (if active) cannot show a unified execution tree

This is observable today: if you look at a parent session's event log, you see the agent completed a step that delegated to a routine. But you cannot see what happened inside that routine run, which steps it took, what it found, or whether it succeeded.

## Why It Matters Now

Extension points (`.workrail/bindings.json`) and templateCall both increase the role of routines and sub-workflows as first-class cognitive units. As workrail moves toward engine-driven delegation rather than NL prose delegation, the parent-child execution relationship will become more common and more critical to observe and debug.

The lack of session linking is currently masked because delegation is NL-driven and opaque anyway. Once engine-driven delegation exists, the absence of a parent-child link will become a first-class gap.

## Desired Behavior

When a sub-session is started by a WorkRail Executor that itself is running inside a parent session:

1. The sub-session should record its parent session ID and the parent step that triggered it
2. The parent session should record the sub-session ID and the routine/workflow that was delegated to
3. The link should be inspectable via the dashboard or `workrail inspect`
4. On session resume, the parent session should be able to surface a summary of what sub-sessions ran during its execution

## Design Questions

- Should linking be automatic (engine detects parent context from environment) or explicit (agent passes parent session ID when starting sub-session)?
- Should the sub-session's output artifacts be referenced in the parent session's event log?
- Should a failed sub-session propagate to the parent as a typed event?
- How does this interact with checkpoint/resume - if the parent is resumed, are sub-sessions re-run or their results re-used?
- What is the right data model - is this a tree (one parent per child) or a DAG (a sub-session could be invoked by multiple parents)?

## Relation to Other Ideas

- Extension points (`docs/design/workflow-extension-points.md`): once bindings resolve which routine fills a slot, session linking would make that delegation visible and traceable
- templateCall: templateCall inlines steps so no linking needed; session linking applies to delegation (black-box child runs), not injection
- Dashboard: the web dashboard would be the natural surface for visualizing the parent-child session tree
