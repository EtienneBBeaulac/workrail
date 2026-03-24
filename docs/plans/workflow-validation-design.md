# Workflow Validation Design

This is the **canonical durable design doc** for the workflow validation initiative.

Use it for:

- architectural rules that should remain true over time
- the validation model and shared boundaries
- important design constraints that explain *why* the system is shaped this way

Do **not** use this doc as a code-shadow full of exact signatures or large copy-paste implementation recipes. Those drift too easily.

## Core design rule

Validation must track what runtime actually does, not a simplified approximation of it.

If validation and runtime diverge, the validator becomes a false assurance layer.

## Architectural principles

### Shared resolution, not duplicate resolution

Validation and runtime should rely on the same source/variant resolution logic rather than maintaining parallel implementations.

This includes:

- workflow discovery
- candidate resolution
- first-step/start construction
- feature-flag-sensitive variant choice

### One validation pipeline, many consumers

CLI, MCP tools, registry validation, and any future runtime assertions should all rely on the same validation pipeline rather than each adding their own interpretation of “valid.”

### Fail loudly instead of hiding invalid workflows

If invalid workflows are filtered out or silently degraded, the system cannot make trustworthy claims about validity.

### Validate the lifecycle, not just the file

Static validation is necessary but insufficient. A stronger validation story includes execution-oriented checks and lifecycle coverage for important bundled workflows.

## Validation tiers

### Tier 1: File validation

Purpose:

- schema conformance
- structural correctness

This is the cheapest and most local layer, but it is not enough on its own.

### Tier 2: Registry validation

Purpose:

- validate discoverable workflows as runtime resolves them
- catch duplicate IDs, source conflicts, and variant-resolution mismatches

This is the tier that closes the gap between individual file validity and actual runtime selection behavior.

### Tier 3: Execution validation

Purpose:

- verify lifecycle integrity
- catch failures that only appear when stepping through execution paths

This tier is what turns validation from “static confidence” into stronger runtime equivalence.

## Important design consequences

### Validation is partly a runtime-design problem

Some validation gaps cannot be solved only by adding new checks. They require runtime behavior to stop hiding invalid states or silently degrading.

### Tests are part of the contract

Lifecycle harnesses and regression coverage are not optional polish. They are part of the proof that the validation story matches execution reality.

### Code is the implementation truth

This doc should explain the durable model, but exact signatures, file counts, and phased code recipes belong in code/tests or short-lived implementation work, not in the permanent design doc.

## Current design priorities

1. preserve runtime/validation parity
2. make failures visible rather than hidden
3. expand lifecycle confidence pragmatically
4. avoid sprawling operator/process docs that duplicate the plan

## Companion docs

- `docs/plans/workflow-validation-roadmap.md`
- `docs/roadmap/open-work-inventory.md`
- `docs/tickets/next-up.md`
