# daemon complete_step tool -- Design Candidates

## Problem Understanding

### Core Tensions

1. **Simplicity vs. completeness of the blocked-response path**: The naive solution handles the happy path (advance) but misses blocked responses. On a blocked response, `executeContinueWorkflow` returns a `retryContinueToken`. The LLM needs to retry `complete_step` with corrected notes, but what token should the tool inject? It must be the retry token, not the original session token -- so the closure variable MUST be updated to the retry token on blocked responses.

2. **Crash safety vs. simplicity**: The existing `makeContinueWorkflowTool` calls `persistTokens()` inside `execute()` before calling `onAdvance()`. The `complete_step` tool must maintain this same invariant: persist the new token to disk before signaling the advance.

3. **Backward compatibility vs. system prompt clarity**: `continue_workflow` must stay in the tools list (it's used by MCP sessions outside the daemon). But if `complete_step` exists alongside it, the system prompt must clearly tell the daemon agent to prefer `complete_step`.

4. **Token update ownership**: `currentContinueToken` is written by two paths: (a) `onAdvance` after a successful advance, and (b) blocked retry in `makeCompleteStepTool.execute()`. Sequential tool execution (`toolExecution: 'sequential'` in AgentLoop) ensures no race condition, but the two write paths must be documented.

### Likely Seam

The seam is in `runWorkflow()`: the `onAdvance` callback signature `(stepText: string, continueToken: string) => void` already passes the new `continueToken` as the second parameter. `runWorkflow()` currently ignores it (because `continue_workflow` doesn't need it -- the LLM round-trips the token). For `complete_step`, we just need to use it.

### What Makes This Hard

- Two token update paths (advance + blocked retry) must both be correct
- Token must be persisted before `onAdvance` fires (crash safety invariant)
- Blocked response feedback must not include `continueToken` in the text (LLM doesn't need to see it)
- System prompt needs to be updated to prefer `complete_step` without breaking existing `continue_workflow` callers

---

## Philosophy Constraints

Sources: `CLAUDE.md` (workspace root), repo patterns in `src/daemon/workflow-runner.ts`

**Active principles:**
- **Immutability by default**: confine mutation to the minimal API -- `currentContinueToken` updated only via callbacks
- **YAGNI with discipline**: avoid speculative abstractions
- **Prefer fakes over mocks**: test with fake `executeContinueWorkflow` injection
- **Document "why" not "what"**: add WHY comments explaining the daemon token injection
- **Make illegal states unrepresentable**: `notes` required with `minLength: 50` at JSON Schema level

No philosophy conflicts found between stated rules and repo patterns.

---

## Impact Surface

- `src/daemon/workflow-runner.ts`: new factory function + updates to `runWorkflow()`, `getSchemas()`, `BASE_SYSTEM_PROMPT`
- `tests/unit/workflow-runner-complete-step.test.ts`: new test file
- `continue_workflow` tool: unchanged (backward compat)
- Public MCP tools list: unchanged (`complete_step` is daemon-only, not exposed via MCP)
- `V2ContinueWorkflowInputShape` / output schemas: unchanged

---

## Candidates

### Candidate 1: Inline closure variable + two callback paths (RECOMMENDED)

**Summary:** Add `let currentContinueToken = startContinueToken` to `runWorkflow()`; update it in the existing `onAdvance` closure (which already receives `continueToken` as a second param but ignores it); for blocked-retry token updates, add an `onTokenUpdate: (t: string) => void` callback parameter to `makeCompleteStepTool()`; `makeCompleteStepTool()` uses `getCurrentToken: () => string` to inject the token.

**Tensions resolved:**
- Crash safety: identical `persistTokens` path before callbacks
- Blocked retry: `onTokenUpdate` callback updates `currentContinueToken` to retry token
- Backward compat: additive only, both tools in list

**Tensions accepted:**
- Two token-update paths (onAdvance for advance, onTokenUpdate for blocked) could diverge if future developers update one but forget the other

**Boundary solved at:** `runWorkflow()` closure + new factory function alongside existing one

**Why this boundary is the best fit:** The seam already exists -- `onAdvance` receives the new `continueToken` but ignores it. Adding a single `onTokenUpdate` callback for blocked responses follows the same pattern used by `onIssueSummary` in `makeReportIssueTool`.

**Failure mode:** Developer forgets to update `currentContinueToken` on blocked retry, causing second TOKEN_BAD_SIGNATURE on retry.

**Repo-pattern relationship:** Follows exactly -- same closure pattern, same fake injection, same `persistTokens` placement.

**Gains:**
- Zero new abstractions
- Easy to test with same fake injection pattern
- Minimal change surface

**Losses:**
- Two write paths for `currentContinueToken` (minor)

**Scope judgment:** Best-fit

**Philosophy fit:** Honors YAGNI, immutability, fakes over mocks. No conflicts.

---

### Candidate 2: Token ref object `{ get(): string; set(t: string): void }`

**Summary:** Introduce a typed `TokenRef` interface; instantiate once in `runWorkflow()` with `currentContinueToken` as internal state; pass the ref to both `makeCompleteStepTool` and `makeContinueWorkflowTool`; both tools call `ref.set()` on advance and blocked-retry.

**Tensions resolved:**
- Single token update path (only `ref.set()` is called in both tools)

**Tensions accepted:**
- Adds a new abstraction (`TokenRef`) not present elsewhere in the repo
- Requires modifying `makeContinueWorkflowTool` signature (breaks backward compat of the function signature, though not behavior)

**Boundary solved at:** New `TokenRef` interface shared across factory functions

**Why this boundary is the best fit:** Only justified if both tools are converted. The spec says keep `continue_workflow` for backward compat -- converting it is out of scope.

**Failure mode:** Over-engineering; `TokenRef` is unnecessary if `makeContinueWorkflowTool` isn't converted.

**Repo-pattern relationship:** Departs from existing patterns (no mutable ref objects elsewhere).

**Gains:** Single token update path, explicit ownership model

**Losses:** New concept to understand, marginal benefit, violates YAGNI

**Scope judgment:** Too broad -- would require modifying `makeContinueWorkflowTool` signature, which isn't needed

**Philosophy fit:** Honors explicit domain types. Conflicts with YAGNI with discipline.

---

## Comparison and Recommendation

| Criterion | Candidate 1 | Candidate 2 |
|-----------|-------------|-------------|
| Zero new abstractions | Yes | No |
| Single token update path | No (two paths) | Yes |
| Matches repo patterns | Yes | Departs |
| Requires makeContinueWorkflowTool change | No | Yes |
| YAGNI | Passes | Fails |
| Test complexity | Same fake injection | Same |

**Recommendation: Candidate 1.**

The two write paths are manageable because:
1. They are clearly distinct: `onAdvance` fires on successful advance, `onTokenUpdate` fires on blocked retry
2. Both have WHY comments explaining their role
3. `toolExecution: 'sequential'` makes races impossible

Candidate 2 fails the YAGNI test. The single update path benefit only matters if `makeContinueWorkflowTool` is also converted -- which is explicitly out of scope.

---

## Self-Critique

**Strongest counter-argument:** Candidate 2's `TokenRef` would prevent the two-path divergence risk. If a future developer adds a third code path that updates the token (e.g., a hypothetical `rehydrate_step` tool), Candidate 1 requires a third callback while Candidate 2 just needs another `ref.set()` call.

**Narrower option:** Don't add `onTokenUpdate` at all; instead update `currentContinueToken` directly inside `makeCompleteStepTool.execute()` by passing a setter into the factory. This is functionally identical to `onTokenUpdate` -- just named differently.

**Broader option threshold:** `TokenRef` would be justified when a second token-managing tool (e.g., `rehydrate_step`) is being added in the same PR.

**Assumption that would invalidate:** If `toolExecution: 'sequential'` is ever changed to parallel, the two write paths could race. But sequential execution is a fundamental requirement for workflow step ordering and will not change.

---

## Open Questions for the Main Agent

1. Should `complete_step` include `continueToken` in the success response text? (The spec says return `{ status: 'advanced', nextStep: string }` or `{ status: 'complete' }` -- so no token in the response text. This is correct and important.)

2. Should the blocked-response feedback text for `complete_step` say "call complete_step again" instead of "call continue_workflow"? Yes -- the blocked feedback must be updated to reference `complete_step`.

3. The spec says `notes: string` required min 50 chars. Should this be enforced at JSON Schema level (LLM sees validation error) or inside `execute()` (tool throws)? JSON Schema is preferred -- it gives the LLM a clear validation error before the tool even runs.

4. Should `workspacePath` be removed from `complete_step` (since the daemon always knows it)? Yes -- daemon context is always available, no need to pass it through.
