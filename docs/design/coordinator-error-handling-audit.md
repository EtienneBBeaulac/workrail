# Coordinator Error Handling Audit

**Date:** 2026-04-19
**Scope:** `src/coordinators/` coordinator layer
**Audited files:**
1. `src/coordinators/adaptive-pipeline.ts` - `PipelineOutcome` type and main entry point
2. `src/coordinators/modes/full-pipeline.ts` - FULL pipeline phase failure handling
3. `src/coordinators/modes/implement.ts` - IMPLEMENT mode executor
4. `src/coordinators/modes/implement-shared.ts` - shared review + verdict cycle
5. `src/coordinators/pr-review.ts` - reference coordinator
6. `src/runtime/result.ts` - the `Result<T,E>` type (baseline reference)

**Excluded:** `src/mcp/`, `src/v2/durable-core/`

---

## Executive Summary

The coordinator layer is broadly sound. The "errors are data" principle is followed: no bare `throw` statements exist in any coordinator file, all session spawn failures return `PipelineOutcome { kind: 'escalated' }`, and `Result<T,string>` is used correctly for the `spawnSession` / `mergePR` boundaries. `WorkflowRunResult` is guarded with `assertNever` in `trigger-router.ts`. The `PipelineOutcome` discriminated union is well-formed.

One genuine runtime bug and two design inconsistencies are present. The bug (missing null-guard) is the only finding that can cause incorrect behavior at runtime.

---

## Findings

### Finding F1 - Critical

**Title:** Missing zombie-detection null-guard on `uxHandle` in `implement.ts`

**File:line:** `src/coordinators/modes/implement.ts:144-145`

**Description:**

```typescript
const uxHandle = uxSpawnResult.value;
const uxAwait = await deps.awaitSessions([uxHandle], REVIEW_TIMEOUT_MS);
```

`uxHandle` is passed directly to `deps.awaitSessions` without checking for an empty/null value. Every other session handle in the coordinator layer has an explicit zombie-detection guard before being passed to `awaitSessions`:

- `implement.ts:189-195` (`codingHandle`)
- `full-pipeline.ts:222-228` (`discoveryHandle`)
- `full-pipeline.ts:300-305` (`shapingHandle`)
- `full-pipeline.ts:348-354` (`uxHandle` - the equivalent check in FULL mode, which this file is missing)
- `full-pipeline.ts:428-433` (`codingHandle`)
- `implement-shared.ts:68-74` (`reviewHandle`)
- `implement-shared.ts:148-153` (`fixHandle`)
- `implement-shared.ts:233-243` (`auditHandle`)
- `implement-shared.ts:286-296` (`reReviewHandle`)

**Risk:** If `deps.spawnSession` returns `ok('')` (empty string), an empty handle is passed to `awaitSessions`. Downstream behavior depends on the `awaitSessions` implementation, but at minimum it could return a result for a non-existent session, causing the UX gate to be treated as successfully completed when it was not. The coding session would then spawn without UX review having occurred.

**Recommended fix:**

```typescript
const uxHandle = uxSpawnResult.value;
if (!uxHandle) {
  return {
    kind: 'escalated',
    escalationReason: { phase: 'ux-gate', reason: 'UX design session returned empty handle' },
  };
}
const uxAwait = await deps.awaitSessions([uxHandle], REVIEW_TIMEOUT_MS);
```

This matches the pattern used at `implement.ts:189-195` and `full-pipeline.ts:348-354`.

---

### Finding F2 - Major

**Title:** Non-exhaustive `switch` on `ReviewSeverity` in `implement-shared.ts` - missing `assertNever`

**File:line:** `src/coordinators/modes/implement-shared.ts:110-175`

**Description:**

```typescript
switch (findings.severity) {
  case 'clean':
    return { kind: 'merged', prUrl };

  case 'minor': {
    // ... fix loop ...
  }

  case 'blocking':
  case 'unknown': {
    return runAuditChain(...);
  }
  // no default
}
```

`ReviewSeverity = 'clean' | 'minor' | 'blocking' | 'unknown'` is a 4-variant union. The switch covers all four, but there is no `default: assertNever(findings.severity)`. TypeScript does not produce a compile error for switches missing a `default` branch - it only enforces exhaustiveness when the fallthrough type is narrowed to `never`.

**Risk:** If `ReviewSeverity` is widened with a new variant (e.g. `'critical'`), the `switch` will compile successfully and the new variant will fall through without being routed. Depending on TypeScript's control-flow analysis, this may return `undefined` (typed as `PipelineOutcome`) and corrupt the coordinator's return value silently.

**Note:** The same switch pattern exists in `runFixAgentLoop` in `pr-review.ts` at several points, but `pr-review.ts` uses `PrOutcome` (not `PipelineOutcome`) and the consequences are less severe.

**Recommended fix:**

```typescript
switch (findings.severity) {
  case 'clean':
    ...
  case 'minor': {
    ...
  }
  case 'blocking':
  case 'unknown': {
    return runAuditChain(...);
  }
  default:
    return assertNever(findings.severity);
}
```

Import `assertNever` from `../../runtime/assert-never.js`. The same fix applies to the corresponding switch at `implement-shared.ts:334` (`if (reFindings.severity === 'clean' || reFindings.severity === 'minor')`) - that one uses `if/else if` rather than `switch`, and the `else` arm covers the remaining cases. Consider converting to a `switch` with `assertNever` for consistency.

---

### Finding F3 - Major

**Title:** `process.stderr.write` bypasses injected `deps.stderr` in `pr-review.ts`

**File:line:** `src/coordinators/pr-review.ts:445-449` inside `readVerdictArtifact()`

**Description:**

```typescript
process.stderr.write(
  `[WARN coord:reason=artifact_parse_failed handle=${handlePrefix}] readVerdictArtifact: wr.review_verdict schema validation failed: ${issues}\n`,
);
```

All other log calls in `pr-review.ts` use the injected `deps.stderr()` function or the local `log()` closure. This single call uses the Node.js global `process.stderr.write` directly, bypassing the injected dependency contract.

**Risk:** Test fakes that inject a no-op or recording `stderr` will miss this warning silently. When a schema-invalid verdict artifact is emitted by an agent, the warning will appear in process stderr even in test environments that redirect all deps-based logging.

**Recommended fix:**

`readVerdictArtifact` currently accepts no `deps` parameter. Two options:

**Option A** (preferred - consistent with `full-pipeline.ts:readDiscoveryHandoffArtifact`): Add an optional `stderrFn` parameter:

```typescript
export function readVerdictArtifact(
  artifacts: readonly unknown[],
  sessionHandle?: string,
  stderrFn?: (line: string) => void,
): ReviewFindings | null {
  // ...
  (stderrFn ?? ((s) => process.stderr.write(s + '\n')))(
    `[WARN coord:reason=artifact_parse_failed handle=${handlePrefix}] ...`
  );
}
```

**Option B** (minimal): Accept the hardcoded `process.stderr.write` as intentional for this utility function and document it explicitly. This is the lower-effort option but does not fix the test isolation gap.

---

### Finding F4 - Minor

**Title:** `checkSpawnCutoff()` returns `PipelineOutcome | null` rather than an `Option` type

**File:line:** `src/coordinators/adaptive-pipeline.ts:245-260`

**Description:**

```typescript
export function checkSpawnCutoff(
  coordinatorStartMs: number,
  now: number,
  phase: string,
): PipelineOutcome | null {
  if (now - coordinatorStartMs > COORDINATOR_SPAWN_CUTOFF_MS) {
    return { kind: 'escalated', ... };
  }
  return null;
}
```

`null` is used as a sentinel for "safe to spawn." Callers check `if (cutoffCheck) return cutoffCheck;`. This diverges slightly from the "errors are data" principle (null as absence) but is scoped to one helper with a clear usage pattern.

**Risk:** None at runtime. Callers immediately check the return. The naming (`checkSpawnCutoff`) clearly implies a nullable return. This is a stylistic inconsistency, not a functional issue.

**Recommended fix (optional):** If the project ever adopts an `Option<T>` type, this is a good candidate for `Option<PipelineOutcome>`. As-is, the current implementation is clear and the null is well-understood at each call site.

---

### Finding F5 - Minor

**Title:** `dispatchAdaptivePipeline` returns `{ kind: 'escalated' }` for dedup-skip, which is semantically impure

**File:line:** `src/trigger/trigger-router.ts:1003-1030`

**Description:**

When a duplicate adaptive dispatch is detected within the 30-second dedup window, `dispatchAdaptivePipeline` returns:

```typescript
return {
  kind: 'escalated',
  escalationReason: { phase: 'dispatch', reason: 'duplicate ...' },
};
```

The code comment at line 1003-1007 explicitly acknowledges this: *"WHY 'escalated' as the return kind: PipelineOutcome has no 'skipped' variant."*

**Risk:** None at runtime. The calling path (GitHub queue poller) is fire-and-forget and does not branch on `outcome.kind`. This is acknowledged technical debt.

**Recommended fix (optional):** Add `{ readonly kind: 'skipped'; readonly reason: string }` to `PipelineOutcome` in `adaptive-pipeline.ts`. Update `dispatchAdaptivePipeline` to use it. Update any caller that switches on `outcome.kind` to add a `case 'skipped':` arm (with `assertNever` in the default).

---

## Non-Issues

The following patterns were audited and are **not** problems:

- **No bare `throw` in coordinator files.** Archive failures in `implement.ts` and `full-pipeline.ts` `finally` blocks catch exceptions and log them without re-throwing - correct.
- **`PipelineOutcome.escalationReason.reason` is `string`.** String is appropriate at the coordinator boundary (external-facing). Internal domain types use discriminated unions; coordinator escalation reasons are human-readable strings for operator consumption.
- **`WorkflowRunResult` -> `PipelineOutcome` mapping.** These types operate at different architectural layers and are never mapped to each other. `assertNever` is correctly present in `trigger-router.ts` for `WorkflowRunResult` switches (lines 811-814 and 918-921).
- **`outcome !== 'success'` string comparisons.** These compare against session result outcomes from the daemon layer - the correct approach at a typed interface boundary.
- **`readDiscoveryHandoffArtifact` returning `null`.** The null is not leaked outside the function boundary; the function is a local helper returning an optional domain object.
- **`parseFindingsFromNotes` catching JSON parse errors silently.** The `try/catch` in the JSON block scanner (`pr-review.ts:322-337`) is correct - JSON.parse throws for malformed input and the catch correctly advances to the next block.

---

## Severity Summary

| ID | File | Severity | Title |
|----|------|----------|-------|
| F1 | `src/coordinators/modes/implement.ts:144` | **Critical** | Missing null-guard on `uxHandle` (zombie detection) |
| F2 | `src/coordinators/modes/implement-shared.ts:110` | **Major** | Non-exhaustive `ReviewSeverity` switch - no `assertNever` |
| F3 | `src/coordinators/pr-review.ts:445` | **Major** | `process.stderr.write` bypasses injected `deps.stderr` |
| F4 | `src/coordinators/adaptive-pipeline.ts:248` | Minor | `checkSpawnCutoff` returns `null` as sentinel |
| F5 | `src/trigger/trigger-router.ts:1026` | Minor | `escalated` used for dedup-skip (acknowledged in comments) |
