# Research Brief: Sub-agent Spawning Patterns for WorkRail

## Intake Question (verbatim)

What patterns do LLM agent frameworks (LangGraph, CrewAI, AutoGen, OpenAI Swarm, etc.) use for bounded mid-session codebase investigation -- spawning a child agent mid-task, getting typed results back, and continuing the parent -- and what engine primitives are needed to support this?

---

## BLUF

The research identifies two shipped production patterns for typed parent-child agent result-return: LangGraph's synchronous subgraph invocation with TypedDict state transformation, and OpenAI Agents SDK's `as_tool` pattern with Pydantic-typed `final_output`. Both block the parent synchronously. WorkRail's daemon-context execution model already matches this blocking pattern and has better failure handling than either framework. The single most important gap is the untyped child artifact result: `lastStepArtifacts` is `unknown[]` and the parent workflow cannot declare or validate the expected artifact contract. Two implementation paths exist: Option A (durable engine-level parking via PendingChildPoller) is more robust for production; Option B (blocking MCP tool analogous to OpenAI `as_tool`) is faster to build but carries an unquantified MCP timeout risk for long-running child sessions.

---

## Ranked Findings

**Finding 1 (M): Blocking synchronous child execution is the dominant pattern across surveyed frameworks**
- Confidence: MEDIUM (downgraded from HIGH per dissent -- each framework's 'blocking' claim is single-source; three single-source claims do not constitute one verified cross-framework claim)
- Evidence for: LangGraph `subgraph.invoke()` blocks [unconfirmed, single-source: langchain-ai subgraphs.md]; OpenAI Agents SDK `Runner.run()` inside `as_tool` blocks [unconfirmed, single-source: agent.py source]; WorkRail spawn_agent `await runWorkflowFn()` blocks [unconfirmed, single-source: spawn-agent.ts]. Pattern is consistent across all three.
- Evidence against: The research did not survey durable async frameworks (Temporal, Dapr, AWS Step Functions) which are listed as integration targets for OpenAI Agents SDK. Their exclusion from the source map is a survivorship bias risk. AutoGen/OpenAI Swarm use transfer-of-control (not counterevidence -- they are a different pattern, not a non-blocking result-return approach).
- Implication: Blocking is at minimum the dominant current pattern. Whether it is the right approach for WorkRail's durable session architecture over async alternatives is not resolved.

**Finding 2 (H): Two primary shipped patterns exist for typed result return**
- Confidence: HIGH (sq1-c2 verified by two independent LangGraph docs)
- Pattern A -- LangGraph "call inside a node": parent node function calls `subgraph.invoke(transform_input(state))`, transforms output into parent state. TypedDict enforced at type-checker time, not engine runtime. Contract is implicit Python code.
- Pattern B -- OpenAI Agents SDK `as_tool`: `child_agent.as_tool(name, desc)` returns a `FunctionTool`; `Runner.run()` executes child blocking; child's `final_output` (Pydantic-validated via `output_type`) returned as tool result. Contract enforced at LLM output parse.
- Implication: WorkRail's target design improves on both: declarative JSON authoring (neither framework has this) with engine-level JSON Schema validation (stronger than both).

**Finding 3 (H): WorkRail's failure handling is already best-in-class for daemon context**
- Confidence: HIGH (single-source WorkRail + single-source OpenAI, two independent codebases)
- Evidence: WorkRail `spawnOne()` returns discriminated union { 'success'|'error'|'timeout'|'stuck' }, never throws. OpenAI Agents SDK `failure_error_function` catches child exceptions as error strings. LangGraph propagates unhandled subgraph exceptions (worst model).
- Caveat: This finding applies to the daemon context. MCP context failure handling (what happens if the MCP connection drops mid-child-execution) is a separate concern not covered by this finding.

**Finding 4 (M): The typed artifact contract gap is the single most important engine change needed**
- Confidence: MEDIUM (single-source from WorkRail source)
- Evidence: `WorkflowRunSuccess.lastStepArtifacts` is `readonly unknown[]` [unconfirmed, single-source: types.ts]. Parent workflow has no way to declare expected child artifact type. Engine cannot validate child output at parent boundary.
- Implication: Adding `spawnAndWait.expectedArtifact.contractRef` to `WorkflowStepDefinition` fills this gap. Existing `ArtifactContractRef` + artifact-contract-validator.ts infrastructure can be reused.

**Finding 5 (M): Option A (durable parking) is the safer production path; Option B (blocking MCP tool) requires timeout risk quantification first**
- Confidence: MEDIUM (inferred design proposals with load-bearing unknown per dissent)
- Option A (Durable Parking): New `spawnAndWait` step behavior + `pending_child` gate state + PendingChildPoller auto-advances parent when child completes. Zero HMAC changes. Durable across MCP connection drops. Higher implementation cost.
- Option B (Tool-Blocking): New MCP tool `spawn_and_wait` blocks synchronously like spawn_agent. Zero DAG changes. Lower implementation cost. **Load-bearing risk: if MCP tool calls exceeding 10-30 minutes cause Claude Code session timeout, Option B is not viable for MR review workflows that spawn long-running investigation agents.**
- Recommendation: Quantify the MCP timeout risk before committing to Option B. If MCP tool calls can block for 15+ minutes without timeout, Option B is viable as a prototype. If not, Option A is required from the start.

---

## Contradictions

None found. Blocking execution and handoff/transfer-of-control are distinct patterns, not contradictory approaches.

---

## Falsified Priors

None. No priors-ledger entries existed before this pass.

---

## What We Now Know

- LangGraph "call inside a node" and OpenAI Agents SDK `as_tool` are the two primary production patterns for typed result return. Handoffs are not result-return.
- All surveyed frameworks' result-return patterns are synchronous-blocking.
- WorkRail's daemon failure handling (discriminated union outcome) is already best-in-class.
- The typed artifact contract gap (`lastStepArtifacts: unknown[]`) is the most critical engine gap for the MR review use case.
- A `spawnAndWait` step property in workflow JSON authoring is the right surface: declarative, engine-contract-validated, compatible with existing `context_set` injection.
- The `session_created.data.parentSessionId` field already provides durable parent-child tracking.
- HMAC token protocol requires no changes -- the parent's continueToken remains valid while a child runs.

## What We Still Do Not Know

- Whether blocking an MCP tool call for 10-30 minutes causes Claude Code session timeout (load-bearing for Option B viability)
- Whether Temporal, Dapr, or AWS Step Functions offer async child-completion-notification patterns that would be more appropriate for WorkRail's durable session architecture
- Whether `spawnAndWait` should be a new DAG node kind or a step property with special execution behavior (implementation design decision)
- Whether the PendingChildPoller approach (Option A) can reuse the existing PendingDraftReviewPoller infrastructure without significant refactoring
- What `wr.investigation_findings` artifact schema should contain (domain knowledge needed from MR review team)

---

## Implications for Goal (WorkRail MR review spawn-and-wait)

The research confirms that mid-review child agent spawn with typed result return is implementable in WorkRail. The child workflow (`wr.code-investigation`) requires no special "I am a child" knowledge -- it is a standard reusable workflow producing a typed artifact. This is architecturally clean and maps to LangGraph's "private scratchpad, shared typed output" pattern. The typed artifact contract change (Finding 4) is required regardless of which implementation path is chosen.

---

## Recommended Next Steps

**Step 1 (prerequisite): Quantify MCP tool call timeout behavior**
- Test: start a child daemon session from an MCP tool call; let it run for 10, 20, 30 minutes; observe whether the Claude Code MCP session drops
- If timeout occurs before typical child session duration: Option A is required; skip Option B entirely
- Estimated cost: 0.5 days
- This gates the Option B vs Option A decision

**Step 2 (medium cost): Design and register wr.investigation_findings artifact contract**
- Define JSON Schema for the investigation findings artifact with domain team
- Register alongside existing contracts (wr.review_verdict, wr.phase_handoff)
- Required before either implementation option can be used end-to-end
- Estimated cost: 1 day

**Step 3 (medium-high cost): Implement chosen execution path**
- Option B (if MCP timeout is acceptable): new `spawn_and_wait` MCP tool reusing spawn-agent logic + `spawnAndWait` step property on WorkflowStepDefinition. 1-2 days.
- Option A (if MCP timeout is not acceptable): new `pending_child_session` gate state + PendingChildPoller + spawnAndWait step property. 3-5 days.

---

## Dissent

*Verbatim from Executor dissent pass:*

Finding #1 confidence is overstated: each framework's "blocking" claim is single-source, not verified. Three single-source claims from three different frameworks is NOT the same as one verified claim with 2+ independent sources. The HIGH confidence rating exceeds the evidence base.

The BLUF recommendation of Option B (blocking MCP tool) as "low-cost first step" is contradicted by the acknowledged unknown: MCP tool call timeout during 10+ minute child sessions. The brief acknowledges this risk in "What we do not know" but recommends Option B anyway without quantifying the risk.

The evidence base systematically excluded durable async frameworks (Temporal, Dapr, AWS Step Functions) which are explicitly mentioned as integration targets for OpenAI Agents SDK. Their absence from the source map means the "blocking is universal" claim has survivorship bias.

*Dissent addressed in revised brief by: downgrading Finding #1 to MEDIUM confidence; restructuring Recommended Next Steps to gate on MCP timeout quantification before committing to Option B.*

---

## Premortem

If this brief turns out to be wrong six months from now, the most likely reason is that blocking an MCP tool call for 10+ minutes reliably times out Claude Code sessions, making Option B non-viable -- and the brief's framing of Option B as a "prototype" misleads implementers into starting with a path that must be abandoned mid-implementation. The second most likely reason: a durable async pattern (Temporal/Dapr-style event-driven child completion) proves more natural for WorkRail's session store architecture than the blocking model, because the session store is already an event log that can express "waiting for external event" without holding a thread. Neither of these outcomes would invalidate the artifact contract gap finding (Finding 4), which is the most robust and actionable claim in the brief.

---

## Evidence Base

[1] LangGraph subgraphs concepts: `https://raw.githubusercontent.com/langchain-ai/langgraph/0.4/docs/docs/concepts/subgraphs.md`
[2] LangGraph multi-agent concepts: `https://raw.githubusercontent.com/langchain-ai/langgraph/0.4/docs/docs/concepts/multi_agent.md`
[3] OpenAI Agents SDK agent.py: `https://raw.githubusercontent.com/openai/openai-agents-python/main/src/agents/agent.py`
[4] OpenAI Agents SDK exceptions.py: `https://raw.githubusercontent.com/openai/openai-agents-python/main/src/agents/exceptions.py`
[5] Anthropic building-effective-agents: `https://www.anthropic.com/engineering/building-effective-agents`
[6] WorkRail spawn_agent: `src/daemon/tools/spawn-agent.ts`
[7] WorkRail daemon types: `src/daemon/types.ts`
[8] WorkRail token payloads: `src/v2/durable-core/tokens/payloads.ts`
[9] WorkRail session events: `src/v2/durable-core/schemas/session/events.ts`
[10] WorkRail workflow definition: `src/types/workflow-definition.ts`

---

## Appendix A: Priors Ledger

No priors existed before this research pass. See `priors-ledger.json`.

---

## Appendix B: Source Map

See `source-map.md` (8 sources, deep mode). Note: Temporal, Dapr, and AWS Step Functions were not in the source map. This is a gap identified by the dissent pass.

---

## Appendix C: Dependency Matrix

See `dependency-matrix.json`. Regime: depth_serial. Topological order: SQ1 -> SQ2 -> SQ3 -> SQ4 -> SQ5 -> SQ6.

---

## Appendix D: Gap Analysis Log

See `gap-analysis.md`. All 6 sub-questions resolved or design-complete at end of pass 1.
