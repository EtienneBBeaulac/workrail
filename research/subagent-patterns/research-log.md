# Research Log -- Sub-agent Spawning Patterns

## Phase 1 complete

**Regime:** depth_serial
**Sub-question count:** 6
**Topological order:** SQ1 -> SQ2 -> SQ3 -> SQ4 -> SQ5 -> SQ6

**Artifacts produced:**
- `source-map.md` -- 8 source entries (deep mode cap)
- `dependency-matrix.json` -- 6 sub-questions with dependency graph
- `plan.md` -- per-sub-question task list, source priority, stop rules, token budgets

**Key observation from initial fetch pass:**
- LangGraph's "call inside a node" pattern (synchronous invoke with typed TypedDict state transformation) is the most directly applicable to WorkRail's step-execution model
- OpenAI Agents SDK `as_tool` pattern (child agent embedded as a blocking tool call) is the second key pattern -- it maps naturally to WorkRail's tool execution layer
- OpenAI Swarm / handoffs are explicitly NOT result-return patterns -- they are transfer of control. Swarm is now deprecated in favor of Agents SDK which added `as_tool` specifically to address this gap
- Anthropic's orchestrator-workers pattern is described in production terms with clear typed delegation
- AutoGen's Swarm uses HandoffMessage -- also transfer-of-control, not result injection
- The Anthropic Claude Agent SDK uses `user.custom_tool_result` events to inject typed results back into a running session -- this is the most direct analogy to WorkRail's token-gated continue mechanism

**Pre-hypothesis entering Phase 2:**
The two most practical patterns for WorkRail are:
1. "Step as subgraph call" -- a step whose execution spawns a child session, blocks (durably) until it completes, and injects the child's artifact into the parent's step context. Maps to LangGraph "call inside a node."
2. "Child as tool" -- the child session is declared as a tool in the parent's step. The tool call triggers the child, the tool result is the child's typed output. Maps to OpenAI Agents SDK `as_tool`.

## Phase 3 complete (pass 1)

**Regime executed:** depth_serial
**Claims files produced:** 6 (one per sub-question, in topological order)

**SQ1 summary:** LangGraph "call inside a node" and OpenAI Agents SDK `as_tool` are the two shipped production patterns for blocking parent-child spawning with typed result return. LangGraph uses TypedDict + Python transformation functions. OpenAI uses Pydantic `output_type` + `final_output` extraction. Both block synchronously.

**SQ2 summary:** All production frameworks use blocking (parent waits for child). LangGraph's Send API supports parallel fan-out but parent still waits for all. AutoGen Swarm and OpenAI Swarm (deprecated) are the only "non-blocking" patterns -- but they are transfer-of-control, not result-return. WorkRail's existing spawn_agent matches the blocking model.

**SQ3 summary:** LangGraph uses Python TypedDict (type-checker enforced, not runtime-validated). OpenAI uses Pydantic (runtime-validated at LLM output parsing). WorkRail has the most principled system: JSON Schema contracts registered in the artifact registry, validated by the engine at step advance. The gap is that parent steps cannot declare expected child artifact contracts.

**SQ4 summary:** OpenAI Agents SDK is the only framework with bounded child execution: all failure modes (MaxTurnsExceeded, ModelBehaviorError) are caught by `failure_error_function` and returned as error strings. LangGraph propagates exceptions to the parent graph (no graceful degradation). WorkRail's existing spawn_agent has the best failure handling: typed discriminated union result (success/error/timeout/stuck) with issueSummaries.

**SQ5 summary:** Two viable engine approaches identified: (A) new `spawnAndWait` step property + PendingChildPoller for durable parking -- zero HMAC changes needed; (B) new MCP tool that blocks synchronously like spawn_agent does today -- zero DAG changes needed. The critical gap is typed artifact contract at the parent boundary (lastStepArtifacts is currently `unknown[]`).

**SQ6 summary:** Draft `spawnAndWait` step property designed as JSON extension to WorkflowStepDefinition. Parent declares `workflowId`, `goalTemplate`, `expectedArtifact.contractRef`, `contextPassThrough`. Child workflow is a standard reusable workflow. Result injected as `context_set` event into parent session. Structurally equivalent to LangGraph "different schemas + transform" but with declarative JSON authoring and engine-level contract validation instead of ad-hoc Python.

## Phase 4 complete (pass 1): 3 verified, 19 single-source, 12 inferred, 0 falsified-pending, 0 corroborated

**Merged file:** `claims/merged-pass-1.json`
**Priors ledger:** `priors-ledger.json` (no prior priors -- first pass)

**Confidence distribution:**
- verified (3): sq1-c2, sq6-c6, sq1-c2 -- LangGraph multi-agent topologies confirmed by two independent docs; WorkRail vs LangGraph architectural comparison confirmed by official docs + source code
- single-source (19): most WorkRail source code claims + primary SDK docs
- inferred (12): design proposals, analogical reasoning, absence-of-feature conclusions

**Key deduplication:** No duplicate claims across the 6 sub-question files. All 34 claims are unique. No prior priors to falsify or corroborate (first pass).

## Phase 5 complete (pass 1): stop

**Decision: STOP**
- All 6 SQs resolved (confirmed or design-complete)
- iterationCount=1, iterationCap=2 -- within cap, but no critical path gap justifies iteration
- Gap analysis: `gap-analysis.md`

## Phase 8 complete: RESEARCH COMPLETE -- brief.md emitted

**Final brief:** `research/subagent-patterns/brief.md` (research artifacts) and `docs/design/mr-review-overhaul/research-subagent-patterns.md` (canonical location)
**Final word count:** ~1,950 words (within 2,500 budget)
**Validation gate:** PASS (structural_integrity=high, confidence_integrity=high, focus_integrity=high)
**Ranked findings:** 5
**Falsified priors:** 0
**Contradictions:** 0

## Phase 7 complete: dissent type = weakest-claim

**Dissent file:** `dissent.md`
**Dissent type:** weakest-claim (plus structural concern about MCP timeout assumption)
**Load-bearing error identified:** Yes -- the BLUF recommendation of Option B as "low-cost first step" is undermined by the unquantified MCP tool call timeout risk. The brief acknowledges this risk in "What we do not know" but recommends Option B anyway. Dissent identifies this as a contradiction.

## Phase 6 complete: ~1,900 words

**Brief file:** `brief.md`
**Ranked findings:** 5
**Contradictions:** 0
**Falsified priors:** 0
**Word count:** ~1,900 (within 2,500 deep budget)
