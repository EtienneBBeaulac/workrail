# Workflow Authoring Guide

Create custom workflows to guide AI agents through your team's processes.

---

## WorkRail v2 authoring (conceptual)

> **Draft / design notes (not implemented yet).**
>
> This section captures the **v2 direction** for workflow authoring. It is intentionally conceptual and may change.
> If you are authoring workflows for the current shipped system, use the rest of this document.
>
> See also:
> - `docs/reference/workflow-execution-contract.md`
> - `docs/adrs/006-append-only-session-run-event-log.md`
> - `docs/adrs/007-resume-and-checkpoint-only-sessions.md`

WorkRail v2 aims to keep workflow authoring **as simple as possible** while making execution **deterministic, rewind-safe, and resumable**.

### JSON-first authoring

WorkRail v2 uses **JSON** as the canonical authoring format. DSL and YAML remain possible future input formats, but for v2 we optimize for determinism and simple validation.

Workflows are hashed based on their **compiled canonical model** (after templates/features/contracts are expanded), not raw text, so the hash remains stable and deterministic.

### Authoring primitives (v2)

WorkRail v2 introduces several primitives for expressive workflows:

- **Capabilities** (workflow-global): declare optional agent capabilities like `delegation` or `web_browsing` (required/preferred).
- **Features** (compiler middleware): mostly toggle IDs; a small subset supports typed config objects (`{id, config}`).
- **Templates**: reusable step sequences, called explicitly via `type: "template_call"`.
- **Contract packs**: WorkRail-owned output schemas for structured artifacts (e.g., `wr.contracts.capability_observation`).
- **PromptBlocks** (optional): structure step prompts as blocks (goal/constraints/procedure/outputRequired/verify) which compile to deterministic text.
- **AgentRole**: workflow and/or step-level stance/persona (not system prompt control).

For detailed JSON syntax and examples, see: `docs/design/workflow-authoring-v2.md`.

### Baseline (Tier 0): notes-first

- **You can write workflows with no special authoring features.**
- The default durable output is a short recap in `output.notesMarkdown` (recorded by the agent when advancing or checkpointing).
- Structured artifacts are **optional** and must never be required for a workflow to be usable.

### Builtins (no user-defined plugins)

WorkRail v2 provides **built-in** building blocks that workflows (including external workflows) can reference:

- **Templates**: pre-built steps (or step sequences) authors can “call” to speed up authoring and ensure consistency.
- **Features**: deterministic, closed-set “middleware” applied by WorkRail (e.g., tier-aware instructions, formatting, durable recap guidance).
- **Contract packs**: server-side definitions for allowed artifact kinds and small examples (no schema authoring required by workflow authors).

External workflows can reference these builtins, but cannot define arbitrary new plugin code.

### Where injections happen: templates as anchors

When something needs to be injected at a specific point (“run an audit here”, “insert a standard gate here”), **template references are the primary anchor**:

- Explicit at the callsite (less hidden magic).
- Deterministic and debuggable.
- Avoids tag-taxonomy sprawl.

Tags can still exist as optional **classification** metadata (for UI organization and search), but should not be the primary injection mechanism.

### Step identity and provenance

To keep authoring simple:

- Author step IDs remain the primary, stable identifiers (what agents see as `pending.stepId`).
- Template-expanded/internal step IDs are **reserved/internal** and carry provenance (what injected them, where, and why).
- By default, injected steps should be **collapsed** for agent UX; provenance exists for debugging/auditing and advanced views.

### Versioning and determinism

- The canonical pin is a **content hash** of the **fully expanded compiled workflow** (including template expansions, feature application, and contract pack selection), not a human-maintained `version` string.
- Human `version` fields may exist as labels, but should not be the source of truth for determinism.

### Debugging and auditing

WorkRail v2 treats debugging/auditing as first-class:

- WorkRail should record a bounded “decision trace” (why a step was selected/skipped, loop decisions, fork detection) as durable data.
- Dashboards and exports can surface this trace for post-mortems without requiring the agent to carry debugging internals in chat.
- “Cognitive audits” (subagent auditor model) are supported via built-in templates/features, not bespoke author boilerplate.

---

## Quick Start

### 1. Create a Workflow File

Create a JSON file in `~/.workrail/workflows/`:

```json
{
  "id": "my-workflow",
  "name": "My Custom Workflow",
  "version": "1.0.0",
  "description": "A workflow for my specific process",
  "steps": [
    {
      "id": "step-1",
      "title": "First Step",
      "prompt": "Instructions for what to do in this step.",
      "agentRole": "You are a helpful assistant focused on this task."
    },
    {
      "id": "step-2",
      "title": "Second Step",
      "prompt": "Instructions for the second step.",
      "agentRole": "You are continuing the previous work."
    }
  ]
}
```

### 2. Validate It

```bash
workrail validate ~/.workrail/workflows/my-workflow.json
```

### 3. Use It

Tell your AI agent:

> "Use the my-workflow workflow to help me with this task"

---

## Workflow Schema

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (lowercase, hyphens, no spaces) |
| `name` | string | Human-readable name |
| `version` | string | Semantic version (e.g., "1.0.0") |
| `description` | string | What this workflow accomplishes |
| `steps` | array | List of workflow steps (minimum 1) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `preconditions` | string[] | Prerequisites before starting |
| `clarificationPrompts` | string[] | Questions to ask upfront |
| `metaGuidance` | string[] | Persistent best practices shown throughout |

### Example with All Fields

```json
{
  "id": "code-review",
  "name": "Team Code Review Process",
  "version": "1.0.0",
  "description": "Systematic code review following our team standards",
  
  "preconditions": [
    "MR/PR is ready for review",
    "All CI checks have passed",
    "Self-review has been completed by the author"
  ],
  
  "clarificationPrompts": [
    "What is the scope of this change?",
    "Are there any areas of particular concern?",
    "What is the testing strategy?"
  ],
  
  "metaGuidance": [
    "Focus on correctness and maintainability over style",
    "Provide actionable feedback with examples",
    "Consider security implications of all changes"
  ],
  
  "steps": []
}
```

Note: `steps` is shown as an empty array here for brevity.

---

## Step Schema

### Required Step Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique step identifier |
| `title` | string | Human-readable step name |
| `prompt` | string | Instructions for the AI agent |

### Optional Step Fields

| Field | Type | Description |
|-------|------|-------------|
| `agentRole` | string | Persona/role for the agent (10-1024 chars) |
| `guidance` | string[] | Additional tips for this step |
| `askForFiles` | boolean | Request file context from user |
| `requireConfirmation` | boolean | Pause for user approval |
| `runCondition` | object | Conditional execution logic |

### Example Step

```json
{
  "id": "security-review",
  "title": "Security Assessment",
  "prompt": "Review the code changes for security vulnerabilities:\n\n1. Check for injection risks (SQL, XSS, command)\n2. Verify authentication and authorization\n3. Look for sensitive data exposure\n4. Check for insecure dependencies\n\nDocument any findings with severity levels.",
  "agentRole": "You are a security-focused code reviewer with expertise in OWASP Top 10 vulnerabilities.",
  "guidance": [
    "Pay special attention to user input handling",
    "Check for hardcoded secrets or credentials",
    "Verify that error messages don't leak sensitive information"
  ],
  "requireConfirmation": true
}
```

---

## Conditional Steps

Use `runCondition` to skip steps based on context variables.

### Simple Condition

```json
{
  "id": "deep-analysis",
  "title": "Deep Architecture Analysis",
  "prompt": "Perform detailed architectural review...",
  "runCondition": {
    "var": "complexity",
    "equals": "high"
  }
}
```

### Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `equals` | Equal to | `{ "var": "x", "equals": "value" }` |
| `not_equals` | Not equal to | `{ "var": "x", "not_equals": "value" }` |
| `gt` | Greater than | `{ "var": "x", "gt": 5 }` |
| `gte` | Greater than or equal | `{ "var": "x", "gte": 5 }` |
| `lt` | Less than | `{ "var": "x", "lt": 10 }` |
| `lte` | Less than or equal | `{ "var": "x", "lte": 10 }` |

### Logical Operators

**AND:**

```json
{
  "runCondition": {
    "and": [
      { "var": "complexity", "equals": "high" },
      { "var": "hasTests", "equals": false }
    ]
  }
}
```

**OR:**

```json
{
  "runCondition": {
    "or": [
      { "var": "type", "equals": "feature" },
      { "var": "type", "equals": "refactor" }
    ]
  }
}
```

**NOT:**

```json
{
  "runCondition": {
    "not": { "var": "skipAnalysis", "equals": true }
  }
}
```

---

## Loops

Iterate over steps for batch operations, retries, or refinement.

### For Loop (Fixed Count)

```json
{
  "id": "implement-features",
  "type": "loop",
  "title": "Implement Each Feature",
  "loop": {
    "type": "for",
    "count": 3,
    "maxIterations": 5,
    "iterationVar": "featureNumber"
  },
  "body": "implement-single-feature"
}
```

### ForEach Loop (Over Items)

```json
{
  "id": "review-files",
  "type": "loop",
  "title": "Review Each Changed File",
  "loop": {
    "type": "forEach",
    "items": "changedFiles",
    "itemVar": "currentFile",
    "indexVar": "fileIndex",
    "maxIterations": 50
  },
  "body": [
    {
      "id": "review-file",
      "title": "Review {{currentFile}}",
      "prompt": "Review the file {{currentFile}} for issues..."
    }
  ]
}
```

### While Loop (Condition-Based)

```json
{
  "id": "refine-solution",
  "type": "loop",
  "title": "Refine Until Satisfactory",
  "loop": {
    "type": "while",
    "condition": { "var": "needsRefinement", "equals": true },
    "maxIterations": 5
  },
  "body": "refinement-step"
}
```

### Until Loop

```json
{
  "id": "search-root-cause",
  "type": "loop",
  "title": "Search Until Found",
  "loop": {
    "type": "until",
    "condition": { "var": "rootCauseFound", "equals": true },
    "maxIterations": 10
  },
  "body": "investigate-hypothesis"
}
```

**Important:** Always set `maxIterations` to prevent infinite loops.

For detailed loop documentation, see [Loop Support](features/loops.md).

---

## Best Practices

### 1. Keep Steps Atomic

Each step should be:

- **Completable** independently
- **Testable** with clear success criteria
- **Committable** as a logical unit

**Bad - Too large:**

```json
{
  "title": "Implement everything",
  "prompt": "Build the entire authentication system"
}
```

**Good - Focused:**

```json
{
  "title": "Create User Model",
  "prompt": "Create a User model with email and password fields"
}
```

### 2. Write Clear Prompts

Be specific about what to do:

**Bad - Vague:**

```json
{
  "prompt": "Review the code"
}
```

**Good - Specific:**

```json
{
  "prompt": "Review the authentication code for:\n1. Input validation\n2. Error handling\n3. Security vulnerabilities\n\nDocument findings with severity (Critical/High/Medium/Low)."
}
```

### 3. Use agentRole Effectively

Set the right persona for the task:

```json
{
  "agentRole": "You are a senior security engineer performing a thorough code audit. You are methodical, skeptical, and document everything."
}
```

### 4. Add Verification Steps

Include steps to verify work:

```json
{
  "id": "verify-implementation",
  "title": "Verify Changes",
  "prompt": "Verify the implementation:\n1. Run tests\n2. Check for regressions\n3. Validate against requirements",
  "requireConfirmation": true
}
```

### 5. Use Preconditions

Catch missing context early:

```json
{
  "preconditions": [
    "Task requirements are documented",
    "Codebase access is available",
    "Test environment is set up"
  ]
}
```

### 6. Add metaGuidance

Embed best practices that apply throughout:

```json
{
  "metaGuidance": [
    "Always verify understanding before implementing",
    "One task at a time - never combine unrelated changes",
    "Write tests for all new functionality"
  ]
}
```

---

## Workflow Patterns

### Pattern: prep/implement/verify

Structure steps around understanding, doing, and checking:

```json
{
  "steps": [
    {
      "id": "understand",
      "title": "Understand Requirements",
      "prompt": "Analyze the requirements and clarify any ambiguities..."
    },
    {
      "id": "plan",
      "title": "Create Plan",
      "prompt": "Create a detailed implementation plan...",
      "requireConfirmation": true
    },
    {
      "id": "implement",
      "title": "Implement Solution",
      "prompt": "Implement according to the plan..."
    },
    {
      "id": "verify",
      "title": "Verify Implementation",
      "prompt": "Verify the implementation meets requirements..."
    }
  ]
}
```

### Pattern: Complexity Triage

Use conditions to adapt based on complexity:

```json
{
  "steps": [
    {
      "id": "triage",
      "title": "Assess Complexity",
      "prompt": "Evaluate task complexity (simple/medium/complex) and set the complexity variable."
    },
    {
      "id": "quick-path",
      "title": "Quick Implementation",
      "prompt": "Implement directly...",
      "runCondition": { "var": "complexity", "equals": "simple" }
    },
    {
      "id": "full-analysis",
      "title": "Full Analysis",
      "prompt": "Perform detailed analysis...",
      "runCondition": { "var": "complexity", "not_equals": "simple" }
    }
  ]
}
```

### Pattern: Iterative Refinement

Use loops for refinement cycles:

```json
{
  "id": "refine-loop",
  "type": "loop",
  "title": "Iterative Refinement",
  "loop": {
    "type": "for",
    "count": 3,
    "maxIterations": 3,
    "iterationVar": "iteration"
  },
  "body": [
    {
      "id": "review",
      "title": "Review (Iteration {{iteration}})",
      "prompt": "Review the current solution and identify improvements..."
    },
    {
      "id": "improve",
      "title": "Apply Improvements",
      "prompt": "Apply the identified improvements..."
    }
  ]
}
```

---

## Testing Workflows

### Validate JSON

```bash
workrail validate my-workflow.json
```

### Dry Run

Walk through your workflow manually:

1. Can each step be completed with the information provided?
2. Are there hidden dependencies between steps?
3. Do the prompts make sense in sequence?

### Test with Different Scenarios

- Simple case: Does it work for straightforward inputs?
- Edge cases: What happens with unusual inputs?
- Error cases: How does it handle failures?

---

## Sharing Workflows

### Team Repository

Create a Git repository with your workflows:

```
team-workflows/
├── workflows/
│   ├── code-review.json
│   ├── incident-response.json
│   └── onboarding.json
└── README.md
```

Configure WorkRail to load from it:

```bash
WORKFLOW_GIT_REPOS=https://github.com/yourteam/workflows.git
```

See [Configuration](configuration.md#git-repositories) for details.

### Local Sharing

Copy workflow files to team members' `~/.workrail/workflows/` directories.

---

## See Also

- [All Workflows](workflows.md) – Browse existing workflows for inspiration
- [Configuration](configuration.md) – Set up workflow sources
- [Loop Documentation](features/loops.md) – Detailed loop patterns
- [Advanced Features](advanced.md) – Validation, optimization
