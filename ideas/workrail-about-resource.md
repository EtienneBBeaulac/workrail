# Idea: workrail://about MCP Resource

## Problem

Agents have no structured way to answer user questions about WorkRail itself -- what it is, how to use it, where the console is, what the dashboard shows, etc. Today they either hallucinate or say nothing useful.

## Idea

Add a `workrail://about` MCP resource that gives agents the context they need to be a helpful first point of contact for WorkRail questions.

Content would cover:
- What WorkRail is (step-enforcing workflow system for agents)
- How to use it (list_workflows, start_workflow, continue_workflow loop)
- What the console/dashboard is and how to open it (open_dashboard tool or direct URL)
- Where to find workflows (built-in, project-scoped via .workrail/, managed sources)
- How sessions work (durable, resumable via resume_session)
- Common questions: "why is it blocking me?", "how do I skip a step?", "where are my notes saved?"

## Why a resource

Resources are pull-based -- agents read them on demand rather than having the content jammed into every tool description. Keeps tool descriptions focused on usage, not orientation.

## Related

- `workrail://tags` resource (same pattern, already shipped)
- `open_dashboard` tool (console link -- should be mentioned in about content)
