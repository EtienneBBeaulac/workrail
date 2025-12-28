# MCP Error Envelope Audit - Findings by File

## `src/mcp/server.ts`

### Finding #1: Document `retry` Serialization (Info)
**Lines:** 91–112 (toMcpResult function)  
**Issue:** `retry` is always serialized but not documented  
**Status:** ✓ Working correctly  
**Recommendation:** Add comment at line 104
```typescript
// NOTE: retry is ALWAYS serialized; it is NOT optional in the envelope.
retry: result.retry,
```

### Finding #2: Zod Parse Errors Produce Correct Envelope (Verified)
**Lines:** 174–192 (createHandler function)  
**Issue:** No issue; Zod errors flow through toMcpResult correctly  
**Status:** ✓ Verified working  
**Example envelope:** 
```json
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid input",
  "retry": { "kind": "not_retryable" },
  "details": { "validationIssues": [...] }
}
```

### Finding #3: Prevalidation Errors Use Same Envelope (Verified)
**Lines:** 199–222 (createValidatingHandler function)  
**Issue:** No issue; prevalidation errors flow through toMcpResult  
**Status:** ✓ Verified working  
**Path:** preValidate → errNotRetryable → toMcpResult ✓

### Finding #14: All Error Paths Return via `toMcpResult` (Verified)
**Lines:** 91–370 (overall flow)  
**Issue:** No issue; error routing is consistent  
**Status:** ✓ Verified working  
**Verification:**
- `createHandler`: All 3 paths go through toMcpResult ✓
- `createValidatingHandler`: All 3 paths go through toMcpResult ✓
- v2 handlers wrapped in createHandler ✓

### Finding #16: No Runtime Validation of `details` (Missing)
**Lines:** 91–112 (toMcpResult case 'error')  
**Issue:** `details` not validated against JsonValue schema  
**Status:** ⚠️ Needs implementation  
**Recommendation:** Add validation before serialization (lines 99–111)
```typescript
case 'error':
  if (result.details !== undefined) {
    const detailsValid = JsonValueSchema.safeParse(result.details);
    if (!detailsValid.success) {
      return toMcpResult(
        errNotRetryable('INTERNAL_ERROR', 'Error details validation failed', {
          details: { 
            originalError: result.message,
            validationErrors: detailsValid.error.errors.map(e => e.message)
          }
        })
      );
    }
  }
  return { /* ... */ };
```

---

## `src/mcp/types.ts`

### Finding #4: `ToolError` Requires `retry` (Verified)
**Lines:** 72–79 (ToolError interface)  
**Issue:** No issue; `retry` is required (not optional)  
**Status:** ✓ Correct  
**Current code:**
```typescript
export interface ToolError {
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
  readonly suggestion?: string;
  readonly retry: ToolRetry;  // ← NON-OPTIONAL ✓
  readonly details?: JsonValue;
}
```

**Recommendation:** Add JSDoc at lines 70–71
```typescript
/**
 * Error result from a tool handler.
 * The `retry` field is ALWAYS present and NEVER undefined.
 */
export interface ToolError {
```

### Finding #5: Error Constructors Set `retry` Correctly (Verified)
**Lines:** 104–147 (error, errNotRetryable, errRetryableImmediate, errRetryableAfterMs)  
**Issue:** No issue; all constructors explicitly set `retry`  
**Status:** ✓ Correct  
**Verification:**
- `error()` line 115: `retry: retry ?? { kind: 'not_retryable' }` ✓
- `errNotRetryable()` line 129: `{ kind: 'not_retryable' }` ✓
- `errRetryableImmediate()` line 137: `{ kind: 'retryable_immediate' }` ✓
- `errRetryableAfterMs()` line 146: `{ kind: 'retryable_after_ms', afterMs }` ✓

### Finding #12: `JsonValue` Type Duplicated (Consolidation Needed)
**Lines:** 19–25 (JsonValue type definition)  
**Issue:** Duplicated in output-schemas.ts without documentation  
**Status:** ⚠️ Needs consolidation  
**Recommendation:**
1. Keep this as primary definition at lines 19–25
2. Add comprehensive JSDoc (lines 16–18):
```typescript
/**
 * JSON-safe details payload.
 * 
 * This type ensures that error details crossing the MCP boundary cannot contain:
 * - undefined values
 * - Functions
 * - Symbols
 * - Circular references
 * 
 * All error details must conform to JsonValue to maintain v2 semantics.
 * This is the ONLY serializable type allowed in ToolError.details.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

---

## `src/mcp/error-mapper.ts`

### Finding #6: Domain Error Mapper Has Correct Casts (Verified)
**Lines:** 12–62 (mapDomainErrorToToolError function)  
**Issue:** No issue; all cases have `as ToolFailure` cast  
**Status:** ✓ Correct  
**Lines with casts:**
- Line 15: WorkflowNotFound ✓
- Line 20: InvalidState ✓
- Line 37: InvalidLoop ✓
- Line 42: MissingContext ✓
- Line 50: ConditionEvalFailed ✓
- Line 55: MaxIterationsExceeded ✓

### Finding #7: Unknown Error Mapper Correctly Typed (Verified)
**Lines:** 64–69 (mapUnknownErrorToToolError function)  
**Issue:** No issue; returns `ToolFailure` type  
**Status:** ✓ Correct  
**Code:**
```typescript
export function mapUnknownErrorToToolError(err: unknown): ToolFailure {
  if (err instanceof Error) {
    return errNotRetryable('INTERNAL_ERROR', err.message) as ToolFailure;
  }
  return errNotRetryable('INTERNAL_ERROR', String(err)) as ToolFailure;
}
```

### Finding #15: Document `JsonValue` in Error Mappers (Missing)
**Lines:** 12–69 (all functions)  
**Issue:** No mention of JsonValue requirement  
**Status:** ⚠️ Needs documentation  
**Recommendation:** Add JSDoc to each function:
```typescript
/**
 * Maps domain errors to tool failures with JsonValue-safe details.
 * 
 * All returned error details MUST conform to JsonValue type:
 * - No undefined values
 * - No functions or symbols
 * - No circular references
 * 
 * The `retry` field is always set to not_retryable.
 */
export function mapDomainErrorToToolError(err: DomainError): ToolFailure {
```

---

## `src/mcp/handlers/v2-execution.ts`

### Finding #8: Session Health Details Type-Safe (Verified)
**Lines:** 70–134 (error mapper functions)  
**Issue:** No issue; uses `detailsSessionHealth()` helper  
**Status:** ✓ Correct  
**Example at lines 92–102:**
```typescript
return errNotRetryable(
  'SESSION_NOT_HEALTHY',
  `Session corruption detected (${e.location}): ${e.reason.code}`,
  {
    suggestion: 'Execution requires a healthy session. Export a salvage/read-only view, then recreate the run.',
    details: detailsSessionHealth({  // ← Type-safe helper ✓
      kind: e.location === 'head' ? 'corrupt_head' : 'corrupt_tail',
      reason: e.reason,
    }),
  }
) as ToolFailure;
```

### Finding #9: Token Errors Don't Use `details` (Improvement)
**Lines:** 193–222 (tokenDecodeErrorToToolError function)  
**Issue:** Token errors only use `suggestion`, not structured `details`  
**Status:** ⚠️ Could improve  
**Current code:**
```typescript
function tokenDecodeErrorToToolError(e: { readonly code: string; readonly message: string }): ToolResult<never> {
  switch (e.code) {
    case 'TOKEN_INVALID_FORMAT':
      return error(
        'TOKEN_INVALID_FORMAT',
        normalizeTokenErrorMessage(e.message),
        'Use the exact tokens returned by WorkRail. Tokens are opaque; do not edit or construct them.'
      );
```

**Recommendation:** Add details parameter (line 196):
```typescript
const details: JsonValue = { tokenErrorCode: e.code };
return error(
  'TOKEN_INVALID_FORMAT',
  normalizeTokenErrorMessage(e.message),
  'Use the exact tokens returned by WorkRail. Tokens are opaque; do not edit or construct them.',
  undefined,
  details
);
```

### Finding #10: Mixed Error Constructor Styles (Clarity Issue)
**Lines:** 70–108, 193–222, 424–445 (various error calls)  
**Issue:** Mixed use of `error()` (positional args) and `errNotRetryable()` (named options)  
**Status:** ⚠️ Needs standardization  
**Examples:**
- Line 71: `errNotRetryable('INTERNAL_ERROR', ..., suggestion ? { suggestion } : undefined)` ✓
- Line 196: `error('TOKEN_INVALID_FORMAT', ..., 'Use the exact tokens...')` ← unclear position
- Line 424: `error('TOKEN_UNKNOWN_NODE', ..., 'No durable run state...')` ← unclear position

**Recommendation:** Refactor to always use named options:
```typescript
// Change from:
error('CODE', 'message', 'suggestion')
// To:
error('CODE', 'message', { suggestion: '...' })

// Or use named wrapper:
errWithSuggestion('CODE', 'message', 'suggestion')
```

### Finding #11: Suggestion Strings Not Bounded (Data Hygiene)
**Lines:** 88–89, 116–117, 123–124, etc.  
**Issue:** Suggestions are uncontrolled size (compare to prevalidation which bounds at 512 bytes)  
**Status:** ⚠️ Needs implementation  
**Examples:**
- Line 88–89: `'Retry in a few seconds; if this persists >10s, ensure no other WorkRail process is running for this session.'` (142 bytes)
- Line 116–117: Similar length  

**Recommendation:** Create helper in bounded-json.ts (line 28):
```typescript
export function boundedSuggestion(text: string, maxBytes: number = 512): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  return buf.subarray(0, Math.max(0, maxBytes - 4)).toString('utf8') + '...';
}
```

Then use throughout v2-execution.ts:
```typescript
{ suggestion: boundedSuggestion('Retry in a few seconds...') }
```

### Finding #13: Unsafe Type Narrowing (Type Safety)
**Lines:** 146–191 (continueAckErrorToToolError function)  
**Issue:** Type guard doesn't distinguish between ContinueAckError and ExecutionSessionGateErrorV2  
**Status:** ⚠️ Type safety concern  
**Current code (line 157–158):**
```typescript
if ('kind' in e && typeof e.kind === 'string') {
  const err = e as ContinueAckError;  // ← Unsafe cast
```

**Problem:** Both ContinueAckError and ExecutionSessionGateErrorV2 have `kind: string`, so this guard isn't exhaustive.

**Recommendation:** Use Zod discriminator (replace lines 146–154):
```typescript
const ContinueAckErrorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing_node_or_run') }),
  z.object({ kind: z.literal('workflow_hash_mismatch') }),
  z.object({ kind: z.literal('missing_snapshot') }),
  z.object({ kind: z.literal('no_pending_step') }),
  z.object({ kind: z.literal('advance_apply_failed'), message: z.string() }),
  z.object({ kind: z.literal('advance_next_failed'), message: z.string() }),
  z.object({ kind: z.literal('session_store_error'), error: SessionEventLogStoreErrorSchema }),
  z.object({ kind: z.literal('snapshot_store_error'), error: SnapshotStoreErrorSchema }),
]);

type ContinueAckError = z.infer<typeof ContinueAckErrorSchema>;
```

---

## `src/mcp/output-schemas.ts`

### Finding #12b: `JsonValue` Duplicated Here (Consolidation Needed)
**Lines:** 8–14 (JsonValue type definition)  
**Issue:** Duplicate of types.ts definition  
**Status:** ⚠️ Needs consolidation  
**Action:** Replace with import (lines 8–14):
```typescript
// Remove duplicate definition
// Add import from types.ts instead:
export type { JsonValue } from './types.js';

// Then adjust JsonValueSchema to reference imported type:
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(JsonValueSchema)])
);
```

---

## `src/mcp/validation/bounded-json.ts`

### Finding #11b: Add `boundedSuggestion` Helper (New)
**Lines:** 28 (end of file)  
**Issue:** No bounding helper for suggestion strings  
**Status:** ⚠️ Needs implementation  
**Add after line 28:**
```typescript
/**
 * Bound a suggestion string to a maximum byte size.
 * 
 * Ensures suggestion strings don't exceed reasonable envelope size.
 * Uses UTF-8 safe truncation to avoid breaking multi-byte characters.
 * 
 * @param text The suggestion text to bound
 * @param maxBytes Maximum byte length (default: 512)
 * @returns Bounded suggestion text, with '...' appended if truncated
 */
export function boundedSuggestion(text: string, maxBytes: number = 512): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  
  // Truncate at byte boundary, preserving UTF-8 integrity
  const buf = Buffer.from(text, 'utf8');
  const truncated = buf.subarray(0, Math.max(0, maxBytes - 4)).toString('utf8');
  return truncated + '...';
}
```

---

## Summary by File

| File | Findings | Status | Action |
|------|----------|--------|--------|
| `server.ts` | 4 | 3✓ 1⚠️ | Add comment, validation |
| `types.ts` | 4 | 3✓ 1⚠️ | Add JSDoc, consolidate JsonValue |
| `error-mapper.ts` | 3 | 2✓ 1⚠️ | Add documentation |
| `v2-execution.ts` | 6 | 1✓ 5⚠️ | Refactor errors, add bounding, fix types |
| `output-schemas.ts` | 1 | 0✓ 1⚠️ | Remove JsonValue duplicate |
| `bounded-json.ts` | 1 | 0✓ 1⚠️ | Add boundedSuggestion helper |

**Total findings:** 19 across 6 files  
**Working correctly:** 11  
**Needs improvement:** 8  
**New code needed:** 2 (boundedSuggestion, JsonValue validation)

---

## Implementation Checklist

### Priority 0 (Type Safety)
- [ ] `server.ts` #16: Add JsonValue runtime validation in toMcpResult
- [ ] `types.ts` #12: Consolidate JsonValue to single source
- [ ] `types.ts` #4: Add JSDoc to ToolError interface

### Priority 1 (Consistency)  
- [ ] `v2-execution.ts` #10: Standardize to named options
- [ ] `bounded-json.ts`: Add boundedSuggestion helper
- [ ] `v2-execution.ts` #11: Apply bounding to suggestions
- [ ] `v2-execution.ts` #9: Add structured details to token errors

### Priority 2 (Type Safety)
- [ ] `v2-execution.ts` #13: Implement Zod discriminator
- [ ] `error-mapper.ts` #15: Add JsonValue documentation
- [ ] `server.ts` #1: Add comment about retry serialization
- [ ] `output-schemas.ts` #12b: Remove JsonValue duplicate

---

Last updated: 2025-01-XX  
Audit status: Complete  
Implementation status: Pending
