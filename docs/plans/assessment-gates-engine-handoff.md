# Assessment Gates Engine Handoff

## Status

This is a handoff document for a new agent picking up the **native assessment / decision gates** engine feature.

It is intentionally written as a **catch-up + execution-orientation** doc:

- what problem we are solving
- why it matters now
- what the current engine can and cannot do
- where to read first
- what not to accidentally do

This is **not** the final design spec. It is the best current starting point for a fresh agent.

## What this feature is

We want a **first-class engine feature** for structured assessments that can drive workflow behavior.

Today, workflows can only express confidence, readiness, or risk decisions in prose. The agent can write notes like:

- boundary confidence is low
- coverage confidence is medium
- we should continue because uncertainty remains

But the engine cannot reason over those assessments directly. That means:

- routing still depends on prompt interpretation
- confidence caps are prose-only
- follow-up triggers are prose-only
- traces can say what happened, but not cleanly expose the structured decision that drove it

The proposed feature is a **typed assessment / decision gate system** that lets:

- the **agent** assess named dimensions and provide short rationales
- the **engine** apply declared rules such as caps, routing outcomes, and follow-up triggers

## Why this is the next biggest engine win

This feature has high leverage because it unlocks better workflow behavior across multiple domains:

- **MR review**
  - confidence assessment
  - boundary/context/routing caps
  - block vs continue / follow-up decisions
- **planning**
  - readiness gates
  - “good enough to implement?” checks
- **debugging / investigation**
  - next-step routing based on confidence, evidence, or ambiguity
- **future explainability**
  - cleaner traceability of why the engine chose to continue, loop, or downgrade confidence

Compared with other ideas:

- it is more powerful than a workflow previewer because it improves **runtime behavior**, not just authoring UX
- it is more foundational than note scaffolding because it changes **decision quality and engine expressiveness**

## Problem statement

WorkRail currently has a gap between:

- what workflows want to say in a structured way
- and what the engine can actually enforce or reason over

Examples:

- a workflow wants to say “if boundary confidence is Low, final confidence cannot exceed Low”
- a workflow wants to say “if coverage confidence is Low, reopen targeted follow-up”
- a workflow wants to say “if readiness is Medium with one specific concern, continue; otherwise stop”

Today, those rules live in prompts and notes. That is useful, but weak:

- not compiler-validated
- not engine-enforced
- not structurally visible in runtime traces
- easy to drift across workflows

## Current recommendation

Build this as a **real engine feature**, not a tiny helper.

The intended shape is:

- **typed assessment definitions**
- **engine-applied gate rules**
- **durable traceability**
- **compiler/schema support**
- **reusable built-in or repo-owned assessment shapes**

This should be the **smallest complete thing worth living with**, not a toy MVP.

## What success looks like

A strong first version should support all of the following:

### 1. Typed assessment definitions

Workflows can declare assessment structures with:

- a stable name / reference
- named dimensions
- allowed levels
- rationale requirements

Examples:

- `confidenceAssessment`
- `readinessAssessment`
- `riskAssessment`

### 2. Engine-applied rules

The engine can consume a completed assessment and apply rules like:

- cap final confidence
- trigger follow-up
- continue vs stop
- reopen loop
- downgrade recommendation band

### 3. Durable execution visibility

Assessment results should be visible in durable execution history and usable for projection/trace surfaces.

That likely means:

- structured persistence
- explicit event(s)
- console/trace visibility later

### 4. Compiler/schema validation

Workflow definitions should be validated so authors cannot:

- reference missing dimensions
- reference invalid levels
- define malformed gate rules

### 5. Reuse

The feature should support either:

- inline assessment declarations
- reusable refs
- or both

without forcing every workflow to invent its own one-off matrix shape.

## Recommended product scope

### In scope for the first serious build

- a first-class assessment primitive such as:
  - `assessmentGate`
  - `assessmentRef`
  - or a closely-related name
- assessment dimensions with a closed set of allowed levels
- short rationale capture per dimension
- rule evaluation in the engine
- durable persistence / traceability
- compile-time validation
- a few good built-in patterns:
  - confidence
  - readiness
  - risk

### Out of scope for this feature

Do **not** bundle these into the first implementation:

- generic arbitrary decision-table engine
- engine-injected note scaffolding
- large UI/console preview work
- overly open-ended value types
- “anything can assess anything” without clear type boundaries

Those may come later, but they should not bloat the first solid implementation.

## Agent vs engine responsibility split

This split should remain sharp.

### Agent responsibilities

- assess each declared dimension
- choose one allowed level per dimension
- provide a short rationale
- submit the assessment result as part of workflow output / continuation

### Engine responsibilities

- validate the assessment shape
- validate levels and dimension names
- apply declared gate rules
- expose derived outcomes to later workflow behavior
- persist assessment facts durably
- record enough trace information to explain the decision path later

The engine should not replace the agent’s judgment. It should **formalize and enforce the consequences** of that judgment.

## What this is not

This is **not**:

- a generic policy engine for all workflow logic
- a replacement for prompts
- a free-form confidence essay system
- a note-formatting feature

It is a **structured decision layer** for a small class of decisions that are currently trapped in prose.

## Existing repo context

The idea already exists in the backlog:

- `docs/ideas/backlog.md`
  - **Native assessment / decision gates for workflows**
  - **Engine-injected note scaffolding** is now split out as a related follow-on idea

The MR review redesign work is one of the main reasons this feature is now compelling:

- `docs/plans/mr-review-workflow-redesign.md`

That doc now has a narrowed next slice with:

- compact confidence dimensions
- routing minimalism
- explicit engine-compatibility constraints

The main takeaway is:

- workflows want structured confidence/routing
- the current engine still forces those ideas to live in prompts

## Reading order for a new agent

If you are picking this up fresh, read in this order.

### 1. Repo workflow and operating rules

- `AGENTS.md`

Pay attention to:

- deliberate progression
- planning-doc expectations
- verification rules
- release rules

### 2. Normative execution semantics

- `docs/reference/workflow-execution-contract.md`

Focus on:

- token-driven execution
- continuation behavior
- blocked / continue semantics
- where optional capabilities and durable state already fit

### 3. Core durable engine design locks

- `docs/design/v2-core-design-locks.md`

Focus on:

- append-only truth model
- projections and durable state shape
- event philosophy
- anything that constrains new execution events or derived state

### 4. Workflow validation philosophy

- `docs/plans/workflow-validation-design.md`

Focus on:

- runtime/validation parity
- shared resolution logic
- why validation must mirror real engine behavior

This feature must not create a second “looks valid but runtime disagrees” layer.

### 5. Current assessment-gate backlog note

- `docs/ideas/backlog.md`

Find:

- **Native assessment / decision gates for workflows**

That captures the current product intuition and open questions.

### 6. MR review redesign context

- `docs/plans/mr-review-workflow-redesign.md`

Focus on:

- the narrowed implementation slice
- compact confidence model
- why structured routing/caps matter

## Code-reading path

### Authoring / workflow definition types

Start here:

- `src/types/workflow-definition.ts`

This is the key place to understand:

- what workflow definitions can express today
- existing step/loop/output-contract shapes
- where a new authoring primitive would naturally live

### Validation layer

Read:

- `src/application/services/validation-engine.ts`
- `spec/workflow.schema.json`

You need to understand both:

- runtime-side validation expectations
- schema-level authoring support

This repo has already hit real schema/compiler mismatches, so this feature must be introduced carefully and consistently.

### Compiler / template path

Read:

- `src/application/services/compiler/template-registry.ts`

Use this to understand how reusable authoring constructs are currently expanded/validated and whether assessment gates should participate in compilation directly.

### Engine/runtime surfaces

Read:

- `src/engine/index.ts`
- `src/engine/types.ts`
- `src/engine/engine-factory.ts`

The goal is to find the right place for:

- assessment results
- derived outcomes
- execution integration

### MCP output / trace surfaces

Read:

- `src/mcp/step-content-envelope.ts`
- `src/mcp/v2-response-formatter.ts`
- `src/mcp/output-schemas.ts`

Assessment gates likely do not need first-class agent-facing prose immediately, but they should fit the existing response/contract model cleanly.

### Projections / durable views

Read:

- `src/v2/projections/`

Especially anything around:

- run status
- preferences
- DAG state
- node outputs

You want to understand how a structured assessment result would appear in durable projections later.

## Design constraints that matter

### 1. Runtime/validation parity is mandatory

Do not design an assessment feature that:

- validates in schema
- but is not truly enforced in runtime

or the reverse.

### 2. Keep the engine/agent split clean

The agent assesses.

The engine applies gate rules.

Do not let the engine become a generic policy brain.

### 3. Avoid giant generality

A real feature does **not** mean a universal decision-language.

Prefer:

- typed, bounded, closed-set constructs

over:

- open-ended user-programmable rule DSLs

for the first serious implementation.

### 4. Preserve traceability

One of the biggest benefits of this feature is explainability.

If the engine applies a cap or follow-up trigger from an assessment, that should be traceable later.

### 5. Keep note scaffolding separate

This came up during design discussion, but it is a separate feature.

Do not quietly smuggle note-structure requirements into assessment gates just because they are adjacent concepts.

## Recommended first design pass

The first real design pass should answer these questions explicitly.

### Authoring shape

- Is the core primitive inline, referenced, or both?
- What is the minimum stable declaration shape?
- How are dimensions declared?
- How are allowed levels declared?

### Runtime behavior

- When does the engine evaluate the gate?
- What inputs does it consume?
- What outputs does it produce for later steps/conditions?
- How are gate outcomes persisted?

### Validation

- What can schema validate?
- What must runtime validate?
- How do we prevent authoring/runtime drift?

### Traceability

- What event(s) or durable records are emitted?
- What do projections need to expose later?
- What should console/trace surfaces eventually show?

### Reuse

- What built-in assessment families should exist first?
- What does inline-only authoring lose?
- What should refs buy us?

## Good first built-in families

If built-ins are included in the first proper version, the best candidates are:

- **confidence assessment**
- **readiness assessment**
- **risk assessment**

These are broad enough to matter across workflows, but still conceptually tight.

## Suggested non-goals for the first implementation

Keep these explicitly out unless the user directs otherwise:

- arbitrary free-form scoring systems
- weighted math-heavy assessment engines
- bundled UI work for previewing assessments
- note scaffolding
- generalized business-rule language

## Known risks

### Over-generalization

The biggest risk is building something too generic too early.

That would likely:

- slow adoption
- complicate schema/compiler work
- blur the engine/agent boundary

### Validation drift

If schema, compiler, and runtime do not all agree on the feature shape, confidence in the system will drop quickly.

### Trace debt

If the engine uses assessment outcomes internally but they are not visible in durable traces, the feature will feel magical and hard to debug.

## A good end state

By the end of the first solid implementation, a workflow author should be able to say:

- here are the dimensions
- here are the allowed levels
- here are the gate rules

And the engine should be able to:

- validate the shape
- accept the agent’s assessment
- apply the gate outcomes
- persist the result
- explain later what happened

## Immediate next step for a new agent

Do **not** jump straight to implementation.

First:

1. read the docs/code listed above
2. write a compact design note or plan that proposes:
   - authoring shape
   - runtime behavior
   - validation shape
   - persistence/trace model
   - non-goals
3. compare at least two design options:
   - narrower typed gate
   - slightly more reusable ref-based model
4. bring the tradeoffs back to the user before coding

That is the right restart point.
