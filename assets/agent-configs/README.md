# WorkRail Agent Configuration

This directory contains the reference configuration for a universal workflow executor designed to
work with WorkRail in agentic IDEs.

## Quick Start

### For Firebender Users

1. Copy the executor to your Firebender agents directory:
   ```bash
   cp firebender/workrail-executor.md ~/.firebender/agents/
   ```

2. Register it in your `firebender.json`:
   ```json
   {
     "subagents": [
       "~/.firebender/agents/workrail-executor.md"
     ]
   }
   ```

3. The executor uses **tool inheritance** (no `tools` field), so it has access to all tools
   including WorkRail by default.

### For Other IDEs

Check `docs/integrations/` for IDE-specific setup guides.

---

## How It Works

The WorkRail executor is a **single universal subagent** that can execute any WorkRail workflow. The
workflow defines the cognitive function - the executor adapts its role accordingly.

```
Main Agent
  ↓ delegates with workflow name
WorkRail Executor
  ↓ loads and executes workflow
Structured deliverable returned
```

### Benefits

1. **Single Source of Truth** - Workflows define behavior, not subagent configs
2. **No Duplication** - Role/behavior defined once in the workflow
3. **Easy to Extend** - Add new workflows without creating new subagents
4. **Simple Installation** - One file to install

---

## Delegation Pattern

When delegating to the WorkRail Executor, provide a complete work package:

```
task(subagent_type="workrail-executor", prompt="
  Execute the 'bug-investigation' workflow.
  
  Work Package:
  MISSION: Find the root cause of auth token rejection
  TARGET: src/auth/middleware/auth.ts
  CONTEXT:
    - Bug: Valid tokens rejected in production
    - Error: 401 on refresh endpoint
  DELIVERABLE: Investigation report with root cause and fix
")
```

The executor will:

1. Load the specified workflow
2. Execute all steps autonomously
3. Return the deliverable

---

## Customization

### Restricting Tools

To restrict tools instead of inheriting all, add a `tools` array to the YAML frontmatter:

```yaml
---
name: workrail-executor
tools:
  - read_file
  - grep_search
  - workflow_list
  - workflow_get
  - workflow_next
---
```

### Specifying Model

```yaml
---
name: workrail-executor
model: claude-sonnet-4
---
```

---

## Troubleshooting

### "Subagent isn't using WorkRail tools"

- Check that the config doesn't have a `tools` array excluding WorkRail tools
- If using explicit `tools`, add: `workflow_list`, `workflow_get`, `workflow_next`

### "Subagent output is incomplete"

- Verify you provided all required context in the work package
- Review the executor's "Gaps" section for what it couldn't complete

---

## Documentation

- **Firebender Integration:** `docs/integrations/firebender.md`
- **Design Principles:** `docs/architecture/subagent-design-principles.md`
