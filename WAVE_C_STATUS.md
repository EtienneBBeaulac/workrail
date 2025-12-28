# Wave C Status: Architectural Cleanup

## Completed (C1, C3 partial)
✅ V2Dependencies interface updated (6 properties)
✅ CryptoPortV2 import fixed (correct path)
✅ Dead code removed (loadKeyring helper)

## Remaining Issues

### Issue 1: Helper Functions Need Hmac Injection
**Files affected**: `src/mcp/handlers/v2-execution.ts`

Three helper functions still instantiate `NodeHmacSha256V2`:
- `parseStateTokenOrFail()` (line 248)
- `parseAckTokenOrFail()` (line 270)
- `signTokenOrErr()` (line 301)

**Root cause**: These are pure utility functions but they need crypto infrastructure.

**Two solutions**:
A) Add `hmac: HmacSha256PortV2` to V2Dependencies (PROPER)
B) Pass hmac as parameter to helpers (PATCH)

**Recommendation**: Option A - Add hmac to V2Dependencies for consistency.

### Issue 2: Server.ts Not Updated (C2)
- Need to add crypto resolution in `createToolContext()`
- Need to add crypto to v2 object

### Issue 3: Test Files Not Updated (C5)
- 5 test files need crypto added to v2 context

## Next Steps
1. Add hmac to V2Dependencies (7th property)
2. Update createToolContext to inject crypto + hmac
3. Update handlers to destructure crypto + hmac
4. Pass hmac to helper functions instead of instantiating
5. Update all test files
6. Typecheck + test + commit

