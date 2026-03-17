# Routines Guide — Three Consumption Modes

Routines are reusable cognitive workflows defined as JSON in `workflows/routines/`.
They can be consumed in three ways, each suited to different orchestration needs.

## Mode 1: Delegation (WorkRail Executor)

The primary agent delegates a routine to a **WorkRail Executor subagent** at runtime.
The subagent runs the routine's steps independently and returns output to the parent.

**When to use**: bounded cognitive tasks (design generation, hypothesis challenge, plan analysis)
where the parent agent wants to continue working in parallel.

**How it works**:
1. Parent agent spawns a WorkRail Executor with a `routineId`
2. The executor runs the routine's steps sequentially
3. Output flows back to the parent via the session

**Example** (in a workflow step prompt):
```
Spawn ONE WorkRail Executor running `routine-tension-driven-design` with your
tensions, philosophy sources, and problem understanding as input.
```

## Mode 2: Direct Execution (Agent Follows Steps)

An agent reads the routine definition and **follows its steps directly** as structured guidance.
No subagent spawning — the agent itself executes each step in sequence.

**When to use**: when the agent IS the executor (e.g., inside a WorkRail Executor session),
or when delegation overhead isn't justified.

**How it works**:
1. Agent loads the routine JSON
2. Agent executes each step's prompt in order
3. Agent produces the deliverable described in the final step

## Mode 3: Injection (Compile-Time Template Expansion)

A workflow references a routine via `templateCall`, and the **compiler expands the routine's
steps inline** at compile time. The routine's steps become first-class workflow steps.

**When to use**: when routine steps should be visible in the workflow's step list, participate
in confirmation gates, and be tracked individually in the session.

**How it works**:
1. A workflow step declares a `templateCall` with the routine's template ID and args
2. At compile time, the template registry expands the routine into real steps
3. The expanded steps replace the templateCall step in the compiled workflow
4. `{arg}` placeholders in prompts are substituted; `{{contextVar}}` is preserved for runtime

**Template ID convention**:
- Routine `routine-tension-driven-design` → template ID `wr.templates.routine.tension-driven-design`
- The `routine-` prefix is stripped automatically

**Example** (in workflow JSON):
```json
{
  "id": "phase-1-design",
  "title": "Phase 1: Design",
  "templateCall": {
    "templateId": "wr.templates.routine.tension-driven-design",
    "args": {
      "deliverableName": "design-candidates.md"
    }
  }
}
```

**What happens at compile time**:
- The step above is replaced by the routine's 5 steps (step-discover-philosophy, step-understand-deeply, etc.)
- Each expanded step ID is prefixed: `phase-1-design.step-discover-philosophy`
- `{deliverableName}` in prompts becomes `design-candidates.md`
- The routine's `metaGuidance` is injected as step-level `guidance` on each expanded step
- `preconditions` and `clarificationPrompts` are NOT included (parent workflow handles those)

**Constraints**:
- Routine steps must NOT contain `templateCall` (no recursive injection)
- All `{arg}` placeholders must be satisfied by `templateCall.args`
- Arg values must be primitives (string, number, boolean) — objects/arrays are rejected

## Comparison

| Aspect | Delegation | Direct Execution | Injection |
|---|---|---|---|
| When resolved | Runtime | Runtime | Compile time |
| Parallelism | Yes (subagent) | No | N/A (steps are inline) |
| Step visibility | Opaque to parent | Transparent | Fully visible |
| Confirmation gates | Subagent only | Agent decides | Per-step as authored |
| Session tracking | Separate session | Same session | Same session, per-step |
| Arg substitution | Via context | Via context | `{arg}` → compile-time |

## See Also

- `workflows/examples/routine-injection-example.json` — example workflow using injection
- `src/application/services/compiler/template-registry.ts` — injection implementation
- `src/application/services/compiler/routine-loader.ts` — routine loading from disk
