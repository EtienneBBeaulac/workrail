# MCP Tool API Specification v1.0

This document formally specifies the JSON-RPC 2.0 API for the Workflow Orchestration System's
`workflowlookup` MCP server. The system features an advanced **ValidationEngine** with three enhancement types: JSON Schema Validation, Context-Aware Validation, and Logical Composition for comprehensive step output quality assurance.

> **Note**: This document focuses on the workflow-specific tools. For complete MCP protocol compliance including server initialization, tool discovery, and handshake procedures, see [MCP Protocol Handshake Specification](mcp-protocol-handshake.md).

## MCP Protocol Compliance

This server implements the full MCP (Model Context Protocol) specification:

-  **Server Initialization**: Handles `initialize` requests with protocol version validation
-  **Tool Discovery**: Implements `tools/list` with complete input/output schemas  
-  **Error Handling**: Uses MCP standard error codes (-32000 to -32099 range)
-  **Communication**: Stdio transport with newline-delimited JSON-RPC messages
-  **Server Lifecycle**: Proper startup, shutdown, and error recovery

For complete protocol details, see [MCP Protocol Handshake Specification](mcp-protocol-handshake.md).

## JSON-RPC 2.0 Base Protocol

All communication follows the [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification).

### Request Structure

Every request to the MCP server must conform to this structure:

```json
{
  "jsonrpc": "2.0",
  "id": number | string,
  "method": string,
  "params": object | array | null
}
```

- `jsonrpc`: Must always be `"2.0"`
- `id`: Unique identifier for the request (number or string)
- `method`: The name of the tool being invoked
- `params`: Parameters specific to the tool (can be object, array, or null)

### Response Structure

#### Success Response

```json
{
  "jsonrpc": "2.0",
  "id": number | string,
  "result": any
}
```

- `jsonrpc`: Always `"2.0"`
- `id`: Must match the request ID
- `result`: The tool's return value (structure depends on the tool)

#### Error Response

```json
{
  "jsonrpc": "2.0",
  "id": number | string | null,
  "error": {
    "code": number,
    "message": string,
    "data": any
  }
}
```

- `jsonrpc`: Always `"2.0"`
- `id`: Matches request ID, or null if error occurred before ID could be determined
- `error`: Error object containing:
    - `code`: Numeric error code
    - `message`: Human-readable error message
    - `data`: Optional additional error information

### Standard Error Codes

| Code | Message | Description |
|------|---------|-------------|
| -32700 | Parse error | Invalid JSON was received |
| -32600 | Invalid Request | The JSON sent is not a valid Request object |
| -32601 | Method not found | The method does not exist |
| -32602 | Invalid params | Invalid method parameter(s) |
| -32603 | Internal error | Internal JSON-RPC error |
| -32000 | Server error | Server-specific error (MCP reserved) |
| -32001 | Workflow not found | The specified workflow ID does not exist |
| -32002 | Invalid workflow | The workflow file is malformed or invalid |
| -32003 | Step not found | The specified step ID does not exist in the workflow |
| -32004 | Validation error | ValidationEngine encountered invalid validation criteria |
| -32005 | State error | Invalid workflow execution state |
| -32006 | Storage error | Error accessing workflow storage |
| -32007 | Security error | Security validation failed |

## Tool Specifications

The `workflowlookup` server exposes the following tools:

### workflow_list

Lists all available workflows.

#### Request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "workflow_list",
  "params": null
}
```

#### Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "workflows": [
      {
        "id": "string",
        "name": "string",
        "description": "string",
        "category": "string",
        "version": "string"
      }
    ]
  }
}
```

#### Field Descriptions

- `workflows`: Array of workflow summaries
    - `id`: Unique workflow identifier (matches workflow schema pattern)
    - `name`: Human-friendly workflow name
    - `description`: Brief description of what the workflow accomplishes
    - `category`: Workflow category (e.g., "development", "review", "documentation")
    - `version`: Workflow version following semantic versioning

### workflow_get

Retrieves workflow information with configurable detail level. Supports progressive disclosure to prevent "workflow spoiling" while providing necessary context for workflow selection and initiation.

#### Request

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "workflow_get",
  "params": {
    "id": "string",
    "mode": "preview"
  }
}
```

#### Parameters

- `id` (required): The workflow ID to retrieve
- `mode` (optional): The level of detail to return
  - `"metadata"`: Returns workflow info without steps
  - `"preview"`: Returns metadata plus the first eligible step (default)

#### Response Examples

**Preview Mode (default):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "id": "coding-task-workflow-with-loops",
    "name": "Excellent Adaptive Coding Workflow",
    "description": "A comprehensive workflow for AI-assisted coding",
    "version": "0.1.0",
    "preconditions": ["User has a clear task description"],
    "clarificationPrompts": ["What is the complexity level?"],
    "metaGuidance": ["Follow PREP -> IMPLEMENT -> VERIFY pattern"],
    "totalSteps": 8,
    "firstStep": {
      "id": "phase-0-intelligent-triage",
      "title": "Phase 0: Intelligent Task Triage & Complexity Analysis",
      "prompt": "**ANALYZE**: Evaluate the provided task for complexity indicators...",
      "agentRole": "You are a technical assessment specialist...",
      "guidance": ["Be thorough in your analysis"],
      "requireConfirmation": true
    }
  }
}
```

**Metadata Mode:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "id": "coding-task-workflow-with-loops",
    "name": "Excellent Adaptive Coding Workflow",
    "description": "A comprehensive workflow for AI-assisted coding",
    "version": "0.1.0",
    "preconditions": ["User has a clear task description"],
    "clarificationPrompts": ["What is the complexity level?"],
    "metaGuidance": ["Follow PREP -> IMPLEMENT -> VERIFY pattern"],
    "totalSteps": 8
  }
}
```

#### Error Cases

- Returns error code `-32001` if workflow ID not found
- Returns error code `-32002` if workflow file is malformed

### workflow_next

Gets the next step guidance based on workflow state.

#### Request

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "workflow_next",
  "params": {
    "workflowId": "string",
    "currentStep": "string",
    "completedSteps": ["string"],
    "context": {}
  }
}
```

#### Parameters

- `workflowId` (required): The workflow being executed
- `currentStep` (optional): The ID of the current step
- `completedSteps` (required): Array of step IDs that have been completed
- `context` (optional): Execution context object for evaluating step conditions. Can contain variables like `taskScope`, `userExpertise`, `complexity`, etc.

#### Response

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "step": {
      "id": "string",
      "title": "string",
      "prompt": "string",
      "agentRole": "string",
      "guidance": ["string"],
      "askForFiles": boolean,
      "requireConfirmation": boolean,
      "runCondition": object
    },
    "guidance": {
      "prompt": "string",
      "modelHint": "string",
      "requiresConfirmation": boolean,
      "validationCriteria": ["string"]
    },
    "isComplete": boolean
  }
}
```

#### Field Descriptions

- `step`: The next step to execute (null if workflow is complete)
    - `id`: Unique step identifier
    - `title`: Human-readable step name
    - `prompt`: User-facing instructions for the step
    - `agentRole`: Optional AI agent behavioral guidance (10-1024 characters)
    - `guidance`: Optional array of guidance strings
    - `askForFiles`: Whether to request file context
    - `requireConfirmation`: Whether user confirmation is needed
    - `runCondition`: Optional condition object that determines if this step should execute
- `guidance`: Additional orchestration guidance
    - `prompt`: Enhanced prompt with context
    - `modelHint`: Suggested model type (e.g., "model-with-strong-reasoning")
    - `requiresConfirmation`: Whether user confirmation is needed
    - `validationCriteria`: List of criteria to validate completion
- `isComplete`: True if all workflow steps are completed

#### Conditional Step Execution

Steps can include an optional `runCondition` property that determines whether the step should be executed based on the provided context. The condition uses a simple expression format:

```json
{
  "runCondition": {
    "var": "taskScope",
    "equals": "large"
  }
}
```

**Supported operators:**
- `equals`: Variable equals value
- `not_equals`: Variable does not equal value
- `gt`, `gte`, `lt`, `lte`: Numeric comparisons
- `and`: Logical AND of multiple conditions
- `or`: Logical OR of multiple conditions
- `not`: Logical NOT of a condition

**Example context:**
```json
{
  "context": {
    "taskScope": "large",
    "userExpertise": "expert",
    "complexity": 0.8
  }
}
```

If a step's `runCondition` evaluates to false, the step is skipped and the next eligible step is returned.

#### Error Cases

- Returns error code `-32001` if workflow ID not found
- Returns error code `-32003` if current step ID not found in workflow

### workflow_validate

Validates the output of a workflow step using the advanced ValidationEngine. The system supports three enhancement types: **JSON Schema Validation**, **Context-Aware Validation**, and **Logical Composition** for comprehensive output quality assurance.

#### Request

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "workflow_validate",
  "params": {
    "workflowId": "string",
    "stepId": "string",
    "output": "string",
    "context": {
      "taskScope": "large",
      "userExpertise": "expert",
      "complexity": 0.8
    }
  }
}
```

#### Parameters

- `workflowId` (required): The workflow being executed
- `stepId` (required): The step ID being validated  
- `output` (required): The output to validate against the step's validation criteria
- `context` (optional): Execution context for context-aware validation rules

#### Response

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "valid": boolean,
    "issues": ["string"],
    "suggestions": ["string"]
  }
}
```

#### Field Descriptions

- `valid`: Whether the output meets all applicable validation criteria
- `issues`: List of specific validation problems found (empty if valid)
- `suggestions`: List of actionable suggestions for improvement

#### ValidationEngine Enhancement Types

The ValidationEngine supports three types of validation enhancements:

##### 1. JSON Schema Validation

Validates structured output against JSON Schema specifications:

```json
{
  "type": "schema",
  "schema": {
    "type": "object",
    "properties": {
      "endpoint": {"type": "string", "pattern": "^/api/"},
      "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE"]},
      "authentication": {"type": "boolean"}
    },
    "required": ["endpoint", "method"]
  },
  "message": "API endpoint must follow required structure"
}
```

##### 2. Context-Aware Validation

Applies validation rules conditionally based on execution context:

```json
{
  "type": "contains",
  "value": "comprehensive tests",
  "condition": {
    "var": "taskScope",
    "equals": "large"
  },
  "message": "Large tasks require comprehensive testing"
}
```

**Supported Condition Operators:**
- `equals`: Variable equals specific value
- `not_equals`: Variable does not equal specific value  
- `gt`, `gte`: Greater than, greater than or equal (numeric)
- `lt`, `lte`: Less than, less than or equal (numeric)
- `and`, `or`, `not`: Logical operators for complex conditions

##### 3. Logical Composition

Combines multiple validation rules with boolean operators:

```json
{
  "and": [
    {
      "type": "contains",
      "value": "authentication",
      "message": "Must include authentication"
    },
    {
      "or": [
        {"type": "contains", "value": "jwt", "message": "Should use JWT"},
        {"type": "contains", "value": "session", "message": "Should use sessions"}
      ]
    }
  ]
}
```

#### Validation Rule Types

| Type | Description | Required Fields | Optional Fields |
|------|-------------|----------------|-----------------|
| `contains` | Checks if output contains specific text | `type`, `value`, `message` | `condition` |
| `regex` | Validates against regular expression pattern | `type`, `pattern`, `message` | `flags`, `condition` |
| `length` | Validates output length constraints | `type`, `message` | `min`, `max`, `condition` |
| `schema` | Validates against JSON Schema | `type`, `schema`, `message` | `condition` |

#### Example Requests and Responses

##### Basic Validation Request

```json
{
  "jsonrpc": "2.0",
  "id": "validate-1",
  "method": "workflow_validate",
  "params": {
    "workflowId": "auth-implementation",
    "stepId": "create-middleware",
    "output": "Created JWT authentication middleware that extracts tokens from Authorization header and returns 401 for invalid tokens."
  }
}
```

##### Context-Aware Validation Request

```json
{
  "jsonrpc": "2.0",
  "id": "validate-2", 
  "method": "workflow_validate",
  "params": {
    "workflowId": "adaptive-development",
    "stepId": "implementation",
    "output": "Implemented basic feature functionality with standard patterns.",
    "context": {
      "userExpertise": "expert",
      "complexity": 0.9,
      "taskScope": "large"
    }
  }
}
```

##### Successful Validation Response

```json
{
  "jsonrpc": "2.0",
  "id": "validate-1",
  "result": {
    "valid": true,
    "issues": [],
    "suggestions": []
  }
}
```

##### Failed Validation Response

```json
{
  "jsonrpc": "2.0",
  "id": "validate-2",
  "result": {
    "valid": false,
    "issues": [
      "Expert implementation should use advanced patterns",
      "Complex tasks require optimization considerations"
    ],
    "suggestions": [
      "Review validation criteria and adjust output accordingly.",
      "Consider adding architectural patterns for expert-level implementation."
    ]
  }
}
```

#### Error Cases

- Returns error code `-32001` if workflow ID not found
- Returns error code `-32003` if step ID not found in workflow
- Returns error code `-32004` if validation criteria format is invalid
- Returns error code `-32002` if JSON Schema validation fails due to malformed schema

### workflow_validate_json

Validates workflow JSON content directly without external tools or storage dependencies. This tool provides comprehensive validation including JSON syntax checking, schema compliance validation, and actionable error messages optimized for LLM consumption.

#### Request

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "workflow_validate_json",
  "params": {
    "workflowJson": "string"
  }
}
```

#### Parameters

- `workflowJson` (required): The complete workflow JSON content as a string to validate

#### Response

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "valid": boolean,
    "issues": ["string"],
    "suggestions": ["string"]
  }
}
```

#### Field Descriptions

- `valid`: Whether the workflow JSON is syntactically correct and schema-compliant
- `issues`: List of specific validation problems found (empty if valid)
- `suggestions`: List of actionable suggestions for fixing validation issues

#### Validation Process

The tool performs comprehensive validation in the following order:

1. **JSON Syntax Validation**: Parses JSON and reports syntax errors with line/column information
2. **Schema Compliance**: Validates against the workflow schema using the same ValidationEngine used by the storage layer
3. **Error Enhancement**: Provides LLM-friendly error messages with specific suggestions for resolution

#### Example Requests and Responses

##### Valid Workflow JSON

```json
{
  "jsonrpc": "2.0",
  "id": "validate-json-1",
  "method": "workflow_validate_json",
  "params": {
    "workflowJson": "{\"id\":\"test-workflow\",\"name\":\"Test Workflow\",\"description\":\"A simple test workflow\",\"version\":\"1.0.0\",\"steps\":[{\"id\":\"step1\",\"title\":\"First Step\",\"prompt\":\"Do something useful\"}]}"
  }
}
```

##### Valid Workflow Response

```json
{
  "jsonrpc": "2.0",
  "id": "validate-json-1",
  "result": {
    "valid": true,
    "issues": [],
    "suggestions": []
  }
}
```

##### Invalid JSON Syntax

```json
{
  "jsonrpc": "2.0",
  "id": "validate-json-2",
  "method": "workflow_validate_json",
  "params": {
    "workflowJson": "{\"id\":\"test-workflow\",\"name\":\"Test Workflow\",\"description\":\"Missing closing brace\""
  }
}
```

##### JSON Syntax Error Response

```json
{
  "jsonrpc": "2.0",
  "id": "validate-json-2",
  "result": {
    "valid": false,
    "issues": [
      "JSON syntax error: Unexpected end of JSON input at position 75"
    ],
    "suggestions": [
      "Check for missing closing braces, brackets, or quotes",
      "Validate JSON syntax using a JSON validator or formatter"
    ]
  }
}
```

##### Schema Validation Error

```json
{
  "jsonrpc": "2.0",
  "id": "validate-json-3",
  "method": "workflow_validate_json",
  "params": {
    "workflowJson": "{\"id\":\"test-workflow\",\"name\":\"Test Workflow\"}"
  }
}
```

##### Schema Error Response

```json
{
  "jsonrpc": "2.0",
  "id": "validate-json-3",
  "result": {
    "valid": false,
    "issues": [
      "Missing required property 'description'",
      "Missing required property 'steps'"
    ],
    "suggestions": [
      "Add required 'description' field with a meaningful description",
      "Add required 'steps' array with at least one step object"
    ]
  }
}
```

#### Use Cases

- **Workflow Development**: Validate workflow JSON during creation and editing
- **CI/CD Integration**: Automated validation in deployment pipelines
- **Real-time Validation**: Live validation in workflow editors and management tools
- **Troubleshooting**: Diagnose workflow loading issues and syntax problems
- **LLM Integration**: Programmatic validation with enhanced error messages for AI agents

#### Error Cases

- Returns error code `-32602` if `workflowJson` parameter is missing or empty
- Returns error code `-32603` if internal validation engine encounters unexpected errors
- JSON syntax and schema validation errors are returned as successful responses with `valid: false`

## Example Session

Here's a complete example session showing tool usage:

### 1. List Available Workflows

```json
// Request
{
  "jsonrpc": "2.0",
  "id": "list-1",
  "method": "workflow_list",
  "params": null
}

// Response
{
  "jsonrpc": "2.0",
  "id": "list-1",
  "result": {
    "workflows": [
      {
        "id": "ai-task-implementation",
        "name": "AI Task Prompt Workflow",
        "description": "Guides through task understanding → planning → implementation → verification",
        "category": "development",
        "version": "1.0.0"
      }
    ]
  }
}
```

### 2. Get Workflow Details

```json
// Request
{
  "jsonrpc": "2.0",
  "id": "get-1",
  "method": "workflow_get",
  "params": {
    "id": "ai-task-implementation"
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": "get-1",
  "result": {
    "id": "ai-task-implementation",
    "name": "AI Task Prompt Workflow",
    "description": "Complete task implementation with verification",
    "preconditions": [
      "Task description is clear and complete"
    ],
    "steps": [
      {
        "id": "understand",
        "title": "Deep understanding of task and codebase",
        "prompt": "Analyze the task description...",
        "requireConfirmation": true
      }
    ]
  }
}
```

### 3. Get Next Step

```json
// Request
{
  "jsonrpc": "2.0",
  "id": "next-1",
  "method": "workflow_next",
  "params": {
    "workflowId": "ai-task-implementation",
    "completedSteps": [],
    "context": {"taskId": "TASK-123"}
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": "next-1",
  "result": {
    "step": {
      "id": "understand",
      "title": "Deep understanding of task and codebase",
      "prompt": "Analyze the task description...",
      "requireConfirmation": true
    },
    "guidance": {
      "prompt": "First, let's understand the task thoroughly. Analyze the task description...",
      "modelHint": "model-with-strong-reasoning",
      "requiresConfirmation": true,
      "validationCriteria": [
        "Clear understanding of requirements",
        "Identified affected files",
        "Documented assumptions"
      ]
    },
    "isComplete": false
  }
}
```

### 4. Validate Step Output

```json
// Request - Advanced ValidationEngine with context-aware validation
{
  "jsonrpc": "2.0",
  "id": "validate-1",
  "method": "workflow_validate",
  "params": {
    "workflowId": "auth-implementation",
    "stepId": "implement-login",
    "output": "Created POST /auth/login endpoint that accepts email and password, validates credentials against database using bcrypt, and returns JWT token with 24h expiration on success.",
    "context": {
      "security": "high",
      "environment": "production"
    }
  }
}

// Response - Successful validation
{
  "jsonrpc": "2.0",
  "id": "validate-1",
  "result": {
    "valid": true,
    "issues": [],
    "suggestions": []
  }
}
```

### 5. Context-Aware Validation Example

```json
// Request - Expert-level task with high complexity
{
  "jsonrpc": "2.0",
  "id": "validate-2",
  "method": "workflow_validate",
  "params": {
    "workflowId": "adaptive-development",
    "stepId": "expert-implementation",
    "output": "Implemented feature using basic CRUD operations with standard MVC pattern.",
    "context": {
      "userExpertise": "expert",
      "complexity": 0.9,
      "taskScope": "large"
    }
  }
}

// Response - Failed validation with context-aware feedback
{
  "jsonrpc": "2.0",
  "id": "validate-2",
  "result": {
    "valid": false,
    "issues": [
      "Expert implementation should use advanced patterns",
      "Should include optimizations for complex features"
    ],
    "suggestions": [
      "Review validation criteria and adjust output accordingly.",
      "Consider adding architectural patterns like Repository, Strategy, or Observer for expert-level implementation."
    ]
  }
}
```

### 6. Validate Workflow JSON

```json
// Request - Validate workflow JSON directly
{
  "jsonrpc": "2.0",
  "id": "validate-json-1",
  "method": "workflow_validate_json",
  "params": {
    "workflowJson": "{\"id\":\"sample-workflow\",\"name\":\"Sample Workflow\",\"description\":\"A workflow for demonstration\",\"version\":\"1.0.0\",\"steps\":[{\"id\":\"demo-step\",\"title\":\"Demo Step\",\"prompt\":\"Perform the demo action\"}]}"
  }
}

// Response - Successful validation
{
  "jsonrpc": "2.0",
  "id": "validate-json-1",
  "result": {
    "valid": true,
    "issues": [],
    "suggestions": []
  }
}
```

### 7. JSON Validation Error Example

```json
// Request - Invalid workflow JSON
{
  "jsonrpc": "2.0",
  "id": "validate-json-2",
  "method": "workflow_validate_json",
  "params": {
    "workflowJson": "{\"id\":\"invalid-workflow\",\"name\":\"Invalid Workflow\"}"
  }
}

// Response - Validation failed with actionable suggestions
{
  "jsonrpc": "2.0",
  "id": "validate-json-2",
  "result": {
    "valid": false,
    "issues": [
      "Missing required property 'description'",
      "Missing required property 'steps'"
    ],
    "suggestions": [
      "Add required 'description' field with a meaningful description",
      "Add required 'steps' array with at least one step object"
    ]
  }
}
```

### 8. Error Example

```json
// Request
{
  "jsonrpc": "2.0",
  "id": "error-1",
  "method": "workflow_get",
  "params": {
    "id": "non-existent-workflow"
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": "error-1",
  "error": {
    "code": -32001,
    "message": "Workflow not found",
    "data": {
      "workflowId": "non-existent-workflow"
    }
  }
}
```
