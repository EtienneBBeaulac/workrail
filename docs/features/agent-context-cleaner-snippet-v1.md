# Context Cleaner for Agents (v1)

This snippet is for **v1** agent integrations calling `workflow_next`.

> For WorkRail v2, use `docs/features/agent-context-cleaner-snippet-v2.md` and the canonical v2 contract: `docs/reference/workflow-execution-contract.md`.

---

# Context Cleaner for Agents

## Quick Copy-Paste Function

> **Note (WorkRail v1 vs v2):** This snippet is for v1 (`workflow_next` + large context payloads). WorkRail v2 uses opaque tokens (`start_workflow`/`continue_workflow`) and does not rely on agent-managed engine state. See `docs/reference/workflow-execution-contract.md`.

Add this to your agent implementation to automatically clean context before sending to `workflow_next`:

```typescript
function cleanContextForWorkflowNext(
  fullContext: any,
  modifiedFields: string[] = []
): any {
  // Start with only essential fields
  const cleanContext: any = {};
  
  // Always include current loop variables if present
  if (fullContext.currentStep) {
    cleanContext.currentStep = fullContext.currentStep;
  }
  if (typeof fullContext.stepIndex === 'number') {
    cleanContext.stepIndex = fullContext.stepIndex;
  }
  if (typeof fullContext.stepIteration === 'number') {
    cleanContext.stepIteration = fullContext.stepIteration;
  }
  
  // Add any fields the agent explicitly modified
  modifiedFields.forEach(field => {
    if (field in fullContext) {
      cleanContext[field] = fullContext[field];
    }
  });
  
  // NEVER include these
  const blocklist = [
    'implementationSteps',
    '_loopState',
    '_currentLoop',
    '_contextSize',
    '_warnings',
    'userRules',
    'taskDescription'
  ];
  
  // Remove any blocklisted fields that snuck in
  blocklist.forEach(field => {
    delete cleanContext[field];
  });
  
  return cleanContext;
}
```

## Usage Example

```typescript
// During your workflow execution:
const response = await workflow_next({
  workflowId: "coding-task-workflow-with-loops",
  completedSteps: ["phase-6-prep"],
  context: cleanContextForWorkflowNext(fullContext, [
    'featureBranch',      // I created this
    'verificationResult', // I added this
    'filesCreated'        // I added this
  ])
});
```

## Even Simpler: Manual Approach

If you're manually calling workflow_next, just remember:

```jsonc
{
  "workflowId": "...",
  "completedSteps": [...],
  "context": {
    // Only 3-5 fields max!
    "currentStep": {...},
    "stepIndex": 1,
    "stepIteration": 2,
    "yourNewData": "..."
  }
}
```

## Validation Check

Before sending, ask yourself:
- Is my context < 5KB? 
- Did I remove all arrays I didn't modify?   
- Did I remove all `_` fields? 
- Am I only sending what I changed? 

If yes to all, you're doing it right!
