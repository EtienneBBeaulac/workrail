# Context Optimization Guide for Workflows (v1)

This guide documents **v1 behavior** (`workflow_next` with agent-sent context).

> For WorkRail v2, use `docs/features/context-optimization-guide-v2.md` and the canonical v2 contract: `docs/reference/workflow-execution-contract.md`.

---

# Context Optimization Guide for Workflows

## Overview

> **Note (WorkRail v1 vs v2):** This guide describes v1 behavior (`workflow_next` with agent-sent context). WorkRail v2 uses `start_workflow` / `continue_workflow` with opaque tokens and does not rely on agent-managed engine state. See `docs/reference/workflow-execution-contract.md`.

The MCP server now includes automatic context optimization instructions that help AI agents reduce the size of context sent with each `workflow_next` call. This guide explains how workflows can
use this feature effectively.

## Understanding the Stateless Nature

The MCP server is **completely stateless**. This means:
- It doesn't remember previous requests
- Every `workflow_next` call must include ALL necessary data
- Missing required variables will cause failures

## What Gets Optimized

### Before Optimization
```jsonc
{
      "workflowId": "coding-task-workflow-with-loops",
  "completedSteps": ["phase-1", "phase-2"],
  "context": {
    // 17KB of accumulated state including:
    "taskDescription": "...",           // 2KB
    "implementationSteps": [...],        // 10KB array
    "_loopState": {...},                 // 3KB
    "analysisResults": {...},            // 1KB
    "userRules": [...],                  // 500B
    "existingCode": "...",              // 500B
    // ... and much more
  }
}
```

### After Optimization
```jsonc
{
      "workflowId": "coding-task-workflow-with-loops",
  "completedSteps": ["phase-1", "phase-2", "phase-3"],
  "context": {
    // Only what's needed for the next step:
    "taskComplexity": "Medium",          // Used in conditions
    "currentStepNumber": 3,              // Used in templates
    "stepCompleted": true,               // New variable
    "testResults": "passed"              // Modified variable
    // Total: <2KB
  }
}
```

## Critical Rules for Context Preservation

### 1. Variables in Conditions

If a step has a `runCondition`, ALL referenced variables MUST be included:

```jsonc
{
  "id": "conditional-step",
  "runCondition": {
    "and": [
      {"var": "taskComplexity", "equals": "Large"},
      {"var": "needsReview", "equals": true}
    ]
  }
}
```

**Required context:**
```jsonc
{
  "taskComplexity": "Large",
  "needsReview": true
}
```

### 2. Template Variables

Any `{{variable}}` in prompts, titles, or guidance MUST be included:

```jsonc
{
  "id": "loop-step",
  "title": "Step {{currentStepNumber}} of {{totalSteps}}",
  "prompt": "Implement item {{currentItem.name}}"
}
```

**Required context:**
```jsonc
{
  "currentStepNumber": 3,
  "totalSteps": 10,
  "currentItem": {"name": "User authentication"}
}
```

### 3. Loop Variables

When inside a loop, specific variables are injected and must be preserved:

```jsonc
{
  // For forEach loops:
  "currentItem": {...},      // Current item being processed
  "currentIndex": 2,         // Index in the array
  "currentIteration": 3,     // 1-based iteration count
  
  // Only the active loop state:
  "_loopState": {
    "active-loop-id": {
      "iteration": 2,
      "index": 2
    }
  }
}
```

## Best Practices for Workflow Design

### 1. Avoid Large Array Storage

 **Bad: Storing large arrays**
```jsonc
{
  "id": "prepare-implementation",
  "prompt": "Extract all implementation steps into an array"
  // Results in: implementationSteps: [30 items] = 15KB
}
```

 **Good: Store count and read on-demand**
```jsonc
{
  "id": "count-steps",
  "prompt": "Count the implementation steps in the plan"
  // Results in: totalSteps: 30 = 4 bytes
}
```

### 2. Use Explicit Variable Names

Make it clear which variables are important:

```jsonc
{
  "id": "validation-step",
  "prompt": "Validate the code. Set 'validationPassed' to true/false",
  "guidance": ["Variable 'validationPassed' will be used in next step's condition"]
}
```

### 3. Document Variable Dependencies

Add guidance about what needs to be preserved:

```jsonc
{
  "id": "analysis-step",
  "guidance": [
    "Extract key findings into 'analysisResults'",
    "This variable is needed until phase-5"
  ]
}
```

## Workflow-Specific Optimizations

### 1. Coding Task Workflow

The coding task workflow now includes explicit optimization instructions:

```jsonc
{
  "id": "phase-6-prep",
  "prompt": "...\n\n**CRITICAL CONTEXT OPTIMIZATION:**\nWhen calling workflow_next after this step, send ONLY:\n- currentStepNumber and totalImplementationSteps\n- Any NEW variables you created (like featureBranch)\n- DO NOT send: arrays, plans, _loopState, _currentLoop, unchanged data"
}
```

### 2. Custom Workflows

You can add similar instructions to your workflows:

```jsonc
{
  "id": "data-processing",
  "prompt": "Process the data...",
  "guidance": [
    "After processing, only send 'processingStatus' and 'errorCount'",
    "The large 'rawData' array is no longer needed"
  ]
}
```

## Debugging Context Issues

### Common Problems

1. **Missing Condition Variable**
   - Error: `Cannot read property 'X' of undefined`
   - Fix: Ensure variable X is included in context

2. **Missing Template Variable**
   - Symptom: `{{variable}}` appears literally in output
   - Fix: Include the variable in context

3. **Loop State Lost**
   - Symptom: Loop restarts or skips
   - Fix: Preserve `_loopState[activeLoopId]`

4. **Loop Count Variable Missing** 
   - Symptom: Loop exits immediately, jumps to next major phase
   - Error: "Invalid count value for 'for' loop: variableName"
   - Fix: Ensure count variable (e.g., `totalImplementationSteps`) is preserved
   - Common cause: Workflow step instructions override general template variable rules

### Validation Checklist

Before each `workflow_next` call, agents should verify:

- [ ] `workflowId` is included
- [ ] `completedSteps` array is complete
- [ ] All condition variables are present
- [ ] All template variables are included
- [ ] Loop count variables are preserved (e.g., `totalImplementationSteps`)
- [ ] New/modified variables are added
- [ ] Active loop state is preserved
- [ ] Context size is reasonable (<10KB)

## Size Targets

| Scenario | Target Size | Maximum |
|----------|------------|---------|
| Simple step | <1KB | 2KB |
| With conditions | <2KB | 5KB |
| Loop iteration | <3KB | 5KB |
| Complex state | <5KB | 10KB |
| Maximum allowed | - | 256KB |

## Example: Complete Optimization Flow

```typescript
// Step 1: Agent receives response with optimization instructions
const response = await workflow_next({
  workflowId: "my-workflow",
  completedSteps: ["step-1"],
  context: fullContext // 15KB
});

// Step 2: Agent reads optimization requirements
// Sees: "ALWAYS INCLUDE condition variables..."

// Step 3: Agent analyzes next step requirements
// Next step has: runCondition using 'status'
// Next step has: "Review {{itemCount}} items"

// Step 4: Agent sends optimized context
const nextCall = await workflow_next({
  workflowId: "my-workflow",
  completedSteps: ["step-1", "step-2"],
  context: {
    // Required for condition:
    status: "ready",
    // Required for template:
    itemCount: 5,
    // New variable from this step:
    reviewStarted: true
    // Total: <1KB (vs 15KB)
  }
});
```

## Migration Guide

For existing agents:
1. Start logging context sizes
2. Identify which variables are actually used
3. Implement context filtering based on the requirements
4. Test with reduced context
5. Monitor for any missing variable errors

## Summary

The context optimization feature helps reduce token usage by 70-90% while maintaining full functionality. The key is understanding what the stateless server actually needs and sending only that data. When in doubt, err on the side of including data rather than breaking functionality.
