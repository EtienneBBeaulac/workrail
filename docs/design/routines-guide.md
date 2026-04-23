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
Spawn ONE WorkRail Executor running `wr.routine-tension-driven-design` with your
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

A workflow references a routine via a `type: "template_call"` step, and the **compiler expands the routine's
steps inline** at compile time. The routine's steps become first-class workflow steps.

**When to use**: when routine steps should be visible in the workflow's step list, participate
in confirmation gates, and be tracked individually in the session.

**How it works**:
1. A workflow step declares a `type: "template_call"` step with the routine's template ID and args
2. At compile time, the template registry expands the routine into real steps
3. The expanded steps replace the template call step in the compiled workflow
4. `{arg}` placeholders in prompts are substituted; `{{contextVar}}` is preserved for runtime

**Template ID convention**:
- Routine `wr.routine-tension-driven-design` → template ID `wr.templates.routine.tension-driven-design`
- The `routine-` prefix is stripped automatically

**Example** (in workflow JSON):
```json
{
  "type": "template_call",
  "templateId": "wr.templates.routine.tension-driven-design",
  "args": {
    "deliverableName": "design-candidates.md"
  }
}
```

**What happens at compile time**:
- The step above is replaced by the routine's 5 steps (step-discover-philosophy, step-understand-deeply, etc.)
- Each expanded step ID is prefixed using the compiler's provenance/step identity rules
- `{deliverableName}` in prompts becomes `design-candidates.md`
- The routine's `metaGuidance` is injected as step-level `guidance` on each expanded step
- `preconditions` and `clarificationPrompts` are NOT included (parent workflow handles those)

**Constraints**:
- Routine steps must NOT contain nested `template_call` usage (no recursive injection)
- All `{arg}` placeholders must be satisfied by the template call's `args`
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

## Selection guidance

Choosing the right consumption mode matters as much as choosing the right routine.

### Default decision rule

Use this order unless you have a strong reason not to:

- **Use injection (`templateCall`) by default** when the routine is part of the parent workflow's authored structure.
- **Use delegation** when the routine's value comes from an independent perspective, parallelism, or an intentionally opaque bounded audit.
- **Use extension points only to make delegation seams overridable**, not as a substitute for routine injection.

A good litmus test:

- If you want the routine's **steps to appear in the parent workflow**, use **injection**.
- If you want the routine's **result but not its internal steps**, use **delegation**.
- If you want a team to **swap which delegated implementation is called** without forking the parent workflow, add an **extension point** around that delegated seam.

### What extension points do not do

`extensionPoints` and `{{wr.bindings.*}}` do **not** inject a routine into the parent workflow.

They only resolve a slot to a routine/workflow ID in prompt text at compile time. The parent agent still decides whether to call or follow that bound implementation at runtime.

Because binding resolution runs **after** template expansion, extension points cannot currently choose which routine gets injected via `templateCall`.

### Prefer delegation when

- an independent cognitive perspective adds value
- the parent can continue useful work in parallel
- the routine is acting as an auditor, challenger, or verifier
- the routine's internal steps do not need to be visible as first-class parent workflow steps

Common examples:

- context completeness / depth audits
- adversarial hypothesis challenge
- philosophy alignment review
- final verification from a fresh perspective

### Prefer direct execution when

- delegation overhead is not justified
- the current agent is already the natural executor
- step visibility is unnecessary
- the routine is mainly a reusable thinking scaffold, not a separate perspective

### Prefer injection when

- the routine's steps should be visible in the parent workflow
- confirmation behavior should apply per injected step
- session traceability matters
- the routine is central enough to the parent workflow that hiding it behind opaque delegation would reduce debuggability
- the author wants the engine, not the agent, to own that reusable subflow

Common examples:

- reusable design-generation cores
- reusable final-verification skeletons
- bounded reusable subflows the author wants Studio/session visibility for

## Auditor-first guidance

For many high-value routines, the best default mental model is **auditor**, not **task owner**.

That means the parent workflow:

- gathers or synthesizes the current state
- delegates a bounded audit/challenge/verification package
- interprets the returned artifact as evidence

not as canonical truth.

This is often a better fit than executor-style delegation for:

- review workflows
- planning workflows
- verification-heavy workflows

## High-value routine defaults

The current routine catalog suggests these default uses:

- `wr.routine-context-gathering`: completeness/depth audit or bounded context expansion
- `wr.routine-hypothesis-challenge`: adversarial challenge against the current leading story
- `wr.routine-execution-simulation`: bounded runtime/flow reasoning where mental execution adds value
- `wr.routine-philosophy-alignment`: review against user/repo principles
- `wr.routine-final-verification`: proof-oriented end-state validation

## Good and bad fits

### Good fit for delegation

- an adversarial reviewer challenging the current recommendation
- a philosophy/policy auditor checking alignment against repo rules
- a fresh final verifier evaluating whether evidence really supports the conclusion

### Bad fit for delegation

- tiny deterministic transformations that the parent can do faster directly
- parent-owned loop decisions or canonical synthesis
- work where hiding the internal steps would make the session harder to debug

### Good fit for injection

- a reusable multi-step authoring scaffold the parent wants visible in the step list
- a reusable verification sequence that should honor parent confirmation gates

### Bad fit for injection

- every small repeated instruction block
- routines whose value comes mainly from independent perspective rather than visible sub-steps

### Prefer extension points when

- the parent workflow intentionally delegates a bounded seam
- teams may want to replace that delegated implementation per project
- the parent workflow still owns synthesis, loop control, and final decisions

### Bad fit for extension points

- using `{{wr.bindings.*}}` where the real goal is inline routine structure
- hiding a core parent subflow behind a rebinding slot just to avoid hardcoding a routine ID
- expecting project bindings to change which routine a `templateCall` injects

## See Also

- `workflows/examples/routine-injection-example.json` — example workflow using injection
- `src/application/services/compiler/template-registry.ts` — injection implementation
- `src/application/services/compiler/routine-loader.ts` — routine loading from disk
