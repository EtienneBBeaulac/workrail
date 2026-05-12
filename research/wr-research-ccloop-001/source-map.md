# Source Map -- wr-research-ccloop-001

## Sources (deep mode -- max 8)

### S1: src/QueryEngine.ts (PRIMARY)
**URL:** https://github.com/codeaashu/claude-code/blob/main/src/QueryEngine.ts
**Rationale:** This is the core agent loop file -- handles the main LLM query, tool call processing, parallel vs sequential tool execution logic, abort handling, and context management. Direct answer to questions 1-4, 6.

### S2: src/query/transitions.ts (PRIMARY)
**URL:** https://github.com/codeaashu/claude-code/blob/main/src/query/transitions.ts
**Rationale:** State machine transitions for query processing -- reveals how the agent loop advances through states, including stuck detection and abort conditions.

### S3: src/Tool.ts (PRIMARY)
**URL:** https://github.com/codeaashu/claude-code/blob/main/src/Tool.ts
**Rationale:** Base Tool type definition -- contains the safety classification fields (isParallelizable, requiresUserApproval, etc.) that govern parallel execution safety model. Direct answer to question 1-2.

### S4: src/tools.ts (PRIMARY)
**URL:** https://github.com/codeaashu/claude-code/blob/main/src/tools.ts
**Rationale:** All tool registrations with their safety metadata -- shows which tools Claude Code marks safe for parallelism and which must be sequential. Direct answer to question 2.

### S5: src/query/tokenBudget.ts (SECONDARY)
**URL:** https://github.com/codeaashu/claude-code/blob/main/src/query/tokenBudget.ts
**Rationale:** Token budget and context compaction logic -- directly answers question 4 about context window pressure management.

### S6: src/tasks/LocalAgentTask/LocalAgentTask.tsx (SECONDARY)
**URL:** https://github.com/codeaashu/claude-code/blob/main/src/tasks/LocalAgentTask/LocalAgentTask.tsx
**Rationale:** Local agent task implementation -- contains the subagent/coordinator delegation model and potentially the delivery/commit flow. Answers question 5.

### S7: src/query/stopHooks.ts (SECONDARY)
**URL:** https://github.com/codeaashu/claude-code/blob/main/src/query/stopHooks.ts
**Rationale:** Stop condition hooks -- reveals what signals Claude Code uses to determine a session is complete or stuck. Augments question 6.

### S8: src/coordinator/coordinatorMode.ts (SECONDARY)
**URL:** https://github.com/codeaashu/claude-code/blob/main/src/coordinator/coordinatorMode.ts
**Rationale:** Coordinator mode implementation -- relevant to delivery/commit flow for coordinator-spawned sessions (maps to WorkRail's B1+B6 gap). Answers question 5.
