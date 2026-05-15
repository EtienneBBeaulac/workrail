# Gap Analysis -- Pass 1

## Resolved Sub-questions

**SQ1: Shipped production patterns for parent-child spawning with typed result return**
- Status: RESOLVED
- Evidence: sq1-c2 VERIFIED (LangGraph multi-agent topologies confirmed by 2 independent docs). sq1-c3 single-source (OpenAI Agents SDK source code). sq1-c4 single-source (Anthropic blog). sq1-c5 inferred (Swarm deprecation implies result-return gap). No contradicting evidence.
- Key finding: Two primary patterns -- LangGraph "call inside a node" (TypedDict transform) and OpenAI Agents SDK `as_tool` (Pydantic output_type). Handoffs are explicitly NOT result-return patterns.

**SQ2: Blocking vs non-blocking execution model**
- Status: RESOLVED
- Evidence: sq2-c1 through sq2-c5 all consistent -- all production result-return patterns are synchronous-blocking. WorkRail's spawn_agent matches this model. LangGraph Send API is the only concurrent pattern but still logically blocking.
- No contradicting evidence found.

**SQ3: Typed result contracts**
- Status: RESOLVED
- Evidence: sq3-c1 (LangGraph TypedDict, type-checker only), sq3-c2 (OpenAI Pydantic, runtime), sq3-c3 (WorkRail unknown[], key gap identified), sq3-c5 (WorkRail artifact contracts are most principled but only child-side). Consistent picture across all sources.
- Critical gap identified: parent step cannot declare expected child artifact contract -- this is a design change recommendation, not a fact gap.

**SQ4: Failure modes and recovery**
- Status: RESOLVED
- Evidence: sq4-c1 (OpenAI bounded child execution via failure_error_function -- single-source from source code). sq4-c3 (WorkRail discriminated union outcome -- single-source from source code). sq4-c2 (LangGraph exception propagation -- inferred but consistent with LangGraph doc). No contradicting evidence.
- Key finding: WorkRail's spawn_agent already has the best failure handling of all surveyed frameworks.

**SQ5: WorkRail engine primitives needed**
- Status: RESOLVED (design proposals)
- Evidence: sq5-c1 through sq5-c7 -- all inferred design proposals derived from WorkRail source code analysis. The claims are internally consistent and derivable from the confirmed source code facts.
- Two concrete options identified (Option A durable parking, Option B tool-blocking). The typed artifact contract gap (sq5-c7) is the single most important change identified.
- Note: SQ5 produces design recommendations, not factual claims about existing systems. Inferred confidence is appropriate and expected here.

**SQ6: Workflow authoring surface**
- Status: RESOLVED (design proposals)
- Evidence: sq6-c1 through sq6-c6 -- all inferred design proposals. sq6-c6 VERIFIED (architectural comparison between WorkRail and LangGraph confirmed by independent sources from distinct hostnames).
- Draft `spawnAndWait` step property designed. Parent/child workflow fragments documented. Context injection mechanism identified.

## Partial Sub-questions

None -- all 6 sub-questions resolved.

## Open Sub-questions

None.

## Iteration Decision

**Decision: STOP**

Rationale:
1. All 6 sub-questions are resolved (confirmed or design-complete)
2. iterationCount (1) < iterationCap (2) but no critical path gap exists
3. Additional passes would not yield new verified claims -- the remaining design questions (SQ5, SQ6) are proposals that require implementation work, not additional research
4. The key synthesis deliverable (engine primitives + authoring surface) has sufficient grounding to write the research brief
