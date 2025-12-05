# Advanced Features

WorkRail includes advanced features for complex workflow scenarios.

## Loops & Iteration

WorkRail supports four loop types for iterative workflows:

| Type | Use Case |
|------|----------|
| `for` | Fixed number of iterations |
| `forEach` | Iterate over a collection |
| `while` | Continue while condition is true |
| `until` | Continue until condition becomes true |

**Example:**

```json
{
  "id": "process-items",
  "type": "loop",
  "loop": {
    "type": "forEach",
    "items": "dataItems",
    "maxIterations": 100
  },
  "body": "process-single-item"
}
```

**Full documentation:** [Loop Support](features/loops.md)

---

## Conditional Steps

Skip or include steps based on context variables:

```json
{
  "id": "deep-analysis",
  "title": "Deep Analysis",
  "prompt": "...",
  "runCondition": {
    "and": [
      { "var": "complexity", "equals": "high" },
      { "var": "hasArchitecturalChanges", "equals": true }
    ]
  }
}
```

**Supported operators:** `equals`, `not_equals`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`

**Full documentation:** [Workflow Authoring Guide](authoring.md#conditional-steps)

---

## External Workflow Repositories

Load workflows from Git repositories:

```bash
WORKFLOW_GIT_REPOS=https://github.com/team/workflows.git
```

Supports:

- Multiple repositories
- Authentication (GitHub, GitLab, Bitbucket, SSH)
- Auto-sync with configurable intervals
- Priority-based override

**Full documentation:** [External Workflow Repositories](features/external-workflow-repositories.md)

---

## Loop Optimization

WorkRail automatically optimizes loop execution:

- **Progressive disclosure**: 60-80% smaller context after first iteration
- **Function DSL**: Define reusable functions to reduce duplication
- **Empty loop detection**: Automatically skip empty loops

```json
{
  "functionDefinitions": [
    {
      "name": "processItem",
      "definition": "Validates and transforms item data"
    }
  ]
}
```

**Full documentation:** [Loop Optimization Guide](features/loop-optimization.md)

---

## Validation Criteria

Add validation rules to steps:

```json
{
  "id": "create-plan",
  "title": "Create Plan",
  "prompt": "Create a detailed implementation plan",
  "validationCriteria": {
    "outputLength": { "min": 200, "max": 2000 },
    "mustContain": ["objectives", "steps", "risks"]
  }
}
```

---

## Context Size Management

WorkRail monitors context size to prevent memory issues:

- Automatic warnings when context grows large
- Context optimization for loops
- Safety limits for iteration counts

---

## metaGuidance

Embed persistent best practices that apply throughout the workflow:

```json
{
  "metaGuidance": [
    "Always verify understanding before implementing",
    "One task at a time - never combine unrelated changes",
    "Write tests for all new functionality",
    "Follow existing code patterns and conventions"
  ]
}
```

These are shown to the agent throughout execution, not just at the start.

---

## Function Definitions

Define reusable instructions that can be referenced across steps:

```json
{
  "functionDefinitions": [
    {
      "name": "updateDecisionLog",
      "definition": "Update the Decision Log with: file paths, key findings, why they matter."
    },
    {
      "name": "verifyImplementation",
      "definition": "1) Run tests 2) Check coverage >80% 3) Self-review"
    }
  ],
  "steps": [
    {
      "prompt": "After analysis, use updateDecisionLog() to record findings."
    }
  ]
}
```

---

## Workflow Complexity Adaptation

Workflows can adapt based on assessed complexity:

```json
{
  "steps": [
    {
      "id": "triage",
      "title": "Assess Complexity",
      "prompt": "Evaluate: Small (1-2 files), Medium (multi-file), or Large (architectural). Set taskComplexity variable."
    },
    {
      "id": "quick-path",
      "runCondition": { "var": "taskComplexity", "equals": "Small" },
      "title": "Quick Implementation",
      "prompt": "Implement directly with minimal ceremony..."
    },
    {
      "id": "full-analysis",
      "runCondition": { "var": "taskComplexity", "not_equals": "Small" },
      "title": "Full Analysis",
      "prompt": "Perform detailed codebase analysis..."
    }
  ]
}
```

---

## CLI Commands

```bash
# List all workflows
workrail list

# Validate a workflow file
workrail validate workflow.json

# Get the JSON schema
workrail schema

# Initialize user workflow directory
workrail init
```

---

## Debugging

Enable verbose logging to troubleshoot issues:

```bash
WORKRAIL_LOG_LEVEL=DEBUG npx @exaudeus/workrail
```

**Log levels:** `DEBUG`, `INFO`, `WARN`, `ERROR`, `SILENT` (default)

---

## See Also

- [Loop Support](features/loops.md) – Complete loop documentation
- [Loop Optimization](features/loop-optimization.md) – Performance optimization
- [Loop Validation Best Practices](features/loop-validation-best-practices.md) – Validation patterns
- [External Repositories](features/external-workflow-repositories.md) – Git integration
- [Workflow Authoring](authoring.md) – Creating workflows
- [Configuration](configuration.md) – Environment variables
