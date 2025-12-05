# WorkRail Test Architecture

**Last Updated:** 2024-11-27  
**Owner:** _________________ (assign before using)

---

## Quick Start

```bash
# Run all tests
npm test

# Run by tier (fastest to slowest)
npm run test:smoke        # < 5s - DI health checks
npm run test:unit         # Fast - isolated functions
npm run test:integration  # Medium - service collaboration
npm run test:perf         # Slow - memory/performance
```

---

## Test Tiers

| Tier | Purpose | Speed | Mocking | File Location |
|------|---------|-------|---------|---------------|
| **[SMOKE]** | DI health | < 5s total | None | `tests/smoke/` |
| **[INTEGRATION]** | Service collaboration | 10-100ms | Infrastructure only | `tests/integration/` |
| **[UNIT]** | Single function | < 1ms | Heavy | `tests/unit/` |
| **[PERF]** | Memory/cache | 1-10s | Minimal | `tests/performance/` |

---

## Decision Tree

**See:** `tests/TIER_DECISION_FLOWCHART.md` for printable reference.

```
Testing DI construction? → [SMOKE]
Testing 2+ services with real implementations? → [INTEGRATION]
Testing 2+ services with mocks? → [UNIT]
Testing single function? → [UNIT]
Testing memory/performance? → [PERF]
```

---

## Writing Tests

### [SMOKE] Test Template

```typescript
// tests/smoke/my-service.smoke.test.ts
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { container } from 'tsyringe';
import { DI } from '../../src/di/tokens.js';
import { initializeContainer, resetContainer } from '../../src/di/container.js';

describe('[SMOKE] MyService DI Health', () => {
  beforeEach(() => resetContainer());
  afterEach(() => resetContainer());

  it('can resolve without error', async () => {
    await initializeContainer();
    expect(() => container.resolve(DI.Services.MyService)).not.toThrow();
  });
});
```

**Use when:** Verifying a new service's DI configuration works.

---

### [INTEGRATION] Test Template

```typescript
// tests/integration/my-feature.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupIntegrationTest, teardownIntegrationTest, resolveService } from '../di/integration-container.js';
import { DI } from '../../src/di/tokens.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';

describe('[INTEGRATION] My Feature', () => {
  let storage: InMemoryWorkflowStorage;

  beforeEach(async () => {
    storage = new InMemoryWorkflowStorage();
    await setupIntegrationTest({ storage });
  });

  afterEach(() => teardownIntegrationTest());

  it('tests real service collaboration', async () => {
    const service = resolveService<any>(DI.Services.Workflow);
    
    // Service uses REAL ValidationEngine, REAL LoopStackManager, etc.
    const result = await service.getNextStep('workflow-1', []);
    expect(result.step).toBeDefined();
  });
});
```

**Use when:** Testing how multiple services work together with real implementations.

---

### [UNIT] Test Template

```typescript
// tests/unit/my-function.test.ts
import { describe, it, expect } from 'vitest';
import { myFunction } from '../../src/utils/my-function.js';

describe('[UNIT] myFunction', () => {
  it('handles edge case correctly', () => {
    const result = myFunction('input');
    expect(result).toBe('expected');
  });
});
```

**Use when:** Testing a single function's logic in isolation.

---

## Common Patterns

### Pattern 1: Mock Storage Only

```typescript
beforeEach(async () => {
  const storage = new InMemoryWorkflowStorage();
  storage.addWorkflow(FIXTURES.simpleWorkflow);
  
  await setupIntegrationTest({ storage });
});

// Now all services use real DI, only storage is mocked
```

### Pattern 2: Control Feature Flags

```typescript
beforeEach(async () => {
  await setupIntegrationTest({ 
    featureFlags: { 
      sessionTools: false,  // Disable HTTP server
      verboseLogging: true, // Enable debug logs
    }
  });
});
```

### Pattern 3: Access Real Services

```typescript
it('uses real validation engine', async () => {
  const service = resolveService<WorkflowService>(DI.Services.Workflow);
  
  // service.validationEngine is the REAL ValidationEngine
  // service.stepResolutionStrategy is the REAL IterativeStepResolutionStrategy
});
```

---

## Anti-Patterns (Don't Do This!)

### ❌ Anti-Pattern 1: Business Logic Mocks in Integration

```typescript
// ❌ BAD - ESLint will fail this!
await setupIntegrationTest({
  mocks: { [DI.Infra.ValidationEngine]: mockValidator }
});

// ✅ GOOD - Move to unit test if you need mocks
await setupTest({  // Different helper for unit tests
  mocks: { [DI.Infra.ValidationEngine]: mockValidator }
});
```

### ❌ Anti-Pattern 2: DI Tests in Unit Tier

```typescript
// ❌ BAD - Wrong tier
describe('[UNIT] MyService Construction', () => {
  it('can be constructed', () => {
    expect(() => new MyService()).not.toThrow();
  });
});

// ✅ GOOD - Use smoke tests
describe('[SMOKE] MyService DI', () => {
  it('can be resolved', async () => {
    await initializeContainer();
    expect(() => container.resolve(DI.Services.MyService)).not.toThrow();
  });
});
```

### ❌ Anti-Pattern 3: Real File I/O in Integration

```typescript
// ❌ BAD - Slow and brittle
await setupIntegrationTest({
  storage: new FileWorkflowStorage('./real-workflows')
});

// ✅ GOOD - In-memory is fast and reliable
await setupIntegrationTest({
  storage: new InMemoryWorkflowStorage()
});
```

---

## Test Helpers

### For [SMOKE] Tests

```typescript
import { initializeContainer, resetContainer } from '../../src/di/container.js';
import { container } from 'tsyringe';

beforeEach(() => resetContainer());
afterEach(() => resetContainer());

it('smoke test', async () => {
  await initializeContainer();
  const service = container.resolve(DI.Services.MyService);
});
```

### For [INTEGRATION] Tests

```typescript
import { setupIntegrationTest, teardownIntegrationTest, resolveService } from '../di/integration-container.js';

beforeEach(async () => {
  await setupIntegrationTest({ storage: myStorage });
});

afterEach(() => teardownIntegrationTest());

it('integration test', async () => {
  const service = resolveService<Type>(DI.Services.MyService);
});
```

### For [UNIT] Tests

```typescript
import { setupTest, teardownTest, resolve } from '../di/test-container.js';

beforeEach(async () => {
  await setupTest({ mocks: { ... } });
});

afterEach(() => teardownTest());

it('unit test', () => {
  const service = resolve(DI.Services.MyService);
});
```

---

## Enforcement

### ESLint

Integration tests cannot have business logic mocks:

```javascript
// .eslintrc-tests.js catches this:
setupIntegrationTest({
  mocks: { [DI.Infra.ValidationEngine]: mock } // ❌ Error!
});
```

### PR Checklist

- [ ] Ran `npm run test:smoke` (< 5s)
- [ ] New tests use correct tier (see flowchart)
- [ ] Integration tests don't mock business logic
- [ ] ESLint passes

### Code Review

Reviewer verifies:

- [ ] Test is in correct directory (`smoke/`, `integration/`, `unit/`)
- [ ] Integration tests use `setupIntegrationTest()`
- [ ] No business logic mocked in integration tier

---

## Metrics (Tracked Weekly)

| Metric | Target |
|--------|--------|
| Smoke test runtime | < 5s |
| Tests per tier ratio | 10% smoke, 20% integration, 70% unit |
| Wrong-tier violations | 0 per week |
| Bugs caught by smoke tests | Track and celebrate! |

---

## Getting Help

1. **Unsure which tier?** Check `TIER_DECISION_FLOWCHART.md`
2. **ESLint error?** You're probably mocking business logic in integration
3. **Test too slow?** Consider if it should be unit, not integration
4. **Need help?** Ask the test architecture owner: _________________

---

## Examples

See these for reference:

- `tests/smoke/di-container.smoke.test.ts` - All smoke test patterns
- `tests/integration/tsyringe-di.test.ts` - Basic integration patterns
- `tests/performance/cache-eviction.test.ts` - Performance test patterns
