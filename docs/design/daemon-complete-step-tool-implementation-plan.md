# Implementation Plan: daemon complete_step tool

## Problem Statement

The daemon's `continue_workflow` tool requires the LLM to round-trip a `continueToken` (an HMAC-signed opaque token). The LLM frequently mangles this token, causing TOKEN_BAD_SIGNATURE errors that kill sessions. The fix: add a `complete_step` tool where the daemon injects the `continueToken` internally -- the LLM never sees it.

## Acceptance Criteria

1. `makeCompleteStepTool()` function exists in `src/daemon/workflow-runner.ts`, exported alongside `makeContinueWorkflowTool()`
2. `complete_step` accepts: `notes: string` (required, min 50 chars), `artifacts?: unknown[]`, `context?: Record<string, unknown>`
3. The tool injects the current session's `continueToken` internally before calling `executeContinueWorkflow` -- LLM never provides it
4. `continueToken` is managed via a closure variable `currentContinueToken` in `runWorkflow()`, updated on advance and blocked-retry
5. On successful advance: returns `{ status: 'advanced', nextStep: '<step title>' }` text
6. On workflow complete: returns `{ status: 'complete' }` text
7. On blocked: returns human-readable feedback saying 'call complete_step again' (not continue_workflow)
8. Runtime validation: throws if `notes.length < 50`
9. `complete_step` is in the daemon tools list in `runWorkflow()` alongside `continue_workflow`
10. `continue_workflow` description is marked `[DEPRECATED in daemon sessions -- use complete_step]`
11. `BASE_SYSTEM_PROMPT` lists `complete_step` as the primary advancement tool
12. Initial prompt removes `continueToken: ${startContinueToken}` and says 'Call complete_step with your notes when done'
13. Unit tests cover: happy-path advance, workflow complete, blocked response (retryable + non-retryable), notes too short, artifacts pass-through
14. All existing tests pass

## Non-Goals

- No schema changes to `V2ContinueWorkflowInputShape` or public MCP tools
- No new HTTP routes or public API changes
- `complete_step` is daemon-only -- NOT added to the MCP server's public tools list
- No migration of `makeContinueWorkflowTool` to use `TokenRef` pattern
- No removal of `continue_workflow` from the daemon tools list (backward compat)
- No changes to `rehydrate` flow

## Philosophy-Driven Constraints

- **Immutability by default**: `currentContinueToken` is the only mutable shared state; confined to `runWorkflow()` closure
- **Validate at boundaries**: runtime `notes.length` check in `execute()` (JSON Schema is informational only)
- **Prefer fakes over mocks**: tests use fake `executeContinueWorkflow` injection
- **YAGNI**: zero new abstraction types
- **Document "why" not "what"**: WHY comments on all non-obvious decisions

## Invariants

1. `persistTokens(sessionId, newToken, ...)` is always called BEFORE `onAdvance()` fires (crash safety)
2. `currentContinueToken` is updated to the advance token on `kind: 'ok'` responses
3. `currentContinueToken` is updated to the retry token on `kind: 'blocked'` responses
4. `continueToken` never appears in `complete_step` response text
5. `intent: 'advance'` is hardcoded -- LLM cannot pass `rehydrate` via `complete_step`
6. `complete_step` is NOT exposed in the MCP server's public tool registration

## Selected Approach

**Candidate 1: Inline closure variable + two callback paths**

`runWorkflow()` holds `let currentContinueToken = startContinueToken`. The variable is updated:
- In `onAdvance(stepText, continueToken)` -- uses the `continueToken` param (already available, currently ignored)
- Via `onTokenUpdate: (t: string) => void` callback passed to `makeCompleteStepTool()` -- called on blocked retry

`makeCompleteStepTool()` signature:
```typescript
export function makeCompleteStepTool(
  sessionId: string,
  ctx: V2ToolContext,
  getCurrentToken: () => string,
  onAdvance: (nextStepText: string, continueToken: string) => void,
  onComplete: (notes: string | undefined) => void,
  onTokenUpdate: (t: string) => void,
  schemas: Record<string, any>,
  _executeContinueWorkflowFn?: typeof executeContinueWorkflow,
  emitter?: DaemonEventEmitter,
  workrailSessionId?: string | null,
): AgentTool
```

**Runner-up:** Candidate 2 (`TokenRef` object) -- rejected: requires `makeContinueWorkflowTool` signature change (out of scope), violates YAGNI.

## Vertical Slices

### Slice 1: Schema and factory function
**Files:** `src/daemon/workflow-runner.ts`
**Work:**
- Add `CompleteStepParams` JSON Schema to `getSchemas()`:
  ```json
  {
    "type": "object",
    "properties": {
      "notes": { "type": "string", "minLength": 50, "description": "..." },
      "artifacts": { "type": "array", "items": {}, "description": "..." },
      "context": { "type": "object", "additionalProperties": true }
    },
    "required": ["notes"],
    "additionalProperties": false
  }
  ```
- Add `makeCompleteStepTool()` factory function (described above)
- Runtime notes validation inside `execute()`
- Full blocked/advance/complete handling (mirror `makeContinueWorkflowTool` but without token in response text)

**AC:** Function exists, exported, executes correctly with fake injection

### Slice 2: runWorkflow() integration
**Files:** `src/daemon/workflow-runner.ts`
**Work:**
- Add `let currentContinueToken = startContinueToken` after `startContinueToken` is assigned
- Update `onAdvance` to set `currentContinueToken = continueToken` (second param was ignored before)
- Add `complete_step` to the tools list with `makeCompleteStepTool(..., () => currentContinueToken, onAdvance, onComplete, (t) => { currentContinueToken = t; }, ...)`
- Mark `continue_workflow` description as deprecated

**AC:** `runWorkflow()` compiles; `currentContinueToken` is updated on advance

### Slice 3: System prompt + initial prompt updates
**Files:** `src/daemon/workflow-runner.ts`
**Work:**
- Update `BASE_SYSTEM_PROMPT` tools section: add `complete_step` as primary tool, mark `continue_workflow` as deprecated
- Update `initialPrompt` in `runWorkflow()`: remove `continueToken: ${startContinueToken}` from the text; change 'call continue_workflow' to 'call complete_step'

**AC:** Prompt does not contain the continueToken string; 'complete_step' appears as primary tool

### Slice 4: Tests
**Files:** `tests/unit/workflow-runner-complete-step.test.ts`
**Test cases:**
- TC1: notes present, advance returns `{ status: 'advanced', nextStep: '...' }`
- TC2: workflow complete returns `{ status: 'complete' }`
- TC3: blocked retryable -- feedback says 'call complete_step again', `onTokenUpdate` called with retry token
- TC4: blocked non-retryable -- feedback says cannot proceed without resolving
- TC5: notes too short (< 50 chars) -- tool throws
- TC6: notes absent -- tool throws
- TC7: artifacts pass-through -- artifacts forwarded to executeContinueWorkflow
- TC8: no artifacts, no output artifact object constructed (empty array guard)
- TC9: `continueToken` NOT in response text (regression guard)
- TC10: `getCurrentToken()` is called (not a hardcoded token) -- verify via fake that captures input

**AC:** All 10 tests pass; `npm run test:unit` green

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LLM uses deprecated continue_workflow with hallucinated token | Low | Medium | System prompt deprecation notice; transition risk accepted |
| Token not updated on blocked retry | Low | High | Test TC3 catches this |
| `continueToken` in response text | Low | Medium | Test TC9 catches this |
| Initial prompt still contains token string | Low | Medium | Test prompt content in system-prompt test |

## PR Packaging Strategy

Single PR: `feat/daemon-complete-step-tool`

All 4 slices go in one commit per slice (or a single clean commit). No multi-PR needed -- change is additive, no breaking changes.

## Philosophy Alignment

| Slice | Principle | Status |
|---|---|---|
| Slice 1: Schema | Make illegal states unrepresentable | Satisfied -- notes required, intent hardcoded |
| Slice 1: Factory | Validate at boundaries | Satisfied -- runtime check in execute() |
| Slice 1: Factory | Immutability by default | Satisfied -- mutation via callbacks only |
| Slice 2: runWorkflow | Determinism | Acceptable tension -- sequential execution makes mutable state deterministic |
| Slice 3: Prompts | Document "why" | Satisfied -- prompts explain the tool's purpose |
| Slice 4: Tests | Prefer fakes over mocks | Satisfied -- fake injection pattern |
| All slices | YAGNI | Satisfied -- zero new abstractions |

## Unresolved Unknowns

None material. All design decisions are confirmed.

- `unresolvedUnknownCount`: 0
- `planConfidenceBand`: High
