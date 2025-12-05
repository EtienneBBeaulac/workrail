# Loop Workflow Examples

This directory contains example workflows demonstrating the loop functionality in Workrail v0.1.0.

## Available Examples

### 1. Simple Polling (`simple-polling.json`)
Demonstrates how to use a **while loop** to poll an API endpoint until a certain condition is met.
- **Loop type**: `while`
- **Use case**: Monitoring asynchronous operations
- **Key concepts**: Condition-based iteration, status checking

### 2. Simple Retry (`simple-retry.json`)
Shows how to implement retry logic using a **for loop** with a fixed number of attempts.
- **Loop type**: `for`
- **Use case**: Fault-tolerant operations
- **Key concepts**: Fixed iteration count, error handling

### 3. Simple Batch Processing (`simple-batch.json`)
Illustrates processing a collection of items using a **forEach loop**.
- **Loop type**: `forEach`
- **Use case**: Bulk data processing
- **Key concepts**: Iterating over arrays, item and index variables

### 4. Simple Search (`simple-search.json`)
Demonstrates searching through multiple data sources using an **until loop**.
- **Loop type**: `until`
- **Use case**: Finding data across multiple sources
- **Key concepts**: Loop until condition met, early exit

## Loop Types

Workrail supports four types of loops:

1. **while**: Continues while a condition is true
2. **until**: Continues until a condition becomes true
3. **for**: Executes a fixed number of times
4. **forEach**: Iterates over items in an array

## Key Features

- **maxIterations**: Safety limit to prevent infinite loops
- **iterationVar**: Custom variable name for the current iteration count
- **itemVar** (forEach only): Variable name for the current item
- **indexVar** (forEach only): Variable name for the current index
- **body**: Reference to the step ID to execute in each iteration

## Running the Examples

These workflows can be executed through any MCP-enabled AI assistant that has Workrail installed. The assistant will:
1. Initialize the required context variables
2. Execute the loop body for each iteration
3. Update variables as specified
4. Exit when the loop condition is met or maxIterations is reached

## Validation

All examples have been validated against the Workrail v0.1.0 schema. You can validate them yourself:

```bash
workrail validate workflows/examples/loops/simple-polling.json
```

## Creating Your Own Loop Workflows

When creating loop workflows:
1. Always specify `maxIterations` as a safety measure
2. Use meaningful variable names for `iterationVar`, `itemVar`, and `indexVar`
3. Ensure the loop body step updates necessary variables to avoid infinite loops
4. Test with small datasets first
5. Consider adding progress logging in the loop body 