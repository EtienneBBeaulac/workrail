# Analysis Strategy: Dynamic Retry Limits & suggestedFixes Review

## Scope of Analysis
Verify the implementation correctness, architectural integrity, and testing coverage of the new dynamic retry limits and tool-aware `suggestedFix` recommendations.

## Key Questions
1. **Completeness**: Are autonomous runs (daemon) capped at 3 retries and interactive runs (MCP) at 10 retries?
2. **Context Resolution**: Is `isAutonomous` correctly determined from the session's run context and passed seamlessly through to the domain layers?
3. **Aesthetics & UX Accuracy**: Do error suggestions correctly recommend `complete_step` (autonomous) vs `continue_workflow` (interactive)?
4. **Architectural Coupling**: Are the domain boundaries preserved (Zod schemas and reason-model containing zero infrastructure-specific imports)?
5. **Robustness & Edge Cases**: Does the circuit breaker chain count represent consecutive blocked attempts on the *same step*? Is the counter reset properly?
6. **Recovery**: Are clear rehydrate/rewind instructions returned to the user when the interactive limit is hit?

## Reference Files
- [advance.ts](file:///Users/etienneb/git/personal/workrail/src/mcp/handlers/v2-execution/advance.ts)
- [reason-model.ts](file:///Users/etienneb/git/personal/workrail/src/v2/durable-core/domain/reason-model.ts)
- [prompt-renderer.ts](file:///Users/etienneb/git/personal/workrail/src/v2/durable-core/domain/prompt-renderer.ts)
- [blocked-messages.ts](file:///Users/etienneb/git/personal/workrail/src/v2/durable-core/schemas/artifacts/blocked-messages.ts)
- [mcp-attempt-circuit-breaker.lifecycle.test.ts](file:///Users/etienneb/git/personal/workrail/tests/lifecycle/mcp-attempt-circuit-breaker.lifecycle.test.ts)

## Risk Focus Areas
- Chain depth walk logic: verify it stops correctly and does not bleed across successful steps.
- First-pass prompt formatting: verify that `prompt-renderer.ts` properly projects `sessionContext.is_autonomous` and avoids hardcoded CompleteStep guidance on first try.
- Verification gaps in lifecycle tests.
