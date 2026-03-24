# Content Coherence and Linked References

> **Active initiative plan**
>
> Canonical design and slice plan for increasing coherence across WorkRail's content delivery seams
> and introducing workflow-declared linked references.

**Status**: Implemented (slices 1–6 complete)
**Date**: 2026-03-22
**Completed**: 2026-03-22

---

## Problem

WorkRail has grown six independent mechanisms for injecting content into what the agent sees at execution time:

| Seam | Phase | Declared on | Override mechanism |
|---|---|---|---|
| Extension points / bindings | Compile-time | `WorkflowDefinition.extensionPoints` | `.workrail/bindings.json` |
| Features | Compile-time | `WorkflowDefinition.features` | None (closed set) |
| Refs (`wr.refs.*`) | Compile-time | `promptBlocks` parts | None (closed set) |
| Context templates (`{{varName}}`) | Render-time | Inline in prompt text | Session context |
| Prompt fragments | Render-time | `WorkflowStepDefinition.promptFragments` | Session context conditions |
| Response supplements | Transport-time | Hardcoded in `response-supplements.ts` | None |
| `metaGuidance` | Always visible | `WorkflowDefinition.metaGuidance` | None |

Each seam was well-motivated in isolation, but they share no vocabulary, no resolution protocol, and no unified introspection surface. An author deciding "where does this content belong?" must understand all of them and their interactions.

Additionally, there is no first-class way for a workflow to point at authoritative external documents (schemas, authoring specs, team guides, playbooks) without inlining content into the prompt or metaGuidance strings.

## Goal

1. Introduce a **typed intermediate representation** (StepContentEnvelope) that makes the categories of agent-visible content explicit in the type system, replacing implicit string concatenation in the prompt renderer.
2. Introduce **workflow-declared linked references** as a new declaration surface for external supporting documents.
3. Make the boundary between the compiler pipeline (compile-time, deterministic, hashed) and the render/transport pipeline (runtime, session-aware) explicit and typed.

## Non-goals

- Grand unification of all seams into one abstraction. The compiler and render pipelines serve different purposes and should stay distinct.
- Moving prompt fragments out of the prompt string. Fragments are authored prompt content; they belong inline. The envelope documents what matched, but the text stays in `authoredPrompt`.
- Content inlining for references. V1 references are pointers only. The agent reads the file itself if needed.
- User-defined refs replacing the closed `wr.refs.*` set. Workflow-declared references are a separate concept.

## Key design decisions

### StepContentEnvelope

The prompt renderer currently returns `StepMetadata` (stepId, title, prompt string, agentRole, requireConfirmation). The response formatter receives the final response object through shape detection. Between them, content categories are implicit.

The envelope makes them explicit:

```typescript
interface StepContentEnvelope {
  readonly authoredPrompt: string;
  readonly matchedFragmentIds: readonly string[];
  readonly requirements: readonly Requirement[];
  readonly loopBanner: string | null;
  readonly recoveryContext: string | null;
  readonly references: readonly ResolvedReference[];
}
```

The handler assembles the envelope from renderer output + handler-level knowledge (binding drift, preferences, blockers). The `V2ExecutionRenderEnvelope` grows from `{ response, lifecycle }` to `{ response, lifecycle, contentEnvelope }`. The formatter consumes the envelope instead of relying on ad-hoc shape detection.

### Linked references

A reference declaration on `WorkflowDefinition`:

```typescript
interface WorkflowReference {
  readonly id: string;
  readonly title: string;
  readonly source: string;          // path or URI
  readonly purpose: string;
  readonly authoritative: boolean;
}
```

Reference handling splits into two phases:

- **Compile-time** (pure): validate declarations structurally (unique IDs, non-empty paths, valid shapes). Include declarations in the workflow hash.
- **Start-time** (I/O): resolve paths against the workspace, validate existence, capture resolved references as observation events. This follows the existing pattern in `resolveWorkspaceAnchors` in `start.ts`.

Only workflow-declared references participate in the hash. Project-attached references (future) are handled like binding overrides: captured at session start, drift-detected against current state.

### Data flow awareness

The Zod schema boundary (`V2StartWorkflowOutputSchema.parse`) only knows about `pending.prompt` as a string. The envelope travels as a parallel channel through the render envelope wrapper, not through the Zod-validated response. `pending.prompt` is serialized from the envelope's `authoredPrompt` for backward compatibility.

### metaGuidance status

`metaGuidance` is declared on `WorkflowDefinition` but in the v2 clean-format path it is not delivered to the agent during execution (only visible in `inspect_workflow` output). Some things currently in metaGuidance (e.g. "follow this coding guide") are references in disguise. This initiative should clarify metaGuidance's delivery semantics or deprecate it in favor of references + existing prompt composition primitives.

## Constraints

- Prompt fragments must not move out of the prompt string. They participate in the authored prompt and affect recovery budget calculations (`RECOVERY_BUDGET_BYTES`). Moving them would change prompt hashes and break rehydrate for existing sessions.
- Reference content must not be inlined at compile time. Referenced files change independently of the workflow; content inlining would make hashes unstable.
- Project-attached references must not participate in the workflow hash. The same workflow in two projects with different local refs must produce the same hash. Project refs are observation-level, not definition-level.

## Slice plan

> All slices 1–6 are implemented. Slice 5 (project-attached references) was deferred as future work.

### Slice 1: StepContentEnvelope type and render envelope extension ✅

Define the `StepContentEnvelope` type. Extend `V2ExecutionRenderEnvelope` to carry it. Have the handler assemble it from renderer output + handler-level knowledge. Formatter consumes it. **No behavioral change**: the formatter produces identical output, sourced from a typed representation instead of ad-hoc shape detection.

**Key files**: `render-envelope.ts`, `prompt-renderer.ts`, `v2-response-formatter.ts`, `v2-execution/start.ts`, `v2-execution/continue-rehydrate.ts`, `v2-execution/continue-advance.ts`

### Slice 2: Reference declarations ✅

Add `references` as an optional array on `WorkflowDefinition` and `workflow.schema.json`. Structural validation in the validation engine (unique IDs, non-empty paths). Compiler includes declarations in workflow hash. Surfaced in `inspect_workflow` output.

**Key files**: `workflow-definition.ts`, `workflow.schema.json`, `validation-engine.ts`, `v2-workflow.ts` (inspect handler)

### Slice 3: Reference resolution at start-time ✅

I/O phase at `start_workflow` validates reference paths against the workspace, stores resolved references as observation events. Handler populates the envelope's reference section.

**Key files**: `v2-execution/start.ts`, `v2-workspace-resolution.ts`, observation event schema

### Slice 4: Reference delivery ✅

Formatter renders resolved references as a dedicated MCP content item on `start` (full set) and `rehydrate` (compact reminder). Separate from the authored prompt and from supplements.

**Key files**: `v2-response-formatter.ts`, `handler-factory.ts` (toMcpResult)

### Slice 5: Project-attached references (deferred — future work)

`.workrail/references.json` merges with workflow-declared references at start-time. Provenance field (`workflow_declared` | `project_attached`) distinguishes origin. Drift detection via observation comparison (same pattern as binding drift in `binding-drift.ts`).

**Key files**: new `reference-registry.ts`, `v2-execution/continue-rehydrate.ts` (drift detection), `v2-response-formatter.ts` (drift warnings)

### Slice 6: metaGuidance clarification ✅

Either make metaGuidance delivery explicit through the envelope (a supplement or dedicated content section with clear lifecycle semantics) or deprecate it with a migration path to references + prompt composition.

**Key files**: `workflow-definition.ts`, `prompt-renderer.ts`, `v2-response-formatter.ts`, authoring spec, authoring docs

## Relationship to other initiatives

- **Composition and middleware engine** (agentic-orchestration-roadmap.md Phase 2): the StepContentEnvelope provides a typed surface that a future assembler/middleware engine would populate, rather than producing raw strings.
- **Authorable response supplements** (agentic-orchestration-roadmap.md backlog): the envelope gives supplements a typed home. Authorable supplements would declare their content in workflow JSON and flow through the envelope rather than being hardcoded in `response-supplements.ts`.
- **Clean response formatting** (active partial): this initiative completes the boundary clarification between authored prompts, system-injected content, and delivery framing by making each category typed and inspectable.

## Open questions

- Should references support URI schemes beyond file paths (e.g. `https://`, `wr.refs.*`)? Deferring to v1 feedback.
- Should the envelope carry the full supplement specs or just the rendered text? Leaning toward rendered text to keep the formatter's presentation logic in one place.
- Should drift detection for project-attached references be blocking or advisory? Leaning advisory (same as binding drift).
