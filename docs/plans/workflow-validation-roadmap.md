# Workflow Validation Roadmap

This is the **canonical planning/status doc** for the workflow validation initiative.

Use it for:

- mission and invariants
- what is shipped
- what is still open
- realistic next work

Do **not** use this doc for line-by-line implementation scaffolding. That belongs either in the code, tests, or the companion design doc.

## Mission

Make workflow validation the authoritative, runtime-equivalent gate for all workflows.

In practice, that means:

- invalid workflows should be caught before user-visible execution
- invalid workflows should not be silently hidden
- validation and runtime should agree on what workflow is actually being executed

## Durable invariants

### 1. Runtime workflow-definition failures are validator failures

If a workflow passes validation and later fails during execution because the workflow definition itself is invalid, the validator is incomplete.

### 2. Validation and runtime must speak the same error language

If runtime can discover workflow-definition errors that validation cannot represent, the validation model is incomplete.

### 3. Validation and runtime must resolve the same workflow

Registry validation and runtime must use the same resolution path for sources, variants, and start construction.

### 4. There is one authoritative validation pipeline

No consumer should decide “is this workflow valid?” by reimplementing validation outside the shared pipeline.

## Validation model

### Tier 1: File validation

Checks whether an individual workflow file is structurally valid.

### Tier 2: Registry validation

Checks workflows as runtime actually discovers and resolves them across sources and variants.

### Tier 3: Execution validation

Checks that workflows can actually run through lifecycle paths without workflow-definition failures.

## Current status

### Shipped or largely shipped

- unified validation pipeline groundwork
- registry-centric validation groundwork
- validation/runtime resolution-parity direction
- fail-louder runtime direction for some previously hidden errors

### Still partial

- lifecycle-harness breadth and real coverage targets
- normalization of stale validation status/operator docs
- fully explicit closure on remaining runtime-vs-validation gaps

### Still open

- broader lifecycle coverage for bundled workflows
- final cleanup of stale operator-oriented validation docs
- any remaining closure work needed for a trustworthy “done” claim

## Remaining work

### Near-term

1. **Expand lifecycle validation coverage**
   - define a realistic target
   - cover more bundled workflows
   - stop implying closure that the current test surface does not support

2. **Finish validation status cleanup**
   - reduce stale operator docs and duplicated entrypoints
   - make this roadmap the clear planning source of truth

3. **Confirm remaining gaps explicitly**
   - document whether any runtime-definition failure classes remain outside the validator

### Later, if needed

1. tighten any remaining runtime/validator parity gaps
2. revisit whether additional execution-integrity tooling is needed

## What success looks like

- validation is the trusted gate for bundled workflows
- the remaining open work is small, explicit, and measurable
- the planning/docs surface is simple enough that contributors know where truth lives

## Live companions

- `docs/plans/workflow-validation-design.md`
- `docs/roadmap/open-work-inventory.md`
- `docs/tickets/next-up.md`
