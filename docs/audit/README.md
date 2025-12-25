# MCP Error Envelope Implementation Audit

Complete audit of the unified MCP error envelope implementation across `src/mcp/**`.

## Audit Documents

1. **[AUDIT_SUMMARY.txt](./AUDIT_SUMMARY.txt)** - Quick reference summary
   - Key findings at a glance
   - Priority recommendations
   - Risk assessment
   - Implementation roadmap

2. **[mcp-error-envelope-audit.md](./mcp-error-envelope-audit.md)** - Detailed audit report
   - 16 findings with full context
   - File:line references
   - Code examples
   - Verification checklist
   - Implementation recommendations

3. **[FINDINGS_BY_FILE.md](./FINDINGS_BY_FILE.md)** - Organized by source file
   - Specific line numbers and fixes
   - Before/after code examples
   - Implementation checklist
   - File-by-file action items

## Quick Summary

**Overall Status:** ✓ Fundamentally sound  
**Issues Found:** 8 improvements needed (all low-risk)  
**Breaking Changes:** 0  
**Implementation Risk:** Low

### Key Metrics

- ✓ 11 findings working correctly
- ⚠️ 8 findings needing improvement
- 🔧 2 new helpers to add (boundedSuggestion, validation)

### Unified Envelope Shape (Verified ✓)

```json
{
  "code": "ErrorCode",        // ✓ Required
  "message": "string",        // ✓ Required  
  "retry": ToolRetry,         // ✓ ALWAYS serialized (never optional)
  "suggestion"?: "string",    // ✓ Optional
  "details"?: JsonValue       // ✓ Optional, JSON-safe only
}
```

### Findings by Priority

**P0 - Type-Safety & Serialization** (3 items)
1. Add JsonValue runtime validation in toMcpResult
2. Consolidate JsonValue definition (single source of truth)
3. Document why retry is always serialized

**P1 - Consistency & Clarity** (3 items)
4. Use named options in error() constructor
5. Bound all suggestion strings (data hygiene)
6. Add structured details to token errors

**P2 - Type Safety** (2 items)
7. Use Zod discriminator for ContinueAckError
8. Document JsonValue in error mappers

## Files Affected

| File | Findings | Action |
|------|----------|--------|
| `src/mcp/server.ts` | 4 | Add comment, validation |
| `src/mcp/types.ts` | 4 | Add JSDoc, consolidate |
| `src/mcp/error-mapper.ts` | 3 | Documentation |
| `src/mcp/handlers/v2-execution.ts` | 6 | Refactor, bound, fix |
| `src/mcp/output-schemas.ts` | 1 | Remove duplicate |
| `src/mcp/validation/bounded-json.ts` | 1 | Add helper |

## Core Findings

### Working Correctly ✓

1. Retry field always serialized
2. Zod parse errors produce correct envelope
3. Prevalidation errors use same envelope
4. ToolError requires retry (never undefined)
5. Error constructors set retry correctly
6. Domain error mapper has correct casts
7. Unknown error mapper correctly typed
8. Session health details type-safe
9. All error paths return via toMcpResult
10. v2 handlers wrapped in createHandler
11. Single envelope shape everywhere

### Needs Improvement ⚠️

1. **Token error details not utilized** – Could provide structured context
2. **Error constructor style mixed** – Some use positional, some named arguments
3. **Suggestion strings unbounded** – Can exceed reasonable envelope size
4. **JsonValue type duplicated** – Defined in two places
5. **Type narrowing unsafe** – ContinueAckError guard not exhaustive
6. **No runtime validation** – Details not validated against JsonValue schema
7. **JsonValue purpose undocumented** – Why it's required not explained
8. **Error details unstructured** – Token errors could benefit from details

## Implementation Timeline

```
Week 1: P0 changes (validation, consolidation, documentation)
Week 2: P1 changes (named options, bounding, details)
Week 3: P2 changes (Zod discriminator, JSDoc)
Week 4: Testing, verification, cleanup
```

## Code Examples

### Correct Envelope (Verified ✓)

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid input",
  "retry": { "kind": "not_retryable" },
  "suggestion": "Check your input format",
  "details": {
    "validationIssues": [
      { "path": "stateToken", "message": "Required" }
    ]
  }
}
```

### Session Health Error (Verified ✓)

```json
{
  "code": "SESSION_NOT_HEALTHY",
  "message": "Session corruption detected (head): STORE_INVARIANT_VIOLATION",
  "retry": { "kind": "not_retryable" },
  "suggestion": "Export a salvage/read-only view, then recreate the run.",
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

### Retryable Error (Verified ✓)

```json
{
  "code": "TOKEN_SESSION_LOCKED",
  "message": "Session is locked by another process",
  "retry": {
    "kind": "retryable_after_ms",
    "afterMs": 2000
  },
  "suggestion": "Retry in a few seconds..."
}
```

## Verification Checklist

- [x] Single envelope shape everywhere
- [x] retry required and always serialized
- [x] suggestion top-level semantics
- [x] details type is JsonValue
- [x] Zod parse errors produce correct envelope
- [x] Prevalidation errors produce correct envelope
- [x] Error mappers return correct retry
- [⚠️] Error details validated at boundary
- [⚠️] All suggestion strings bounded
- [⚠️] Token error details structured

## Risk Assessment

| Metric | Level | Notes |
|--------|-------|-------|
| Breaking Changes | None | All additive |
| Backward Compatibility | 100% | No public API changes |
| Testing Impact | Low | Data validation only |
| Performance Impact | Negligible | Boundary validation only |
| **Overall Risk** | **LOW** | Safe to implement |

## Quick Navigation

**For Audit Overview:** → [AUDIT_SUMMARY.txt](./AUDIT_SUMMARY.txt)  
**For Detailed Analysis:** → [mcp-error-envelope-audit.md](./mcp-error-envelope-audit.md)  
**For Implementation Plan:** → [FINDINGS_BY_FILE.md](./FINDINGS_BY_FILE.md)  

---

**Audit Date:** 2025  
**Scope:** `src/mcp/**`  
**Status:** Complete  
**Recommendation:** Proceed with P0 and P1 implementations (low risk)
