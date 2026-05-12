# Research Plan -- wr-research-ccloop-001

## Regime: depth_serial
## Sub-question count: 7
## Token budget per subagent: 25,000 (deep mode)
## Subagent cap: 10

---

## Execution Order

### Batch 1: SQ1 (foundation -- must complete first)

**SQ1 -- Parallel tool execution implementation**
- Task: Fetch `src/QueryEngine.ts` in full. Read for: (a) how tool_use blocks are processed, (b) any `Promise.all` or async fan-out pattern, (c) any `isParallelizable` or similar field checked before parallelizing, (d) how results are collected and returned to the LLM.
- Sources: S1 (QueryEngine.ts), then S3 (Tool.ts) for type definitions
- Stop rule: min 3 fetches (QueryEngine + Tool + tools.ts), stop after 2 consecutive zero-novelty fetches
- Token budget: 25,000

### Batch 2: SQ4, SQ5, SQ6 (independent, can be done in parallel mentally but must be serialized in fetch execution)

**SQ4 -- Context management**
- Task: Fetch `src/query/tokenBudget.ts` in full. Look for: token counting, compaction triggers, summarization calls, context pruning strategies. Cross-reference with QueryEngine.ts already fetched.
- Sources: S5, then S1 for where it's called
- Stop rule: min 2 fetches + 1 zero-novelty
- Token budget: 15,000

**SQ5 -- Delivery/commit flow**
- Task: Fetch `src/tasks/LocalAgentTask/LocalAgentTask.tsx` and `src/coordinator/coordinatorMode.ts`. Look for: post-task hooks, git commit/push calls, PR creation, cleanup steps.
- Sources: S6, S8
- Stop rule: min 2 fetches + 1 zero-novelty
- Token budget: 15,000

**SQ6 -- Stuck/stall detection**
- Task: Fetch `src/query/stopHooks.ts` and `src/query/transitions.ts`. Look for: loop detection, progress metrics, token velocity, max iteration counters, content-based stall signals.
- Sources: S7, S2
- Stop rule: min 2 fetches + 1 zero-novelty
- Token budget: 15,000

### Batch 3: SQ2, SQ3, SQ7 (depend on SQ1 completion)

**SQ2 -- Tool safety classification**
- Task: Using Tool.ts and tools.ts already fetched, extract the full safety classification schema. Map each tool to its parallelism class.
- Sources: S3, S4
- Stop rule: Analysis of already-fetched material + 1 additional fetch if needed
- Token budget: 10,000

**SQ3 -- Abort/cancellation for parallel tools**
- Task: In QueryEngine.ts (already fetched), trace the AbortController/AbortSignal usage specifically for in-flight parallel calls. What happens to already-started parallel tools when abort is triggered?
- Sources: S1 (already fetched), S2
- Stop rule: Analysis of already-fetched material
- Token budget: 10,000

**SQ7 -- Tool result formatting and error handling**
- Task: In QueryEngine.ts and Tool.ts (already fetched), find: max result size limits, truncation logic, isError semantics, how errors are formatted back to the LLM.
- Sources: S1, S3 (already fetched)
- Stop rule: Analysis of already-fetched material + 1 additional fetch if needed
- Token budget: 10,000

---

## Output Artifacts

For each sub-question, produce a `findings-SQN.md` file with:
- Key findings (specific code patterns, data structures, algorithms)
- Prior updates (which priors were confirmed, refuted, or updated)
- Adoption recommendations for WorkRail

Final synthesis: `synthesis.md` with actionable recommendations for each of the 7 key questions, organized by priority.
