# Feature Flags Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     ENVIRONMENT VARIABLES                       │
│                                                                 │
│  WORKRAIL_ENABLE_SESSION_TOOLS=true                            │
│  WORKRAIL_ENABLE_EXPERIMENTAL_WORKFLOWS=false                  │
│  WORKRAIL_VERBOSE_LOGGING=false                                │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ reads at startup
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│            EnvironmentFeatureFlagProvider                       │
│                                                                 │
│  • Parses environment variables                                │
│  • Validates boolean values                                    │
│  • Creates immutable flag map                                  │
│  • Logs enabled experimental features                          │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ implements
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              IFeatureFlagProvider (Interface)                   │
│                                                                 │
│  isEnabled(key: FeatureFlagKey): boolean                       │
│  getAll(): FeatureFlags                                        │
│  getSummary(): string                                          │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ injected into
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Application Container                        │
│                   (Dependency Injection)                        │
│                                                                 │
│  {                                                              │
│    featureFlags: IFeatureFlagProvider,                         │
│    storage: IWorkflowStorage,                                  │
│    workflowService: WorkflowService,                           │
│    validationEngine: ValidationEngine,                         │
│    ...                                                          │
│  }                                                              │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ provides to
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                 WorkflowOrchestrationServer                     │
│                                                                 │
│  constructor(container?: AppContainer) {                       │
│    this.featureFlags = container.featureFlags;                 │
│                                                                 │
│    if (this.featureFlags.isEnabled('sessionTools')) {          │
│      // Initialize session tools                               │
│      this.sessionTools = createSessionTools(...);              │
│    } else {                                                     │
│      this.sessionTools = [];                                   │
│    }                                                            │
│  }                                                              │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ registers
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                         MCP Tools                               │
│                                                                 │
│  ┌─────────────────────┐  ┌────────────────────────────┐      │
│  │   Core Tools        │  │  Conditional Tools         │      │
│  │   (always enabled)  │  │  (feature flag gated)      │      │
│  ├─────────────────────┤  ├────────────────────────────┤      │
│  │ • workflow_list     │  │ • workrail_create_session  │      │
│  │ • workflow_get      │  │ • workrail_update_session  │      │
│  │ • workflow_next     │  │ • workrail_read_session    │      │
│  │ • workflow_validate │  │ • workrail_open_dashboard  │      │
│  └─────────────────────┘  └────────────────────────────┘      │
│                                                                 │
│  Tools are only registered if feature flag is enabled          │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow: Feature Check

```
Agent calls tool
      │
      ▼
MCP Server receives request
      │
      ▼
Is tool name "workrail_*"?
      │
      ├─── No ──► Route to workflow tools
      │
      └─── Yes ─► Check feature flag
                       │
                       ▼
            featureFlags.isEnabled('sessionTools')?
                       │
                       ├─── true ──► Execute session tool
                       │             Return result
                       │
                       └─── false ─► Return error
                                     "Session tools not enabled.
                                      Set WORKRAIL_ENABLE_SESSION_TOOLS=true"
```

## Testing Flow: Dependency Injection

```
┌─────────────────────────────────────────────────────────────────┐
│                         PRODUCTION                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  const container = createAppContainer();                       │
│  // Uses EnvironmentFeatureFlagProvider                        │
│  // Reads from process.env                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                          TESTING                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  const testFlags = new StaticFeatureFlagProvider({             │
│    sessionTools: true,        // ← Explicit test values        │
│    experimentalWorkflows: false,                               │
│  });                                                            │
│                                                                 │
│  const container = createAppContainer({                        │
│    featureFlags: testFlags,   // ← Inject test provider        │
│  });                                                            │
│                                                                 │
│  // Tests run with known, predictable flag values              │
│  // No environment manipulation needed                         │
│  // Fast, isolated, deterministic                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Class Diagram

```
┌──────────────────────────────────────────────────────┐
│         <<interface>>                                │
│         IFeatureFlagProvider                         │
├──────────────────────────────────────────────────────┤
│ + isEnabled(key: FeatureFlagKey): boolean           │
│ + getAll(): FeatureFlags                            │
│ + getSummary(): string                              │
└─────────────────┬────────────────────────────────────┘
                  │
                  │ implements
       ┏━━━━━━━━━━┻━━━━━━━━━━┓
       ▼                      ▼
┌──────────────────┐  ┌────────────────────┐
│ Environment      │  │ Static             │
│ FeatureFlag      │  │ FeatureFlag        │
│ Provider         │  │ Provider           │
├──────────────────┤  ├────────────────────┤
│ - flags: Map     │  │ - flags: Map       │
├──────────────────┤  ├────────────────────┤
│ Production use   │  │ Testing use        │
│ Reads env vars   │  │ Explicit values    │
│ At startup       │  │ No I/O             │
└──────────────────┘  └────────────────────┘
```

## Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                    APPLICATION STARTUP                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. Read Environment Variables                                  │
│     - WORKRAIL_ENABLE_SESSION_TOOLS                            │
│     - WORKRAIL_ENABLE_EXPERIMENTAL_WORKFLOWS                   │
│     - WORKRAIL_VERBOSE_LOGGING                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Parse & Validate                                            │
│     - true/1/yes/on → true                                     │
│     - false/0/no/off/undefined → false                         │
│     - Invalid values → warn + use default                      │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Create Immutable Flag Map                                   │
│     {                                                           │
│       sessionTools: false,                                     │
│       experimentalWorkflows: false,                            │
│       verboseLogging: false,                                   │
│     }                                                           │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Log Enabled Experimental Features                           │
│     [FeatureFlags] Session tools disabled                      │
│     [FeatureFlags] (enable with WORKRAIL_ENABLE_SESSION_TOOLS)│
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. Inject into Container                                       │
│     container.featureFlags = provider                          │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  6. Services Check Flags at Runtime                             │
│     if (featureFlags.isEnabled('sessionTools')) { ... }        │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  7. MCP Server Ready                                            │
│     Tools registered based on enabled features                 │
└─────────────────────────────────────────────────────────────────┘
```

## Decision Tree: Adding a New Feature

```
                    ┌───────────────────┐
                    │ New Feature Ready │
                    └─────────┬─────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │ Is it stable?     │
                    └─────────┬─────────┘
                              │
                 ┌────────────┴────────────┐
                 │                         │
                 ▼                         ▼
          ┌─────────────┐          ┌─────────────┐
          │ YES         │          │ NO          │
          │ Stable      │          │ Experimental│
          └──────┬──────┘          └──────┬──────┘
                 │                        │
                 ▼                        ▼
     ┌──────────────────────┐  ┌──────────────────────┐
     │ Add with             │  │ Add with             │
     │ defaultValue: true   │  │ defaultValue: false  │
     │ stable: true         │  │ stable: false        │
     └──────┬───────────────┘  └──────┬───────────────┘
            │                         │
            └────────────┬────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │ Add to               │
              │ FEATURE_FLAG_        │
              │ DEFINITIONS          │
              └──────┬───────────────┘
                     │
                     ▼
              ┌──────────────────────┐
              │ Use in code:         │
              │ if (featureFlags     │
              │   .isEnabled('key')) │
              └──────┬───────────────┘
                     │
                     ▼
              ┌──────────────────────┐
              │ Write tests          │
              │ (enabled & disabled) │
              └──────┬───────────────┘
                     │
                     ▼
              ┌──────────────────────┐
              │ Merge to main        │
              │ (flag OFF by default)│
              └──────┬───────────────┘
                     │
                     ▼
              ┌──────────────────────┐
              │ Test in staging      │
              │ (enable with env var)│
              └──────┬───────────────┘
                     │
                     ▼
              ┌──────────────────────┐
              │ Feature proven       │
              │ stable?              │
              └──────┬───────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
   ┌────────┐              ┌────────────┐
   │ YES    │              │ NO - Iterate│
   └────┬───┘              └────────────┘
        │
        ▼
   ┌────────────────────┐
   │ Flip default to ON │
   │ stable: true       │
   └────┬───────────────┘
        │
        ▼
   ┌────────────────────┐
   │ After 2+ releases  │
   │ Remove flag        │
   └────────────────────┘
```

## SOLID Principles Visualization

```
┌────────────────────────────────────────────────────────────────┐
│  S - Single Responsibility Principle                           │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌───────────────────────────┐                                │
│  │ EnvironmentFeatureFlag    │  One job: Read env vars       │
│  │ Provider                  │  and parse booleans           │
│  └───────────────────────────┘                                │
│                                                                │
│  ┌───────────────────────────┐                                │
│  │ StaticFeatureFlagProvider │  One job: Provide test        │
│  │                           │  values                        │
│  └───────────────────────────┘                                │
│                                                                │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  O - Open/Closed Principle                                     │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Add new flags without modifying existing code:               │
│                                                                │
│  FEATURE_FLAG_DEFINITIONS.push({                              │
│    key: 'newFeature',                                         │
│    envVar: 'WORKRAIL_NEW_FEATURE',                           │
│    defaultValue: false,                                       │
│  });                                                           │
│                                                                │
│  No changes needed to provider classes!                      │
│                                                                │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  L - Liskov Substitution Principle                             │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Any IFeatureFlagProvider implementation works:               │
│                                                                │
│  function useProvider(provider: IFeatureFlagProvider) {       │
│    return provider.isEnabled('sessionTools');                 │
│  }                                                             │
│                                                                │
│  useProvider(new EnvironmentFeatureFlagProvider());         │
│  useProvider(new StaticFeatureFlagProvider());              │
│  useProvider(new CustomProvider());                        │
│                                                                │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  I - Interface Segregation Principle                           │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Focused interface (only 3 methods):                          │
│                                                                │
│  interface IFeatureFlagProvider {                             │
│    isEnabled(key): boolean;    ← Most used                   │
│    getAll(): FeatureFlags;     ← Bulk access                 │
│    getSummary(): string;       ← Debugging                   │
│  }                                                             │
│                                                                │
│  No bloat, no unused methods                                 │
│                                                                │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  D - Dependency Inversion Principle                            │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────┐                                     │
│  │ WorkflowServer       │  Depends on abstraction             │
│  │ (High-level)         │  (not concrete class)              │
│  └──────────┬───────────┘                                     │
│             │                                                  │
│             ▼                                                  │
│  ┌──────────────────────┐                                     │
│  │ IFeatureFlagProvider │  ← Interface (abstraction)         │
│  └──────────┬───────────┘                                     │
│             │                                                  │
│             ▼                                                  │
│  ┌──────────────────────┐                                     │
│  │ EnvironmentFeature   │  Concrete implementation           │
│  │ FlagProvider         │  depends on interface              │
│  └──────────────────────┘                                     │
│                                                                │
│  Easy to swap implementations                                │
│  Easy to test                                                │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Comparison: Before vs After

### Before (Hardcoded Comments)

```typescript
class WorkflowOrchestrationServer {
  constructor() {
    //  Manual commenting/uncommenting
    //  Not testable
    //  Blocks releases
    
    // Initialize session management (DISABLED for release)
    // TODO: Re-enable session tools when ready for production
    this.sessionManager = new SessionManager();
    this.httpServer = new HttpServer(this.sessionManager);
    this.sessionTools = []; // Disabled: createSessionTools(...)
  }
  
  async initialize(): Promise<void> {
    // Start HTTP server (DISABLED for release)
    // TODO: Re-enable when ready
    // await this.httpServer.start();
  }
}
```

### After (Clean Feature Flags)

```typescript
class WorkflowOrchestrationServer {
  constructor(container?: AppContainer) {
    //  Clean boolean check
    //  Fully testable
    //  Never blocks releases
    
    this.container = container ?? createAppContainer();
    this.featureFlags = this.container.featureFlags;
    
    if (this.featureFlags.isEnabled('sessionTools')) {
      this.sessionManager = new SessionManager();
      this.httpServer = new HttpServer(this.sessionManager);
      this.sessionTools = createSessionTools(this.sessionManager, this.httpServer);
    } else {
      this.sessionTools = [];
    }
  }
  
  async initialize(): Promise<void> {
    if (this.featureFlags.isEnabled('sessionTools') && this.httpServer) {
      await this.httpServer.start();
    }
  }
}
```

## Benefits Summary

| Aspect | Before | After |
|--------|--------|-------|
| **Enabling feature** | Edit code, uncomment lines | Set env var |
| **Testing** | Manual mocking, hard to test | Inject `StaticFeatureFlagProvider` |
| **Release blocking** | Yes, must manually disable | No, flags control features |
| **Type safety** | No | Full TypeScript support |
| **Trunk-based dev** | Difficult | Easy |
| **Code cleanliness** | Comments everywhere | Clean conditional logic |
| **Debugging** | Unclear what's disabled | Clear logs |

