# Dashboard Schema System

The Schema Registry provides **optional but powerful** validation for workflow data. Schemas are completely optional - dashboards work fine without them! However, schemas provide better validation, type safety, and developer experience.

## Quick Start

### Using Built-in Schemas

Three schemas are included out-of-the-box:

```javascript
// The dashboard automatically validates data if you provide a workflow type
sessionManager.updateSession('bug-investigation', 'BUG-001', {
  dashboard: {
    title: 'Auth Token Bug',
    status: 'in_progress',
    progress: 45,
    confidence: 7
  },
  hypotheses: [
    {
      description: 'Server timezone issue',
      status: 'active',
      confidence: 6
    }
  ]
});
// ✅ Validates against bug-investigation schema automatically
```

### Available Built-in Schemas

1. **bug-investigation** - Systematic bug investigation workflows
2. **code-review** - Code review workflows  
3. **test-results** - Test execution results

## Creating Custom Schemas

### Basic Schema

```javascript
import { schemaRegistry } from './schema-registry.js';

schemaRegistry.register('deployment', {
  name: 'Deployment Workflow',
  description: 'Schema for deployment tracking',
  fields: {
    dashboard: {
      type: 'object',
      required: true,
      schema: {
        title: { type: 'string', required: true },
        status: { 
          type: 'string', 
          enum: ['pending', 'deploying', 'deployed', 'failed'] 
        },
        progress: { type: 'number', min: 0, max: 100 }
      }
    },
    environment: {
      type: 'string',
      required: true,
      enum: ['development', 'staging', 'production']
    },
    version: {
      type: 'string',
      required: true
    },
    deployedAt: {
      type: 'string',
      format: 'iso-date'
    }
  }
});
```

## Field Types

### String

```javascript
{
  type: 'string',
  required: true,
  enum: ['value1', 'value2'],      // Optional: restrict to specific values
  format: 'iso-date',                // Optional: validate format
  minLength: 5,                      // Optional: minimum length
  maxLength: 100                     // Optional: maximum length
}
```

**Supported formats:**
- `iso-date` - ISO 8601 date/time format

### Number

```javascript
{
  type: 'number',
  required: true,
  min: 0,                           // Optional: minimum value
  max: 100,                         // Optional: maximum value
  integer: true                     // Optional: must be integer
}
```

### Boolean

```javascript
{
  type: 'boolean',
  required: false
}
```

### Array

```javascript
{
  type: 'array',
  minItems: 1,                      // Optional: minimum items
  maxItems: 10,                     // Optional: maximum items
  itemSchema: {                     // Optional: validate each item
    name: { type: 'string', required: true },
    value: { type: 'number' }
  }
}
```

### Object

```javascript
{
  type: 'object',
  required: true,
  schema: {                         // Nested field definitions
    field1: { type: 'string' },
    field2: { type: 'number' }
  }
}
```

## Using Schemas

### In Workflows

The agent can simply write data and validation happens automatically:

```json
{
  "name": "deployment-workflow",
  "workflowType": "deployment",
  "steps": [
    {
      "id": "deploy",
      "description": "Deploy to environment",
      "instructions": [
        "Update session with deployment status:",
        "```javascript",
        "workrail.updateSession('deployment', sessionId, {",
        "  dashboard: {",
        "    title: 'Deploying v1.2.3',",
        "    status: 'deploying',",
        "    progress: 0",
        "  },",
        "  environment: 'production',",
        "  version: '1.2.3'",
        "});",
        "```"
      ]
    }
  ]
}
```

### Manual Validation

```javascript
import { schemaRegistry } from './schema-registry.js';

const data = {
  dashboard: { title: 'Test' },
  environment: 'production',
  version: '1.0.0'
};

const result = schemaRegistry.validate(data, 'deployment');

if (!result.valid) {
  console.error('Validation failed:');
  result.errors.forEach(err => {
    console.error(`  ${err.path}: ${err.message}`);
  });
}

if (result.warnings.length > 0) {
  console.warn('Warnings:', result.warnings);
}
```

### Validation Result

```javascript
{
  valid: boolean,           // Overall validation status
  errors: [                // Validation errors (cause valid=false)
    {
      path: 'field.name',  // Path to invalid field
      message: 'Error...',  // Human-readable message
      expected: '...',      // Expected value/type
      actual: '...'         // Actual value/type
    }
  ],
  warnings: [              // Warnings (don't affect validity)
    'Unknown field: extraField'
  ]
}
```

## TypeScript Integration

Generate TypeScript interfaces from schemas:

```javascript
import { schemaRegistry } from './schema-registry.js';

const typescript = schemaRegistry.generateTypeScript('deployment');
console.log(typescript);
```

Output:

```typescript
// Generated TypeScript interface for Deployment Workflow
// Schema for deployment tracking

export interface DeploymentData {
  /** Dashboard metadata */
  dashboard: { title: string; status?: 'pending' | 'deploying' | 'deployed' | 'failed'; progress?: number };
  environment: 'development' | 'staging' | 'production';
  version: string;
  deployedAt?: string;
}
```

## Best Practices

### 1. Start Simple

Don't over-specify your schema. Start with just required fields:

```javascript
{
  fields: {
    dashboard: {
      type: 'object',
      required: true,
      schema: {
        title: { type: 'string', required: true }
      }
    }
  }
}
```

### 2. Use Enums for Status Fields

```javascript
status: {
  type: 'string',
  enum: ['pending', 'in_progress', 'completed', 'failed']
}
```

This catches typos early!

### 3. Validate Ranges

```javascript
progress: { type: 'number', min: 0, max: 100 },
confidence: { type: 'number', min: 0, max: 10 },
priority: { type: 'number', min: 1, max: 5 }
```

### 4. Make Most Fields Optional

Only mark fields as `required: true` if they're absolutely essential:

```javascript
// Good - only title required
dashboard: {
  type: 'object',
  schema: {
    title: { type: 'string', required: true },
    subtitle: { type: 'string' },            // optional
    progress: { type: 'number' }             // optional
  }
}
```

### 5. Document Your Fields

```javascript
findings: {
  type: 'array',
  description: 'Issues discovered during code review',
  itemSchema: {
    severity: { 
      type: 'string', 
      enum: ['critical', 'high', 'medium', 'low'],
      description: 'Issue severity level'
    }
  }
}
```

## Common Patterns

### Workflow with Phases

```javascript
{
  fields: {
    dashboard: { /* ... */ },
    phases: {
      type: 'object',
      description: 'Workflow execution phases',
      schema: {
        'phase-1': {
          type: 'object',
          schema: {
            complete: { type: 'boolean' },
            summary: { type: 'string' }
          }
        }
      }
    }
  }
}
```

### Workflow with Timeline

```javascript
{
  fields: {
    timeline: {
      type: 'array',
      description: 'Timeline of events',
      itemSchema: {
        timestamp: { type: 'string', format: 'iso-date' },
        event: { type: 'string', required: true },
        details: { type: 'string' }
      }
    }
  }
}
```

### Workflow with Findings

```javascript
{
  fields: {
    findings: {
      type: 'array',
      itemSchema: {
        severity: { 
          type: 'string', 
          enum: ['critical', 'high', 'medium', 'low', 'info'] 
        },
        description: { type: 'string', required: true },
        file: { type: 'string' },
        line: { type: 'number', min: 1 }
      }
    }
  }
}
```

## Advanced Features

### Conditional Fields

Schemas don't support conditionals directly, but you can handle this in validation:

```javascript
// If status is 'failed', error field should be present
if (data.status === 'failed' && !data.error) {
  // Handle validation in your workflow logic
}
```

### Nested Arrays

```javascript
categories: {
  type: 'array',
  itemSchema: {
    name: { type: 'string', required: true },
    items: {
      type: 'array',
      itemSchema: {
        id: { type: 'string' },
        value: { type: 'number' }
      }
    }
  }
}
```

### Union Types (via Validation)

For complex union types, validate in workflow code:

```javascript
// Schema allows either string or object
value: { type: 'string' }  // Base schema

// Then handle both in workflow:
if (typeof data.value === 'object') {
  // Handle object case
}
```

## Listing Schemas

```javascript
import { schemaRegistry } from './schema-registry.js';

const schemas = schemaRegistry.list();
schemas.forEach(schema => {
  console.log(`${schema.type}: ${schema.name}`);
  console.log(`  ${schema.description}`);
  console.log(`  Fields: ${schema.fieldCount}`);
});
```

## Migration Guide

### From Unvalidated to Validated

1. **Create schema** based on your existing data structure
2. **Test validation** with real data
3. **Fix any issues** found by validation
4. **Add to workflow** by specifying workflowType

### Gradual Adoption

You don't need to validate everything at once:

```javascript
// Phase 1: Just validate dashboard
{
  fields: {
    dashboard: { /* full schema */ }
  }
}

// Phase 2: Add critical fields
{
  fields: {
    dashboard: { /* ... */ },
    status: { /* ... */ }
  }
}

// Phase 3: Complete schema
{
  fields: {
    dashboard: { /* ... */ },
    status: { /* ... */ },
    phases: { /* ... */ },
    findings: { /* ... */ }
  }
}
```

## FAQ

**Q: Do I need to use schemas?**  
A: No! Schemas are completely optional. Dashboards work fine without them.

**Q: When should I use schemas?**  
A: Use schemas when you want better validation, type safety, or are building reusable workflows.

**Q: Can I update a schema?**  
A: Yes, just call `register()` again with the same workflow type.

**Q: What happens if validation fails?**  
A: The data is still processed, but errors are logged to the console. This is intentional - we don't want validation to break the dashboard.

**Q: Can I validate without a schema?**  
A: Yes, the DataNormalizer still does basic validation (null checks, circular references, etc.) without a schema.

**Q: How do I debug validation errors?**  
A: Check the browser console - all validation errors are logged with detailed paths and messages.

## Examples

See the built-in schemas in `schema-registry.js` for complete examples:
- Bug Investigation Schema
- Code Review Schema  
- Test Results Schema

Each demonstrates different patterns and field types.






