# Design: WorkRail Evidence Gate MVP

> **Artifact strategy:** This document is for human reading and design review.
> It is NOT execution truth. Session notes and context variables are the durable
> record. This doc may not survive a chat rewind; the WorkRail session notes will.

## Context / Ask

WorkRail currently gates `continue_workflow` token issuance on agent-provided notes and
structured output. This is *trust-based*: if an agent claims it ran `npm test` and tests
passed, WorkRail cannot contradict that claim.

The ask is to make enforcement *evidence-based*: a workflow step declares what real tool
calls must have occurred (with what arguments, and what exit code), and WorkRail refuses
to issue the continue token until those observations are on record.

**Reference sources read:**
- `src/mcp/handlers/v2-execution/continue-advance.ts` -- the advance intent handler
- `src/mcp/handlers/v2-execution/advance.ts` -- thin orchestrator delegating to
  `executeAdvanceCore` in `v2-advance-core.ts`
- `spec/workflow.schema.json` -- full step schema; today no `requiredEvidence` field exists
- `src/mcp/output-schemas.ts` -- blocker codes, `V2BlockerSchema`, `V2BlockerReportSchema`
- `src/types/hooks.ts` (Claude Code repo) -- `PreToolUse` / `PostToolUse` hook model; the
  `hookSpecificOutput.hookEventName` discriminant union shows that `PostToolUse` hooks can
  return `additionalContext` but cannot currently inject structured evidence into an
  external store
- `src/utils/hooks/hookEvents.ts` (Claude Code repo) -- `HookResponseEvent` carries
  `exitCode` and `stdout`/`stderr`; emitted to registered `HookEventHandler`
- `packages/agent/src/types.ts` (pi-mono) -- `BeforeToolCallResult`, `AfterToolCallResult`,
  `BeforeToolCallContext`; the `afterToolCall` hook receives `result`, `isError`, and the
  full tool `args`

---

## Path Recommendation

**`full_spectrum`** -- the risk is not just a bad implementation but framing the wrong
concept. Two legitimate design framings exist:

1. *Push model*: Claude Code's `PostToolUse` hook fires a side-channel call into WorkRail
   MCP with evidence; WorkRail stores it; `continue_workflow` checks it.
2. *Pull model*: The agent itself calls a new WorkRail MCP tool (`record_evidence`) after
   each qualifying tool use; `continue_workflow` checks the evidence log before advancing.

Both framings are valid for an MVP. The push model is more autonomous and harder to spoof;
the pull model is simpler to implement and does not require changes to Claude Code. The
right choice depends on the threat model (see Candidate Directions).

---

## Constraints / Anti-goals

**Constraints:**
- Must not break existing `continue_workflow` behavior for steps without `requiredEvidence`
- Must be durable (evidence survives chat rewind, just like session event log)
- Must fit within the existing blocker code system (`V2BlockerSchema`)
- Evidence matching should be declarative in the workflow YAML, not code

**Anti-goals:**
- Do not build a full replay-based audit log (overkill for MVP)
- Do not require changes to the agent's LLM model behavior (only hook/tool instrumentation)
- Do not attempt to cryptographically sign tool outputs (out of scope for MVP)

---

## Landscape Packet

### How the advance gate works today

`handleAdvanceIntent` (continue-advance.ts) calls `advanceAndRecord`, which calls
`executeAdvanceCore` (src/mcp/handlers/v2-advance-core/index.ts). The gate flow is:

1. `derivePendingStepForMode` -- derive the step being advanced from snapshot
2. `validateAdvanceInputs` -- validate context, notes, step metadata
3. `ValidationEngine.validate` -- run validation criteria if present
4. `detectBlockingReasonsV1` -- build `ReasonV1[]` from output requirement, notes, assessment, capabilities
5. `applyGuardrails` -- apply risk policy; post-guardrail reasons are canonical
6. `buildBlockedOutcome` / `buildSuccessOutcome` -- emit events and snapshot

All reasons come from `ReasonV1` (reason-model.ts). The `detectBlockingReasonsV1` function
takes `outputRequirement`, `capabilityRequirement`, `missingNotes`, `assessmentFollowupRequired`.
A new evidence check fits as a new parameter here.

### The `ReasonV1` discriminated union today

Current reason kinds (reason-model.ts):
- `missing_context_key`, `context_budget_exceeded`
- `missing_required_output`, `invalid_required_output`
- `assessment_followup_required`, `missing_notes`
- `required_capability_unknown`, `required_capability_unavailable`
- `user_only_dependency`, `invariant_violation`, `storage_corruption_detected`, `evaluation_error`

A new `evidence_not_satisfied` reason variant is additive and maps to a new blocker code
`EVIDENCE_NOT_SATISFIED`.

### The `EVENT_KIND` constant object today

The closed set lives in `src/v2/durable-core/constants.ts`:
```
SESSION_CREATED, OBSERVATION_RECORDED, RUN_STARTED, NODE_CREATED, EDGE_CREATED,
ADVANCE_RECORDED, VALIDATION_PERFORMED, NODE_OUTPUT_APPENDED, ASSESSMENT_RECORDED,
ASSESSMENT_CONSEQUENCE_APPLIED, PREFERENCES_CHANGED, CAPABILITY_OBSERVED, GAP_RECORDED,
CONTEXT_SET, DIVERGENCE_RECORDED, DECISION_TRACE_APPENDED
```
The comment states: "Adding a new event kind requires updating the DomainEventV1Schema union."
New kind: `EVIDENCE_RECORDED: 'evidence_recorded'`.

### Where a new gate check would live

The exact insertion point is `executeAdvanceCore` (index.ts, step 4), alongside the call to
`detectBlockingReasonsV1`. A new parameter `evidenceRequirement` is added there:
```
case 'not_satisfied': reasons.push({ kind: 'evidence_not_satisfied', requirementIndex: 0 });
```
No other files in the advance pipeline need changes -- only: reason-model.ts, blocking-decision.ts,
output-schemas.ts (blocker code enum), constants.ts (EVENT_KIND), and the new event schema.

### Delegation probe result

Both parallel subagent attempts failed (exit 143 / not connected). Delegation is unavailable
in this session. All landscape work was done solo. This is noted as an evidence gap but does
not block the design -- the source files provide sufficient grounding.

### Claude Code hook model

Claude Code fires `PreToolUse` and `PostToolUse` hooks as subprocess calls or callbacks.
The `PostToolUse` hook receives:
- `hookEventName: "PostToolUse"`
- tool name, tool input, tool output, exit code (for Bash)
- `additionalContext` as a return channel

The `HookResponseEvent` type (hookEvents.ts) already carries `exitCode`. This is the
observation surface we need.

### pi-mono hook model

pi-mono's `afterToolCall` hook receives `BeforeToolCallContext` (containing `toolCall.name`
and validated `args`) and `result` (content + details + isError). This is equivalent and
could be used for non-Claude Code agent runtimes.

---

## Problem Frame Packet

### Users and stakeholders

| Who | What they need |
|-----|---------------|
| Workflow author | Declare that a step cannot complete unless specific tool calls were observed |
| Agent runner | Know that a failed test run will block advancement, not be hidden behind polished notes |
| WorkRail platform | A structural hook into the agent's tool call stream -- not trust in the agent's self-reporting |
| Claude Code user | Minimal configuration friction; the hook should be easy to install |

### Jobs and outcomes

The primary job: *make workflow enforcement real, not advisory*. Today WorkRail is a
structured todo list with quality gates. The evidence gate makes it a *verifiable execution
journal* -- the gap between those two is WorkRail's strongest differentiator.

Secondary job: *give workflow authors a vocabulary for "done"* that goes beyond notes.
A step is done when the work happened, not when the agent says it happened.

### Core pains and tensions

1. **Trust vs verification tension:** Notes are fast to produce, easy to fake (even unintentionally).
   Evidence collection is slower (requires hook plumbing) but structurally sound.

2. **Push model viability tension:** The push model is the right design but requires Claude Code
   hook configuration the user must set up. A mandatory dependency on user config is a friction
   multiplier that will suppress adoption.

3. **Pull model trust gap:** If the agent calls `record_evidence` itself, it can still skip the
   test run and call the tool anyway. The threat model matters: inattentive agents are common;
   actively deceptive agents are rare.

4. **Schema stability tension:** Adding `requiredEvidence` to `standardStep` is additive, but
   the evidence gate is only enforced when the capability is present. Without the hook, the
   field is silently ignored -- or it should emit a warning.

5. **Pattern matching fragility:** Substring match on `args.command` is fast to implement but
   misses edge cases (`npm run test`, `npx jest`, etc.). Regex is more powerful but harder to
   author.

### Constraints that matter in lived use

- Workflow authors will write YAML, not TypeScript. The `requiredEvidence` syntax must be
  readable and obvious.
- The evidence gate must not break existing workflows. Steps without `requiredEvidence` must
  behave identically.
- The continue token is the enforcement mechanism -- it must not be issuable until evidence
  is on record. No bypass, no "soft gate" mode.
- Evidence must be durable (survive chat rewind). The session event log satisfies this.

### Success criteria

1. A workflow step declaring `requiredEvidence` blocks advancement when evidence is absent
   and the capability is present.
2. The agent receives a clear blocker message: "Required evidence not satisfied: npm test
   with exit code 0 was not observed for this step."
3. After the hook fires and records evidence, the next `continue_workflow` call advances.
4. Steps without `requiredEvidence` behave identically to today.
5. A working example workflow step is fully specced and would pass schema validation.

### Assumptions to validate

- Assumption: Claude Code's `PostToolUse` hook receives `exitCode` reliably. *Evidence:*
  `HookResponseEvent.exitCode` is defined in hookEvents.ts. Validated.
- Assumption: The hook subprocess can call an MCP tool back to WorkRail. *Evidence:*
  Not confirmed from source. Hook subprocesses run as shell commands; calling an MCP server
  requires the MCP CLI or a direct HTTP endpoint. This is a real uncertainty.
- Assumption: `record_evidence` can be called with a continue token to scope evidence to
  a node. *Evidence:* Continue tokens encode `sessionId + nodeId + attemptId`. Plausible.

### HMW questions

1. **HMW make evidence collection zero-config for most users?** -- Pre-install the hook via
   `npx workrail init` or ship a Claude Code settings snippet in the WorkRail docs. The hook
   is a one-time setup, not per-workflow config.

2. **HMW handle the case where a hook is not installed?** -- When a step declares
   `requiredEvidence` but the `evidence_collection` capability has not been observed,
   emit `REQUIRED_CAPABILITY_UNAVAILABLE` with a `suggestedFix` pointing to hook setup docs.
   Do not silently ignore the declaration.

3. **HMW make `requiredEvidence` useful even without a hook?** -- The pull model (agent
   calls `record_evidence` explicitly) is weaker but still adds value: it forces the agent
   to *actively assert* it ran the tool, creating a distinct signal in the session log. This
   is stronger than notes (which are prose) because it's a structured, typed assertion.

### Framing risks

1. **Over-engineering risk:** Building a full audit log with cryptographic signing before
   validating that the basic pattern (record_evidence + gate check) is used in practice.
   MVP should be minimal.
2. **Under-scoping risk:** Building only the pull model and calling it "evidence collection"
   when users will rightly ask "but can't the agent just skip the call?" The push hook path
   must be documented as the intended upgrade even if it ships later.
3. **Wrong abstraction risk:** Tying `requiredEvidence` to tool names and patterns may not
   generalize well (e.g., what if the test is run in a Docker container?). The right
   abstraction might be "evidence tags" that the agent asserts and the hook confirms -- but
   that's post-MVP complexity.

---

## Candidate Generation Expectations

The candidate set must:
1. **Not cluster around the obvious pull/push binary.** Four directions should cover meaningfully different positions on the trust vs enforcement spectrum.
2. **Include at least one reframe** -- not just "pull model" or "push model" but a direction that challenges the premise that evidence collection requires a new mechanism at all.
3. **Ground each direction in the actual code landscape** -- each candidate should name the specific files and patterns it builds on, not float as abstract design.
4. **Be honest about the pull model trust gap** -- at least one direction should name this as a first-class property, not bury it.

## Candidate Directions

### Candidate A -- Typed assertion gate (pull model, honest naming)

**One-sentence summary:** Add `requiredEvidence` to `standardStep` schema; expose a `record_evidence` MCP tool the agent calls after qualifying Bash invocations; gate `continue_workflow` on `evidence_recorded` events in the session log scoped to the current `nodeId`.

**Tensions resolved/accepted:**
- Resolves: Schema stability (additive change); the blocker message is specific and actionable.
- Accepts: Observation vs assertion (this is an assertion gate, not an observation gate). Named honestly in docs and blocker messages.

**Boundary solved at:** `detectBlockingReasonsV1` in `blocking-decision.ts` (new `evidenceRequirement?: EvidenceRequirementStatus` parameter); `record_evidence` handler following the port-injection, `ResultAsync` pattern.

**Specific failure mode:** Agent skips test run, calls `record_evidence(token, "Bash", "npm test", 0)` directly. Evidence is recorded; gate passes; tests never ran. This is the pull model's inherent weakness.

**Relation to repo patterns:** Follows exactly. `CAPABILITY_OBSERVED` + `required_capability_unavailable` reason is the structural precedent. New event kind `EVIDENCE_RECORDED`, new reason `evidence_not_satisfied`, new blocker code `EVIDENCE_NOT_SATISFIED`. All three follow the naming convention and closed-set pattern.

**What you gain:** Shippable in 1 week. Zero Claude Code dependency. Full schema and event model compatibility with the push model (Candidate B). The gap is honest.

**What you give up:** Structural enforcement. A motivated or broken agent defeats the gate trivially.

**Impact surface:** 8 files: `spec/workflow.schema.json`, `constants.ts`, `reason-model.ts`, `blocking-decision.ts`, `output-schemas.ts`, `v2-advance-core/index.ts` (pass new param), new handler `record-evidence.ts`, `v2/tools.ts` (register tool). Plus `DomainEventV1Schema` union update (locked).

**Scope judgment:** Best-fit. Minimal surface, consistent with existing patterns, clear seams for upgrade.

**Philosophy:** Honors `errors are data`, `exhaustiveness everywhere`, `validate at boundaries`, `YAGNI`. Conflicts with `make illegal states unrepresentable` (the pull model allows a legally-formed but semantically-void assertion).

---

### Candidate B -- Structural observation gate (push model, zero-agent-trust)

**One-sentence summary:** Ship a `workrail` CLI tool that Claude Code's `PostToolUse` hook subprocess calls after every Bash invocation; the CLI writes an `evidence_recorded` event to the session log; the agent never controls whether this fires.

**Tensions resolved/accepted:**
- Resolves: Observation vs assertion (this IS an observation gate -- the agent cannot forge evidence without running the tool). Makes illegal states unrepresentable.
- Accepts: Push model viability tension -- requires Claude Code `PostToolUse` hook config in `.claude/settings.json`. Sessions without the hook configured cannot satisfy `requiredEvidence` steps.

**Boundary solved at:** Same as Candidate A for the gate side. Additional boundary: a `workrail record-evidence` CLI command that reads the continue token from `$WORKRAIL_CONTINUE_TOKEN` env var and posts to the WorkRail MCP server's HTTP endpoint (or via `npx workrail mcp record-evidence`).

**Specific failure mode:** Hook not configured. Workflow declares `requiredEvidence` but `evidence_collection` capability has never been observed (no `CAPABILITY_OBSERVED` event for `evidence_collection`). Gate emits `REQUIRED_CAPABILITY_UNAVAILABLE` blocker with setup guide. User reads guide, installs hook, reruns. Second failure mode: CLI cannot reach MCP server (running in CI without MCP). Need a fallback.

**Relation to repo patterns:** The gate side follows repo patterns exactly (same as Candidate A). The CLI tool is new territory -- WorkRail does not currently ship a standalone CLI. This is a genuine architectural addition.

**What you gain:** Real enforcement. The agent cannot advance without evidence, and evidence cannot be fabricated without running the tool.

**What you give up:** Shipping speed (2-3 weeks more). Requires a standalone CLI or HTTP endpoint. New deployment surface.

**Impact surface:** Everything in Candidate A, plus: new CLI package or HTTP endpoint, hook setup documentation, `evidence_collection` capability probe mechanism.

**Scope judgment:** Too broad for MVP given the CLI requirement. Best-fit for v1.1.

**Philosophy:** Fully honors `make illegal states unrepresentable`. The structural enforcement matches the stated design philosophy. Conflicts with `YAGNI` (the push model requires infra that may not be needed if most users are satisfied with the assertion gate).

---

### Candidate C -- Reframe: evidence tags declared on both sides

**One-sentence summary:** Instead of matching tool names and command patterns, workflow steps declare named evidence tags (`requires: [test-suite-passed]`), and the agent (or hook) records these tags explicitly; matching is by tag name, not by tool call pattern.

**Tensions resolved/accepted:**
- Resolves: Pattern matching fragility (no more `npm test` substring matching; the tag `test-suite-passed` matches whether the agent ran `npm test`, `npx jest`, or a Docker-wrapped test runner).
- Accepts: Still pull-based in MVP. The agent tags assertions; the hook tags observations. Same trust gap as Candidate A, but more flexible.

**Boundary solved at:** Schema: `requiredEvidence: [{ tag: "test-suite-passed" }]`. New MCP tool: `record_evidence_tag(token, tag, passed: boolean)`. Gate: scan for `evidence_tag_recorded` events matching tag name scoped to nodeId.

**Specific failure mode:** Tag inflation (workflow authors create meaningless tags like `done` or `finished`). Tags without semantic commitment defeat the purpose. Requires workflow authoring conventions.

**Relation to repo patterns:** Departs from repo patterns. The existing capability model uses a closed 2-value enum (`delegation`, `web_browsing`). Evidence tags are an open vocabulary -- no closed set. This contradicts the `exhaustiveness everywhere` principle.

**What you gain:** Generalization. Works for any tool, any test runner, any environment. The agent and the hook use the same vocabulary.

**What you give up:** Type safety on evidence tag names. The tag vocabulary is an open string, making exhaustive handling impossible. Also increases authoring complexity: workflow authors must invent and document tag names.

**Scope judgment:** Too broad for MVP. The open vocabulary problem is a real architectural tension that needs a separate design decision. The simpler substring-match approach in Candidates A/B is safer.

**Philosophy:** Conflicts with `exhaustiveness everywhere` (open tag vocabulary), `prefer explicit domain types over primitives` (tags are strings). Honors `architectural fixes over patches` (generalizes the pattern matching problem rather than patching it).

---

### Candidate D -- Strengthen existing notes enforcement (no new mechanism)

**One-sentence summary:** Add a structured `requiredClaims` array to `standardStep`; each claim is a prose assertion the agent must include in notes; the existing LLM-based `ValidationEngine` checks whether the notes contain each claim before advancing.

**Tensions resolved/accepted:**
- Resolves: Schema stability (additive), scope (zero new event kinds, zero new MCP tools), YAGNI (no new infrastructure).
- Accepts: Observation vs assertion -- this is purely trust-based. Does NOT address the stated goal of evidence collection.

**Boundary solved at:** `spec/workflow.schema.json` (new `requiredClaims` field), `ValidatedAdvanceInputs` (new field), `ValidationEngine` (new claim-check logic).

**Specific failure mode:** Same as today -- agent writes "tests passed" without running tests. This candidate does not solve the problem; it reframes what the problem is (notes quality vs evidence collection).

**Relation to repo patterns:** Follows existing `validationCriteria` pattern very closely. The `ValidationEngine` already validates notes against criteria; `requiredClaims` is a specialized form of that.

**What you gain:** Zero infrastructure. Ships today. Improves notes quality for well-intentioned agents.

**What you give up:** Structural enforcement. This is advisory, not mandatory. Does not address the user request.

**Scope judgment:** Too narrow. It does not solve the stated problem and should be labeled honestly.

**Philosophy:** Honors `YAGNI`. Conflicts with `architectural fixes over patches` (this is a patch that defers the root problem).

---

## Challenge Notes

1. **The pull model is not meaningfully more secure than notes.** If the goal is
   *structural* enforcement, only the push hook model (B or C) achieves it. The discovery
   doc should be honest about this.

2. **The hook model requires host cooperation.** An agent running without the hook
   configured can never satisfy evidence requirements. WorkRail needs a capability probe
   mechanism (similar to the existing capability blockers for `delegation` and
   `web_browsing`) to detect whether evidence collection is available.

3. **The `requiredEvidence` schema addition is small and clean.** It fits naturally in the
   existing `standardStep` schema alongside `validationCriteria` and `outputContract`. No
   architectural change to the step model is needed.

4. **The advance gate insertion point is clear.** `executeAdvanceCore` (v2-advance-core.ts)
   is where all other blockers are computed. Adding an evidence scan there is 20-30 lines
   of new code plus a new event kind.

5. **Durability is free.** The existing session event log already stores arbitrary domain
   events. `evidence_recorded` is a new event kind appended to the same log; it survives
   chat rewind because the event log is append-only and durable.

---

## Resolution Notes

**Recommended MVP scope:**

1. **Schema:** Add `requiredEvidence` to `standardStep` in `workflow.schema.json`
2. **Event kind:** Add `evidence_recorded` to the session event log constants
3. **MCP tool:** Add `record_evidence(continueToken, toolName, matchedPattern, exitCode)`
   -- usable both by pull (agent) and push (hook subprocess) callers
4. **Gate check:** In `executeAdvanceCore`, before appending `advance_recorded`, scan for
   `evidence_recorded` events matching all declared `requiredEvidence` entries; emit
   `EVIDENCE_NOT_SATISFIED` blocker if any are missing
5. **Capability probe:** Add `evidence_collection` to the capability enum; when a step
   declares `requiredEvidence` but the capability is absent, emit a
   `REQUIRED_CAPABILITY_UNAVAILABLE` blocker with a setup guide

**Working example workflow step:**
```yaml
- id: run-tests
  title: Run test suite
  prompt: |
    Run `npm test` and fix any failures before advancing. WorkRail will not
    issue a continue token until it observes a passing test run.
  requiredEvidence:
    - tool: Bash
      pattern: "npm test"
      exitCode: 0
```

**Evidence satisfied when:** The session event log contains at least one `evidence_recorded`
event for the current `nodeId` where `toolName == "Bash"`, `args.command` includes
`"npm test"`, and `exitCode == 0`.

---

## Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Push hook is the real differentiator | Pull model is marginally better than notes; structural enforcement requires host-side observation |
| 2 | MVP uses pull model + hook instructions | Avoids hard dependency on Claude Code hook config for initial release; hook model documented as upgrade path |
| 3 | Evidence store = session event log | No new storage layer needed; durability and dedup are inherited |
| 4 | Gate check goes in executeAdvanceCore | All other blockers live there; consistent with existing architecture |
| 5 | New blocker code EVIDENCE_NOT_SATISFIED | Fits the existing discriminated union; agents already handle blocked responses |
| 6 | evidence_recorded event includes source: "agent" or "hook" field | Identified by adversarial challenge: B-path upgrade needs to distinguish agent-recorded vs hook-recorded evidence. Adding source from MVP makes the upgrade additive. |
| 7 | Candidate A selected (typed assertion gate) | Follows CAPABILITY_OBSERVED precedent exactly; shippable in 1 week; schema compatible with B-path upgrade. Challenge pressure confirmed the enforcement theater risk is manageable via honest naming and documentation. |
| 8 | Candidate B is the runner-up | Right design, wrong scope for MVP. Switch condition: evidence that the pull model actively damages user trust OR that the target user base already has PostToolUse hooks configured. |

---

## Final Summary

### Recommendation: Candidate A -- Typed Assertion Gate

**Confidence: High**

Add a `requiredEvidence` field to `standardStep`, a `record_evidence` MCP tool that the
agent calls explicitly, and a gate check in `detectBlockingReasonsV1` that refuses to
advance until `evidence_recorded` events are present for the current `nodeId`.

**What this is:** An assertion gate. The agent asserts it ran the tool. WorkRail enforces
the assertion is present, not that the tool actually ran. Named honestly in all docs and
blocker messages.

**What this is not:** An observation gate. The push hook model (Candidate B) is the
observation gate. It is the right long-term design and is the planned v1.1 upgrade.

### MVP spec -- concrete and complete

**Schema addition (`standardStep`):**
```yaml
requiredEvidence:           # optional array; omit for no gate
  - tool: Bash              # tool name as it appears in Claude Code
    pattern: "npm test"     # substring match on args.command
    exitCode: 0             # optional; omit to accept any exit code
    patternType: substring  # "substring" (MVP) | "regex" (post-MVP)
evidenceMode: all           # "all" (default) | "any"
```

**New MCP tool: `record_evidence`**
```typescript
Input: {
  continueToken: string;    // or evToken: string (ev_ prefix, narrow-scope, post-MVP)
  toolName: string;         // "Bash"
  commandPattern: string;   // the command that matched
  exitCode: number;         // 0 = success
}
Returns: ResultAsync<void, RecordEvidenceError>
```

**New event kind: `EVIDENCE_RECORDED`**
```typescript
{
  kind: 'evidence_recorded',
  sessionId: string,
  nodeId: string,           // scoped to the current pending step
  toolName: string,
  commandPattern: string,
  exitCode: number,
  source: 'agent' | 'hook', // 'agent' for pull model, 'hook' for push model (B-path)
  attemptId: string,
}
```

**New reason variant: `evidence_not_satisfied`**
```typescript
{ kind: 'evidence_not_satisfied', requirementIndex: number, toolName: string, pattern: string }
```

**Blocker message template:**
"Required evidence not satisfied: Bash with pattern 'npm test' and exit code 0 was not
recorded for this step. Note: this is an assertion gate -- install the evidence_collection
hook for structural enforcement."

**Gate check insertion point:** `detectBlockingReasonsV1` in `blocking-decision.ts`,
as a new `evidenceRequirement?: EvidenceRequirementStatus` parameter. Consistent with
the existing `capabilityRequirement` parameter pattern.

**Working example workflow step:**
```yaml
- id: run-tests
  title: Run test suite and verify passing
  prompt: |
    Run `npm test`. Fix any failures before advancing.
    WorkRail will not issue a continue token until it has recorded a passing
    test run for this step. Call `record_evidence` after the test run completes.
  requiredEvidence:
    - tool: Bash
      pattern: "npm test"
      exitCode: 0
```

### Strongest alternative

Candidate B (push hook). Switch condition: evidence that the pull model actively damages
user trust in production, or that the target user base already has `PostToolUse` hooks
configured. The B-path upgrade is zero-schema-change given the `source` field is present
from MVP.

### Residual risks

1. **Enforcement theater (medium):** Pull model is assertion-based. Mitigated by honest
   naming and blocker messages. Risk compounds if B-path never ships.
2. **ev_ token security surface (medium-high for B-path):** Hook subprocesses should not
   receive the continue token (advance authority). An `ev_` narrow-scope token must be
   defined before B-path implementation.
3. **B-path timeline unresolved (low for MVP):** Product decision, outside design scope.

**Design doc path:** `design-evidence-gate-mvp.md`
