# Claude Code Integration Guide

This guide covers setting up WorkRail with Claude Code (both Desktop and CLI).

## Quick Start

### Claude Desktop App

1. Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent location on your OS
2. Add WorkRail to the `mcpServers` section:

```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["-y", "@exaudeus/workrail"]
    }
  }
}
```

3. Restart Claude Desktop
4. Verify by asking: "List available workflows"

### Claude Code CLI

#### Method 1: Using `claude mcp add` (Recommended)

```bash
# Navigate to your project
cd /path/to/your/project

# Add WorkRail MCP server
claude mcp add workrail npx -y @exaudeus/workrail
```

This creates/updates `.claude.json` in your project root.

#### Method 2: Manual Configuration

Edit or create `.claude.json` in your project root:

```json
{
  "projects": {
    "/absolute/path/to/your/project": {
      "mcpServers": {
        "workrail": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@exaudeus/workrail"],
          "env": {}
        }
      }
    }
  }
}
```

**Important:** The path must be absolute and match your actual project directory.

---

## Custom Workflow Configuration

To use custom workflows, add environment variables:

```json
{
  "projects": {
    "/path/to/your/project": {
      "mcpServers": {
        "workrail": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@exaudeus/workrail"],
          "env": {
            "WORKFLOW_STORAGE_PATH": "/path/to/custom/workflows",
            "WORKFLOW_GIT_REPOS": "https://github.com/your-org/workflows.git",
            "GITHUB_TOKEN": "ghp_your_token_here"
          }
        }
      }
    }
  }
}
```

---

## workrail-executor Agent

The `workrail-executor` agent enables delegating workflow execution to subagents, allowing parallel context gathering and multi-agent workflows.

### Setup

Create `~/.claude/agents/workrail-executor.md`:

```markdown
---
name: workrail-executor
description: Executes WorkRail workflows step by step using the WorkRail MCP tools. Use when the user wants to run a workflow, follow a structured process, or resume a previous workflow session. Handles start, continue, and checkpoint operations, interpreting each step's instructions faithfully and advancing only when the step is complete.
tools: Bash, Read, Write, Edit, mcp__workrail__list_workflows, mcp__workrail__inspect_workflow, mcp__workrail__start_workflow, mcp__workrail__continue_workflow, mcp__workrail__checkpoint_workflow, mcp__workrail__resume_session, mcp__workrail__create_session, mcp__workrail__update_session, mcp__workrail__read_session, mcp__workrail__open_dashboard
---

You are the WorkRail executor. Your job is to faithfully follow WorkRail workflow steps one at a time.

## Core responsibilities

- Use `mcp__workrail__start_workflow` to begin a workflow by name or ID.
- Use `mcp__workrail__continue_workflow` with a `continueToken` to advance after completing a step.
- Use `mcp__workrail__checkpoint_workflow` to save progress and return a resume token when asked or when ending a session.
- Use `mcp__workrail__list_workflows` to show available workflows.
- Use `mcp__workrail__inspect_workflow` to preview a workflow's steps before starting.

## Execution rules

1. **Read each step carefully.** The step prompt is your instruction. Execute it fully before advancing.
2. **Do not skip steps.** Every step must be completed in order.
3. **Provide required notes.** Steps that require notes must receive substantive notes before you call `continue_workflow`. Pass them via the `output.notesMarkdown` parameter.
4. **Advance only when done.** Call `continue_workflow` only after the step's work is complete.
5. **Checkpoint on request.** If the user asks to pause or save progress, call `mcp__workrail__checkpoint_workflow` and share the resume token.
6. **Report clearly.** After each step, briefly summarize what was done before moving on.

## Token handling

- `continueToken` (`ct_` prefix) — use with `continue_workflow` to advance.
- `checkpointToken` / `resumeToken` (`cp_` or `st_` prefix) — use with `checkpoint_workflow` or `continue_workflow` to save/rehydrate.
- Never mix token types.

## Workflow complete

When the workflow returns `isComplete: true`, summarize all work done across the workflow and confirm completion to the user.
```

### Usage

Once configured, spawn workrail-executor agents in workflows:

```python
# In Python (or equivalent in your language)
agent = Agent(
    subagent_type="workrail-executor",
    description="Execute context gathering",
    prompt="""
    Start the routine-context-gathering workflow.

    Workspace: /path/to/project
    Focus: COMPLETENESS
    Context: ...
    """
)
```

Or from the main agent in Claude Code:

```
Please use the workrail-executor agent to run the bug-investigation-agentic workflow
```

---

## Troubleshooting

### WorkRail tools not available

**Symptoms:** Claude doesn't recognize workflow commands or says workrail tools aren't available.

**Solutions:**

1. **Desktop App:** Restart Claude Desktop completely (Quit, not just close window)
2. **CLI:** Exit and start a new session - MCP servers load at startup, not mid-session
3. **Verify config:**
   ```bash
   # For CLI
   cat .claude.json | jq '.projects[].mcpServers.workrail'

   # For Desktop
   cat ~/Library/Application\ Support/Claude/claude_desktop_config.json | jq '.mcpServers.workrail'
   ```

### Agent can't access workrail tools

**Symptoms:** workrail-executor agent reports "I don't have access to WorkRail workflow tools"

**Common causes:**

1. **Wrong tool names in agent config** - Tool names must match exactly:
   - Correct: `mcp__workrail__start_workflow`
   - Wrong: `mcp_workrail_start_workflow` (missing double underscores)
   - Wrong: `mcp__workrail__mcp_workrail_start_workflow` (doubled prefix)

2. **Agent config not reloaded** - After editing `~/.claude/agents/workrail-executor.md`, start a fresh session

3. **MCP server not running** - Ensure workrail MCP is configured and loaded (see "WorkRail tools not available" above)

### Workflows not found

```bash
# Check what WorkRail sees
npx @exaudeus/workrail list

# Verify custom paths
ls -la ~/.workrail/workflows/

# Check environment variables
echo $WORKFLOW_STORAGE_PATH
```

### Git repository authentication fails

```bash
# Test GitHub token
curl -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/user

# Test repo access
git ls-remote https://github.com/your-org/workflows.git
```

---

## Advanced Configuration

### Per-Project Workflows

Use project-local workflows that override bundled ones:

```bash
cd /path/to/your/project
mkdir -p workflows
# Add your .json workflow files
```

WorkRail auto-discovers `./workflows/` in the current directory.

### Multiple Git Repositories

```json
{
  "env": {
    "WORKFLOW_GIT_REPOS": "https://github.com/team-a/workflows.git,https://github.com/team-b/workflows.git"
  }
}
```

Later repositories override earlier ones with the same workflow ID.

### Disable Bundled Workflows

```json
{
  "env": {
    "WORKFLOW_INCLUDE_BUNDLED": "false"
  }
}
```

---

## Best Practices

1. **Version control your agent configs** - Check `~/.claude/agents/` into a dotfiles repo
2. **Use project-specific `.claude.json`** - Different projects can have different workflow configs
3. **Enable session tools for debugging** - Set `WORKRAIL_ENABLE_SESSION_TOOLS=true` to use dashboard and session inspection
4. **Create team-specific workflows** - Host in a shared Git repo and reference via `WORKFLOW_GIT_REPOS`

---

## Examples

### Running a workflow directly

```
> Use the bug-investigation-agentic workflow to investigate the cache expiration issue
```

### Delegating to workrail-executor

```
> Spawn two workrail-executor agents in parallel:
> 1. One running routine-context-gathering with focus=COMPLETENESS
> 2. One running routine-context-gathering with focus=DEPTH
```

### Resuming a checkpointed workflow

```
> Resume the workflow session using token: st_abc123...
```

---

## See Also

- [Configuration Reference](../configuration.md)
- [Writing Workflows](../authoring.md)
- [All Available Workflows](../workflows.md)
- [Firebender Integration](./firebender.md)
