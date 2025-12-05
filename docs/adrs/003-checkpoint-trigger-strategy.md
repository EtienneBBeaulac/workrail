# ADR 003: Checkpoint Triggering Strategy

**Status:** Accepted
**Date:** 2024-07-27

## Context

The system needs a reliable strategy for when to automatically save a checkpoint. The goal is to ensure data durability and create logical, meaningful save points for resumption, without creating excessive, low-value checkpoints or putting the entire burden on the agent.

We considered the following options:
1.  **Manual-Only Trigger:** The agent is solely responsible for calling `workflow_checkpoint_save`. This provides maximum control but is brittle, as agent oversight could lead to data loss.
2.  **Time-Based Trigger:** Automatically save a checkpoint every N minutes. This is simple but disconnected from the workflow's actual progress, potentially creating checkpoints in awkward, non-resumable states.
3.  **Step-Based Trigger:** Save a checkpoint after every N steps. This is better, but still arbitrary and can create too many checkpoints for simple workflows.
4.  **Phase-Based Trigger:** Save a checkpoint after a logical "phase" of work is completed, as defined in the workflow's structure.

## Decision

We will implement a **hybrid checkpoint triggering strategy** that combines automatic phase-based triggers with a manual agent override.

-   **Automatic Phase-Based Trigger (Default):** The system will automatically save a checkpoint at the end of a major workflow "phase." A phase is a logical unit of work, which can be defined in the workflow's metadata (e.g., a group of steps). This provides a reliable, automatic baseline.
-   **Manual Override (Agent Control):** The agent can explicitly call `workflow_checkpoint_save` at any time to force a save at a critical moment that might not align with a phase boundary.

This approach creates a system that is both reliable by default and flexible enough to handle the unpredictable nature of AI-driven tasks.

## Consequences

### Positive:
-   **High Data Durability:** Guarantees that progress is saved regularly at logical intervals without requiring perfect agent behavior.
-   **Meaningful Checkpoints:** Checkpoints align with the workflow's semantic structure, making them easier for a user or agent to understand and choose from when resuming.
-   **Agent Flexibility:** The manual override provides a crucial escape hatch for agents to save state at critical junctures (e.g., after receiving a key insight or before attempting a risky operation).
-   **Balanced Performance:** Avoids the overhead of saving after every single step, striking a balance between data safety and performance.

### Negative:
-   **Requires Workflow Annotation:** For the automatic trigger to be most effective, workflow authors are encouraged to structure their workflows with logical "phases" in their metadata. Workflows without this annotation will have less meaningful automatic checkpoints.
-   **Slightly More Complex Implementation:** The server needs logic to parse workflow phase boundaries in addition to handling the manual tool call. 