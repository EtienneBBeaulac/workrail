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

### 1. Install WorkRail Subagent Configs

Copy the subagent markdown files to your Firebender agents directory:

```bash
# Copy all Core 6 subagents
cp packages/workrail/assets/agent-configs/firebender/*.md ~/.firebender/agents/

# Or copy individually
cp packages/workrail/assets/agent-configs/firebender/context-researcher.md ~/.firebender/agents/
cp packages/workrail/assets/agent-configs/firebender/hypothesis-challenger.md ~/.firebender/agents/
cp packages/workrail/assets/agent-configs/firebender/plan-analyzer.md ~/.firebender/agents/
cp packages/workrail/assets/agent-configs/firebender/execution-simulator.md ~/.firebender/agents/
cp packages/workrail/assets/agent-configs/firebender/ideator.md ~/.firebender/agents/
cp packages/workrail/assets/agent-configs/firebender/builder.md ~/.firebender/agents/
```

### 2. Register Subagents in Firebender

Edit your `~/.firebender/firebender.json` (or project-specific `firebender.json`):

```json
{
  "subagents": [
    "~/.firebender/agents/context-researcher.md",
    "~/.firebender/agents/hypothesis-challenger.md",
    "~/.firebender/agents/plan-analyzer.md",
    "~/.firebender/agents/execution-simulator.md",
    "~/.firebender/agents/ideator.md",
    "~/.firebender/agents/builder.md"
  ]
}
```

**Important:** The subagent configs use tool inheritance (no `tools` field), so they'll automatically have access to all tools including WorkRail.

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
- Check if subagents are available
- Probe if subagents have WorkRail tool access
- Report your tier (Solo, Proxy, or Delegate)

### 5. Test with a Simple Delegation

Try delegating a simple task to verify everything works:

```
"Delegate to the Context Researcher:

Execute routine-context-gathering at depth=1

Mission: Map the structure of the src/auth directory
Target: src/auth/
Context: I need to understand how authentication works
Deliverable: context-map.md"
```

If the Context Researcher can execute the routine and return a structured deliverable, you're in **Tier 3 (Delegation Mode)** ✅

---

## Usage Patterns

### **Pattern 1: Explicit Delegation**

Use the `task` tool to explicitly delegate to a subagent:

```
task(subagent_type="context-researcher", prompt="
  Execute routine-context-gathering at depth=2
  
  Mission: Understand how user profiles are cached
  Target: src/services/user-service.ts, src/cache/
  Context: Investigating slow profile loads
  Deliverable: cache-analysis.md
")
```

### **Pattern 2: Workflow-Driven Delegation**

Use `.agentic.json` workflows that include delegation instructions:

```
"Start the bug-investigation workflow"
```

The workflow will guide you through strategic delegation points (e.g., "Delegate context gathering to Context Researcher").

### **Pattern 3: Multi-Step Delegation**

Chain multiple subagent calls for complex tasks:

```
1. Delegate to Context Researcher (gather context)
2. Review their deliverable
3. Delegate to Hypothesis Challenger (challenge findings)
4. Review their critique
5. Delegate to Plan Analyzer (validate approach)
```

---

## Troubleshooting

### **"Subagent can't find workflow_list"**

**Cause:** Subagent has a `tools` whitelist that excludes WorkRail tools.

**Fix:** Either:
- Remove the `tools` field entirely (use inheritance)
- Or add WorkRail tools to the whitelist: `workflow_list`, `workflow_get`, `workflow_next`

### **"Subagent returns incomplete results"**

**Cause:** Insufficient context in delegation prompt.

**Fix:** Provide a complete work package:
- Mission (what to accomplish)
- Target (what to analyze)
- Context (background, constraints, prior work)
- Deliverable (what to return)

### **"How do I know which subagent to use?"**

**Guide:**
- **Context Researcher**: "I need to understand how X works"
- **Hypothesis Challenger**: "Challenge my assumptions about Y"
- **Plan Analyzer**: "Review this implementation plan"
- **Execution Simulator**: "Trace what happens when I call X with Y"
- **Builder**: "Implement this feature according to the plan"

### **"Can I use auto-invocation instead of explicit delegation?"**

**Answer:** Yes, Firebender can auto-invoke subagents based on task matching (using the `description` field). However, **explicit delegation is recommended** for predictability and control.

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

