# Firebender Integration Guide

## Overview
Firebender is an Agentic IDE that supports multiple subagents. WorkRail works seamlessly with Firebender in two modes: **Delegation** (Gold) and **Proxy** (Silver).

## Configuration Rules

Firebender has a specific behavior regarding Tool Access that you must understand to enable **Delegation Mode**.

### The "Inheritance" Rule (Recommended)
If you define a subagent **without** a `tools` configuration block, it inherits **ALL** tools from the main agent, including WorkRail.

**✅ Recommended Config (Tier 3 Enabled):**
```json
{
  "subagents": {
    "researcher": {
      "systemPrompt": "You are a Researcher...",
      // No "tools" block -> Inherits everything!
    }
  }
}
```

### The "Whitelist" Pitfall
If you define a `tools` block (even if empty), the subagent loses access to everything except what is listed.

**❌ Broken Config (Tier 2 Only):**
```json
{
  "subagents": {
    "researcher": {
      "systemPrompt": "...",
      "tools": ["read_file", "grep"] // Missing WorkRail tools!
    }
  }
}
```

**✅ Fixed Whitelist Config:**
If you MUST whitelist tools, you must explicitly add the WorkRail suite:
```json
{
  "subagents": {
    "researcher": {
      "systemPrompt": "...",
      "tools": [
        "read_file", 
        "grep",
        "workflow_list",
        "workflow_get",
        "workflow_next",
        "workflow_validate"
      ]
    }
  }
}
```

## Step-by-Step Setup

### 1. Install WorkRail Subagent Config

Copy the universal WorkRail executor to your Firebender agents directory:

```bash
# Copy the universal executor
cp assets/agent-configs/firebender/workrail-executor.md ~/.firebender/agents/

# Legacy: Individual subagent configs (deprecated in favor of universal executor)
# cp assets/agent-configs/firebender/*.md ~/.firebender/agents/
```

### 2. Register Subagent in Firebender

Edit your `~/.firebender/firebender.json` (or project-specific `firebender.json`):

```json
{
  "subagents": [
    "~/.firebender/agents/workrail-executor.md"
  ]
}
```

**Important:** The subagent config uses **tool inheritance** (no `tools` field), so it will automatically have access to all tools including WorkRail.

### 3. Enable Agentic Workflows in WorkRail

Set the feature flag to enable `.agentic.json` workflow variants:

```bash
export WORKRAIL_ENABLE_AGENTIC_ROUTINES=true
```

Or add to your shell profile (`~/.zshrc`, `~/.bashrc`):

```bash
echo 'export WORKRAIL_ENABLE_AGENTIC_ROUTINES=true' >> ~/.zshrc
source ~/.zshrc
```

### 4. Verify Your Setup

Run the diagnostic workflow to test your configuration:

```bash
# In Firebender, ask the main agent:
"Run the workflow-diagnose-environment workflow"
```

This will:
- Check if the WorkRail executor is available
- Probe if the executor has WorkRail tool access
- Report your tier (Solo, Proxy, or Delegate)

### 5. Test with a Simple Delegation

Try delegating a simple task to verify everything works:

```
"Delegate to the WorkRail Executor:

Execute the 'Context Gathering Routine' workflow at depth=1.

Work Package:
MISSION: Map the structure of the src/auth directory
TARGET: src/auth/
CONTEXT: I need to understand how authentication works
DELIVERABLE: context-map.md"
```

If the WorkRail Executor can execute the routine and return a structured deliverable, you're in **Tier 3 (Delegation Mode)** ✅

---

## Usage Patterns

### **Pattern 1: Explicit Delegation**

Use the `task` tool to explicitly delegate to the WorkRail executor:

```
task(subagent_type="workrail-executor", prompt="
  Execute the 'Context Gathering Routine' workflow at depth=2.
  
  Work Package:
  MISSION: Understand how user authentication works in this codebase
  TARGET: src/auth/
  CONTEXT: 
    - Bug: Valid tokens rejected in production
    - Previous Finding: AuthService identified as likely location
  DELIVERABLE: context-map.md with component structure and execution flow
")
```

The WorkRail Executor will:
1. Load the `Context Gathering Routine` workflow
2. Execute it autonomously at depth=2
3. Return `context-map.md` with findings

### **Pattern 2: Main Agent Instruction**

You can also instruct the main agent to delegate for you:

```
"Please delegate context gathering to the WorkRail Executor.

Execute the 'Context Gathering Routine' at depth=2 (Explore level).

Mission: Understand the authentication system
Target: src/auth/
Context: Investigating token validation bug
Deliverable: context-map.md"
```

The main agent will format the delegation and call the WorkRail Executor.

### **Pattern 3: Workflow-Driven Delegation**

Agentic workflows (`.agentic.json`) include delegation instructions in their prompts:

```
"Start the bug-investigation workflow"
```

The workflow will guide the main agent through strategic delegation points, with prompts like:

```
"Execute the 'Context Gathering Routine' workflow at depth=2.

Work Package:
MISSION: [extracted from context]
TARGET: [identified files/areas]
..."
```

The main agent reads these instructions and delegates to the WorkRail Executor accordingly.

### **Pattern 4: Parallel Delegation**

For THOROUGH mode workflows, delegate to multiple executors simultaneously:

```
# Spawn 3 WorkRail Executors in parallel:

Executor 1: Execute 'Ideation Routine' with perspective=logic-errors
Executor 2: Execute 'Ideation Routine' with perspective=data-state
Executor 3: Execute 'Ideation Routine' with perspective=integration

# Then synthesize all deliverables
```

Each executor works independently, exploring different solution spaces.

---

## Troubleshooting

### **"WorkRail Executor can't find workflow_list"**

**Cause:** Subagent has a `tools` whitelist that excludes WorkRail tools.

**Fix:** Either:
- Remove the `tools` field entirely from the YAML frontmatter (use inheritance)
- Or add WorkRail tools to the whitelist: `workflow_list`, `workflow_get`, `workflow_next`

The provided `workrail-executor.md` uses inheritance (no `tools` field), so this shouldn't happen unless you modified it.

### **"WorkRail Executor returns incomplete results"**

**Cause:** Insufficient context in delegation prompt.

**Fix:** Provide a complete work package:
- **Workflow**: Which routine to execute (by name)
- **Parameters**: Workflow-specific params (depth, rigor, perspective, etc.)
- **Mission**: What to accomplish
- **Target**: What to analyze (files, directories, code areas)
- **Context**: Background, constraints, prior work
- **Deliverable**: What artifact to create and what format

### **"How do I know which workflow to use?"**

**Guide:**
- **Context Gathering Routine**: "I need to understand how X works"
- **Hypothesis Challenge Routine**: "Challenge my assumptions about Y"
- **Plan Analysis Routine**: "Review this implementation plan"
- **Execution Simulation Routine**: "Trace what happens when I call X with Y"
- **Ideation Routine**: "Generate multiple approaches to solve X"
- **Feature Implementation Routine**: "Implement this feature according to the plan"

The WorkRail Executor can execute any of these - the workflow defines its behavior.

### **"Can I use auto-invocation instead of explicit delegation?"**

**Answer:** Yes, Firebender can auto-invoke subagents based on task matching (using the `description` field in the YAML frontmatter). However, **explicit delegation is recommended** for predictability and control, especially for workflows with parameters (depth, rigor, etc.).

---

## Advanced Configuration

### **Per-Project Subagents**

You can have project-specific subagent configs:

```bash
# Create project-specific agents directory
mkdir .firebender/agents/

# Copy and customize subagents
cp ~/.firebender/agents/context-researcher.md .firebender/agents/

# Register in project firebender.json
{
  "subagents": [
    ".firebender/agents/context-researcher.md"
  ]
}
```

### **Custom Subagents**

To create a custom subagent:

1. Copy an existing subagent as a template
2. Modify the YAML frontmatter:
   ```yaml
   ---
   name: my-custom-agent
   description: "My custom agent description"
   tools:  # Optional, omit to inherit all tools
     - read_file
     - grep_search
   model: claude-sonnet-4
   ---
   ```
3. Update the system prompt to define the cognitive function
4. Register in `firebender.json`

### **Model Selection**

Choose models based on task complexity:

```yaml
---
name: context-researcher
model: claude-haiku-4  # Fast, cheap (for depth 0-1)
# OR
model: claude-sonnet-4  # Powerful (for depth 2+)
---
```

---

## Verifying Your Setup

Run the Diagnostic Workflow to test your configuration:
1. Start a chat with the Main Agent.
2. Ask: "Run the environment diagnostic workflow."
3. Follow the steps to probe your subagent's capabilities.

