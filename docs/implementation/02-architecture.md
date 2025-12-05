# Architecture Guide

> 🏛️ **System architecture and design principles**

[![Build](https://img.shields.io/github/actions/workflow/status/EtienneBBeaulac/mcp/ci.yml?branch=main)]()
[![Spec Version](https://img.shields.io/badge/spec-1.0.0-blue.svg)](specs/)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.org)

##  Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Layers](#architecture-layers)
3. [Component Roles](#component-roles)
4. [Data Flow](#data-flow)
5. [Key Technical Decisions](#key-technical-decisions)
6. [Scalability & Monitoring](#scalability--monitoring)
7. [Migration Paths](#migration-paths)
8. [References](#references)

---

## System Overview

The MVP is fully implemented using **Clean Architecture**.  Responsibilities are split into **Domain**, **Application**, and **Infrastructure** layers wired together by a lightweight **dependency-injection container**.

```
┌───────────┐   JSON-RPC    ┌───────────────┐  Uses  ┌─────────────┐
│ AI Agent  │ ───────────▶ │  RPC Adapter   │ ─────▶ │  Use Cases  │
└───────────┘    stdin      │  (server.ts)  │        └─────┬──────┘
                     ▼      └───────────────┘              │DTOs
                  stdout                  calls            ▼
                                     ┌───────────────┐  pure logic
                                     │   Domain      │◀───────────
                                     └───────────────┘  Entities
```

---

## Architecture Layers

| Layer | Folder | Responsibilities | Depends On |
|-------|--------|------------------|------------|
| Domain | `src/domain` | Pure entities & error classes | – |
| Application | `src/application` | Use-cases, services, validation | Domain |
| Infrastructure | `src/infrastructure` | Adapters (RPC, storage, caching) | Application / Domain |

Cross-cutting concerns (logging, DI) live at the root.

---

## Component Roles

### RPC Server (Infrastructure)
* File: `src/infrastructure/rpc/server.ts`
* Exposes JSON-RPC 2.0 over **stdin/stdout**.
* Delegates each method (`workflow_list`, `workflow_get`, `workflow_next`, `workflow_validate`, `workflow_validate_json`) to the corresponding **use-case**.
* Applies request-schema validation middleware and maps thrown domain errors to JSON-RPC error objects.

### Use-Cases (Application)
* Folder: `src/application/use-cases/`
* Pure functions with no side-effects.
* Injected with an `IWorkflowStorage` implementation and executed by the server.
* **Current**: `get-next-step` accepts optional context parameter for conditional step evaluation.
* **Current**: `validate-workflow-json` provides direct JSON validation without external tool dependencies.

### ValidationEngine (Application)
* **File**: `src/application/services/validation-engine.ts`
* **Purpose**: Advanced step output validation with three enhancement types for comprehensive quality assurance.
* **Architecture**: Dependency-injected service with AJV integration and performance optimizations.

#### Core Validation Enhancement Types

**1. JSON Schema Validation**
* **Technology**: AJV (Another JSON Schema Validator) with Draft 7 support
* **Performance**: Map-based compiled schema caching for sub-millisecond validation
* **Capabilities**: Full JSON validation (objects, arrays, primitives) with detailed error reporting
* **Use Cases**: Structured output validation, API response validation, complex data format verification

**2. Context-Aware Validation**
* **Technology**: Integration with `condition-evaluator.ts` for dynamic rule application
* **Capabilities**: Conditional validation rules based on execution context variables
* **Operators**: equals, not_equals, gt, gte, lt, lte, and, or, not
* **Use Cases**: Task-specific validation, user role-based rules, environment-dependent validation
* **Safety**: Graceful degradation when context variables are missing

**3. Logical Composition**
* **Technology**: Recursive composition evaluation with unlimited nesting depth
* **Operators**: AND (all must pass), OR (at least one must pass), NOT (must not pass)
* **Format**: Both array format (backward compatible) and composition object format
* **Use Cases**: Complex business logic validation, multi-condition requirements, sophisticated validation expressions

#### Validation Rule Types

```typescript
// Basic rule types with comprehensive support
ValidationRule {
  type: 'contains' | 'regex' | 'length' | 'schema';
  message: string;
  condition?: Condition; // Optional context-aware evaluation
  // Type-specific properties...
}

// Logical composition for complex expressions
ValidationComposition {
  and?: ValidationCriteria[];
  or?: ValidationCriteria[];
  not?: ValidationCriteria;
}
```

#### Performance Architecture

* **Schema Compilation Cache**: `Map<string, ValidateFunction>` prevents recompilation overhead
* **Conditional Evaluation**: Rules with unmet conditions are skipped entirely
* **Lazy Evaluation**: Composition operators short-circuit when possible (AND stops on first failure, OR stops on first success)
* **Memory Management**: Efficient validation with minimal allocation during execution

#### Error Handling & Debugging

* **Structured Error Messages**: Clear, actionable validation failure descriptions
* **AJV Error Integration**: Detailed JSON Schema validation errors with path information
* **Validation Context**: Error messages include context about which rule failed and why
* **Debug Information**: Comprehensive validation results with issues and suggestions

#### Integration Patterns

* **WorkflowService Integration**: Seamless step output validation via `validateStepOutput()`
* **Workflow JSON Validation**: Direct JSON validation via `validateWorkflowJson()` use case
* **Backward Compatibility**: Legacy string-based validation rules still supported
* **Dependency Injection**: Clean separation from storage and transport concerns
* **Testing Support**: Extensive test coverage (72 tests) demonstrating all validation patterns

#### JSON Validation Use Case

The `validate-workflow-json` use case provides comprehensive workflow JSON validation:

* **JSON Syntax Validation**: Parses and validates JSON syntax with detailed error messages
* **Schema Compliance**: Validates against the workflow schema using the same ValidationEngine
* **Error Enhancement**: Provides actionable suggestions for LLM consumption
* **Standalone Operation**: No external dependencies or storage requirements
* **Integration**: Leverages existing validation infrastructure without code duplication

### Storage Adapters (Infrastructure)
* Folder: `src/infrastructure/storage/`
* Implement the async `IWorkflowStorage` interface.
  * `FileWorkflowStorage` – reads workflow JSON files.
  * `InMemoryWorkflowStorage` – used in tests.
  * `SchemaValidatingWorkflowStorage` – wraps another storage, performing workflow-schema validation.
  * `CachingWorkflowStorage` – TTL cache wrapper.
* Adapters are composed via the DI container, yielding a single façade to the application layer.

### Dependency Injection Container
* File: `src/container.ts`
* Registers storage stack, error handler, and RPC server for production and for tests.

---

## Data Flow

1. **Request** – Agent sends JSON-RPC over stdin.
2. **RPC Layer** parses & validates parameters (Ajv).
3. **Use-Case** executes core logic, querying storage via injected adapter.
4. **WorkflowService** processes step data, including agentRole field handling for agent behavioral guidance.
5. **ValidationEngine** – For `workflow_validate` calls, applies advanced validation rules to step output. For `workflow_validate_json` calls, validates JSON syntax and schema compliance.
6. **Domain Error**? → mapped to JSON-RPC error.
7. **Response** emitted on stdout.

### AgentRole Processing Flow

```
WorkflowStep → WorkflowService.getNextStep() → {
  Step Selection → Find next eligible step
  ↓
  Guidance Construction → {
    AgentRole Present? → Add "## Agent Role Instructions" header + agentRole content
    Guidance Present? → Add "## Step Guidance" section
    Combine with user-facing prompt
  }
  ↓
  Response Assembly → {
    step: Original step data (includes agentRole field)
    guidance: { prompt: Enhanced prompt with agent instructions }
    isComplete: Workflow completion status
  }
}
```

### Validation Flow Detail

```
Step Output → ValidationEngine.validate() → {
  Context Evaluation → Filter applicable rules
  ↓
  Criteria Assessment → {
    Array Format: Apply each rule sequentially
    Composition: Recursive logical evaluation (and/or/not)
  }
  ↓
  Rule Execution → {
    contains: String inclusion check
    regex: Pattern matching with flags
    length: Min/max constraints
    schema: AJV compilation and validation
  }
  ↓
  Result Aggregation → ValidationResult
}
```

---

## Key Technical Decisions

* **Clean Architecture** chosen to isolate domain logic from transport/storage concerns and ease future adapter swaps (e.g., WebSocket transport).
* **TypeScript** with strict null-checks enabled.
* **Ajv** for high-performance JSON-schema validation (both RPC params & workflow documents).
* **Advanced ValidationEngine Architecture** – Three-tier validation system (JSON Schema + Context-Aware + Logical Composition) provides comprehensive output quality assurance without sacrificing performance.
* **Schema Compilation Caching** – Map-based validator caching prevents repeated AJV compilation overhead during high-frequency validation operations.
* **Context-Aware Validation** – Dynamic rule application based on execution context enables task-specific, user-role-based, and environment-dependent validation patterns.
* **Backward-Compatible Validation** – Support for both legacy array-based rules and modern composition syntax ensures smooth migration paths.
* **AgentRole Field Architecture** – Clean separation of agent behavioral instructions from user-facing prompts, processed at the WorkflowService layer with backward compatibility.
* **Async I/O Only** – storage interface returns `Promise` to support remote stores later.
* **Thin Adapters** – server & storage wrappers are intentionally small; majority of logic resides in use-cases.
* **Conditional Step Execution** – Safe expression evaluation enables dynamic workflows that adapt based on context variables like task scope and user expertise.

---

## Scalability & Monitoring

* **Horizontal Scaling** – Multiple server instances can run behind a queue; stdin transport can be swapped for HTTP without touching domain code.
* **Caching** – `CachingWorkflowStorage` reduces disk access; switch to Redis in distributed setups.
* **Observability** – Structured logging via the error handler + TODO: OTEL traces.

---

## Migration Paths

| From… | To (v0.0.1-alpha) | Migration Notes |
|-------|-----------|-----------------|
| `src/core/server.ts` JSON-RPC wrapper | `src/infrastructure/rpc/server.ts` | Now a pure adapter, delegates to use-cases. |
| Modules in `src/tools/` | Removed | Logic moved to application use-cases. |
| `src/workflow/*.ts` storage impls | `src/infrastructure/storage/*` | Names unchanged; import paths updated. |
| Ad-hoc validation utilities | `src/application/services/validation-engine.ts` | Advanced ValidationEngine with three enhancement types. |

---

## Documentation Standards & Terminology

### Core Validation Terminology

**Standardized Terms** (use consistently across all documentation):
* **ValidationEngine** – The core validation service class
* **ValidationRule** – Individual validation criteria (contains, regex, length, schema)
* **ValidationComposition** – Logical grouping of rules with and/or/not operators
* **ValidationCriteria** – Union type supporting both rules and compositions
* **ValidationResult** – Structured output with valid/issues/suggestions
* **Context-Aware Validation** – Rules that apply conditionally based on execution context
* **Condition Context** – Variables available for conditional rule evaluation

### Code Example Standards

**TypeScript Code Blocks**: Always include proper typing
```typescript
//  Good - includes types and context
const result: ValidationResult = await engine.validate(output, rules, context);

//  Bad - no types or context
const result = engine.validate(output, rules);
```

**JSON Examples**: Always validate against current schema
```json
{
  "validationCriteria": {
    "and": [
      { "type": "contains", "value": "success", "message": "Must contain success" },
      { "type": "length", "min": 10, "message": "Must be detailed" }
    ]
  }
}
```

### Documentation Structure Standards

**Section Headers**: Use descriptive, action-oriented titles
*  "Implementing Advanced Validation Rules"
*  "Validation"

**Code Comments**: Explain the why, not just the what
```typescript
// Apply conditional rules only when context matches
if (rule.condition && !evaluateCondition(rule.condition, context)) {
  continue; // Skip rule when condition not met
}
```

### Cross-Reference Standards

**File References**: Always use relative paths from current document
* `../../spec/workflow.schema.json` 
* `../implementation/13-advanced-validation-guide.md`

**Validation Examples**: Must demonstrate real-world use cases
* Task-specific validation scenarios
* Performance optimization patterns
* Error handling and debugging approaches

---

## References

* [Main README](../../README.md)
* [Development Phases](03-development-phases.md)
* [Advanced Validation Guide](13-advanced-validation-guide.md)
* [Simple Workflow Guide](09-simple-workflow-guide.md)
* [API Specification](../../spec/mcp-api-v1.0.md)
* [Workflow Schema](../../spec/workflow.schema.json) 