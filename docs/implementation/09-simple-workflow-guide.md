# Simple Workflow Creation Guide

> 📝 **A guide to creating simple, single-file workflows**

[![Status](https://img.shields.io/badge/status-specification-orange.svg)](https://github.com/EtienneBBeaulac/mcp)
[![Spec Version](https://img.shields.io/badge/spec-1.0.0-blue.svg)](specs/)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.org)

## 📋 Table of Contents

1. [Getting Started with Workflows](#getting-started-with-workflows)
2. [Creating Your First Workflow](#creating-your-first-workflow)
3. [Workflow Design Basics](#workflow-design-basics)
   - [Function Reference Pattern (Advanced)](#function-reference-pattern-advanced)
4. [Testing Your Workflow](#testing-your-workflow)
5. [Common Mistakes to Avoid](#common-mistakes-to-avoid)
6. [Examples](#examples)

---

## Getting Started with Workflows

### What is a Workflow?

A workflow is a structured sequence of steps that guides an AI agent through a development task. Think of it as a recipe that helps the AI follow best practices and avoid common pitfalls.

### How to Read the Existing Example

Let's look at the authentication workflow example:

```json
{
  "id": "simple-auth-implementation",
  "name": "Simple Authentication Implementation",
  "description": "Implement basic JWT authentication for a REST API with user login and token validation",
  "preconditions": [
    "User model exists in the database",
    "JWT library is installed in the project",
    "Environment variables for JWT_SECRET are configured"
  ],
  "clarificationPrompts": [
    "What is the token expiration time you want to use?",
    "Should the authentication support refresh tokens?",
    "Do you need role-based access control?"
  ],
  "steps": [
    {
      "id": "analyze-current-auth",
      "title": "Analyze current authentication setup",
      "prompt": "Examine the existing authentication implementation if any. Look for: user model structure, existing auth middleware, login endpoints. Document what you find.",
      "requireConfirmation": true
    }
  ],
  "metaGuidance": [
    "Always hash passwords using bcrypt or similar",
    "Include proper error messages for debugging",
    "Follow RESTful conventions for endpoints",
    "Add rate limiting to prevent brute force attacks"
  ]
}
```

**Key Parts:**
- **`id`**: Unique identifier (use kebab-case)
- **`name`**: Human-friendly title
- **`description`**: What the workflow accomplishes
- **`preconditions`**: What must be true before starting
- **`clarificationPrompts`**: Questions to ask upfront
- **`steps`**: The actual workflow steps
- **`metaGuidance`**: Best practices that apply throughout

**Available in current release:**
- **`runCondition`**: Optional condition on steps for "choose your own adventure" workflows
- **`agentRole`**: Optional agent behavioral instructions (separate from user-facing prompts)

---

## Creating Your First Workflow

### Step 1: Start with a Template

Copy the authentication example and modify it for your needs:

```json
{
  "id": "your-workflow-id",
  "name": "Your Workflow Name",
  "description": "What your workflow accomplishes",
  "preconditions": [
    "Prerequisite 1",
    "Prerequisite 2"
  ],
  "clarificationPrompts": [
    "Question 1?",
    "Question 2?"
  ],
  "steps": [
    {
      "id": "step-1",
      "title": "First Step",
      "prompt": "What to do in this step",
      "agentRole": "Optional: specific behavioral guidance for the AI agent",
      "requireConfirmation": true
    }
  ],
  "metaGuidance": [
    "Best practice 1",
    "Best practice 2"
  ]
}
```

### Step 2: Define Your Steps

Each step should follow the **prep/implement/verify** pattern:

```json
{
  "id": "implement-feature",
  "title": "Implement the feature",
  "prompt": "**PREP**: First, understand the current state and requirements.\n\n**IMPLEMENT**: Make the necessary changes following the plan.\n\n**VERIFY**: Test your changes and ensure they work correctly.",
  "requireConfirmation": true
}
```

### Step 3: Add Clarification Prompts

Ask questions that help clarify requirements:

```json
"clarificationPrompts": [
  "What is the main goal of this feature?",
  "Are there any specific constraints or requirements?",
  "Which files are most likely to be affected?"
]
```

---

## Workflow Design Basics

### The prep/implement/verify Pattern

This pattern helps ensure quality by breaking each step into three phases:

1. **PREP**: Understand the current state and requirements
2. **IMPLEMENT**: Make focused, specific changes
3. **VERIFY**: Test and validate the changes

**Example:**
```json
{
  "id": "add-user-validation",
  "title": "Add user input validation",
  "prompt": "**PREP**: Examine the current user input handling and identify validation gaps.\n\n**IMPLEMENT**: Add appropriate validation rules for user inputs.\n\n**VERIFY**: Test with various input scenarios to ensure validation works correctly.",
  "requireConfirmation": true
}
```

### When to Use `requireConfirmation`

Use `requireConfirmation: true` when:
- The step makes significant changes
- User approval is needed before proceeding
- The step involves important decisions
- You want to pause for review

**Example:**
```json
{
  "id": "create-database-migration",
  "title": "Create database migration",
  "prompt": "Create a database migration for the new user fields.",
  "requireConfirmation": true
}
```

### When to Use `askForFiles`

Use `askForFiles: true` when:
- The step needs to examine specific files
- File context is important for the step
- You want to ensure the agent has the right files

**Example:**
```json
{
  "id": "review-existing-code",
  "title": "Review existing implementation",
  "prompt": "Examine the current implementation and identify areas for improvement.",
  "askForFiles": true
}
```

### When to Use `runCondition`

Use `runCondition` when:
- Different steps should execute based on task scope or complexity
- You want "choose your own adventure" style workflows
- Steps should be skipped based on user expertise or preferences
- Conditional logic is needed for different scenarios

**Example:**
```json
{
  "id": "advanced-optimization",
  "title": "Advanced performance optimization",
  "prompt": "Implement advanced caching and optimization strategies.",
  "runCondition": {
    "and": [
      {"var": "taskScope", "equals": "large"},
      {"var": "userExpertise", "equals": "expert"}
    ]
  }
}
```

**Supported condition operators:**
- `equals`, `not_equals`: Value comparison
- `gt`, `gte`, `lt`, `lte`: Numeric comparison
- `and`, `or`, `not`: Logical operations

### When to Use `agentRole`

Use `agentRole` when:
- You want to provide specific behavioral guidance to the AI agent
- The agent needs role-specific expertise (security expert, code reviewer, etc.)
- You want to separate agent instructions from user-facing content
- Different steps require different agent personas or expertise

**Example:**
```json
{
  "id": "security-review",
  "title": "Security Code Review",
  "prompt": "Please review the provided code for security issues.",
  "agentRole": "You are a cybersecurity expert specializing in code security. Focus on identifying vulnerabilities like SQL injection, XSS, authentication bypasses, and data exposure. Provide specific remediation steps for any issues found.",
  "askForFiles": true
}
```

**Best Practices for agentRole:**
- Be specific about the agent's expertise and focus areas
- Include what the agent should look for or prioritize
- Mention the expected output format or approach
- Keep it separate from user-facing instructions in the prompt

### Writing Good Prompts

**Good Prompt:**
```json
{
  "prompt": "**PREP**: Analyze the current authentication system and identify security gaps.\n\n**IMPLEMENT**: Add input validation and sanitization to prevent common attacks.\n\n**VERIFY**: Test with malicious inputs to ensure security measures work."
}
```

**Bad Prompt:**
```json
{
  "prompt": "Fix the authentication system"
}
```

**Why the first is better:**
- Clear structure with prep/implement/verify
- Specific instructions
- Includes validation criteria
- Follows the pattern consistently

### Function Reference Pattern (Advanced)

For complex workflows with repeated instructions, you can use a **function reference pattern** to reduce duplication and improve maintainability. This creates a pseudo-DSL (Domain Specific Language) within your workflow.

#### How It Works

Define reusable "functions" in your `metaGuidance` section, then reference them throughout your workflow:

**Example Function Definitions:**
```json
{
  "metaGuidance": [
    "fun updateDecisionLog() = 'Update Decision Log in CONTEXT.md: file paths/ranges, excerpts, why important, outcome impact. Limit 3-5 files/decision.'",
    "fun useTools() = 'Use tools to verify—never guess. Expand file reads to imports/models/interfaces/classes/deps. Trace all dependencies.'",
    "fun createFile(filename) = 'Use edit_file to create/update {filename}. NEVER output full content in chat—only summarize. If fails, request user help & log command.'",
    "fun applyUserRules() = 'Apply & reference user-defined rules, patterns & preferences. Document alignment in Decision Log. Explain rule influence in decisions.'",
    "fun matchPatterns() = 'Use codebase_search/grep to find similar patterns. Reference Decision Log patterns. Match target area unless user rules override.'",
    "fun gitCommit(type, msg) = 'If git available: commit with {type}: {msg}. If unavailable: log in CONTEXT.md with timestamp.'",
    "When you see function calls like updateDecisionLog() or createFile(spec.md), refer to the function definitions above for full instructions."
  ]
}
```

**Example Usage in Steps:**
```json
{
  "id": "create-specification",
  "title": "Create Technical Specification",
  "prompt": "Create a detailed technical specification from the analysis.\n\n**Requirements:**\n- Include existing patterns/conventions from analysis\n- System integration approach\n- applyUserRules() throughout\n- matchPatterns() from codebase\n\n**Actions:**\n- createFile(spec.md)\n- updateDecisionLog()\n- Sanity check complexity level"
}
```

#### Benefits of Function References

1. **Significant deduplication**: Each instruction appears only once
2. **Improved consistency**: Same wording used everywhere  
3. **Better readability**: Prompts become more scannable
4. **Easier maintenance**: Update function definition once, applies everywhere
5. **Context savings**: Reduces file size by 15-20% while maintaining detail

#### Implementation Tips

- **Function Naming**: Use clear, descriptive names like `updateDecisionLog()` or `createFile(filename)`
- **Parameter Support**: Simple parameter substitution works: `createFile(spec.md)` becomes instructions for "spec.md"
- **Resumption Support**: Include function definitions in CONTEXT.md for workflow resumption
- **Documentation**: Always include the interpretation instruction in metaGuidance

#### When to Use This Pattern

✅ **Good for:**
- Complex workflows with repeated instructions
- Workflows with >10 steps that share common patterns
- Team workflows where consistency is crucial
- Workflows that need detailed instructions but have character limits

❌ **Avoid for:**
- Simple workflows with few steps
- One-off workflows that won't be maintained
- Workflows where explicit instructions are clearer

#### Character Limits and Validation

Remember that metaGuidance items have a 256-character limit in the schema. Keep function definitions concise:

```json
// ✅ Good - under 256 characters
"fun updateDecisionLog() = 'Update Decision Log: file paths, why important, outcome impact. Limit 3-5 files.'"

// ❌ Too long - over 256 characters
"fun updateDecisionLog() = 'Update the Decision Log section in CONTEXT.md with detailed file paths and line ranges, excerpts showing why each file was important, and how they influenced the outcome and decision-making process throughout the workflow execution. Always limit to the top 3-5 most impactful files per decision for scannability and conciseness.'"
```

---

## Testing Your Workflow

### Step 1: Validate Against Schema

#### CLI Validation
Use the JSON schema to validate your workflow:

```bash
# Example validation (when tools are available)
npm run validate-workflow your-workflow.json
```

#### MCP Tool Validation
You can also validate workflow JSON directly through the MCP protocol:

```bash
# Example: Validate workflow JSON via MCP tool
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"workflow_validate_json","arguments":{"workflowJson":"{\"id\":\"my-workflow\",\"name\":\"My Workflow\",\"description\":\"A test workflow\",\"steps\":[{\"id\":\"step1\",\"title\":\"First Step\",\"prompt\":\"Do something\"}]}"}}}' | node dist/mcp-server.js
```

**When to use `workflow_validate_json`:**
- Building workflow editors or management tools
- Integrating validation into automated workflows
- Providing real-time validation feedback
- Validating programmatically generated workflows

**Benefits:**
- Comprehensive JSON syntax validation
- Schema compliance checking
- Actionable error messages with suggestions
- No external dependencies required

### Step 2: Basic Testing Checklist

- [ ] Does the workflow have a unique `id`?
- [ ] Is the `name` clear and descriptive?
- [ ] Does the `description` explain what it accomplishes?
- [ ] Are all required fields present?
- [ ] Do the steps follow the prep/implement/verify pattern?
- [ ] Are clarification prompts clear and relevant?
- [ ] Is metaGuidance helpful and specific?

### Step 3: Advanced Step Output Validation

The workflow system includes a powerful **ValidationEngine** that can validate step outputs using three enhancement types:

#### JSON Schema Validation
Validate structured output against a JSON schema:

```json
{
  "id": "create-user-api",
  "title": "Create user API endpoint",
  "prompt": "**PREP**: Design the API endpoint structure.\n\n**IMPLEMENT**: Create the endpoint with proper validation.\n\n**VERIFY**: Test the endpoint with various inputs.",
  "validationCriteria": [
    {
      "type": "schema",
      "schema": {
        "type": "object",
        "properties": {
          "endpoint": {"type": "string", "pattern": "^/api/users(/.*)?$"},
          "method": {"type": "string", "enum": ["POST", "PUT", "PATCH"]},
          "validation": {
            "type": "object",
            "properties": {
              "required": {"type": "array", "items": {"type": "string"}},
              "properties": {"type": "object"}
            },
            "required": ["required", "properties"]
          }
        },
        "required": ["endpoint", "method", "validation"]
      }
    }
  ]
}
```

#### Context-Aware Validation
Apply validation rules conditionally based on context:

```json
{
  "id": "database-migration",
  "title": "Create database migration",
  "prompt": "**PREP**: Analyze the database changes needed.\n\n**IMPLEMENT**: Create migration files.\n\n**VERIFY**: Test migration in development environment.",
  "validationCriteria": [
    {
      "type": "contains",
      "value": "CREATE TABLE",
      "condition": "context.migrationType === 'create'"
    },
    {
      "type": "contains", 
      "value": "ALTER TABLE",
      "condition": "context.migrationType === 'modify'"
    },
    {
      "type": "regex",
      "pattern": "rollback|down|revert",
      "condition": "context.requiresRollback === true"
    }
  ]
}
```

#### Logical Composition Validation
Combine multiple validation rules with logical operators:

```json
{
  "id": "security-implementation",
  "title": "Implement security measures",
  "prompt": "**PREP**: Identify security requirements.\n\n**IMPLEMENT**: Add authentication and authorization.\n\n**VERIFY**: Test security measures thoroughly.",
  "validationCriteria": {
    "and": [
      {
        "or": [
          {"type": "contains", "value": "jwt"},
          {"type": "contains", "value": "session"}
        ]
      },
      {
        "type": "regex",
        "pattern": "\\b(authorize|permission|role)\\b"
      },
      {
        "not": {
          "type": "contains",
          "value": "password"
        }
      }
    ]
  }
}
```

### Step 4: Common Validation Errors

**Missing Required Fields:**
```json
// ❌ Missing required fields
{
  "name": "My Workflow"
  // Missing id, description, steps
}
```

**Invalid Step Structure:**
```json
// ❌ Invalid step
{
  "id": "step-1",
  "title": "My Step"
  // Missing required 'prompt' field
}
```

**Invalid ID Format:**
```json
// ❌ Invalid ID (contains spaces)
{
  "id": "my workflow",
  // Should be: "my-workflow"
}
```

**Invalid Validation Criteria:**
```json
// ❌ Invalid schema format
{
  "type": "schema",
  "schema": "not a valid schema object"
}

// ❌ Invalid condition syntax
{
  "type": "contains",
  "value": "test",
  "condition": "invalid javascript syntax"
}

// ❌ Missing logical operator
{
  "validationCriteria": {
    "invalidOperator": [
      {"type": "contains", "value": "test"}
    ]
  }
}
```

---

## Common Mistakes to Avoid

### 1. **Vague Prompts**
```json
// ❌ Too vague
{
  "prompt": "Fix the bug"
}

// ✅ Specific and structured
{
  "prompt": "**PREP**: Identify the root cause of the authentication bug.\n\n**IMPLEMENT**: Apply the fix with proper error handling.\n\n**VERIFY**: Test the fix with various scenarios."
}
```

### 2. **Missing Preconditions**
```json
// ❌ No preconditions
{
  "steps": [...]
}

// ✅ Clear preconditions
{
  "preconditions": [
    "Database is accessible",
    "Required libraries are installed",
    "Environment variables are configured"
  ]
}
```

### 3. **Poor Step Organization**
```json
// ❌ Steps not logically ordered
{
  "steps": [
    {"id": "test", "title": "Test the feature"},
    {"id": "implement", "title": "Implement the feature"},
    {"id": "plan", "title": "Plan the implementation"}
  ]
}

// ✅ Logical order
{
  "steps": [
    {"id": "plan", "title": "Plan the implementation"},
    {"id": "implement", "title": "Implement the feature"},
    {"id": "test", "title": "Test the feature"}
  ]
}
```

### 4. **Inconsistent Patterns**
```json
// ❌ Inconsistent pattern usage
{
  "steps": [
    {"id": "step1", "prompt": "PREP: Analyze... IMPLEMENT: Code... VERIFY: Test..."},
    {"id": "step2", "prompt": "Just do this thing"}
  ]
}

// ✅ Consistent pattern usage
{
  "steps": [
    {"id": "step1", "prompt": "PREP: Analyze... IMPLEMENT: Code... VERIFY: Test..."},
    {"id": "step2", "prompt": "PREP: Review... IMPLEMENT: Update... VERIFY: Validate..."}
  ]
}
```

---

## Examples

### Example 1: Feature Implementation Workflow

```json
{
  "id": "feature-implementation",
  "name": "Feature Implementation Workflow",
  "description": "Implement a new feature following best practices",
  "preconditions": [
    "Feature requirements are clear",
    "Codebase is accessible",
    "Development environment is set up"
  ],
  "clarificationPrompts": [
    "What is the main goal of this feature?",
    "Are there any specific constraints or requirements?",
    "Which parts of the codebase will be affected?"
  ],
  "steps": [
    {
      "id": "understand-requirements",
      "title": "Understand requirements and scope",
      "prompt": "**PREP**: Review the feature requirements and understand the scope.\n\n**IMPLEMENT**: Break down the requirements into specific tasks.\n\n**VERIFY**: Confirm understanding with stakeholders if needed.",
      "requireConfirmation": true
    },
    {
      "id": "plan-implementation",
      "title": "Plan the implementation",
      "prompt": "**PREP**: Analyze the codebase to understand the current architecture.\n\n**IMPLEMENT**: Create a detailed implementation plan with specific steps.\n\n**VERIFY**: Review the plan for completeness and feasibility.",
      "requireConfirmation": true
    },
    {
      "id": "implement-feature",
      "title": "Implement the feature",
      "prompt": "**PREP**: Set up the development environment and review the plan.\n\n**IMPLEMENT**: Write the code following the implementation plan.\n\n**VERIFY**: Test the implementation and ensure it meets requirements.",
      "askForFiles": true,
      "validationCriteria": [
        {
          "type": "contains",
          "value": "function",
          "condition": "context.language === 'javascript'"
        },
        {
          "type": "contains",
          "value": "def ",
          "condition": "context.language === 'python'"
        },
        {
          "type": "regex",
          "pattern": "\\b(test|spec)\\b"
        }
      ]
    },
    {
      "id": "test-and-validate",
      "title": "Test and validate the feature",
      "prompt": "**PREP**: Review the implementation and identify test scenarios.\n\n**IMPLEMENT**: Write comprehensive tests for the feature.\n\n**VERIFY**: Run tests and validate the feature works correctly.",
      "requireConfirmation": true,
      "validationCriteria": {
        "and": [
          {
            "or": [
              {"type": "contains", "value": "describe"},
              {"type": "contains", "value": "test"}
            ]
          },
          {
            "type": "regex",
            "pattern": "\\b(expect|assert|should)\\b"
          },
          {
            "type": "length",
            "min": 100,
            "condition": "context.testCoverage === 'comprehensive'"
          }
        ]
      }
    }
  ],
  "metaGuidance": [
    "Always follow the prep/implement/verify pattern",
    "Write clear, readable code with good comments",
    "Include proper error handling",
    "Add tests for new functionality",
    "Follow existing code conventions"
  ]
}
```

### Example 2: Bug Fix Workflow

```json
{
  "id": "bug-fix-workflow",
  "name": "Bug Fix Workflow",
  "description": "Systematically identify and fix bugs",
  "preconditions": [
    "Bug report is clear and reproducible",
    "Development environment is set up",
    "Access to relevant code and logs"
  ],
  "clarificationPrompts": [
    "What is the expected behavior?",
    "What is the actual behavior?",
    "Can you reproduce the bug consistently?",
    "What steps lead to the bug?"
  ],
  "steps": [
    {
      "id": "reproduce-bug",
      "title": "Reproduce the bug",
      "prompt": "**PREP**: Understand the bug report and required environment.\n\n**IMPLEMENT**: Follow the steps to reproduce the bug.\n\n**VERIFY**: Confirm the bug occurs consistently.",
      "requireConfirmation": true
    },
    {
      "id": "identify-root-cause",
      "title": "Identify the root cause",
      "prompt": "**PREP**: Examine the code and logs related to the bug.\n\n**IMPLEMENT**: Trace through the code to find the root cause.\n\n**VERIFY**: Confirm the identified cause explains the bug behavior.",
      "askForFiles": true
    },
    {
      "id": "implement-fix",
      "title": "Implement the fix",
      "prompt": "**PREP**: Plan the fix based on the root cause analysis.\n\n**IMPLEMENT**: Apply the fix with minimal changes.\n\n**VERIFY**: Test that the fix resolves the bug without introducing new issues.",
      "requireConfirmation": true,
      "validationCriteria": [
        {
          "type": "contains",
          "value": "fix",
          "condition": "context.bugSeverity === 'high'"
        },
        {
          "type": "regex",
          "pattern": "\\b(error|exception|null|undefined)\\b"
        },
        {
          "not": {
            "type": "contains",
            "value": "TODO"
          }
        }
      ]
    },
    {
      "id": "test-fix",
      "title": "Test the fix",
      "prompt": "**PREP**: Identify test scenarios including edge cases.\n\n**IMPLEMENT**: Run comprehensive tests on the fix.\n\n**VERIFY**: Confirm the bug is fixed and no regressions are introduced.",
      "requireConfirmation": true
    }
  ],
  "metaGuidance": [
    "Always reproduce the bug before attempting to fix it",
    "Make minimal changes to fix the issue",
    "Test thoroughly to ensure no regressions",
    "Document the fix and root cause",
    "Consider adding tests to prevent future occurrences"
  ]
}
```

---

## Enhanced Example Workflows

The following example workflows in `spec/examples/` now demonstrate agentRole best practices:

### 1. Simple Authentication Implementation (`valid-workflow.json`)

This example showcases how to use agentRole for different security-focused roles:

- **Security-focused systems analyst** for authentication assessment
- **Senior backend engineer** for secure middleware development  
- **API development specialist** for authentication endpoints
- **Quality assurance engineer** for security testing

Each step demonstrates how agentRole provides specialized behavioral guidance while keeping user-facing prompts clear and focused.

### 2. Adaptive Development Workflow (`conditional-workflow-example.json`)

This advanced example demonstrates agentRole usage with conditional logic:

- **Project setup specialist** for environment configuration
- **Senior business analyst** for complex requirement analysis (large/complex tasks only)
- **Efficient developer** for simple implementations
- **Patient mentor** for novice users
- **Senior software engineer** for expert implementations
- **Performance engineering specialist** for optimization (complex tasks only)

The agentRole fields automatically adapt based on:
- User expertise level (`novice`, `intermediate`, `expert`)
- Task scope (`small`, `medium`, `large`) 
- Task complexity (0.1 to 1.0 scale)

### AgentRole Best Practices Demonstrated

1. **Role Specificity**: Each agentRole provides specific expertise and behavioral guidance
2. **Separation of Concerns**: Agent instructions are separate from user-facing prompts
3. **Conditional Adaptation**: Agent roles can change based on workflow conditions
4. **Professional Personas**: Each role represents a realistic professional with specific expertise
5. **Behavioral Guidance**: Roles guide approach, methodology, and focus areas

## Next Steps

1. **Practice**: Create a simple workflow for a task you're familiar with
2. **Validate**: Use the schema to validate your workflow
3. **Test**: Try using your workflow with an AI agent
4. **Improve**: Refine your workflow based on feedback
5. **Share**: Contribute your workflow to the community

## References

- [Advanced Validation Guide](13-advanced-validation-guide.md) - Complete guide to ValidationEngine features
- [Architecture Guide](02-architecture.md) - Technical details of the ValidationEngine
- [Workflow Schema](../spec/workflow.schema.json)
- [Valid Example](../spec/examples/valid-workflow.json)
- [API Specification](../spec/mcp-api-v1.0.md)
- [Architecture Guide](02-architecture.md)

---

**Last Updated**: 2024-01-15  
**Documentation Version**: 0.0.1-alpha  
**Maintained By**: Documentation Team 