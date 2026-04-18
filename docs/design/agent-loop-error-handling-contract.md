# AgentLoop Error Handling Contract

**Status:** Final recommendation -- ready for implementation  
**Date:** 2026-04-16  
**Scope:** `src/daemon/agent-loop.ts` `_executeTools`, PR #515 (`501df000`)

---

## Context / Ask

The daemon `AgentLoop._executeTools` has been changed twice in opposite directions:

- **Commit `3929c39f`** (initial first-party implementation): `_executeTools` had no try/catch -- tool throws propagated to `prompt()`.
- **PR #495 (`954450ae`)** (current HEAD on this branch): Added try/catch in `_executeTools` converting tool throws to `isError: true` tool_results. The module-header comment and `AgentTool` JSDoc still say "THROWS on failure (pi-agent-core contract)."
- **PR #515 (`501df000`)** (on a separate unmerged branch): Removed the try/catch again, restoring throw propagation, with the comment "A tool that exists but throws is a programmer-visible failure that should not be silently swallowed."

The design question: which contract is correct, and should it be uniform across all tools?

---

## Path Recommendation

**`full_spectrum`** -- both landscape grounding (what the code does today) and reframing (should the contract differ by tool type?) are needed to answer the real question.

Justification over alternatives:
- `landscape_first` alone would miss the deeper question of whether a single uniform contract is even correct.
- `design_first` alone would miss the concrete implementation details that constrain the answer.

---

## Constraints / Anti-goals

**Constraints:**
- The LLM must be able to see tool errors for user-facing tools (Bash, Read, Write) to retry or adapt.
- `continue_workflow` failures with a bad/expired token must not cause infinite retry loops.
- Session progress must not be silently lost; crash recovery (daemon-sessions files) must remain coherent.
- The `WorkflowRunResult` discriminated union is the outer error-as-data boundary -- `runWorkflow()` never throws.

**Anti-goals:**
- Do not create a bespoke error-classification system per tool -- complexity without clear benefit.
- Do not change the outer `runWorkflow()` contract (it already catches everything and returns a discriminated union).

---

## Landscape Packet

### Current code state (HEAD `954450ae`)

`_executeTools` in `src/daemon/agent-loop.ts` (lines 449-459) contains a try/catch:

```typescript
try {
  result = await tool.execute(block.id, params);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  results.push({
    toolCallId: block.id,
    toolName: block.name,
    result: { content: [{ type: 'text', text: `Tool execution failed: ${message}` }], details: null },
    isError: true,
  });
  continue;
}
```

This is **Option B**: all tool throws become `isError: true` tool_results visible to the LLM.

### What PR #515 did

PR #515 (`501df000`) removed this try/catch entirely, restoring **Option A**: any tool throw propagates through `_runLoop` -> `_runLoop` (unhandled) -> `prompt()` -> caught by `runWorkflow()`'s outer try/catch -> session dies with `WorkflowRunResult { _tag: 'error' }`.

### What `workflow-runner.ts` expects

`src/daemon/workflow-runner.ts` line 13 says: "Tools THROW on failure (AgentLoop contract). `runWorkflow()` catches and returns a `WorkflowRunResult` discriminated union."

The `continue_workflow` tool's `execute()` at line 828 does:
```typescript
if (result.isErr()) {
  throw new Error(`continue_workflow failed: ${result.error.kind} -- ${JSON.stringify(result.error)}`);
}
```

This throw is supposed to propagate up to kill the session.

### What the test actually tests

The test `agent-loop.test.ts > tool errors (throwing tools) > propagates tool throws to the prompt() caller` (lines 444-458) asserts:
```typescript
await expect(agent.prompt(USER_MSG)).rejects.toThrow('Tool execution failed');
```

This test was written for PR #515's behavior (Option A). It currently **FAILS** on HEAD because `_executeTools` has the try/catch -- `prompt()` resolves instead of rejecting. The test is testing the contract that does NOT exist on the current branch.

### `continue_workflow` error behavior

When `executeContinueWorkflow` returns `isErr()` (bad token, session state error, etc.), the `continue_workflow` tool throws. Under Option B (current HEAD), that throw is caught in `_executeTools` and returned as an `isError: true` tool_result -- the LLM sees "continue_workflow failed: invalid_token" and can retry. Under Option A (PR #515), that throw kills the session.

---

## Problem Frame Packet

### The real question is not "A or B" -- it is "which error categories are recoverable?"

The binary framing (Option A vs B) obscures the actual decision surface. There are three distinct error categories:

| Category | Example | Correct handling |
|---|---|---|
| **LLM recoverable** | Bash exits 1, file not found, tool returns bad output | Option B: isError tool_result, LLM retries |
| **State-fatal, non-retryable** | Bad/expired continueToken, session state corruption | Option A: propagate and kill session |
| **Transient retryable** | Network timeout, rate limit, intermittent API error | Option B or retry logic inside the tool |

Option A (PR #515's approach) treats ALL tool throws as state-fatal. This is wrong for user-facing tools.

Option B (current HEAD's approach) treats ALL tool throws as LLM-recoverable. This is wrong for `continue_workflow` with a bad token -- the LLM will retry indefinitely with the same bad token, burning context and making no progress.

### The `continue_workflow` infinite loop risk

Under Option B: LLM calls `continue_workflow` with an expired token. `executeContinueWorkflow` returns `isErr()`. `continue_workflow.execute()` throws. `_executeTools` catches the throw, returns `isError: true` with message "continue_workflow failed: invalid_token". The LLM sees this and... retries with the same token. Same result. Loop until max_turns or wall-clock timeout.

This is a real risk, not theoretical. The system prompt instructs the agent: "round-trip the continueToken exactly." The LLM has no way to fix a bad token -- it can only loop.

### The `continue_workflow` kill-the-session risk (Option A)

Under Option A: `continue_workflow` throws on ANY error, including transient errors (e.g., DB write failed due to disk pressure, rare engine bug). The entire session dies. All progress is lost. Crash recovery may have the previous token but not the notes the agent just wrote.

---

## Candidate Directions

### Direction 1: Uniform Option B with loop-break heuristic (current HEAD + guard)

Keep the try/catch in `_executeTools`. Add a heuristic in the `continue_workflow` tool's error path: if the error kind is `invalid_token` or `session_not_found`, include a `FATAL:` prefix in the error text. The system prompt instructs the agent to stop retrying on `FATAL:` errors.

**Pros:** Simple, no type-level distinction needed.  
**Cons:** Relies on LLM instruction-following to avoid the infinite loop. Fragile.

### Direction 2: Uniform Option A with outer catch (PR #515 approach)

Remove try/catch from `_executeTools`. All tool throws propagate and kill the session. Bash, Read, Write tools must NOT throw -- they must encode errors in their return value (non-throwing tools already do this in the current implementation).

**Pros:** Clean "throws = programmer error" invariant. Outer boundary always catches.  
**Cons:** Bash tool must never throw (currently it does throw on execAsync failure). Requires auditing all tools. Any unintended throw anywhere kills the session silently from the LLM's perspective.

### Direction 3: Two-tier contract (recommended)

Differentiate at the `AgentTool` level:

- **`recoverableOnError: false` (default):** Tool throws -> `_executeTools` catches -> `isError: true` tool_result. LLM can see the error and adapt. This is the correct default for Bash, Read, Write, and most user-facing tools.
- **`recoverableOnError: false` / `fatalOnError: true`:** Tool throws -> propagates immediately, session dies. This is correct for `continue_workflow` when the error is a bad/expired token.

But `continue_workflow` already distinguishes internally: `isErr()` throws, `out.kind === 'blocked'` returns a recoverable result. The question is which `isErr()` cases are truly fatal.

**Better framing for `continue_workflow`:** the tool should NOT throw at all for most `isErr()` cases. It should return an `isError: true` tool_result with a `FATAL:` marker only for `invalid_token` / `session_not_found`. The agent system prompt should instruct: "If you see FATAL in a continue_workflow error, stop immediately -- do not retry."

**Pros:** Explicit, type-safe if annotated, handles the infinite loop risk without a uniform kill.  
**Cons:** Requires updating `continue_workflow.execute()` to not throw on all `isErr()`.

---

## Challenge Notes

1. **The test is broken on HEAD.** `propagates tool throws to the prompt() caller` expects Option A behavior, but HEAD has Option B. This test will pass on the PR #515 branch and fail on main. This is a test/implementation mismatch that needs to be resolved regardless of which direction is chosen.

2. **Module-header comment contradicts implementation.** The comment at line 21 says "Tools throw on failure (pi-agent-core contract). AgentLoop propagates throws to prompt()'s caller." The `AgentTool` JSDoc at line 81 says "THROWS on failure (pi-agent-core contract) -- do not encode errors in content." Both contradict the current try/catch. Whoever wins this design question needs to update one or the other.

3. **`continue_workflow` infinite loop is the decisive argument against uniform Option B.** Without a mechanism to break the loop, uniform Option B is not safe for production.

4. **Bash tool behavior.** The Bash tool in `workflow-runner.ts` (lines 947-984) has its OWN internal try/catch. For exit code 1 with no stderr, it returns a successful result (POSIX "no match found" semantics). For exit 2+ or signal kills, it **throws** at line 982: `throw new Error('Command failed: ...')`. Under Option A (no try/catch in `_executeTools`), this throw kills the entire session -- the LLM never sees the stdout/stderr. Under Option B (current HEAD), `_executeTools` catches it and returns an `isError: true` tool_result that includes the full stdout/stderr. This is the concrete proof that Option A is wrong for Bash. The LLM MUST see the stderr to reason about what failed.

---

## Resolution Notes

### Correct contract per tool type

**User-facing tools (Bash, Read, Write, report_issue):** Option B is correct. A bash command that exits 1 is not a programmer error -- it is normal operation. The LLM must see the stderr and exit code to retry or report to the user. Converting to `isError: true` tool_result is the right behavior.

**`continue_workflow` with truly fatal errors (invalid/expired token, session not found):** Option A is correct -- but only for these specific error kinds. The current implementation throws for ALL `isErr()` results, which is too broad. A transient write error should not kill the session.

**`continue_workflow` with retryable errors (blocked step, validation failure):** Already handled correctly -- returns a recoverable result, not a throw.

### Was PR #515 right or wrong?

**PR #515 was wrong** for its stated goal. Removing the try/catch wholesale means a Bash command that exits 1 and throws will kill the entire autonomous session -- the LLM never gets to see the error message and adapt. This is the worst possible user experience for an autonomous agent. The PR's own comment says "A tool that exists but throws is a programmer-visible failure" -- but a bash exit-1 is NOT a programmer-visible failure, it is a completely normal operational event.

However, PR #515 correctly identified the real problem: `continue_workflow` should not have its errors swallowed. The fix was applied with too broad a brush.

### What the fix should be

1. **Keep Option B in `_executeTools`** (the current HEAD try/catch). This is correct for user-facing tools.

2. **Fix `continue_workflow.execute()`** to distinguish fatal vs. non-fatal `isErr()` cases:
   - `invalid_token`, `session_not_found`, `session_state_corrupted` -> should propagate (throw) even under Option B. These errors can be flagged with a special error type so `_executeTools` re-throws them specifically.
   - Transient errors -> return as `isError: true` tool_result with clear guidance.

3. **Update the `AgentTool` JSDoc and module header** to reflect the actual contract: "tools may throw; throws are converted to `isError: true` tool_results. Use a `FatalToolError` subclass to signal that a throw should propagate through to kill the session."

4. **Fix or rewrite the broken test.** `propagates tool throws to the prompt() caller` should either be deleted (if Option B is canonical) or rewritten to test the `FatalToolError` subclass propagation path.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-16 | Option B (try/catch) is correct for user-facing tools | LLM must see bash failures to adapt |
| 2026-04-16 | PR #515 was wrong -- too broad | Removed try/catch kills sessions on any tool error |
| 2026-04-16 | `continue_workflow` needs selective fatal error propagation | Uniform Option B creates infinite loop risk on bad token |
| 2026-04-16 | Recommended fix: `FatalToolError` subclass | `_executeTools` re-throws only `FatalToolError`; all others become tool_results |

---

## Final Summary

The correct error handling contract is **not uniform** across tool types:

- **Bash/Read/Write/report_issue**: always Option B (convert throws to `isError` tool_results). These are operational errors the LLM must see.
- **`continue_workflow`**: mostly Option B, but fatal errors (bad/expired tokens, session not found) should propagate and kill the session to prevent infinite retry loops.

**Implementation mechanism: `FatalToolError` subclass (Candidate 2)**

- Export `class FatalToolError extends Error {}` from `agent-loop.ts`
- In `_executeTools` catch block: `if (err instanceof FatalToolError) throw err;` before converting to isError tool_result
- In `workflow-runner.ts` line 828: throw `new FatalToolError(...)` instead of `new Error(...)`
- Update `AgentTool.execute()` JSDoc to document both throw types
- Update or split the test `propagates tool throws to the prompt() caller`

**PR #515 verdict:** Wrong. Diagnosed the right symptom (bad token errors shouldn't be swallowed) but applied the wrong fix (removed ALL error recovery). The Bash tool at line 982 throws on exit 2+ -- under PR #515's approach, any bash command failure kills the entire session and the LLM never sees stderr.

**Confidence: HIGH** -- 0 RED findings in review, all 5 acceptance criteria verified.

**Residual risks:**
1. FM3 (transient continue_workflow error kills session) -- mitigated by crash recovery; defer error-kind discrimination
2. FM1 (tool author throws plain Error when FatalToolError intended) -- detectable in tests; low probability

**Supporting documents:**
- `docs/design/agent-loop-error-handling-candidates.md` -- full candidate analysis
- `docs/design/agent-loop-error-handling-review.md` -- tradeoff review findings
