# Research Brief: Sub-agent Spawning Patterns for WorkRail

## Intake Question (verbatim)

What patterns do LLM agent frameworks (LangGraph, CrewAI, AutoGen, OpenAI Swarm, etc.) use for bounded mid-session codebase investigation -- spawning a child agent mid-task, getting typed results back, and continuing the parent -- and what engine primitives are needed to support this?

---

## BLUF

The research identifies two shipped production patterns for typed parent-child agent result-return: LangGraph's synchronous subgraph invocation with TypedDict state transformation, and OpenAI Agents SDK's `as_tool` pattern with Pydantic-typed `final_output`. Both block the parent synchronously. WorkRail's daemon-context execution model already matches this blocking pattern and has better failure handling than either framework. The single most important gap is the untyped child artifact result: `lastStepArtifacts` is `unknown[]` and the parent workflow cannot declare or validate the expected artifact contract. Two implementation paths exist: Option A (durable engine-level parking via PendingChildPoller) is more robust for production; Option B (blocking MCP tool analogous to OpenAI `as_tool`) is faster to build but carries an unquantified MCP timeout risk for long-running child sessions.

---

## Ranked Findings

**Finding 1 (M): Blocking synchronous child execution is the dominant pattern across surveyed frameworks**
- Confidence: MEDIUM (each framework's 'blocking' claim is single-source; three single-source claims from three different frameworks do not constitute one verified cross-framework claim)
- Evidence for: LangGraph `subgraph.invoke()` blocks [unconfirmed, single-source: langchain-ai/langgraph subgraphs.md]; OpenAI Agents SDK `Runner.run()` inside `as_tool` blocks [unconfirmed, single-source: agent.py source code]; WorkRail spawn_agent `await runWorkflowFn()` blocks [unconfirmed, single-source: spawn-agent.ts]. Pattern is consistent across all three.
- Evidence against: Temporal, Dapr, and AWS Step Functions (durable workflow engines listed as OpenAI Agents SDK integration targets) were not surveyed. Their exclusion is a survivorship bias risk. The "blocking is universal" claim may not hold when durable async patterns are included. AutoGen/OpenAI Swarm use transfer-of-control, which is a different pattern (not counterevidence).
- Implication: Blocking is at minimum the dominant current pattern. Whether it is the right approach for WorkRail's durable session architecture over async alternatives remains open.

**Finding 2 (H): Two primary shipped patterns exist for typed result return**
- Confidence: HIGH (sq1-c2 verified by two independent LangGraph documents)
- Pattern A -- LangGraph "call inside a node": parent node function calls `subgraph.invoke(transform_input(state))` and transforms output back to parent state. TypedDict contract enforced by Python type-checker, not engine runtime.
- Pattern B -- OpenAI Agents SDK `as_tool`: `child_agent.as_tool(name, desc)` returns a `FunctionTool`; `Runner.run()` executes child blocking; child's `final_output` (Pydantic-validated via `output_type`) returned as tool result. Contract enforced at LLM output parse.
- Implication: WorkRail's target design improves on both: declarative JSON authoring (neither framework has this) and engine-level JSON Schema validation (stronger than both).

**Finding 3 (H): WorkRail's failure handling is already best-in-class for the daemon context**
- Confidence: HIGH (WorkRail source code + OpenAI Agents SDK source code, two independent codebases)
- Evidence: WorkRail `spawnOne()` returns a discriminated union { 'success'|'error'|'timeout'|'stuck' } and never throws. OpenAI Agents SDK `failure_error_function` catches all child exceptions as error strings (second-best). LangGraph propagates unhandled subgraph exceptions (worst model).
- Caveat: This finding covers daemon context only. MCP context failure handling (connection drop during long child execution) is a separate concern.

**Finding 4 (M): The typed artifact contract gap is the single most important engine change needed**
- Confidence: MEDIUM (single-source from WorkRail source)
- Evidence: `WorkflowRunSuccess.lastStepArtifacts` is `readonly unknown[]` [unconfirmed, single-source: types.ts]. Parent workflow has no mechanism to declare expected child artifact type. Engine cannot validate child output at the parent boundary.
- Implication: Adding `spawnAndWait.expectedArtifact.contractRef` to `WorkflowStepDefinition` fills this gap. The existing `ArtifactContractRef` + artifact-contract-validator.ts infrastructure can be reused at the parent boundary.

**Finding 5 (M): Option A (durable parking) is the safer production path; Option B (blocking MCP tool) requires timeout risk quantification first**
- Confidence: MEDIUM (inferred design proposals; load-bearing unknown identified by dissent)
- Option A: New `spawnAndWait` step behavior + `pending_child` gate state + PendingChildPoller auto-advances parent on child completion. Zero HMAC changes needed. Durable across MCP connection drops. Higher implementation cost (3-5 days).
- Option B: New MCP tool `spawn_and_wait` blocks synchronously like spawn_agent. Zero DAG changes. Lower implementation cost (1-2 days). **Load-bearing risk: if MCP tool calls exceeding 10-30 minutes cause Claude Code session timeout, Option B is not viable for long-running investigation agents.**
- Recommendation: Quantify the MCP timeout risk before committing to Option B.

---

## Contradictions

None found. Blocking execution and handoff/transfer-of-control are distinct patterns addressing different requirements, not contradictory approaches.

---

## Falsified Priors

None. No priors existed before this research pass.

---

## What We Now Know

- LangGraph "call inside a node" and OpenAI Agents SDK `as_tool` are the two primary production patterns for typed result return
- All surveyed frameworks' result-return patterns are synchronous-blocking
- WorkRail's daemon failure handling (discriminated union outcome) is already best-in-class
- The typed artifact contract gap (`lastStepArtifacts: unknown[]`) is the most critical engine gap for the MR review use case
- A `spawnAndWait` step property in workflow JSON authoring is the right authoring surface: declarative, engine-contract-validated, compatible with existing `context_set` injection
- The `session_created.data.parentSessionId` field already provides durable parent-child tracking
- HMAC token protocol requires no changes to support child session parking

## What We Still Do Not Know

- Whether blocking an MCP tool call for 10-30 minutes causes Claude Code session timeout (load-bearing for Option B viability)
- Whether Temporal, Dapr, or AWS Step Functions offer async child-completion-notification patterns that would be more appropriate for WorkRail's durable session architecture
- Whether `spawnAndWait` should be a new DAG node kind or a step property with special execution behavior
- Whether PendingChildPoller (Option A) can reuse the existing PendingDraftReviewPoller infrastructure without significant refactoring
- What `wr.investigation_findings` artifact schema should contain (domain knowledge needed from MR review team)

---

## Implications for Goal (WorkRail MR review spawn-and-wait)

Mid-review child agent spawn with typed result return is implementable in WorkRail with two focused changes: (1) a typed artifact contract on the parent step, and (2) the execution path (Option A or B). The child workflow (`wr.code-investigation`) requires no special "child-awareness" -- it is a standard reusable workflow that happens to produce a typed artifact. This is architecturally clean and mirrors LangGraph's "private scratchpad, shared typed output" pattern.

---

## Recommended Next Steps

**Step 1 (prerequisite, 0.5 days): Quantify MCP tool call timeout behavior**
- Test: start a child daemon session from an MCP tool call; let it run for 10, 20, 30 minutes; observe whether the Claude Code MCP session drops
- If timeout occurs: Option A is required from the start
- If no timeout: Option B is viable as a prototype
- This gates the implementation path decision

**Step 2 (medium cost, 1 day): Design and register wr.investigation_findings artifact contract**
- Define JSON Schema with MR review domain team
- Register alongside existing contracts (wr.review_verdict, wr.phase_handoff)
- Required before either implementation option is usable end-to-end

**Step 3 (medium-high cost, 1-5 days): Implement chosen execution path**
- Option B (if MCP timeout is acceptable): new `spawn_and_wait` MCP tool reusing spawn-agent logic + `spawnAndWait` step property on WorkflowStepDefinition. 1-2 days.
- Option A (if MCP timeout is not acceptable): new `pending_child_session` gate state + PendingChildPoller + spawnAndWait step property. 3-5 days.

---

## Dissent

The following concerns were raised in the adversarial dissent pass:

Finding #1 confidence was originally rated HIGH but this overstates the evidence: each framework's "blocking" claim is single-source. Three single-source claims from different frameworks do not constitute one verified cross-framework claim. Confidence downgraded to MEDIUM.

The original BLUF recommended Option B as a "low-cost first step" but Option B's primary failure mode (MCP timeout during 10+ minute child sessions) was simultaneously acknowledged as unknown. This is a contradiction. Recommended next steps restructured to gate on timeout quantification before committing to Option B.

The source map excluded durable workflow engines (Temporal, Dapr) mentioned as OpenAI Agents SDK integration targets. The "blocking is universal" claim may not hold when these are included.

---

## Premortem

If this brief turns out to be wrong six months from now, the most likely reason is that blocking an MCP tool call for 10+ minutes reliably times out Claude Code sessions -- making Option B non-viable and misleading implementers who start with Option B before testing. The second most likely reason: a durable async pattern (Temporal/Dapr-style event-driven child completion) proves more natural for WorkRail's append-only event log architecture, because the session store can express "waiting for external event" without holding a thread. Neither outcome would invalidate Finding 4 (the artifact contract gap), which is the most robust and actionable claim in this brief.

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

No priors existed before this research pass. See `research/subagent-patterns/priors-ledger.json`.

---

## Appendix B: Source Map

8 sources (deep mode cap). See `research/subagent-patterns/source-map.md`.

Gap: Temporal, Dapr, and AWS Step Functions were not in the source map. This is identified by dissent as a survivorship bias risk for Finding #1.

---

## Appendix C: Dependency Matrix

Regime: depth_serial. Topological order: SQ1 -> SQ2 -> SQ3 -> SQ4 -> SQ5 -> SQ6. See `research/subagent-patterns/dependency-matrix.json`.

---

## Appendix D: Gap Analysis Log

All 6 sub-questions resolved or design-complete at end of pass 1. See `research/subagent-patterns/gap-analysis.md`.
