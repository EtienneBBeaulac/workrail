# Loop Validation Best Practices

This document describes the enhanced loop validation features in WorkRail and provides best practices for creating maintainable loop workflows.

## Overview

WorkRail includes enhanced validation for loop steps that goes beyond basic syntax checking. It helps you identify potential issues with complex conditional logic, excessive prompt lengths, undefined variables, and provides guidance on best practices.

## Validation Categories

### 1. Conditional Logic Complexity

**What it checks:**
- Complex ternary operators (2 or more `?` operators)
- Nested ternary operators
- Multi-path conditionals in prompts

**Why it matters:**
- Complex conditionals are hard to read and maintain
- Template variables may not resolve properly
- All conditional branches may be included in the output

**Best practice:**
Instead of inline conditionals:
```json
{
  "prompt": "{{iteration === 1 ? 'First step' : iteration === 2 ? 'Second step' : 'Third step'}}"
}
```

Use separate steps with `runCondition`:
```json
[
  {
    "id": "step-1",
    "prompt": "First step",
    "runCondition": {"var": "iteration", "equals": 1}
  },
  {
    "id": "step-2", 
    "prompt": "Second step",
    "runCondition": {"var": "iteration", "equals": 2}
  },
  {
    "id": "step-3",
    "prompt": "Third step", 
    "runCondition": {"var": "iteration", "equals": 3}
  }
]
```

### 2. Prompt Length Validation

**What it checks:**
- Raw prompt length approaching 1500-2000 character limits
- Total conditional content size when expanded

**Why it matters:**
- Long prompts can exceed system limits
- Conditional expansion can make prompts even larger
- Large prompts reduce readability and maintainability

**Best practice:**
- Keep prompts focused and under 1000 characters
- Move detailed instructions to the `guidance` array
- Split complex prompts into multiple steps

### 3. Template Variable Usage

**What it checks:**
- Undefined variables in prompts, titles, and agent roles
- Proper use of loop iteration variables

**Available loop variables:**
- For all loops: `iteration` (or custom `iterationVar`)
- For `forEach` loops: `item` (or custom `itemVar`), `index` (or custom `indexVar`)
- Context variables defined elsewhere in the workflow

**Best practice:**
- Always verify variables are defined before use
- Use descriptive custom variable names
- Document expected context variables

### 4. Loop Structure

**What it checks:**
- Reasonable `maxIterations` limits
- Appropriate loop types for use cases
- Common loop patterns

**Best practice:**
- Set `maxIterations` to prevent infinite loops (typically < 100)
- Use `for` loops for fixed iterations
- Use `while`/`until` for condition-based loops
- Use `forEach` for processing arrays

## Common Patterns

### Progressive Analysis Pattern

Detected when loops perform step-by-step analysis (e.g., Structure → Modules → Dependencies → Patterns).

**Recommendation:** Use separate steps with `runCondition` for clarity.

### Multi-Path Pattern

Detected when loops have multiple conditional execution paths.

**Recommendation:** Refactor to separate steps for better maintainability.

## Example: Well-Structured Loop

```json
{
  "id": "analysis-loop",
  "type": "loop",
  "loop": {
    "type": "for",
    "count": 4,
    "maxIterations": 4,
    "iterationVar": "analysisStep"
  },
  "body": [
    {
      "id": "step-structure",
      "title": "Structural Analysis",
      "prompt": "Analyze the codebase structure...",
      "runCondition": {"var": "analysisStep", "equals": 1}
    },
    {
      "id": "step-modules",
      "title": "Module Analysis",
      "prompt": "Analyze task-relevant modules...",
      "runCondition": {"var": "analysisStep", "equals": 2}
    },
    {
      "id": "step-dependencies",
      "title": "Dependency Analysis",
      "prompt": "Trace dependencies and flows...",
      "runCondition": {"var": "analysisStep", "equals": 3}
    },
    {
      "id": "step-patterns",
      "title": "Pattern Discovery",
      "prompt": "Identify established patterns...",
      "runCondition": {"var": "analysisStep", "equals": 4}
    }
  ]
}
```

## CLI Validation

Run validation to see warnings and suggestions:

```bash
workrail validate your-workflow.json
```

The validator will show:
- ❌ **Errors**: Must be fixed for the workflow to run
- ⚠️ **Warnings**: Should be addressed for better maintainability
- ℹ️ **Information**: Detected patterns and insights
- 💡 **Suggestions**: Recommendations for improvement

## Summary

Good loop design principles:
1. Keep logic simple and explicit
2. Use `runCondition` for multi-path flows
3. Keep prompts concise and focused
4. Define and document all variables
5. Set reasonable iteration limits
6. Test thoroughly with validation

Following these practices will result in workflows that are easier to understand, maintain, and debug.