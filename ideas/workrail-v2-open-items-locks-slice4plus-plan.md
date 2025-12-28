# WorkRail v2 — Open Items Lock-In + Slice 4+ Plan (Design Thinking Anchor)

## Context / Problem
- WorkRail v2 is designed to be **deterministic and rewind-safe** under MCP constraints (no transcript access, no server push, lossy agents).
- Slice 3 (token orchestration) is nearly complete; remaining work is to:
  - lock down any remaining v2 open items / gaps (closed sets, schemas, policies),
  - plan and execute Slice 4+ (blocked/gaps, export/import, resume, checkpointing),
  - update canonical docs so design intent and implementation do not drift.

## Persona
- **Primary**: WorkRail operator/maintainer (Etienne), driving v2 to “shippable” with minimal drift risk.
- **Secondary**: future contributors who need crisp invariants, closed sets, and slice plans that prevent accidental v1 regressions.

## POV + HMW
- **POV**: A maintainer shipping v2 needs the remaining “open items” to become **locked closed sets** with deterministic semantics so Slice 4+ can be implemented without protocol drift.
- **HMW**:
  - How might we eliminate remaining ambiguity (especially around gaps/blockers/preferences/tip policy) without expanding the MCP surface?
  - How might we slice Slice 4+ so each PR has crisp acceptance criteria and doesn’t compromise v2’s invariants (rehydrate purity, fact-returning replay, append-only truth)?

## Success criteria
- **Design**:
  - All remaining open items are either (a) locked with explicit closed sets and semantics, or (b) explicitly deferred with a bounded rationale.
  - Canonical docs agree (no “open items” that are already locked elsewhere).
- **Implementation readiness**:
  - Slice 4+ is broken into concrete sub-slices (or PR-sized chunks) with quality gates and test targets.

## Phase 1 — Empathize (Constraints, Reality, and Pain)

## Persona card (primary)
- **Name**: “WorkRail v2 Maintainer”
- **Context**: ships v2 in a lossy agent + rewindable chat environment; must preserve determinism, correctness, and resumption across restarts/imports.
- **Goals**:
  - Ship v2 with **minimal MCP surface** and **maximal rewind safety**.
  - Make “what happened” recoverable **without transcript**.
  - Prevent drift between docs, schemas, compiler, and UI (“single source of truth”).
- **Pains**:
  - “Open items” distributed across docs can drift or conflict.
  - Slice 4+ work spans protocol + storage + UX projection semantics; easy to accidentally expand surface area or reintroduce v1-style mutability.
  - Agents are inconsistent; correctness must be enforced structurally (types/witnesses) rather than via best-effort guidelines.
- **Constraints**:
  - MCP constraints: no server push, no transcript access, bounded tool discovery, lossy/replayed calls.
  - v2 locks: append-only truth, pinned determinism (`workflowHash`), rehydrate purity, replay must be fact-returning.
- **Quotes/observations (from evidence we have)**:
  - “Chat UIs allow users to rewind/edit… WorkRail cannot access the transcript.” (MCP constraints + ADR 005/006)
  - “Tool boundary drift is easy when the public API exposes engine internals.” (ADR 005)
  - “Rehydrate-only is side-effect-free (normative).” (Execution contract)

## Journey map (lightweight)
- **Step**: Identify remaining open items → **Pain**: open items are scattered / contradictory → **Opportunity**: consolidate + lock closed sets in one place
- **Step**: Lock enums/schemas/policies → **Pain**: temptation to leave “TODO” bags/strings → **Opportunity**: enforce via schema + types + deterministic ordering/budgets
- **Step**: Plan Slice 4+ work → **Pain**: too-big mega-slice risk → **Opportunity**: sub-slices with gates and tests per invariant
- **Step**: Update canonical docs → **Pain**: easy to forget to remove outdated “open items” → **Opportunity**: treat docs as part of the slice deliverable (definition of done)

## Observations (5)
- **O1**: The environment is rewindable and WorkRail cannot read the transcript; correctness must be derived from durable storage, not chat history.
- **O2**: v1 experienced drift between tool descriptions and actual tool schemas/semantics when engine internals were exposed at the boundary.
- **O3**: v2 correctness depends on strict separation: rehydrate is pure, advance is append-capable, replay is fact-returning (no recompute).
- **O4**: v2 already has many “locks” (tokens/HMAC/JCS, append-only substrate, event kinds), but the execution contract still lists “Open items” that need resolution to ship Slice 4+.
- **O5**: Studio/Console must be a projection layer over append-only truth; it cannot “control the chat” and must surface “desired vs applied” + “pending vs applied-at-node” semantics.

## Insights (5)
- **I1**: Rewind-safety is primarily a *storage + protocol* property, not a UX property; anything that relies on transcript context will fail under rewinds. (O1)
- **I2**: “Drift prevention” requires eliminating stringly extensibility: closed sets + canonical schemas + generated registries must be treated as product-critical. (O2, O4)
- **I3**: The most fragile v2 surface is *outcome semantics* (blocked vs gaps vs replay) because it’s both correctness and UX; it must be locked before implementing Slice 4+. (O3, O4)
- **I4**: Slice 4+ should be planned around invariants and quality gates rather than features; each sub-slice should prove a specific lock (e.g., export/import equivalence). (O3, O4)
- **I5**: Studio UX can be designed later, but the durable data model must already encode everything Studio needs to render explainable states after rewinds (blocked reasons, gaps, preferences, capability observations). (O5, O3)

## Evidence
- **Facts we have**:
  - Canonical docs enumerate MCP constraints, token semantics, append-only substrate, and slice sequencing.
  - Current contract explicitly lists unresolved open items (preferences, gaps shape, user-only deps, preferred tip policy, etc.).
- **Evidence gaps**:
  - Which “open items” are truly undecided vs already implicitly decided in `v2-core-design-locks.md`.
  - Real-world examples of user-only dependency reasons (to validate closed-set categories).

## Constraints (environment/tooling/model)
- **Platform**: MCP stdio; bounded tool discovery; no transcript access; no server push; agents are lossy/replay-prone.
- **Architecture**: append-only truth; tokens are handles; pinned determinism via `workflowHash = sha256(JCS(compiledWorkflow))`.
- **Operational**: corruption gating; execution requires `SessionHealth=healthy`; salvage is read-only.
- **Product**: minimal MCP surface; no projection tools; Studio is a projection/control plane for WorkRail-owned state only.

## Observed pain themes (5–10)
- Drift risk when “open items” remain in multiple docs.
- Closed sets are sometimes described as “deferred” but required for UX correctness (blocked/gaps, preferences, user-only deps).
- Slice boundaries can blur; risk of mixing “protocol correctness” with “Studio ergonomics.”
- Difficulty proving determinism across export/import without a dedicated equivalence test suite.
- Capability detection is inherently lossy; provenance must be durable and explainable.

## Unknowns (explicit list)
- Final closed set for **UserOnlyDependencyReason** (and how it maps to blockers/gaps).
- Final closed set for **preferences** (keys/values) + Studio labels.
- Canonical **gaps** shape (if any tool-level shape is needed beyond event model) and its interaction with `blocked`.
- **Preferred tip policy**: deterministic ranking of branches/tips for resume + Studio default path.
- Exact scope of **output contracts** enforcement in Slice 4+ (which packs are “required to ship” vs “nice to have”).

## Interpretation risks (3)
- We may be treating some items as “open” that are already locked in implementation (doc drift).
- We may overfit closed sets too early without enough real usage, causing churn later.
- We may conflate “what Studio wants” with “what correctness requires,” expanding the durable model unnecessarily.

## Reflection (brief)
- **Likely symptoms vs root causes**: doc drift and protocol ambiguity are symptoms; root cause is missing single-source-of-truth closures for the remaining enums/policies + lack of a single “ship checklist” for Slice 4+.
- **Disproof signals**: if code already fully defines these closed sets and semantics (tests/golden fixtures) then the gap is purely documentation and planning, not design.

## Phase 2 — Define (POV + HMW + Success Criteria)

## POV (Point of View)
- **WorkRail v2 maintainer** needs **a single, code-aligned set of locked closed sets + policies for Slice 4+** because **any residual ambiguity (blocked/gaps/preferences/tip policy) will reintroduce drift and break rewind-safe determinism once we ship resumable export/import and resume-by-query**.

## Problem statement (2–4 lines)
- Slice 3 is nearly complete, but v2 still contains scattered “open items” (and some doc-vs-lock inconsistencies) around preferences/modes, gaps/blockers semantics, resume “preferred tip” policy, and contract pack readiness.
- Without locking these now and reconciling canonical docs, Slice 4+ work (resume/export/checkpoint) risks either expanding the MCP surface or encoding ambiguous behavior that will drift across projections and time.

## Alternative framings (2)
- **If we’re wrong about the core problem**: the “open items” are mostly already decided in `v2-core-design-locks.md` and in code; the real work is a **docs reconciliation + tests proving invariants**, not new design.
- **Radically simpler interpretation**: we only need to ship a minimal Slice 4 that implements export/import and resume without adding new semantics—defer “fancy gaps UX / richer prefs” and rely on a minimal blocked model + notes-only durable outputs.

## How might we… (3–7)
- How might we **collapse remaining ambiguity** into a small set of locked enums/schemas with deterministic budgets and ordering?
- How might we ensure **blocked vs gaps** is mode-driven *view logic* over one underlying reason model, without creating parallel semantics?
- How might we lock a **preferred tip policy** that is deterministic, explainable, and compatible with auto-fork behavior?
- How might we plan Slice 4+ into sub-slices where each has a crisp **quality gate** (e.g., export/import equivalence)?
- How might we update canonical docs so “open items” are either removed (locked) or explicitly deferred with rationale and owner?

## Success criteria (measurable where possible)
- **No “Open items” remain** in `workflow-execution-contract.md` that block Slice 4+ implementation (either locked or explicitly deferred).
- **Single authoritative definitions** exist for:
  - `UserOnlyDependencyReason` (closed set)
  - `Preferences` keys/values (closed set)
  - gaps + blockers mapping rules
  - preferred tip policy (deterministic)
- Slice 4+ plan is committed to docs with:
  - sub-slices and deliverables
  - per-slice quality gates/tests (export/import equivalence, deterministic ranking, idempotency, corruption gating)

## Key tensions / tradeoffs
- **Locking early vs learning**: closed sets reduce drift but can churn if real usage demands expansion.
- **Minimal MCP surface vs operator convenience**: resist adding new agent tools to query projections.
- **Purity and correctness vs shipping speed**: avoid shortcuts (recompute on replay, salvage execution) even if tempting.

## Assumptions
- Slice 3 provides stable primitives (tokens, CAS snapshots, witness gating, replay is fact-returning).
- The remaining “open items” can be locked without needing broad user studies (we can expand closed sets later with versioning discipline).
- Studio/Console can remain “post-core,” but the durable model must already encode what Studio needs.

## Riskiest assumption (pick one)
- The closed set for **user-only dependency reasons** can be made small and durable without immediately needing expansion.

## What would change our mind?
- Evidence that:
  - real workflows frequently require reasons outside the proposed closed sets (forcing expansion),
  - or that our preferred tip policy produces confusing defaults in multi-branch sessions.

## Out-of-scope
- Full Studio implementation or UI polish beyond what’s required to validate the model.
- Adding additional MCP projection tools.

## Proceeding to Ideation — readiness check
- We have enough constraints and known pain to ideate solutions; the main risk is doc-vs-code drift, not lack of problem definition.

## Idea Backlog (append-only)
## Idea Backlog (Round 1)

- **DT-001 — Reconcile “open items” vs “locks” across docs (single truth pass)**
  - **What**: Audit `workflow-execution-contract.md` Open items vs `v2-core-design-locks.md` + implementation; delete/replace anything that’s already locked; leave only true TBDs.
  - **Why**: eliminates doc drift before we lock new semantics.
  - **Risks**: none (pure reconciliation).

- **DT-002 — Lock `UserOnlyDependencyReason` (closed set) + mapping to `ReasonCode`**
  - **What**: Define a small closed set for user-only dependencies (e.g., `missing_user_artifact`, `missing_user_decision`, `missing_credentials`, `policy_requires_user_ack`), and lock mapping → `ReasonCode.user_only_dependency:*`.
  - **Why**: needed for consistent `blocked` + `gap_recorded` behavior across autonomy modes.
  - **Risks**: premature taxonomy; mitigate by versioning and “other” avoidance (prefer expanding closed set).

- **DT-003 — Lock “gaps” as the single durable disclosure primitive (no separate tool-level gaps shape)**
  - **What**: Treat `gap_recorded` as canonical; tool responses may include a small summary view derived from events but no new schema.
  - **Why**: keeps MCP surface stable and avoids parallel semantics.
  - **Risks**: Studio might want richer structure; mitigate via gap reason detail unions + evidence refs.

- **DT-004 — Lock `blocked` vs `gaps` as a deterministic view over one underlying `ReasonCode`**
  - **What**: Confirm the mapping rules: blocking modes emit `blocked.blockers[]`; never-stop emits `gap_recorded` and continues; both share the same underlying reason model.
  - **Why**: prevents divergence across modes.
  - **Risks**: none if we keep it strict.

- **DT-005 — Lock preference keys/values and Studio labels**
  - **What**: Finalize the closed set for `Preferences` (at least `autonomy`, `riskPolicy`) including allowed enum values and user-facing labels.
  - **Why**: Slice 4+ requires stable behavior; Studio needs consistent rendering.
  - **Risks**: scope creep; mitigate by minimal initial set + extension plan.

- **DT-006 — Lock “Mode presets” mapping to preferences (stable preset IDs)**
  - **What**: Define WorkRail-owned preset IDs (e.g., `wr.modes.guided`, `wr.modes.full_auto_never_stop`) mapping to preference snapshots.
  - **Why**: keeps UI simple without inventing arbitrary preference bags.
  - **Risks**: more surface area; keep preset set tiny and stable.

- **DT-007 — Lock preferred tip policy (deterministic)**
  - **What**: Define deterministic “preferred tip” selection for runs (e.g., choose most recently advanced by `EventIndex`, tie-break by lexicographic nodeId; exclude checkpoint-only tips unless configured).
  - **Why**: needed for `resume_session` and Studio default path; avoids “confusing soup.”
  - **Risks**: surprising defaults; mitigate with explicit “why this tip” trace entry.

- **DT-008 — Lock resume ranking/matching normalization**
  - **What**: Confirm the normalization pipeline (NFKC + lowercase + tokenization) and ranking tiers (observations first, then tip notes, then deep search).
  - **Why**: deterministic resume is core usability; ranking drift is a correctness risk.
  - **Risks**: ranking changes across versions; mitigate by versioned scoring policy (internal) + deterministic ties.

- **DT-009 — Lock `resume_session` “fully validated only” rule**
  - **What**: Enforce that `resume_session` only returns candidates from `SessionHealth=healthy` (no corrupt_tail tips).
  - **Why**: prevents salvage reads becoming correctness paths.
  - **Risks**: reduced usability in rare corruption cases; acceptable (integrity over convenience).

- **DT-010 — Lock export/import equivalence definition**
  - **What**: Define what must be equivalent after export/import: projections (run DAG, pending step, outputs, gaps, prefs) match byte-for-byte where applicable; tokens are re-minted.
  - **Why**: Slice 4+ needs a crisp Gate 4.
  - **Risks**: hard to enforce if we include unstable fields; mitigate by excluding timestamps and runtime-only data.

- **DT-011 — Add a determinism “diff tool” for debugging drift (internal)**
  - **What**: Tooling to diff two bundles/runs via JCS canonical bytes for events/manifests/snapshots.
  - **Why**: accelerates diagnosing drift during Slice 4+ and hardening.
  - **Risks**: scope; keep internal-only and test-oriented.

- **DT-012 — Lock `checkpoint_workflow` semantics and minimal requirements**
  - **What**: Confirm checkpoint node/edge creation, idempotency via `checkpointToken`, output-only durable writes, and attachment to a specific node (unless `start_session` is enabled later).
  - **Why**: checkpointing is the durable memory primitive for “between steps.”
  - **Risks**: users may want checkpoint-only sessions; keep as flagged later via `start_session`.

- **DT-013 — Decide which contract packs are “ship blockers” for Slice 4+**
  - **What**: Minimal set for shipping: `capability_observation`, `workflow_divergence`, `loop_control` (and whether “gaps” needs a contract pack at all).
  - **Why**: prevents getting stuck implementing a broad registry to ship core value.
  - **Risks**: underpowered authoring; acceptable initially.

- **DT-014 — Lock builtins catalog metadata schema (generated)**
  - **What**: Define the minimal metadata shape needed for Studio autocomplete/insert (IDs, kind, description, args schema, example snippet, provenance).
  - **Why**: discoverability is required, and generated registry prevents drift.
  - **Risks**: tying UI to engine schemas too tightly; mitigate via “generated from compiler definitions” as the contract.

- **DT-015 — Lock configurable feature whitelist + schemas**
  - **What**: Confirm the small whitelist (capabilities/output_contracts/mode_guidance) and their config schemas.
  - **Why**: avoids feature-id explosion and avoids config bags.
  - **Risks**: future features; extend via new closed-set IDs.

- **DT-016 — Confirm `promptBlocks` remains optional (and lock enforcement stance)**
  - **What**: Make “optional” explicit as a lock; Studio can encourage but not require.
  - **Why**: reduces authoring friction; avoids churn.
  - **Risks**: inconsistent prompt structure; mitigate with templates/features.

- **DT-017 — Clarify “decision trace” retention and privacy posture**
  - **What**: Lock what goes into `decision_trace_appended` (bounded, never required for correctness), default inclusion in bundles, and redaction posture (local-only).
  - **Why**: avoids trace becoming hidden correctness input.
  - **Risks**: bundle size/noise; keep bounded and optional.

- **DT-018 — Slice 4+ decomposition into 4a/4b/4c with gates**
  - **What**: Turn “Slice 4+” into sequenced sub-slices: (4a) blocked/gaps/prefs/contracts, (4b) export/import, (4c) resume/checkpoints.
  - **Why**: keeps PRs coherent and verifies invariants incrementally.
  - **Risks**: ordering dependencies; manage via explicit gates.

- **DT-019 — Add “ship checklist” section to canonical docs**
  - **What**: A short checklist for “v2 production-ready” referencing locks and quality gates (esp. Gate 4 portability).
  - **Why**: prevents “almost shipped” from lingering with hidden gaps.
  - **Risks**: doc sprawl; keep it small and point to locks.

- **DT-020 — Remove/relocate outdated Open Items sections once locked**
  - **What**: After locking, delete “Open items” blocks from the contract or reframe as “deferred enhancements” with explicit boundaries.
  - **Why**: keeps docs honest and reduces future confusion.
  - **Risks**: none.

## Emerging patterns (Round 1)
- Most ideas are about **collapsing semantics into one underlying reason model** (ReasonCode → blocked/gaps views).
- A lot of risk concentrates around **preferred tip + resume ranking determinism** (UX default correctness).
- “Generated registries” and closed sets are doing double duty: **drift prevention** and **discoverability**.
- Slice 4+ wants to be decomposed by **quality gates** (especially export/import equivalence).
- The consistent anti-pattern is “new surface area”: avoid new MCP tools or config bags.

## Idea Backlog (Round 2)

- **DT-021 — Aviation-style “pre-flight checklist” gate for Slice 4+ features**
  - **Analogy**: aviation checklists prevent rare catastrophic failures via explicit gates.
  - **What**: require a single “pre-flight validation” routine per sub-slice (e.g., export/import equivalence tests must pass before unflagging).
  - **How constraint changes solution**: shifts “confidence” from ad-hoc manual checks to a deterministic checklist encoded as tests.

- **DT-022 — Finance ledger framing for preferences + intents**
  - **Analogy**: account balances are projections over an append-only ledger.
  - **What**: model preferences and queued intents purely as append-only “transactions,” with effective state as a projection.
  - **Why**: avoids mutable preference documents and makes “pending → applied-at-node” natural.

- **DT-023 — Compiler pipeline framing for features/templates/contracts**
  - **Analogy**: compilation as deterministic passes producing a pinned IR.
  - **What**: treat each feature/template/contract expansion as an explicit pass with provenance artifacts for Studio, and lock a deterministic pass ordering.
  - **Why**: reduces “middleware magic” and makes compiled provenance explainable.

- **DT-024 — Logistics manifest framing for export bundles**
  - **Analogy**: shipping manifests enumerate contents and integrity checks.
  - **What**: make bundle integrity manifest first-class in UX (“what is inside / what failed”), with deterministic path naming and failure modes.
  - **Why**: turns “bundle integrity failed” from opaque to actionable.

- **DT-025 — Healthcare pathway framing for mode guidance**
  - **Analogy**: clinical decision support suggests safe pathways without hard-blocking.
  - **What**: represent “recommended max automation” as a structured “care pathway” recommendation with explicit risks, not a hard constraint.
  - **Why**: matches “warn + recommend, never hard-block.”

- **DT-026 — Game design framing: make drift visible via “badges” and “fail states”**
  - **Analogy**: games teach rules through immediate feedback and visible state.
  - **What**: in Studio, badge nodes for divergence/gaps/capability-degraded paths; surface “why blocked” as a single unblock panel.
  - **Why**: makes v2’s explainability primitives feel native and reduces confusion.

- **DT-027 — Inversion: assume “tool responses will be replayed out of context”**
  - **What**: enforce that every blocked response includes copy/pasteable next-input templates and stable pointers; never rely on transient prose.
  - **Why**: makes the system self-correcting under lossy agents.

- **DT-028 — Inversion: treat “doc updates” as production work, not follow-up**
  - **What**: define “doc reconciliation + removal of Open Items” as part of the acceptance criteria for each Slice 4+ sub-slice PR.
  - **Why**: prevents the design surface from silently drifting as code moves.

### Constraint inversion ideas (required)

- **DT-029 — Constraint: assume no state**
  - **What**: imagine a “stateless WorkRail” where the only durable thing is the chat; tokens would need to embed the entire snapshot.
  - **How constraint changes solution**: it highlights why v2 must treat durable store as truth (stateless is incompatible with rewind safety + resumable export/import without transcript).

- **DT-030 — Constraint: assume no JSON**
  - **What**: imagine the system uses a canonical binary format (e.g., deterministic protobuf) instead of JCS JSON.
  - **How constraint changes solution**: forces us to specify canonicalization and hashing at the “bytes” level, making drift harder but reducing human inspectability; reinforces why JCS was chosen for v2 ergonomics.

- **DT-031 — Constraint: assume only files**
  - **What**: imagine there is no notion of “in-memory projections”; everything is derived by reading files (events/manifests/snapshots) on demand.
  - **How constraint changes solution**: pushes us toward strict segmentation, bounded reads, and explicit pin lists (already aligned with the two-stream model).

- **DT-032 — Constraint: assume only events (no snapshots)**
  - **What**: imagine snapshots are forbidden; rehydrate must rebuild engine state by replaying domain events.
  - **How constraint changes solution**: would require the event log to carry much more execution detail (high drift risk) and make rehydrate expensive; validates why v2 separates durable lineage (events) from rehydration payloads (snapshots).

- **DT-033 — Constraint: assume “no branching UX”**
  - **What**: imagine Studio must always show a single line; branches are hidden unless explicitly expanded.
  - **How constraint changes solution**: forces a crisp preferred tip policy and strong “collapsed fork” affordances (aligns with “avoid confusing soup”).

- **DT-034 — Air-traffic-control framing for preferred tip**
  - **Analogy**: ATC has one “cleared” route at a time; others are holding patterns.
  - **What**: treat preferred tip as the “cleared route,” and require explicit user/agent action to switch active branch in Studio.
  - **Why**: reduces accidental context mixing when many forks exist.

- **DT-035 — Legal contract framing for output contracts**
  - **Analogy**: contracts specify required clauses; missing clauses block execution.
  - **What**: make contract packs small and precise, with explicit examples, and make enforcement rules deterministic by autonomy.
  - **Why**: reduces ambiguous expectations and improves self-correction.

## Interesting analogies (Round 2)
- Ledger/projection separation (finance) maps directly to preferences + intents as append-only events.
- Compilation passes (compiler IR) maps to deterministic feature/template expansion and provenance.
- Aviation/ATC maps to “quality gates” and preferred tip / fork discipline.

## Derived ideas (Round 3)

- **DT-036 — “One reason model” primitive: `ReasonCode` as the only semantic source**
  - **Derived from**: DT-004 + existing locks.
  - **What**: explicitly forbid any new “reason-ish” bags; everything maps to `ReasonCode` and then projects into blockers/gaps/warnings.

- **DT-037 — “Outcome replay contract test harness”**
  - **Derived from**: DT-010 + Slice 3 replay locks.
  - **What**: a reusable test harness that, given an `(ackToken)` replay key, asserts the response is fact-returning (no recompute) and byte-stable where applicable.

- **DT-038 — Preferred tip explainability via `decision_trace_appended.detected_non_tip_advance`**
  - **Derived from**: DT-007 + trace locks.
  - **What**: always append a tiny trace entry when non-tip advance occurs and when preferred tip selection changes, so Studio can explain “why this path.”

- **DT-039 — “Resume safety envelope” package**
  - **Derived from**: DT-009 + corruption gating locks.
  - **What**: bundle of rules: only healthy sessions, only tip nodes, deterministic truncation, and explicit “why recommended” in response.

- **DT-040 — “Preferences as transactions” + “queued intents” unification**
  - **Derived from**: DT-022 + resumption pack queued intents idea.
  - **What**: represent both as the same append-only “intent applied at node boundary” mechanism, with different intent kinds.

- **DT-041 — Minimal “ship blocker” contract pack set**
  - **Derived from**: DT-013.
  - **What**: formally define which packs must exist and be enforced for Slice 4+ shipping, and explicitly defer the rest.

- **DT-042 — Generated builtins registry: treat as compiler output**
  - **Derived from**: DT-014 + DT-023.
  - **What**: generate catalog metadata from the same canonical definitions the compiler uses; Studio consumes generated artifact, not hand-authored UI JSON.

- **DT-043 — Slice 4a/4b/4c gates encoded as tests**
  - **Derived from**: DT-018 + DT-021.
  - **What**: “gate tests” live in repo and are the definition of done (e.g., export/import equivalence suite is Gate 4).

- **DT-044 — “Docs as gates” — doc reconciliation required per gate**
  - **Derived from**: DT-028 + DT-020.
  - **What**: treat updating canonical docs (and removing Open items) as an explicit checklist item for each sub-slice.

- **DT-045 — Capability observation provenance: default to strong-only for enforcement**
  - **Derived from**: existing `capability_observed` lock.
  - **What**: ensure only strong provenance (`probe_step`/`attempted_use`) can unblock required capabilities; `manual_claim` is UI-only and never enforcement-grade.

- **DT-046 — Output contract enforcement “mode matrix”**
  - **Derived from**: DT-035.
  - **What**: a single table in docs + tests mapping autonomy → (block | gap+continue) for missing/invalid required output, ensuring drift can’t creep in.

- **DT-047 — “Bundle-first export UX” minimalism**
  - **Derived from**: DT-024.
  - **What**: prioritize resumable bundle correctness over rendered exports; rendered exports are pure projections later.

## Candidate concept packages (5)
- **Package A: Outcome Semantics Lockdown** | member DT-IDs: DT-036, DT-046, DT-037 | what it enables: stable blocked/gaps/warnings behavior and fact-returning replay guarantees.
- **Package B: Resume Correctness Envelope** | member DT-IDs: DT-007, DT-039, DT-038, DT-009 | what it enables: deterministic resume defaults with explainability and corruption safety.
- **Package C: Portability / Gate 4** | member DT-IDs: DT-010, DT-043, DT-047 | what it enables: export/import equivalence as a shippable correctness gate.
- **Package D: Discoverability Without Drift** | member DT-IDs: DT-042, DT-014, DT-015 | what it enables: Studio catalog/autocomplete powered by generated canonical metadata.
- **Package E: Intent Transactions (later, but coherent)** | member DT-IDs: DT-040, DT-022 | what it enables: queued intents + preferences unified as node-boundary events.

## Additional ideas (Round 4)

- **DT-048 — Versioning policy for closed sets (forward-compat contract)**
  - **What**: define how we evolve enums/schemas (add-only within schemaVersion; never repurpose values; migrations are explicit).
  - **Why**: prevents subtle drift during future expansion of reasons/prefs/capabilities.

- **DT-049 — Migration strategy: v1 → v2 tool surface messaging**
  - **What**: a minimal operator-facing migration note for v1 users (how to enable v2 tools, how to resume, what changes).
  - **Why**: reduces confusion; helps internal adoption.

- **DT-050 — Performance budget for `resume_session` (bounded deep search)**
  - **What**: hard caps and deterministic truncation rules for search (max sessions scanned, max bytes inspected, max results).
  - **Why**: prevents “brand new chat resume” from becoming slow/unpredictable.

- **DT-051 — Bundle redaction/sanitization posture (local-first, but explicit)**
  - **What**: clarify whether exports include full notes/artifacts by default and how a user can redact before sharing.
  - **Why**: confidentiality isn’t primary, but sharing is real; we should be explicit.

- **DT-052 — Retention + GC policy (snapshot CAS + session pins)**
  - **What**: define TTL behavior and safe GC constraints (especially under corruption gating / orphan segments).
  - **Why**: avoids unbounded disk growth and avoids deleting reachable snapshots.

- **DT-053 — Key rotation operational UX**
  - **What**: how to rotate token signing keys without breaking resumes; how to surface “token signed by previous” diagnostics.
  - **Why**: reduces “mysterious TOKEN_BAD_SIGNATURE” incidents.

- **DT-054 — Compatibility policy for workflow sources and collisions**
  - **What**: deterministic priority + “winner vs shadowed” rendering rules; ensure `wr.*` remains protected.
  - **Why**: avoids surprise behavior changes when sources change order.

- **DT-055 — Loop correctness stress tests**
  - **What**: property-like tests ensuring loop stack invariants, maxIterations enforcement, and fail-safe stop behavior in never-stop.
  - **Why**: loops are a drift magnet; tests must prove determinism.

- **DT-056 — “Do not expand MCP surface” guard test**
  - **What**: a test asserting the exact allowed MCP tools (core + flagged) to prevent projection-tool creep.
  - **Why**: enforces a major v2 stance via CI.

- **DT-057 — End-to-end “no transcript needed” smoke tests**
  - **What**: tests that simulate: start → advance → “forget pending” → rehydrate-only → continue; and a fork-from-non-tip scenario.
  - **Why**: directly targets the MCP constraints that motivated v2.

## Coverage map
- **Protocol correctness** | high | DT-036, DT-037, DT-046, DT-057
- **Resumption UX** | high | DT-007, DT-039, DT-008, DT-050
- **Authoring UX / discoverability** | med | DT-042, DT-014, DT-016
- **Validation / closed sets** | high | DT-002, DT-005, DT-048
- **Dashboard/observability** | med | DT-026, DT-038, DT-017
- **Model variability / lossy agents** | high | DT-027, DT-057
- **External packaging (export/import)** | high | DT-010, DT-047, DT-052
- **Loops correctness** | med | DT-055, DT-041
- **Capability negotiation** | med | DT-045, DT-013
- **Security/policy** | low | DT-051 (needs more exploration)
- **Performance** | med | DT-050
- **Migration/compatibility** | med | DT-049, DT-054

## Clusters
## Clusters (8)

### C1 — Outcome semantics: blockers + gaps + replay correctness
- **Member ideas**: DT-003, DT-004, DT-036, DT-037, DT-046, DT-057
- **What it is**: Make `ReasonCode` the only semantic source; `blocked` and `gap_recorded` become deterministic projections by autonomy; replay remains fact-returning.
- **Why it matters**: Slice 4+ will otherwise “invent” semantics across modes and drift.
- **Dependencies**: none (builds on existing locks).
- **Primary risks**: accidentally creating a second reason bag (tool-level or UI-only) that becomes correctness-critical.

### C2 — Preferences/modes as closed sets + node-boundary application
- **Member ideas**: DT-005, DT-006, DT-022, DT-040, DT-048
- **What it is**: Lock preference keys/values + mode presets; treat changes as append-only transactions applied at node boundaries; future “queued intents” can reuse the same pattern.
- **Why it matters**: preferences influence control flow; must be rewind-safe and portable.
- **Dependencies**: C1 (reason model influences blocked vs gaps).
- **Primary risks**: scope creep into “policy bags” or too many knobs.

### C3 — Preferred tip + resume correctness envelope
- **Member ideas**: DT-007, DT-008, DT-009, DT-038, DT-039, DT-050
- **What it is**: Deterministic preferred tip policy + deterministic resume ranking and normalization; “healthy-only” rule; bounded search budgets; explainability traces.
- **Why it matters**: resume is the usability escape hatch for brand new chats, and “confusing soup” is the biggest UX failure mode.
- **Dependencies**: C1 (branch/fork semantics), C2 (prefs may influence default views).
- **Primary risks**: surprising default tip selection; performance blowups in deep search.

### C4 — Portability: export/import equivalence (Gate 4)
- **Member ideas**: DT-010, DT-043, DT-047, DT-052, DT-051
- **What it is**: Define equivalence and enforce with tests; ensure token re-minting correctness; add retention/GC constraints; clarify export redaction posture.
- **Why it matters**: portability is a core v2 promise; without Gate 4 equivalence, “resumable sharing” is brittle.
- **Dependencies**: C1 (durable outcomes), C2 (prefs are durable truth), C3 (resume uses durable truth).
- **Primary risks**: including unstable fields in equivalence; accidental merges on import; GC deleting reachable refs.

### C5 — Discoverability without drift (builtins + generated registry)
- **Member ideas**: DT-014, DT-015, DT-042, DT-016
- **What it is**: Generated metadata registry from compiler definitions; Studio consumes generated artifact; keep promptBlocks optional but encouraged by templates.
- **Why it matters**: builtins won’t be used if not discoverable; drift returns if UI metadata is hand-maintained.
- **Dependencies**: none (but easier after core is stable).
- **Primary risks**: overbuilding Studio before Slice 4+ correctness is proven.

### C6 — Operational hardening: keys, corruption, performance
- **Member ideas**: DT-053, DT-050, DT-052, DT-056
- **What it is**: key rotation UX; resume performance budgets; retention/GC; “no MCP surface creep” guard test.
- **Why it matters**: prevents slow/fragile behavior and preserves the v2 “minimal surface” stance.
- **Dependencies**: C4 (export/import and retention), C3 (resume).
- **Primary risks**: shipping without guardrails and later adding hacks.

### C7 — Migration + compatibility posture
- **Member ideas**: DT-049, DT-054
- **What it is**: v1→v2 messaging; workflow source collision rules; protect `wr.*` namespace.
- **Why it matters**: reduces adoption friction and avoids surprising behavior drift due to sources.
- **Dependencies**: none.
- **Primary risks**: changing behavior without surfaced warnings.

### C8 — Loops correctness & stress tests
- **Member ideas**: DT-055, DT-041
- **What it is**: loop invariants and fail-safe behavior; determine which contract packs are shipping blockers.
- **Why it matters**: loops are high-risk for drift and infinite execution; tests must prove determinism and safety.
- **Dependencies**: C1 (reason model), C2 (mode matrix).
- **Primary risks**: too much authoring friction; mitigate with templates/contracts.

## Decision Log (append-only)
- (empty)

## Candidate directions (top 6)

### D1 — “Outcome Semantics Lockdown” (C1 + C2) as Slice 4a
- **North Star**: Make Slice 4+ semantics impossible to drift by locking the closed sets (reasons, prefs, modes) and enforcing the mode matrix with tests.
- **Summary**: Highest leverage: unblock all subsequent Slice 4+ work; reduces long-tail correctness risk. Moderate migration cost (doc + schema updates).
- **Scoring (1–5)**:
  - **Impact**: 5 — defines correctness and UX explainability.
  - **Confidence**: 4 — most primitives already exist in locks; needs reconciliation and final enums.
  - **Migration cost**: 3 — doc updates + schema tightening; limited code churn.
  - **Model-robustness**: 5 — reduces reliance on agent prose; deterministic errors-as-data.
  - **Time-to-value**: 4 — can ship quickly once Slice 3 lands.

### D2 — “Portability Gate 4 First” (C4) as Slice 4b
- **North Star**: Make export/import resumable and equivalence-tested so v2 can be safely shared and resumed across machines.
- **Summary**: Core promise; high confidence if we keep equivalence strictly defined. Slightly higher complexity (integrity, pin lists, snapshots).
- **Scoring (1–5)**:
  - **Impact**: 5
  - **Confidence**: 3 — easy to accidentally include unstable fields; needs careful spec/test discipline.
  - **Migration cost**: 3
  - **Model-robustness**: 5
  - **Time-to-value**: 3 — more moving parts than D1.

### D3 — “Resume Envelope” (C3) as Slice 4c
- **North Star**: Make `resume_session` deterministic, safe, bounded, and explainable, with preferred tip policy locked.
- **Summary**: Major usability win; must be deterministic and healthy-only. Requires chosen tip policy and search budgets.
- **Scoring (1–5)**:
  - **Impact**: 4
  - **Confidence**: 3 — policy choices affect UX; needs clear tie-breakers.
  - **Migration cost**: 2
  - **Model-robustness**: 4
  - **Time-to-value**: 4

### D4 — “Checkpointing as Durable Memory” (part of 4c)
- **North Star**: Make `checkpoint_workflow` the default tool for preserving progress between steps and across rewinds.
- **Summary**: Opt-in, low surface, high value. Depends on token orchestration being stable.
- **Scoring (1–5)**:
  - **Impact**: 4
  - **Confidence**: 4
  - **Migration cost**: 2
  - **Model-robustness**: 4
  - **Time-to-value**: 4

### D5 — “Discoverability Without Drift” (C5) (defer until core locked)
- **North Star**: Generated builtins catalog drives Studio authoring without docs drift.
- **Summary**: Important, but should not block correctness slices unless authoring is bottlenecking Slice 4+.
- **Scoring (1–5)**:
  - **Impact**: 3
  - **Confidence**: 4
  - **Migration cost**: 3
  - **Model-robustness**: 3
  - **Time-to-value**: 2

### D6 — “Operational hardening bundle” (C6) (parallelizable)
- **North Star**: Make the system boring in production: guard tests, budgets, retention, key-rotation clarity.
- **Summary**: Doesn’t need to block features, but should land before unflagging v2 broadly.
- **Scoring (1–5)**:
  - **Impact**: 4
  - **Confidence**: 4
  - **Migration cost**: 3
  - **Model-robustness**: 4
  - **Time-to-value**: 3

## Shortlist (3)
- **S1: D1 (Outcome Semantics Lockdown → Slice 4a)**: lock remaining closed sets + mode matrix + doc reconciliation.
- **S2: D2 (Portability Gate 4 → Slice 4b)**: export/import equivalence + integrity + token re-minting.
- **S3: D3+D4 (Resume + Checkpoints → Slice 4c)**: preferred tip + resume ranking + checkpoint_workflow.

## Reflection prompts (brief)
- **What would falsify the top direction?** If we discover most “open items” are already fully defined in code/tests, then D1 should be reframed as “docs reconciliation + proof suite,” not “new locks.”
- **Most dangerous second-order effect**: creating parallel semantics (tool-level gaps vs event gaps; UI-only reason codes) that quietly become correctness inputs.

## Adversarial challenge (brief)
- **Why S1 might be wrong**: we could ship export/import and resume first (D2/D3) with minimal semantics, and only lock closed sets once real usage reveals the right taxonomy.
- **Strongest alternative**: D2-first. If portability is the core differentiator, proving Gate 4 earlier could accelerate adoption and surface missing semantic locks naturally.

## Decision Gate
- Confirm we should proceed with **Shortlist S1→S2→S3** and treat it as **Slice 4a/4b/4c** ordering.

## Synthesis Quality Gate
- POV statement is present ✅
- 3–7 HMW questions are present ✅
- Success criteria are present (measurable where possible) ✅
- Key tensions/tradeoffs are present ✅
- Idea Backlog has meaningful breadth (covers protocol/resumption/authoring/observability/reliability/tooling/packaging at least once each, if applicable) ✅
- Shortlist (2–3) exists with risks and migration cost noted ✅
- The top direction has at least one falsifiable learning question ✅

## Pre-mortem & Falsification

## Pre-mortem (top 5)
- **Failure mode**: We “lock” semantics in docs, but code implements something subtly different (drift). | **Why it happens**: multiple canonical docs + code move faster than docs; missing equivalence tests. | **Mitigation**: treat doc updates as acceptance criteria per sub-slice; add a small “no MCP surface creep” tool-list test; add Gate 4 equivalence tests.
- **Failure mode**: We accidentally introduce a second reason model (UI-only codes or tool-level gaps) that becomes correctness-critical. | **Why it happens**: convenience shortcuts (e.g., bespoke `gaps[]` in responses) and ad-hoc strings. | **Mitigation**: enforce “ReasonCode is the only semantic source” and map deterministically to blockers/gaps; forbid new reason bags by schema/tests.
- **Failure mode**: Preferred tip / resume ranking feels arbitrary or unstable across minor changes, causing “confusing soup.” | **Why it happens**: implicit tie-breakers, time-based ordering, unbounded deep search. | **Mitigation**: define deterministic tie-breakers by stable IDs/EventIndex; byte-budgeted truncation; hard performance caps; include “why recommended” explanation trace.
- **Failure mode**: Export/import is “technically correct” but not equivalent in practice (projections differ; tokens can’t be re-minted cleanly). | **Why it happens**: missing pinned workflow snapshots or snapshot pins; unstable fields; integrity rules too loose. | **Mitigation**: lock equivalence definition; make import validate ordering + integrity strictly; enforce token re-mint from stored snapshots only; add export/import roundtrip tests as Gate 4.
- **Failure mode**: Scope creep: we start building Studio features or broad UX before correctness is proven, slowing shipping and increasing surface area. | **Why it happens**: discoverability and ergonomics are genuinely needed, but can preempt correctness work. | **Mitigation**: keep Slice 4+ scoped to correctness primitives + minimal operator visibility; treat catalog generation as “later” unless authoring blocks shipping.

## Falsification criteria (1–3)
- **FC1 (Docs vs reality)**: If, during reconciliation, we find that the “open items” are already fully locked and implemented in code/tests, then the “lock-in” direction is wrong; we should pivot to a **docs reconciliation + proof suite** direction (no new enums/policies invented).
- **FC2 (Semantics drift)**: If we cannot implement Slice 4a without introducing a second reason model (beyond `ReasonCode` + deterministic projections), then the approach is failing; we must revisit the reason model and/or projection boundaries.
- **FC3 (Portability)**: If export/import roundtrip cannot produce projection-equivalent state without adding non-deterministic fields or recomputation, then our equivalence definition or snapshot/event partitioning is flawed; we must narrow equivalence or adjust what is stored durably.

## Proceed to Prototype (confirmation gate)
- Proceed with **S1 → S2 → S3** as **Slice 4a/4b/4c**, and treat the prototype artifact as an **API sketch + doc edit plan** that locks: reasons/prefs/modes, preferred tip policy, export/import equivalence, resume ranking budgets, and checkpoint semantics.

## Prototype Spec
### Learning question
- Can we lock the remaining v2 “open items” into **closed sets + deterministic policies** without expanding the MCP surface, and can we plan Slice 4a/4b/4c so implementation is unambiguous and drift-resistant?

### Prototype artifact: API sketch (request/response + closed sets)
This is an **API-and-model sketch**, not a commitment to new MCP tools. The goal is to make the remaining semantics explicit and testable.

#### A) Closed sets to lock (normative targets)

##### A1) Preferences
- **`PreferenceKey` (closed set)**:
  - `autonomy`
  - `riskPolicy`

- **`Autonomy` (closed set)**:
  - `guided`
  - `full_auto_stop_on_user_deps`
  - `full_auto_never_stop`

- **`RiskPolicy` (closed set)**:
  - `conservative`
  - `balanced`
  - `aggressive`

- **Mode presets (display-facing, WorkRail-owned IDs)**:
  - `wr.modes.guided` → `{ autonomy: guided, riskPolicy: conservative }`
  - `wr.modes.full_auto_stop_on_user_deps` → `{ autonomy: full_auto_stop_on_user_deps, riskPolicy: balanced }`
  - `wr.modes.full_auto_never_stop` → `{ autonomy: full_auto_never_stop, riskPolicy: conservative }`

Notes:
- Workflows may recommend presets, but **do not invent keys**.
- Preference changes remain **node-boundary applied** (pending → applied-at-node).

##### A2) Reason model (single source)
- **`ReasonCode` remains the single semantic source**.
- `blocked.blockers[].code` remains the **derived view** (`ReasonCode` → `Blocker.code`) per existing mapping locks.
- `gap_recorded.reason` remains the **durable disclosure view** (append-only), also derived from `ReasonCode`.

##### A3) User-only dependency reasons
Lock the **already-locked** user-only dependency reasons (as in `v2-core-design-locks.md`) under `ReasonCode.user_only_dependency:*`.

**`UserOnlyDependencyReason` (initial closed set, locked)**:
- `needs_user_secret_or_token`
- `needs_user_account_access`
- `needs_user_artifact`
- `needs_user_choice`
- `needs_user_approval`
- `needs_user_environment_action`

Special rule (locked):
- `needs_user_choice` is only emitted when the workflow explicitly marks the choice as **non-assumable** via `NonAssumableChoiceKind`.

**`NonAssumableChoiceKind` (closed set, locked)**:
- `preference_tradeoff`
- `scope_boundary`
- `irreversible_action`
- `external_side_effect`
- `policy_or_compliance`

Mapping:
- `ReasonCode.user_only_dependency:<reason>` → `Blocker.code = USER_ONLY_DEPENDENCY`
- In `full_auto_stop_on_user_deps`: return `blocked` for these.
- In `full_auto_never_stop`: record `gap_recorded(severity=critical, category=user_only_dependency, detail=<reason>)` and continue.

##### A4) Preferred tip policy (run-local, deterministic)
Goal: pick a single default path without hiding forks.

Preferred tip selection (per run, locked direction):
1) identify leaf nodes (no children)
2) compute each leaf’s **last-activity** as max `EventIndex` among events that touch the node’s reachable history (node/output/gap/capability/prefs/divergence/edge)
3) choose highest last-activity
4) tie-breakers: `node_created` index, then lexical `NodeId`

Explainability:
- Whenever a non-tip advance occurs, append `decision_trace_appended.kind=detected_non_tip_advance`.
- Whenever preferred tip selection changes materially, record a bounded trace entry (optional) so Studio can say “why this tip.”

##### A5) Resume ranking/matching (deterministic + bounded)
Normalization + token match (locked):
- Normalize query and candidate text by:
  1) Unicode normalization: **NFKC**
  2) lowercase (locale-independent)
  3) extract tokens matching regex: `[a-z0-9_-]+`
- “Matches notes” iff **all query tokens** are in the candidate token set (set membership; not substring).

Ranking (locked: strict tiers, no probabilistic scoring):
1) exact match on `git_head_sha` observation
2) exact or prefix match on `git_branch` observation
3) token match on latest preferred-tip recap notes (`outputChannel=recap`, `payloadKind=notes`)
4) token match on workflow id/name
5) fallback to recency only

Within-tier ordering (locked):
1) run preferred-tip `lastActivityEventIndex` desc
2) `sessionId` lex

Response budget (locked):
- max candidates: 5
- max snippet bytes per candidate: 1024 (UTF-8, with canonical truncation marker)

Safety (locked intent):
- Only return candidates from `SessionHealth=healthy`.

#### B) Slice 4a/4b/4c plan (execution plan)

##### Slice 4a — Outcome semantics lockdown (reasons + prefs/modes + contracts + docs)
**Deliverables**
- Lock/implement the closed sets above in code-canonical schemas (no string bags):
  - `Preferences` keys/values + preset IDs
  - `UserOnlyDependencyReason`
  - “mode matrix” mapping autonomy → blocked vs gap+continue for each `ReasonCode` category
- Reconcile and update canonical docs:
  - remove/replace `workflow-execution-contract.md` “Open items” that are now locked
  - ensure `v2-core-design-locks.md` is the single source for enums and policies; contract references it

**Acceptance gates**
- A single table exists in docs and tests: **autonomy × (missing/invalid output, required cap missing, user-only dependency)** → `blocked` or `gap_recorded`.
- No new “reason-ish” bags exist in tool responses beyond the existing `blocked.blockers[]` schema.

##### Slice 4b — Export/import equivalence (Gate 4)
**Deliverables**
- Export bundle includes: events, manifest, snapshots, pinnedWorkflows, integrity entries (JCS sha256).
- Import validates: integrity, ordering, required pins; default import-as-new.
- Token re-minting from stored snapshots (no portability of runtime tokens).

**Acceptance gates**
- Export→Import roundtrip produces projection-equivalent state for:
  - run DAG shape and preferred tip
  - pending step / isComplete
  - node outputs (including supersedes linkage)
  - preferences effective snapshots
  - gaps and blockers outcomes

##### Slice 4c — Resume + checkpoints
**Deliverables**
- `resume_session` (flagged): layered search + deterministic ranking + healthy-only.
- `checkpoint_workflow` (flagged): idempotent via `checkpointToken`, creates checkpoint node+edge, appends output.
- Preferred tip policy implemented and used by resume + Studio default views.

**Acceptance gates**
- Deterministic ranking tests (stable ordering) and bounded behavior tests (budget enforcement).
- Non-tip resume behavior produces an auto-fork outcome with bounded downstream recap (per contract).

#### C) Doc edit plan (before/after)
**Primary canonical docs to update**
- `docs/reference/workflow-execution-contract.md`
  - remove/close the “Open items” section by either:
    - converting items into locked references to `v2-core-design-locks.md`, or
    - explicitly reclassifying leftovers as “deferred enhancements” with non-blocking scope.
- `docs/design/v2-core-design-locks.md`
  - add/confirm: `UserOnlyDependencyReason`, `Preferences` enums, preferred tip policy, resume ranking budgets.

**Secondary docs to align**
- `docs/plans/workrail-v2-one-pager.md` (ensure Slice 4+ bullets match the updated plan)
- `docs/design/studio.md` (only where it references now-locked semantics, especially gaps/prefs/pending→applied)

## Test Plan
### Test strategy
- **Primary goal**: prove Slice 4+ semantics are deterministic, rewind-safe, and portable **without transcript**.
- **Mechanism**: tests assert **facts** (events/snapshots/manifests) and **projection equivalence**, not implementation details.

### Agents/models/IDEs to test
- **Claude** (strong model; baseline dogfood)
- **One weaker model** (e.g., GPT/Grok/Gemini) to ensure the contract is self-correcting under variability

### Core test suites (by slice)

#### Slice 4a (semantics lockdown)
- **Closed-set schema tests**:
  - `UserOnlyDependencyReason` is exhaustive (no “other”).
  - `Preferences` keys/values are exhaustive; preset IDs map to valid snapshots.
- **Mode matrix tests**:
  - For each autonomy mode, each `ReasonCode` category maps deterministically to:
    - `blocked` with `BlockerReport` (blocking modes), or
    - `gap_recorded` + continue (never-stop)
  - `BlockerReport` ordering and byte budgets are enforced.
- **No parallel semantics tests**:
  - Tool responses do not introduce new “gaps[]” or “reason bags” beyond the locked shapes.

#### Slice 4b (export/import Gate 4)
- **Integrity tests**:
  - bundle JCS digest verification fails fast on tamper.
  - import rejects missing snapshots or missing pinned workflows.
- **Roundtrip equivalence tests**:
  - export → import results in equivalent projections (excluding runtime-only tokens and timestamps):
    - run DAG shape + preferred tip
    - pending step + isComplete
    - outputs (append-only + supersedes linkage)
    - preferences effective snapshots
    - gaps and recorded outcomes

#### Slice 4c (resume + checkpoint)
- **Resume ranking determinism tests**:
  - normalization is stable; ranking ties break deterministically.
  - budget enforcement (caps on sessions/bytes/results) is strict.
  - healthy-only candidates (no corrupt_tail).
- **Fork / non-tip behavior tests**:
  - resuming from non-tip auto-forks and returns bounded downstream recap (deterministic truncation markers).
- **Checkpoint idempotency tests**:
  - replaying the same `(stateToken, checkpointToken)` does not create duplicates.

### End-to-end “no transcript needed” scenarios (must pass)
- Start → advance → “forget pending prompt” → rehydrate-only → advance continues correctly.
- Rewind: reuse an older `stateToken` and advance → creates a branch; preferred tip policy remains deterministic.

## Iteration Notes
### Iteration 1: Adversarial / drift audit (doc-vs-lock consistency)
- **Test performed**: compared the Phase 5 “API sketch” against `docs/design/v2-core-design-locks.md` (preferred tip, gaps/user-only deps, prefs/modes).
- **Finding**: several items were already locked in `v2-core-design-locks.md` with more specific enums/policies:
  - `UserOnlyDependencyReason` + `NonAssumableChoiceKind`
  - preferred tip policy “last-activity” definition
  - mode preset for `full_auto_never_stop` uses `riskPolicy=conservative`
- **Action taken**: updated Prototype Spec sections A1/A3/A4 to match the locked definitions (removed conflicting proposals).
- **Outcome**: prototype artifact is now aligned with the canonical lock doc, reducing drift risk before Slice 4a.

### Iteration 2: Resume ranking drift audit (budgets + tiering)
- **Test performed**: compared Prototype Spec resume ranking (A5) against `v2-core-design-locks.md` Section 2.3.
- **Finding**: the lock doc already specifies a deterministic tiered algorithm and stricter budgets:
  - strict tiers (no probabilistic scoring)
  - max candidates 5; max snippet bytes 1024
  - within-tier ordering by `lastActivityEventIndex` desc, then `sessionId` lex
- **Action taken**: updated Prototype Spec A5 to match the locked resume ranking and budgets.
- **Outcome**: Slice 4c plan can implement resume without inventing new ranking semantics.

## Counters (DT IDs)
- Next DT ID: **DT-058**
