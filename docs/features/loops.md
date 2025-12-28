# Loop Support in Workrail

This guide covers the loop functionality introduced in Workrail v0.1.0, enabling powerful iteration patterns within workflows while maintaining the system's stateless architecture.

> **WorkRail v2 note:** v2 loop semantics are intentionally different. v2 prefers explicit, deterministic loops with closed-set conditions and contract-validated loop control artifacts (not free-form context expression evaluation). For v2 authoring, see `docs/design/workflow-authoring-v2.md`.

## Table of Contents
- [Overview](#overview)
- [Loop Types](#loop-types)
  - [While Loops](#while-loops)
  - [Until Loops](#until-loops)
  - [For Loops](#for-loops)
  - [ForEach Loops](#foreach-loops)
- [Configuration](#configuration)
- [Context and State Management](#context-and-state-management)
- [Best Practices](#best-practices)
- [Migration Guide](#migration-guide)
- [Technical Details](#technical-details)

## Overview

Loops in Workrail allow workflows to iterate over steps, enabling common patterns like:
- Polling APIs until completion
- Retrying operations with backoff
- Processing collections of data
- Searching across multiple sources

### Key Features
- **Four loop types**: `while`, `until`, `for`, and `forEach`
- **Safety limits**: Configurable `maxIterations` to prevent infinite loops
- **Stateless execution**: Loop state managed through context, not persisted
- **Flexible body**: Reference existing steps or define inline steps
- **Custom variables**: Control iteration and item variable names

## Loop Types

### While Loops
Continue execution while a condition remains true.

```json
{
  "id": "poll-status",
  "type": "loop",
  "title": "Poll Until Complete",
  "loop": {
    "type": "while",
    "condition": {
      "and": [
        { "var": "status", "not_equals": "completed" },
        { "var": "attempts", "lt": 10 }
      ]
    },
    "maxIterations": 10,
    "iterationVar": "currentAttempt"
  },
  "body": "check-status"
}
```

**Use cases**: 
- API polling
- Waiting for conditions
- Continuous monitoring

### Until Loops
Continue execution until a condition becomes true.

```json
{
  "id": "search-data",
  "type": "loop",
  "title": "Search Until Found",
  "loop": {
    "type": "until",
    "condition": {
      "or": [
        { "var": "found", "equals": true },
        { "var": "sourcesExhausted", "equals": true }
      ]
    },
    "maxIterations": 20
  },
  "body": "search-next-source"
}
```

**Use cases**:
- Searching across sources
- Waiting for events
- Progressive discovery

### For Loops
Execute a fixed number of iterations.

```json
{
  "id": "retry-operation",
  "type": "loop",
  "title": "Retry With Backoff",
  "loop": {
    "type": "for",
    "count": 3,
    "maxIterations": 5,
    "iterationVar": "attemptNumber"
  },
  "body": "attempt-operation"
}
```

**Dynamic count using context variable**:
```json
{
  "loop": {
    "type": "for",
    "count": "maxRetries",  // References context variable
    "maxIterations": 10
  }
}
```

**Use cases**:
- Fixed retry attempts
- Batch operations
- Timed sequences

### ForEach Loops
Iterate over items in an array.

```json
{
  "id": "process-items",
  "type": "loop",
  "title": "Process Each Item",
  "loop": {
    "type": "forEach",
    "items": "dataItems",
    "itemVar": "currentItem",
    "indexVar": "itemIndex",
    "maxIterations": 100
  },
  "body": "process-single-item"
}
```

**Use cases**:
- Batch processing
- Data transformation
- Collection operations

## Configuration

### Loop Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `type` | string | Yes | One of: `while`, `until`, `for`, `forEach` |
| `condition` | object | Conditional | Required for `while` and `until` loops |
| `count` | number/string | Conditional | Required for `for` loops |
| `items` | string | Conditional | Required for `forEach` loops |
| `maxIterations` | number | Yes | Safety limit (1-1000) |
| `iterationVar` | string | No | Custom name for iteration counter |
| `itemVar` | string | No | Custom name for current item (forEach only) |
| `indexVar` | string | No | Custom name for current index (forEach only) |

### Body Definition

The loop body can be defined in two ways:

**1. Reference to existing step:**
```json
{
  "body": "process-step-id"
}
```

**2. Inline step definitions:**
```json
{
  "body": [
    {
      "id": "step-1",
      "title": "First Step",
      "prompt": "Do something"
    },
    {
      "id": "step-2",
      "title": "Second Step",
      "prompt": "Do something else"
    }
  ]
}
```

### Condition Operators

Conditions support the following operators:

| Operator | Description | Example |
|----------|-------------|---------|
| `equals` | Equal to | `{ "var": "status", "equals": "done" }` |
| `not_equals` | Not equal to | `{ "var": "status", "not_equals": "error" }` |
| `gt` | Greater than | `{ "var": "count", "gt": 5 }` |
| `gte` | Greater than or equal | `{ "var": "count", "gte": 10 }` |
| `lt` | Less than | `{ "var": "count", "lt": 100 }` |
| `lte` | Less than or equal | `{ "var": "count", "lte": 50 }` |
| `and` | Logical AND | `{ "and": [...conditions] }` |
| `or` | Logical OR | `{ "or": [...conditions] }` |
| `not` | Logical NOT | `{ "not": condition }` |

## Context and State Management

### Loop Variables

During execution, loops inject special variables into the context:

**All loop types:**
- `{{iterationVar}}`: Current iteration number (1-based)
- Default: `_iteration`

**ForEach loops only:**
- `{{itemVar}}`: Current item from the array
- `{{indexVar}}`: Current index (0-based)
- Defaults: `_item` and `_index`

### Example Context Flow

```javascript
// Initial context
{
  "items": ["apple", "banana", "cherry"],
  "processed": 0
}

// During forEach iteration 2
{
  "items": ["apple", "banana", "cherry"],
  "processed": 1,
  "_item": "banana",     // Current item
  "_index": 1,           // Current index
  "_iteration": 2        // Iteration count
}
```

### Loop State Management

The system maintains loop state internally through:
- `_loopState`: Tracks iteration counts and conditions
- `_currentLoop`: Identifies the active loop during nested execution
- `_contextSize`: Monitors context growth for safety

These are implementation details and not directly accessible in workflows.

## Best Practices

### 1. Always Set maxIterations
```json
{
  "loop": {
    "type": "while",
    "condition": { "var": "searching", "equals": true },
    "maxIterations": 50  // Prevent infinite loops
  }
}
```

### 2. Update Loop Variables
Ensure your loop body updates variables used in conditions:

```json
{
  "id": "increment-counter",
  "prompt": "Increment the counter",
  "guidance": ["Set counter = counter + 1"]
}
```

### 3. Use Meaningful Variable Names
```json
{
  "loop": {
    "type": "forEach",
    "items": "customers",
    "itemVar": "customer",      // Clear naming
    "indexVar": "customerIndex"  // Descriptive
  }
}
```

### 4. Consider Performance
- Keep loop bodies focused
- Avoid deeply nested loops
- Monitor context size for large datasets
- Use appropriate maxIterations values

### 5. Handle Edge Cases
```json
{
  "runCondition": {
    "and": [
      { "var": "items", "not_equals": null },
      { "var": "items.length", "gt": 0 }
    ]
  }
}
```

## Migration Guide

### From v0.0.1 to v0.1.0

Workrail provides an automated migration tool:

```bash
# Migrate a single workflow
workrail migrate workflow.json

# Dry run to see changes
workrail migrate workflow.json --dry-run

# Create backup
workrail migrate workflow.json --backup

# Specify output file
workrail migrate workflow.json --output new-workflow.json
```

### Manual Migration Steps

1. **Add version field:**
   ```json
   {
     "version": "0.1.0"
   }
   ```

2. **Convert loop-like patterns:**
   
   **Before (v0.0.1):**
   ```json
   {
     "id": "step-2",
     "title": "Process Item 2 of 5",
     "prompt": "Process the second item",
     "guidance": ["This is step 2 of 5 in the iteration"]
   }
   ```

   **After (v0.1.0):**
   ```json
   {
     "id": "process-items",
     "type": "loop",
     "title": "Process All Items",
     "loop": {
       "type": "for",
       "count": 5,
       "maxIterations": 5
     },
     "body": "process-single-item"
   }
   ```

### Common Migration Patterns

| Pattern | v0.0.1 Approach | v0.1.0 Loop Type |
|---------|----------------|------------------|
| Polling | Multiple similar steps | `while` loop |
| Retry | Duplicate steps with variations | `for` loop |
| Batch | Hardcoded item processing | `forEach` loop |
| Search | Sequential check steps | `until` loop |

## Technical Details

### Performance Considerations

- **Context cloning**: Optimized for shallow copies
- **Iteration overhead**: ~0.1ms per iteration
- **Memory usage**: Linear with context size
- **Nested loops**: Supported but use judiciously

### Safety Features

1. **Iteration limits**: Hard cap at 1000 iterations
2. **Context size monitoring**: Prevents memory exhaustion
3. **Timeout protection**: Configurable execution timeouts
4. **State isolation**: Each iteration has clean context

### Error Handling

Loops handle errors gracefully:
- Step failures don't break the loop by default
- Conditions are re-evaluated after errors
- Error state can be checked in conditions

```json
{
  "condition": {
    "and": [
      { "var": "lastError", "equals": null },
      { "var": "attempts", "lt": 5 }
    ]
  }
}
```

### Schema Validation

Loops are validated against the v0.1.0 schema:
- Type safety for all properties
- Condition structure validation
- Reference integrity for body steps
- Range checks for numeric values

## Examples

See the `workflows/examples/loops/` directory for complete examples:
- `simple-polling.json`: API polling pattern
- `simple-retry.json`: Retry with backoff
- `simple-batch.json`: Batch processing
- `simple-search.json`: Multi-source search

## Troubleshooting

### Common Issues

1. **"Maximum iterations exceeded"**
   - Increase `maxIterations` if legitimate
   - Check loop exit conditions
   - Ensure variables are updated

2. **"Invalid condition"**
   - Use correct operator names (`lte` not `less_than_or_equal_to`)
   - Check variable names match context
   - Validate condition structure

3. **"Step not found"**
   - Ensure referenced step IDs exist
   - Check for typos in body references
   - Verify step ordering

### Debug Tips

- Add logging steps to track variables
- Use small datasets for initial testing
- Validate workflows before execution
- Monitor context size with large datasets

## Enhanced Loop Validation

WorkRail includes enhanced validation features specifically for loops that help catch common issues and promote best practices:

- **Conditional Logic Complexity**: Warns about complex ternary operators and suggests using runCondition
- **Prompt Length Validation**: Checks for excessively long prompts that could cause issues
- **Template Variable Usage**: Validates that all referenced variables are properly defined
- **Pattern Detection**: Recognizes common loop patterns and provides guidance

For detailed information about loop validation and best practices, see the [Loop Validation Best Practices](./loop-validation-best-practices.md) guide.

## Future Enhancements

Potential future improvements:
- Parallel forEach execution
- Break/continue statements
- Loop result aggregation
- Performance profiling tools

For the latest updates, see the [changelog](../reference/changelog.md). 