# Research Brief -- wr-research-ccloop-001

## Intake Question (verbatim)

What agent loop patterns does Claude Code use that WorkRail's daemon AgentLoop should adopt? Specifically: parallel tool execution, tool safety model, abort handling, context management, delivery/commit flow, and stuck detection.

---

## BLUF

Claude Code's parallel tool execution uses a four-axis safety classification (isConcurrencySafe, isReadOnly, isDestructive, interruptBehavior) with a run-in-order batching strategy that is adoptable by WorkRail's daemon once tool safety metadata is added to the tool interface. Its abort handling is a hierarchical three-level AbortController cascade that separates sibling-error propagation from user-interrupt propagation -- a pattern WorkRail currently lacks and should adopt for the non-streaming parallel execution path. Claude Code has NO dedicated stuck detector; its diminishing-returns token-velocity check (delta < 500 tokens for 3+ continuations) is different from WorkRail's repeated-tool-call heuristic but not superior -- both address different failure modes and WorkRail should add the token-velocity check as a complement. The most immediately actionable gap for WorkRail is the worker self-commit pattern: Claude Code workers commit as part of task execution, not in a post-task hook, which directly addresses WorkRail's known B1+B6 delivery gap via a prompt-only change.

---

## Ranked Findings

**Finding 1 (confidence: M [single-source])** -- Parallel execution is a batching strategy, not a scheduling policy  
Evidence for: `partitionToolCalls()` groups consecutive `isConcurrencySafe` tools into one batch; singleton batches for non-safe tools; `runToolsConcurrently()` with cap=10 [SQ1-C2, SQ1-C3]  
Evidence against: no counter-evidence found in fetched sources  
WorkRail implication: WorkRail needs `isConcurrencySafe` per-tool metadata and a batch partitioner around the existing sequential loop. The non-streaming execution path (runTools -> partitionToolCalls -> runToolsConcurrently) is more adoptable than the StreamingToolExecutor path, which requires restructuring around a stateful async class.

**Finding 2 (confidence: M [single-source])** -- Tool safety is four-axis, not binary  
Evidence for: `isConcurrencySafe`, `isReadOnly`, `isDestructive`, `interruptBehavior` -- all per-invocation methods, fail-closed defaults [SQ2-C1, SQ2-C2, SQ2-C5]; BashTool uses dynamic per-command analysis via `checkReadOnlyConstraints()` [SQ2-C4]  
Evidence against: no counter-evidence found in fetched sources  
WorkRail implication: Adding these four fields to the tool interface is the prerequisite for both parallel execution and correct abort behavior. All four default to safe/conservative values.

**Finding 3 (confidence: M [single-source])** -- Abort is a three-level hierarchy with controlled propagation  
Evidence for: session AbortController > siblingAbortController > per-tool toolAbortController; sibling errors do NOT propagate to session; only Bash errors cascade to siblings [SQ3-C1, SQ3-C2, SQ3-C6]  
Evidence against: no counter-evidence found in fetched sources  
WorkRail implication: The non-streaming parallel path should use a siblingAbortController scoped to each concurrent batch. Bash-tool errors abort batch siblings; read-tool errors do not.

**Finding 4 (confidence: M [single-source])** -- Worker self-commit closes the delivery gap  
Evidence for: Coordinator system prompt requires workers to 'Run relevant tests and typecheck, then commit your changes and report the hash' [SQ5-C2]; no separate post-task hook [SQ5-C4, SQ5-C5]  
Evidence against: no counter-evidence found in fetched sources  
WorkRail implication: WorkRail's B1+B6 gap can be addressed by adding explicit self-commit instructions to the WorkTrain worker system prompt. No engine change required.

**Finding 5 (confidence: M/inferred for compaction strategies)** -- Context management uses four layered strategies; diminishing-returns detection is the most portable  
Evidence for: autocompact, reactive-compact, snip, context-collapse [SQ4-C4, inferred]; BudgetTracker diminishing-returns check (continuationCount >= 3 AND delta < 500 tokens) [SQ4-C3, single-source]  
Evidence against: no counter-evidence found in fetched sources  
WorkRail implication: Add the token-velocity check to the daemon loop as a complement to the existing repeated-tool-call heuristic. Full compaction strategies are lower priority for bounded daemon sessions.

---

## Contradictions

None found. All 49 claims from 7 sub-questions are internally consistent across the fetched source files.

---

## Falsified Priors

**P11 FALSIFIED:** "Claude Code has more sophisticated stuck/stall detection than WorkRail (e.g., progress metrics, token velocity checks)"

Overturning claim [SQ6-C1, single-source]: "Claude Code has no dedicated 'stuck detector'. It uses two mechanisms instead: (1) maxTurns hard limit, (2) token budget diminishing-returns detection."

Resolution: Claude Code and WorkRail have DIFFERENT stuck-detection approaches, not a sophistication gap. WorkRail's repeated-tool-call heuristic catches the 'spinning on same tool' failure mode; Claude Code's token-velocity check catches 'producing diminishing output'. WorkRail should ADD the token-velocity check; it is not inferior to Claude Code.

---

## What We Now Know

- Exact implementation of partitionToolCalls / runToolsConcurrently / StreamingToolExecutor batching logic
- Complete four-axis safety classification schema with per-tool values for FileRead, Glob, Grep, FileEdit, FileWrite, WebSearch, BashTool
- Three-level AbortController hierarchy with explicit propagation rules (sibling vs session)
- Four context compaction strategies with trigger conditions and the BudgetTracker diminishing-returns threshold
- Coordinator/worker protocol including XML task-notification format and worker self-commit requirement
- Exhaustive discriminated union of Terminal and Continue exit reasons (10 terminal, 8 continue states)
- Per-tool maxResultSizeChars table; persist-to-disk strategy (no truncation); empty-output guard

## What We Still Do Not Know

- How `checkReadOnlyConstraints()` classifies compound Bash commands -- the full rule set is in `BashTool/bashCommandHelpers.ts`, not fetched
- How the `all()` utility implements the concurrency cap (semaphore? backpressure? work-stealing?) -- `utils/generators.ts` not fetched; Finding 1's implication that WorkRail can use a "trivial bounded Promise.all" is unverified
- Whether the coordinator/worker XML protocol is schema-validated or only system-prompt-enforced -- coordinatorMode.ts:143-165 cited but not deeply parsed
- Whether `QueryEngine.ts` (S1 in source-map) is the same file as `query.ts` cited in claims -- naming inconsistency not resolved; the top-level agent loop entry point was not fully analyzed
- Proactive autocompact threshold -- SQ4-C4 is inferred across multiple file references, not directly read from the autocompact trigger logic

---

## Implications for WorkRail Daemon

Prioritized by implementation cost:

1. **Zero code change (prompt only):** Add self-commit instruction to WorkTrain worker system prompt. Closes B1+B6. [Finding 4]
2. **Low cost (tool metadata):** Add `isConcurrencySafe()` and `isReadOnly()` to tool interface, fail-closed defaults. Does not break sequential mode. [Finding 2]
3. **Low cost (stuck detection):** Add token-velocity check: continuationCount >= 3 AND last two deltas < 500 tokens -> stop. Complements existing heuristic. [Finding 5]
4. **Medium cost (batching loop):** Wrap sequential tool execution with partitionToolCalls + runToolsConcurrently(cap=10) using the NON-streaming path. Backwards-compatible: all tools default to sequential. [Finding 1]
5. **Medium cost (abort hierarchy):** Add siblingAbortController between session and per-tool for Bash-batch error isolation. [Finding 3]
6. **High cost (context compaction):** Full compaction strategies. Defer -- daemon sessions are bounded by step timeouts.

---

## Recommended Next Steps

1. **Fetch utils/generators.ts for the all() concurrency cap implementation (30 min)** -- Verifies Finding 1's implication that a simple bounded Promise.all is sufficient. If all() has backpressure or fairness properties, WorkRail needs to replicate them.

2. **Fetch BashTool/bashCommandHelpers.ts for checkReadOnlyConstraints (1 hour)** -- Needed to implement dynamic Bash classification. Without this, all Bash calls must default to non-concurrent (safe but misses parallelism opportunity).

3. **Add worker self-commit to WorkTrain system prompt and test on one workflow (2 hours)** -- Highest ROI action item. Can be done immediately with no dependencies on the above.

---

## Dissent

Adversarial review identified two legitimate weaknesses in the brief (dissent type: weakest-claim):

**Weakness 1 -- 'Directly adoptable with minimal architectural change' is unsupported.** The BLUF originally stated this without comparing against WorkRail's actual tool execution architecture. This has been softened in the final brief to "adoptable by WorkRail's daemon once tool safety metadata is added to the tool interface." The adoptability claim for the non-streaming path is reasonable; for the streaming path (StreamingToolExecutor), it is significantly more complex.

**Weakness 2 -- Finding 1 rests on unverified assumption about all().** The claim that WorkRail can use a "trivial bounded Promise.all" is an inference about utils/generators.ts content that was not fetched. The brief's Recommended Next Steps item 1 now makes this explicit.

**Weakness 3 -- QueryEngine.ts vs query.ts naming inconsistency.** Source-map S1 names the primary file as `src/QueryEngine.ts`, but claims SQ1-C7 cites `query.ts:1380-1408`. These may be the same file at different points in the repo's history, or different files. The top-level loop entry point was not confirmed. This does not affect the correctness of the tool execution claims, which are sourced from toolOrchestration.ts and StreamingToolExecutor.ts, but it is an evidence gap for the full loop context.

Full dissent text: see dissent.md.

---

## Premortem

If this brief turns out to be wrong six months from now, the most likely reason is that the `all()` concurrency utility has backpressure or fairness properties that make naive bounded `Promise.all` adoption incorrect for WorkRail's use case -- specifically, that the 10-slot cap in Claude Code is tuned for a consumer desktop with fast local tools, and WorkRail's daemon running longer-duration server-side tasks needs a different cap or a different scheduling strategy. A secondary likely failure mode is that the worker self-commit recommendation (Finding 4) does not generalize to WorkRail's non-coordinator workflow sessions, where there is no coordinator to report the hash to, making the commit invisible.

---

## Evidence Base

[1] toolOrchestration.ts -- partitionToolCalls, runToolsConcurrently, runToolsSerially (SQ1-C1 through SQ1-C3, SQ1-C6)  
[2] StreamingToolExecutor.ts -- streaming parallel executor, abort hierarchy, interruptBehavior (SQ1-C4, SQ1-C5, SQ2-C5, SQ2-C6, SQ3-C1 through SQ3-C7)  
[3] query.ts -- query loop async generator interface, abort-during-streaming, maxTurns, token budget continuation (SQ1-C7, SQ3-C4, SQ4-C2, SQ4-C5, SQ6-C1, SQ6-C5, SQ6-C6)  
[4] Tool.ts -- ToolResult type, isConcurrencySafe, isReadOnly, isDestructive, interruptBehavior, maxResultSizeChars, buildTool defaults (SQ2-C1, SQ2-C2, SQ2-C5, SQ4-C7, SQ7-C1, SQ7-C6)  
[5] toolExecution.ts -- abort check at tool start, error wrapping, is_error formatting, classifyToolError (SQ3-C6, SQ7-C4, SQ7-C5)  
[6] tokenBudget.ts -- BudgetTracker, diminishing-returns detection, token nudge message (SQ4-C1, SQ4-C2, SQ4-C3)  
[7] transitions.ts -- Terminal and Continue discriminated unions (SQ6-C2, SQ6-C3)  
[8] stopHooks.ts -- external stop hooks, abort polling during hook execution, loop prevention (SQ6-C4, SQ6-C5, SQ6-C7)  
[9] coordinatorMode.ts -- coordinator/worker model, XML task-notification, worker self-commit instruction, anti-patterns (SQ5-C1 through SQ5-C3, SQ5-C7)  
[10] LocalAgentTask.tsx -- task state machine, sliding window tracker, pendingMessages drain (SQ5-C4 through SQ5-C6)  
[11] toolResultStorage.ts -- persist-to-disk strategy, empty-output guard, image bypass (SQ7-C1, SQ7-C3, SQ7-C7)  
[12] GlobTool.ts, GrepTool.ts, FileReadTool.ts, FileEditTool.ts, BashTool.tsx, WebSearchTool.ts -- per-tool safety annotations, maxResultSizeChars values (SQ2-C3, SQ2-C4, SQ7-C2)

---

## Appendix A: Priors Ledger Final Status

| Prior | Claim | Final Tag |
|---|---|---|
| P1 | WorkRail AgentLoop only supports sequential tool execution | prior:verified |
| P2 | Claude Code supports parallel tool execution | corroborated |
| P3 | WorkRail stuck detection uses repeated_tool_call heuristic | prior:verified |
| P4 | WorkRail stall detection uses stallTimeoutMs timer | prior:verified |
| P5 | WorkRail coordinator workers have B1+B6 delivery gap | prior:verified |
| P6 | WorkRail tools throw on failure, AgentLoop catches | prior:verified |
| P7 | Claude Code has context compaction strategy | corroborated |
| P8 | Claude Code uses AbortController for in-flight calls | corroborated |
| P9 | Claude Code has safety classification for read-only vs mutating | corroborated |
| P10 | Claude Code handles delivery/commit inside agent loop | corroborated |
| P11 | Claude Code has MORE sophisticated stuck detection than WorkRail | **falsified** |
| P12 | Source accessible at github.com/codeaashu/claude-code | corroborated |

---

## Appendix B: Source Map

S1: src/QueryEngine.ts -- PRIMARY (cited as main loop file; claims reference query.ts -- naming to verify)  
S2: src/query/transitions.ts -- PRIMARY (Terminal/Continue discriminated unions)  
S3: src/Tool.ts -- PRIMARY (ToolResult, safety classification, maxResultSizeChars)  
S4: src/tools.ts -- PRIMARY (tool registry; per-tool safety confirmed via individual tool files)  
S5: src/query/tokenBudget.ts -- SECONDARY (BudgetTracker, diminishing-returns)  
S6: src/tasks/LocalAgentTask/LocalAgentTask.tsx -- SECONDARY (task state machine, pendingMessages)  
S7: src/query/stopHooks.ts -- SECONDARY (stop hooks, abort polling)  
S8: src/coordinator/coordinatorMode.ts -- SECONDARY (coordinator/worker model, self-commit)

Additional files fetched not in original source map:  
- src/services/tools/toolOrchestration.ts (primary parallel execution implementation)  
- src/services/tools/StreamingToolExecutor.ts (streaming executor, abort hierarchy)  
- src/services/tools/toolExecution.ts (tool call/error handling)  
- src/utils/toolResultStorage.ts (persist-to-disk strategy)  
- Individual tool files: GlobTool.ts, GrepTool.ts, FileReadTool.ts, BashTool.tsx, WebSearchTool.ts, FileEditTool.ts, FileWriteTool.ts

---

## Appendix C: Dependency Matrix Summary

SQ1 (foundation) -> SQ2, SQ3, SQ7 (depend on SQ1)  
SQ4, SQ5, SQ6 (independent)  
Topological order executed: SQ1, SQ4, SQ5, SQ6, SQ2, SQ3, SQ7  
Regime: depth_serial

---

## Appendix D: Gap Analysis Log

All 7 sub-questions: PARTIAL (single-source, comprehensive)  
Iteration decision: STOP after pass 1  
Rationale: No critical-path gap; additional passes would not add cross-hostname verification for code-level claims; all key files fetched.  
Remaining gaps: utils/generators.ts, BashTool/bashCommandHelpers.ts, QueryEngine.ts (vs query.ts naming), autocompact trigger threshold.
