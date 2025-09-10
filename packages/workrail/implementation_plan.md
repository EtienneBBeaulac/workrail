# Implementation Plan: Workflow Documentation Feature

## 1. Goal Clarification

**From Specification & Clarifications:**
- Implement stateless, text-only workflow documentation system
- Add `workflow_docs` and `workrail_help` MCP tools with progressive disclosure
- Extend schema to v0.3.0 with optional `documentation` object
- Create DocumentationService with JSON → README → fallback resolution
- Maintain backward compatibility for existing workflows
- Integrate with existing ValidationEngine for critical field enforcement

**Success Criteria:**
- New MCP tools provide documentation access without UI elements
- Schema validates documentation fields when present
- Storage layer supports README resolution across implementations
- Existing workflows continue functioning without modification
- Tests maintain >80% coverage following existing patterns

## 2. applyUserRules() - Pattern Compliance

**Dependency Injection Patterns:**
- DocumentationService injected via existing container (`/src/container.ts`)
- Interface-based design (`IDocumentationService`) for testability
- Service dependencies injected at construction time

**Clean Architecture Alignment:**
- New components follow domain → application → infrastructure → types layering
- Use case pattern with factory functions (following `/src/application/use-cases/get-workflow.ts`)
- MCP tool delegation to use cases (following `/src/mcp-server.ts` pattern)

**Stateless MCP Design:**
- No caching or state management in MCP layer
- Context passed via parameters, not stored
- Documentation resolved per-request

**Existing File Preference:**
- Extend existing interfaces rather than creating parallel systems
- Modify existing schema file for v0.3.0
- Update existing container and MCP server files

## 3. Pattern Matching Strategy

### 3.1 Service Implementation Pattern
**Template:** `/src/application/services/workflow-service.ts` (lines 59-68)
```typescript
export class DefaultWorkflowService implements WorkflowService {
  constructor(
    private readonly storage: IWorkflowStorage = createDefaultWorkflowStorage(),
    private readonly validationEngine: ValidationEngine = new ValidationEngine()
  ) {}
}
```

**Apply to:** DocumentationService with similar constructor injection pattern

### 3.2 Use Case Factory Pattern  
**Template:** `/src/application/use-cases/get-workflow.ts` (lines 31-32)
```typescript
export function createGetWorkflow(service: WorkflowService) {
  return async (workflowId: string, mode: WorkflowGetMode = 'preview'): Promise<WorkflowGetResult> => {
```

**Apply to:** `createGetWorkflowDocs` and `createGetWorkrailHelp` functions

### 3.3 Storage Interface Extension Pattern
**Template:** `/src/types/storage.ts` (lines 12-34)
```typescript
export interface IWorkflowStorage {
  loadAllWorkflows(): Promise<Workflow[]>;
  // Optional methods for extensibility
  save?(workflow: Workflow): Promise<void>;
}
```

**Apply to:** Add optional README methods to maintain backward compatibility

### 3.4 Container Registration Pattern
**Template:** `/src/container.ts` (lines 28-34)
```typescript
export function createAppContainer(overrides: Partial<AppContainer> = {}): AppContainer {
  const storage = overrides.storage ?? createDefaultWorkflowStorage();
  const service = overrides.service ?? new DefaultService(storage, validationEngine);
}
```

**Apply to:** Register DocumentationService with dependency injection

### 3.5 Test Structure Pattern
**Template:** `/tests/unit/workflow-service.test.ts` structure
- Describe blocks for each method
- Mock dependencies via constructor injection
- Test success/error paths separately
- Integration tests in `/tests/integration/`

## 4. Impact Assessment

### 4.1 Affected Components

**High Impact (Major Changes):**
- `/spec/workflow.schema.json` - Schema version bump to v0.3.0
- `/src/container.ts` - Add DocumentationService registration
- `/src/mcp-server.ts` - Add new tool definitions and handlers

**Medium Impact (New Files):**
- `/src/application/services/documentation-service.ts` - New service implementation
- `/src/application/use-cases/get-workflow-docs.ts` - New use case
- `/src/application/use-cases/get-workrail-help.ts` - New use case
- `/src/types/documentation-types.ts` - New type definitions

**Low Impact (Interface Extensions):**
- `/src/types/storage.ts` - Add optional README methods
- `/src/types/mcp-types.ts` - Extend WorkflowSummary interface

### 4.2 Dependencies & Risks

**Dependencies:**
- Existing ValidationEngine for schema validation
- Storage implementations for README resolution
- MCP SDK for tool definitions

**Risks:**
1. **Schema Migration Risk**: v0.3.0 could break existing validation
   - **Mitigation**: Comprehensive backward compatibility testing
2. **Storage Implementation Variance**: Different README handling across storage types
   - **Mitigation**: Optional interface methods with graceful degradation
3. **Performance Risk**: README file I/O on every documentation request
   - **Mitigation**: Document performance characteristics, consider future caching

## 5. Implementation Strategy

### Phase 1: Schema & Core Services (Priority 1)

#### Step 1.1: Update Workflow Schema
**File:** `/spec/workflow.schema.json`
**Rationale:** Foundation for all other changes; enables validation
**Input:** Current schema v0.2.0
**Output:** Schema v0.3.0 with documentation object and sensitivity tags

**Implementation:**
```json
{
  "$id": "https://workflowlookup.io/schemas/workflow/v0.3.0",
  "properties": {
    "documentation": {
      "type": "object",
      "properties": {
        "summary": {"type": "string", "maxLength": 512},
        "whenToUse": {"type": "array", "items": {"type": "string", "maxLength": 256}, "maxItems": 10},
        "whenNotToUse": {"type": "array", "items": {"type": "string", "maxLength": 256}, "maxItems": 5},
        "inputs": {"type": "array", "items": {"$ref": "#/$defs/documentationInput"}, "maxItems": 20},
        "outputs": {"type": "array", "items": {"type": "string", "maxLength": 256}, "maxItems": 10},
        "assumptions": {"type": "array", "items": {"type": "string", "maxLength": 256}, "maxItems": 10},
        "risks": {"type": "array", "items": {"type": "string", "maxLength": 256}, "maxItems": 10},
        "relatedWorkflows": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
        "helpHint": {"type": "string", "maxLength": 256}
      },
      "required": ["summary", "whenToUse", "inputs", "outputs", "risks"],
      "additionalProperties": false
    },
    "sensitivity": {
      "type": "object",
      "properties": {
        "level": {"type": "string", "maxLength": 50},
        "notes": {"type": "string", "maxLength": 256}
      },
      "additionalProperties": false
    }
  }
}
```

**Size Limits Added:** Prevent large documentation objects from impacting performance

#### Step 1.2: Create Documentation Types
**File:** `/src/types/documentation-types.ts`
**Rationale:** Type safety for new interfaces
**Input:** Schema definitions
**Output:** TypeScript interfaces matching schema

**Implementation:**
```typescript
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

export interface DocumentationResult {
  source: 'json' | 'readme' | 'fallback';
  format: 'json' | 'markdown' | 'text';
  content: DocumentationMetadata | string;
  sections?: Record<string, string>;
}
```

#### Step 1.3: Implement DocumentationService
**File:** `/src/application/services/documentation-service.ts`
**Rationale:** Core business logic for documentation resolution
**Input:** IWorkflowStorage, ValidationEngine
**Output:** Service with resolution methods

**Implementation Pattern:** Follow `DefaultWorkflowService` constructor injection pattern
```typescript
export interface IDocumentationService {
  resolveDocumentation(workflowId: string, mode?: 'preview' | 'full', sections?: string[], format?: string): Promise<DocumentationResult>;
  isDocumentationAvailable(workflowId: string): Promise<boolean>;
  getWorkrailHelp(section?: string, format?: string): Promise<DocumentationResult>;
}

export class DefaultDocumentationService implements IDocumentationService {
  constructor(
    private readonly storage: IWorkflowStorage,
    private readonly validationEngine: ValidationEngine
  ) {}
}
```

#### Step 1.4: Update Container Registration
**File:** `/src/container.ts`
**Rationale:** Enable dependency injection for new service
**Input:** Existing container structure
**Output:** Container with DocumentationService registration

**Implementation:** Follow existing service registration pattern
```typescript
export interface AppContainer {
  // existing services...
  documentationService: IDocumentationService;
}

export function createAppContainer(overrides: Partial<AppContainer> = {}): AppContainer {
  const documentationService = overrides.documentationService ?? 
    new DefaultDocumentationService(storage, validationEngine);
  
  return { /* ... */, documentationService };
}
```

### Phase 2: MCP Tool Integration (Priority 2)

#### Step 2.1: Create Use Cases
**Files:** 
- `/src/application/use-cases/get-workflow-docs.ts`
- `/src/application/use-cases/get-workrail-help.ts`

**Rationale:** Follow existing use case delegation pattern
**Input:** DocumentationService
**Output:** Factory functions for MCP tool handlers

**Implementation Pattern:** Follow `createGetWorkflow` factory pattern
```typescript
export function createGetWorkflowDocs(service: IDocumentationService) {
  return async (id: string, mode?: string, sections?: string[], format?: string): Promise<DocumentationResult> => {
    return await service.resolveDocumentation(id, mode, sections, format);
  };
}
```

#### Step 2.2: Add MCP Tool Definitions
**File:** `/src/mcp-server.ts`
**Rationale:** Expose new tools via MCP protocol
**Input:** Existing tool definitions pattern
**Output:** New tool definitions for workflow_docs and workrail_help

**Implementation Pattern:** Follow existing tool definition structure (lines 178-326)
```typescript
const WORKFLOW_DOCS_TOOL: Tool = {
  name: "workflow_docs",
  description: "Retrieve workflow documentation with progressive disclosure",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Workflow identifier" },
      mode: { type: "string", enum: ["preview", "full"], default: "preview" },
      sections: { type: "array", items: { type: "string" } },
      format: { type: "string", enum: ["text", "markdown", "json"], default: "text" }
    },
    required: ["id"]
  }
};
```

#### Step 2.3: Add Request Handlers
**File:** `/src/mcp-server.ts`
**Rationale:** Handle MCP requests for new tools
**Input:** Existing request handler pattern
**Output:** New case handlers in switch statement

**Implementation Pattern:** Follow existing handler pattern (lines 390-442)
```typescript
case "workflow_docs":
  const getWorkflowDocs = createGetWorkflowDocs(container.documentationService);
  return await getWorkflowDocs(args.id, args.mode, args.sections, args.format);
```

#### Step 2.4: Update workflow_list Tool
**File:** `/src/mcp-server.ts`
**Rationale:** Add documentation metadata to workflow list
**Input:** Existing workflow_list implementation
**Output:** Enhanced WorkflowSummary with docsAvailable and helpHint

**Implementation:** Extend existing `listWorkflows` method

### Phase 3: Storage Extension (Priority 3)

#### Step 3.1: Extend Storage Interface
**File:** `/src/types/storage.ts`
**Rationale:** Enable README resolution across storage implementations
**Input:** Existing IWorkflowStorage interface
**Output:** Interface with optional README methods

**Implementation Pattern:** Follow optional method pattern (line 33)
```typescript
export interface IWorkflowStorage {
  // existing methods...
  getWorkflowReadme?(workflowId: string): Promise<string | null>;
  hasDocumentation?(workflowId: string): Promise<boolean>;
}
```

#### Step 3.2: Update FileWorkflowStorage
**File:** `/src/infrastructure/storage/file-workflow-storage.ts`
**Rationale:** Primary storage implementation for README files
**Input:** Existing file operations pattern
**Output:** README resolution methods

**README File Convention:** `{workflowId}.md` in same directory as workflow JSON files

**Implementation Pattern:** Follow existing file operations with security integration (lines 15-32)
```typescript
async getWorkflowReadme(workflowId: string): Promise<string | null> {
  // Use existing security functions
  const sanitizedId = sanitizeId(workflowId);
  const readmePath = path.resolve(this.baseDir, `${sanitizedId}.md`);
  
  // Security check using existing function
  assertWithinBase(readmePath, this.baseDir);
  
  if (!existsSync(readmePath)) return null;
  
  // Check file size limit (1MB max)
  const stats = statSync(readmePath);
  if (stats.size > 1_000_000) {
    throw new InvalidWorkflowError(workflowId, 'README file too large (max 1MB)');
  }
  
  try {
    return await fs.readFile(readmePath, 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new InvalidWorkflowError(workflowId, `Failed to read README: ${error.message}`);
  }
}

async hasDocumentation(workflowId: string): Promise<boolean> {
  const workflow = await this.getWorkflowById(workflowId);
  if (!workflow) return false;
  
  // Has documentation if JSON object exists OR README file exists
  if (workflow.documentation) return true;
  
  const sanitizedId = sanitizeId(workflowId);
  const readmePath = path.resolve(this.baseDir, `${sanitizedId}.md`);
  assertWithinBase(readmePath, this.baseDir);
  
  return existsSync(readmePath);
}
```

**Security Integration:** Uses existing `sanitizeId` and `assertWithinBase` functions
**Error Handling:** Explicit handling for file access errors and size limits

#### Step 3.3: Update Other Storage Implementations
**Files:** Git, Remote, Caching storage implementations
**Rationale:** Consistent README support across all storage types
**Input:** Storage-specific patterns
**Output:** README methods or graceful degradation

### Phase 4: Validation & Testing (Priority 4)

#### Step 4.1: Schema Validation Integration
**File:** `/src/application/services/validation-engine.ts`
**Rationale:** Validate critical documentation fields
**Input:** Existing validation patterns
**Output:** Documentation field validation

#### Step 4.2: Unit Tests
**Files:** `/tests/unit/documentation-service.test.ts`, etc.
**Rationale:** Follow existing test coverage patterns
**Input:** Test structure from `/tests/unit/workflow-service.test.ts`
**Output:** Comprehensive test coverage

**Test Structure Pattern:**
```typescript
describe('DocumentationService', () => {
  describe('resolveDocumentation', () => {
    it('should return JSON documentation when available', async () => {
      // Test implementation
    });
    
    it('should fallback to README when JSON unavailable', async () => {
      // Test implementation
    });
  });
});
```

#### Step 4.3: Integration Tests
**Files:** `/tests/integration/documentation-integration.test.ts`
**Rationale:** Test full MCP tool workflow
**Input:** Integration test patterns
**Output:** End-to-end test coverage

## 6. Testing Strategy

### 6.1 Unit Testing (Following Existing Patterns)

**Template:** `/tests/unit/workflow-service.test.ts`
- Mock dependencies via constructor injection
- Test each service method independently
- Separate success/error path tests
- Use Jest framework with existing setup

**New Test Files:**
- `documentation-service.test.ts` - Core service logic
- `get-workflow-docs.test.ts` - Use case testing
- `get-workrail-help.test.ts` - Use case testing

### 6.2 Integration Testing

**Template:** `/tests/integration/workflow-get-schema-integration.test.ts`
- Test MCP tool end-to-end workflow
- Use real storage implementations
- Validate response formats and schemas

**New Test Files:**
- `documentation-integration.test.ts` - Full workflow documentation flow
- `storage-readme-integration.test.ts` - Storage layer README resolution

### 6.3 Contract Testing

**Template:** `/tests/contract/comprehensive-api-endpoints.test.ts`
- Validate MCP tool response schemas
- Test API contracts for new tools
- Ensure backward compatibility

## 7. Failure Handling

### 7.1 Test Failure Protocols

**Unit Test Failures:**
1. Check mock setup and dependency injection
2. Verify interface contracts match implementations
3. Review error handling paths
4. **Max 2 attempts** before escalating to user

**Integration Test Failures:**
1. Verify storage setup and file permissions
2. Check MCP tool registration and routing
3. Validate response format compliance
4. **Max 2 attempts** before escalating to user

### 7.2 Tool Issues

**Schema Validation Failures:**
- Check schema syntax and references
- Validate example workflows against new schema
- Ensure backward compatibility for existing workflows
- **Critical:** Test partial documentation objects don't break validation

**Storage Implementation Issues:**
- Test README file access and permissions
- Verify path sanitization using existing security functions
- Check graceful degradation for missing files
- **New:** Test file size limits and encoding error handling
- **New:** Verify README file naming convention compliance

**MCP Tool Registration Issues:**
- Verify tool definitions match implementation
- Check parameter validation and error handling
- Test response format consistency
- **New:** Test documentation resolution fallback chain
- **New:** Verify circular dependency prevention in related workflows

## 8. Final Review Checklist

### 8.1 Functionality Verification
- [ ] `workflow_docs` tool returns documentation in all modes (preview/full)
- [ ] `workrail_help` tool provides platform documentation
- [ ] `workflow_list` includes documentation availability flags
- [ ] Documentation resolution follows JSON → README → fallback algorithm
- [ ] Critical fields validated when documentation object present
- [ ] Existing workflows continue functioning without modification

### 8.2 Quality Assurance  
- [ ] Unit test coverage >80% for new components
- [ ] Integration tests pass for all MCP tools
- [ ] Schema v0.3.0 validates successfully
- [ ] No breaking changes to existing API contracts
- [ ] Error handling provides clear, actionable messages
- [ ] Security: Path traversal prevention in README resolution

### 8.3 Performance & Compatibility
- [ ] Documentation resolution performance acceptable (<500ms typical)
- [ ] Memory usage within acceptable bounds
- [ ] Backward compatibility verified with existing workflows
- [ ] All storage implementations handle README resolution gracefully
- [ ] MCP tool responses conform to expected schemas

### 8.4 Documentation & Maintenance
- [ ] Code follows existing patterns and conventions
- [ ] TypeScript interfaces provide clear contracts
- [ ] Error messages are user-friendly and actionable
- [ ] Implementation enables future extensibility
- [ ] **New:** README file naming convention documented and enforced
- [ ] **New:** Security functions properly integrated (sanitizeId, assertWithinBase)
- [ ] **New:** File size limits enforced (1MB max for README files)
- [ ] **New:** Encoding error handling prevents crashes

## 9. Out-of-Scope Items (Future Enhancements)

**Performance Optimizations (Future):**
- Integration with FileWorkflowStorage caching mechanism
- Documentation content caching strategy
- Lazy loading for large documentation objects

**Advanced Features (Future):**
- Internationalization support for multi-language README files
- Documentation analytics and usage tracking
- Automated documentation quality scoring
- Cross-workflow documentation dependency analysis

**Tooling Enhancements (Future):**
- CLI commands for documentation linting and validation
- Automated README template generation
- Documentation migration tools for existing workflows
- Visual documentation browser/explorer

**Security Enhancements (Future):**
- Content Security Policy for documentation rendering
- Documentation access logging and auditing
- Encrypted documentation storage options

These items were identified during planning but are not critical for the core documentation feature functionality.

**Final Implementation Plan Status:** Ready for execution with critical risks addressed and clear success criteria defined.
