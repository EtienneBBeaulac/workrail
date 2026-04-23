# Coordinator I/O Error Handling -- Design Review Findings

Generated: 2026-04-19

## Tradeoff Review

### Verbosity (8+ `postToOutbox` inline try/catch sites)

- **Verdict:** Acceptable. At 8 sites, YAGNI wins. The `archiveFile` precedent in the same files
  shows inline try/catch is the established pattern.
- **Break condition:** If `postToOutbox` call sites grow to 15+, extract a private helper.
- **Hidden assumption:** `postToOutbox` call count stays roughly constant in the near term.

### `deps.stderr()` vs. `process.stderr.write()` in catch blocks

- **Verdict:** Use `deps.stderr()` to match the existing `archiveFile` pattern in `implement.ts`
  and `full-pipeline.ts`. The task spec example uses `process.stderr.write()` but the actual repo
  uses `deps.stderr()` for the identical use case. `deps.stderr()` is more consistent and testable.
- **Break condition:** None. `deps.stderr()` is strictly better here.

### `pollForPR` in `full-pipeline.ts` not in task description but included

- **Verdict:** Include it. It's the same unsafe call pattern, same dep, same risk. Excluding it
  would leave the fix incomplete.
- **Hidden assumption:** Both `pollForPR` call sites use the same real implementation -- confirmed.

---

## Failure Mode Review

| Mode | Handled? | Risk | Notes |
|------|----------|------|-------|
| Missing a call site | Mitigated | Medium | Grep check after implementation |
| `postToOutbox` throw during escalation sequence | Yes | Low | `return` is on next line after try/catch |
| `getAgentResult` throw with non-Error | Yes | Low | `e instanceof Error ? e.message : String(e)` |
| `pollForPR` throw leaving `prUrl` uninitialized | Yes (with care) | Medium | Must use `let prUrl; try {...} catch -> return escalated` |
| UX gate empty `uxHandle` zombie | Yes (after fix) | Low | Same 4-line guard as 9 other handles |

**Highest-risk failure mode:** `pollForPR` catch block structure. If written incorrectly (catch
logs but falls through), `prUrl` would be undefined and the subsequent `if (!prUrl)` check would
catch it -- but the `prUrl` variable would need to be declared with `let` outside the try block.
The fix requires care in the variable declaration pattern.

---

## Runner-Up / Simpler Alternative Review

**Runner-up:** Private `safePostToOutbox` helper.
- **Strength worth borrowing:** Standardized log message format across all `postToOutbox` sites.
- **Adopted:** Standardize the log message format inline (consistent `[WARN coordinator] postToOutbox failed: ...` prefix across all sites).
- **Rejected:** Full helper extraction. YAGNI at 8 sites. No precedent in repo.

**Simpler alternative:** Skip `postToOutbox` wrapping (only fix `getAgentResult` and `pollForPR`).
- **Rejected:** `postToOutbox` crashes at critical escalation points. Medium severity is still a
  production crash path that must be fixed.

---

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Errors are data | Fully satisfied -- throws become `PipelineOutcome` values |
| Escalation-first invariant | Enforced -- no throw-exit paths remain after fix |
| Make illegal states unrepresentable | Satisfied -- coordinator now always returns a value |
| DI for boundaries | Satisfied -- no new imports, changes are in mode files only |
| Compose with small functions | Under acceptable tension -- functions grow slightly |
| Document why not what | Needs 1-line comment per postToOutbox catch explaining non-fatal rationale |
| YAGNI with discipline | Satisfied -- no speculative helper |

---

## Findings

### Yellow: `pollForPR` variable declaration pattern

The `let prUrl` declaration must be placed BEFORE the try/catch block (not inside it) so that
the catch block can `return` an escalated outcome and the variable remains in scope after. If
the variable is declared inside `try`, TypeScript will not compile. This is a known TypeScript
pattern but worth flagging explicitly.

**Fix:** Use the explicit two-step pattern from the task spec:
```typescript
let prUrl: string | null;
try {
  prUrl = await deps.pollForPR(branchPattern, PR_POLL_TIMEOUT_MS);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  deps.stderr(`[WARN coordinator] pollForPR threw: ${msg}`);
  return { kind: 'escalated', escalationReason: { phase: 'pr-detection', reason: `pollForPR threw: ${msg}` } };
}
if (!prUrl) { ... }
```

### Yellow: `deps.stderr()` vs. `process.stderr.write()`

Use `deps.stderr()` in catch blocks. The task spec example uses `process.stderr.write()` but the
repo's `archiveFile` catch blocks use `deps.stderr()`. Consistency with repo pattern wins.

---

## Recommended Revisions

1. Use `deps.stderr()` (not `process.stderr.write()`) in all catch blocks.
2. Use `let prUrl: string | null` declared before the try block for `pollForPR` calls.
3. Add a one-line comment in each `postToOutbox` catch explaining non-fatal policy:
   `// postToOutbox write failure is non-fatal -- escalation still returns below`
4. Include `pollForPR` in `full-pipeline.ts` even though task description only names `implement.ts`.
5. Include UX gate zombie detection fix in `implement.ts` line 144.

---

## Residual Concerns

- **No tests for throw injection:** This PR fixes the runtime behavior but adds no tests for
  the throw paths. Tests are a planned follow-up (per the audit doc). The absence of tests means
  a regression in this fix would not be caught by CI. Low concern for this PR -- the fix is
  mechanical and the pattern is simple.
- **`adaptive-pipeline.ts` line 362 `postToOutbox` is unguarded** but is explicitly out of scope
  for this task. Should be addressed in a follow-up.
