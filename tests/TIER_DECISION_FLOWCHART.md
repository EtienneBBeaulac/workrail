# Test Tier Decision Flowchart

**Print this and keep it at your desk!**

---

## Quick Reference

| Test Type | Speed | Mocking | Example |
|-----------|-------|---------|---------|
| **[SMOKE]** | < 5s total | None | "Can resolve DI.Services.Workflow?" |
| **[INTEGRATION]** | 10-100ms | Infrastructure only | "Workflow with real ValidationEngine" |
| **[UNIT]** | < 1ms | Heavy | "parseBoolean('yes') returns true" |
| **[PERF]** | 1-10s | Minimal | "Cache stays under 1000 entries" |

---

## Decision Flowchart

```
┌────────────────────────────────────────────┐
│ I need to write a test for...             │
└──────────┬─────────────────────────────────┘
           │
           ▼
    ┌──────────────────┐
    │ Is it about DI?  │
    │ (Construction/   │
    │  wiring check?)  │
    └─────┬────────────┘
          │
     YES──┼──NO
      │         │
      ▼         ▼
  ┌─────────┐  ┌──────────────────┐
  │ [SMOKE] │  │ Multiple services│
  │         │  │ working together?│
  │ 5s total│  └────┬─────────────┘
  │ No mocks│       │
  └─────────┘  YES──┼──NO
                    │      │
                    ▼      ▼
            ┌──────────────┐  ┌──────────────┐
            │ Need real    │  │ Single       │
            │ behavior?    │  │ function?    │
            └────┬─────────┘  └──────┬───────┘
                 │                   │
            YES──┼──NO               ▼
             │      │            ┌─────────┐
             ▼      ▼            │ [UNIT]  │
       ┌─────────────┐  ┌─────────────┐  │ < 1ms   │
       │[INTEGRATION]│  │ [UNIT]      │  │ Heavy   │
       │ 10-100ms    │  │ with mocks  │  │ mocks   │
       │ Infra mocks │  │ Quick test  │  └─────────┘
       │ only        │  │ Isolated    │
       └─────────────┘  └─────────────┘
```

---

## Examples by Tier

### [SMOKE] - DI Health Checks

```typescript
// tests/smoke/di-container.smoke.test.ts

it('can resolve all DI tokens', async () => {
  await initializeContainer();
  expect(() => container.resolve(DI.Services.Workflow)).not.toThrow();
});
```

**Characteristics:**

-  No mocks
-  Tests construction, not behavior
-  Catches: Missing decorators, bad constructors, circular deps
-  Fast (< 1s per test)

---

### [INTEGRATION] - Service Collaboration

```typescript
// tests/integration/workflow-execution-real.test.ts

beforeEach(async () => {
  const storage = new InMemoryWorkflowStorage();
  await setupIntegrationTest({ storage });
});

it('validates step output with real ValidationEngine', async () => {
  const service = resolveService<WorkflowService>(DI.Services.Workflow);
  const result = await service.validateStepOutput('wf-1', 'step-1', 'output');
  
  // Uses REAL ValidationEngine.validate() - not a mock
  expect(result.valid).toBe(true);
});
```

**Characteristics:**

-  Uses real business logic services (ValidationEngine, LoopStackManager)
-  Only mocks infrastructure (storage, feature flags)
-  Tests service integration points
-  Medium speed (10-100ms)

**What to mock:**

-  Storage (use InMemoryWorkflowStorage)
-  Feature flags (use StaticFeatureFlagProvider)
-  HTTP clients, file I/O

**What NOT to mock:**

-  ValidationEngine
-  LoopStackManager
-  StepSelector
-  Any business logic service

---

### [UNIT] - Isolated Functions

```typescript
// tests/unit/condition-evaluator.test.ts

it('evaluates simple equals condition', () => {
  const condition = { var: 'status', equals: 'active' };
  const context = { status: 'active' };
  
  const result = evaluateCondition(condition, context);
  expect(result).toBe(true);
});
```

**Characteristics:**

-  Tests single function in isolation
-  Heavy mocking acceptable
-  Very fast (< 1ms)
-  No DI involved

---

### [PERF] - Memory & Performance

```typescript
// tests/performance/cache-eviction.test.ts

it('cache stays under limit', async () => {
  const resolver = container.resolve<any>(DI.Infra.LoopStepResolver);
  
  // Simulate 2000 resolutions
  for (let i = 0; i < 2000; i++) {
    // ... add to cache
  }
  
  expect(resolver.getCacheSize()).toBeLessThanOrEqual(1000);
});
```

**Characteristics:**

-  Load simulation
-  Memory checks
-  Cache eviction verification
-  Slower (1-10s)

---

## Common Mistakes

###  Mistake 1: Mocking Business Logic in Integration Tests

```typescript
// BAD - This defeats the purpose of integration testing!
await setupIntegrationTest({
  mocks: { [DI.Infra.ValidationEngine]: mockValidator }
});

// GOOD - Only mock infrastructure
await setupIntegrationTest({
  storage: new InMemoryWorkflowStorage()
});
```

**ESLint will catch this!**

---

###  Mistake 2: Testing DI in Unit Tests

```typescript
// BAD - Wrong tier
describe('[UNIT] MyService', () => {
  it('can be constructed', () => {
    expect(() => new MyService()).not.toThrow();
  });
});

// GOOD - Use smoke tests for DI
describe('[SMOKE] DI Health', () => {
  it('can resolve MyService', async () => {
    await initializeContainer();
    expect(() => container.resolve(DI.Services.MyService)).not.toThrow();
  });
});
```

---

###  Mistake 3: Slow Integration Tests

```typescript
// BAD - Real file I/O in integration test
await setupIntegrationTest({
  storage: new FileWorkflowStorage('./workflows')
});

// GOOD - In-memory storage is fast but realistic
await setupIntegrationTest({
  storage: new InMemoryWorkflowStorage()
});
```

---

## When in Doubt

**Ask yourself:**

1. **Am I testing that a service can be constructed?**
    - YES → [SMOKE]

2. **Am I testing that 2+ services work together?**
    - YES → Do I need their REAL behavior or can I mock?
        - REAL → [INTEGRATION]
        - MOCK → [UNIT]

3. **Am I testing a single function's logic?**
    - YES → [UNIT]

4. **Am I testing memory/performance under load?**
    - YES → [PERF]

---

## Tier Migration Guide

### Moving from [UNIT] to [INTEGRATION]

```typescript
// Before: Unit test with mocks
beforeEach(async () => {
  await setupTest({ 
    mocks: { [DI.Infra.ValidationEngine]: mockValidator }
  });
});

// After: Integration test with real services
beforeEach(async () => {
  const storage = new InMemoryWorkflowStorage();
  await setupIntegrationTest({ storage });
});
// Now uses REAL ValidationEngine
```

### Moving from [INTEGRATION] to [SMOKE]

```typescript
// Before: Integration test checking if service exists
it('creates validation engine', async () => {
  await setupIntegrationTest();
  const engine = resolveService(DI.Infra.ValidationEngine);
  expect(engine).toBeDefined();
});

// After: Smoke test
it('can resolve ValidationEngine', async () => {
  await initializeContainer();
  expect(() => container.resolve(DI.Infra.ValidationEngine)).not.toThrow();
});
```

---

## Visual Reminder

```
┌─────────────────────────────────────────┐
│         INTEGRATION TESTS               │
│                                         │
│   DO:                                 │
│    - Mock storage                       │
│    - Mock feature flags                 │
│    - Mock HTTP clients                  │
│                                         │
│   DON'T:                              │
│    - Mock ValidationEngine              │
│    - Mock LoopStackManager              │
│    - Mock business logic services       │
│                                         │
│  Rule: Only mock I/O boundaries!        │
└─────────────────────────────────────────┘
```

---

**Questions?** See `tests/README.md` or ask the test architecture owner.
