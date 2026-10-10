# WorkRail startup detection and measured acceptance

Status: shared sniff and p99 boundary approved by the owner; implementation tracked in #1346. Parent: issue #1152, SC-2 and the harness portion of SC-4. This follows the delivered portable MCP model-selection boundary.

## Current mechanism

`src/v2/usecases/start-workflow.ts` and `src/mcp/handlers/v2-execution/continue-advance.ts` each read process environment and independently classify a harness. Both use `TERM_PROGRAM=vscode` as evidence for Cursor. That marker identifies a terminal environment, not a specific client. Start also considers trusted internal trigger context; continuation currently uses a different input set.

The existing synchronous sniff has no isolated performance receipt. Timing all of `start_workflow` would include workflow loading, workspace resolution, signing and persistence, and would not measure SC-2's named boundary.

## Proposed boundary

1. Capture supported environment indicators at the host boundary. Resolve a closed, immutable harness observation with a small pure function shared by start and the first new advance after recovery. Explicit supported overrides retain precedence. Generic VS Code or absent markers resolve to generic MCP, rather than inventing Cursor identity.
2. Keep classification separate from execution capabilities and provider identity. A sniffed harness must not grant delegation permissions, fabricate an active model, or prove a provider identity. Trusted host inputs retain their own provenance.
3. Preserve existing durable attestation signing and verification. Align fresh advance with the same classifier without changing opaque token handling or importing daemon implementation into MCP.
4. Simple workflows must start without an LLM capability handshake. Verify the actual MCP start path and durable observations using isolated data roots.

## Input and transition contract

The proposed closed input has supported environment indicators plus an optional trusted current host trigger (`daemon` or `mcp`). An override takes precedence, followed by Claude markers, an explicit Cursor marker, a daemon marker or a trusted current daemon trigger, then generic MCP. Invalid override values retain the existing fall-through behavior for this slice. Conflicting markers follow that explicit precedence table. A generic VS Code marker supplies no Cursor evidence.

Process markers describe the server environment, not the identity of each HTTP-connected client. Trusted host trigger provenance is separate from those observations; neither grants capabilities. Start uses its actual trusted host input. Fresh advance uses a trusted current input only where the execution boundary actually supplies one; it must not promote mutable stored context or a prior harness into proof of the current host. Thus a daemon-origin session advanced in a fresh generic MCP process without current daemon evidence records generic MCP. Rehydrate and idempotent replay preserve stored observations and do not sniff again. Only the first new advance refreshes the observation. Test that distinction in a start-then-fresh-process advance scenario. WorkTrain parity is not claimed.

## Performance acceptance

Pre-register an assay before measuring. Time the exact production environment-capture-plus-classification entry point, not a copied implementation or already captured input. Module import and full process startup are reported separately. Report first-invocation latency across fresh processes separately from warmed invocation latency and full startup latency. The proposed SC-2 threshold is p99 below 2ms for both sniff distributions on the named host and runtime, with raw samples and the maximum retained. This is bounded measured evidence, not a universal worst-case scheduler guarantee.

Pre-register 200 fresh-process first-call samples and 10,000 individually timed warmed calls per scenario, using nearest-rank p99 (sorted sample at ceil(0.99*N)). Retain raw samples, median, p99 and maximum, host/runtime identity and source/build digests. Cover each supported precedence branch and the unknown case. Exclude process launch/import time from the sniff threshold while reporting it separately.

The negative control must execute successfully and introduce a bounded delay within the measured classifier boundary; it must fail the same threshold check. Missing modules, failed builds and process errors are not negative timing evidence. Record functional classification controls separately, including generic VS Code, explicit Cursor, Claude, daemon, generic MCP, override precedence and changed environment on recovery.

## Decisions required

- Approve the shared classifier plus correction of the generic VS Code classification, or restrict this slice to acceptance measurements around existing behavior.
- Approve the p99 under-2ms criterion with first-call and warm results separately reported. An absolute wall-clock maximum requires an explicit scheduling/platform envelope.

## Non-goals

No WorkTrain daemon routing implementation, new provider identity attestation, global model settings, new client-specific executor setup, or automatic expansion of supported harness identities. Cross-client native acceptance remains separate work under #1152.

## Execution

After the boundary is approved, record a scoped issue if needed, register this plan and relevant source contracts in the feature store, complete gather/design gates, and implement in this isolated worktree. Required validation includes targeted start/recovery tests, structural import checks, real MCP simple-workflow acceptance, the falsifiable performance assay, full Vitest/build/registry/authoring checks, and authoring guidance for changed public behavior. No push or merge is implied by the current planning step.
