# Research Log -- wr-research-ccloop-001 -- 2026-05-12T00:00:00Z

## Phase 0 complete
Intake captured: researching Claude Code leaked source for agent loop patterns (parallel tool execution, abort handling, context management, delivery/commit flow, stuck detection) applicable to WorkRail's daemon AgentLoop. Mode: understanding. Run mode: deep.

## Phase 1 complete
Regime: depth_serial. Sub-questions: 7. Topological order: SQ1 -> (SQ2, SQ3, SQ7), SQ4/SQ5/SQ6 independent. Sources confirmed accessible at https://github.com/codeaashu/claude-code. Key files: QueryEngine.ts, Tool.ts, tools.ts, query/tokenBudget.ts, query/transitions.ts, query/stopHooks.ts, tasks/LocalAgentTask/LocalAgentTask.tsx, coordinator/coordinatorMode.ts.

## Phase 3 complete (pass 1)
- Step 1 (SQ1): Parallel tool execution -- fetched toolOrchestration.ts, StreamingToolExecutor.ts, query.ts. 7 claims. Key: partitionToolCalls batching by isConcurrencySafe, runToolsConcurrently with concurrency cap 10, StreamingToolExecutor with streaming-start-before-model-done.
- Step 2 (SQ4): Context management -- fetched tokenBudget.ts, query.ts compact paths. 7 claims. Key: BudgetTracker value object, 4 compaction strategies, diminishing-returns detection, disk offload for large tool results.
- Step 3 (SQ5): Delivery/commit flow -- fetched coordinatorMode.ts, LocalAgentTask.tsx. 7 claims. Key: coordinator/worker model, workers self-verify+commit, XML task-notification protocol, pendingMessages drain at tool-round boundaries.
- Step 4 (SQ6): Stuck/stall detection -- fetched stopHooks.ts, transitions.ts. 7 claims. Key: no dedicated stuck detector, maxTurns hard limit, token-budget diminishing-returns (delta < 500 for 3+ continuations), exhaustive Terminal/Continue discriminated unions.
- Step 5 (SQ2): Tool safety classification -- fetched Tool.ts, GlobTool.ts, GrepTool.ts, FileReadTool.ts, FileEditTool.ts, FileWriteTool.ts, BashTool.tsx, WebSearchTool.ts, StreamingToolExecutor.ts. 6 claims. Key: isConcurrencySafe+isReadOnly+isDestructive+interruptBehavior four-axis model, BashTool dynamic classification via command analysis, Bash-only sibling abort on error.
- Step 6 (SQ3): Abort/cancellation -- fetched StreamingToolExecutor.ts, query.ts, toolExecution.ts. 7 claims. Key: 3-level AbortController hierarchy, sibling_error does not propagate to parent, getRemainingResults for synthetic tool_results on abort, interruptBehavior cancel vs block asymmetry.
- Step 7 (SQ7): Tool result formatting/errors -- fetched toolResultStorage.ts, toolExecution.ts, Tool.ts. 7 claims. Key: persist-to-disk instead of truncate, per-tool maxResultSizeChars table, empty-output guard, is_error XML wrapping, contextModifier deferred for parallel tools.

## Phase 4 complete (pass 1): 0 verified, 47 single-source, 2 inferred, 1 falsified-pending, 5 corroborated
## Phase 5 complete (pass 1): stop
## Phase 6 complete: ~2100 words (under 2500 budget)
## Phase 7 complete: dissent type = weakest-claim
## Phase 8 complete: RESEARCH COMPLETE -- brief.md emitted
Merged file: claims/merged-pass-1.json. Priors updated: P2/P7/P8/P9/P10/P12 -> corroborated; P11 -> falsified-pending-review (Claude Code NOT more sophisticated -- different approach, no dedicated stuck detector). All claims from single hostname, none qualified for 'verified' status.
