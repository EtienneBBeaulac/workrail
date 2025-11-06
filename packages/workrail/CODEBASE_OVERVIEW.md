# WorkRail MCP: Comprehensive Codebase Overview

**Date**: November 3, 2025  
**Version**: 0.6.1-beta.7  
**Status**: Active Development - External Workflow Repositories Branch

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [System Purpose and Philosophy](#system-purpose-and-philosophy)
3. [Architecture Overview](#architecture-overview)
4. [Core Domain Concepts](#core-domain-concepts)
5. [Technology Stack](#technology-stack)
6. [Code Organization](#code-organization)
7. [Key Components Deep Dive](#key-components-deep-dive)
8. [Infrastructure Layer](#infrastructure-layer)
9. [Testing Strategy](#testing-strategy)
10. [Current Development State](#current-development-state)
11. [Design Decisions and Rationale](#design-decisions-and-rationale)
12. [Future Directions](#future-directions)

---

## Executive Summary

**WorkRail** is a Model Context Protocol (MCP) server that guides Large Language Models (LLMs) through structured, proven software engineering workflows. Rather than relying on prompting or hoping LLMs will follow best practices, WorkRail **systematically enforces** them through machine-readable workflow definitions.

### Key Characteristics

- **Domain**: Workflow orchestration for AI agents
- **Protocol**: Model Context Protocol (MCP) compliant
- **Language**: TypeScript (Node.js ≥20)
- **Architecture**: Clean architecture with dependency injection
- **State**: Stateless MCP server (state managed by agent/client)
- **Distribution**: npm package (`@exaudeus/workrail`)
- **Maturity**: Beta (v0.6.x), production-ready infrastructure

### Core Problem Solved

LLMs suffer from:
- **Hallucination** - Generate plausible but incorrect information
- **Scope creep** - Try to do too much at once
- **Context loss** - Struggle with long conversations
- **Inconsistency** - Same prompt yields different results
- **Missing prerequisites** - Start implementing before gathering context

WorkRail solves this by guiding LLMs through structured workflows:
```
Traditional: User → LLM → [May or may not follow best practices]
WorkRail:    User → Workflow → LLM → [Cannot skip steps, follows proven patterns]
```

---

## System Purpose and Philosophy

### Primary Goals

1. **Enforce Best Practices**: Make it difficult for LLMs to skip critical steps
2. **Consistency**: Same workflow produces same quality regardless of prompting skill
3. **Reproducibility**: Workflows are repeatable and auditable
4. **Progressive Disclosure**: Provide the right information at the right time
5. **Context Optimization**: Minimize token usage while maintaining quality

### Design Philosophy

**"Guide, Don't Control"**
- Workflows provide structure, not rigidity
- Conditional steps allow flexibility
- Context-aware branching enables adaptation
- Validation provides quality gates without blocking progress

**"Stateless by Design"**
- MCP server maintains no session state
- All state lives in the agent/client
- Enables horizontal scaling
- Simplifies error recovery

**"Progressive Disclosure"**
- Only show what's needed for the current step
- Full context on first iteration, minimal on subsequent
- Loop optimization reduces context size by 60-80%

---

## Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      AI Agent (Client)                       │
│                (Claude Desktop, Cursor, etc.)                │
└──────────────────┬──────────────────────────────────────────┘
                   │ MCP Protocol (JSON-RPC over stdio)
┌──────────────────▼──────────────────────────────────────────┐
│                    MCP Server Layer                          │
│              (src/mcp-server.ts)                             │
│  ┌────────────────────────────────────────────────────┐     │
│  │ Tools: workflow_list, workflow_get,                │     │
│  │        workflow_next, workflow_validate,           │     │
│  │        workflow_validate_json, workflow_get_schema │     │
│  │        + Session Tools (workrail_*)                │     │
│  └────────────────────────────────────────────────────┘     │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│                 Application Layer                            │
│              (src/application/)                              │
│  ┌─────────────────┐  ┌──────────────────┐                 │
│  │  Use Cases      │  │   Services       │                 │
│  │  - GetWorkflow  │  │ - WorkflowSvc    │                 │
│  │  - GetNextStep  │  │ - ValidationEng  │                 │
│  │  - Validate     │  │ - LoopOptimizer  │                 │
│  └─────────────────┘  └──────────────────┘                 │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│                Infrastructure Layer                          │
│             (src/infrastructure/)                            │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐      │
│  │  Storage     │  │   Session    │  │    RPC      │      │
│  │  - File      │  │  - Manager   │  │  - Server   │      │
│  │  - Git       │  │  - HTTP      │  │  - Handler  │      │
│  │  - Multi-Dir │  │  - Validator │  │             │      │
│  │  - Cache     │  │  - Normalizer│  │             │      │
│  └──────────────┘  └──────────────┘  └─────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### Architectural Style

**Clean Architecture** with clear boundaries:
1. **MCP Server Layer**: Protocol handling, tool registration
2. **Application Layer**: Business logic, use cases, services
3. **Domain Layer**: Core entities, value objects (types/)
4. **Infrastructure Layer**: External systems, storage, sessions

**Dependency Direction**: Infrastructure → Application → Domain (never reversed)

### Dependency Injection

Centralized in `src/container.ts`:
```typescript
export interface AppContainer {
  storage: IWorkflowStorage;
  validationEngine: ValidationEngine;
  loopContextOptimizer: ILoopContextOptimizer;
  workflowService: WorkflowService;
  server: WorkflowLookupServer;
}

export function createAppContainer(overrides?: Partial<AppContainer>): AppContainer
```

Benefits:
- Easy testing (inject mock dependencies)
- Flexible configuration
- Clear component boundaries
- Runtime composition

---

## Core Domain Concepts

### 1. Workflow

A **Workflow** is a structured sequence of steps that guides an agent through a task.

```typescript
interface Workflow {
  id: string;                    // Unique identifier (e.g., "coding-task-workflow-with-loops")
  name: string;                  // Human-readable name
  description: string;           // Purpose and use case
  version: string;               // Semantic version
  preconditions?: string[];      // Requirements before starting
  clarificationPrompts?: string[]; // Questions to ask user
  steps: (WorkflowStep | LoopStep)[]; // Ordered steps
  metaGuidance?: string[];       // High-level instructions
  functionDefinitions?: FunctionDefinition[]; // Reusable functions
}
```

**Key Characteristics**:
- **Declarative**: Workflows describe *what*, not *how*
- **Conditional**: Steps can have `runCondition` for branching
- **Composable**: Workflows can reference sub-workflows
- **Versioned**: Support for schema evolution

### 2. WorkflowStep

Individual unit of work in a workflow.

```typescript
interface WorkflowStep {
  id: string;                    // Unique within workflow
  title: string;                 // Short description
  prompt: string;                // Instructions for agent
  agentRole?: string;            // Role framing for LLM
  guidance?: string[];           // Additional tips
  runCondition?: Condition;      // When to execute
  validationCriteria?: ValidationCriteria[]; // Output validation
  functionDefinitions?: FunctionDefinition[]; // Step-scoped functions
  functionCalls?: FunctionCall[]; // Explicit function invocations
  requireConfirmation?: boolean; // Pause for user approval
}
```

**Step Execution Flow**:
1. Check `runCondition` (skip if false)
2. Build prompt with agent role + guidance
3. Execute step (agent performs work)
4. Validate output (if criteria defined)
5. Update context
6. Mark complete

### 3. LoopStep

Special step type for iteration patterns.

```typescript
interface LoopStep extends WorkflowStep {
  type: 'loop';
  loop: LoopConfig;
  body: string | WorkflowStep[]; // Single step ID or inline steps
}

interface LoopConfig {
  type: 'while' | 'until' | 'for' | 'forEach';
  condition?: Condition;         // For while/until
  items?: string;                // Context variable for forEach
  count?: number | string;       // Count for 'for' loop
  maxIterations: number;         // Safety limit
  iterationVar?: string;         // Iteration counter name
  itemVar?: string;              // Current item variable (forEach)
  indexVar?: string;             // Array index variable (forEach)
}
```

**Loop Types**:
- **while**: Continue while condition is true
- **until**: Continue until condition becomes true  
- **for**: Fixed iteration count
- **forEach**: Iterate over array items

**Loop Optimization** (v0.2.0):
- First iteration: Full context (100%)
- Subsequent iterations: Minimal context (20-40%)
- 60-80% reduction in tokens after first iteration
- Progressive disclosure pattern

### 4. Context

State container passed between steps.

```typescript
interface EnhancedContext extends ConditionContext {
  _loopState?: LoopState;        // Loop iteration tracking
  _warnings?: {                  // Accumulated warnings
    loops?: { [loopId: string]: string[] };
  };
  _contextSize?: number;         // Size tracking
  _currentLoop?: {               // Active loop metadata
    loopId: string;
    loopStep: LoopStep;
  };
  // Plus user-defined variables
  [key: string]: any;
}
```

**Context Management**:
- Agent maintains context across steps
- Server validates context size (256KB limit)
- Context variables enable conditional execution
- Loop metadata injected automatically

### 5. Condition

Declarative condition evaluation system.

```typescript
interface Condition {
  var?: string;                  // Variable name
  equals?: any;                  // Equality check
  not_equals?: any;              // Inequality check
  in?: any[];                    // Set membership
  gt?: number;                   // Greater than
  lt?: number;                   // Less than
  and?: Condition[];             // Logical AND
  or?: Condition[];              // Logical OR
  not?: Condition;               // Logical NOT
}
```

**Example**:
```json
{
  "or": [
    {"var": "taskComplexity", "equals": "Large"},
    {
      "and": [
        {"var": "taskComplexity", "equals": "Medium"},
        {"var": "requestDeepAnalysis", "equals": true}
      ]
    }
  ]
}
```

---

## Technology Stack

### Core Technologies

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| **Runtime** | Node.js | ≥20 | JavaScript runtime |
| **Language** | TypeScript | 5.9+ | Type-safe development |
| **MCP SDK** | @modelcontextprotocol/sdk | 0.5.0 | MCP protocol implementation |
| **Validation** | Ajv | 8.17.1 | JSON schema validation |
| **Validation** | Zod | 3.22.4 | Runtime type validation |
| **CLI** | Commander | 14.0.0 | Command-line interface |
| **HTTP** | Express | 5.1.0 | Dashboard server |
| **Process** | child_process | Built-in | Git operations |

### Development Tools

| Tool | Purpose |
|------|---------|
| **Vitest** | Unit testing |
| **Playwright** | E2E testing |
| **TSC** | TypeScript compilation |
| **ESLint** | Code linting |
| **npm** | Package management |

### Distribution

- **Package**: `@exaudeus/workrail`
- **Registry**: npm
- **Binary**: `workrail` (maps to `dist/mcp-server.js`)
- **Usage**: `npx -y @exaudeus/workrail` or `docker run workrail-mcp`

---

## Code Organization

### Directory Structure

```
packages/workrail/
├── src/                          # Source code
│   ├── mcp-server.ts            # MCP server entry point
│   ├── container.ts             # Dependency injection
│   ├── cli.ts                   # CLI commands
│   ├── application/             # Application layer
│   │   ├── services/            # Business logic services
│   │   │   ├── workflow-service.ts
│   │   │   ├── validation-engine.ts
│   │   │   ├── loop-context-optimizer.ts
│   │   │   ├── loop-execution-context.ts
│   │   │   ├── loop-step-resolver.ts
│   │   │   └── context-optimizer.ts
│   │   └── use-cases/           # Application use cases
│   │       ├── get-workflow.ts
│   │       ├── get-next-step.ts
│   │       ├── validate-step-output.ts
│   │       └── validate-workflow-json.ts
│   ├── infrastructure/          # Infrastructure layer
│   │   ├── storage/             # Workflow storage backends
│   │   │   ├── file-workflow-storage.ts
│   │   │   ├── git-workflow-storage.ts
│   │   │   ├── multi-directory-workflow-storage.ts
│   │   │   ├── enhanced-multi-source-workflow-storage.ts
│   │   │   ├── caching-workflow-storage.ts
│   │   │   ├── schema-validating-workflow-storage.ts
│   │   │   ├── plugin-workflow-storage.ts
│   │   │   ├── remote-workflow-storage.ts
│   │   │   └── in-memory-storage.ts
│   │   ├── session/             # Session management
│   │   │   ├── SessionManager.ts
│   │   │   ├── SessionDataValidator.ts
│   │   │   ├── SessionDataNormalizer.ts
│   │   │   └── HttpServer.ts
│   │   └── rpc/                 # RPC server
│   │       ├── server.ts
│   │       └── handler.ts
│   ├── types/                   # Type definitions
│   │   ├── mcp-types.ts         # MCP protocol types
│   │   ├── workflow-types.ts    # Workflow domain types
│   │   ├── storage.ts           # Storage interfaces
│   │   └── loop-context-optimizer.ts
│   ├── core/                    # Core utilities
│   │   └── error-handler.ts    # Custom error classes
│   ├── utils/                   # Utility functions
│   │   ├── condition-evaluator.ts
│   │   ├── context-size.ts
│   │   ├── logger.ts
│   │   └── storage-security.ts
│   ├── validation/              # Validation logic
│   │   └── workflow-validator.ts
│   └── tools/                   # MCP tool implementations
│       └── session-tools.ts
├── workflows/                   # Bundled workflows
│   ├── coding-task-workflow-with-loops.json
│   ├── systematic-bug-investigation-with-loops.json
│   ├── mr-review-workflow.json
│   ├── adaptive-ticket-creation.json
│   └── [18 more workflows]
├── web/                         # Dashboard frontend
│   ├── dashboard.html
│   ├── index.html
│   └── assets/
├── tests/                       # Test suites
│   ├── unit/                    # Unit tests
│   ├── integration/             # Integration tests
│   ├── e2e/                     # End-to-end tests
│   └── contract/                # MCP contract tests
├── docs/                        # Documentation
│   ├── implementation/          # Implementation guides
│   ├── features/                # Feature documentation
│   ├── reference/               # API reference
│   └── README.md
├── spec/                        # Specifications
│   ├── workflow.schema.json     # Workflow JSON schema
│   ├── mcp-api-v1.0.md         # MCP API spec
│   └── examples/
├── sessions/                    # Session data storage
└── dist/                        # Compiled output
```

### Module Boundaries

**Clear separation of concerns**:

1. **`types/`**: Pure type definitions, no logic
2. **`core/`**: Domain-agnostic utilities
3. **`utils/`**: Helper functions
4. **`application/`**: Business logic, orchestration
5. **`infrastructure/`**: External integrations
6. **`mcp-server.ts`**: Protocol adapter

**Import Rules**:
- Infrastructure can import from application, types, utils
- Application can import from types, utils, core
- Types are pure (no imports from other layers)
- No circular dependencies

---

## Key Components Deep Dive

### 1. WorkflowService (`src/application/services/workflow-service.ts`)

**Purpose**: Core orchestration engine for workflow execution.

**Key Responsibilities**:
- Load workflows from storage
- Determine next eligible step
- Handle conditional execution
- Manage loop execution
- Validate step outputs
- Track loop state
- Context size validation

**Critical Method**: `getNextStep()`

```typescript
async getNextStep(
  workflowId: string,
  completedSteps: string[],
  context: ConditionContext = {}
): Promise<{
  step: WorkflowStep | null;
  guidance: WorkflowGuidance;
  isComplete: boolean;
  context?: ConditionContext;
}>
```

**Execution Algorithm**:
1. Load workflow from storage
2. Validate workflow structure
3. Check if in active loop
   - If yes: Handle loop iteration logic
   - Check loop continuation condition
   - Resolve loop body step
   - Apply context optimization
4. If not in loop: Find next eligible step
   - Skip completed steps
   - Skip loop body steps (unless in loop)
   - Evaluate `runCondition`
5. If next step is loop: Initialize loop state
6. Handle blocked workflow (unmet conditions)
7. Return step + guidance + context

**Loop Handling** (Complex Logic):
```typescript
// Check if we're currently executing a loop body
if (enhancedContext._currentLoop) {
  const { loopId, loopStep } = enhancedContext._currentLoop;
  const loopContext = new LoopExecutionContext(...);
  
  if (loopContext.shouldContinue(context)) {
    // Execute loop body with optimized context
    const bodyStep = resolveLoopBody(...);
    const useMinimal = !isFirst && !!loopContextOptimizer;
    const optimizedContext = useMinimal 
      ? loopContextOptimizer.stripLoopMetadata(context)
      : context;
    return { step: bodyStep, guidance, context: optimizedContext };
  } else {
    // Loop complete, mark and continue
    completed.push(loopId);
    delete enhancedContext._currentLoop;
  }
}
```

**Performance Optimizations**:
- Context size checking (256KB limit)
- Loop metadata stripping (60-80% reduction)
- Progressive disclosure pattern
- Lazy workflow loading

### 2. ValidationEngine (`src/application/services/validation-engine.ts`)

**Purpose**: Validate step outputs against criteria.

**Supported Validation Types**:

| Type | Description | Example |
|------|-------------|---------|
| `contains` | Output must include substring | `{type: "contains", value: "test"}` |
| `regex` | Output must match pattern | `{type: "regex", pattern: "\\d{3}"}` |
| `length` | Output length constraints | `{type: "length", min: 100, max: 1000}` |
| `schema` | JSON schema validation | `{type: "schema", schema: {...}}` |

**Validation Composition**:
```json
{
  "and": [
    {"type": "contains", "value": "function"},
    {"or": [
      {"type": "contains", "value": "async"},
      {"type": "contains", "value": "Promise"}
    ]}
  ]
}
```

**Conditional Validation**:
```json
{
  "type": "contains",
  "value": "integration tests",
  "condition": {
    "var": "testType",
    "equals": "integration"
  }
}
```

**Workflow Validation**:
- Validates entire workflow structure
- Checks for duplicate step IDs
- Validates loop configurations
- Validates function definitions/calls
- Validates runConditions
- Produces detailed error reports

**Loop Validation**:
- Type-specific validation (while/until/for/forEach)
- maxIterations safety checks
- Body reference validation
- Variable name validation
- Nested loop detection
- Enhanced validation for common mistakes

### 3. Storage Layer

**Interface**: `IWorkflowStorage`
```typescript
interface IWorkflowStorage {
  loadAllWorkflows(): Promise<Workflow[]>;
  getWorkflowById(id: string): Promise<Workflow | null>;
  listWorkflowSummaries(): Promise<WorkflowSummary[]>;
  save?(workflow: Workflow): Promise<void>;
}
```

**Implementations** (Decorator Pattern):

1. **FileWorkflowStorage**: Load from local JSON files
2. **GitWorkflowStorage**: Clone/sync from Git repos
3. **MultiDirectoryWorkflowStorage**: Combine multiple directories
4. **PluginWorkflowStorage**: Load from npm packages
5. **RemoteWorkflowStorage**: Fetch from HTTP registries
6. **SchemaValidatingWorkflowStorage**: Decorator for validation
7. **CachingWorkflowStorage**: Decorator for TTL caching
8. **EnhancedMultiSourceWorkflowStorage**: Combines all sources

**Default Stack** (Composition):
```typescript
function createDefaultWorkflowStorage(): CachingWorkflowStorage {
  const base = createEnhancedMultiSourceWorkflowStorage();
  const validating = new SchemaValidatingWorkflowStorage(base);
  const cached = new CachingWorkflowStorage(validating, 300_000); // 5 min TTL
  return cached;
}
```

**Priority Order** (later overrides earlier):
1. Bundled workflows (built-in)
2. Plugins (npm packages)
3. User directory (`~/.workrail/workflows`)
4. Custom paths (`WORKFLOW_STORAGE_PATH`)
5. Git repositories (`WORKFLOW_GIT_REPOS`)
6. Project directory (`./workflows`)

### 4. GitWorkflowStorage (`src/infrastructure/storage/git-workflow-storage.ts`)

**Purpose**: Load workflows from Git repositories.

**Features**:
- Clone repositories on first access
- Pull updates on sync interval
- Offline support (local cache)
- Token authentication (HTTPS)
- SSH key support
- Branch specification
- Path traversal protection
- Command injection prevention
- File size limits
- Automatic branch fallback

**Security Measures**:
- Whitelisted hosting providers (GitHub, GitLab, Bitbucket, Azure DevOps, SourceForge)
- HTTPS-only (except SSH and file://)
- Git ref sanitization (prevent injection)
- Path validation (prevent traversal)
- File size limits (1MB default)
- File count limits (100 default)
- Shell argument escaping
- Timeout protection (60s)

**Configuration**:
```typescript
interface GitWorkflowConfig {
  repositoryUrl: string;         // Git repo URL
  branch?: string;               // Branch name (default: main)
  localPath?: string;            // Cache location
  syncInterval?: number;         // Minutes between syncs
  authToken?: string;            // Auth token
  maxFileSize?: number;          // Max file size (bytes)
  maxFiles?: number;             // Max file count
}
```

**Token Resolution** (Priority):
1. Service-specific: `GITHUB_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN`
2. Hostname-based: `GIT_<HOSTNAME_UPPERCASE>_TOKEN`
3. Generic: `GIT_TOKEN`, `WORKFLOW_GIT_AUTH_TOKEN`

**Repository Structure**:
```
repo/
└── workflows/
    ├── workflow-1.json
    ├── workflow-2.json
    └── ...
```

### 5. SessionManager (`src/infrastructure/session/SessionManager.ts`)

**Purpose**: Manage workflow execution sessions for dashboard.

**Features**:
- Project-based organization
- Git worktree support (shares sessions across worktrees)
- Atomic writes (temp file + rename)
- Deep merge updates
- JSONPath-like queries
- File watching (real-time updates)
- Data normalization
- Data validation
- Validation logging

**Storage Location**:
```
~/.workrail/sessions/
├── {projectId}/
│   ├── project.json
│   ├── {workflowId}/
│   │   ├── {sessionId}.json
│   │   └── ...
│   └── validation-logs/
└── ...
```

**Session Structure**:
```typescript
interface Session {
  id: string;                    // Session ID
  workflowId: string;            // Workflow being executed
  projectId: string;             // Project hash
  projectPath: string;           // Absolute path to project
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
  data: Record<string, any>;     // Workflow-specific data
}
```

**Key Methods**:
- `createSession()`: Initialize new session
- `updateSession()`: Deep merge updates
- `readSession()`: Read with optional JSONPath query
- `deleteSession()`: Remove session
- `listAllSessions()`: List for current project
- `listAllProjectsSessions()`: Global list
- `watchSession()`: Watch for file changes

**Git Worktree Resolution**:
```typescript
// Resolves worktrees to main repo root
// This ensures worktrees share the same project ID
private resolveProjectPath(startPath: string): string {
  const gitRoot = execSync('git rev-parse --show-toplevel', {
    cwd: startPath
  }).trim();
  return gitRoot || path.resolve(startPath);
}
```

**Query Support**:
```typescript
// Dot notation
readSession(workflowId, sessionId, "dashboard.progress")

// Array index
readSession(workflowId, sessionId, "hypotheses[0]")

// Array filter
readSession(workflowId, sessionId, "hypotheses[?status=='active']")
```

### 6. LoopContextOptimizer (`src/application/services/loop-context-optimizer.ts`)

**Purpose**: Reduce context size for loop iterations (60-80% reduction).

**Optimization Strategy**:

**First Iteration**:
```json
{
  "_currentLoop": {
    "loopId": "phase-1-multi-analysis",
    "loopStep": { 
      "id": "...",
      "type": "loop",
      "title": "Phase 1: Multi-Step Analysis",
      "prompt": "...", 
      "loop": {...},
      "body": [...]
    }
  }
}
```

**Subsequent Iterations**:
```json
{
  "_currentLoop": {
    "loopId": "phase-1-multi-analysis",
    "loopType": "for",
    "iteration": 2,
    "isFirstIteration": false,
    "phaseReference": {
      "loopId": "phase-1-multi-analysis",
      "phaseTitle": "Phase 1: Multi-Step Analysis",
      "totalSteps": 4,
      "functionDefinitions": [...]
    }
  }
}
```

**What Gets Stripped**:
- Full loop step definition
- Complete body array
- Large context arrays (except current item)
- Verbose metadata

**What's Preserved**:
- Loop ID and type
- Current iteration number
- Essential state variables
- Current item (forEach)
- Function definitions (if needed)

**Implementation**:
```typescript
public stripLoopMetadata(context: EnhancedContext): OptimizedLoopContext {
  // Convert to optimized format
  const optimizedContext = convertToOptimized(context);
  
  // Minimize forEach arrays (keep only current item)
  if (optimizedContext._currentLoop?.loopType === 'forEach') {
    const state = optimizedContext._loopState[loopId];
    state.items = [state.items[state.index]]; // Single item
    state.index = 0; // Reset index
  }
  
  // Remove large arrays
  removelargeArrays(optimizedContext);
  
  return optimizedContext;
}
```

**Benefits**:
- 60-80% reduction in context size
- Faster processing
- Lower costs
- Maintains full functionality

### 7. Function Definition System

**Purpose**: Reduce duplication in workflow definitions.

**Scope Levels**:
1. **Workflow**: Available to all steps
2. **Loop**: Available within loop body
3. **Step**: Available only in that step

**Definition**:
```json
{
  "name": "updateDecisionLog",
  "definition": "Update Decision Log in CONTEXT.md: file paths/ranges, excerpts, why important, outcome impact. Limit 3-5 files/decision.",
  "parameters": [
    {
      "name": "phase",
      "type": "string",
      "required": true,
      "description": "Current phase name"
    }
  ],
  "scope": "workflow"
}
```

**Usage** (Two Forms):

1. **Inline Reference**: `updateDecisionLog()`
2. **Explicit Call**:
```json
{
  "functionCalls": [
    {
      "name": "updateDecisionLog",
      "args": {"phase": "analysis"}
    }
  ]
}
```

**Validation**:
- Function existence check
- Required parameter validation
- Type validation
- Enum validation

**Resolution Order**:
1. Step-level definitions
2. Loop-level definitions
3. Workflow-level definitions

---

## Infrastructure Layer

### Storage Security (`src/utils/storage-security.ts`)

**Functions**:
- `sanitizeId()`: Prevent path traversal in IDs
- `assertWithinBase()`: Ensure paths stay within boundaries
- `validateFileSize()`: Enforce size limits
- `validateSecurityOptions()`: Validate config
- `isAllowedExtension()`: Whitelist file types

**Path Traversal Prevention**:
```typescript
function sanitizeId(id: string): string {
  // Remove path separators and traversal attempts
  return id.replace(/[\/\\\.]/g, '-');
}

function assertWithinBase(filePath: string, baseDir: string): void {
  const resolved = path.resolve(filePath);
  const base = path.resolve(baseDir);
  if (!resolved.startsWith(base)) {
    throw new SecurityError('Path traversal detected');
  }
}
```

### Error Handling (`src/core/error-handler.ts`)

**Custom Error Classes**:
```typescript
class WorkflowNotFoundError extends Error
class StepNotFoundError extends Error
class ValidationError extends Error
class StorageError extends Error
class SecurityError extends Error
class InvalidWorkflowError extends Error
```

**Error Codes** (MCP Protocol):
```typescript
enum MCPErrorCodes {
  WORKFLOW_NOT_FOUND = -32001,
  INVALID_WORKFLOW = -32002,
  STEP_NOT_FOUND = -32003,
  VALIDATION_ERROR = -32004,
  STATE_ERROR = -32005,
  STORAGE_ERROR = -32006,
  SECURITY_ERROR = -32007,
}
```

### Logger (`src/utils/logger.ts`)

**Purpose**: Structured logging with configurable levels.

**Configuration**:
```bash
WORKRAIL_LOG_LEVEL=DEBUG|INFO|WARN|ERROR|SILENT  # Default: SILENT
WORKRAIL_LOG_FORMAT=human|json                    # Default: human
```

**Outputs to stderr** (stdout reserved for MCP protocol)

**Usage**:
```typescript
const logger = createLogger('ComponentName');
logger.debug('Message', { metadata });
logger.info('Message', { metadata });
logger.warn('Message', error, { metadata });
logger.error('Message', error, { metadata });
```

### Context Size Validation (`src/utils/context-size.ts`)

**Purpose**: Prevent context overflow (256KB limit).

```typescript
function checkContextSize(context: any): {
  isError: boolean;
  sizeBytes: number;
  context: any;
} {
  const size = JSON.stringify(context).length;
  if (size > 256 * 1024) {
    return { isError: true, sizeBytes: size, context };
  }
  return { isError: false, sizeBytes: size, context };
}
```

**Checked At**:
- Step execution
- Loop iteration
- Context updates

---

## Testing Strategy

### Test Categories

1. **Unit Tests** (`tests/unit/`)
   - Services (workflow-service, validation-engine)
   - Storage (all implementations)
   - Utilities (condition-evaluator, context-size)
   - Coverage target: 80%+

2. **Integration Tests** (`tests/integration/`)
   - MCP protocol compliance
   - Workflow execution end-to-end
   - Storage integration
   - Session management

3. **Contract Tests** (`tests/contract/`)
   - MCP protocol adherence
   - Tool schema validation
   - Response format validation

4. **E2E Tests** (`tests/e2e/`, `e2e/`)
   - Full workflow execution
   - Dashboard functionality
   - Browser-based tests (Playwright)

### Test Tools

- **Vitest**: Unit and integration tests
- **Playwright**: E2E browser tests
- **In-memory storage**: Test isolation
- **Mock dependencies**: Component testing

### Coverage

Current coverage (estimated based on test files):
- Unit: ~75%
- Integration: ~60%
- E2E: ~40%

### Running Tests

```bash
npm test              # Run all tests (Vitest)
npm run test:ui       # Vitest UI
npm run test:run      # CI mode (no watch)
npm run e2e           # Playwright E2E
npm run e2e:ui        # Playwright UI
```

---

## Current Development State

### Active Branch: `feature/external-workflow-repositories`

**Status**: ✅ Complete infrastructure, pending integration decision

### What's Complete

1. **Core Workflow System**: ✅ Production-ready
   - Workflow loading
   - Step execution
   - Loop support
   - Validation engine
   - Context management

2. **Storage Backends**: ✅ All implemented
   - File storage
   - Git storage (external repos)
   - Multi-directory storage
   - Plugin storage
   - Remote HTTP storage
   - Caching layer
   - Schema validation layer

3. **Session Management**: ✅ Production-ready
   - Session CRUD operations
   - Dashboard HTTP server
   - Real-time updates (file watching)
   - Data normalization
   - Data validation

4. **Security**: ✅ Production-grade
   - Path traversal prevention
   - Command injection prevention
   - File size limits
   - HTTPS enforcement
   - Token authentication

5. **MCP Compliance**: ✅ Fully compliant
   - All required protocol features
   - Tool registration
   - Error handling
   - JSON-RPC 2.0

6. **Documentation**: ✅ Comprehensive
   - User-facing (README.md)
   - Internal (docs/)
   - API specification
   - Feature documentation

### What's In Progress

1. **External Workflow Repos Integration**: 🔄
   - Infrastructure: ✅ Complete
   - Integration: ⏳ Pending decision
   - CLI commands: ⏳ Not started
   - Documentation: ✅ Complete
   - Example repo: ⏳ Not started

2. **Loop Optimization**: ✅ Implemented, needs more real-world testing

3. **Workflow Validation**: ✅ Core complete, enhanced validators added

### What's Planned

From README.md "Planned Features":

1. **Workflow State Management**
   - Save & Resume workflows
   - Context preservation across sessions
   - Checkpoint system

2. **Model Switching Guidance**
   - Recommend optimal models per step
   - Cost optimization hints
   - (Recommendations only, not automatic)

3. **Enhanced Workflow Management**
   - ✅ Dynamic loading (Git repos) - DONE
   - Workflow categories
   - Reusable components
   - Schema versioning
   - Workflow templates

4. **Advanced Validation**
   - Custom validation functions
   - Integration hooks
   - Performance validation
   - Length validation optimization

5. **Workflow Discovery**
   - Smart workflow suggestions
   - Pattern recognition

### Known Issues

From investigation:
- Git operations can be slow on first clone (mitigated by caching)
- Context size limit (256KB) may be restrictive for very complex workflows
- Loop optimization not enabled for `while`/`until` loops (only `for`/`forEach`)

---

## Design Decisions and Rationale

### 1. Stateless MCP Server

**Decision**: Server maintains no session state; all state in agent.

**Rationale**:
- MCP protocol design (server-agnostic)
- Horizontal scaling support
- Simplified error recovery
- Clear responsibility boundaries
- Agent controls context

**Trade-off**:
- Agent must manage all state
- Context passed on every request
- Size limits must be enforced

### 2. Decorator Pattern for Storage

**Decision**: Stack storage implementations using decorators.

**Rationale**:
- Single Responsibility Principle
- Open/Closed Principle (extend without modifying)
- Composable functionality
- Easy testing (mock individual layers)
- Flexible configuration

**Example**:
```typescript
Base → Schema Validation → Caching → Consumer
```

### 3. Progressive Disclosure for Loops

**Decision**: Full context on first iteration, minimal on subsequent.

**Rationale**:
- 60-80% context size reduction
- First iteration needs full overview
- Subsequent iterations need only current state
- Reduces token costs
- Maintains quality

**Trade-off**:
- Slightly more complex implementation
- Agent must handle different context shapes

### 4. Conditional Step Execution

**Decision**: Steps have optional `runCondition` evaluated at runtime.

**Rationale**:
- Enable workflow branching
- Adapt to context
- Support complexity levels (Small/Medium/Large)
- Avoid unnecessary steps
- Keep workflows DRY

**Trade-off**:
- More complex execution logic
- Harder to visualize workflow path
- Testing requires various contexts

### 5. Git-Based External Workflows

**Decision**: Use Git repositories as primary external workflow source.

**Rationale**:
- Zero infrastructure (use GitHub/GitLab)
- Familiar to developers
- Built-in version control
- Pull request workflow
- Free hosting
- Offline support (cache)

**Trade-offs**:
- Requires Git installed
- Clone/pull latency (mitigated by sync interval)
- Not ideal for high-frequency updates

**Alternatives Considered**:
- HTTP registry (requires infrastructure)
- npm plugins (works but less collaborative)
- Direct file sharing (no version control)

### 6. Function Definition System

**Decision**: Support reusable function definitions with scoping.

**Rationale**:
- Reduce duplication in workflows
- Improve readability
- Easy updates (change once, apply everywhere)
- Scope control (workflow/loop/step)
- Parameter validation

**Trade-off**:
- Adds complexity to workflow schema
- Validation overhead
- Learning curve

### 7. Validation Composition

**Decision**: Support AND/OR/NOT validation logic.

**Rationale**:
- Express complex validation rules
- Conditional validation
- Reusable validation patterns
- Clear semantics

**Example**:
```json
{
  "and": [
    {"type": "contains", "value": "test"},
    {"or": [
      {"type": "contains", "value": "unit"},
      {"type": "contains", "value": "integration"}
    ]}
  ]
}
```

### 8. Session Management (Dashboard Feature)

**Decision**: Add session persistence and HTTP dashboard.

**Rationale**:
- Real-time progress visibility
- Debugging workflows
- Workflow analytics
- Multi-user collaboration (view sessions)
- Persistent execution history

**Trade-off**:
- Adds HTTP server (port 3000)
- File I/O for persistence
- More moving parts

**Mitigation**:
- Auto-open disabled by default
- Graceful degradation if port busy
- Optional feature (doesn't affect core)

### 9. TypeScript with Strict Mode

**Decision**: Use TypeScript with strict compiler options.

**Rationale**:
- Type safety
- Better IDE support
- Catch errors at compile time
- Self-documenting code
- Easier refactoring

**Configuration** (`tsconfig.json`):
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "esModuleInterop": true,
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node"
  }
}
```

### 10. 256KB Context Limit

**Decision**: Enforce 256KB context size limit.

**Rationale**:
- Prevent agent context overflow
- Encourage focused workflows
- Early error detection
- Performance optimization
- Token cost control

**Implementation**:
```typescript
const MAX_CONTEXT_SIZE = 256 * 1024; // 256KB

function checkContextSize(context: any) {
  const size = JSON.stringify(context).length;
  if (size > MAX_CONTEXT_SIZE) {
    throw new Error(`Context too large: ${size} bytes`);
  }
}
```

---

## Future Directions

### Near-Term (Next Release)

1. **Finalize External Workflow Repos**
   - Decide on integration approach (A/B/C)
   - Implement CLI commands
   - Create example repository
   - Update documentation

2. **Workflow Templates**
   - CLI command: `workrail create-from-template`
   - Template repository
   - Variable substitution

3. **Enhanced Validation**
   - Custom validation functions
   - Performance validation
   - Better error messages

### Mid-Term (3-6 Months)

1. **Workflow State Management**
   - Resume workflows across sessions
   - Checkpoint system
   - State serialization

2. **Model Switching Guidance**
   - Recommend models per step
   - Cost/quality trade-offs

3. **Workflow Categories**
   - Better organization
   - Discovery improvements
   - Search functionality

4. **Analytics**
   - Workflow usage tracking
   - Success metrics
   - Performance insights

### Long-Term (6-12 Months)

1. **Workflow Marketplace**
   - Discover community workflows
   - Rating/review system
   - Workflow signing/verification

2. **Workflow Designer UI**
   - Visual workflow editor
   - Step configuration
   - Live preview

3. **Plugin System**
   - Workflow extensions
   - Custom step types
   - Integration hooks

4. **Multi-Language Support**
   - Internationalization
   - Localized workflows

### Research Areas

1. **Dynamic Workflow Generation**
   - AI-generated workflows based on task
   - Workflow optimization
   - A/B testing workflows

2. **Collaborative Workflows**
   - Multi-agent workflows
   - Human-in-the-loop steps
   - Real-time collaboration

3. **Workflow Versioning**
   - Schema evolution
   - Backward compatibility
   - Migration tools

4. **Advanced Loop Patterns**
   - Nested loops
   - Parallel loops
   - Conditional loop bodies

---

## Appendix

### Key Files Reference

| File | Lines | Purpose |
|------|-------|---------|
| `src/mcp-server.ts` | 485 | MCP server entry point |
| `src/application/services/workflow-service.ts` | 613 | Core orchestration |
| `src/application/services/validation-engine.ts` | 696 | Validation logic |
| `src/infrastructure/storage/git-workflow-storage.ts` | 495 | Git repo integration |
| `src/infrastructure/session/SessionManager.ts` | 693 | Session management |
| `src/types/workflow-types.ts` | 477 | Type definitions |
| `workflows/coding-task-workflow-with-loops.json` | 522 | Premier workflow example |

### Workflow Examples

**Bundled Workflows** (20 total):
1. `coding-task-workflow-with-loops.json` - Comprehensive coding workflow
2. `systematic-bug-investigation-with-loops.json` - Debugging methodology
3. `mr-review-workflow.json` - Merge request review
4. `adaptive-ticket-creation.json` - Ticket creation
5. `document-creation-workflow.json` - Documentation writing
6. `presentation-creation.json` - Presentation design
7. `exploration-workflow.json` - Codebase exploration
8. `workflow-for-workflows.json` - Meta-workflow design
9. Plus 12 more specialized workflows

### Environment Variables

**Workflow Sources**:
```bash
WORKFLOW_INCLUDE_BUNDLED=true       # Include built-in workflows
WORKFLOW_INCLUDE_USER=true          # Include ~/.workrail/workflows
WORKFLOW_INCLUDE_PROJECT=true       # Include ./workflows
WORKFLOW_STORAGE_PATH=/path1:/path2 # Custom directories
```

**Git Repositories**:
```bash
WORKFLOW_GIT_REPOS=url1,url2        # Git repo URLs (comma-separated)
GITHUB_TOKEN=ghp_xxx                # GitHub auth
GITLAB_TOKEN=glpat_xxx              # GitLab auth
BITBUCKET_TOKEN=xxx                 # Bitbucket auth
GIT_HOSTNAME_TOKEN=xxx              # Self-hosted Git
GIT_TOKEN=xxx                       # Generic fallback
```

**Performance**:
```bash
WORKRAIL_CACHE_DIR=/path/to/cache   # Cache location
CACHE_TTL=300000                    # Cache TTL (ms)
```

**Logging**:
```bash
WORKRAIL_LOG_LEVEL=DEBUG|INFO|WARN|ERROR|SILENT
WORKRAIL_LOG_FORMAT=human|json
```

### CLI Commands

```bash
# List available workflows
workrail list

# Validate a workflow file
workrail validate /path/to/workflow.json

# Get workflow schema
workrail schema

# Initialize user directory
workrail init
```

### MCP Tools

Exposed to AI agents:

1. **`workflow_list`** - Browse available workflows
2. **`workflow_get`** - Get workflow details (metadata or preview mode)
3. **`workflow_next`** - Get next step in workflow
4. **`workflow_validate`** - Validate step output
5. **`workflow_validate_json`** - Validate workflow JSON
6. **`workflow_get_schema`** - Get workflow JSON schema
7. **`workrail_create_session`** - Create session for dashboard
8. **`workrail_update_session`** - Update session data
9. **`workrail_read_session`** - Read session data
10. **`workrail_open_dashboard`** - Open dashboard in browser

### Project Metrics (Estimated)

- **Total Lines of Code**: ~15,000 (src/ only)
- **Type Definitions**: ~2,000 lines
- **Test Code**: ~5,000 lines
- **Documentation**: ~10,000 lines
- **Workflows**: ~8,000 lines (JSON)
- **Dependencies**: 15 production, 10 development
- **Test Coverage**: ~70% (estimated)
- **Files**: ~150 source files

### Contributors

Primary development by Exaudeus team.

### License

MIT License

---

**Document Version**: 1.0  
**Last Updated**: November 3, 2025  
**Codebase Version**: 0.6.1-beta.7  
**Branch**: feature/external-workflow-repositories

---

## How to Use This Document

**For New Developers**:
1. Read Executive Summary + System Purpose
2. Read Architecture Overview
3. Read Core Domain Concepts
4. Explore Key Components Deep Dive
5. Review Code Organization
6. Browse actual source files

**For Integration**:
1. MCP Tools section
2. Environment Variables
3. Installation from README.md
4. MCP protocol specification

**For Contributing**:
1. Design Decisions section
2. Code Organization
3. Testing Strategy
4. Development setup from README.md

**For Architecture Decisions**:
1. Design Decisions and Rationale
2. Future Directions
3. Trade-offs documented

---

*This document provides a comprehensive technical overview of the WorkRail MCP codebase. For user-facing documentation, see README.md. For API details, see spec/mcp-api-v1.0.md.*



