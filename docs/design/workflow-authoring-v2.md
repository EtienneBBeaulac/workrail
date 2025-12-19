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

```json
{
  "id": "namespace.workflow_name",
  "name": "Human-Readable Name",
  "description": "What this workflow does",
  "agentRole": "Optional: workflow-level stance/persona for the agent",
  "capabilities": { ... },
  "features": [ ... ],
  "steps": [ ... ]
}
```

## Capabilities (workflow-global)

Capabilities declare optional agent environment enhancements that materially affect workflow execution or are required for correctness.

```json
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

```json
"features": [
  "wr.features.mode_guidance",
  "wr.features.durable_recap_guidance"
]
```

A small subset of features can accept typed configuration:

```json
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

### Normal step

```json
{
  "id": "phase-1",
  "title": "Phase 1: Analysis",
  "agentRole": "Optional: override workflow-level role for this step",
  "prompt": "A single prompt string (traditional)"
}
```

Or using structured blocks:

```json
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

**Output object** (optional):
- `contractRef` (string): references a WorkRail-owned contract pack; WorkRail validates on `continue_workflow`
- `hints` (object): non-enforced guidance

### Template call step

```json
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

## Output contracts

Output contracts enable WorkRail to validate required outputs and return self-correcting `blocked` responses (or record gaps).

### Contract packs (closed set)

WorkRail defines a small, closed set of contract packs. Initial set (conceptual):

- `wr.contracts.capability_observation`
- `wr.contracts.workflow_divergence`
- (and gaps-related contracts when formalized)

Each pack includes:
- allowed artifact kind(s)
- required fields
- minimal example payload

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

```json
"output": {
  "contractRef": "wr.contracts.verification_report",
  "hints": { ... }
}
```

Then WorkRail can validate the verification output before advancing.

## Divergence markers

Agents can report `workflow_divergence` when intentionally deviating from instructions.

Divergence is a structured artifact:

```json
{
  "kind": "workflow_divergence",
  "reason": "skipped_for_efficiency",  // closed set
  "summary": "Skipped hypothesis X because ...",
  "relatedStepId": "phase-2"
}
```

Studio badges nodes with divergence for auditability.

Enforcement: divergence is **optional** (agent reports when applicable); it should not block unless a step explicitly requires it.

## Example: complete v2 workflow

```json
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
