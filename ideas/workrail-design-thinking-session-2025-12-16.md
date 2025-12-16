# Workrail Design Thinking Session (2025-12-16)

This is a living design-thinking record. It intentionally contains both:
- **Part A — Narrative**: what actually happened (the thinking process, pivots, debates)
- **Part B — Spec**: the stable synthesis (principles, constraints, problem, clusters, roadmap buckets)

---

## Trigger Incident (Raw)

### Input (agent → Workrail)
```json
{"workflowId":"mr-review-workflow-agentic","completedSteps":["phase-0-triage","phase-0a-assess-mode","phase-1-context","phase-1a-llm-context-gathering","consolidate-patterns","hygiene-and-inconsistencies","finalize-review-document","phase-5-handoff"],"variables":{"complexity":"High-Risk","skipContextGathering":true,"contextGatheringComplete":true}}
```

### Output (Workrail → agent)
```json
{
  "step": null,
  "guidance": {
    "prompt": "No eligible step due to unmet conditions. Please update context:\n- Provide a value for 'complexity'\n- Set 'contextGatheringComplete' to one of: 'true'\n- Set 'skipContextGathering' to one of: 'true'"
  },
  "isComplete": false,
  "context": {
    "_contextSize": 4
  }
}
```

---

# Part A — Narrative (How we got here)

## A1. Timeline (high-signal)

1. **Observed failure**: workflow returned `step: null` + unmet-conditions prompt even though the agent provided the fields.
2. **Forensics**: traced the unmet-conditions message to `DefaultStepSelector.handleNoEligibleStep()` and compared it to how conditions are evaluated.
3. **Hypothesis formed**: inputs were not reaching condition evaluation.
4. **Root cause identified**: the agent sent `variables`, but Workrail evaluates conditions against `context`.
   - This created silent mismatch and misleading guidance.
5. **Tempting quick fix**: accept `variables` as an alias for `context`.
6. **Philosophy checkpoint**: we evaluated the quick fix against base principles (type-safety, DRY, architectural fixes over patches).
   - Conclusion: aliasing is a compatibility patch that expands an already-permissive contract.
7. **Undo**: reverted the alias approach (without losing unrelated uncommitted work).
8. **Reframe**: questioned the *concept* of “user context” itself.
   - Maybe the core model should be an explicit **execution protocol** (inputs/state/engine/diagnostics), not a flat bag.
9. **Output format debate**: explored JSON-only vs text-only vs **text blob + minimal JSON backbone**.
10. **MCP scope check**: confirmed the design space is broader than `workflow_next` and includes tooling, resources, errors-as-data, and session state.
11. **Second-order empathize**: incorporated power-user experience (model variability, resumption pain, workflow authoring friction, external workflows, observability, loops reliability).

## A2. Key pivots / reframes (and why)

### Pivot 1: “Context bag” → “Execution protocol”
- **Why**: the flat context currently mixes inputs, derived state, engine bookkeeping, and diagnostics.
- **What it enables**: typed, resumable, explainable state transitions; better portability.

### Pivot 2: “Resumption as agent discipline” → “Resumption as first-class”
- **Why**: relying on an agent to update a file creates inconsistent resumes across models/IDEs.
- **What it enables**: deterministic resume that rehydrates instructions and required state.

### Pivot 3: “Prompt generator” → “Agent control protocol (prompts are a view)”
- **Why**: Workrail’s value is enforcement + state management + determinism, not just prose prompts.
- **What it enables**: structured blockers, tool plans, dashboards, better testing.

### Pivot 4: “JSON-only outputs” → “Text-first + JSON backbone”
- **Why**: agents do great with text, but robustness needs stable structured fields.
- **What it enables**: model-agnostic UX + machine-actionable diagnostics and resumption.

## A3. Tradeoff debates we had (captured)

### Debate: Do we need machine-readable outputs?
- **Position**: yes, because the agent effectively uses outputs to construct the next JSON input, and because resumability/observability/testing need stable structure.
- **Resolution direction**: keep structured outputs, but include a high-quality `text` field.

### Debate: Forgiving vs strict
- **Strict**: prevents drift (unknown keys become errors)
- **Forgiving**: helps weaker models and reduces friction
- **Resolution direction**: forgiving *boundary* via explicit normalization + warnings, strict internal canonical model.

### Debate: Should we accept `variables` forever?
- Not decided yet.
- The design intent is to avoid permanent “two ways to say the same thing” without an explicit compatibility policy.

---

# Part B — Spec (What we believe now)

## B1. Design constraints (non-negotiables)

### Philosophy constraints (from power-user)
- Prefer architectural fixes over patches.
- Prefer explicit types / closed sets (discriminated unions / enums) over base types (especially booleans and arbitrary strings) when representing state.
- Abuse type-safety; prevent invalid states by construction.
- CLEAN / SOLID / DRY; small focused components; composable design.
- DI everywhere it makes sense.
- Declarative/functional over imperative.
- Prefer control flow based on **data state** vs execution context flags.
- Soft YAGNI (avoid scope creep but still build proper foundations).
- Errors as data; avoid throwing for expected/validation failures.

### Platform constraints (stdio MCP reality)
- No server push; progress must be polled or written externally.
- Agents are lossy; resumption/handoff must be robust.
- Token/payload budgets matter; prefer refs + summaries.
- Multiple front doors (MCP + JSON-RPC + CLI) must not drift.

## B2. Personas
- **Power user/operator**: installs workflows, wants observability, resumption, easy external workflow management.
- **Workflow author**: wants blueprints, linting, safer primitives.
- **Agent/client model**: wants minimal cognitive load, self-correcting protocol.
- **IDE ecosystem**: heterogenous tool availability; needs portability.

## B3. Problem statement (draft)
Workrail’s execution interface and workflow authoring model are too permissive and underspecified. This causes contract drift, brittle resumption dependent on agent discipline, inconsistent outcomes across models/IDEs, uneven workflow quality, and poor observability.

## B4. Success criteria (draft)
- Resumption works with **zero** agent discipline; Workrail can rehydrate “instructions so far” and required state.
- No silent contract drift across MCP/RPC/CLI.
- Blocked states are deterministic and actionable (structured blockers + suggested patches).
- Workflows have recommended blueprints and reusable primitives.
- Loops are correct and explainable.
- Status is always visible (sessions/dashboard).

## B5. North Star Pillars (Locked)

1) **Text-first agent UX**
- Every step is consumable as text first; formatting is deterministic (standard header + section ordering).

2) **Deterministic protocol (boundary + runtime)**
- Invalid inputs never fail silently; blocked states are deterministic and actionable.

3) **Composable workflow features (deterministic middleware)**
- Workflows declare features; middleware injects standard capabilities consistently.

## B6. North Star Acceptance Criteria (Binary)

### Pillar 1 — Text-first agent UX (`AC-P1-*`)
- **AC-P1-01 (schema/test):** `workflow_next` responses MUST include a top-level `text` field sufficient for an agent to execute without parsing other fields.
- **AC-P1-02 (test):** `text` MUST start with a deterministic header block (fixed ordering of header lines).
- **AC-P1-03 (type/schema):** Header fields MUST be a closed set; additions require template version bump.
- **AC-P1-04 (test):** Step body sections within `text` MUST follow deterministic section order.
- **AC-P1-05 (schema):** Steps MUST be renderable from structured fields in template mode OR explicitly opt out via an escape hatch (e.g., `rawPrompt`).
- **AC-P1-06 (test):** If workflow declares `features:['agentCascade']`, header MUST be tier-aware and must not assume delegation/parallelism without capability info.
- **AC-P1-07 (inspection):** Instruction portion MUST be imperative + checklist-driven (no ambiguous hedging in the instruction portion).
- **AC-P1-08 (test):** Prompts MUST end with deterministic "Next Input" when external input is required.

### Pillar 2 — Deterministic protocol (`AC-P2-*`)
- **AC-P2-01 (type/schema):** `workflow_next` response MUST be a discriminated union with `kind ∈ { step, blocked, complete, error }`.
- **AC-P2-02 (test):** If `kind=step`, response MUST include stable identifiers (at least `stepId`).
- **AC-P2-03 (schema/test):** If `kind=blocked`, response MUST include `blockers[]` as structured data; `text` summarizes blockers.
- **AC-P2-04 (test):** `blockers[]` MUST be deterministically ordered.
- **AC-P2-05 (schema):** Each blocker MUST include: `code` (closed set), `path` (or key), `message`, and `suggestedFix`/`suggestedPatch` when known.
- **AC-P2-06 (schema/test):** Malformed input MUST NOT be silently ignored; it MUST yield actionable `kind=error` (or `blocked` with explicit invalid-input blockers).
- **AC-P2-07 (schema/test):** If normalization is applied, it MUST emit structured `warnings[]`; silent normalization is not allowed.
- **AC-P2-08 (test):** Condition-unmet states MUST be representable as data (blockers reference the missing/invalid variables).
- **AC-P2-09 (inspection):** Expected failures MUST be errors-as-data; throws are reserved for programmer bugs.

### Pillar 3 — Composable workflow features (`AC-P3-*`)
- **AC-P3-01 (schema/type):** Workflows MUST support `features: []` where values are from a closed set.
- **AC-P3-02 (test):** Feature application order MUST be deterministic.
- **AC-P3-03 (type/test):** Features MUST be pure transforms returning errors-as-data (`Workflow -> Result<Workflow, Error>`), not side-effectful hooks.
- **AC-P3-04 (schema/test):** Responses MUST expose applied features (e.g., `appliedFeatures[]`) for explainability.
- **AC-P3-05 (test):** `agentCascade` feature MUST be able to influence rendering (tier-aware header) without copy/paste prompt duplication.
- **AC-P3-06 (test):** Injected steps/blocks MUST have stable IDs and provenance.
- **AC-P3-07 (inspection):** Features MUST not require manual replication across workflows when injectible centrally.
- **AC-P3-08 (inspection):** Feature system MUST not execute untrusted code from workflow files.

## B7. Rejection Triggers (`REJECT-*`)
- **REJECT-01:** Reintroduces meaningful nulls as state instead of discriminated unions.
- **REJECT-02:** Malformed input can be accepted/partially applied without structured warning/error.
- **REJECT-03:** Adds a second way to express the same concept without explicit compatibility/normalization policy.
- **REJECT-04:** Makes prompt formatting non-deterministic without template versioning.
- **REJECT-05:** Adds side-effectful or arbitrary-code plugin hooks.
- **REJECT-06:** Introduces per-workflow bespoke scaffolding that should be a shared feature.
- **REJECT-07:** Introduces boolean/freeform-string state where a closed set is clearly available.

## B8. Enforcement Mechanisms (How we guarantee the above)

### Enforcement toolbox
- **Type-level:** TS discriminated unions + exhaustive `switch(kind)`.
- **Schema-level:** strict Zod parsing in `src/mcp/tools.ts` + output schema validation.
- **Runtime guards:** single boundary normalization/validation stage producing errors-as-data.
- **Tests:** Vitest unit tests for renderer + protocol + middleware.

### Pillar 1 enforcement
- Renderer tests assert header-first + section ordering (parse headings, assert order).
- Header fields encoded as string-literal union; renderer uses fixed ordered list.
- Template-mode schema requires structured fields; missing fields → actionable `kind=error/blocked`.
- `agentCascade` feature tests verify tier-aware header rendering.

### Pillar 2 enforcement
- Protocol response type is a discriminated union; handler returns only that type.
- Blockers are typed (closed `code` union) + deterministically sorted; unit tests enforce sorting.
- Invalid inputs produce structured errors; no silent drops.

### Pillar 3 enforcement
- `features` is an enum list; unknown feature → error-as-data.
- Middleware registry is ordered; tests assert deterministic application order.
- Features implement pure transform interface; tests assert provenance and stable injected IDs.

## B9. Idea inventory (condensed)

### Protocol redesign
- Versioned execution request envelope.
- Cursor or event-sourced progress (vs completedSteps bag).
- Discriminated union results: step | blocked | complete | error.
- Resume token.

### Boundary robustness + forgiveness
- Shared normalization layer across transports.
- Smart schema errors (“did you mean …”).
- Conflict policy when multiple equivalent fields provided.
- Deprecation windows (warn → error).

### State modeling
- Replace booleans with explicit state machines.
- Decision objects/unions instead of freeform strings.
- Typed workflow families for key domains (MR review, bug investigation).

### Namespacing + separation of concerns
- Split into inputs/state/engine/diagnostics.
- Prevent injection of engine-owned keys.
- Field provenance.

### Output redesign
- Text-first + minimal JSON backbone.
- Output modes: text | structured | both.

### Explainability
- Structured blockers (“why blocked”) + minimal unsat-core.
- Suggested minimal patch / next call template.

### Scaling
- Artifact references instead of blob context.
- Required-keys-only virtualization.
- Context deltas.

### Workflow authoring power
- Compile workflows to IR (graph).
- Workflow schemas + linting.
- Composition via sub-workflows.

## B6. Cluster map
- **A Execution/state core**: protocol engine, cursor/events, resume token, dataflow execution, explainability.
- **B Boundary/compat**: canonical schemas, normalization, smart errors, deprecation.
- **C Authoring correctness**: IR/DSL/macros, schemas, linting/autofix, simulation.
- **D Agent UX**: text-first + JSON backbone, action menus/forms, next-call templates.
- **E Orchestration**: tool-call plans, parallel fan-out/fan-in, capability negotiation, composition.
- **F Artifacts**: refs, checksums, provenance, deltas.
- **G Policy/safety**: capability gating, guardrails.
- **H Positioning**: generic vs vertical vs platform.

## B7. Roadmap buckets (candidates)
1. Protocol v2: text-first + JSON backbone; discriminated union results; structured blockers.
2. Sessions + deterministic resumption owned by Workrail (rehydrate instructions up to cursor).
3. Workflow manifest/blueprints + standard library primitives.
4. Capability negotiation + portability layer for IDE tools.
5. External workflow packaging/discovery/versioning.
6. Loop correctness + traceability.
7. Dashboard/management UI.
8. Optional full-auto modes (structured tool plans + policy gates).

## B8. Decision log (append-only)
- 2025-12-16: prefer **text-first + JSON backbone** over JSON-only or text-only.
- 2025-12-16: avoid permanent ad-hoc alias patches without an explicit compatibility policy.

## B9. Open decisions
- Forgiveness policy: accept aliases forever (warn) vs deprecate to error.
- Protocol foundation: prompt sequencing vs typed execution protocol.
- Namespaced envelope adoption strategy.
- Generic vs vertical workflow families: where to draw the line.

## B10. Prototype candidates (learning-first)
- Protocol v2 response shape: `text` + `kind/stepId/blockers/resumeToken`.
- Session-owned resumption: reconstruct “instructions so far” from workflow + cursor.
- Workflow manifest: embed expectations/philosophy/capabilities (no separate README required).
- Loop trace output: deterministic trace for why a loop advanced/skipped.

---

## Appendix: Subagent constraints & the Agent Cascade Protocol (notes)
This work is constrained by the subagent model described in:
- `docs/architecture/subagent-design-principles.md`
- `docs/architecture/agent-cascade-protocol.md`
- `assets/agent-configs/firebender/workrail-executor.md`

Key takeaways that shape workflow design:
- Subagents are **stateless** and must receive a complete work package.
- Prefer the **auditor model** (subagents audit main-agent work) over executor model when possible.
- Parallelism should be explicit and used only for independent work; assign distinct focuses (e.g., completeness vs depth).
- Support Tier 1/2/3 execution (Solo/Proxy/Delegation) via a verify-then-delegate probe.

## Appendix: Link to the design thinking workflow
- Workflow (human-assisted): `workflows/design-thinking-workflow.json`
- Workflow (autonomous agentic): `workflows/design-thinking-workflow-autonomous.agentic.json`
