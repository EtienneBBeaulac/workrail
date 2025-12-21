# Agent Context Optimization Guide

## The Problem

> **Note (WorkRail v1 vs v2):** This guide describes v1 behavior where agents send large `context` payloads to `workflow_next`. WorkRail v2 uses `start_workflow` / `continue_workflow` with opaque tokens; agents do not send engine internals. See `docs/reference/workflow-execution-contract.md`.

Agents currently send back the ENTIRE context (15-20KB) on every `workflow_next` call, even though they only need to send what changed.

## The Solution: Send Only What Changed

###  DON'T DO THIS (Current Behavior)

```jsonc
{
  "workflowId": "coding-task-workflow-with-loops",
  "completedSteps": ["phase-6-prep"],
  "context": {
    // All 17KB of data including:
    "taskDescription": "...",
    "userRules": "...", 
    "implementationSteps": [/* all 14 items */],
    "_loopState": {/* entire state */},
    "_currentLoop": {/* full definition */},
    // ... everything else unchanged
  }
}
```

###  DO THIS INSTEAD (Optimized)

```jsonc
{
  "workflowId": "coding-task-workflow-with-loops", 
  "completedSteps": ["phase-6-prep"],
  "context": {
    // Only what you need or changed:
    "currentStep": {
      "title": "Core Contracts...",
      "description": "...",
      "outputs": "..."
    },
    "stepIndex": 1,
    "stepIteration": 2,
    "featureBranch": "feat/new-feature", // NEW data you created
    // That's it! 3KB instead of 17KB
  }
}
```

## Rules for Context Management

### 1. Never Echo Arrays

```jsonc
//  BAD: Sending back unchanged array
"implementationSteps": [/* all 14 items */]

//  GOOD: Only send current item
"currentStep": { /* just this one */ }
```

### 2. Skip Internal Fields

Never send these back:
- `_loopState`
- `_currentLoop` 
- `_contextSize`
- `_warnings`

### 3. Only Send What You Modified

```jsonc
// If you created a new variable:
"verificationResult": true

// If you modified existing data:
"confidenceScore": 10  // was 9

// DON'T send unchanged data:
// "taskDescription": "..." // unchanged, don't send
```

## Specific Examples

### For Loop Steps

```jsonc
{
  "workflowId": "coding-task-workflow-with-loops",
  "completedSteps": ["phase-6-prep", "phase-6-implement"],
  "context": {
    "currentStep": { /* current */ },
    "stepIndex": 2,
    "stepIteration": 3,
    "filesCreated": ["new-file.ts"], // NEW data
    "testsPassed": true              // NEW data
  }
}
```

### For Clarification Steps

```jsonc
{
  "workflowId": "coding-task-workflow-with-loops",
  "completedSteps": ["phase-2-informed-clarification"],
  "context": {
    "clarifiedRequirements": "Updated requirements...", // MODIFIED
    "confidenceScore": 8                                // MODIFIED
    // Don't send taskDescription, userRules, etc.
  }
}
```

## Why This Matters

- **80-90% smaller requests** (3KB vs 17KB)
- **Faster processing**
- **Lower costs**
- **Better performance**

## Implementation Checklist

When calling `workflow_next`:

1. [ ] Remove all arrays you didn't modify
2. [ ] Remove all `_` prefixed fields
3. [ ] Only include fields you created or changed
4. [ ] For loops: only send current item, not all items
5. [ ] Check: Is my context < 5KB? (Good!)

## Testing Your Implementation

Before:
```
Context size: 17,104 bytes
```

After following this guide:
```
Context size: 2,048 bytes (88% reduction!)
```