# Wave 1 Outputs: Handler DI Refactoring

## Status
✅ Both subagents completed successfully
✅ No conflicts (independent functions)
✅ Ready to apply

## Integration Instructions

### 1. Apply Subagent A output (handleV2StartWorkflow)

**File**: `src/mcp/handlers/v2-execution.ts`
**Lines**: 401-622

**Changes**:
- Added `if (!ctx.v2)` guard at line 403
- Added destructuring: `const { gate, sessionStore, snapshotStore, pinnedStore, keyring } = ctx.v2;`
- Deleted lines 414-422 (store instantiations)
- Deleted lines 556-562 (loadKeyring call)
- Added `const crypto = container.resolve<any>(DI.V2.Crypto);` for hashing

**Add imports** at top of file:
```typescript
import { container } from '../../../di/container.js';
import { DI } from '../../../di/tokens.js';
```

### 2. Apply Subagent B output (handleV2ContinueWorkflow)

**File**: `src/mcp/handlers/v2-execution.ts`
**Lines**: 625-1093

**Changes**:
- Added `if (!ctx.v2)` guard
- Added destructuring of ctx.v2
- Deleted lines 631-636 (loadKeyring)
- Deleted lines 643-649 (rehydrate instantiations)
- Deleted lines 776-781 (ack instantiations)
- Replaced line 791: inline pinnedStore → injected pinnedStore
- Deleted line 810 (inline snapshotStore)
- Replaced line 981: sessionStore2 → sessionStore

### 3. Verify

```bash
npm run typecheck
npm test -- tests/unit/mcp-v2-*.test.ts tests/contract/mcp-v2-execution.contract.test.ts
```

### 4. Commit

```bash
git add src/mcp/handlers/v2-execution.ts
git commit -m "refactor(v2): use DI-injected dependencies in handlers (Wave 1)"
```

---

## Next: Wave 2-4

Continue with remaining waves in fresh session:
- Wave 2: Remove try/catch (2 parallel)
- Wave 3: Documentation (2 parallel)
- Wave 4: Verification audits (5 parallel)

See CONTEXT.md for full plan.
