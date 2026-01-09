# WorkRail v2 — Workflow Authoring Reference

This document describes the v2 JSON authoring model for workflows, including capabilities, features, templates, output contracts, and prompt engineering patterns.

See also:
- `docs/authoring.md` (general guide)
- `docs/reference/workflow-execution-contract.md` (normative contract)
- `docs/design/studio.md` (Studio discoverability and catalog)

## JSON-first authoring

WorkRail v2 uses **JSON** as the canonical authoring format.

- DSL and YAML remain possible future input formats, but v2 optimizes for determinism and straightforward validation.
- Workflows are pinned to a `workflowHash` computed from the **compiled canonical model** (after all templates/features/contracts are expanded), not raw source text.

## Top-level workflow structure

```jsonc
{
  "id": "namespace.workflow_name",
  "name": "Human-Readable Name",
  "description": "What this workflow does",
  "agentRole": "Optional: workflow-level stance/persona for the agent",
  "capabilities": { ... },
  "features": [ ... ],
  "conditions": [ ... ],
  "steps": [ ... ]
}
```

## Capabilities (workflow-global)

Capabilities declare optional agent environment enhancements that materially affect workflow execution or are required for correctness.

```jsonc
"capabilities": {
  "delegation": "preferred",
  "web_browsing": "required"
}
```

**Allowed values**:
- `required`: workflow cannot run meaningfully without it
- `preferred`: use when available; degrade gracefully otherwise
- `disabled`: do not use even if available (rare)

**Closed set for v2**:
- `delegation` (subagents / parallel delegation)
- `web_browsing` (external knowledge lookup)

**Behavior**:
- WorkRail cannot introspect the agent environment.
- Capability availability is learned via **explicit probe/attempt steps** and recorded durably as node-attached observations.
- If required and unavailable:
  - blocking modes → `blocked` with remediation ("install web browsing MCP" or provide sources manually)
  - never-stop → record critical gap + continue

## Features (compiler middleware)

Features are closed-set, WorkRail-defined behaviors applied globally during workflow compilation.

Most features are simple toggles:

```jsonc
"features": [
  "wr.features.mode_guidance",
  "wr.features.durable_recap_guidance"
]
```

A small subset of features can accept typed configuration:

```jsonc
"features": [
  {
    "id": "wr.features.capabilities",
    "config": {
      "probeVisibility": "collapsed",
      "recordObservationsAs": "artifact"
    }
  },
  {
    "id": "wr.features.output_contracts",
    "config": {
      "enforce": "block_in_blocking_modes_gap_in_never_stop"
    }
  }
]
```

**Whitelist of configurable features** (initial):
- `wr.features.capabilities`
- `wr.features.output_contracts`
- `wr.features.mode_guidance`

Config schemas are WorkRail-owned and validated per feature.

## Steps

Steps can be either normal steps or template calls.

### Identifier constraints (authoring-time validation, locked)
To keep execution deterministic and avoid escaping footguns, step and loop identifiers used in execution state must be delimiter-safe.

Locks:
- `step.id` (StepId) MUST match: `[a-z0-9_-]+`
- `loopId` (when/if loop constructs are used) MUST match: `[a-z0-9_-]+`
- The following characters are not allowed in these identifiers: `@`, `/`, `:`

Studio/CLI should provide deterministic auto-fix suggestions (lowercase + replace invalid characters with `_`).

### Loops (explicit, deterministic) (initial v2 authoring)
Loops are authored as first-class steps to keep execution deterministic and Studio-renderable. The compiler assigns a stable `bodyIndex` corresponding to the index in the authored `body[]` list.

Locks:
- Loops are expressed as `type: "loop"` steps with a unique `loopId` (delimiter-safe).
- Loop bodies are explicit and ordered: `body[]` is the authoritative step list for `bodyIndex`.
- Every loop MUST declare `maxIterations` (no defaults).
- Loop continuation is defined by a `while` condition reference (see Conditions below), not by ad-hoc booleans or free-form strings.

Example:

```jsonc
{
  "type": "loop",
  "loopId": "investigation_pass",
  "while": { "kind": "condition_ref", "conditionId": "hypotheses_stable" },
  "maxIterations": 5,
  "body": [
    { "id": "gather_evidence", "title": "Gather evidence", "prompt": "..." },
    { "id": "update_hypotheses", "title": "Update hypotheses", "prompt": "..." }
  ]
}
```

### Conditions (closed set, reusable) (initial v2 authoring)
Conditions are authored as a closed set of reusable definitions and referenced by loops and (later) other control structures. This keeps control flow based on data state and avoids stringly-typed expression bags.

Identifier constraints:
- `conditions[].id` MUST match: `[a-z0-9_-]+`

Shape:

```jsonc
{
  "conditions": [
    {
      "id": "hypotheses_stable",
      "kind": "always_false"
    }
  ]
}
```

Initial closed set (minimal, expandable):
- `always_true`
- `always_false`
- `loop_control` (recommended for most real loops)

#### `loop_control` condition kind (recommended)
Because WorkRail cannot infer intent from prompts and we avoid arbitrary expression strings, the most practical deterministic loop exit is an explicit loop control signal produced by the workflow itself.

Pattern:
- A step in the loop body emits a small, contract-validated control artifact indicating whether to continue.
- The loop’s `while` condition references a `loop_control` condition definition.

Example condition definition:

```jsonc
{
  "id": "keep_iterating",
  "kind": "loop_control",
  "continueWhen": "continue" // closed set: continue | stop
}
```

Notes:
- The control signal should be validated via a WorkRail-owned output contract pack (e.g., `wr.contracts.loop_control`) to keep it self-correcting and deterministic.
- This avoids reading arbitrary `context` keys or relying on free-form strings for control flow.
- Deterministic evaluation intent:
  - On each loop iteration, the workflow must produce a validated `wr.loop_control` artifact for the loop’s `loopId`.
  - The loop continues while the most recent validated artifact indicates `decision == continueWhen`.
  - Missing/invalid loop control output is handled by effective autonomy:
    - blocking modes: `blocked` with structured missing/invalid required output
    - never-stop: record a critical gap and treat as `decision="stop"` (fail-safe to prevent runaway loops)

#### `wr.contracts.loop_control` (initial contract pack, locked)
This contract pack validates a loop control artifact emitted via `output.artifacts[]`.

Artifact kind:
- `wr.loop_control`

Required fields:
- `loopId` (must match the enclosing loop step’s `loopId`)
- `decision`: `continue | stop`

Optional fields:
- `summary` (bounded text)

Example artifact:

```jsonc
{
  "kind": "wr.loop_control",
  "loopId": "investigation_pass",
  "decision": "continue",
  "summary": "More hypotheses to test; proceed."
}
```

Notes:
- The initial set is intentionally tiny; richer condition kinds should be added only when needed and must remain a closed set.

### Normal step

```jsonc
{
  "id": "phase-1",
  "title": "Phase 1: Analysis",
  "agentRole": "Optional: override workflow-level role for this step",
  "prompt": "A single prompt string (traditional)"
}
```

Or using structured blocks:

```jsonc
{
  "id": "phase-1",
  "title": "Phase 1: Analysis",
  "promptBlocks": {
    "goal": "What this step accomplishes",
    "constraints": [
      "Follow the selected mode (guided vs full-auto)",
      "Do not assume baseline tools exist in workflows"
    ],
    "procedure": [
      "Step 1: ...",
      "Step 2: ..."
    ],
    "outputRequired": {
      "notesMarkdown": "Short recap (≤10 lines)"
    },
    "verify": [
      "Check that ..."
    ]
  },
  "output": {
    "contractRef": "wr.contracts.some_contract",
    "hints": {
      "notesMarkdown": "If you can't produce the contract, at least write notes."
    }
  }
}
```

**PromptBlocks** (optional):
- Canonical block set: `goal`, `constraints`, `procedure`, `outputRequired`, `verify`
- WorkRail renders blocks in deterministic order into a text-first `pending.prompt`
- Features can inject/override specific blocks (e.g., mode guidance → constraints)

### Prompt references (`wr.refs.*`) (initial v2 authoring)
Workflows may inject small, canonical WorkRail-owned snippets inline (e.g., “WorkRail v2 definition”, “append-only truth”, “modes semantics”) to avoid copy/paste and keep prompts consistent.

Locks (v2 intent):
- **Compile-time only**: references are resolved during compilation and included in the compiled snapshot (and therefore `workflowHash`).
- **Closed set**: reference IDs are WorkRail-owned and namespaced: `wr.refs.*`.
- **No templating**: do not support `{{ }}` interpolation, file-path includes, or URL includes. References must be typed and validated.
- **Budgets**: references are byte-bounded; budget violations are validation errors (no silent truncation).
- **Placement discipline**: references are allowed only within structured prompt sections (to keep prompts instruction-first).

Locked choice (v2): the compiled workflow snapshot embeds the fully resolved reference text for every `wr.refs.*` usage (not just `{refId, refContentHash}`), so pinned compiled snapshots are self-contained for export/import.

Authoring shape (conceptual, code-canonical schema will be generated):
- `PromptValue = string | PromptParts`
- `PromptParts = [PromptPart, ...]` (non-empty list)
- `PromptPart` (closed union):
  - `{ "kind": "text", "text": "..." }`
  - `{ "kind": "ref", "refId": "wr.refs.some_snippet" }`

Recommended placements:
- `promptBlocks.goal`: `PromptValue`
- `promptBlocks.constraints[]`: `PromptValue[]`
- `promptBlocks.procedure[]`: `PromptValue[]`
- `promptBlocks.verify[]`: `PromptValue[]`

Example (conceptual):

```jsonc
{
  "id": "project.planning_v2",
  "steps": [
    {
      "id": "plan_storage",
      "title": "Plan the two-stream commit protocol",
      "promptBlocks": {
        "goal": [
          { "kind": "text", "text": "Plan the durable commit protocol for WorkRail v2." },
          { "kind": "ref", "refId": "wr.refs.v2_definition" }
        ],
        "constraints": [
          [
            { "kind": "ref", "refId": "wr.refs.append_only_truth" },
            { "kind": "text", "text": "Do not introduce salvage scanning as a correctness path." }
          ]
        ],
        "procedure": [
          "Define the AppendPlan commit ordering.",
          "List crash states and recovery rules."
        ],
        "verify": [
          [
            { "kind": "text", "text": "Hashing inputs are canonical and deterministic." },
            { "kind": "ref", "refId": "wr.refs.jcs_hashing" }
          ]
        ]
      }
    }
  ]
}
```

**Output object** (optional):
- `contractRef` (string): references a WorkRail-owned contract pack; WorkRail validates on `continue_workflow`
- `hints` (object): non-enforced guidance

### Template call step

```jsonc
{
  "type": "template_call",
  "templateId": "wr.templates.capability_probe",
  "args": {
    "capability": "web_browsing",
    "when": "early_if_required"
  }
}
```

Templates are WorkRail-owned builtins that expand into one or more steps.

**Template-implied contracts**:
- Templates may automatically imply an `output.contractRef` without the author specifying it.
- Example: `wr.templates.capability_probe` implies `wr.contracts.capability_observation`.

## AgentRole

`agentRole` is a stance/persona snippet injected into the rendered prompt.

- WorkRail **cannot control the agent's system prompt** (that lives in the agent/IDE runtime).
- `agentRole` is simply text guidance included in the workflow/step instructions.

**Scoping**:
- Workflow-level `agentRole` applies to all steps unless overridden.
- Step-level `agentRole` overrides the workflow default.

**Best practice**: keep short; rely on templates/features for reusable stance content.

## Validation Criteria (v1 compatibility, design guidance)

Steps can include `validationCriteria` to validate agent output. This is a v1 feature maintained for backward compatibility.

### Evidence-Based Validation Design (CRITICAL)

**Lock (§19)**: Validate **evidence of work**, not **completion flags**.

When agents see validation requirements (via prompt enhancement, error messages, or guidance fields), they may optimize for **passing validation** rather than **doing quality work**. Prevent this with evidence-based validation.

#### Anti-Pattern: Flag-Only Validation ❌

```json
{
  "prompt": "Analyze security vulnerabilities",
  "validationCriteria": {
    "type": "contains",
    "value": "analysisComplete = true"
  }
}
```

**Problem**: Agent writes `analysisComplete = true` without analysis. Passes validation, produces no value.

#### Good Pattern: Evidence-Based Validation ✅

```json
{
  "prompt": "Analyze security vulnerabilities. List findings with severity.",
  "validationCriteria": {
    "and": [
      {"type": "regex", "pattern": "Finding \\d+:.*severity:(high|medium|low)", "message": "List numbered findings with severity"},
      {"type": "contains", "value": "file:", "message": "Reference specific file locations"},
      {"type": "length", "min": 200, "max": 5000, "message": "Substantive analysis (200-5000 chars)"}
    ]
  }
}
```

**Why it works**: Can't fake structured findings without doing analysis.

#### Design Guidelines

**DO**:
- ✅ Check for work products ("Finding N:", "file:line", "rationale:")
- ✅ Require patterns that indicate substance (not just keywords)
- ✅ Use multiple independent criteria (cross-validation)
- ✅ Set reasonable length bounds (ensures substance, prevents spam)

**DON'T**:
- ❌ Validate single boolean flags (`complete = true`, `done = yes`)
- ❌ Check for magic phrases alone (`must contain 'finished'`)
- ❌ Make validation trivially satisfiable with minimal text
- ❌ Rely on agent honesty without verification

### Migration Note

**Existing workflows** using flag-only validation will continue to work (backward compatible), but should be audited and enhanced to follow evidence-based patterns.

**New workflows** should follow evidence-based validation from the start.

See §19 in `v2-core-design-locks.md` for full rationale.

## Output contracts

Output contracts enable WorkRail to validate required outputs and return self-correcting `blocked` responses (or record gaps).

### Contract packs (closed set)

WorkRail defines a small, closed set of contract packs. Initial set (conceptual):

- `wr.contracts.capability_observation`
- `wr.contracts.workflow_divergence`
- `wr.contracts.loop_control`
- (and gaps-related contracts when formalized)

Each pack includes:
- allowed artifact kind(s)
- required fields
- minimal example payload

### Workflow-authored output schemas (rejected for v2)
v2 does **not** allow workflows to define arbitrary inline JSON schemas (or point to project-local / git-hosted schema files) for required outputs.

Instead:
- Use `output.contractRef` referencing a **WorkRail-owned** contract pack (`wr.contracts.*`).
- If you need richer structured artifacts than existing packs support, prefer:
  - expanding the WorkRail-owned contract pack catalog (recommended), or
  - using `output.notesMarkdown` temporarily (generic durability) until a pack exists.

This preserves determinism, prevents drift, and keeps Studio rendering consistent.

### Enforcement

When a step declares `output.contractRef`:

- On `continue_workflow`, WorkRail validates the contract output.
- **Blocking modes**: if missing/invalid, return `kind: "blocked"` with structured "missing required output" + example.
- **Never-stop mode**: if missing/invalid, record critical gap and continue.

### Versioning

Contract packs are referenced by ID only (no explicit version refs).

Versioning is **implicit** via the pinned compiled workflow snapshot (`workflowHash`). The snapshot carries the exact contract schemas resolved at compile time, ensuring deterministic behavior even if packs evolve.

## Verify (instructional vs enforceable)

The `verify` block (in `promptBlocks`) is **instructional by default**: the agent follows it as a self-check before acknowledging.

To make verification **enforceable**, express it as an output contract:

```jsonc
"output": {
  "contractRef": "wr.contracts.verification_report",
  "hints": { ... }
}
```

Then WorkRail can validate the verification output before advancing.

## Divergence markers

Agents can report `workflow_divergence` when intentionally deviating from instructions.

Divergence is a structured artifact:

```jsonc
{
  "kind": "workflow_divergence",
  "reason": "efficiency_skip",  // closed set (WorkRail-owned)
  "summary": "Skipped hypothesis X because ...",
  "relatedStepId": "phase-2"
}
```

Initial closed set (conceptual; generated from canonical contract pack definitions to prevent drift):
- `missing_user_context`
- `capability_unavailable`
- `efficiency_skip`
- `safety_stop`
- `policy_constraint`

Studio badges nodes with divergence for auditability.

Enforcement: divergence is **optional** (agent reports when applicable); it should not block unless a step explicitly requires it.

## Example: complete v2 workflow

```jsonc
{
  "id": "project.bug_investigation_v2",
  "name": "Bug Investigation (v2)",
  "description": "Deterministic, rewind-safe bug investigation with mode-aware ambiguity handling.",
  "agentRole": "You are a senior engineer. Be explicit about assumptions and verification. Follow workflow instructions as the user's process.",
  "capabilities": {
    "delegation": "preferred",
    "web_browsing": "preferred"
  },
  "features": [
    "wr.features.mode_guidance",
    {
      "id": "wr.features.capabilities",
      "config": {
        "probeVisibility": "collapsed",
        "recordObservationsAs": "artifact"
      }
    }
  ],
  "steps": [
    {
      "id": "triage",
      "title": "Triage and focus",
      "promptBlocks": {
        "goal": "Classify scope/risks and choose focus areas for the investigation.",
        "constraints": [
          "Follow the selected mode (guided vs full-auto).",
          "If delegation is unavailable, do sequential passes.",
          "Record a durable recap at the end."
        ],
        "procedure": [
          "Summarize the bug in 3 bullets.",
          "List top 3 hypotheses.",
          "Choose 2–4 investigation focus areas."
        ],
        "outputRequired": {
          "notesMarkdown": "≤10 lines: scope, hypotheses, focus areas, and what's next."
        },
        "verify": [
          "Hypotheses are testable and mutually distinguishable."
        ]
      }
    },
    {
      "type": "template_call",
      "templateId": "wr.templates.capability_probe",
      "args": {
        "capability": "delegation",
        "when": "lazy_on_first_use"
      }
    },
    {
      "id": "investigate",
      "title": "Run investigation passes",
      "promptBlocks": {
        "goal": "Test hypotheses via evidence gathering.",
        "constraints": [
          "If delegation is available: run parallel passes; otherwise do sequential passes.",
          "If you intentionally deviate (skip a hypothesis), record a divergence marker."
        ],
        "procedure": [
          "For each hypothesis: gather minimal evidence to confirm or falsify.",
          "Record observations durably."
        ],
        "outputRequired": {
          "notesMarkdown": "Key observations + updated confidence per hypothesis."
        }
      },
      "output": {
        "hints": {
          "divergence": "Report if you skip hypotheses or deviate from procedure."
        }
      }
    },
    {
      "id": "finalize",
      "title": "Finalize root cause",
      "promptBlocks": {
        "goal": "Provide final root cause and recommendations.",
        "procedure": [
          "State the most likely root cause with confidence level.",
          "Propose 2–3 preventative recommendations."
        ],
        "outputRequired": {
          "notesMarkdown": "Root cause + recommendations."
        },
        "verify": [
          "Root cause is grounded in observed evidence."
        ]
      }
    }
  ]
}
```

## What happens at compile time

WorkRail compiles the source workflow:

1) Expands `template_call` steps into their full step sequences (with provenance).
2) Applies `features` in deterministic order (injects prompt content, adds probe logic, etc.).
3) Resolves `contractRef` to actual schemas from the contract pack registry.
4) Renders `promptBlocks` into deterministic text `pending.prompt` strings.
5) Computes `workflowHash` from the fully expanded canonical model.

## Source vs compiled (Studio)

- **Source**: what the author wrote (editable depending on source provenance/namespace).
- **Compiled**: what WorkRail executes and pins.

Studio's compiled view shows:
- injected steps (collapsed by default, expandable with provenance)
- effective `agentRole` per step
- resolved contract schemas
- rendered `pending.prompt` text

This makes injection and determinism transparent.

## Prompt engineering best practices (baked into templates/features)

WorkRail templates/features should encode:

- **Instruction clarity**: single clear goal, explicit constraints, prioritized procedure.
- **Structured layout**: consistent sections (goal/constraints/procedure/output/verify).
- **Role/stance**: appropriate persona per workflow/step.
- **Context discipline**: provide only necessary context; avoid bloat.
- **Tool-use guidance**: when capabilities matter (delegation/web), include probe + fallback.
- **Output format constraints**: explicit schemas via contracts; minimal examples.
- **Ambiguity handling**: mode-aware (ask/block vs assume+disclose).
- **Verification**: explicit self-check step; optionally enforceable via contracts.
- **Error handling as data**: blocked with structured reasons, not vague failures.

Authors should **rely on templates/features** for repetitive structure rather than hand-rolling best practices in every step.

## Discoverability

Builtins (templates/features/contracts/capabilities) should be discoverable via:

- **Studio Builtins Catalog**: searchable, with copyable snippets and insert actions.
- **Contextual autocomplete**: while editing workflows in Studio.
- **Validation as suggestions**: "You declared capability X; consider feature Y."

The catalog is powered by a **generated registry** sourced from the same canonical builtin definitions the compiler uses (to prevent drift).

See: `docs/design/studio.md` for Studio catalog and autocomplete UX.

## Anti-patterns (avoid)

- Assuming WorkRail can control the agent's system prompt (it can't).
- Modeling "baseline tools" (file ops, grep, terminal) in workflow capabilities (noise + drift).
- Inline schema authoring (use contract pack references instead).
- Huge unstructured prompts (use promptBlocks + templates/features for reusable structure).
- Silent divergence or assumptions (report via divergence markers/gaps).
- Trusting agent-declared capabilities without probe/attempt (WorkRail can't introspect).

## Related

- Normative execution protocol: `docs/reference/workflow-execution-contract.md`
- Studio UX and catalog: `docs/design/studio.md`
- General authoring guide: `docs/authoring.md`
