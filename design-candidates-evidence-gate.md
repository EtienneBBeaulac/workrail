# Design Candidates: WorkRail Evidence Gate MVP

> Raw investigative material for main-agent synthesis. Not a final decision.

## Problem Understanding

### Core tensions

1. **Observation vs assertion** -- The desired property is "tool call was executed." The pull
   model delivers "agent asserted tool call was executed." Only the push hook model bridges this.

2. **Schema stability vs new capability** -- Adding `requiredEvidence` to `standardStep` is
   additive but requires updating the `DomainEventV1Schema` locked union and every
   exhaustive switch on `ReasonV1`. The codebase is deliberately brittle-to-extension
   (by design -- exhaustiveness guards catch all call sites).

3. **New tool vs extend continue_workflow** -- Evidence can be recorded multiple times
   during a step (each test run); `continue_workflow` is called once. A separate
   `record_evidence` tool is semantically correct.

4. **Node scoping** -- Evidence must be scoped to a `nodeId`, not just a session.
   The continue token encodes `sessionId + nodeId + runId` and is the natural scoping key.

### Likely seam

`detectBlockingReasonsV1` in `blocking-decision.ts`. All blocking reasons unify here.
New `evidenceRequirement?: EvidenceRequirementStatus` parameter, producing
`evidence_not_satisfied` reasons. Gate check before `advance_recorded` event is appended.

### What makes this hard

Not the code -- the product honesty problem. The pull model ships enforcement theater.
Naming matters: "assertion gate" vs "observation gate" is the difference between honest
and misleading documentation.

---

## Philosophy Constraints

From `CLAUDE.md` and confirmed in repo patterns:

- **Errors are data** -- `record_evidence` must return `ResultAsync`, not throw
- **Exhaustiveness everywhere** -- `ReasonV1` is a discriminated union; adding a variant
  forces all call sites to update (enforced by `_exhaustive: never` guards)
- **Make illegal states unrepresentable** -- pull model violates this (agent can assert
  without running); push model honors it
- **Validate at boundaries, trust inside** -- `record_evidence` validates token at entry
- **Closed sets with lock comments** -- `EVENT_KIND` and `DomainEventV1Schema` must be
  updated together; the lock comment enforces this
- **YAGNI** -- push model is the right design but requires infra not yet needed

---

## Impact Surface

Files needing changes (any candidate that adds evidence gate):
1. `spec/workflow.schema.json` -- add `requiredEvidence` to `standardStep`
2. `src/v2/durable-core/constants.ts` -- add `EVIDENCE_RECORDED` to `EVENT_KIND`
3. `src/v2/durable-core/schemas/session/index.ts` -- add `evidence_recorded` to `DomainEventV1Schema` (locked)
4. `src/v2/durable-core/domain/reason-model.ts` -- add `evidence_not_satisfied` to `ReasonV1`; add `EVIDENCE_NOT_SATISFIED` to `BlockerCodeV1`
5. `src/v2/durable-core/domain/blocking-decision.ts` -- add `evidenceRequirement` parameter
6. `src/mcp/handlers/v2-advance-core/input-validation.ts` -- validate requiredEvidence from step def
7. `src/mcp/handlers/v2-advance-core/index.ts` -- pass evidenceRequirement to detectBlockingReasonsV1
8. `src/mcp/output-schemas.ts` -- add `EVIDENCE_NOT_SATISFIED` to `V2BlockerSchema` code enum
9. New: `src/mcp/handlers/record-evidence.ts` -- MCP tool handler
10. `src/mcp/v2/tools.ts` -- register the new tool

Exhaustive-switch call sites on `ReasonV1` (will be caught at compile time):
- `buildBlockerReport` in `reason-model.ts`
- Any `switch (reason.kind)` in the advance pipeline

---

## Candidates

### Candidate A -- Typed assertion gate (pull model, honest naming)

**Summary:** `record_evidence(continueToken, toolName, commandPattern, exitCode)` MCP tool.
Agent calls it after qualifying Bash invocations. Gate scans for `evidence_recorded` events
scoped to current `nodeId` before issuing continue token.

**Tensions resolved:**
- Schema stability -- additive
- Node scoping -- resolved via continue token binding
- Actionable blocker message -- resolved

**Tensions accepted:**
- Observation vs assertion -- this is an assertion gate. Named honestly.

**Boundary:** `detectBlockingReasonsV1` + new `record_evidence` handler.

**Why this boundary:** Same as `capabilityRequirement` parameter -- optional input to the
blocking reason pipeline. No architectural change to advance core.

**Failure mode:** Agent calls `record_evidence("npm test", 0)` without running tests.
Gate passes. Tests never ran.

**Repo-pattern relationship:** Follows exactly. `CAPABILITY_OBSERVED` + `required_capability_unavailable` is the structural precedent.

**Gains:** Shippable in ~1 week. Zero external dependencies. Full compatibility with
Candidate B upgrade.

**Losses:** Structural enforcement. Motivated or inattentive agent defeats the gate.

**Scope:** Best-fit.

**Philosophy:** Honors `errors are data`, `exhaustiveness`, `validate at boundaries`, `YAGNI`.
Mild conflict with `make illegal states unrepresentable`.

---

### Candidate B -- Structural observation gate (push model)

**Summary:** `workrail record-evidence` CLI tool called by Claude Code `PostToolUse` hook
subprocess. CLI reads continue token from `$WORKRAIL_CONTINUE_TOKEN` env var, posts
`evidence_recorded` event. Agent never controls whether this fires.

**Tensions resolved:**
- Observation vs assertion -- genuine observation gate. Agent cannot forge evidence.
- Make illegal states unrepresentable -- honored.

**Tensions accepted:**
- Push model viability -- requires `.claude/settings.json` hook config. Sessions without
  hook cannot satisfy `requiredEvidence` steps (emits `REQUIRED_CAPABILITY_UNAVAILABLE`).

**Boundary:** Same as A for gate. Additional boundary: standalone CLI package + HTTP endpoint
or MCP server endpoint that accepts CLI calls.

**Why this boundary:** The hook subprocess runs as a shell command; it cannot natively
call an MCP tool. It needs an HTTP endpoint or CLI wrapper.

**Failure mode:** Hook not configured. `REQUIRED_CAPABILITY_UNAVAILABLE` blocker with
setup guide. Also: CLI cannot reach MCP server in CI without MCP running.

**Repo-pattern relationship:** Gate side follows repo patterns. CLI is new territory --
WorkRail does not currently ship a standalone CLI.

**Gains:** Real enforcement. Structural. Matches stated design goal.

**Losses:** Shipping speed (2-3 weeks). New CLI deployment surface. Hook config friction.

**Scope:** Too broad for MVP. Best-fit for v1.1.

**Philosophy:** Fully honors `make illegal states unrepresentable`. Conflicts with `YAGNI`
(CLI infra may not be needed if pull model satisfies most users).

---

### Candidate C -- Evidence tags (reframe)

**Summary:** Steps declare `requires: [{tag: "test-suite-passed"}]`. Agent/hook records
`record_evidence_tag(token, "test-suite-passed", passed: true)`. Matching by tag name,
not tool name + command pattern.

**Tensions resolved:**
- Pattern matching fragility -- no more `npm test` substring matching. Works for any test
  runner.

**Tensions accepted:**
- Open vocabulary conflicts with `exhaustiveness everywhere`. Tag names are strings --
  cannot be exhaustively handled.
- Still pull-based in MVP.

**Boundary:** Same gate location. Different event schema (`evidence_tag_recorded`).

**Failure mode:** Tag inflation (`done`, `finished`). Meaningless tags defeat the semantics.

**Repo-pattern relationship:** Departs from repo patterns. Existing capability model uses
a closed enum; open tag vocabulary is a new architectural choice.

**Gains:** Generalization. Works for Docker, custom test runners, etc.

**Losses:** Type safety on tag names. Open vocabulary. Authoring complexity.

**Scope:** Too broad for MVP.

**Philosophy:** Conflicts with `exhaustiveness everywhere`, `prefer explicit domain types
over primitives`. Honors `architectural fixes over patches`.

---

### Candidate D -- Strengthen notes enforcement (no new mechanism)

**Summary:** Add `requiredClaims: string[]` to `standardStep`. `ValidationEngine` checks
notes contain each claim string before advancing.

**Tensions resolved:**
- Schema stability -- purely additive, no new event kinds.
- Zero infrastructure.

**Tensions accepted:**
- Observation vs assertion -- purely trust-based. Does not solve the stated problem.

**Boundary:** `spec/workflow.schema.json` (new field), `ValidatedAdvanceInputs`,
`ValidationEngine` (new claim-check logic).

**Failure mode:** Agent writes "tests passed" without running tests. Identical to today.

**Repo-pattern relationship:** Follows `validationCriteria` pattern very closely.

**Gains:** Ships today. Zero new infrastructure.

**Losses:** Does not solve the problem. Advisory, not enforcement.

**Scope:** Too narrow.

**Philosophy:** Honors `YAGNI`. Conflicts with `architectural fixes over patches`.

---

## Comparison and Recommendation

### Recommendation: Candidate A with explicit B-path seam

**Rationale:**
- A follows existing repo patterns exactly (10 files, clear precedent).
- A is shippable without new infrastructure.
- A's schema and event model are identical to B -- upgrading is zero-schema-change.
- A is honest about what it provides (documented in blocker messages).
- D is too narrow. C adds open-vocabulary complexity. B is right but premature.

**The B-path seam:** When `evidence_collection` capability is observed (hook fires),
WorkRail upgrades to trusting only hook-recorded evidence for steps with `requiredEvidence`.
Agent-recorded evidence gets a warning: "Hook detected -- only hook-recorded evidence
accepted for this step." Zero schema changes required for this upgrade.

### Self-Critique

**Strongest counter-argument:** A ships enforcement theater. Users who trust the feature
name will be surprised when broken agents pass gates. The feature could damage trust in
WorkRail's enforcement model.

**Narrower option:** D (notes strengthening). Loses because it cannot produce a typed
`EVIDENCE_NOT_SATISFIED` blocker and does not create the evidence store infrastructure
needed for the B upgrade.

**Broader option:** B (push hook). Justified if users already have Claude Code hook
infrastructure configured. Evidence needed: survey of WorkRail users' `.claude/settings.json`.

**Invalidating assumption:** If the B-path capability upgrade cannot be implemented without
a breaking change to the session schema, A loses its upgrade path advantage.

---

## Open Questions for the Main Agent

1. Is the pull model's trust gap acceptable given that the primary threat model is
   *inattentive* agents (not actively deceptive ones)?
2. Should the `record_evidence` tool be a new MCP tool or an additional intent on
   `continue_workflow`? (Current recommendation: separate tool.)
3. Should `requiredEvidence` without the `evidence_collection` capability silently pass,
   warn, or block? (Current recommendation: block with `REQUIRED_CAPABILITY_UNAVAILABLE`.)
4. What is the matching semantics for `exitCode: 0` when the field is omitted -- accept
   any exit code, or require 0? (Current recommendation: omit = accept any exit code.)
5. When multiple `requiredEvidence` entries are declared, is it AND or OR semantics?
   (Recommendation: AND -- all must be satisfied.)
