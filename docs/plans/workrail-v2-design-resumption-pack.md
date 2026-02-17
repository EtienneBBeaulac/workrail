# WorkRail v2 — Design Resumption Pack

This file is intended to be linked in a brand new chat when prior chat context is lost.
It captures not only decisions, but the *intent*, *tradeoffs*, and the "feel" of how we're designing v2.

## The core goal (north star)

Make agent-driven workflows **deterministic and rewind-safe**, while preserving **high-signal progress** and keeping the **tool surface area simple and hard to misuse**.

## How to use this pack in a new chat

In a new chat, tell the assistant:

1) "Read the canonical documents listed below and treat them as shared memory."
2) "Treat the decisions in this pack as locked unless I explicitly reopen them."
3) "Do not restart from first principles; continue as a collaborative senior-engineer design jam."
4) "Before proposing new primitives, check MCP constraints and failure modes (rewinds, lossy agents, tool discovery)."

## Design philosophy (hard constraints)

- **Immutability / append-only truth** where possible.
- **Architectural fixes over patches** (avoid compatibility hacks that expand surface area indefinitely).
- **Closed sets** (discriminated unions, enums) over loose primitives when it improves correctness.
- **Type-safety** as first line of defense: prevent invalid states by construction.
- **Declarative over imperative**; control flow based on data state, not ad-hoc flags.
- **Soft YAGNI**: avoid scope creep but build proper foundations.
- **Errors as data**: expected failures should be structured, not thrown.
- **Side effects at the edges**: all non-pure operations (filesystem, locks, crypto, clocks) isolated behind ports/adapters; the functional core remains pure and immutable.
- **Per-step outputs, not cumulative** (LOCKED in Slice 4a, §18.1): Each step's `notesMarkdown` IS a fresh summary of that step only, not appended to previous notes. WorkRail aggregates via recap projection for recovery context.

## Operator preferences (conversation context)

These are preferences and collaboration norms expressed during design (not "spec mechanics"):

- **Avoid doc sprawl**: prefer consolidating and referencing canonical docs over adding many small docs.
- **When I say "go for it", execute**: don't restate the plan and wait for confirmation again.
- **When asking decisions, include your recommendation**: provide your take and why, not just options.
- **Keep the system type-safe**: avoid unbounded base primitives (strings/booleans) where a closed set improves correctness.

## MCP reality constraints (hard facts)

- WorkRail is **stdio MCP, local-only by default**.
- **No server push into the chat**; UI cannot "press buttons" that affect the conversation.
- **No reliable transcript access**; rewinds can delete context without warning.
- **Agents are lossy**; tool calls can be malformed; contracts must be self-correcting.
- **Tool discovery is bounded** to initialization/restart; don't assume renegotiation mid-chat.
- **WorkRail cannot introspect the agent's environment**; it only knows the tools it exposes and learns everything else through explicit tool-call inputs/outputs.
- **Sharing requires explicit export/import**; confidentiality is not primary, **integrity is**.

## Canonical documents (shared memory)

Treat these as authoritative:

- `docs/adrs/005-agent-first-workflow-execution-tokens.md`
- `docs/adrs/006-append-only-session-run-event-log.md`
- `docs/adrs/007-resume-and-checkpoint-only-sessions.md`
- `docs/reference/workflow-execution-contract.md`
- `docs/reference/mcp-platform-constraints.md`
- `docs/plans/workrail-v2-design-resumption-pack.md` (this file)

Helpful synthesis:

- `docs/plans/workrail-v2-one-pager.md`

Detailed design references:

- `docs/design/studio.md` (Studio/Console UX and catalog)
- `docs/design/v2-core-design-locks.md` (consolidated v2 locks: event log, preferred tip, gaps, preferences, recommendations, Console, IDs, drift prevention)
- `docs/design/workflow-authoring-v2.md` (detailed authoring reference with JSON examples)

Note: modes/preferences semantics (including the two full-auto variants) are captured in `docs/reference/workflow-execution-contract.md`.

Optional background:

- `ideas/workrail-design-thinking-session-2025-12-16.md`

## v2 in one sentence (definition)

Workrail v2 makes agent workflows resumable and rewind-proof by persisting durable outputs and execution lineage in an append-only run graph.

## What we observed in v1 (current reality / pain points)

This section is intentionally blunt. It describes the "why v2" pressure from the current architecture.

### Execution protocol today is agent-owned state

Current execution (v1) uses a state/event boundary (`workflow_next`) where the agent sends internal engine state and events. v2 replaces this with opaque token-based execution (`start_workflow`/`continue_workflow`) so the agent never constructs engine internals.
That increases:

- agent error rate (it's easy to send the wrong shape),
- contract drift (descriptions and schemas diverge),
- rewind fragility (chat transcript is effectively the storage medium).

### "Sessions" today are a separate mutable JSON world

The current session/dashboard tools store mutable JSON documents and can drift from execution truth under rewinds.
This is the exact class of problem v2 is designed to eliminate by demoting sessions to projections and making the source of truth append-only.

### Workflow determinism is not pinned

Workflows can come from multiple sources (bundled/user/project/git/remote) and override each other by priority.
Without pinning to a content hash snapshot, the same workflowId can behave differently over time or across machines.

### Tool discovery bounded at init makes "toggle features live" impossible

Anything that changes tool set / schemas requires restart of the agent environment.
Any UI/config surface must be designed around "desired vs applied" and "restart required."

## v2 pillars (the shape of the system)

1) **Token-based execution**: opaque handles at the MCP boundary; engine internals hidden.
2) **Durable outputs**: a single durable write path via `output` (notes + optional artifacts).
3) **Append-only truth**: per-session event log + per-run DAG; projections drive UI/exports.
4) **Pinned determinism**: always pin runs to a `workflowHash` computed from the fully expanded compiled workflow (builtins included).
5) **Resumable sharing**: export/import bundles that rehydrate and continue deterministically.
6) **Auditability**: bounded decision traces + correlation IDs; surfaced via dashboard/logs/exports (not agent-facing by default).
7) **Modes + preferences**: guided vs full-auto execution is controlled by a closed set of WorkRail-defined preferences; preference changes are durable and rewind-safe.
8) **Optional capabilities**: workflows may request specific WorkRail-defined capabilities (e.g., delegation or web browsing). Availability is learned through explicit, durable observations and degrades gracefully with Studio warnings.

## Locked decisions (what we chose)

For full mechanics, see the canonical documents. This section captures the **intent, stance, and "feel"** behind the choices.

### Execution boundary (token-based)

- Agent round-trips opaque tokens; never constructs engine internals.
- **Why**: agent-first usability, prevents drift, makes rewinds/forks correct by construction.
- See: `docs/adrs/005-agent-first-workflow-execution-tokens.md`, `docs/reference/workflow-execution-contract.md`

### Modes + preferences (guided vs full-auto)

- **Never hard-block a user-selected mode.** Warn loudly, recommend safer combo, but keep user sovereignty.
- **Full-auto has two variants** (never-stop vs stop-on-user-deps) because different users optimize for different experiences ("do not interrupt me" vs "only stop when truly can't proceed").
- **Agent must play agent+user** in full-auto: no silent skipping of "ask the user" prompts; assume/derive/skip+disclose instead.
- **Session-level toggles are a higher-order idea**: Studio can change session prefs mid-chat; they apply on the next node (not just for modes—general primitive for WorkRail-owned state changes).
- Preference changes are mutable mid-run and durable (apply going forward via node lineage).
- See: `docs/reference/workflow-execution-contract.md` (Preferences & modes)

### Optional capabilities (workflow-shaping)

- **Do not model "baseline tools"** (file ops, grep, terminal) as capabilities. Only model workflow-shaping or optionally-required enhancements (delegation, web_browsing).
- **Features/plugins/probes should be WorkRail-injected** (not hand-rolled per workflow).
  - Why: reduces author burden, prevents drift, enables provenance, keeps compilation deterministic.
- **Degrade gracefully + warn in Studio** when unavailable.
- WorkRail cannot introspect the agent environment; capability availability is learned through explicit attempts/probes.
- See: `docs/reference/workflow-execution-contract.md` (Optional capabilities)

### Workflow authoring (simple + powerful)

- **JSON-first** (not DSL/YAML) until we have concrete authoring pain that templates/features/contract packs can't solve.
  - Why: easier to validate, canonicalize, and hash deterministically; avoids DSL footguns and slippery slope.
- **Builtins catalog must be generated from the same canonical compiler definitions** (not hand-maintained).
  - Why: v1 suffered from tool-vs-docs drift; this prevents it by construction.
- **WorkRail cannot control the agent's system prompt**; `agentRole` is stance guidance only.
- Templates/features/capabilities/contracts are all closed-set and WorkRail-owned.
- **Loops are explicit and deterministic**: authored as `type:"loop"` with explicit ordered `body[]`, required `maxIterations`, and contract-validated loop-control (no arbitrary expression strings or context bags).
- See: `docs/design/workflow-authoring-v2.md`, `docs/reference/workflow-execution-contract.md` (Output contracts, PromptBlocks, AgentRole, Divergence markers)

### Append-only truth, sessions, rewinds, export/import

See the canonical docs for full mechanics:
- Storage substrate is explicitly two-stream (event segments + authoritative `manifest.jsonl` control stream); orphan segments are ignored. See: `docs/design/v2-core-design-locks.md`
- Implementation uses a bounded context (`src/v2/`) to firebreak v2's new truth model (append-only event sourcing) from v1's mutable session world.
- Canonical JSON standard: RFC 8785 (JCS) for all hashing (`workflowHash` + bundle integrity) to prevent drift and hand-rolled canonicalizer footguns.
- Sessions/persistence/DAG: `docs/adrs/006-append-only-session-run-event-log.md`
- Rewinds as forks (auto-fork, no confirmation): `docs/adrs/007-resume-and-checkpoint-only-sessions.md`
- Resumption (layered search + observations): `docs/adrs/007-resume-and-checkpoint-only-sessions.md`
- Export/import (resumable, import-as-new): `docs/reference/workflow-execution-contract.md` (Export/import bundles)
- Determinism via pinning: `docs/adrs/005-agent-first-workflow-execution-tokens.md`

## What we considered and why we chose what we chose (tradeoffs)

### Tokens vs agent-owned state

- **Rejected**: agent-owned state/event internals as the boundary (too easy to misuse; drift-prone).
- **Chosen**: opaque tokens + idempotent ack (engine owns mechanics; replay-safe; rewind-safe).

### Confirmation on fork vs auto-fork

- **Considered**: asking user to confirm forks when a non-tip snapshot is advanced.
- **Rejected**: pushes platform complexity onto user; forks are an engine concern; rewinds are surprise deletions.
- **Chosen**: auto-fork + return lost branch context so the agent can keep going.

### Token copy/paste between chats vs lookup

- **Considered**: only resuming via pasted `stateToken` (low surface area).
- **Rejected**: high user friction for brand new chats.
- **Desired**: `resume_session` lookup tool (layered search, deterministic ranking) as a core usability primitive.
  - Note: the shipped v2 MCP tool surface is currently the closed set: `list_workflows`, `inspect_workflow`, `start_workflow`, `continue_workflow`.

### Workflows vs routines

- **Considered**: hiding routines from discovery to prevent misuse.
- **Rejected**: routines are just smaller workflows; power-users want them directly.
- **Chosen**: list both by default, but mark with `kind: workflow|routine` and sort deterministically.

### Full-auto behavior: never-stop vs stop-on-user-deps

- **Considered**: one "full-auto" mode that always blocks on missing user input.
- **Considered**: one "full-auto" mode that never blocks and always keeps going.
- **Chosen**: support both variants because they optimize different operator experiences:
  - one for "do not interrupt me" (never-stop)
  - one for "only stop when it truly can't proceed" (stop-on-user-deps)
- Hard requirement: full-auto cannot mean "skip user questions"; the agent must act as agent+user and record assumptions/skips durably.

### Preferences as closed set vs policy bag

- **Rejected (hard)**: arbitrary key/value "preference bags."
- **Chosen**: WorkRail-defined closed-set preferences with display-friendly labels and deterministic semantics.
- Why: this keeps behavior predictable, makes Studio UX clean, and prevents drift that would reintroduce v1-style brittleness.

### Streaming / single-step macros

- **Rejected**: streaming-style workflows that require heavy tool usage.
- **Rejected**: single-step "macro" execution as the primary shape.
- Why: both tend to increase tool spam and reduce the clarity/structure that makes v2 resumable and rewind-safe.

### "Dashboard" as read-only vs a control plane

- **Chosen direction**: evolve "dashboard" into a WorkRail Console:
  - workflows list/details (README-like), validate, author (JSON-first), sources, flags, sessions/runs/branches/traces, export/import.
  - Console can only affect WorkRail-owned state; it cannot affect the agent IDE beyond "restart required" guidance.
  - Default session UX is sessions-first and opinionated to avoid "confusing soup":
    - show one active run at a time, render the preferred tip path by default (forks collapsed), and treat `complete_with_gaps` as done-with-follow-ups.

### Bundled workflow overrideability

- **Rejected**: allowing bundled workflows to be overridden/shadowed (confusing and unsafe).
- **Chosen**: bundled/core namespace is reserved and protected (read-only, non-overrideable).

### JSON-first vs DSL vs YAML (authoring format)

- **Considered**: DSL for richer abstractions; YAML for human readability and comments.
- **Rejected for v2**: DSL risks slippery slope toward user-defined logic (conflicts with builtin-only); YAML has canonicalization/determinism footguns (indentation, implicit types, anchors).
- **Chosen**: JSON-first until we have concrete authoring pain that templates/features/contract packs can't solve.
- Why: easiest to validate, canonicalize for deterministic hashing, and keep the surface predictable.

### Capabilities: top-level vs feature pack (authoring)

- **Considered**: capabilities as just another feature inside `features[]`.
- **Chosen**: capabilities as top-level `capabilities` section.
- Why: they have special semantics (requested vs observed, probe rules, Studio warnings); making them first-class keeps the model clearer and Studio UX better.

### Template calls: distinct step type vs syntactic sugar

- **Considered**: templates as a magic field inside normal steps.
- **Chosen**: explicit `type: "template_call"` as a distinct step type.
- Why: schema stays honest, compiled provenance is obvious, and it's easier for Studio to render source vs compiled.

### Feature configs: toggle-only vs typed configs

- **Considered**: all features as simple on/off toggles.
- **Rejected**: would cause feature ID explosion ("feature_X_early" vs "feature_X_lazy").
- **Chosen**: mostly toggle IDs, but a small whitelist can accept `{id, config}` with typed config schemas.
- Why: avoids proliferation while staying closed-set and validated.

### Output contracts: pack references vs inline schemas

- **Considered**: allowing workflow authors to define inline output schemas.
- **Rejected**: creates authoring burden and drift risk.
- **Chosen**: prefer WorkRail-owned contract pack references.
- Why: simple by default, powerful when needed, consistent Studio rendering, no schema authoring required.

### PromptBlocks: required vs optional

- **Considered**: making structured `promptBlocks` required for all steps.
- **Chosen**: optional (plain `prompt` string still allowed).
- Why: keeps authoring friction low; workflows that don't need injection/Studio editing can stay simple.

### Gaps resolution: mutable vs append-only

- **Considered**: mutating gap records when resolved.
- **Rejected**: violates append-only truth.
- **Chosen**: gaps are historical facts with append-only "resolved" markers.
- Why: preserves audit trail and rewind-safety.

## What's still missing / open questions

This section tracks remaining work. Most design locks are now complete; the focus is implementation.

- **v2 core design is locked**: see `docs/design/v2-core-design-locks.md` for the comprehensive implementation locks (durable model, projections, authoring, ops envelope, architecture map, module layout, and ports).
- **Implementation status** (verified against `origin/main` @ `v1.4.0`, 2026-02-17):
  - ✅ **Slice 1 shipped**: v2 bounded context (`src/v2/`), JCS canonicalization, `workflowHash` pinning, compiled workflow snapshots, pinned workflow store. Golden hashes pinned with exact SHA-256 assertions.
  - ✅ **Slice 2 shipped**: append-only session event log substrate (segments + `manifest.jsonl` + single-writer lock + corruption gating), typed closed-set event schemas for all 13 locked event kinds, idempotency enforcement, and pure deterministic projections (run DAG, session health, node outputs, capabilities, gaps, advance outcomes, run status signals, preferences propagation).
  - ✅ **Slice 2.5 shipped**: `ExecutionSessionGateV2` (lock+health+witness choke-point); `WithHealthySessionLock` (opaque branded witness; append requires proof); readonly/append port split; `SessionHealthV2` union with manifest-attested corruption reasons; typed snapshot pin enforcement (no `any`).
  - ✅ **Slice 3 shipped**: token-based execution via `start_workflow` / `continue_workflow` (rehydrate/advance/replay). Binary token format with bech32m encoding, HMAC-SHA256 signing, crash-safe keyring.
  - ✅ **Slice 4a shipped** (PR #55): Semantics lockdown — blockers, gaps, preferences, context persistence, recap recovery, notesMarkdown per-step semantics. 34 files changed, 1846 tests.
  - ✅ **Agent execution guidance shipped** (PR #57): Layers 1-3 — tool descriptions, field descriptions, prompt-based requirement injection.
  - ✅ **Typed artifact validation shipped** (PR #61, `v1.2.0`): `outputContract` replacing `validationCriteria`, `LoopControlArtifactV1` schema, artifact-based loop evaluation, blocked retry UX with first-class blocked nodes, handler decomposition, system-injected contract guidance, golden hash pinning, v2 MCP contract tests, projection timing hooks, v1 fail-fast guard. 112 files changed, 2326 tests passing.
  - ✅ **Slice 4b shipped** (`v1.3.0`): Export/import bundle domain logic — session export, bundle integrity (SHA-256 manifest), import validation + token re-minting, export-import equivalence tests.
  - ✅ **Slice 4c-i shipped** (`v1.4.0`): `checkpoint_workflow` tool — idempotent via opaque `checkpointToken`, creates checkpoint node + edge in run DAG, token minting and replay-safe.
  - ✅ **Slice 4c-ii shipped** (`v1.4.0`, PR #66): `resume_session` tool — 5-tier deterministic ranking (git HEAD SHA, branch, recap notes, workflow ID, recency fallback), `DirectoryListingPortV2` + `SessionSummaryProviderPortV2` ports, up to 5 ranked candidates with fresh stateTokens, 24 ranking tests + 4 enumeration tests + 6 contract tests.
  - **All functional slices are complete.** The locked type-first sequencing is done:
    1. ✅ Canonical models + hashing (no I/O)
    2. ✅ Pure projections
    3. ✅ Storage substrate (ports + adapters)
    4. ✅ Execution safety boundaries (gate+witness; Slice 2.5)
    5. ✅ Protocol orchestration (Slice 3)
    6. ✅ Semantics lockdown (Slice 4a)
    7. ✅ Portability (Slice 4b)
    8. ✅ Checkpoints + Resume (Slice 4c)
    9. Remaining: production workflow migration, polish & hardening (sub-phases A-H)
- **Authoring is finalized**:
  - Initial contract packs are locked: `capability_observation`, `workflow_divergence`, `loop_control` (and gaps integrated into event model).
  - Builtins metadata schema defined (code-canonical + generated).
  - Feature config whitelist locked.
  - `promptBlocks` remain optional.
  - Divergence reasons are a locked closed set.

## Product stance (operator preferences)

These are not theoretical; they reflect explicit preferences and pushback that shape v2's "feel":

- **Prefer broad exploration before deep spec**; don't rush into low-level details prematurely.
- **Avoid nagging**:
  - don't ask the user to choose a mode for every workflow/run; prefer session defaults + user can state intent upfront ("go full auto").
- **No hard blocks**:
  - warn loudly and recommend the best automation combo, but keep user sovereignty.
- **Full-auto must be real**:
  - `full_auto_never_stop` keeps going even through user-only dependencies by gathering context elsewhere or skipping with durable disclosure.
- **MCP only**:
  - no CLI-first automation path; humans go through the agent.
- **Discoverability must be first-class**:
  - builtins (templates/features/contracts/capabilities) won't be used unless they're easily discoverable in Studio (catalog + autocomplete + validation suggestions).
- **Studio is post-core, but core must prepare for it**:
  - don't block core v2 value on Studio UX, but design the substrate (append-only truth, projections, node-attached signals) so Studio becomes natural.
- **Injection by WorkRail, not hand-rolled**:
  - strong preference for features/templates/probes to be injected by the compiler (deterministic, provenance-tracked) rather than requiring authors to copy-paste patterns.
- **Projections are internal-only**:
  - keep MCP tool surface minimal; Studio/Console/CLI share an internal projections module (no new agent tools for read models).

## Notable ideas / "aha moments" (explore if relevant)

These emerged during design but aren't locked yet:

- **Session buttons / queued intents**: Studio can enqueue "intent" actions (like preference changes) that WorkRail applies at the next node boundary (same mechanics as session prefs). Pinned as a later Studio feature.
- **Node-attached divergence markers**: agents can report when they intentionally deviate from workflow instructions, and Studio badges those nodes for audit. This makes "off-script" behavior visible and explainable.

## Assessment (design complete) + invariants to enforce

This section is intentionally opinionated. It exists to preserve the *discipline* of v2, not to restate the specs.

### Why this design will work

- **Rewind-safe by construction**: tokens are opaque handles; truth is an append-only run graph.
- **Deterministic by construction**: runs pin to `workflowHash = sha256(JCS(compiledWorkflow))`; compiled snapshots are persisted and portable.
- **Anti-drift by construction**: code-canonical schemas + generator/verifier is the only sustainable way to keep MCP/CLI/Studio aligned.

### The pressure points (where v2 can regress into v1)

- **Rehydrate becoming a hidden mutation path**: if rehydrate accidentally writes durable truth, resumption becomes non-deterministic. *(Mitigated in Slice 2.5: gate+witness + port split make append impossible without proof.)*
- **Convenience projection tools creeping into MCP**: expanding the agent tool surface for read models reintroduces drift and "session pointer" ambiguity.
- **Idempotent "same response" drifting under retries/forks**: if we recompute outcomes on replay, tiny changes can break determinism. *(Locked normatively in contract: replay must return from durable recorded facts.)*
- **Canonicalization splintering**: if hashing/signing/integrity use different "canonical JSON" implementations, determinism collapses.
- **Loop-control authoring friction**: if loops aren't self-validating by construction, authors will route around with ad-hoc context reads.
- **Slice N+1 substrate gaps** (new lesson, added 2025-12-23): starting a complex integration slice (like Slice 3: orchestration) without verifying that prerequisite boundary schemas/ports/codecs exist forces mid-slice refactors and risks drift. *(Solution: explicit "Slice N+1 readiness audit" checklist in playbook.)*

### Invariants (make these true in code, then enforce with tests)

#### Lock registry + coverage CI (non-optional)

- `docs/design/v2-lock-registry.json` is a required input (not optional docs):
  - read by `scripts/generate-lock-coverage.ts`
  - read by `tests/architecture/v2-lock-coverage.test.ts`
  - used by CI `npm run verify:generated`
- Lock coverage is enforced via `@enforces <lockId>` annotations; CI is zero-tolerance for uncovered locks.
- `npm run generate:locks` writes `docs/generated/v2-lock-coverage.{md,json}` and `docs/generated/v2-lock-closure-plan.md`.
  - Be explicit about whether `docs/generated/*` is committed. The current verification uses `git diff` on those paths, which will not catch missing/untracked files.

- **Rehydrate is pure**:
  - Implement `rehydrate` and `advance` as separate use-cases (not branches inside one), so rehydrate paths cannot access append-capable ports.
  - Test: rehydrate does not change any durable indices/state (event/manifest counts or equivalent).
- **No MCP projection tools**:
  - Tool registry is a closed set with a build-time test asserting the exact allowed tools (core + flagged).
  - Enforce architectural boundaries: projections must not import MCP wiring (lint rule / boundary test).
- **Idempotent same-response**:
  - Do not "re-run logic" on replay. Make replay return from durable facts keyed by `(sessionId, nodeId, attemptId)`.
  - Keep the outcome record minimal and stable (see `advance_recorded` in `docs/design/v2-core-design-locks.md`).
- **One canonicalization path**:
  - One `CanonicalJsonPort` (RFC 8785 JCS) used for `workflowHash`, token signing inputs, and bundle integrity.
  - Make "hashable" inputs a branded type (e.g., `CanonicalBytes`) so callers can't pass `unknown` or ad-hoc JSON.
- **Loops are deterministic by construction**:
  - Loop control should be part of loop compilation (compiler-injected gate), not an optional author discipline.
  - Conditions remain closed set; do not add "read arbitrary context key" condition kinds to paper over friction.

See the normative mechanics and hard locks in:
- `docs/design/v2-core-design-locks.md`
- `docs/reference/workflow-execution-contract.md`

## Instructions for an assistant continuing this design jam

When continuing:

- Read the canonical docs listed above first.
- Treat "Locked decisions" as decisions unless explicitly reopened.
- Keep pace brisk and grounded in constraints and failure modes.
- Propose options with explicit tradeoffs; prefer closed sets and append-only models.
- Avoid expanding the MCP tool surface unless it tightens correctness or reduces user friction materially.
- Treat modes/preferences as first-class; remember the two full-auto variants and the "agent plays agent+user" requirement.

## Session timeline (2025-12-22)

This is a concise record of what we did in this chat, for resumption continuity (not a spec).

- Read the resumption pack, `v2-core-design-locks.md`, and referenced canonical docs; identified the highest-risk drift points.
- Chose and tightened several v2 locks (checkpoint lineage, idempotency handles, deterministic outputs, error/corruption gating) and updated docs for consistency.
- Split v1-heavy docs into v1/v2 variants with router entrypoints to avoid confusion while preserving inbound links:
  - authoring: `docs/authoring.md` → `docs/authoring-v1.md` / `docs/authoring-v2.md`
  - context optimization docs: `docs/features/*` split into `*-v1.md` / `*-v2.md` plus routers
  - feature flags architecture: `docs/features/feature-flags-architecture.md` split into `*-v1.md` / `*-v2.md` plus router
- Verified doc consistency via repo-wide grep and a final "thorough check".
- **v1 usability fix (shipped)**: improved `workflow_next` error UX with pre-validation + copy-pasteable templates (agents were failing until they guessed the right `state` shape; now errors are self-correcting without schema changes).

### What's next (current status as of 2026-02-17)

**All functional slices are complete and released as v1.4.0.** The full v2 MCP tool surface (`list_workflows`, `inspect_workflow`, `start_workflow`, `continue_workflow`, `checkpoint_workflow`, `resume_session`) is implemented and passing CI. All tools are currently feature-flagged behind `WORKRAIL_ENABLE_V2_TOOLS=true`.

#### Recently shipped (since last update)

- ✅ **Slice 4b** (`v1.3.0`): Export/import bundle domain logic with SHA-256 manifest integrity, import validation + token re-minting, export-import equivalence tests.
- ✅ **Slice 4c-i** (`v1.4.0`): `checkpoint_workflow` tool with idempotent replay via `checkpointToken`, checkpoint node + edge in run DAG.
- ✅ **Slice 4c-ii** (`v1.4.0`, PR #66): `resume_session` tool with 5-tier deterministic ranking (git HEAD SHA, branch match, recap notes, workflow ID, recency fallback). Segregated `DirectoryListingPortV2` + `SessionSummaryProviderPortV2` ports. Returns up to 5 ranked candidates with fresh stateTokens.

#### Remaining work

**Production workflow migration** (~1 day):
- Migrate existing workflows from `validationCriteria` to `outputContract`
- Test workflow exists as reference pattern (`test-artifact-loop-control.json`)

**Polish & Hardening (Sub-phases A-H)** (~3-5 days):
- See `v2-core-design-locks.md` section 16.5
- Some items partially done: projection timing hooks (G), import boundary tests (H), v1 fail-fast guard (H)
- Remaining: anti-drift enforcement (A-B), property-based determinism tests (D-E), error ergonomics (F)

**Unflag v2 tools** (after polish):
- Remove `WORKRAIL_ENABLE_V2_TOOLS` gate
- `resume_session` and `checkpoint_workflow` may retain separate unflag gates if needed

**Next agent should**:
- Read `v2-core-design-locks.md` sections 16.1-16.5 (implementation blueprint + playbook + polish phase).
- Run the remaining Polish & Hardening sub-phases (A-H) before unflagging v2.
- Migrate production workflows from `validationCriteria` to `outputContract`.

#### Historical reference: lock tightening sessions (2025-12-21 to 2025-12-23)
All design locks were audited and tightened across these sessions. Key decisions include: rehydrate/advance/replay separation, append transaction protocol, fork modeling, token crypto, checkpointing semantics, resume matching, corruption gating, and error envelope. These are now all implemented and tested. See `v2-core-design-locks.md` for the full locked mechanics.

### Conversation style & collaboration patterns

**How we work together** (reproduce this in the next chat):

- **Natural back-and-forth ideation**, not robotic Q&A.
- **When proposing options or asking questions, provide enough context** - don't just give 3-word labels:
  - ❌ Bad: "1) Option A  2) Option B  3) Option C - which do you prefer?"
  - ✅ Good: "1) **Option A (prefer X over Y)**: this optimizes for Z because... *Why it matters*: ..."
- **Include your reasoning and recommendations** when asking - this helps me react/refine faster.
- **Bounce ideas off each other** - you can ask me questions that include your own thoughts.
- **Make conversations flow naturally** - not a series of "here's the list, pick one" prompts.

**Common patterns that worked well**:
- "I think X is better because Y, but Z is the tradeoff. What do you think?"
- "Let's ideate on A. Here are three shapes: [detailed explanation of each]. My take: ..."
- "Agreed. Next question: should we do B or C? I'd lean toward B because [reasoning], but here's when C would be better..."

**When I push back**:
- Take it seriously - it usually means I see a footgun or misalignment with the product feel.
- Don't just acknowledge and move on - explore why I pushed back and incorporate that into the design.

### Editing this resumption pack

#### Known paper-cuts (keep this list honest)

- The lock registry declares `$schema: "./v2-lock-registry.schema.json"` but that schema file may not exist.
- Some lock entries reference `v2-architectural-hardening-final.md`; ensure the referenced source exists or update the registry sources.

**IMPORTANT**: Before editing this file, ALWAYS create a backup first:
```bash
cp docs/plans/workrail-v2-design-resumption-pack.md docs/plans/workrail-v2-design-resumption-pack.md.backup
```

**Editing preferences**:
- Use the proper Firebender tools (`read_file`, `edit`, `write`) - NOT terminal commands for file reading/editing.
- Don't be lazy - complete edits thoroughly and verify they worked.
- When asked to triple-check or verify, actually do it comprehensively.
- If an edit fails, don't keep retrying the same approach - use a different tool or method.
- This file should focus on **operator voice, preferences, tradeoffs, and "feel"** - not duplicate the canonical specs.
- Point to canonical docs rather than restating mechanics.

---

## Slice 4a Implementation Status (2026-01-06)

**Status**: ✅ COMPLETE - Merged to main (PR #55)

**What was implemented**:
1. **Recap recovery** (S9):
   - Tip detection via projectRunDagV2.tipNodeIds
   - Tip recovery: ancestry recap + function definitions
   - Non-tip recovery: child summaries + preferred-branch downstream recap + function definitions
   - 12KB budget (RECOVERY_BUDGET_BYTES) with deterministic [TRUNCATED] marker
   - O(1) UTF-8 boundary trimming (proven algorithm)
   - Single renderPendingPrompt seam (4 call sites unified)
   
2. **Context persistence** (S8):
   - Run-scoped context_set event (DomainEventV1Schema)
   - projectRunContextV2 projection (latest event per runId)
   - start_workflow emits context_set when initial context provided
   - continue_workflow auto-loads + shallow merges with delta
   - Null tombstones (delete keys), reserved key rejection
   - Rehydrate purity preserved (zero writes on rehydrate-only path)

3. **notesMarkdown semantics** (S6):
   - Tool schema: per-step fresh description
   - Contract: normative section added
   - Design lock §18.1 CLOSED

4. **Test coverage** (S7):
   - context_budget blocker pointer test
   - nextIntent exhaustive matrix test
   - 21 new test files, 1846 tests total

**Design decisions closed**:
- §18.1: notesMarkdown accumulation → LOCKED as per-step fresh
- §18.2: Context persistence → LOCKED as context_set event (run-scoped, shallow merge)

**Philosophy alignment**:
- All functions < 50 lines (decomposed 143-line function into 4 helpers)
- Branded types (NodeId, RunId) throughout
- Pure functional style (zero mutations, zero imperative loops)
- Recursive traversals with cycle protection
- Comprehensive docstrings on all public functions

**Files**: 34 changed (+6266/-95 lines)

**Next slices**: 4b (portability), 4c (resume_session + checkpoint_workflow)

---

## Slice 4a+ Implementation Status (2026-01-06 onwards)

### Agent Execution Guidance (✅ IMPLEMENTED - PR #57, 2026-01-09)

**Status**: ✅ Complete - Layers 1-3 implemented and merged to main

**What was implemented**:

**Layer 1 - Tool Descriptions** (src/mcp/tool-descriptions.ts):
- Rewrote v2 tool descriptions with behavioral guidance matching v1 clarity
- Added "workflow = user speaking" mental model framing
- Explained nextIntent values inline
- Added context auto-loading clarity
- Included WRONG/RIGHT examples for notesMarkdown

**Layer 2 - Field Descriptions** (src/mcp/v2/tools.ts):
- Enhanced Zod field descriptions with lifecycle clarity
- Differentiated stateToken (session handle) vs ackToken (completion receipt)
- Clarified context auto-loading behavior
- Added per-step fresh examples

**Layer 3 - Prompt-Based Requirement Injection** (NEW):
- Created `validation-requirements-extractor.ts` - pure function extracting requirements from validationCriteria
- Enhanced `prompt-renderer.ts` - appends requirements to pending.prompt
- Agents see validation requirements BEFORE working (proactive vs reactive)
- Covers contains (51%), regex (36%), length (13%) + and compositions

**Validation Results**:
- Baseline: 40% agent error rate with v2 tools
- Post-L1+L2: 33% error rate (eliminated prediction behavior, context re-passing, notes accumulation)
- Target: <10% with Layer 3 (validation requirements visible proactively in prompts)

**Design Decision**: 
Originally proposed `agentInstructions` field in responses (900 lines of parsing logic). After validation testing and 5 subagent reviews, pivoted to prompt-based injection (50 lines) as simpler and more philosophically aligned (fail fast = proactive, architectural fix not patch).

**Related Design Locks**:
- §18.3 in v2-core-design-locks.md (full implementation details)
- §19 in v2-core-design-locks.md (evidence-based validation design - prevents gameable validation when requirements visible)

---

### Typed Artifact Validation + Blocked Retry UX (✅ IMPLEMENTED - PR #61, 2026-02-16)

**Status**: ✅ Complete - Squash-merged to main as `v1.2.0`

**What was implemented**:

**Phase 1 - Validation Requirements + Artifact Wiring**:
- `prompt-renderer.ts`: Wired `extractValidationRequirements` to append `**OUTPUT REQUIREMENTS:**` section to prompts when `validationCriteria` is present
- `events.ts`: Extended `ArtifactRefPayloadV1Schema` with `content: z.unknown().optional()` for inlined artifacts
- `v2-execution.ts`: Artifacts from `output.artifacts[]` are canonicalized, hashed, and stored as events at both advance paths

**Phase 3 - Architectural Fix (typed artifacts replacing substring validation)**:
- **Slice A1**: `LoopControlArtifactV1Schema` — typed artifact with `decision: 'continue' | 'stop'`, replacing brittle `contains("continuePlanning = true")` prose checks
- **Slice A2**: Artifact projection (`projectArtifactsV2`) + loop control evaluator (`evaluateLoopControlFromArtifacts` / `evaluateLoopControlWithFallback`)
- **Slice A3**: `OutputContract` type on `WorkflowStepDefinition`, `validateArtifactContract()` pure validator, handler integration via `getOutputRequirementStatusWithArtifactsV1()` — validates `outputContract` first, falls back to `validationCriteria`
- **Slice A4**: Test workflow (`test-artifact-loop-control.json`) demonstrating new pattern

**Loop Condition Integration**:
- `workflow-interpreter.ts`: `while`/`until` loop conditions now use `evaluateLoopControlWithFallback(artifacts, loopId, contextDecision)` — artifacts override context when present, with legacy fallback
- `v2-execution.ts`: Builds `artifactsForEval = truthArtifacts + input.output.artifacts` and passes into both `interpreter.next(...)` calls
- System-injected contract guidance: `formatOutputContractRequirements()` renders canonical guidance from contract metadata (not from authored prompts)

**Workflow Schema Updates**:
- `workflow.schema.json` + `workflow.schema.v0.0.1.json`: Added `outputContract` to `standardStep`
- Both `validationCriteria` (legacy) and `outputContract` (preferred) supported simultaneously

**Quality & Hardening**:
- Golden hash fixtures now contain pinned `expectedSha256` values — tests assert exact match (catches canonicalization drift between releases)
- v1 `validateStepOutput()` fail-fast guard: returns error if step uses `outputContract` (prevents silent bypass through legacy path)
- `withProjectionTiming()` — pure higher-order wrapper for measuring projection performance before optimizing
- New `tests/contract/v2-mcp-tools.contract.test.ts` — 38 boundary tests covering all v2 MCP response shapes and closed sets

**Handler Decomposition**:
- Extracted focused modules from the v2-execution handler (blocked-node builder, validation criteria validator extensions)

**Test Coverage**: 2326 tests passing across 179 test files

**Design Decisions**:
- `outputContract` takes priority over `validationCriteria` when both present (no dual validation)
- Artifact-based loop evaluation uses `frame.loopId` as the artifact `loopId` (simplest mapping, no schema change needed)
- System-injected guidance is contract-driven (contract registry → canonical instructions), not prompt-dependent
- v1 compatibility maintained: `WorkflowInterpreter.next()` accepts optional `artifacts` param (defaults to `[]`)

---

## Open items (remaining v2 work)

**All functional slices shipped** (v1.4.0). Remaining work is migration + hardening.

**Production workflow migration** (~1 day):
- Migrate existing workflows from `validationCriteria` to `outputContract`
- Reference pattern: `test-artifact-loop-control.json`

**Polish & Hardening** (sub-phases A-H, ~3-5 days):
- See `v2-core-design-locks.md` section 16.5
- Partially done: projection timing hooks (G), import boundary tests (H), v1 fail-fast guard (H)
- Remaining: anti-drift enforcement (A-B), property-based determinism tests (D-E), error ergonomics (F), dead code removal

**Unflag v2 tools** (after polish):
- Remove `WORKRAIL_ENABLE_V2_TOOLS` gate so v2 tools are available by default
- `resume_session` and `checkpoint_workflow` may retain separate unflag gates if gradual rollout is preferred
