# WorkRail MCP: Executive Codebase Summary

> **Quick reference guide for understanding the WorkRail codebase architecture and key components**

---

## What is WorkRail?

WorkRail is a **Model Context Protocol (MCP) server** that guides LLMs through structured workflows, enforcing software engineering best practices through machine-readable step-by-step guidance.

**Problem Solved**: LLMs hallucinate, lose context, skip steps, and produce inconsistent results.  
**Solution**: Structured workflows that make it difficult for LLMs to go off track.

---

## Key Statistics

| Metric | Value |
|--------|-------|
| **Version** | 0.6.1-beta.7 |
| **Protocol** | MCP (Model Context Protocol) |
| **Language** | TypeScript |
| **Runtime** | Node.js ≥20 |
| **LOC** | ~15,000 (src) + 8,000 (workflows) |
| **Bundled Workflows** | 20 production-ready |
| **MCP Tools** | 10 exposed tools |
| **Test Coverage** | ~70% |
| **License** | MIT |

---

## Architecture at a Glance

```
AI Agent (Client)
      ↓ MCP Protocol (JSON-RPC over stdio)
MCP Server Layer (protocol handling)
      ↓
Application Layer (business logic)
   - WorkflowService (orchestration)
   - ValidationEngine (quality gates)
   - LoopOptimizer (context reduction)
      ↓
Infrastructure Layer (external systems)
   - Storage (File/Git/Multi-source)
   - Sessions (dashboard data)
   - RPC (server implementation)
```

**Style**: Clean Architecture with Dependency Injection  
**Pattern**: Stateless server, agent manages all state  
**Composition**: Decorator pattern for storage, use cases for operations

---

## Core Components (Top 7)

### 1. **WorkflowService** (`src/application/services/workflow-service.ts`)
- **Purpose**: Core orchestration engine
- **Responsibilities**: Load workflows, determine next step, handle loops, validate outputs
- **Key Method**: `getNextStep()` - returns next eligible step based on context
- **Complexity**: 613 lines, handles conditional execution and loop iteration

### 2. **ValidationEngine** (`src/application/services/validation-engine.ts`)
- **Purpose**: Validate step outputs against criteria
- **Validation Types**: contains, regex, length, schema
- **Features**: Composition (AND/OR/NOT), conditional validation, workflow validation
- **Complexity**: 696 lines, includes loop validation

### 3. **Storage Layer** (`src/infrastructure/storage/`)
- **Interface**: `IWorkflowStorage` (4 methods)
- **Implementations**: 9 storage backends
- **Pattern**: Decorator (stack: base → validation → caching)
- **Default**: EnhancedMultiSourceWorkflowStorage (combines all sources)

### 4. **GitWorkflowStorage** (`src/infrastructure/storage/git-workflow-storage.ts`)
- **Purpose**: Load workflows from Git repositories
- **Features**: Clone/sync, auth, offline cache, security
- **Security**: Path traversal prevention, command injection prevention, HTTPS-only
- **Status**: ✅ Production-ready, pending integration decision

### 5. **SessionManager** (`src/infrastructure/session/SessionManager.ts`)
- **Purpose**: Manage workflow execution sessions
- **Storage**: `~/.workrail/sessions/{projectId}/{workflowId}/{sessionId}.json`
- **Features**: Atomic writes, deep merge, JSONPath queries, file watching
- **Special**: Git worktree support (shares sessions across worktrees)

### 6. **LoopContextOptimizer** (`src/application/services/loop-context-optimizer.ts`)
- **Purpose**: Reduce context size for loop iterations
- **Reduction**: 60-80% after first iteration
- **Strategy**: Full context first iteration, minimal subsequent
- **Benefit**: Lower token costs, faster processing

### 7. **MCP Server** (`src/mcp-server.ts`)
- **Purpose**: Protocol adapter and entry point
- **Tools**: Exposes 10 MCP tools to AI agents
- **Transport**: stdio (JSON-RPC 2.0)
- **Status**: Fully MCP-compliant

---

## Domain Model (5 Key Concepts)

### 1. **Workflow**
Ordered sequence of steps with metadata.
```typescript
{ id, name, description, version, steps[], metaGuidance?, functionDefinitions? }
```

### 2. **WorkflowStep**
Individual unit of work.
```typescript
{ id, title, prompt, agentRole?, runCondition?, validationCriteria?, requireConfirmation? }
```

### 3. **LoopStep**
Iteration construct (while/until/for/forEach).
```typescript
{ type: 'loop', loop: { type, maxIterations, condition?, items?, count? }, body }
```

### 4. **Context**
State container passed between steps.
```typescript
{ _loopState?, _currentLoop?, _warnings?, [userVars] }
```

### 5. **Condition**
Declarative conditional logic.
```typescript
{ var?, equals?, in?, gt?, lt?, and?, or?, not? }
```

---

## Storage Architecture

### Priority Order (later overrides earlier)
1. Bundled (built-in workflows)
2. Plugins (npm packages)
3. User (`~/.workrail/workflows`)
4. Custom (`WORKFLOW_STORAGE_PATH`)
5. Git repos (`WORKFLOW_GIT_REPOS`)
6. Project (`./workflows`)

### Implementation Stack
```
CachingWorkflowStorage (5 min TTL)
  └─ SchemaValidatingWorkflowStorage
      └─ EnhancedMultiSourceWorkflowStorage
          ├─ FileWorkflowStorage (bundled)
          ├─ MultiDirectoryWorkflowStorage (user/custom/project)
          ├─ GitWorkflowStorage[] (external repos)
          ├─ PluginWorkflowStorage (npm)
          └─ RemoteWorkflowStorage (HTTP)
```

---

## Key Design Decisions

| Decision | Rationale | Trade-off |
|----------|-----------|-----------|
| **Stateless server** | MCP design, horizontal scaling | Agent manages all state |
| **Decorator storage** | Composable, testable, extensible | Slightly more complex |
| **Progressive disclosure** | 60-80% context reduction | Different context shapes |
| **Git for external workflows** | Zero infra, familiar, version control | Requires Git, clone latency |
| **256KB context limit** | Prevent overflow, cost control | May restrict complex workflows |
| **Function definitions** | Reduce duplication | Schema complexity |
| **TypeScript strict mode** | Type safety, IDE support | Slower development |

---

## Current Development State

### Branch: `feature/external-workflow-repositories`

**Completed** ✅:
- Core workflow system (100%)
- All storage backends (100%)
- Session management (100%)
- Security (production-grade)
- MCP compliance (100%)
- Documentation (comprehensive)

**In Progress** 🔄:
- External workflow repos integration (infrastructure done, awaiting decision)

**Planned** 📋:
- Workflow state management (save/resume)
- Model switching guidance
- Workflow categories
- Analytics
- Marketplace

---

## File Organization

```
src/
├── mcp-server.ts           # Entry point (485 lines)
├── container.ts            # DI container (43 lines)
├── cli.ts                  # CLI commands
├── application/
│   ├── services/           # Business logic
│   │   ├── workflow-service.ts (613 lines) ⭐
│   │   ├── validation-engine.ts (696 lines) ⭐
│   │   ├── loop-context-optimizer.ts
│   │   ├── loop-execution-context.ts
│   │   ├── loop-step-resolver.ts
│   │   └── context-optimizer.ts
│   └── use-cases/          # Application operations
│       ├── get-workflow.ts
│       ├── get-next-step.ts
│       ├── validate-step-output.ts
│       └── validate-workflow-json.ts
├── infrastructure/
│   ├── storage/            # 9 storage implementations
│   │   ├── git-workflow-storage.ts (495 lines) ⭐
│   │   ├── enhanced-multi-source-workflow-storage.ts
│   │   ├── file-workflow-storage.ts
│   │   └── ...
│   ├── session/            # Dashboard sessions
│   │   ├── SessionManager.ts (693 lines) ⭐
│   │   ├── SessionDataValidator.ts
│   │   ├── SessionDataNormalizer.ts
│   │   └── HttpServer.ts
│   └── rpc/                # RPC server
├── types/                  # Type definitions (~2000 lines)
│   ├── mcp-types.ts
│   ├── workflow-types.ts (477 lines)
│   ├── storage.ts
│   └── ...
├── core/
│   └── error-handler.ts    # Custom errors
├── utils/                  # Utilities
│   ├── condition-evaluator.ts
│   ├── context-size.ts
│   ├── logger.ts
│   └── storage-security.ts
└── tools/
    └── session-tools.ts    # Session MCP tools

workflows/                  # 20 bundled workflows (~8000 lines)
web/                        # Dashboard UI
tests/                      # Unit, integration, E2E tests
docs/                       # Comprehensive documentation
spec/                       # JSON schema, API spec
```

---

## MCP Tools Exposed

1. **`workflow_list`** - Browse available workflows
2. **`workflow_get`** - Get workflow details (metadata/preview modes)
3. **`workflow_next`** - Get next step with context
4. **`workflow_validate`** - Validate step output
5. **`workflow_validate_json`** - Validate workflow JSON
6. **`workflow_get_schema`** - Get workflow JSON schema
7. **`workrail_create_session`** - Create session
8. **`workrail_update_session`** - Update session
9. **`workrail_read_session`** - Read session (with JSONPath)
10. **`workrail_open_dashboard`** - Open dashboard

---

## Key Technologies

| Category | Technology |
|----------|-----------|
| **Runtime** | Node.js ≥20 |
| **Language** | TypeScript 5.9+ (strict mode) |
| **Protocol** | MCP SDK 0.5.0 |
| **Validation** | Ajv 8.17.1, Zod 3.22.4 |
| **CLI** | Commander 14.0.0 |
| **HTTP** | Express 5.1.0 |
| **Testing** | Vitest, Playwright |
| **Distribution** | npm, Docker |

---

## Security Features

✅ **Implemented**:
- Path traversal prevention
- Command injection prevention
- HTTPS-only (Git repos)
- Token authentication
- File size limits (1MB)
- File count limits (100)
- Context size limits (256KB)
- Shell argument escaping
- Timeout protection
- URL whitelisting

---

## Loop Optimization (60-80% Reduction)

### First Iteration (Full Context)
```json
{
  "_currentLoop": {
    "loopId": "analysis-loop",
    "loopStep": {
      "id": "analysis-loop",
      "type": "loop",
      "title": "Multi-Step Analysis",
      "prompt": "...",
      "loop": {...},
      "body": [...]  // Full body array
    }
  }
}
```

### Subsequent Iterations (Minimal Context)
```json
{
  "_currentLoop": {
    "loopId": "analysis-loop",
    "loopType": "for",
    "iteration": 2,
    "isFirstIteration": false,
    "phaseReference": {
      "loopId": "analysis-loop",
      "phaseTitle": "Multi-Step Analysis",
      "totalSteps": 4
    }
  }
}
```

**Result**: 60-80% smaller payload after first iteration

---

## Validation System

### Validation Types
- **contains**: Check for substring
- **regex**: Pattern matching
- **length**: Size constraints
- **schema**: JSON schema validation

### Composition
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

### Conditional Validation
```json
{
  "type": "contains",
  "value": "async",
  "condition": {"var": "useAsync", "equals": true}
}
```

---

## Quick Start for Developers

### 1. Setup
```bash
cd packages/workrail
npm install
npm run build
```

### 2. Run Tests
```bash
npm test              # Unit tests
npm run test:ui       # Vitest UI
npm run e2e           # E2E tests
```

### 3. Development
```bash
npm run watch         # Watch mode
npm run dev           # Build + run
```

### 4. Validate Workflow
```bash
node dist/cli.js validate workflows/my-workflow.json
```

### 5. Run as MCP Server
```bash
node dist/mcp-server.js
# Or via npx
npx -y @exaudeus/workrail
```

---

## External Workflows (Git Repos)

### Status
✅ **Infrastructure**: 100% complete  
⏳ **Integration**: Awaiting decision (Option A/B/C)  
📝 **Documentation**: Complete  

### Configuration
```bash
# Single repo
export WORKFLOW_GIT_REPOS=https://github.com/org/workflows.git
export GITHUB_TOKEN=ghp_xxx

# Multiple repos (comma-separated)
export WORKFLOW_GIT_REPOS=repo1.git,repo2.git
```

### Repository Structure
```
repo/
└── workflows/
    ├── workflow-1.json
    ├── workflow-2.json
    └── ...
```

### Authentication
1. Service-specific: `GITHUB_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN`
2. Hostname-based: `GIT_HOSTNAME_TOKEN`
3. Generic: `GIT_TOKEN`
4. SSH keys (automatic)

---

## Testing Strategy

| Type | Tool | Coverage | Location |
|------|------|----------|----------|
| **Unit** | Vitest | ~75% | `tests/unit/` |
| **Integration** | Vitest | ~60% | `tests/integration/` |
| **Contract** | Vitest | 100% | `tests/contract/` |
| **E2E** | Playwright | ~40% | `tests/e2e/`, `e2e/` |

**Test Principles**:
- Isolation (in-memory storage for tests)
- Mock external dependencies
- Test public interfaces, not internals
- High coverage for critical paths

---

## Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| **Workflow load time** | <50ms | Cached after first load |
| **Step resolution** | <10ms | In-memory operations |
| **Context validation** | <5ms | JSON size check |
| **Git clone** | 2-10s | First time only |
| **Git pull** | <2s | Updates only |
| **Loop optimization** | 60-80% | Context size reduction |
| **Memory usage** | <100MB | Typical workflow |
| **Startup time** | <500ms | Cold start |

---

## Common Workflows

| Name | Purpose | Complexity | Steps |
|------|---------|------------|-------|
| **coding-task-workflow-with-loops** | Comprehensive coding workflow | High | 25+ |
| **systematic-bug-investigation-with-loops** | Debugging methodology | High | 20+ |
| **mr-review-workflow** | Merge request review | Medium | 8 |
| **adaptive-ticket-creation** | Create tickets | Low | 5 |
| **exploration-workflow** | Codebase exploration | Medium | 6 |
| **document-creation-workflow** | Documentation | Medium | 7 |

---

## Entry Points

| File | Purpose | Export |
|------|---------|--------|
| `src/mcp-server.ts` | MCP protocol server | `runServer()` |
| `src/cli.ts` | Command-line interface | CLI commands |
| `src/container.ts` | DI container | `createAppContainer()` |
| `src/index.ts` | Package entry | Re-exports |

---

## Dependencies (Production)

Critical dependencies:
- `@modelcontextprotocol/sdk` (0.5.0) - MCP protocol
- `ajv` (8.17.1) - JSON schema validation
- `zod` (3.22.4) - Runtime validation
- `commander` (14.0.0) - CLI
- `express` (5.1.0) - Dashboard server

Total: 15 production dependencies

---

## Next Steps (Post-Analysis)

### For New Contributors
1. Read this summary
2. Read `CODEBASE_OVERVIEW.md` for depth
3. Browse `src/application/services/workflow-service.ts`
4. Run tests: `npm test`
5. Try a workflow: `node dist/cli.js list`

### For Integration
1. Review MCP tools section
2. Check `spec/mcp-api-v1.0.md`
3. Configure environment variables
4. Test with `npx -y @exaudeus/workrail`

### For External Workflows
1. Review `EXTERNAL_WORKFLOWS_INVESTIGATION.md`
2. Decide on Option A/B/C
3. Create example repository
4. Test with real workflows

---

## Resources

- **Main README**: `README.md` (user-facing)
- **Deep Overview**: `CODEBASE_OVERVIEW.md` (this document)
- **API Spec**: `spec/mcp-api-v1.0.md`
- **External Workflows**: `EXTERNAL_WORKFLOWS_INVESTIGATION.md`
- **Documentation Index**: `docs/README.md`

---

**Document Version**: 1.0  
**Date**: November 3, 2025  
**Codebase Version**: 0.6.1-beta.7  
**Branch**: feature/external-workflow-repositories

---

*This summary provides a quick reference to the WorkRail codebase. For comprehensive details, see CODEBASE_OVERVIEW.md.*



