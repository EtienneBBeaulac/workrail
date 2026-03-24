# Prompt Fragments

This is the **canonical summary doc** for the conditional prompt fragments feature.

Use it for:

- what the feature is
- the final design stance
- shipped status and accepted tensions

## What it is

`promptFragments` lets a workflow step declare small conditional prompt additions that are evaluated at render time against session context.

## Final design stance

- fragments are **runtime-only**
- they do **not** participate in the compiled workflow hash
- they are **additive only**
- they are assembled at the existing prompt-rendering seam
- steps without `promptFragments` behave unchanged

## Why the final design won

The chosen design kept fragment evaluation at render time instead of pushing it into compilation or scattering new context-plumbing across call sites.

That preserved:

- backward compatibility
- deterministic compiled hashes
- a single prompt-construction seam

## Shipped status

This feature is effectively **done**.

Delivered work includes:

- workflow/schema support for `promptFragments`
- render-time fragment assembly
- `in` operator support for conditions
- validation rejecting `{{wr.*}}` tokens in fragment text
- focused tests covering rendering and validation behavior

## Accepted tensions

- fragment provenance is not separately persisted as its own runtime artifact
- context projection during rendering is accepted as part of the existing prompt-rendering seam
- there is no heavy lifecycle/integration harness dedicated solely to fragments

## Source history

The earlier design/review/verification docs for this feature are now superseded:

- `docs/plans/prompt-fragments-design.md`
- `docs/plans/prompt-fragments-design-review.md`
- `docs/plans/prompt-fragments-verification.md`

Use this file plus the shipped code/tests as the canonical view.
