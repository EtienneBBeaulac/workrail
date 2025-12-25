# MCP Error Envelope Implementation Audit

**Scope:** `src/mcp/**`  
**Focus:** Unified error envelope shape, serialization, type-safety, and v2 semantics consistency  
**Date:** 2025 Audit

---

## Executive Summary

The MCP error envelope implementation is **well-structured** with a clear discriminated union design, but has **6 areas for improvement** that require tightening:

1. **Runtime validation missing** – `details` not validated as JsonValue at boundary
2. **JsonValue type duplicated** – Defined in two places without explanation
3. **Token errors underutilized** – Don't provide structured `details`
4. **Error constructor ambiguous** – Mixed positional and named arguments
5. **Suggestion strings unbounded** – Can grow large in some paths
6. **Type narrowing unsafe** – ContinueAckError type guard not exhaustive

---

## Detailed Findings

### Finding #1: Missing `retry` Serialization in `toMcpResult` (VERIFIED ✓)

**File:** `./src/mcp/server.ts:91–112`  
**Lines:** 101–107

**Status:** ✓ **Correct** – `retry` is **always** included in JSON serialization.

**Recommendation:** Add a comment documenting that `retry` is always serialized:
```typescript
// NOTE: retry is ALWAYS serialized; it is NOT optional in the envelope.
retry: result.retry,
```

---

### Finding #2: Zod Parse Errors Produce Correct Envelope (VERIFIED ✓)

**File:** `./src/mcp/server.ts:174–192`

**Status:** ✓ **Correct** – Zod parse errors go through `toMcpResult`, producing the correct envelope:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid input",
  "retry": { "kind": "not_retryable" },
  "details": {
    "validationIssues": [
      { "path": "stateToken", "message": "Required" }
    ]
  }
}
```

---

### Finding #3: Prevalidation Errors Use Same Envelope (VERIFIED ✓)

**File:** `./src/mcp/server.ts:199–222`

**Status:** ✓ **Correct** – Prevalidation errors go through `toMcpResult`, producing the same envelope shape.

---

### Finding #4: `ToolError` Interface Correctly Requires `retry` (VERIFIED ✓)

**File:** `./src/mcp/types.ts:72–79`

**Status:** ✓ **Correct** – `retry` is **required** (not optional).

**Recommendation:** Document that `retry` is never undefined:
```typescript
/**
 * Error result from a tool handler.
 * The `retry` field is ALWAYS present and NEVER undefined.
 */
export interface ToolError {
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
  readonly suggestion?: string;
  readonly retry: ToolRetry;  // Always set; never undefined
  readonly details?: JsonValue;
}
```

---

### Finding #5: Error Constructors Produce Correct Envelopes (VERIFIED ✓)

**File:** `./src/mcp/types.ts:104–147`

**Status:** ✓ **Correct** – All constructors explicitly set `retry`:
- `error()` defaults to `not_retryable`
- `errNotRetryable()` explicitly sets `kind: 'not_retryable'`
- `errRetryableImmediate()` explicitly sets `kind: 'retryable_immediate'`
- `errRetryableAfterMs()` explicitly sets `kind: 'retryable_after_ms'` with ms value

---

### Finding #6: Domain Error Mapper Correctly Typed (VERIFIED ✓)

**File:** `./src/mcp/error-mapper.ts:12–62`

**Status:** ✓ **Correct** – All cases have `as ToolFailure` cast:
- Line 15: WorkflowNotFound ✓
- Line 20: InvalidState ✓
- Line 37: InvalidLoop ✓
- Line 42: MissingContext ✓
- Line 50: ConditionEvalFailed ✓
- Line 55: MaxIterationsExceeded ✓

---

### Finding #7: Unknown Error Mapper Correctly Typed (VERIFIED ✓)

**File:** `./src/mcp/error-mapper.ts:64–69`

**Status:** ✓ **Correct** – Returns `ToolFailure` type.

---

### Finding #8: v2 Execution Error Mappers Type-Safe (VERIFIED ✓)

**File:** `./src/mcp/handlers/v2-execution.ts:70–134`

**Status:** ✓ **Correct** – Session health details are type-safe via `detailsSessionHealth()` helper:

```typescript
export type SessionHealthDetails = Readonly<{
  health: Readonly<{
    kind: 'healthy' | 'corrupt_tail' | 'corrupt_head' | 'unknown_version';
    reason?: Readonly<{ code: string; message: string }>;
  }>;
}>;
```

---

### Finding #9: Token Error Mappers Don't Use `details` (IMPROVEMENT OPPORTUNITY ⚠️)

**File:** `./src/mcp/handlers/v2-execution.ts:193–222`

**Current:** Token errors only use `suggestion` field, not `details`.

**Recommendation:** Add structured details:

```typescript
function tokenDecodeErrorToToolError(e: { readonly code: string; readonly message: string }): ToolResult<never> {
  const suggestion = 'Use the exact tokens returned by WorkRail. Tokens are opaque; do not edit or construct them.';
  const details: JsonValue | undefined = {
    tokenErrorCode: e.code,
  };
  
  switch (e.code) {
    case 'TOKEN_INVALID_FORMAT':
      return error('TOKEN_INVALID_FORMAT', normalizeTokenErrorMessage(e.message), suggestion, undefined, details);
    // ...
  }
}
```

**Status:** ⚠️ **Opportunity** – Could benefit from structured details.

---

### Finding #10: v2 Execution Errors Use Mixed Constructor Styles (CLARITY ISSUE ⚠️)

**File:** `./src/mcp/handlers/v2-execution.ts:424–445`

**Current:** Mixed use of `error()` (5 positional args) and `errNotRetryable()` (named options):

```typescript
// Positional style (unclear which arg is which)
return error('TOKEN_UNKNOWN_NODE', 'No durable run state found...', 'Use start_workflow...');

// Named style (clearer)
return errNotRetryable('NOT_FOUND', 'Workflow not found', { suggestion: '...' });
```

**Recommendation:** Standardize to named options:

```typescript
type ErrorOptions = {
  suggestion?: string;
  retry?: ToolRetry;
  details?: JsonValue;
};

export const error = (
  code: ErrorCode,
  message: string,
  options?: ErrorOptions | string  // Support both for backward compat
): ToolResult<never> => {
  if (typeof options === 'string') {
    // legacy: error(code, message, suggestion)
    return {
      type: 'error',
      code,
      message,
      suggestion: options,
      retry: { kind: 'not_retryable' },
    };
  }
  return {
    type: 'error',
    code,
    message,
    suggestion: options?.suggestion,
    retry: options?.retry ?? { kind: 'not_retryable' },
    ...(options?.details !== undefined ? { details: options.details } : {}),
  };
};
```

**Status:** ⚠️ **Clarity** – Mixed styles make intent unclear.

---

### Finding #11: Suggestion Strings Not Bounded (DATA HYGIENE ISSUE ⚠️)

**File:** `./src/mcp/handlers/v2-execution.ts:88–89, 116–117, 123–124`

**Current:** Suggestions are uncontrolled in size:
```typescript
{ suggestion: 'Retry in a few seconds; if this persists >10s, ensure no other WorkRail process is running for this session.' }
```

**Compare to:** Prevalidation uses `toBoundedJsonValue(512)`.

**Recommendation:** Apply bounding:

```typescript
function boundedSuggestion(text: string, maxBytes: number = 512): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  return buf.subarray(0, Math.max(0, maxBytes - 4)).toString('utf8') + '...';
}

// Usage
{ suggestion: boundedSuggestion('Retry in a few seconds; if this persists >10s, ...') }
```

**Status:** ⚠️ **Unbounded** – Suggestions can grow beyond reasonable envelope size.

---

### Finding #12: `JsonValue` Type Is Duplicated and Underdocumented (CONSOLIDATION NEEDED ⚠️)

**File:** `./src/mcp/types.ts:19–25` and `./src/mcp/output-schemas.ts:8–14`

**Current:** Type defined in two places without documentation:

```typescript
// src/mcp/types.ts (line 19–25)
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// src/mcp/output-schemas.ts (line 8–14) - DUPLICATE
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

**Issues:**
1. Type duplication – violates DRY principle
2. No documentation – doesn't explain why JsonValue is required
3. Error mappers don't mention it

**Recommendation:** Single source of truth with documentation:

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

**Status:** ⚠️ **Consolidation needed** – Type is safe but its purpose isn't explained.

---

### Finding #13: `continueAckErrorToToolError` Has Unsafe Type Narrowing (TYPE SAFETY ISSUE ⚠️)

**File:** `./src/mcp/handlers/v2-execution.ts:146–191`

**Current:** Weak type guard:

```typescript
function continueAckErrorToToolError(e: ExecutionSessionGateErrorV2 | ContinueAckError): ToolFailure {
  if ('kind' in e && typeof e.kind === 'string') {
    const err = e as ContinueAckError;  // ← Unsafe cast
    switch (err.kind) {
      case 'missing_node_or_run':
        return errNotRetryable(...) as ToolFailure;
      // ...
    }
  }
  return gateErrorToToolError(e as ExecutionSessionGateErrorV2);
}
```

**Problems:**
1. Type guard doesn't distinguish between ContinueAckError and ExecutionSessionGateErrorV2
2. Both types have `kind: string` field
3. Type narrowing is not exhaustive

**Recommendation:** Use Zod discriminator at source:

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

**Status:** ⚠️ **Type-safety concern** – Type guard is not exhaustive.

---

### Finding #14: All Error Paths Return via `toMcpResult` (VERIFIED ✓)

**File:** `./src/mcp/server.ts:91–112` (main conversion point)

**Verification:**

✓ `createHandler`: All paths through `toMcpResult`
  - Success: `toMcpResult(await handler(...))`
  - Zod parse failure: `toMcpResult(errNotRetryable(...))`
  - Exception: `toMcpResult(mapUnknownErrorToToolError(err))`

✓ `createValidatingHandler`: All paths through `toMcpResult`
  - Prevalidation failure: `toMcpResult(errNotRetryable(...))`
  - Handler chain: `createHandler(...)(args, ctx)` → `toMcpResult`
  - Exception: `toMcpResult(mapUnknownErrorToToolError(err))`

**Status:** ✓ **Verified** – No error bypasses `toMcpResult`.

---

### Finding #15: v2 Handlers Wrapped in `createHandler` (VERIFIED ✓)

**File:** `./src/mcp/server.ts:346–350`

**Status:** ✓ **Verified** – v2 handlers are wrapped in `createHandler`, which calls `toMcpResult`.

---

### Finding #16: No Runtime Validation of `details` at Boundary (RUNTIME SAFETY ISSUE ⚠️)

**File:** `./src/mcp/output-schemas.ts:1–20` and `./src/mcp/server.ts:91–112`

**Current:** `JsonValueSchema` defined but not used to validate error details:

```typescript
const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(JsonValueSchema)])
);
```

**Problem:** Error details set by handlers are not validated before serialization.

**Recommendation:** Validate details in `toMcpResult`:

```typescript
import { JsonValueSchema } from './output-schemas.js';

function toMcpResult<T>(result: ToolResult<T>): McpCallToolResult {
  switch (result.type) {
    case 'error':
      // Validate details conform to JsonValue
      if (result.details !== undefined) {
        const detailsValid = JsonValueSchema.safeParse(result.details);
        if (!detailsValid.success) {
          // Return sanitized error instead of invalid details
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            code: result.code,
            message: result.message,
            retry: result.retry,
            ...(result.suggestion && { suggestion: result.suggestion }),
            ...(result.details !== undefined ? { details: result.details } : {}),
          }, null, 2),
        }],
        isError: true,
      };
    // ... success case ...
  }
}
```

**Status:** ⚠️ **No validation** – Details could theoretically contain non-JSON values.

---

## Summary Table

| Finding | File | Line(s) | Issue | Severity | Status |
|---------|------|---------|-------|----------|--------|
| 1 | `server.ts` | 101 | Document that `retry` is always serialized | Info | ⚠️ Add comment |
| 2 | `server.ts` | 174–192 | Zod parse errors produce correct envelope | Status | ✓ Working |
| 3 | `server.ts` | 199–222 | Prevalidation errors use same envelope | Status | ✓ Working |
| 4 | `types.ts` | 72–79 | ToolError requires retry (never undefined) | Status | ✓ Correct |
| 5 | `types.ts` | 104–147 | Error constructors set retry correctly | Status | ✓ Correct |
| 6 | `error-mapper.ts` | 12–62 | Domain error mapper has correct casts | Status | ✓ Correct |
| 7 | `error-mapper.ts` | 64–69 | Unknown error mapper correctly typed | Status | ✓ Correct |
| 8 | `v2-execution.ts` | 70–134 | Session health details are type-safe | Status | ✓ Correct |
| 9 | `v2-execution.ts` | 193–222 | Token errors don't use `details` field | Improvement | ⚠️ Could add details |
| 10 | `v2-execution.ts` | 424–445 | Mixed use of `error()` and `errNotRetryable()` | Clarity | ⚠️ Use named options |
| 11 | `v2-execution.ts` | 88–124 | Suggestion strings not bounded | Data | ⚠️ Add bounding |
| 12 | `types.ts`, `output-schemas.ts` | 19–25, 8–14 | JsonValue duplicated and underdocumented | Documentation | ⚠️ Consolidate & document |
| 13 | `v2-execution.ts` | 146–191 | Unsafe type narrowing in continueAckErrorToToolError | Type Safety | ⚠️ Use Zod discriminator |
| 14 | `server.ts` | 91–370 | All error paths return via toMcpResult | Status | ✓ Verified |
| 15 | `server.ts` | 346–350 | v2 handlers wrapped in createHandler | Status | ✓ Verified |
| 16 | `output-schemas.ts` | 1–20 | No runtime validation of error details | Runtime Safety | ⚠️ Add validation |

---

## Recommendations (Priority Order)

### P0: Type-Safety & Serialization

1. **Add `JsonValue` runtime validation in `toMcpResult`** (Finding #16)
   - Validate error details before serialization
   - Prevent invalid data from crossing MCP boundary
   - File: `src/mcp/server.ts`

2. **Consolidate `JsonValue` definition** (Finding #12)
   - Move to `types.ts` as single source of truth
   - Re-export from `output-schemas.ts`
   - Add comprehensive JSDoc explaining purpose
   - Files: `src/mcp/types.ts`, `src/mcp/output-schemas.ts`

3. **Document why `retry` is always serialized** (Finding #1)
   - Add comment in `toMcpResult` explaining retry is never optional
   - Add JSDoc to `ToolError` interface
   - File: `src/mcp/server.ts`, `src/mcp/types.ts`

### P1: Consistency & Clarity

4. **Use named options in `error()` constructor** (Finding #10)
   - Refactor `error(code, message, suggestion, retry, details)` to use named options
   - Keep backward compatibility via overload if needed
   - Standardize all call sites
   - File: `src/mcp/types.ts`, `src/mcp/handlers/v2-execution.ts`

5. **Bound all suggestion strings** (Finding #11)
   - Implement `boundedSuggestion()` helper function
   - Apply to all handler error paths
   - Maximum 512 bytes (UTF-8 safe truncation)
   - File: `src/mcp/handlers/v2-execution.ts`, `src/mcp/validation/bounded-json.ts`

6. **Add structured details to token errors** (Finding #9)
   - Include `tokenErrorCode` in details
   - Provide structured context for token validation failures
   - File: `src/mcp/handlers/v2-execution.ts`

### P2: Type Safety

7. **Use Zod discriminator for ContinueAckError** (Finding #13)
   - Implement proper discriminated union with Zod
   - Ensure exhaustive type narrowing
   - File: `src/mcp/handlers/v2-execution.ts`

8. **Document JsonValue in error mappers** (Finding #12)
   - Add JSDoc comments explaining JsonValue requirement
   - Explain why no undefined/functions/symbols allowed
   - File: `src/mcp/error-mapper.ts`, `src/mcp/handlers/v2-execution.ts`

---

## Verification Checklist

- [x] Single envelope shape everywhere: `{code, message, retry, suggestion?, details?}`
- [x] `retry` required on `ToolError` and always serialized
- [x] `suggestion` top-level semantics (distinct from `BlockerReport.suggestedFix`)
- [x] `details` type is `JsonValue` (no unknown bags crossing boundary)
- [x] Zod parse errors produce correct envelope via `toMcpResult`
- [x] Prevalidation errors produce correct envelope via `toMcpResult`
- [x] Error mappers return correct retry and don't throw
- [⚠️] Error details validated at boundary (missing runtime check)
- [⚠️] All suggestion strings bounded (missing in some paths)
- [⚠️] Token error details structured (opportunity for improvement)

---

## Code Examples

### Correct Envelope (✓)

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid input",
  "retry": {
    "kind": "not_retryable"
  },
  "suggestion": "Check your input format",
  "details": {
    "validationIssues": [
      {
        "path": "stateToken",
        "message": "Required"
      }
    ]
  }
}
```

### Correct Session Health Error (✓)

```json
{
  "code": "SESSION_NOT_HEALTHY",
  "message": "Session corruption detected (head): STORE_INVARIANT_VIOLATION",
  "retry": {
    "kind": "not_retryable"
  },
  "suggestion": "Execution requires a healthy session. Export a salvage/read-only view, then recreate the run.",
  "details": {
    "health": {
      "kind": "corrupt_head",
      "reason": {
        "code": "STORE_INVARIANT_VIOLATION",
        "message": "Event log index mismatch"
      }
    }
  }
}
```

### Correct Retryable Error (✓)

```json
{
  "code": "TOKEN_SESSION_LOCKED",
  "message": "Session is locked by another process",
  "retry": {
    "kind": "retryable_after_ms",
    "afterMs": 2000
  },
  "suggestion": "Retry in a few seconds; if this persists >10s, ensure no other WorkRail process is running for this session."
}
```

---

## Conclusion

The MCP error envelope implementation is **fundamentally sound** with:
- ✓ Discriminated union design
- ✓ Mandatory `retry` field
- ✓ Consistent routing through `toMcpResult`
- ✓ Type-safe constructors

**Key improvements needed:**
1. Runtime validation of `details` at boundary (safety)
2. Consolidation of `JsonValue` type definition (DRY)
3. Documentation of `JsonValue` purpose (clarity)
4. Bounding of suggestion strings (data hygiene)
5. Type-safe discriminator for complex error types (type safety)

**No breaking changes required** – all improvements are additive or internal.

---

## Implementation Path

1. **Week 1:** P0 changes (validation, consolidation, documentation)
2. **Week 2:** P1 changes (named options, bounding, details)
3. **Week 3:** P2 changes (Zod discriminator, JSDoc)
4. **Week 4:** Testing, audit verification

Estimated impact: **Low risk** – no public API changes, all improvements internal.
