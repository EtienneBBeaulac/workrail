# Research Plan -- Sub-agent Spawning Patterns

Mode: deep | Regime: depth_serial | Sub-questions: 6 | Subagent cap: 10 | Per-subagent budget: 25,000 tokens

## Execution order (topological)

SQ1 -> SQ2 -> SQ3 -> SQ4 -> SQ5 -> SQ6

---

## SQ1: Shipped production patterns for parent-child agent spawning with typed result return

**Goal:** Enumerate the concrete patterns that are actually deployed in production (not just documented) across the major frameworks.

**Planned tasks:**
1. Fetch LangGraph subgraph "call inside a node" pattern in full detail (state transformation, invoke, return)
2. Fetch OpenAI Agents SDK `as_tool` pattern -- how a child agent is embedded as a tool and its output is returned as a tool result
3. Fetch OpenAI Agents SDK handoff documentation to distinguish handoff (transfer) from result-return (coroutine)
4. Read Anthropic engineering blog orchestrator-workers section in detail
5. Fetch LangGraph multi-agent / supervisor concepts page

**Sources to prioritize:** S1, S2, S3, S5

**Stop rule:** min 3 fetches AND 2 consecutive zero-novelty fetches, OR token budget hit

**Token budget:** 25,000 tokens

**Key question to answer:** For each framework, describe the exact mechanism: (a) how parent suspends, (b) how child receives context, (c) how typed output is returned, (d) whether the pattern is blocking.

---

## SQ2: Blocking vs non-blocking execution model

**Goal:** For each pattern identified in SQ1, characterize whether the parent truly blocks (synchronous call), polls, or permanently hands off control.

**Planned tasks:**
1. Review LangGraph subgraph invocation -- it is synchronous Python; the parent node function blocks until `subgraph.invoke()` returns
2. Review OpenAI Agents SDK `as_tool` execution -- the tool call is blocking within the agent loop turn
3. Review AutoGen Swarm handoff pattern -- it is a TRANSFER, not a return; the original agent does not resume
4. Search for any framework that implements async/non-blocking child agent with eventual result injection

**Sources to prioritize:** S1, S2, S4

**Stop rule:** min 3 fetches AND 2 consecutive zero-novelty fetches

**Token budget:** 25,000 tokens

**Key question to answer:** Is blocking (parent waits, single thread) the universal pattern, or do any production frameworks support async spawning where the parent can continue doing other work?

---

## SQ3: Typed result contracts -- schemas and injection

**Goal:** Understand how the output schema of a child is specified and how its output is injected into the parent's context/state.

**Planned tasks:**
1. LangGraph typed state: both `TypedDict` schemas and the transformation functions that map child output to parent state keys
2. OpenAI Agents SDK `output_type` parameter and `ToolsToFinalOutputResult` -- how the child's final output type is declared
3. Anthropic SDK custom tool result event -- `user.custom_tool_result` with typed content injected back into session
4. Examine if any framework has a JSON Schema-validated result contract (not just Python types)

**Sources to prioritize:** S1, S2, S7

**Stop rule:** min 3 fetches AND 2 consecutive zero-novelty fetches

**Token budget:** 25,000 tokens

**Key question to answer:** Is there a pattern where the child's output type is statically declared (in a schema) before the child runs, and the engine validates it on return?

---

## SQ4: Failure modes and recovery

**Goal:** What happens when a child agent fails (exception, timeout, bad output)? How does the parent recover?

**Planned tasks:**
1. OpenAI Agents SDK error handlers and `MaxTurnsExceeded` -- what exception escapes and how callers handle it
2. LangGraph subgraph failure -- if a subgraph raises, does the parent's checkpointer capture state before the call?
3. Anthropic orchestrator-workers failure handling in the blog post
4. Search for any framework with explicit "child failed, parent continues" fallback logic

**Sources to prioritize:** S2, S3, S6

**Stop rule:** min 3 fetches AND 2 consecutive zero-novelty fetches

**Token budget:** 25,000 tokens

**Key question to answer:** Do any production frameworks have "bounded child execution" (timeout + typed error result) that the parent can handle gracefully without crashing the parent session?

---

## SQ5: WorkRail engine primitives needed

**Goal:** Synthesize findings from SQ1-SQ4 into concrete WorkRail engine requirements.

**Planned tasks:**
1. Review WorkRail's current spawn_agent feature and what it does vs does not do
2. Map the "call inside a node" pattern (SQ1) to WorkRail's DAG node execution model
3. Identify what new session events are needed (child_session_started, child_session_completed, child_session_failed)
4. Identify what changes the HMAC token protocol needs (parent session must hold a "pending child" reference without invalidating its own token)
5. Identify whether a new DAG node type is needed (blocking_subgraph vs current spawn_agent)

**Sources to prioritize:** WorkRail source (src/v2/, src/mcp/), S1, S2

**Stop rule:** Source code review complete + synthesis written

**Token budget:** 25,000 tokens

**Key question to answer:** What is the minimal engine change that enables: (a) parent emits a child session, (b) parent session is durably suspended (HMAC state preserved), (c) child completes with typed output, (d) parent resumes with child output injected as step context.

---

## SQ6: Workflow authoring surface for MR review spawn-and-wait

**Goal:** Produce a concrete workflow authoring example showing how a parent review workflow would spawn a code investigation sub-agent mid-review.

**Planned tasks:**
1. Design the JSON authoring surface for a `spawn_and_wait` step type
2. Write example parent workflow JSON fragment
3. Write example child workflow JSON fragment (the investigation sub-workflow)
4. Document the output contract between child and parent
5. Compare with LangGraph's subgraph pattern to validate the design

**Sources to prioritize:** WorkRail authoring docs, S1

**Stop rule:** Authoring surface designed and example written

**Token budget:** 25,000 tokens

**Key question to answer:** What is the minimal authoring surface that is expressive enough for the MR review use case without requiring changes to the workflow JSON schema beyond adding one new step type?
