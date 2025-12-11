# Workflow Documentation Feature Specification

## Task Description

Implement a comprehensive workflow documentation system for WorkRail that provides stateless, text-only access to workflow and platform documentation. The system will enable agents and users to quickly understand workflow purpose, requirements, risks, and usage patterns without requiring UI controls or cross-session persistence.

## Key Objectives & Success Criteria

### Primary Objectives
1. **Self-Explanatory Workflows**: Every workflow becomes self-documenting with clear purpose, inputs, outputs, and risks
2. **Fast Decision Making**: Agents can quickly determine if a workflow fits the user's intent via preview/summary data
3. **Safety & Risk Management**: Sensitive operations are clearly documented and surfaced before execution
4. **Stateless Discovery**: Documentation accessible via text-only MCP tools without requiring first-run detection or persistence

### Success Criteria
-  New MCP tools (`workflow_docs`, `workrail_help`) provide progressive disclosure of documentation
-  Schema v0.3.0 supports optional `documentation` object with enforced critical fields
-  Step-level `sensitivity` tags enable automatic risk surfacing
-  README resolution with fallback algorithm (JSON → README → defaults)
-  Backward compatibility maintained for existing workflows
-  Integration with existing ValidationEngine and error handling patterns

## Scope and Constraints

### In Scope
- **Schema Extension**: Add `documentation` object to workflow schema v0.3.0
- **Step Sensitivity**: Add optional `sensitivity` tags to steps for risk detection
- **MCP Tools**: Implement `workflow_docs` and `workrail_help` tools
- **Documentation Service**: New service for documentation resolution and fallback logic
- **Storage Integration**: Extend storage abstractions to support README file resolution
- **Use Case Implementation**: Follow existing patterns for new use cases
- **Validation Integration**: Enforce critical documentation fields via ValidationEngine

### Out of Scope
- **Internationalization**: No multi-language support needed
- **CLI Commands**: Documentation linting/validation commands not defined
- **Migration Tools**: No automated migration assistance for existing workflows
- **UI Elements**: No buttons, controls, or visual interfaces
- **Cost/Runtime Estimates**: No prediction capabilities
- **First-Run Detection**: No user state tracking or onboarding flows

### Constraints
- **Stateless Design**: MCP remains stateless, no agent system access
- **Text-Only Interface**: All interactions via text, no UI affordances
- **Backward Compatibility**: Existing workflows must continue functioning
- **Schema Migration**: Workflows without documentation should gracefully degrade
- **User Rule Alignment**: Follow established architectural patterns and preferences

## System Integration Approach

### Architecture Integration
**applyUserRules()**: The implementation will follow established user preferences:
- Dependency injection via existing container pattern
- Immutable patterns for data handling
- Clean, extensible architecture with interface abstractions
- Stateless MCP design without agent system coupling

**matchPatterns()**: Integration follows existing WorkRail patterns:
- **MCP Tool Pattern**: Tools defined in `/src/mcp-server.ts` (lines 178-326) with delegation to use cases
- **Use Case Pattern**: New use cases in `/src/application/use-cases/` following existing structure
- **Service Pattern**: New `DocumentationService` injected via `/src/container.ts`
- **Storage Pattern**: Extend `IWorkflowStorage` interface for README resolution
- **Validation Pattern**: Integration with existing `ValidationEngine` for schema validation

### Component Integration

#### 1. Schema Layer (`/spec/workflow.schema.json`)
- **Version**: Bump to v0.3.0 (minor version)
- **Documentation Object**: Optional with enforced critical fields
  ```json
  "documentation": {
    "summary": "required string ≤512 chars",
    "whenToUse": "required array of strings",
    "inputs": "required array with name/required/description",
    "outputs": "required array of strings", 
    "risks": "required array of strings",
    "assumptions": "optional array",
    "relatedWorkflows": "optional array",
    "helpHint": "optional string"
  }
  ```
- **Step Sensitivity**: Optional free-form tags
  ```json
  "sensitivity": {
    "level": "string (free-form)",
    "notes": "optional string"
  }
  ```

#### 2. MCP Server Layer (`/src/mcp-server.ts`)
- **New Tools**: Add `workflow_docs` and `workrail_help` tool definitions
- **Request Handling**: Delegate to use cases following existing pattern (lines 390-442)
- **Tool Registration**: Follow existing tool registration pattern

#### 3. Application Layer 
- **DocumentationService**: New service for resolution logic and fallback handling
- **Use Cases**: 
  - `get-workflow-docs.ts` - Handle `workflow_docs` tool requests
  - `get-workrail-help.ts` - Handle `workrail_help` tool requests
- **Container Integration**: Inject DocumentationService via existing DI container

#### 4. Storage Layer (`/src/infrastructure/storage/`)
- **Interface Extension**: Add README resolution methods to `IWorkflowStorage`
- **Implementation Updates**: Each storage implementation handles README files:
  - `FileWorkflowStorage` - File system README resolution
  - `GitWorkflowStorage` - Git-based README handling
  - `RemoteWorkflowStorage` - Remote README fetching
  - Others gracefully degrade or delegate

#### 5. Validation Layer (`/src/validation/`)
- **Schema Validation**: Extend existing ValidationEngine for documentation fields
- **Critical Field Enforcement**: Validate required documentation fields when present
- **Error Integration**: Use existing error handling patterns

## Impact on Components/Workflows

### Existing Workflows
- **Backward Compatibility**: Workflows without documentation continue functioning
- **Graceful Degradation**: `workflow_list` shows `docsAvailable: false` for undocumented workflows
- **Migration Requirement**: Eventually require documentation for full feature support

### New Tool Contracts

#### `workflow_docs` Tool
```typescript
interface WorkflowDocsRequest {
  id: string;
  mode?: "preview" | "full";
  sections?: string[];
  format?: "text" | "markdown" | "json";
}

interface WorkflowDocsResponse {
  // Preview mode: JSON with critical fields
  // Full mode: README content or compiled documentation
  // Sections mode: Targeted content slices
}
```

#### `workrail_help` Tool
```typescript
interface WorkrailHelpRequest {
  section?: "overview" | "workflows" | "troubleshooting" | "faq";
  format?: "text" | "markdown" | "json";
}
```

#### Enhanced `workflow_list`
```typescript
interface WorkflowListItem {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  docsAvailable: boolean;        // NEW
  helpHint?: string;             // NEW
}
```

## Testing/Quality Alignment

### Testing Strategy
- **Unit Tests**: Test DocumentationService resolution logic, fallback behavior
- **Integration Tests**: Test MCP tool responses, schema validation, storage integration
- **Contract Tests**: Verify MCP tool response schemas match expected formats
- **Validation Tests**: Test critical field enforcement and error handling

### Quality Gates
- **Schema Validation**: All documentation objects must validate against v0.3.0 schema
- **Critical Fields**: Enforce required fields (summary, whenToUse, inputs, outputs, risks)
- **Backward Compatibility**: Existing workflows must continue functioning
- **Error Handling**: Graceful fallback when documentation unavailable

## Phase 2 Decisions Integration

### Clarification Decisions Applied
1. **MCP Integration**: Tools delegate to use cases with ValidationEngine integration ✓
2. **Schema Version**: v0.3.0 minor bump with enforced critical fields ✓
3. **Service Architecture**: New DocumentationService with DI integration ✓
4. **Storage Integration**: Each storage implementation handles README resolution ✓
5. **Backward Compatibility**: Require migration, no migration tools, list works ✓
6. **Internationalization**: Not implemented (removed complexity) ✓

### Complexity Validation
The **Large** complexity classification remains appropriate due to:
- Multiple new services and architectural components
- Schema versioning with migration implications
- Cross-cutting integration across storage, validation, and MCP layers
- New tool contracts with comprehensive resolution logic

## Implementation Phases

### Phase 1: Schema & Core Services
1. Update workflow schema to v0.3.0
2. Implement DocumentationService with resolution logic
3. Update container for DI integration

### Phase 2: MCP Tool Integration  
1. Add tool definitions to mcp-server.ts
2. Implement use cases for new tools
3. Integrate with existing validation patterns

### Phase 3: Storage Extension
1. Extend IWorkflowStorage interface
2. Update storage implementations for README support
3. Test fallback behavior across implementations

### Phase 4: Validation & Testing
1. Integrate critical field validation
2. Comprehensive test coverage
3. Backward compatibility verification

This specification provides a comprehensive foundation for implementing the workflow documentation feature while maintaining alignment with existing architectural patterns and user preferences.




