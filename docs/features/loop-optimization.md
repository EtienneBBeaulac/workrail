# Loop Context Optimization

## Overview

WorkRail v0.2.0 introduces significant optimizations for loop execution, reducing context size by 60-80% during loop iterations. This feature implements a progressive disclosure pattern where the first iteration receives full context and subsequent iterations receive minimal, optimized context.

## Key Features

### 1. Progressive Context Disclosure

- **First Iteration**: Receives complete loop overview including:
  - Full phase information
  - All loop metadata
  - Function definitions
  - Complete array data for forEach loops
  
- **Subsequent Iterations**: Receive minimal context with:
  - Current iteration number
  - Current item only (for forEach loops)
  - Reference to phase overview from first iteration
  - Stripped metadata and large arrays

### 2. Empty Loop Detection

Loops with no items to process are automatically skipped, avoiding unnecessary phase overview generation:

```typescript
// These loops will be skipped entirely:
{ type: 'forEach', items: 'emptyArray' }  // where emptyArray = []
{ type: 'for', count: 0 }
{ type: 'while', condition: { var: 'flag', equals: false } }  // where flag = false
```

### 3. Function DSL Support

The schema now natively supports function definitions at multiple scopes:

```json
{
  "functionDefinitions": [
    {
      "name": "validateItem",
      "definition": "Validates item format and returns boolean",
      "scope": "workflow"
    }
  ],
  "steps": [{
    "id": "process-loop",
    "type": "loop",
    "functionDefinitions": [
      {
        "name": "processSpecific",
        "definition": "Process items in this loop context",
        "scope": "loop"
      }
    ],
    "body": {
      "id": "use-functions",
      "prompt": "Apply validation",
      "functionReferences": ["validateItem()", "processSpecific()"]
    }
  }]
}
```

## Implementation Details

### Architecture

The optimization is implemented through:

1. **LoopContextOptimizer Service**: Instance-based service following DI pattern
2. **Enhanced LoopExecutionContext**: Supports minimal context generation
3. **Modified WorkflowService**: Integrates optimization into main flow

### Context Size Reduction

Example context transformation:

**First Iteration (Full Context)**:
```json
{
  "dataItems": [/* 1000 items */],
  "currentDataItem": { "id": "item-0" },
  "itemIndex": 0,
  "_currentLoop": {
    "loopId": "process-loop",
    "loopStep": { /* full step definition */ }
  }
}
```

**Second Iteration (Optimized Context)**:
```json
{
  "currentDataItem": { "id": "item-1" },
  "itemIndex": 1,
  "_currentLoop": {
    "loopId": "process-loop",
    "loopType": "forEach",
    "iteration": 1,
    "phaseReference": {
      "loopId": "process-loop",
      "phaseTitle": "Process Items Loop",
      "totalSteps": 2
    }
  }
}
```

## Usage Guidelines

### For Workflow Authors

1. **Define Function DSL** at appropriate scopes:
   - Workflow level: Shared across all steps
   - Loop level: Available within loop body
   - Step level: Specific to that step

2. **Use Function References** in step prompts:
   ```json
   {
     "prompt": "Process item using validateItem() and formatOutput()",
     "functionReferences": ["validateItem()", "formatOutput()"]
   }
   ```

3. **Consider Loop Size** when designing workflows:
   - Large arrays benefit most from optimization
   - Nested loops see compounded benefits

### For Agents

When processing optimized loops:

1. **First Iteration**: Store phase overview information for reference
2. **Subsequent Iterations**: Refer to stored phase overview when needed
3. **Function References**: Look up definitions in appropriate scope
4. **Minimal Context**: Work with just the current item, not full arrays

## Performance Characteristics

Based on benchmarks:

- **Context Size Reduction**: 60-80% for large arrays
- **Processing Overhead**: < 5% additional time
- **Memory Usage**: Significantly reduced for long-running loops
- **Network Transfer**: Reduced payload size for remote execution

## Migration Guide

### From v0.1.x to v0.2.0

1. **Schema Version**: Update to v0.2.0
2. **Add maxIterations**: Required field for all loops
3. **Optional**: Add function definitions to reduce duplication
4. **No Code Changes**: Optimization is automatic

Example migration:

```diff
{
-  "version": "0.1.0",
+  "version": "0.2.0",
   "steps": [{
     "type": "loop",
     "loop": {
       "type": "forEach",
-      "items": "data"
+      "items": "data",
+      "maxIterations": 1000
     }
   }]
}
```

## Best Practices

1. **Use Function DSL** for repeated patterns within loops
2. **Set Appropriate maxIterations** to prevent runaway loops
3. **Use Empty Loop Detection** by checking conditions early
4. **Design for Progressive Disclosure** in your prompts

## Troubleshooting

### Large Context Errors

If you still encounter context size errors:

1. Check for accumulating data in loop state
2. Ensure large arrays aren't being duplicated
3. Consider breaking very large loops into batches

### Function Reference Issues

If function references aren't working:

1. Verify function is defined at correct scope
2. Check reference syntax includes parentheses: `functionName()`
3. Ensure agent supports function DSL

## Future Enhancements

Planned improvements include:

1. **Loop Resumption**: Ability to resume execution mid-loop
2. **Client-Side Caching**: Optional caching of phase references
3. **Dynamic Optimization**: Adaptive thresholds based on context size
4. **Streaming Support**: Progressive context streaming for very large loops