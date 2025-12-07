# ADR-005: pino Logging Architecture

## Status

Accepted - Implemented December 2025

## Context

WorkRail had inconsistent logging patterns:

- Custom `Logger` class used by some services
- Raw `console.*` calls in ~50% of codebase
- Logger not injectable via DI
- No structured logging for machine parsing
- No automatic redaction of sensitive data

Compared against CTC MCP project which uses pino with full DI integration.

## Decision

Adopt **pino** for structured logging with DI integration:

### Core Decisions

1. **Use pino directly** - No wrapper abstraction
    - Type: `Logger` = pino's `Logger` type
    - Gives full pino features without overhead

2. **pino API (data-first)**
   ```typescript
   logger.info({ userId: 123, action: 'login' }, 'User logged in');
   logger.error({ err: error, context: data }, 'Operation failed');
   ```

3. **Logger injected via ILoggerFactory from DI**
   ```typescript
   constructor(@inject(DI.Logging.Factory) loggerFactory: ILoggerFactory) {
     this.logger = loggerFactory.create('ComponentName');
   }
   ```

4. **Output to stderr (stdout reserved for MCP protocol)**
    - Sync writes to fd 2
    - JSON format for machine parsing
    - ISO timestamps

5. **Comprehensive redaction** for security
    - Auto-redacts: token, secret, password, apiKey, authToken
    - Nested patterns: `*.token`, `config.*.authToken`
    - HTTP headers: `headers.authorization`

6. **Backward compatibility** via silent delegation
    - Old `createLogger()` continues to work
    - Internally uses bootstrap logger
    - No deprecation warnings (documented in ADR instead)

7. **Bootstrap logger** for pre-DI code
    - Container initialization uses `createBootstrapLogger('DI')`
    - Factory functions use bootstrap logger
    - After DI ready, use injected logger

8. **ExecutionEnvironment pattern** (from CTC MCP)
    - All handlers receive `ExecutionEnvironment { logger }`
    - `ToolContext extends ExecutionEnvironment`
    - Logger is first-class citizen in all contexts

## Architecture

```
┌─────────────────────────────────────────┐
│ Bootstrap Phase (Pre-DI)                │
│  getBootstrapLogger() → pino instance   │
│  Used by: container.ts, factories       │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│ DI Registration (Phase 1)               │
│  registerLogging() → PinoLoggerFactory  │
│  DI.Logging.Factory → singleton         │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│ Service Construction (Phase 2)          │
│  @inject(DI.Logging.Factory)            │
│  logger = factory.create('Component')   │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│ Execution (Runtime)                     │
│  ctx.logger.info({ data }, 'message')   │
│  Child loggers: logger.child({ tool })  │
└─────────────────────────────────────────┘
```

## Implementation

### New Files

```
src/core/logging/
├── types.ts           # Logger, ILoggerFactory, LogLevel types
├── redaction.ts       # Redaction configuration
├── create-logger.ts   # PinoLoggerFactory implementation
├── bootstrap.ts       # Pre-DI logger
└── index.ts           # Public exports

tests/helpers/
├── FakeLogger.ts           # Fake for testing (captures calls)
├── FakeLoggerFactory.ts    # Fake factory
├── test-container.ts       # DI test helper
└── create-git-storage.ts   # Git storage test helper
```

### Modified Files

**DI Layer:**

- `src/di/tokens.ts` - Added `DI.Logging.Factory` token
- `src/di/container.ts` - Register logging first, use bootstrap logger

**Types:**

- `src/mcp/types.ts` - Added `ExecutionEnvironment`, updated `ToolContext`
- `src/mcp/server.ts` - Create context with logger

**Services (migrated to DI logger):**

- `WorkflowService`
- `WorkflowLoader`
- `StepSelector`
- `LoopStackManager`
- `LoopRecoveryService`
- `IterativeStepResolutionStrategy`
- `SessionWatcherService`
- `EnhancedMultiSourceWorkflowStorage`
- `GitWorkflowStorage`

**Handlers:**

- `src/mcp/handlers/workflow.ts` - Use `ctx.logger`

**Backward Compat:**

- `src/utils/logger.ts` - Wrapper that delegates to pino

## Consequences

### Positive

✅ **Industry-standard logging** - pino is battle-tested, used by major projects  
✅ **Full DI integration** - Logger injectable, testable  
✅ **Structured JSON output** - Machine parseable logs  
✅ **Automatic redaction** - Secrets never logged  
✅ **Child loggers** - Contextual logging with zero overhead  
✅ **Testable** - FakeLogger captures calls for assertions  
✅ **Zero breaking changes** - Old code continues to work  
✅ **Type-safe** - Full TypeScript support

### Negative

⚠️ **API change** - Data-first vs message-first (mitigated by backward compat)  
⚠️ **Migration effort** - 15+ files touched (one-time cost)  
⚠️ **Two systems temporarily** - Bootstrap logger + DI logger (acceptable)

### Neutral

ℹ️ **pino dependency** - 13 packages added (~300KB)  
ℹ️ **Learning curve** - Team needs to learn pino idiom (data-first)  
ℹ️ **Test updates** - Tests need FakeLogger

## Migration Path

### For New Code

```typescript
// Inject logger factory
constructor(@inject(DI.Logging.Factory) loggerFactory: ILoggerFactory) {
  this.logger = loggerFactory.create('MyService');
}

// Use pino API (data-first)
this.logger.info({ workflowId, count }, 'Loaded workflows');
this.logger.error({ err: error }, 'Operation failed');
```

### For Old Code

Old code using `createLogger()` continues to work with zero changes:

```typescript
import { createLogger } from '../../utils/logger';
const logger = createLogger('MyComponent');
// Works! Internally delegates to bootstrap logger
```

### For Tests

```typescript
import { FakeLoggerFactory } from '../helpers/FakeLoggerFactory.js';

const loggerFactory = new FakeLoggerFactory();
const service = new MyService(deps, loggerFactory);

// Assert on logs
const logger = loggerFactory.getLogger('MyService');
expect(logger.hasEntry('info', 'Operation completed')).toBe(true);
```

## Alternatives Considered

### Keep Custom Logger

**Rejected:** Not industry-standard, missing features (redaction, performance)

### Use winston

**Rejected:** Heavier, slower than pino, less TypeScript-friendly

### Use bunyan

**Rejected:** Unmaintained, pino is spiritual successor

### Use awilix instead of tsyringe

**Rejected:** Switching DI containers is high risk, low benefit. Both work well.

### Message-first API wrapper

**Rejected:** Abstractions add overhead. Better to adopt pino idiom.

## References

- CTC MCP Architecture:
  `/Users/etienneb/git/zillow/codified-test-cases-codegen/mcp/.vscode/ARCHITECTURE.md`
- pino documentation: https://getpino.io/
- MCP Protocol Spec: stdout for protocol, stderr for logs
