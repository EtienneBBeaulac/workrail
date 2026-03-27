# Workflow Extension Points — Bounded Composability for User-Authored Phase Implementations

## Problem

WorkRail workflows are most valuable when they are both:

- **opinionated** enough to encode strong defaults and best practices
- **customizable** enough for users and teams to inject their own process where it matters

Today, customization often means:

- cloning a large workflow
- editing many unrelated steps
- drifting away from upstream improvements
- losing the safety and consistency of the original orchestration

That is a poor tradeoff. Users should not need to fork a full task-dev workflow just to customize:

- design review
- planning
- final verification
- a domain-specific review phase

## Goal

Allow a parent workflow to expose **bounded extension points** where a user can provide a compatible workflow or routine implementation.

The parent workflow should still own:

- overall sequencing
- confirmation policy
- loop control
- context model
- final decisions
- safety boundaries

The extension implementation should own only a **bounded cognitive unit**.

## Non-goals

This is **not**:

- arbitrary nested workflow execution
- unrestricted recursion
- child workflows mutating parent state freely
- user-defined replacements for the entire parent orchestration
- a mechanism to bypass parent safety or confirmation behavior

## Better framing

The right mental model is not:

- "a workflow can run another workflow"

The better model is:

- **the parent workflow defines extension points**
- **the user provides a compatible phase implementation**

This is closer to:

- pluggable cognitive modules
- strategy selection for bounded phases
- user-authored phase implementations

## Core idea

A parent workflow can declare one or more **extension slots**. Each slot has:

- a stable identifier
- a purpose
- an input contract
- an output contract
- allowed implementation kinds
- guardrails

Example slots in a task-dev workflow:

- `design_generation`
- `design_review`
- `plan_audit`
- `final_verification`

The parent can then say:

- use the default implementation
- or use a user-supplied compatible implementation

## Why this is powerful

This unlocks:

- **safe customization without forking**
- **team-specific process modules**
- **domain-specific cognitive steps**
- **better reuse across workflows**
- **faster experimentation**
- **shared orchestration with custom policy**

Instead of copying a 300-line workflow just to change one phase, a user could say:

- use my architecture review for `design_review`
- use my release-readiness verifier for `final_verification`
- use my migration planner for `plan_audit`

## Parent-child responsibility split

### Parent workflow owns

- the order of phases
- whether a slot is invoked
- whether QUICK / STANDARD / THOROUGH changes behavior
- confirmation and user pauses
- loop decisions
- synthesis into canonical workflow state
- final go/no-go decisions

### Child implementation owns

- the bounded internal reasoning for that phase
- the artifact or structured output promised by the slot contract
- the internal step sequence of the phase implementation

### Important rule

The child produces **evidence and recommendations**.

The parent still interprets the result and decides what to do next.

## When to expose an extension point

Extension points are powerful, but they should stay **bounded and high-value**.

A slot earns its place when customization would materially improve one of these:

- domain-specific judgment
- team-specific policy or philosophy alignment
- final verification quality
- reusable review/generation policy that multiple teams may want to swap

Avoid creating slots for:

- generic utility delegations
- low-value one-off steps
- phases where the parent should obviously keep full ownership with no meaningful team variation

Good default rule:

- expose customization where teams genuinely differ
- keep utility cognition hardcoded where variation would mostly add complexity

Examples:

- **good slot**: `final_verification`, where teams may want different release/readiness standards
- **good slot**: `philosophy_review`, where repo-specific principles genuinely vary
- **bad slot**: generic capability probing, because the variation is low and the utility behavior should stay standardized
- **bad slot**: parent loop decision logic, because parent-owned control flow should remain canonical

## Structured freedom at the extension boundary

Extension points should preserve the same balance as the parent workflow:

- **rigid on contracts and parent-owned control flow**
- **adaptive inside the bounded child implementation**

That means:

- the parent owns sequencing, loop control, canonical synthesis, and final decisions
- the child owns bounded reasoning inside the slot contract
- the child returns evidence/recommendations, not parent workflow truth

## Extension point declaration

The parent workflow declares extension points as a top-level field alongside `steps`:

```json
{
  "id": "coding-task-workflow-agentic",
  "version": "2.2.0",
  "extensionPoints": {
    "design_review": {
      "purpose": "Review a selected design for tradeoff quality, failure modes, simpler alternatives, and philosophy alignment.",
      "defaultBinding": "routine-design-review",
      "acceptedKinds": ["routine", "workflow"],
      "inputContract": {
        "requiredContext": ["selectedApproach", "acceptedTradeoffs", "identifiedFailureModes"],
        "optionalContext": ["runnerUpApproach", "philosophySources"]
      },
      "outputContract": {
        "requiredArtifacts": ["design-review-findings.md"]
      }
    },
    "plan_audit": {
      "purpose": "Audit implementation plan for completeness, risk, and philosophy alignment.",
      "defaultBinding": "routine-plan-analysis",
      "acceptedKinds": ["routine", "workflow"],
      "inputContract": {
        "requiredContext": ["implementationPlan", "slices", "invariants"],
        "optionalContext": ["philosophySources"]
      },
      "outputContract": {
        "requiredArtifacts": ["plan-audit-findings.md"]
      }
    },
    "final_verification": {
      "purpose": "Verify implementation against acceptance criteria, invariants, and philosophy.",
      "defaultBinding": "routine-final-verification",
      "acceptedKinds": ["routine", "workflow"],
      "inputContract": {
        "requiredContext": ["implementationPlan", "acceptanceCriteria", "invariants"],
        "optionalContext": ["philosophySources"]
      },
      "outputContract": {
        "requiredArtifacts": ["final-verification-findings.md"]
      }
    }
  },
  "steps": []
}
```

Each extension point has:

- a stable key used as the slot identifier
- a `purpose` describing the cognitive role
- a `defaultBinding` pointing to the built-in routine/workflow
- `acceptedKinds` constraining what can fill the slot
- `inputContract` declaring what context the implementation receives
- `outputContract` declaring what the implementation must produce

## Child compatibility declaration

A routine or workflow declares what it accepts and produces using an `extensionContract` field:

```json
{
  "id": "my-team-security-review",
  "kind": "routine",
  "extensionContract": {
    "accepts": ["selectedApproach", "acceptedTradeoffs", "identifiedFailureModes"],
    "produces": ["design-review-findings.md"]
  },
  "steps": []
}
```

The compiler validates structurally:

- the child's `accepts` includes all `requiredContext` from the slot's `inputContract`
- the child's `produces` includes all `requiredArtifacts` from the slot's `outputContract`
- the child's kind matches `acceptedKinds`

Compatibility is determined by contract structure, not by slot name. A child that accepts the right inputs and produces the right outputs is compatible with any slot whose contract it satisfies -- without knowing the slot's name.

This means a security review routine is reusable across any parent workflow that exposes a slot with the same contract, regardless of what that slot is called. The user's binding config is the intent signal; the contract is the safety check.

A child without `extensionContract` cannot be bound to any extension point.

## Compiler integration

Extension point bindings are resolved at compile time through the existing ref resolution pass.

### Why not step-level fields

Workflows reference routines by name in prompt prose, often across multiple steps. A single `extensionPoint` field on one step is insufficient. For example, `design_review` logic is referenced in Phase 1 (architecture decision), Phase 2 (design review loop), and Phase 2's delegation instructions.

### Binding refs

The compiler resolves binding references using a new ref kind: `wr.bindings.<slotId>`.

Workflow authors use these refs in prompt text instead of hardcoding routine names:

```
spawn ONE WorkRail Executor running `{{wr.bindings.design_review}}`
```

The compiler replaces these refs with the resolved routine/workflow ID during the existing `resolveRefsPass`. This means:

- binding resolution is global (works across all steps)
- resolved bindings are automatically included in the compiled hash
- no new compiler infrastructure is needed beyond a new ref kind in `ref-registry.ts`

### What is rebindable

Only routines/workflows listed in `extensionPoints` are rebindable. All other routine references (e.g., `routine-context-gathering`, `routine-execution-simulation`) remain hardcoded. The distinction between extension points and utility delegations must be explicit.

## Implementation kinds

### 1. Routine implementation

Best for:

- reusable bounded cognitive units
- lightweight, reusable, well-scoped review/generation tasks

Examples:

- `routine-design-review`
- `routine-final-verification`
- `routine-tension-driven-design`

### 2. Workflow implementation

Best for:

- user-authored multi-step variants with richer internal structure
- team-specific process modules
- domain-specific quality bars that exceed a routine’s scope

These should still be **bounded by the slot contract** and should not be allowed to take over parent orchestration.

## Guardrails

To make this safe, the engine should enforce:

### Contract compatibility

Before composition:

- validate required inputs are available
- validate the child declares compatibility with the slot
- validate required outputs are produced

### No arbitrary state mutation

The child should not write arbitrary parent context.

It should only be allowed to:

- emit declared artifacts
- optionally emit declared slot-scoped outputs

The parent then maps those outputs into workflow-owned decisions.

### No uncontrolled loops

The child implementation may have internal loops, but:

- loop behavior must remain inside the child boundary
- parent loop control remains parent-owned
- the child must not alter parent loop policy

### No recursive chaos

At minimum:

- prevent cycles
- prevent unbounded nested composition
- cap depth of composed implementations

The safe default is to keep composition depth shallow.

### Loop correctness

When a custom implementation fills a slot inside a loop body, it must honor the loop control contract. The custom implementation must not:

- produce artifacts that confuse the loop decision step
- break loop exit conditions
- emit loop control artifacts that the parent doesn't expect

The parent's loop decision step remains the sole authority on whether to continue or exit.

### Error handling and fallback

When a custom implementation fails (crashes, times out, or produces output that doesn't satisfy the output contract):

1. Log the failure with full context (slot ID, bound implementation, error)
2. Fall back to the slot's default implementation
3. Mark the fallback in provenance: `"design_review: fallback-to-default (original failed)"`
4. Continue parent workflow execution

The parent workflow must not crash because a child implementation failed. Fallback-to-default is the safe default policy.

### Parent confirmation policy wins

Child implementations should not be able to unexpectedly introduce:

- extra user pauses
- extra merges/pushes/commits
- parent-level confirmation gates

Those remain parent-owned.

## Determinism and hashing

Compiled workflow identity must include:

- the parent workflow
- the selected implementation for each slot
- the compiled child content

Changing a child implementation must change the compiled hash of any parent workflow that uses it.

The compiled workflow should include a **binding manifest**:

```json
{
  "bindingManifest": {
    "design_review": {
      "resolvedTo": "my-team-security-review",
      "source": "project-config",
      "kind": "routine",
      "hash": "sha256:abc123..."
    },
    "plan_audit": {
      "resolvedTo": "routine-plan-analysis",
      "source": "default",
      "kind": "routine",
      "hash": "sha256:def456..."
    }
  }
}
```

This is required for:

- determinism
- reproducibility
- provenance
- debugging

### Session resumption

The binding manifest must be part of the session snapshot. When a workflow session is resumed (cross-chat), the bindings that were active at checkpoint time must be restored exactly. The resumed session must not silently pick up different bindings from a changed project config.

## Visibility and provenance

Users and agents should be able to see:

- which extension slots were active
- which implementation filled each slot
- whether it was a routine or workflow
- where it came from
- what hash/version was used

Without this, debugging becomes too opaque.

## UX model

The user experience should feel like:

- "Use `coding-task-workflow-agentic`"
- "For `design_review`, use `my-team-security-review`"

Not:

- "Build a deeply nested workflow graph manually"

The system should support:

- defaults
- project-scoped overrides
- user-provided implementations
- explicit per-run overrides

### Configuration format

Project-level overrides live in `.workrail/bindings.json`:

```json
{
  "coding-task-workflow-agentic": {
    "design_review": "my-team-security-review",
    "final_verification": "workflow-release-readiness-review"
  }
}
```

Per-run overrides via CLI:

```bash
workrail start coding-task-workflow-agentic \
  --bind design_review=my-team-security-review
```

### Resolution order

1. CLI `--bind` override (highest priority)
2. `.workrail/bindings.json` project config
3. `extensionPoints[slot].defaultBinding` in workflow JSON (lowest priority)

### Discoverability

`workrail inspect --extension-points <workflow-id>` should show:

- all declared extension slots
- each slot's purpose and contract
- the currently active binding and its resolution source
- whether the binding is default or overridden

## Suggested first version

Start narrow.

Support only a small set of extension slots in a parent workflow:

- `design_review`
- `plan_audit`
- `final_verification`

Why these first:

- naturally bounded
- high customization value
- low orchestration risk
- already close to routine-shaped in task-dev workflows

Avoid starting with:

- full implementation phases
- parent workflow replacement
- arbitrary slot definitions everywhere

## Relation to routines and injection

This builds directly on the existing routine model:

- routines remain the default reusable bounded implementations
- injection remains a valid way to inline a known implementation
- delegation remains valid when parallelism is desired

What changes is that the **implementation for a slot becomes configurable**.

So the parent is no longer hardcoded to one routine or one inline prompt.

It is bound to:

- a slot
- a contract
- a selected compatible implementation

## Example (end-to-end)

### 1. Parent workflow declares the slot and uses a binding ref

In the parent workflow JSON:

```json
{
  "extensionPoints": {
    "final_verification": {
      "purpose": "Verify implementation against acceptance criteria, invariants, and philosophy.",
      "defaultBinding": "routine-final-verification",
      "acceptedKinds": ["routine", "workflow"],
      "inputContract": {
        "requiredContext": ["implementationPlan", "acceptanceCriteria", "invariants"]
      },
      "outputContract": {
        "requiredArtifacts": ["final-verification-findings.md"]
      }
    }
  },
  "steps": [
    {
      "id": "phase-7a-verify-and-fix",
      "title": "Verify Integration and Fix Issues",
      "prompt": "Perform integration verification.\n\nDelegate to `{{wr.bindings.final_verification}}` for the core verification pass.\n\nInterpret the findings artifact and decide whether to fix, re-verify, or hand off."
    }
  ]
}
```

### 2. User provides a custom implementation that declares its contract

```json
{
  "id": "workflow-release-readiness-review",
  "kind": "workflow",
  "extensionContract": {
    "accepts": ["implementationPlan", "acceptanceCriteria", "invariants"],
    "produces": ["final-verification-findings.md"]
  },
  "steps": []
}
```

### 3. User configures the binding

In `.workrail/bindings.json`:

```json
{
  "coding-task-workflow-agentic": {
    "final_verification": "workflow-release-readiness-review"
  }
}
```

### 4. Compiler resolves the binding

The compiler:

1. Loads `extensionPoints` from the parent workflow
2. Resolves `final_verification` to `workflow-release-readiness-review` (from project config)
3. Validates that `workflow-release-readiness-review` has an `extensionContract` whose `accepts` covers the slot's `requiredContext` and whose `produces` covers the slot's `requiredArtifacts`
4. Validates that its kind (`workflow`) matches `acceptedKinds`
5. Replaces `{{wr.bindings.final_verification}}` with `workflow-release-readiness-review` in all prompt text
6. Includes the resolved binding in the binding manifest and compiled hash

### 5. Runtime

At runtime, the agent reads the compiled prompt which now says:

> "Delegate to `workflow-release-readiness-review` for the core verification pass."

The agent delegates via the WorkRail Executor as it would for any routine or workflow. No runtime changes are needed. Extension point resolution is entirely a compile-time concern.

### 6. Parent interprets the result

The parent workflow:

- receives `final-verification-findings.md` from the child
- interprets the findings
- decides whether to fix, re-verify, or hand off

The child does not own the final workflow decision.

## Risks

### 1. Hidden behavior

If it becomes hard to see which implementation is active, users lose trust.

### 2. State drift

If outputs are not tightly contracted, parent assumptions break.

### 3. Over-composition

Too many extension points make workflows hard to reason about.

### 4. User-authored child workflows breaking invariants

Compatibility must be validated, not trusted.

## Design principle

The system should optimize for:

- **bounded composability**
- **parent-owned orchestration**
- **typed contracts**
- **visible provenance**

It should avoid:

- arbitrary workflow nesting
- unconstrained child behavior
- hidden state sharing

## Recommended terminology

Prefer:

- **workflow extension points**
- **phase implementations**
- **pluggable cognitive modules**

Avoid centering the concept around:

- nested workflows
- workflow running workflow

The bounded phase implementation framing leads to a better system design.

## Suggested next steps

1. Register `wr.bindings.*` as a new ref kind in `ref-registry.ts`
2. Add `extensionPoints` parsing to the workflow definition schema
3. Implement binding resolution in `resolveRefsPass` (global, across all steps)
4. Add `.workrail/bindings.json` loading and resolution chain (CLI > project > default)
5. Include binding manifest in compiled workflow hash and session snapshot
6. Add `workrail inspect --extension-points` command
7. Convert `coding-task-workflow-agentic` prompt text to use `{{wr.bindings.*}}` refs for the initial 3 slots
8. Add slot compatibility metadata to routines/workflows
9. Implement contract validation (required inputs available, required outputs produced)
