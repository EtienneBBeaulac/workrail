# WorkRail MCP model selection

Status: proposal awaiting the architecture checkpoint. No implementation started.
Related work: GitHub issue #1152. First acceptance client: Codex.

## Problem and intended result

Workflows can declare `modelTier`, but the MCP parallel handoff omits it. The
server also derives concrete Anthropic model names from tiers and records them as
`metrics_active_model`, despite not controlling or observing the client's model.
Continuation can replace that record with a server default. These are separate
failures: lost intent and unsupported claims about execution.

The result should let a client reliably receive the authored model request,
resolve it against an explicit client/operator mapping, and apply the result when
launching a child. WorkRail must explain when that selection cannot be applied.
It must never claim a requested or inferred model actually ran.

## Architecture boundary

WorkRail owns portable requests and deterministic handoff data. The client owns
the available model catalog, spawning operation, model-specific executor names,
and evidence of actual execution. The MCP server does not start provider SDK
loops or use WorkTrain's spawning code.

Keep the existing workflow tiers: `lightweight`, `mid`, and `heavy`. A tier is a
resource preference, not a capability guarantee or a provider model ID. Provider
IDs belong in the client's mapping. There is no built-in Haiku/Sonnet/OpenAI
mapping and no guessed default model.

## Proposed types and behavior

Use one canonical `ModelTier` type and a pure request resolver. Model intent is a
closed union: inherit the current execution configuration, or request a tier
with an explicit source (`session`, `step`, or `workflow`). Absence means inherit;
it does not mean an arbitrary provider model.

For the main session, preserve the existing intended precedence:
explicit `start_workflow.modelTier` override, then current step tier, then
workflow tier, then inherit. Persist the explicit override as immutable run
configuration and derive it on start, advance, and rehydrate. Ordinary agent
context updates must not rewrite that configuration.

For a delegated child, its own explicit `parallelDelegation.modelTier` is the
child request. A parent's main-session override must not automatically override
the child. Without an explicit delegation tier, leave the child's selection to
its own workflow/session resolution and the client's default. Do not assume the
parent tier should cascade through an entire agent tree.

Represent resolved delegations as structured MCP response data, retaining
workflow ID, goal, mapped inputs, tools, and model intent. Produce the readable
prompt from that same data rather than maintaining separate field lists. This
prevents a model request being available in JSON but disappearing from text.

An optional, validated per-run client routing map resolves each tier to one of:

- A dynamic model override target: an opaque client model name.
- A configured executor target: a client agent name that has its model fixed.

The two target kinds are mutually exclusive. WorkRail describes the requested
launch target; the client validates availability before spawning. A route is
configuration, not proof that a model exists or that a launch succeeded. Missing
bindings produce an explicit unresolved request. Do not silently substitute a
different model for an explicit request. Existing workflows without a model
request retain the client's inheritance behavior.

The map is optional and scoped to this run, supplied by the caller. It does not
read or mutate global client configuration. A durable copy supports recovery;
availability is checked again when launching after recovery. Capability caches
are outside this change because they need their own invalidation design.

## Execution evidence and compatibility

Remove tier-derived provider names from MCP model observations. Unknown actual
model identity stays unknown. Preserve trusted host-supplied model information
for in-process consumers; do not reclassify a server environment override or a
worker's statement as independently verified execution.

Avoid changing the signed token wire format. Separate routing configuration and
model evidence from the existing environment attestation machinery. A signature
proves integrity of a record, not truth of a guessed model name. Existing durable
sessions without routing configuration remain resumable.

The distinct answer-profile MCP API (`open_work` / `answer_work`) must be assessed
explicitly. It has a different host boundary; do not claim feature parity solely
because the token-based `start_workflow` path works.

## Alternatives and tradeoffs

Adding `modelTier` to the prompt alone fixes lost information but leaves client
routing, recovery, and misleading observations unresolved. It is an incomplete
fix for model selection.

Hardcoding current provider IDs in WorkRail is initially easy but couples
portable workflows to model releases, accounts, and clients. It also invites
the server to report a model it cannot observe.

Implementing a provider runner inside MCP would provide control but changes
WorkRail's ownership boundary and duplicates client execution responsibilities.
That requires a separate architectural decision.

The recommended design is the portable request plus typed client binding. It
adds a small configuration boundary while keeping the workflow engine pure and
the client responsible for actual launch behavior.

## Implementation slices

1. Reproduce dropped delegation tiers and the false active-model/default refresh
   with tests. Introduce canonical model request/resolution types.
2. Persist the explicit run override and optional routing bindings. Resolve and
   render main-step and child requests from immutable run configuration. Add
   structured delegation data and derive its text from the same representation.
3. Correct model observation behavior and remove hardcoded provider mappings
   from the MCP path. Preserve token compatibility and in-process consumer
   behavior through focused regression checks.
4. Update authoring schema guidance, generated authoring docs, configuration docs,
   and universal executor instructions. Provide a Codex example with explicit
   operator-supplied model bindings.
5. Run independent philosophy/code reviews and the full repository verification.
   Exercise a built local MCP server with Codex before claiming completion.

## Acceptance matrix

| Scenario | Required result |
|---|---|
| Delegation declares lightweight | JSON and text retain the same request |
| Delegation declares heavy | No implicit downgrade to lightweight/inherit |
| Session override differs from step tier | Explicit session override wins |
| Step override differs from workflow tier | Current step wins |
| No request at any level | Inherit without naming a guessed provider model |
| Parent override differs from child request | Child's explicit request survives |
| Client supports dynamic override | Handoff identifies the configured model target |
| Client uses model-specific executors | Handoff identifies the configured executor |
| Binding absent or target unavailable | Explicit unresolved/unsupported outcome |
| Advance or rehydrate | Same immutable routing config; no guessed model refresh |
| Agent context attempts to rewrite routing | Initial run configuration remains authoritative |
| Existing session lacks new fields | Resume without migration or token replacement |
| Actual client model unavailable to server | Observation remains unknown |

Codex acceptance should retain the returned handoff and native spawn call. When
runtime evidence exposes the actual model, record that separately from the
requested target. Otherwise describe only launch acceptance, not verified model
identity. This session's native model catalog does not expose Haiku; a successful
Codex check cannot be presented as Haiku acceptance.

Required checks: `npx vitest run`, type/build checks, `validate:authoring-spec`,
`validate:feature-coverage`, `validate:authoring-docs`, and registry validation.

## Scope

This proposal completes model request/routing for the token-based WorkRail MCP
path. It does not change ownership of implementation in `wr.coding-task`, create
a WorkTrain runner, add provider credentials, or change global client settings.
Actual main-agent model switching remains client-controlled, with explicit
guidance when the current client cannot switch in place.

## Decisions requiring confirmation

Confirm the request-plus-client-binding boundary rather than implementing a
provider runner inside MCP. Confirm that unsupported explicit selections are
surfaced instead of silently falling back. Confirm whether answer-profile parity
belongs in this change or should receive its own scoped issue after assessment.
