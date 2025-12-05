# Feature Flags System

## Overview

WorkRail uses a **feature flag system** to enable trunk-based development and safe, incremental releases. Features can be merged to `main` with flags **OFF by default**, tested in production environments, and enabled when stable.

## Philosophy

### Trunk-Based Development

```
main (always releasable)
  ↑
  └─ feature/session-tools (merged after 1 day, flag=off)
  └─ feature/new-workflow (merged after 2 days, flag=off)
  └─ fix/bug-123 (merged immediately, no flag needed)
```

**Benefits:**
- No long-lived branches
- No merge conflicts
- Continuous integration
- Fast feedback loops
- Safe releases (experimental features hidden)

### Clean Architecture

The feature flag system follows SOLID principles:

- **Single Responsibility**: Only manages feature configuration
- **Open/Closed**: Add new flags without modifying existing code
- **Liskov Substitution**: Different providers are interchangeable
- **Interface Segregation**: Focused, minimal interface
- **Dependency Injection**: Testable, no global state

## Usage

### For Users

#### Enable a Feature via Environment Variable

```bash
# Enable session management tools
export WORKRAIL_ENABLE_SESSION_TOOLS=true

# Enable experimental workflows
export WORKRAIL_ENABLE_EXPERIMENTAL_WORKFLOWS=true

# Enable verbose logging
export WORKRAIL_VERBOSE_LOGGING=true

# Start MCP server
node dist/mcp-server.js
```

#### Check Available Features

When the MCP server starts, it logs enabled features:

```
[FeatureFlags] Session tools disabled (enable with WORKRAIL_ENABLE_SESSION_TOOLS=true)
[FeatureFlags] Experimental features enabled: experimentalWorkflows
```

#### Accepted Boolean Values

The following values are recognized as `true`:
- `true`, `TRUE`
- `1`
- `yes`, `YES`
- `on`, `ON`

The following values are recognized as `false`:
- `false`, `FALSE`
- `0`
- `no`, `NO`
- `off`, `OFF`
- (undefined/not set)

### For Developers

#### Check if a Feature is Enabled

```typescript
import { IFeatureFlagProvider } from './config/feature-flags.js';

class MyService {
  constructor(private featureFlags: IFeatureFlagProvider) {}
  
  async doSomething() {
    if (this.featureFlags.isEnabled('sessionTools')) {
      // Session tools enabled - use them
      await this.useSessionTools();
    } else {
      // Session tools disabled - use alternative
      await this.useAlternative();
    }
  }
}
```

#### Add a New Feature Flag

1. Add to `FEATURE_FLAG_DEFINITIONS` in `src/config/feature-flags.ts`:

```typescript
export const FEATURE_FLAG_DEFINITIONS: ReadonlyArray<FeatureFlagDefinition> = [
  // ... existing flags ...
  {
    key: 'myNewFeature',
    envVar: 'WORKRAIL_ENABLE_MY_NEW_FEATURE',
    defaultValue: false, // OFF by default for experimental features
    description: 'Enable my new experimental feature',
    since: '0.7.0',
    stable: false, // Mark true when production-ready
  },
];
```

2. TypeScript automatically provides type safety - no additional changes needed!

3. Use in your code:

```typescript
if (featureFlags.isEnabled('myNewFeature')) {
  // Feature code here
}
```

#### Testing with Feature Flags

```typescript
import { createAppContainer } from './container.js';
import { StaticFeatureFlagProvider } from './config/feature-flags.js';

describe('MyFeature', () => {
  it('works when feature is enabled', () => {
    // Inject test-specific feature flags
    const container = createAppContainer({
      featureFlags: new StaticFeatureFlagProvider({
        myNewFeature: true,
      }),
    });
    
    // Test with feature enabled
    expect(container.featureFlags.isEnabled('myNewFeature')).toBe(true);
  });
  
  it('uses fallback when feature is disabled', () => {
    const container = createAppContainer({
      featureFlags: new StaticFeatureFlagProvider({
        myNewFeature: false,
      }),
    });
    
    // Test with feature disabled
    expect(container.featureFlags.isEnabled('myNewFeature')).toBe(false);
  });
});
```

## Available Feature Flags

### `sessionTools`

**Environment Variable:** `WORKRAIL_ENABLE_SESSION_TOOLS`  
**Default:** `false` (experimental)  
**Since:** `0.6.0`

Enables session management tools:
- `workrail_create_session`
- `workrail_update_session`
- `workrail_read_session`
- `workrail_open_dashboard`

Also starts the HTTP dashboard server.

### `experimentalWorkflows`

**Environment Variable:** `WORKRAIL_ENABLE_EXPERIMENTAL_WORKFLOWS`  
**Default:** `false` (experimental)  
**Since:** `0.6.1`

Loads workflows from the `workflows/experimental/` directory in addition to stable workflows.

### `verboseLogging`

**Environment Variable:** `WORKRAIL_VERBOSE_LOGGING`  
**Default:** `false` (stable)  
**Since:** `0.6.0`

Enables detailed debug logging throughout the application.

## Release Workflow

### Phase 1: Development (Feature Flag OFF)

```bash
# 1. Develop feature in short-lived branch
git checkout -b feature/my-feature

# 2. Add feature flag to code
# 3. Implement feature behind flag
# 4. Add tests
# 5. Merge to main (flag OFF by default)
git checkout main
git merge feature/my-feature

# Feature is in production code but disabled
```

### Phase 2: Testing (Feature Flag ON for specific users)

```bash
# Test in staging/dev environment
export WORKRAIL_ENABLE_MY_FEATURE=true
node dist/mcp-server.js

# Power users can opt-in to test
```

### Phase 3: Stabilization (Ready for Release)

```typescript
// Change default from false to true in feature-flags.ts
{
  key: 'myFeature',
  defaultValue: true, // ← Changed from false to true
  stable: true,       // ← Mark as stable
}
```

### Phase 4: Cleanup (Remove Flag)

After feature is stable for several releases:

```typescript
// Remove feature flag check
// Before:
if (featureFlags.isEnabled('myFeature')) {
  doNewThing();
} else {
  doOldThing();
}

// After:
doNewThing(); // Feature is now default, remove flag
```

## Architecture

### Component Diagram

```
┌─────────────────────────────────────┐
│    Environment Variables            │
│  (WORKRAIL_ENABLE_SESSION_TOOLS)    │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  EnvironmentFeatureFlagProvider     │
│  (reads env, parses booleans)       │
└──────────────┬──────────────────────┘
               │
               │ implements
               ▼
┌─────────────────────────────────────┐
│    IFeatureFlagProvider (interface) │
│  - isEnabled(key)                   │
│  - getAll()                         │
│  - getSummary()                     │
└──────────────┬──────────────────────┘
               │
               │ injected into
               ▼
┌─────────────────────────────────────┐
│      Application Container          │
│  (Dependency Injection)             │
└──────────────┬──────────────────────┘
               │
               │ provides to
               ▼
┌─────────────────────────────────────┐
│    Services (MCP Server, etc.)      │
│  (check flags at runtime)           │
└─────────────────────────────────────┘
```

### Key Design Decisions

1. **Immutability**: Flags are read once at startup (MCP restarts are fast)
2. **Type Safety**: TypeScript provides autocomplete and compile-time checking
3. **No Dynamic Toggling**: Not needed for MCP (unlike web apps with persistent connections)
4. **Dependency Injection**: Easy testing, no global state
5. **Interface-Based**: Easy to add new providers (remote config, database, etc.)

## FAQ

### Why not use a library (LaunchDarkly, Unleash, etc.)?

Feature flag SaaS products are designed for:
- Dynamic toggling without restarts
- A/B testing across millions of users
- Complex targeting rules
- Analytics and experimentation

WorkRail's needs are simpler:
- Enable/disable tools in MCP server
- Config via environment variables
- Read once at startup
- ~5 flags total

A 30-line in-house solution is simpler, faster, and has zero dependencies.

### Can I toggle flags without restarting?

No. MCP servers are stateless and restart instantly, so dynamic toggling isn't needed. Just restart the MCP server with new environment variables.

### How do I test multiple flag combinations?

Use `StaticFeatureFlagProvider` in tests:

```typescript
const container = createAppContainer({
  featureFlags: new StaticFeatureFlagProvider({
    feature1: true,
    feature2: false,
    feature3: true,
  }),
});
```

### When should I remove a feature flag?

After the feature has been:
1. Enabled by default for at least 2 releases
2. Proven stable in production
3. No user reports of issues
4. No need to disable it anymore

Then remove the flag and the conditional code.

## References

- [Trunk-Based Development](https://trunkbaseddevelopment.com/)
- [Feature Toggles (Martin Fowler)](https://martinfowler.com/articles/feature-toggles.html)
- [SOLID Principles](https://en.wikipedia.org/wiki/SOLID)

