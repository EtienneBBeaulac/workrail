# Design: Isolating Integration Tests from ~/.workrail/config.json

**Status:** Draft  
**Date:** 2026-04-06  
**Scope:** `src/config/config-file.ts`, `src/di/container.ts`, `src/mcp/v2-response-formatter.ts`, `src/v2/durable-core/domain/prompt-renderer.ts`, and all test infrastructure under `tests/`

---

## Problem

WorkRail reads `~/.workrail/config.json` at container initialization and merges it into `process.env` before constructing any services. This is correct behavior for production; the file is the mechanism for user-level defaults.

The problem is that integration tests that spin up an in-process server (`startHttpServer`, `initializeContainer`) are now sensitive to whatever the developer has set in their personal config file. The concrete breakage: `tests/integration/mcp-http-transport.test.ts` started failing when the developer has `WORKRAIL_CLEAN_RESPONSE_FORMAT=true` in their config, because the test asserts against the default (non-clean) response format.

A workaround was added (`process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT = 'false'`) and then reverted, which is the correct instinct: the workaround is the wrong fix. The test is correct; the isolation contract is wrong.

---

## Landscape: what exists today

### The config loading flow

1. `mcp-server.ts` / `stdio-entry.ts` / `http-entry.ts` call `composeServer()` -> `bootstrap()` -> `initializeContainer()`.
2. `initializeContainer()` calls `registerConfig()`.
3. `registerConfig()` calls `loadWorkrailConfigFile()`, which reads `~/.workrail/config.json` unconditionally.
4. The result is merged as `mergedEnv = { ...configFileValues, ...process.env }` (env wins, file provides defaults).
5. `mergedEnv` is used to construct `AppConfig` and `CustomEnvFeatureFlagProvider`.
6. `mergedEnv` is captured by closure and passed to `LocalDataDirV2`.

### The VITEST guard that exists -- and the one that doesn't

`config-file.ts` has no VITEST guard on `loadWorkrailConfigFile`. The comment in the problem statement says "note the VITEST guard on `ensureWorkrailConfigFile` but NOT on `loadWorkrailConfigFile`". The current code has no `ensureWorkrailConfigFile` function at all -- it was either removed or not yet added. What _does_ exist is:

- `detectRuntimeMode()` in `container.ts` correctly detects `process.env.VITEST` to set `RuntimeMode = 'test'`.
- `test-container.ts` (`setupTest`) pre-registers `DI.Config.App` before calling `initializeContainer`, which causes `registerConfig()` to skip the `loadConfig` call via the `if (!container.isRegistered(DI.Config.App))` guard.
- The same guard also causes `registerConfig()` to skip registering `FeatureFlags` if already registered.

So `setupTest()` already correctly bypasses config file injection for tests that use `test-container.ts`. The problem is tests that do NOT use `setupTest()` and instead call `initializeContainer()` directly.

### The direct `process.env` reads (the deeper problem)

Two source files read `process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT` directly, bypassing the DI system entirely:

- `src/mcp/v2-response-formatter.ts` line 409: `return process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT === 'true';`
- `src/v2/durable-core/domain/prompt-renderer.ts` line 468: `const cleanResponseFormat = process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT === 'true';`

This means that even if the DI container is correctly isolated, these two functions will still pick up the developer's personal config setting -- because `loadWorkrailConfigFile()` writes into `mergedEnv`, not `process.env`. Wait: this means the two `process.env` direct reads would NOT be affected by the config file, because `loadWorkrailConfigFile()` only populates `mergedEnv` (a module-level variable in `container.ts`), not `process.env` itself. So the direct `process.env` reads are a separate (but related) violation of the DI contract: they bypass both `mergedEnv` and the feature flag system.

### How the developer's config.json actually reaches the test

The developer has `WORKRAIL_CLEAN_RESPONSE_FORMAT=true` in `~/.workrail/config.json`. When `mcp-http-transport.test.ts` calls `startHttpServer(HTTP_PORT)`, the call chain is:

`startHttpServer` -> `composeServer` -> `bootstrap` -> `initializeContainer` -> `registerConfig` -> `loadWorkrailConfigFile` -> reads `~/.workrail/config.json` -> merges into `mergedEnv` -> constructs `CustomEnvFeatureFlagProvider(mergedEnv)` -> `featureFlags.isEnabled('cleanResponseFormat')` returns `true`.

But the direct `process.env` reads in `v2-response-formatter.ts` and `prompt-renderer.ts` read from `process.env`, not `mergedEnv`. Since the developer's config sets `WORKRAIL_CLEAN_RESPONSE_FORMAT=true` in the config file (not in `process.env` directly), these two direct reads would actually return `false` even when the DI feature flag says `true`. This is an existing inconsistency: the feature flag system and the direct `process.env` reads diverge.

The immediate test failure is through the DI path (the feature flags system sees `cleanResponseFormat=true` via `mergedEnv`), not through the direct reads. But both paths represent the same underlying problem.

### Tests that call `initializeContainer()` directly (the affected set)

The following tests call `initializeContainer()` without pre-registering config, and are therefore exposed to the developer's `~/.workrail/config.json`:

- `tests/integration/mcp-http-transport.test.ts` -- confirmed broken
- `tests/integration/process-cleanup.test.ts` -- calls `initializeContainer()` in `beforeAll`, no env setup
- `tests/integration/tsyringe-di.test.ts` -- calls `initializeContainer()` in each `beforeEach`
- `tests/integration/bug-fixes-integration.test.ts` -- calls `initializeContainer()` directly
- `tests/integration/unified-dashboard.test.ts` -- calls `initializeContainer()` in `beforeAll`
- `tests/smoke/di-container.smoke.test.ts` -- calls `initializeContainer()` multiple times
- `tests/contract/transport-equivalence.test.ts` -- calls `bootstrap()` directly
- `tests/unit/git-worktree.test.ts` -- calls `initializeContainer()`
- `tests/performance/cache-eviction.test.ts` -- calls `initializeContainer()`

Tests that use `setupTest()` (from `test-container.ts`) are protected because they pre-register `DI.Config.App`, which blocks the config-file loading path in `registerConfig()`.

---

## Candidate solutions

### Option A: VITEST guard on `loadWorkrailConfigFile`

Add an early return in `loadWorkrailConfigFile()` when running under Vitest:

```typescript
export function loadWorkrailConfigFile(): Result<Record<string, string>, ConfigFileError> {
  if (process.env.VITEST) {
    return ok({});
  }
  // ... existing logic
}
```

**Pros:**
- Single-line fix; zero ripple to test infrastructure.
- Consistent with the `detectRuntimeMode` pattern already in `container.ts`.
- Eliminates the entire class of failures for all tests at once.
- No test changes required.

**Cons:**
- Makes `loadWorkrailConfigFile()` impure (it inspects a runtime sentinel that's external to its inputs). This violates "determinism over cleverness" and "validate at boundaries, trust inside".
- Tests cannot exercise the config-file loading path.
- If someone later adds a smoke test for config file loading, it silently does nothing.

---

### Option B: VITEST guard in `registerConfig()` in `container.ts`

Instead of guarding the load function itself, guard the merge step in the composition root:

```typescript
async function registerConfig(): Promise<void> {
  const isTestEnv = Boolean(process.env.VITEST);
  const configFileValues: Record<string, string> = isTestEnv
    ? {}
    : (() => {
        const r = loadWorkrailConfigFile();
        return r.kind === 'ok' ? r.value : {};
      })();
  mergedEnv = { ...configFileValues, ...process.env };
  // ... rest unchanged
}
```

**Pros:**
- `loadWorkrailConfigFile()` stays pure; it can be tested independently.
- The guard is in the composition root, which is the correct place for runtime-mode decisions (consistent with `detectRuntimeMode`).
- Same single-point fix; all affected tests healed at once.

**Cons:**
- Same testability concern: tests cannot exercise the "config file loaded and merged" initialization path.
- Relies on `process.env.VITEST` being set, which is true for Vitest tests but may not be true for other test runners if the project ever changes.

---

### Option C: Accept an explicit env override in `initializeContainer`

Extend `ContainerInitOptions` to accept an env map, and use it instead of `process.env` + config file when provided:

```typescript
export interface ContainerInitOptions {
  readonly runtimeMode?: RuntimeMode;
  readonly env?: Record<string, string | undefined>;  // explicit env; bypasses config file
}
```

In `registerConfig()`:

```typescript
async function registerConfig(env?: Record<string, string | undefined>): Promise<void> {
  if (env !== undefined) {
    // Caller provided explicit env; skip config file loading entirely.
    mergedEnv = env;
  } else {
    const configFileValues = loadWorkrailConfigFile().kind === 'ok' ? ... : {};
    mergedEnv = { ...configFileValues, ...process.env };
  }
  // ... rest unchanged
}
```

Tests that want isolation:

```typescript
await initializeContainer({ runtimeMode: { kind: 'test' }, env: { ...process.env } });
```

Or a clean env:

```typescript
await initializeContainer({
  runtimeMode: { kind: 'test' },
  env: { WORKRAIL_ENABLE_SESSION_TOOLS: 'false', WORKRAIL_ENABLE_V2_TOOLS: 'true' },
});
```

**Pros:**
- Makes test env state explicit and declarative: the reader sees exactly what env the test is running with.
- Honors "validate at boundaries, trust inside": the container is now a pure function of its inputs.
- No sentinel (VITEST) check required; the mechanism is compositional.
- Tests can exercise config-file loading separately by calling `loadWorkrailConfigFile()` directly.
- Compatible with `test-container.ts` / `setupTest()` patterns without changes.
- The `env` opt-in means existing production code paths are unchanged.

**Cons:**
- Requires updating `initializeContainer` signature (non-breaking; new optional field).
- Test files that call `initializeContainer()` directly need to be updated to pass `env` -- or a convenience default (e.g., skip config file when `runtimeMode.kind === 'test'`) handles it automatically.
- `mcp-http-transport.test.ts` bypasses `initializeContainer` entirely (it calls `startHttpServer`, which calls `bootstrap`); this option alone doesn't fix that without also threading `env` through `bootstrap` and the entry points.

---

### Option D: Whitelist approach -- tests declare the flags they require

Rather than suppressing the config file, tests explicitly declare the feature-flag state they need by always pre-registering flags via `setupTest()` or equivalent:

Mandate that every integration test that uses the container calls `setupTest()` (or `setupIntegrationTest()`), and add a lint rule or CI check that flags direct `initializeContainer()` calls in test files without prior config registration.

**Pros:**
- No change to production code.
- Forces test authors to be explicit about required state.
- Consistent with existing pattern in `test-container.ts`.

**Cons:**
- Requires changes to ~10 test files that currently call `initializeContainer()` directly.
- Does not address `mcp-http-transport.test.ts`, which bypasses the container entirely via `startHttpServer`.
- Fragile: requires process discipline rather than a structural constraint. New test files can regress.
- Does not address the `prompt-renderer.ts` and `v2-response-formatter.ts` `process.env` direct reads.

---

### Option E: Propagate `mergedEnv` as an injected dependency

Make the merged env an explicit DI token, and pass it through to all consumers (including `LocalDataDirV2`, `EnvironmentFeatureFlagProvider`, `prompt-renderer`, `v2-response-formatter`).

**Pros:**
- Architecturally correct: environment becomes an explicit, injectable dependency.
- Enables all consumers to be tested with a controlled env.
- Eliminates the direct `process.env` reads in `prompt-renderer.ts` and `v2-response-formatter.ts`.

**Cons:**
- Large-footprint change: all consumers of env vars need to receive the injected env rather than reading `process.env` directly.
- `prompt-renderer.ts` is domain logic; adding an env token as a DI dependency pollutes it.
- High effort relative to the benefit; over-engineered for the immediate problem.

---

## Analysis and selection

### The real root cause

The root cause has two layers:

1. **Primary:** `loadWorkrailConfigFile()` is called unconditionally in `registerConfig()`, including when VITEST is set and a developer is running tests. This is the structural invariant that must change.

2. **Secondary:** `prompt-renderer.ts` and `v2-response-formatter.ts` read `process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT` directly, bypassing both the feature flag system and `mergedEnv`. This is a separate violation of the "validate at boundaries, trust inside" principle, but it is NOT the cause of the reported failure (the config file only populates `mergedEnv`, not `process.env`). It would cause failures if someone sets `WORKRAIL_CLEAN_RESPONSE_FORMAT=true` in their shell environment directly. This should be fixed separately.

### Why Option B wins over Option A

Both A and B add a VITEST sentinel check. Option A puts the check inside `loadWorkrailConfigFile()`, which is a leaf function that should be pure. Option B puts the check in `registerConfig()`, which is already a composition-root function that is explicitly allowed to inspect `process.env` for runtime-mode decisions (it already detects `detectRuntimeMode()` for the same reason). The sentinel belongs in the composition root.

### Why Option C is better than Option B in principle, but can be combined

Option C (explicit env override) is architecturally superior to Option B because it eliminates the sentinel entirely. However, it requires touching ~10 test files or extending the entry points, making it higher effort. The pragmatic path is:

**Recommended: Option B as the immediate fix + Option C as a subsequent improvement.**

Option B heals all affected tests immediately with a two-line change to the composition root. Option C can be added incrementally -- `ContainerInitOptions.env` can be introduced as an optional field, and test files can be migrated over time to the explicit form.

### The direct `process.env` reads: fix separately

The direct reads in `prompt-renderer.ts` and `v2-response-formatter.ts` should be corrected separately. The correct fix is to route the `cleanResponseFormat` flag through the DI feature flag system instead of reading `process.env` directly. This is already partially done: `prompt-renderer.ts`'s `renderPromptForNodeV2` accepts `args.cleanResponseFormat` per a comment (though the current implementation still reads `process.env`). The feature flag should be resolved once at the handler level and passed down into the domain function as a plain `boolean`. This is consistent with "dependency injection for boundaries" and "determinism over cleverness".

---

## Recommended solution

### Immediate fix (Option B)

In `src/di/container.ts`, add a VITEST guard in `registerConfig()`:

```typescript
async function registerConfig(): Promise<void> {
  // In test environments, skip loading the user's personal config file.
  // process.env takes full effect; tests set what they need explicitly.
  // (VITEST is set by the test runner in all vitest-managed processes.)
  const isTestEnv = Boolean(process.env.VITEST);
  const configFileValues: Record<string, string> = isTestEnv
    ? {}
    : (() => {
        const r = loadWorkrailConfigFile();
        return r.kind === 'ok' ? r.value : {};
      })();
  mergedEnv = { ...configFileValues, ...process.env };

  // ... rest of registerConfig unchanged
}
```

This is a two-line addition that is fully consistent with the existing `detectRuntimeMode()` pattern, requires no test changes, and eliminates the entire class of failures.

### Follow-up fix: remove direct `process.env` reads

In `src/mcp/v2-response-formatter.ts` and `src/v2/durable-core/domain/prompt-renderer.ts`, remove the direct `process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT` reads.

For `v2-response-formatter.ts`: the function `isCleanResponseFormat()` should accept the flag as a parameter or be replaced by passing the flag from the caller who already has access to the feature flags via DI.

For `prompt-renderer.ts`: the `renderPromptForNodeV2` function already has the infrastructure to accept `args.cleanResponseFormat` (per the comment at the call site). The implementation should use `args.cleanResponseFormat ?? false` rather than re-reading `process.env`. The caller (the handler or usecase layer) is responsible for resolving `cleanResponseFormat` from `featureFlags.isEnabled('cleanResponseFormat')` and passing it down.

This is consistent with "dependency injection for boundaries" and removes all direct `process.env` reads from domain logic.

### Optional improvement: explicit env override in `ContainerInitOptions`

Add `env?: Record<string, string | undefined>` to `ContainerInitOptions` so tests can opt into fully declarative env. This makes the whitelist pattern (Option D) possible without process discipline: tests that need specific flag states pass them explicitly in the env override, and the absence of the override triggers the VITEST guard. Migration of existing tests to the explicit form can happen incrementally.

---

## Implementation plan

### Phase 1 (immediate, 1 file, ~5 lines)

1. In `src/di/container.ts`, add the VITEST guard in `registerConfig()` as described above.
2. Verify `tests/integration/mcp-http-transport.test.ts` passes without any `process.env` overrides.
3. Run the full test suite to confirm no regressions.

### Phase 2 (follow-up, 2 files, ~20 lines)

1. In `src/mcp/v2-response-formatter.ts`, change `isCleanResponseFormat()` to accept `cleanFormat: boolean` as a parameter. Thread it from wherever the function is called (likely from a handler that already has feature flag access).
2. In `src/v2/durable-core/domain/prompt-renderer.ts`, change line 468 from reading `process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT` to using `args.cleanResponseFormat ?? false`. Ensure all callers pass the flag down from the feature flags system.
3. Add a test that exercises `prompt-renderer.ts` with `cleanResponseFormat: true` explicitly, so the behavior is covered at the unit level.

### Phase 3 (optional, ~1 day)

1. Add `env?: Record<string, string | undefined>` to `ContainerInitOptions`.
2. In `registerConfig()`, if `options.env` is provided, use it as `mergedEnv` directly (no config file loading).
3. Migrate `mcp-http-transport.test.ts` to use `env` explicitly in its setup.
4. Document the pattern in `tests/di/test-container.ts` comments.

---

## Confidence and residual risks

**Confidence:** High that Option B (VITEST guard) eliminates the reported failure class and all similar failures. The guard is conservative: it only skips the config file; tests still receive `process.env`, so any env vars set explicitly (e.g., `WORKRAIL_ENABLE_V2_TOOLS=true` in `mcp-http-transport.test.ts`'s `beforeAll`) continue to work.

**Risk 1:** Tests that intentionally test config file loading behavior (e.g., a future smoke test for `loadWorkrailConfigFile`) will be unaffected by the guard because the guard is in `registerConfig()`, not in `loadWorkrailConfigFile()` itself. Those tests should call `loadWorkrailConfigFile()` directly rather than going through `initializeContainer()`.

**Risk 2:** If a test needs to verify that the config file is applied during container init (integration between `loadWorkrailConfigFile` and `registerConfig`), it would need to temporarily unset `VITEST`, which is not practical. The recommended approach for that case is to call `loadWorkrailConfigFile()` and `loadConfig()` in the test directly, bypassing the container.

**Risk 3:** The direct `process.env` reads in `prompt-renderer.ts` and `v2-response-formatter.ts` remain a latent source of test sensitivity until Phase 2 is complete. A developer who sets `WORKRAIL_CLEAN_RESPONSE_FORMAT=true` in their shell (not just in `config.json`) can still cause test failures in tests that don't explicitly set that env var. Phase 2 is therefore important, not just cosmetic.

---

## What this is NOT

This design does not address:
- Parallelism issues between tests that call `initializeContainer()` concurrently without going through the mutex in `integration-container.ts`.
- The broader question of whether all integration tests should use `setupTest()`. That is a code quality concern, not a blocking correctness issue.
- Project-level `.workrail/config.json` files (these do not currently exist in the codebase).
