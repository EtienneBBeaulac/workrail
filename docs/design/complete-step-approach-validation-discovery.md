# Discovery: Validate complete_step Approach vs Alternatives

**Date:** 2026-04-18
**Status:** In Progress
**Branch:** feat/daemon-complete-step-tool (PR #569)

---

## Context / Ask

PR #569 implements `complete_step`: a new daemon tool that hides the `continueToken` from the LLM using a late-binding closure getter `() => currentContinueToken`. The LLM calls `complete_step({ notes, artifacts, context })` and the daemon injects the token internally.

**Original stated goal:** Is the `complete_step` tool implementation in PR #569 the best approach, or is there a superior alternative?

**Reframed problem:** The daemon agent loop needs to advance workflow state reliably without requiring the LLM to reproduce an opaque HMAC-signed token it received in a prior turn.

---

## Path Recommendation

**design_first** -- the goal is a solution statement and the structured output prototype has already proven a materially different alternative (Option A in `structured-output-tools-coexist-findings.md`). This discovery needs to compare the two approaches against first principles before concluding PR #569 is correct.

Justification:
- `landscape_first` would be redundant: the landscape is already documented in backlog.md and the structured output findings doc.
- `full_spectrum` adds reframing work that's already been done (challenge step completed above).
- `design_first` focuses on the core tension: is `complete_step` the right design, or is structured output better?

---

## Constraints / Anti-goals

- Do NOT break the MCP tool API surface for users calling `continue_workflow` from non-daemon contexts
- Do NOT require beta API if it introduces unacceptable stability risk
- Do NOT assume the structured output path is better just because it's newer
- MUST work on both Anthropic direct and Amazon Bedrock (confirmed in findings doc)

---

## Artifact Strategy

This document is for human readers (PR reviewers, future maintainers). It is NOT the execution truth for this workflow -- all decisions and findings are captured in WorkRail step notes and context variables. If a rewind occurs, the notes and context survive; this file may not.

**Canonical truth lives in:** WorkRail session notes (concatenated across steps).
**This file is:** A readable summary for review and reference.

---

## Landscape Packet

### Sources Read
- `src/daemon/workflow-runner.ts` -- `makeCompleteStepTool()`, `runWorkflow()`, `onAdvance`, `onTokenUpdate`
- `src/daemon/agent-loop.ts` -- sequential tool execution (`toolExecution: 'sequential'`), `_executeTools()`, event loop
- `src/v2/durable-core/tokens/short-token.ts` -- token format, length validation, HMAC verification
- `docs/design/structured-output-tools-coexist-findings.md` -- confirmed: beta API `output_config + tools` coexist on both providers
- `docs/ideas/backlog.md` -- first-principles design alternatives (Apr 18, 2026 entry)
- `docs/design/daemon-complete-step-tool-design-review.md` -- prior design review for PR #569

### Current State
`continue_workflow` requires the LLM to round-trip a 27-char HMAC-signed `continueToken`. The token is small by design (v2 short tokens replaced 162-char v1 tokens specifically because agents mangled them). But even 27-char tokens get corrupted -- wrong characters, truncation, or mangling during context handling causes TOKEN_BAD_SIGNATURE or SHORT_TOKEN_INVALID_LENGTH errors that kill sessions.

### Token Format
- 27 chars total: `ct_` prefix + 24 base64url chars (18 payload bytes: 12 nonce + 6 HMAC-SHA256)
- SHORT_TOKEN_BAD_SIGNATURE = HMAC mismatch (token valid format but wrong key or mangled HMAC bytes)
- SHORT_TOKEN_INVALID_LENGTH = decoded bytes != 18 (token truncated or characters appended)
- Both errors kill the session immediately -- no recovery without a checkpoint token

### Main Existing Approaches
1. **complete_step tool (PR #569):** LLM calls tool with notes; daemon injects token from closure variable. Token absent from LLM context entirely.
2. **Structured output (findings doc):** `client.beta.messages.create()` + `output_config.format` = JSON schema enforced at `end_turn`. Daemon parses JSON, no tool call needed. Token absent from LLM context entirely.
3. **Legacy continue_workflow:** LLM round-trips token. Still supported for non-daemon contexts (MCP tool users). Deprecated in daemon sessions.

### Hard Constraints
- `AgentLoop._executeTools()` runs tools **sequentially** -- no concurrent step execution possible within a session
- `runWorkflow()` creates one `currentContinueToken` closure variable per session -- no cross-session contamination
- `onAdvance` and the `onTokenUpdate` callback are the only two write paths to `currentContinueToken` -- they are in mutually exclusive response branches (`kind: 'ok'` vs `kind: 'blocked'`)
- Token update (via `persistTokens()`) happens BEFORE `onAdvance`/`onTokenUpdate` -- crash safety invariant

### Obvious Contradictions
- `daemon-complete-step-tool-design-review.md` recommends PR #569 as correct and ready to merge
- `structured-output-tools-coexist-findings.md` recommends REMOVING `complete_step` and replacing with `output_config`
- These are not actually contradictory -- they have different timelines. PR #569 solves the immediate problem; structured output is the longer-term architecture. The question is whether to solve both at once or in sequence.

### Evidence Gaps
- No production telemetry on TOKEN_BAD_SIGNATURE error frequency in the field
- No data on LLM tool-hallucination rate for `complete_step` vs `continue_workflow` in practice
- Beta API stability: `output_config` is in beta -- no SLA on when it becomes stable
- `AgentClientInterface` would need updating for beta API (currently typed to `messages.create()` not `beta.messages.create()`)

---

## Problem Frame Packet

**Core tension:** Two valid approaches exist.

**Approach A: complete_step tool (PR #569)**
- LLM calls `complete_step({ notes, artifacts, context })`
- Daemon injects `continueToken` via closure getter `() => currentContinueToken`
- Token is never in LLM context
- Works with current `client.messages.create()` (stable API)
- Risk: LLM still calls a tool; tool hallucination is a failure mode

**Approach B: Structured output (end_turn JSON)**
- LLM ends turn with `{"step_complete": true, "notes": "..."}` 
- Daemon detects `stop_reason: end_turn`, parses JSON, injects token, calls `continue_workflow`
- Token never passed through LLM at all (not even a tool call)
- Requires `client.beta.messages.create()` with `output_config`
- Risk: beta API instability; requires `AgentClientInterface` update

---

## Candidate Directions

### Generation Expectations (design_first + THOROUGH)
- Must include at least one direction that meaningfully reframes the problem, not just packages the obvious options
- Must cover: merge PR #569 as-is, skip to structured output now, hybrid (merge PR #569 as a bridge), and at least one reframe
- Must NOT all cluster around "close to the current plan" -- one direction must represent a genuinely different architecture
- For THOROUGH: if the first spread feels clustered or too safe, push for one more direction

### Candidate Set

**Direction 1: Merge PR #569 as-is (complete_step tool, interim)**
- Complete_step is the right solution NOW, before structured output is stable enough
- Resolves FM1-FM5 immediately; token never in context; notes validated at boundary
- Migration path: structured output replaces it later (separate PR)
- Risks: two-PR cost; complete_step is transitional complexity that gets removed

**Direction 2: Skip PR #569, ship structured output directly**
- Replace complete_step with beta API output_config + end_turn JSON parsing
- Token never touches LLM at all (not even a tool call)
- Requires: AgentClientInterface update, agent-loop.ts update
- Risks: beta API stability; more complex change than PR #569; takes longer

**Direction 3: Merge PR #569 now, migrate to structured output in same milestone**
- Ship PR #569 immediately to fix the production problem
- In the same sprint, ship a follow-up PR that adds structured output support
- Complete_step becomes a compatibility shim or is removed after structured output PR merges
- Risks: coordination overhead; two PRs in quick succession

**Direction 1: Merge PR #569 as-is (simplest correct change)**
- `makeCompleteStepTool()` with `() => string` closure getter; first in tools array; `continue_workflow` deprecated
- `currentContinueToken` is a `let` in `runWorkflow()` closure, updated by `onAdvance` + inline `onTokenUpdate` callback
- Resolves: token never in context, notes validated at boundary, FM4 risk minimized (no token in initial prompt)
- Accepts: migration cost to structured output, mutable closure variable, LLM tool hallucination possible
- Follows existing factory function pattern exactly (`makeBashTool`, `makeReadTool`)
- **Scope: best-fit**

**Direction 2: Skip PR #569, ship structured output directly**
- Remove `complete_step` as a tool; update `AgentClientInterface` to `beta.messages.create()`; add `output_config.format` JSON schema to `AgentLoopOptions`; parse `stop_reason: end_turn` JSON in `_runLoop`; call `executeContinueWorkflow` from workflow-runner.ts `turn_end` path
- Resolves: no closure variable needed, LLM literally cannot touch token, architecturally cleanest
- Accepts: beta API stability risk, larger scope, `AgentClientInterface` change propagates to all consumers
- Departs from existing tool-call pattern; introduces end_turn JSON parsing as new pattern
- **Scope: possibly too broad for one PR**

**Direction 3: Merge PR #569 + structured output shim in same PR (hedge)**
- Ship PR #569 AND add end_turn JSON detection in `workflow-runner.ts` `turn_end` subscriber simultaneously
- Both mechanisms call `executeContinueWorkflow`; LLM can advance via either
- Accepts: two advancement paths doubles test surface; messy interaction; AgentClientInterface change still needed
- **Scope: too broad -- should be two separate PRs**

**Direction 4 (Reframe): Replace complete_step's implementation with end_turn JSON, keeping the concept name**
- LLM instructed: output `{"complete_step": true, "notes": "..."}` as final text
- Daemon detects in turn_end subscriber, parses, calls `executeContinueWorkflow`
- NO `complete_step` in tools array -- concept preserved in system prompt, implementation changes underneath
- Resolves: same as Direction 2 plus DX stability (system prompt and mental model unchanged)
- Accepts: beta API required, system prompt change, same AgentClientInterface scope as Direction 2
- **Scope: same as Direction 2**

---

## Problem Frame Packet

### Primary Users
- **Daemon users:** Running automated workflow sessions. Need zero session kills from token errors. Accept any hidden complexity.
- **Non-daemon MCP users:** Calling `continue_workflow` directly from Claude Code or other MCP clients. Must not be broken by daemon changes.
- **Daemon maintainers:** Need code that is readable, safe to change, and has clear invariants.
- **Future structured-output implementors:** Need a migration path that doesn't require breaking changes.

### Pains / Tensions

**T1: Correctness now vs elegance later**
`complete_step` solves the immediate token problem correctly. But it creates a migration cost if structured output is the future architecture. Shipping PR #569 now may entrench the tool-call approach for longer than intended.

**T2: Beta API stability**
Structured output requires `client.beta.messages.create()`. The beta endpoint is used by production tools (web_search, code execution) but has no stability SLA. Shipping it as the primary workflow control mechanism carries risk.

**T3: Notes validation layer**
Runtime `notes.length < 50` check is inside `execute()` (correct per design review). JSON Schema `minLength` is informational only. This is right per "validate at boundaries" -- the tool boundary is the right place. Not a tension but a confirmed correct decision.

**T4: Deprecated `continue_workflow` still callable**
FM4 risk: during transition the LLM might call `continue_workflow` with the token it sees... but the token is not in the initial prompt (confirmed at line 1981-1984). So the LLM has no token to pass. FM4 risk is lower than the design review assumed.

**T5: `onTokenUpdate` vs `onAdvance` -- two write paths**
Two mutation paths for `currentContinueToken` (lines 1784 and 1925 in workflow-runner.ts). These are confirmed mutually exclusive (kind: ok vs kind: blocked). Sequential execution prevents races. Manageable complexity.

### Success Criteria
1. TOKEN_BAD_SIGNATURE errors reach zero in daemon sessions
2. Session transcripts (LLM context) never contain a `continueToken` string
3. Works on Anthropic and Bedrock without provider-specific conditional logic
4. Token flow traceable by reading `makeCompleteStepTool()` and `runWorkflow()` alone
5. Migration to structured output doesn't require a breaking change to the MCP tool API surface

### Framing Risk

**Primary framing risk:** The entire `complete_step` PR might be unnecessary if structured output is viable to ship NOW. The findings doc (written today) recommends Option A (replace `complete_step` with `output_config`). If that recommendation is correct and the beta API is stable enough, PR #569 introduces complexity that will just be removed in the next PR.

What would confirm this risk: if the beta API has been stable in production for 3+ months and the `AgentClientInterface` change is small, the cost of skipping PR #569 and going straight to structured output is low.

What would refute this risk: if `AgentClientInterface` changes require significant refactoring, or if the beta API has shown instability in prior WorkRail usage, then PR #569 as an interim step is the right call.

---

## Challenge Notes

**Assumption 1: LLM inference is the token corruption source**
- Might be wrong: could be SDK serialization, context truncation, encoding
- Evidence: v2 short tokens are only 27 chars; even small truncation breaks HMAC

**Assumption 2: LLM-callable tool is the right abstraction**
- Might be wrong: daemon already owns loop; structured output eliminates tool layer entirely
- Evidence: structured output prototype confirms feasibility on both providers

**Assumption 3: Closure getter is race-free**
- Might be wrong: JS async boundaries could allow mutation between LLM decision and execution
- Evidence: agent-loop.ts confirms sequential tool execution (`toolExecution: 'sequential'`)

---

## Resolution Notes

### Recommendation: Merge PR #569 as-is (Candidate 1)

**Decision rationale:**

1. **Scope is best-fit.** Candidates 2 and 4 require `AgentClientInterface` changes that propagate to all `AgentLoop` consumers. This is larger than a targeted token-mangling fix.

2. **Complete_step and structured output are NOT mutually exclusive.** The daemon can adopt structured output in a follow-up PR. `executeContinueWorkflow` is the single advance point for both approaches -- migration is low-cost.

3. **Beta API risk is real and unquantified for daemon use.** `output_config` has no SLA. For workflow control where session kills are costly, this risk needs a deliberate architectural decision, not a bundled fix.

4. **Closure getter is proven safe.** Sequential execution confirmed; two mutation paths confirmed mutually exclusive; WHY comments are load-bearing but present.

5. **YAGNI.** PR #569 solves the immediate problem with zero new abstractions. Structured output belongs in a deliberate follow-up.

### What would tip the decision to Candidate 2/4

- Daemon team commits to structured output migration in same sprint
- `AgentClientInterface` change is one line (minimal propagation)
- Evidence that `complete_step` tool hallucination is a real problem in practice

### Improvements before merge

1. **`workrailSessionId` ordering concern (low risk, should add comment):** The tool is constructed before `workrailSessionId` is populated (token decode happens after construction at line 1863). The closure capture by reference is correct because the agent loop starts after the decode. But this ordering dependency is implicit. Add a comment: "WHY tool constructed before workrailSessionId is populated: the closure captures by reference; workrailSessionId is assigned before the agent loop starts at the prompt() call below."

2. **`params: any` type (cosmetic, low priority):** Consider `const params = block.input as CompleteStepParams` with a defined interface instead of `params: any` + eslint disable.

3. **Notes error message (minor improvement):** Current message says "Current length: N characters." Better: add "Notes must describe what you did, what you produced, and any key decisions."

### Relationship to structured output future

PR #569 is correct as an interim step AND as a permanent solution if structured output is never adopted. The two approaches are complementary:
- PR #569 ships now: zero token errors, zero session kills
- Structured output PR ships later (optional): eliminates `currentContinueToken` mutation, removes tool call requirement, makes illegal states unrepresentable
- Migration path: replace `complete_step` tool with end_turn JSON detection in `workflow-runner.ts`; update `AgentClientInterface` to `beta.messages.create()` in `agent-loop.ts`; update system prompt to remove tool reference

Neither PR blocks or invalidates the other.

---

## Decision Log

### Selected direction: Candidate 1 (Merge PR #569 as-is)

**Why C1 won:**
1. Best-fit scope for a token-fix PR
2. Complementary with structured output (not competing) -- executeContinueWorkflow is the shared seam
3. Proven safe from code analysis (sequential execution, mutually exclusive write paths, load-bearing WHY comments)
4. YAGNI -- zero new abstractions for the immediate fix

**Why the runner-up (C2/C4) lost:**
- Beta API risk is real and unquantified for daemon workflow control
- AgentClientInterface change propagates to all AgentLoop consumers -- bigger than a fix warrants
- But: C2/C4 would win if the team commits to the migration in the same sprint

### Challenge results

**Challenge 1 (beta API risk overstated):** Partially stands. Beta risk is not zero but findings doc provides real data. Recommendation unchanged.

**Challenge 2 (structured output will never ship after C1):** REAL concern. Mitigation: creating the follow-up issue is a REQUIREMENT of merge, not a suggestion.

**Challenge 3 (FM4 trigger in continue_workflow description):** NEW FINDING. The `continue_workflow` tool description contains "The continueToken from the previous...call" -- this tells the LLM a token exists and to find one. This is a FM4 vector independent of whether the token is in the prompt. **Action: update continue_workflow description to remove token-seeking language; replace with clear deprecation directive.**

**Challenge 4 (invariant not enforced at type level):** NEW FINDING. The mutual exclusivity of onAdvance vs onTokenUpdate paths is documented but not type-enforced. If a third response kind is added, the invariant could be silently broken. **Action: add exhaustiveness check (TypeScript switch over out.kind) so compiler catches missing cases.**

### Final improvements list (5 items, not 3)

1. Add WHY comment documenting workrailSessionId ordering dependency
2. Improve notes error message to describe content requirement
3. **Create follow-up issue for structured output migration (REQUIRED on merge)**
4. **Update continue_workflow description: remove token-seeking language, replace with deprecation directive**
5. **Add exhaustiveness check on out.kind in makeCompleteStepTool to enforce mutual exclusivity invariant**

---

## Final Summary

### Verdict: Merge PR #569 with 2 required and 3 recommended revisions

**Confidence band: HIGH**

### Is the complete_step tool the best approach?

**For now: YES.** PR #569's approach is correct, safe, and minimal. The closure getter mechanism is proven safe by code analysis (sequential tool execution, mutually exclusive write paths, load-bearing WHY comments). Notes validation is at the correct boundary. Token is never exposed to the LLM. The approach aligns with YAGNI and validates-at-boundaries principles.

**For the long term: The structured output architecture is better.** It eliminates the mutable closure variable entirely, makes it structurally impossible for the LLM to touch the token, and is validated on both Anthropic and Bedrock (findings doc). But it requires beta API + AgentClientInterface changes that are out of scope for a token-fix PR.

**Are they competing?** No. They are complementary. `executeContinueWorkflow` is the shared seam -- structured output just adds a new trigger path (end_turn JSON detection) alongside the existing tool-call trigger path.

### Key questions answered

**Q1: Is the late-binding closure getter `() => currentContinueToken` the right mechanism?**
YES. The getter is safe because tool execution is strictly sequential (confirmed in agent-loop.ts `_executeTools()` for...of loop). `onAdvance` (for successful advances) and the inline `onTokenUpdate` callback (for blocked retries) are mutually exclusive response branches. No race condition is possible.

**Q2: Should `complete_step` eventually be replaced by structured output?**
YES -- but it doesn't need to be, and doing so is NOT urgent. PR #569 is a correct interim solution that can remain indefinitely. The structured output migration is an improvement in architectural cleanliness, not a correctness fix.

**Q3: Is the notes min-50-char enforcement at the right layer?**
YES. JSON Schema `minLength` is informational to the LLM but not enforced by AgentLoop. The runtime check at `execute()` is the correct validation boundary per "validate at boundaries, trust inside."

**Q4: Is the blocked/retryable path reliable?**
YES. The `onTokenUpdate` callback updates `currentContinueToken` to the retry token before the LLM's next `complete_step` call. `persistTokens()` is called before either callback fires. Crash safety is preserved.

**Q5: Does PR #569 correctly remove the continueToken from `initialPrompt`?**
YES. Lines 1981-1984 confirm no token in the initial prompt. Implications: FM4 risk (LLM calling `continue_workflow` with a token) is significantly reduced because the LLM has no token to copy. The only FM4 vector remaining is the `continue_workflow` tool description itself (Revision 1).

### Required revisions (merge blockers)

1. Remove "Requires a continueToken that you must round-trip exactly" from the `continue_workflow` tool description (FM4 fix)
2. Create follow-up issue for structured output migration on merge

### Residual risks (acceptable)

- FM4 remains possible if LLM invents a token after being told the tool requires one; mitigated by Revision 1 and HMAC validation backstop
- Structured output migration may be perpetually deferred; mitigated by Revision 2 (required follow-up issue)
- Mutable closure variable is permanent technical debt until structured output migration ships
