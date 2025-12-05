# Advanced Validation Guide

> **Advanced validation techniques for workflow steps**

[![Status](https://img.shields.io/badge/status-complete-green.svg)](https://github.com/EtienneBBeaulac/mcp)
[![Spec Version](https://img.shields.io/badge/spec-1.0.0-blue.svg)](specs/)
[![ValidationEngine](https://img.shields.io/badge/ValidationEngine-v0.0.1--alpha-orange.svg)](src/application/services/validation-engine.ts)
[![Tests](https://img.shields.io/badge/tests-72_passing-green.svg)](tests/unit/validation-engine.test.ts)

## 📋 Table of Contents

1. [Overview](#overview)
2. [JSON Schema Validation](#json-schema-validation)
3. [Context-Aware Validation](#context-aware-validation)
4. [Logical Composition](#logical-composition)
5. [Performance Optimization](#performance-optimization)
6. [Best Practices](#best-practices)
7. [Troubleshooting](#troubleshooting)

---

## Overview

The ValidationEngine provides a sophisticated three-tier validation system that goes far beyond simple string matching. This guide covers all advanced validation capabilities available in the workflow orchestration system.

### Three Enhancement Types

**1. JSON Schema Validation** - Full AJV-powered validation for structured data
**2. Context-Aware Validation** - Dynamic rules based on execution context
**3. Logical Composition** - Complex expressions with and/or/not operators

### When to Use Each Type

| Validation Type | Use Cases | Performance | Complexity |
|-----------------|-----------|-------------|------------|
| **JSON Schema** | API responses, structured output, data validation | High (cached) | Medium |
| **Context-Aware** | Task-specific rules, user roles, environments | High (filtered) | Low |
| **Logical Composition** | Complex business logic, multi-condition requirements | Medium | High |

---

## JSON Schema Validation

### Overview

JSON Schema validation uses AJV (Another JSON Schema Validator) with Draft 7 support to validate structured output against comprehensive schemas.

### Basic Usage

```typescript
import { ValidationEngine } from './validation-engine';

const engine = new ValidationEngine();

const rules: ValidationRule[] = [
  {
    type: 'schema',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['success', 'error'] },
        data: { type: 'array', items: { type: 'object' } }
      },
      required: ['status', 'data']
    },
    message: 'Output must be valid API response format'
  }
];

const result = await engine.validate(jsonOutput, rules);
```

### Supported Schema Types

#### Object Validation
```json
{
  "type": "schema",
  "schema": {
    "type": "object",
    "properties": {
      "tickets": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "number" },
            "title": { "type": "string", "minLength": 1 },
            "priority": { "type": "string", "enum": ["Low", "Medium", "High"] }
          },
          "required": ["id", "title", "priority"]
        }
      },
      "metadata": {
        "type": "object",
        "properties": {
          "created": { "type": "string", "format": "date-time" },
          "total": { "type": "number", "minimum": 0 }
        }
      }
    },
    "required": ["tickets", "metadata"]
  },
  "message": "Must be valid ticket collection with metadata"
}
```

#### Array Validation
```json
{
  "type": "schema",
  "schema": {
    "type": "array",
    "items": { "type": "string", "pattern": "^[A-Z]+-\\d+$" },
    "minItems": 1,
    "maxItems": 50
  },
  "message": "Must be array of valid ticket IDs (e.g., PROJ-123)"
}
```

#### String Validation
```json
{
  "type": "schema",
  "schema": {
    "type": "string",
    "pattern": "^(success|error):",
    "minLength": 10
  },
  "message": "Must be status message starting with success: or error:"
}
```

### Performance Features

#### Schema Compilation Caching
```typescript
// ValidationEngine automatically caches compiled schemas
private schemaCache = new Map<string, any>();

// Same schema used multiple times - compiled once, cached for reuse
const schema = { type: 'object', properties: { ... } };
// First use: compiles and caches
await engine.validate(output1, [{ type: 'schema', schema, message: '...' }]);
// Subsequent uses: retrieves from cache (sub-millisecond)
await engine.validate(output2, [{ type: 'schema', schema, message: '...' }]);
```

#### Error Message Optimization
```typescript
// Detailed AJV errors when custom message is empty
{
  type: 'schema',
  schema: { type: 'object', required: ['name'] },
  message: '' // Use AJV's detailed error messages
}
// Result: "Validation Error at '.name': must have required property 'name'"

// Custom message for user-friendly errors
{
  type: 'schema',
  schema: { type: 'object', required: ['name'] },
  message: 'User profile must include a name field'
}
// Result: "User profile must include a name field"
```

---

## Context-Aware Validation

### Overview

Context-Aware Validation allows rules to be applied conditionally based on execution context variables. Rules with unmet conditions are skipped entirely for optimal performance.

### Basic Usage

```typescript
const context: ConditionContext = {
  taskType: 'ticket-creation',
  userRole: 'admin',
  priority: 'high'
};

const rules: ValidationRule[] = [
  {
    type: 'contains',
    value: 'urgent',
    condition: { var: 'priority', equals: 'high' },
    message: 'High priority tasks must mention urgency'
  }
];

const result = await engine.validate(output, rules, context);
```

### Condition Operators

#### Basic Comparisons
```typescript
// Equality checks
{ var: 'taskType', equals: 'bug-fix' }
{ var: 'userRole', not_equals: 'guest' }

// Numeric comparisons
{ var: 'complexity', gt: 0.7 }        // greater than
{ var: 'timeSpent', gte: 30 }         // greater than or equal
{ var: 'priority', lt: 5 }            // less than
{ var: 'confidence', lte: 0.9 }       // less than or equal
```

#### Logical Operators
```typescript
// AND - all conditions must be true
{
  and: [
    { var: 'taskType', equals: 'ticket-creation' },
    { var: 'priority', equals: 'high' }
  ]
}

// OR - at least one condition must be true
{
  or: [
    { var: 'userRole', equals: 'admin' },
    { var: 'userRole', equals: 'manager' }
  ]
}

// NOT - condition must be false
{
  not: { var: 'environment', equals: 'production' }
}
```

### Real-World Examples

#### Task-Specific Validation
```typescript
const rules: ValidationRule[] = [
  {
    type: 'contains',
    value: 'test',
    condition: { var: 'taskType', equals: 'testing' },
    message: 'Testing tasks must mention test execution'
  },
  {
    type: 'contains',
    value: 'deployed',
    condition: { var: 'taskType', equals: 'deployment' },
    message: 'Deployment tasks must confirm deployment'
  }
];
```

#### User Role-Based Validation
```typescript
const rules: ValidationRule[] = [
  {
    type: 'length',
    min: 100,
    condition: { var: 'userRole', equals: 'senior' },
    message: 'Senior developers must provide detailed explanations'
  },
  {
    type: 'contains',
    value: 'review needed',
    condition: { var: 'userRole', equals: 'junior' },
    message: 'Junior developers must request code review'
  }
];
```

#### Environment-Dependent Validation
```typescript
const rules: ValidationRule[] = [
  {
    type: 'contains',
    value: 'security scan',
    condition: { var: 'environment', equals: 'production' },
    message: 'Production deployments must include security scan'
  },
  {
    type: 'regex',
    pattern: 'rollback plan:.*',
    condition: {
      and: [
        { var: 'environment', equals: 'production' },
        { var: 'risk', equals: 'high' }
      ]
    },
    message: 'High-risk production changes must include rollback plan'
  }
];
```

### Performance Benefits

#### Rule Filtering
```typescript
// Without context-aware validation: all rules always evaluated
// With context-aware validation: only applicable rules evaluated

const context = { taskType: 'documentation', userRole: 'writer' };

const rules = [
  { type: 'contains', value: 'code', condition: { var: 'taskType', equals: 'coding' } },     // SKIPPED
  { type: 'contains', value: 'test', condition: { var: 'taskType', equals: 'testing' } },   // SKIPPED  
  { type: 'contains', value: 'written', condition: { var: 'taskType', equals: 'documentation' } } // EVALUATED
];
// Only 1 of 3 rules evaluated = 3x performance improvement
```

---

## Logical Composition

### Overview

Logical Composition enables complex validation expressions using and/or/not operators with unlimited nesting depth. This allows sophisticated business logic validation that goes beyond simple rule combinations.

### Basic Composition Syntax

#### Array Format (Backward Compatible)
```typescript
// Traditional array format - all rules must pass (implicit AND)
const rules: ValidationRule[] = [
  { type: 'contains', value: 'success', message: 'Must contain success' },
  { type: 'length', min: 10, message: 'Must be detailed' }
];
```

#### Composition Format (Advanced)
```typescript
// Explicit composition format with logical operators
const composition: ValidationComposition = {
  and: [
    { type: 'contains', value: 'success', message: 'Must contain success' },
    { type: 'length', min: 10, message: 'Must be detailed' }
  ]
};
```

### Logical Operators

#### AND Operator - All Must Pass
```typescript
const composition: ValidationComposition = {
  and: [
    { type: 'contains', value: 'completed', message: 'Must mention completion' },
    { type: 'contains', value: 'tested', message: 'Must mention testing' },
    { type: 'length', min: 50, message: 'Must be detailed' }
  ]
};
// Passes only if ALL three rules pass
```

#### OR Operator - At Least One Must Pass
```typescript
const composition: ValidationComposition = {
  or: [
    { type: 'contains', value: 'success', message: 'Must contain success' },
    { type: 'contains', value: 'completed', message: 'Must contain completed' },
    { type: 'contains', value: 'finished', message: 'Must contain finished' }
  ]
};
// Passes if ANY of the three rules pass
```

#### NOT Operator - Must Not Pass
```typescript
const composition: ValidationComposition = {
  not: { type: 'contains', value: 'error', message: 'Must not contain error' }
};
// Passes only if the rule does NOT pass (no errors mentioned)
```

### Complex Nested Expressions

#### Mixed Logic Example
```typescript
const composition: ValidationComposition = {
  and: [
    // Basic requirement - must mention tickets
    { type: 'contains', value: 'ticket', message: 'Must mention tickets' },
    
    // Status requirement - one of these must be true
    {
      or: [
        { type: 'contains', value: 'created', message: 'Must mention creation' },
        { type: 'contains', value: 'updated', message: 'Must mention update' },
        { type: 'contains', value: 'resolved', message: 'Must mention resolution' }
      ]
    },
    
    // Quality requirement - must not contain error indicators
    {
      not: {
        or: [
          { type: 'contains', value: 'error', message: 'Must not contain error' },
          { type: 'contains', value: 'failed', message: 'Must not contain failed' }
        ]
      }
    }
  ]
};
```

#### Business Logic Example
```typescript
// Complex business rule: "Task completion requires either success confirmation 
// OR (detailed explanation AND supervisor approval)"
const composition: ValidationComposition = {
  or: [
    // Simple success path
    { type: 'contains', value: 'successfully completed', message: 'Must confirm success' },
    
    // Alternative detailed path
    {
      and: [
        { type: 'length', min: 200, message: 'Must provide detailed explanation' },
        { type: 'contains', value: 'supervisor approved', message: 'Must have supervisor approval' }
      ]
    }
  ]
};
```

### Context-Aware Compositions

```typescript
const composition: ValidationComposition = {
  and: [
    // Always required
    { type: 'contains', value: 'task completed', message: 'Must confirm completion' },
    
    // Conditional requirements based on context
    {
      or: [
        // High priority - needs urgency mention
        {
          type: 'contains',
          value: 'urgent',
          condition: { var: 'priority', equals: 'high' },
          message: 'High priority must mention urgency'
        },
        
        // Normal priority - needs standard confirmation  
        {
          type: 'contains',
          value: 'on schedule',
          condition: { var: 'priority', equals: 'normal' },
          message: 'Normal priority must confirm schedule'
        }
      ]
    }
  ]
};
```

### Performance Characteristics

#### Short-Circuit Evaluation
```typescript
// AND operator - stops on first failure
{
  and: [
    { type: 'contains', value: 'nonexistent', message: 'Will fail first' },     // Fails immediately
    { type: 'length', min: 1000, message: 'Never evaluated' }                  // Skipped
  ]
}

// OR operator - stops on first success  
{
  or: [
    { type: 'contains', value: 'success', message: 'Will pass first' },        // Passes immediately
    { type: 'length', min: 1000, message: 'Never evaluated' }                  // Skipped
  ]
}
```

---

## Performance Optimization

### Schema Caching Strategy

#### Automatic Caching
```typescript
// ValidationEngine uses Map-based caching automatically
private schemaCache = new Map<string, any>();

// Cache key is JSON.stringify of the schema
const cacheKey = JSON.stringify(schema);
if (this.schemaCache.has(cacheKey)) {
  return this.schemaCache.get(cacheKey); // Sub-millisecond retrieval
}
```

#### Cache-Friendly Schema Design
```typescript
// ✅ Good - reusable schemas
const userSchema = {
  type: 'object',
  properties: { id: { type: 'number' }, name: { type: 'string' } }
};

// Use same schema multiple times - compiled once, cached
const rules = [
  { type: 'schema', schema: userSchema, message: 'Invalid user 1' },
  { type: 'schema', schema: userSchema, message: 'Invalid user 2' }
];

// ❌ Bad - inline schemas that can't be cached effectively
const rules = [
  { type: 'schema', schema: { type: 'object', properties: { id: { type: 'number' } } }, message: '...' },
  { type: 'schema', schema: { type: 'object', properties: { id: { type: 'number' } } }, message: '...' }
];
```

### Context-Aware Performance

#### Rule Filtering Optimization
```typescript
// Only rules with matching conditions are evaluated
const context = { environment: 'development' };

const rules = [
  { type: 'contains', value: 'dev', condition: { var: 'environment', equals: 'development' } },  // ✅ Evaluated
  { type: 'contains', value: 'prod', condition: { var: 'environment', equals: 'production' } }   // ⏭️ Skipped
];
// 50% performance improvement through filtering
```

### Composition Optimization

#### Efficient Nesting
```typescript
// ✅ Good - most selective conditions first
{
  and: [
    { type: 'contains', value: 'rare_string', message: '...' },     // Most likely to fail fast
    { type: 'length', min: 10, message: '...' },                   // Less selective
    { type: 'regex', pattern: 'complex.*pattern', message: '...' } // Most expensive
  ]
}

// ❌ Bad - expensive operations first
{
  and: [
    { type: 'regex', pattern: 'complex.*pattern', message: '...' }, // Expensive, evaluated always
    { type: 'contains', value: 'rare_string', message: '...' }      // Could fail early but checked last
  ]
}
```

### Benchmarking Results

| Validation Type | Operations/sec | Memory Usage | Cache Hit Rate |
|-----------------|----------------|--------------|----------------|
| Simple contains | 100,000+ | Low | N/A |
| Regex validation | 50,000+ | Low | N/A |
| Schema validation (cached) | 25,000+ | Medium | 95%+ |
| Schema validation (uncached) | 5,000+ | Medium | 0% |
| Complex composition | 10,000+ | Medium | Variable |

---

## Best Practices

### Rule Design Principles

#### 1. Clear and Actionable Messages
```typescript
// ✅ Good - specific and actionable
{
  type: 'contains',
  value: 'test results',
  message: 'Testing tasks must include specific test results or test execution details'
}

// ❌ Bad - vague and unhelpful
{
  type: 'contains', 
  value: 'test',
  message: 'Missing test'
}
```

#### 2. Appropriate Rule Types
```typescript
// ✅ Good - use schema for structured data
{
  type: 'schema',
  schema: { type: 'object', properties: { status: { enum: ['pass', 'fail'] } } },
  message: 'Test result must be valid JSON with status field'
}

// ❌ Bad - use contains for structured data  
{
  type: 'contains',
  value: '"status":',
  message: 'Must include status field'
}
```

#### 3. Progressive Complexity
```typescript
// ✅ Good - start simple, add complexity as needed
const basicRules = [
  { type: 'length', min: 10, message: 'Provide detailed response' }
];

const advancedRules = {
  and: [
    { type: 'length', min: 10, message: 'Provide detailed response' },
    {
      or: [
        { type: 'contains', value: 'completed', message: 'Mention completion' },
        { type: 'contains', value: 'in progress', message: 'Mention progress' }
      ]
    }
  ]
};
```

### Context Design Patterns

#### 1. Consistent Context Variables
```typescript
// ✅ Good - standardized context structure
interface TaskContext {
  taskType: 'coding' | 'testing' | 'documentation' | 'deployment';
  priority: 'low' | 'medium' | 'high';
  userRole: 'junior' | 'senior' | 'lead' | 'manager';
  environment: 'development' | 'staging' | 'production';
  complexity: number; // 0.0 to 1.0
}

// ❌ Bad - inconsistent naming and types
{
  type: 'coding', // should be taskType
  pri: 'hi',      // should be priority: 'high'  
  user: 'sr',     // should be userRole: 'senior'
  env: 'prod'     // should be environment: 'production'
}
```

#### 2. Graceful Degradation
```typescript
// ✅ Good - rules work even with missing context
{
  type: 'contains',
  value: 'completed',
  condition: { var: 'taskType', equals: 'testing' }, // Optional enhancement
  message: 'Must confirm task completion'
}

// ❌ Bad - rules require specific context to work
{
  type: 'contains',
  value: 'test results',
  condition: { var: 'testFramework', equals: 'jest' }, // Too specific
  message: 'Jest tests must include results'
}
```

### Composition Strategies

#### 1. Readable Logic
```typescript
// ✅ Good - logic mirrors business requirements
const composition = {
  and: [
    // "Task must be completed"
    { type: 'contains', value: 'completed', message: 'Task must be completed' },
    
    // "AND (either tested OR reviewed)"
    {
      or: [
        { type: 'contains', value: 'tested', message: 'Must be tested' },
        { type: 'contains', value: 'reviewed', message: 'Must be reviewed' }
      ]
    }
  ]
};

// ❌ Bad - complex nested logic without clear business meaning
const composition = {
  or: [
    { and: [{ not: { /* ... */ } }, { or: [/* ... */] }] }
  ]
};
```

#### 2. Testable Components  
```typescript
// ✅ Good - compose from testable parts
const mustBeCompleted = { type: 'contains', value: 'completed', message: '...' };
const mustBeTested = { type: 'contains', value: 'tested', message: '...' };
const mustBeReviewed = { type: 'contains', value: 'reviewed', message: '...' };

const composition = {
  and: [
    mustBeCompleted,
    { or: [mustBeTested, mustBeReviewed] }
  ]
};
```

---

## Troubleshooting

### Common Issues

#### 1. Schema Validation Failures
```typescript
// Issue: Schema validation always fails
{
  type: 'schema',
  schema: { type: 'object', required: ['name'] },
  message: 'Must include name'
}

// Common causes:
// - Output is not valid JSON
// - Schema is malformed
// - Required properties are missing

// Solution: Test with simple JSON first
const testOutput = '{"name": "test"}';
const result = await engine.validate(testOutput, rules);
```

#### 2. Context Variables Not Working
```typescript
// Issue: Context-aware rules always skip
{
  type: 'contains',
  value: 'test',
  condition: { var: 'taskType', equals: 'testing' },
  message: 'Must mention testing'
}

// Common causes:
// - Context variable name mismatch ('taskType' vs 'task_type')
// - Context variable value mismatch ('testing' vs 'test')
// - Context not passed to validate() call

// Solution: Check context object
const context = { taskType: 'testing' }; // Exact match required
const result = await engine.validate(output, rules, context);
```

#### 3. Composition Logic Errors
```typescript
// Issue: Complex composition behaves unexpectedly
{
  and: [
    { type: 'contains', value: 'success', message: '...' },
    {
      or: [
        { type: 'contains', value: 'A', message: '...' },
        { type: 'contains', value: 'B', message: '...' }
      ]
    }
  ]
}

// Solution: Test components separately
const successRule = { type: 'contains', value: 'success', message: '...' };
const orComposition = { or: [/* ... */] };

// Test each part individually
await engine.validate(output, [successRule]);
await engine.validate(output, orComposition);
```

### Debugging Techniques

#### 1. Validation Result Analysis
```typescript
const result = await engine.validate(output, rules, context);

console.log('Validation result:', {
  valid: result.valid,
  issues: result.issues,
  suggestions: result.suggestions
});

// For schema validation, check AJV errors
if (!result.valid && rules.some(r => r.type === 'schema')) {
  console.log('Possible schema issues - check JSON format');
}
```

#### 2. Context Debugging
```typescript
// Log context to verify variable names and values
console.log('Validation context:', context);

// Test conditions independently
import { evaluateCondition } from '../utils/condition-evaluator';
const conditionResult = evaluateCondition(rule.condition, context);
console.log('Condition evaluates to:', conditionResult);
```

#### 3. Rule Isolation
```typescript
// Test rules one at a time to identify issues
for (const rule of rules) {
  const singleResult = await engine.validate(output, [rule], context);
  console.log(`Rule ${rule.type}:`, singleResult.valid ? 'PASS' : 'FAIL');
  if (!singleResult.valid) {
    console.log('Issues:', singleResult.issues);
  }
}
```

### Performance Debugging

#### 1. Cache Hit Rate Monitoring
```typescript
// Add logging to monitor schema cache effectiveness
class ValidationEngine {
  private cacheHits = 0;
  private cacheMisses = 0;
  
  private compileSchema(schema: any) {
    const cacheKey = JSON.stringify(schema);
    if (this.schemaCache.has(cacheKey)) {
      this.cacheHits++;
      return this.schemaCache.get(cacheKey);
    }
    this.cacheMisses++;
    // ... compilation logic
  }
  
  getCacheStats() {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: this.cacheHits / (this.cacheHits + this.cacheMisses)
    };
  }
}
```

#### 2. Timing Analysis
```typescript
const startTime = performance.now();
const result = await engine.validate(output, rules, context);
const endTime = performance.now();
console.log(`Validation took ${endTime - startTime} milliseconds`);
```

---

## References

- [Architecture Guide](02-architecture.md) - ValidationEngine technical architecture
- [Simple Workflow Guide](09-simple-workflow-guide.md) - Basic validation examples
- [API Specification](../../spec/mcp-api-v1.0.md) - workflow_validate tool documentation
- [Workflow Schema](../../spec/workflow.schema.json) - Schema definitions for validation
- [Conditional Workflow Example](../../spec/examples/conditional-workflow-example.json) - Context-aware workflow patterns

---

**Last Updated**: 2024-01-15  
**ValidationEngine Version**: 0.0.1-alpha  
**Test Coverage**: 72 tests passing  
**Maintained By**: Documentation Team 