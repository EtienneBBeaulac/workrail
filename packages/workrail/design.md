# Architectural Design: Workflow Documentation Feature

## 1. High-Level Approach

**matchPatterns()** - Building on established WorkRail architectural patterns:
- **Layered Architecture**: Following domain → application → infrastructure → types structure
- **Dependency Injection**: New DocumentationService injected via existing container pattern
- **Use Case Pattern**: New use cases following factory function approach in `/src/application/use-cases/`
- **Storage Abstraction**: Extending `IWorkflowStorage` interface for README resolution
- **MCP Tool Delegation**: Following existing pattern in `/src/mcp-server.ts` lines 390-442

**Design Philosophy:**
- **Progressive Enhancement**: Existing workflows continue functioning; documentation adds value without breaking changes
- **Stateless Resolution**: Documentation resolved per-request without caching or state management
- **Graceful Degradation**: Multiple fallback strategies ensure robust behavior
- **Interface-Based Design**: Clean abstractions enable testing and future extensibility

## 2. Component Breakdown

### 2.1 New Components

#### DocumentationService
**Location:** `/src/application/services/documentation-service.ts`
**Purpose:** Core service for documentation resolution with fallback logic
**Dependencies:** IWorkflowStorage, ValidationEngine (injected)

#### Use Cases
**Location:** `/src/application/use-cases/`
- `get-workflow-docs.ts` - Handle `workflow_docs` tool requests
- `get-workrail-help.ts` - Handle `workrail_help` tool requests

#### Type Definitions
**Location:** `/src/types/`
- Extended `WorkflowSummary` with `docsAvailable` and `helpHint` fields
- New `DocumentationMetadata` interface
- New `WorkflowDocsRequest/Response` interfaces

### 2.2 Modified Components

#### Schema Extension
**File:** `/spec/workflow.schema.json`
**Changes:** 
- Version bump to v0.3.0
- Add optional `documentation` object with enforced critical fields
- Add optional step `sensitivity` object

#### MCP Server
**File:** `/src/mcp-server.ts`  
**Changes:**
- Add `workflow_docs` and `workrail_help` tool definitions
- Add request handlers delegating to new use cases
- Update `workflow_list` to include documentation metadata

#### Container
**File:** `/src/container.ts`
**Changes:**
- Register DocumentationService with DI container
- Wire dependencies for new use cases

#### Storage Interface
**File:** `/src/types/storage.ts`
**Changes:**
- Extend `IWorkflowStorage` with README resolution methods
- Add optional documentation metadata methods

## 3. Data Models

### 3.1 Schema Extensions (v0.3.0)

```json
{
  "documentation": {
    "type": "object",
    "properties": {
      "summary": {"type": "string", "maxLength": 512},
      "whenToUse": {"type": "array", "items": {"type": "string"}},
      "whenNotToUse": {"type": "array", "items": {"type": "string"}},
      "inputs": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "required": {"type": "boolean"},
            "description": {"type": "string"}
          },
          "required": ["name"]
        }
      },
      "outputs": {"type": "array", "items": {"type": "string"}},
      "assumptions": {"type": "array", "items": {"type": "string"}},
      "risks": {"type": "array", "items": {"type": "string"}},
      "relatedWorkflows": {"type": "array", "items": {"type": "string"}},
      "helpHint": {"type": "string", "maxLength": 256}
    },
    "required": ["summary", "whenToUse", "inputs", "outputs", "risks"],
    "additionalProperties": false
  },
  "sensitivity": {
    "type": "object", 
    "properties": {
      "level": {"type": "string"},
      "notes": {"type": "string"}
    },
    "additionalProperties": false
  }
}
```

### 3.2 TypeScript Interfaces

```typescript
// Documentation metadata from JSON
export interface DocumentationMetadata {
  summary: string;
  whenToUse: string[];
  whenNotToUse?: string[];
  inputs: DocumentationInput[];
  outputs: string[];
  assumptions?: string[];
  risks: string[];
  relatedWorkflows?: string[];
  helpHint?: string;
}

export interface DocumentationInput {
  name: string;
  required?: boolean;
  description?: string;
}

// Step sensitivity
export interface StepSensitivity {
  level: string;
  notes?: string;
}

// Enhanced workflow summary
export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  docsAvailable: boolean;        // NEW
  helpHint?: string;             // NEW
}

// Documentation resolution result
export interface DocumentationResult {
  source: 'json' | 'readme' | 'fallback';
  format: 'json' | 'markdown' | 'text';
  content: DocumentationMetadata | string;
  sections?: Record<string, string>;
}
```

## 4. API Contracts

### 4.1 MCP Tool Contracts

#### workflow_docs Tool
```typescript
interface WorkflowDocsRequest {
  id: string;
  mode?: 'preview' | 'full';
  sections?: string[];
  format?: 'text' | 'markdown' | 'json';
}

interface WorkflowDocsResponse {
  content: [{
    type: 'text';
    text: string; // JSON string or formatted text
  }];
  isError?: boolean;
}
```

#### workrail_help Tool
```typescript
interface WorkrailHelpRequest {
  section?: 'overview' | 'workflows' | 'troubleshooting' | 'faq';
  format?: 'text' | 'markdown' | 'json';
}

interface WorkrailHelpResponse {
  content: [{
    type: 'text';
    text: string;
  }];
  isError?: boolean;
}
```

### 4.2 Service Contracts

#### DocumentationService Interface
```typescript
export interface IDocumentationService {
  /**
   * Resolve documentation for a workflow with fallback logic
   */
  resolveDocumentation(
    workflowId: string,
    mode?: 'preview' | 'full',
    sections?: string[],
    format?: 'text' | 'markdown' | 'json'
  ): Promise<DocumentationResult>;

  /**
   * Get WorkRail platform help documentation
   */
  getWorkrailHelp(
    section?: 'overview' | 'workflows' | 'troubleshooting' | 'faq',
    format?: 'text' | 'markdown' | 'json'
  ): Promise<DocumentationResult>;

  /**
   * Check if documentation is available for a workflow
   */
  isDocumentationAvailable(workflowId: string): Promise<boolean>;
}
```

#### Extended Storage Interface
```typescript
export interface IWorkflowStorage {
  // Existing methods...
  loadAllWorkflows(): Promise<Workflow[]>;
  getWorkflowById(id: string): Promise<Workflow | null>;
  listWorkflowSummaries(): Promise<WorkflowSummary[]>;

  // New documentation methods
  getWorkflowReadme?(workflowId: string): Promise<string | null>;
  hasDocumentation?(workflowId: string): Promise<boolean>;
}
```

## 5. Key Interactions

### 5.1 Documentation Resolution Flow

```
MCP Request → Use Case → DocumentationService → Storage Layer
     ↓              ↓              ↓               ↓
workflow_docs → get-workflow-docs → resolveDocumentation → getWorkflowById + getWorkflowReadme
     ↓              ↓              ↓               ↓
Response ← JSON/Text ← DocumentationResult ← Workflow + README
```

### 5.2 Fallback Resolution Algorithm

```
1. Load workflow by ID from storage
2. If workflow.documentation exists:
   - For preview mode: return JSON metadata
   - For full mode: check for README, fallback to compiled JSON
3. If no workflow.documentation:
   - Try to load README file via storage
   - Parse README sections if available
   - Return fallback message if neither available
4. Apply sections filter if requested
5. Format response according to format parameter
```

### 5.3 Component Dependencies

```
Container
├── DocumentationService (new)
│   ├── IWorkflowStorage (existing)
│   └── ValidationEngine (existing)
├── GetWorkflowDocsUseCase (new)
│   └── DocumentationService
├── GetWorkrailHelpUseCase (new)
│   └── DocumentationService
└── MCP Server (modified)
    ├── GetWorkflowDocsUseCase
    └── GetWorkrailHelpUseCase
```

## 6. Integration Points

### 6.1 Container Integration
**File:** `/src/container.ts`
```typescript
export function createAppContainer(overrides: Partial<AppContainer> = {}): AppContainer {
  const storage = overrides.storage ?? createDefaultWorkflowStorage();
  const validationEngine = overrides.validationEngine ?? new ValidationEngine();
  const documentationService = overrides.documentationService ?? 
    new DefaultDocumentationService(storage, validationEngine);
  
  // ... rest of container setup
}
```

### 6.2 MCP Tool Registration
**File:** `/src/mcp-server.ts`
```typescript
const WORKFLOW_DOCS_TOOL: Tool = {
  name: "workflow_docs",
  description: "Retrieve workflow documentation with progressive disclosure",
  inputSchema: { /* schema definition */ }
};

// In request handler:
case "workflow_docs":
  const getWorkflowDocs = createGetWorkflowDocs(container.documentationService);
  return await getWorkflowDocs(args.id, args.mode, args.sections, args.format);
```

### 6.3 Storage Layer Integration
Each storage implementation extends base interface:
- **FileWorkflowStorage**: Read README files from filesystem
- **GitWorkflowStorage**: Resolve README from git repository
- **RemoteWorkflowStorage**: Fetch README from remote source
- **CachingWorkflowStorage**: Cache README resolution results

## 7. Phase 2 Decisions Impact

### 7.1 Clarification Decisions Applied

1. **MCP Integration → Use Cases + ValidationEngine**
   - All new MCP tools delegate to use cases following existing pattern
   - ValidationEngine integration for schema validation of documentation fields

2. **Schema v0.3.0 → Minor Version Bump**
   - Backward compatible optional documentation object
   - Enforced critical fields when documentation present

3. **DocumentationService → New Service via DI**
   - Clean service abstraction with interface contract
   - Dependency injection via existing container pattern

4. **Storage Integration → Interface Extension**
   - Each storage implementation handles README resolution
   - Optional methods maintain backward compatibility

5. **Backward Compatibility → Migration Required**
   - Existing workflows continue functioning without documentation
   - `workflow_list` shows `docsAvailable: false` for undocumented workflows
   - Graceful degradation with fallback messages

## 8. Complexity Factors

### 8.1 Identified Complexity Areas

1. **Multi-Storage README Resolution**
   - Each storage type requires different README handling
   - File paths, git references, remote URLs need different resolution logic
   - Error handling across storage implementations

2. **Schema Validation Integration**
   - Critical field enforcement when documentation object present
   - Validation error handling and user-friendly messages
   - Schema migration validation for v0.3.0

3. **Documentation Format Conversion**
   - JSON → text/markdown conversion
   - README parsing for section extraction
   - Consistent formatting across different sources

4. **Fallback Chain Robustness**
   - Multiple failure points in resolution chain
   - Graceful degradation without breaking workflow execution
   - Clear error messages for debugging

### 8.2 Risk Mitigation Strategies

- **Interface-based design** enables testing individual components
- **Comprehensive fallbacks** prevent complete failure
- **ValidationEngine integration** ensures consistent error handling
- **Existing pattern compliance** reduces integration risks

## 9. Pattern Alignment

### 9.1 Existing Patterns Followed

**applyUserRules()** - Design aligns with user preferences:

1. **Dependency Injection** (`/src/container.ts` lines 28-42)
   - DocumentationService injected via existing container
   - Interface-based abstractions for testability

2. **Use Case Pattern** (`/src/application/use-cases/get-workflow.ts`)
   - Factory functions returning pure use case functions
   - Dependencies injected at creation time

3. **MCP Tool Delegation** (`/src/mcp-server.ts` lines 390-442)
   - Tools delegate to use cases, not direct service calls
   - Consistent error handling and response formatting

4. **Storage Abstraction** (`/src/types/storage.ts`)
   - Interface extension maintains existing contract
   - Optional methods for backward compatibility

5. **Validation Integration** (`/src/application/services/validation-engine.ts`)
   - Schema validation using existing ValidationEngine
   - Consistent error message formatting

### 9.2 Architectural Consistency

- **Stateless Design**: No caching or state management in MCP layer
- **Clean Separation**: Business logic in services, coordination in use cases
- **Interface Contracts**: Clear boundaries between layers
- **Error Handling**: Consistent with existing error patterns
- **Testing Strategy**: Unit/integration/contract tests following existing structure

## 10. Implementation Phases

### Phase 1: Core Services & Schema
1. Update workflow schema to v0.3.0
2. Implement DocumentationService interface and default implementation
3. Update container for dependency injection
4. Add validation for critical documentation fields

### Phase 2: MCP Tool Integration
1. Add tool definitions to mcp-server.ts
2. Implement get-workflow-docs and get-workrail-help use cases
3. Update workflow_list to include documentation metadata
4. Test MCP tool responses

### Phase 3: Storage Extension
1. Extend IWorkflowStorage interface with README methods
2. Update FileWorkflowStorage for README resolution
3. Update other storage implementations
4. Test fallback behavior across storage types

### Phase 4: Validation & Testing
1. Integrate critical field validation with ValidationEngine
2. Comprehensive unit tests for DocumentationService
3. Integration tests for MCP tools
4. Contract tests for API responses
5. Backward compatibility verification

This design provides a comprehensive foundation for implementing the workflow documentation feature while maintaining full alignment with existing architectural patterns and user preferences.




