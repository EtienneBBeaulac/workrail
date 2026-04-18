# daemon complete_step tool -- Design Review Findings

## Tradeoff Review

### T1: Two token write paths (onAdvance + onTokenUpdate)
**Assessment:** Acceptable. The two paths are structurally mutually exclusive (`kind: 'ok'` vs `kind: 'blocked'` response branches). Sequential tool execution prevents races. The response kind enum is closed (`ok` | `blocked`). No future third path is anticipated.
**Condition for re-evaluation:** If a third response kind is added that carries a new token.

### T2: Blocked feedback references `complete_step`
**Assessment:** Acceptable. The daemon's tool list will have `complete_step` as the primary tool. Blocked feedback pointing to it is correct.

### T3: `notes` minLength enforced at JSON Schema + runtime
**Finding:** JSON Schema `minLength` is informational to the LLM but NOT enforced by AgentLoop. Runtime check inside `execute()` is required.
**Revision:** Add `if (!params.notes || params.notes.length < 50) throw new Error(...)` inside `execute()`.

---

## Failure Mode Review

| Failure Mode | Covered? | Mitigation |
|---|---|---|
| FM1: Wrong token on blocked retry | Yes | `onTokenUpdate` called with retry token from blocked response |
| FM2: Notes too short not caught | Fixed | Runtime length check in `execute()` |
| FM3: Token in response text | Yes | Response text does not include token |
| FM4: LLM calls `continue_workflow` with hallucinated token | Partial | System prompt marks it deprecated; accepted as transition risk |
| FM5: Wrong intent used | Yes | `intent: 'advance'` hardcoded, not a parameter |

---

## Runner-Up / Simpler Alternative Review

- `TokenRef` object: not worth pulling in -- requires `makeContinueWorkflowTool` signature change which is out of scope
- Simpler variant (inline `setCurrentToken` vs `onTokenUpdate` callback): functionally identical, cosmetic only
- No hybrid opportunity that reduces complexity

**Verdict:** Selected design is the simplest that satisfies all criteria.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Immutability by default | Satisfied -- mutation confined to callbacks |
| YAGNI with discipline | Satisfied -- zero new abstractions |
| Prefer fakes over mocks | Satisfied -- fake injection pattern |
| Validate at boundaries | Satisfied after fix -- runtime check added |
| Make illegal states unrepresentable | Satisfied -- notes required, intent hardcoded |
| Determinism | Acceptable tension -- sequential execution makes mutable state deterministic |

---

## Findings

### Yellow: Two token write paths (manageable)
The `currentContinueToken` closure variable is updated in two places: `onAdvance` (on successful advance) and `onTokenUpdate` (on blocked retry). These are mutually exclusive branches. Risk is low because sequential execution prevents races, but it should be documented with WHY comments.

**Action:** Add WHY comment above each update explaining which response kind it handles.

### Yellow: Runtime notes validation missing
JSON Schema `minLength: 50` is informational only. Without a runtime check, a notes string of 10 chars would pass through to `executeContinueWorkflow`, potentially causing a downstream blocked response. Better to fail fast in the tool.

**Action:** Add runtime check in `execute()` before calling `executeContinueWorkflow`.

---

## Recommended Revisions

1. **Add runtime notes validation**: `if (!params.notes || params.notes.length < 50) throw new Error('complete_step: notes is required and must be at least 50 characters. Include what you did and what you produced.')`

2. **Document two token write paths**: Add WHY comments above each `currentContinueToken` update explaining which execution branch it covers.

3. **Blocked feedback text**: Replace `call continue_workflow` references in blocked feedback with `call complete_step again with corrected notes`.

4. **System prompt update**: Add explicit guidance that `complete_step` is the preferred advancement tool and `continue_workflow` is deprecated in daemon sessions. Keep the `continue_workflow` description updated with `[DEPRECATED in daemon sessions]`.

---

## Residual Concerns

- **FM4 (LLM using deprecated continue_workflow)**: Accepted. During transition, the LLM might call `continue_workflow` with a correctly round-tripped token (from the initial prompt or a previous response). This is functional but defeats the purpose. The system prompt must be strong enough to prevent this.
- **`continueToken` in initial prompt**: The initial prompt currently includes `continueToken: ${startContinueToken}`. With `complete_step`, this is no longer needed since the daemon manages the token. The initial prompt should be updated to remove the token and use `call complete_step when done` instead. This is a UX improvement, not a correctness issue.
