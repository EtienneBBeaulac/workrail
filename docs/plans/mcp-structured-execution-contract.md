# Complete MCP execution responses

Tracks #1364. Status: implemented and locally verified, not shipped.

## Contract

A client choosing `structuredContent` must receive the same public execution state as a client choosing JSON text. Start, rehydrate, advance, blocked, completed and gate-checkpoint outcomes retain their existing fields. References and applicable protocol supplements travel alongside that state as typed delivery data. A pending step alone is not an execution response.

For example, onboarding returns a pending instruction plus continuation authority. The client uses the returned next call to reach its assignment, supplies invalid output and receives a blocked result with retry instructions, corrects the output and reaches completion with no pending step or next call. None of these operations requires extracting information from prose. A workflow-discovery result remains a non-execution result with its existing presentation.

## Design

The ideal is one immutable, typed public payload with separate renderers. Reuse the existing concrete start/continue output schemas and their outcome union. Add typed references and supplements to those schemas, constrain execution metadata and handler success types, and construct the public payload once at the MCP boundary. Use the public response's pending step rather than rebuilding it from parallel render metadata. Validate the assembled payload against its complete output schema before publication. Only the validated construction seam can produce the branded structured-output type; validation preserves the canonical object rather than projecting fields away. Both structured content and JSON text use the exact payload. Formatted text renders that payload with the existing lifecycle and content ordering.

Advertise the corresponding output schemas for start and continue through the existing tool-definition and SDK boundaries. Use the installed JSON-schema conversion library for output schemas, keeping the existing input conversion unchanged. Verify discovered schemas against actual responses, including tool errors that are outside successful-output schemas.

This replaces the smaller alternative of adding token fields to the pending-only projection. That alternative would keep a second field list that can drift and would still exclude no-pending outcomes and delivery guidance. No token signing, engine routing, daemon, console or workflow-schema changes are needed.

## Implementation and verification

1. Add a structured-only MCP lifecycle regression and confirm failure on the unchanged boundary. Include a fresh process for classic, clean and JSON modes, cold rehydration, a blocked/retry path and completion. Unit cases cover gate checkpoints, warnings, metadata and non-execution compatibility.
2. Introduce the canonical execution payload and typed result boundary; preserve references, supplements, warnings, model policy and exact next-call/retry authority. Advertise the full output contract and add compile-time negative examples for pending-only results and envelopes.
3. Update protocol and author guidance, then run the full test suite, typecheck, build and authoring validators. Verify the built server over actual stdio with a structured-only client. Obtain independent structural/design review before implementation and independent philosophy/code review afterward.

The blind ideal review confirmed the explicit execution-metadata seam and identified blocked binding warnings, no-pending outcomes, reference delivery and supplement parity as necessary coverage. These are included in the contract. Existing text ordering is supplements, primary content, references; documentation will be corrected to match it.

## Boundaries

The existing investigation establishes the server defect, not the original reporter's exact client transition date or stalled-session count. This work ends with a reviewed and locally verified branch. Publication and merge require the repository owner's separate instruction.
