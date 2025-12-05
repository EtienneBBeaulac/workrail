# The Agent Cascade Protocol

## Executive Summary

The **Agent Cascade Protocol** is the architectural foundation that allows WorkRail to function universally across different agentic environments—from simple "chat" interfaces to complex, multi-agent IDEs like Firebender and Cursor.

Instead of requiring a specific setup, WorkRail adopts a **Progressive Capability** model. It detects the available agent capabilities and "cascades" down to the most robust execution strategy available.

This ensures three critical outcomes:
1.  **Universal Compatibility:** WorkRail works for users with zero configuration.
2.  **Power User Scalability:** WorkRail unlocks advanced orchestration for users with configured subagents.
3.  **Zero Hallucination:** The protocol verifies capabilities before attempting to use them.

---

## The Three Execution Tiers

WorkRail defines three distinct tiers of execution. The system automatically selects the highest available tier for each task.

### Tier 3: Delegation Mode (Gold)
*   **Requirement:** User has specialized Subagents (e.g., "Researcher") configured with access to WorkRail MCP tools.
*   **Behavior:** The Main Agent acts as a **Dispatcher**. It identifies a task (e.g., "Gather Context"), selects the appropriate Subagent, and hands off the entire corresponding WorkRail Routine (e.g., `routine-gather`). The Subagent executes the routine independently and reports back the final result.
*   **Pros:** Parallel execution, true specialization, cleanest context window for Main Agent.
*   **Cons:** Requires the most advanced configuration (Tool Whitelisting).

### Tier 2: Proxy Mode (Silver)
*   **Requirement:** User has specialized Subagents, but they *cannot* access WorkRail tools (default state in many IDEs).
*   **Behavior:** The Main Agent acts as a **Driver**. It reads the WorkRail steps itself, but delegates the *work* to the Subagent via natural language prompts.
    *   *Main Agent:* "Researcher, please find all files related to Auth."
    *   *Subagent:* (Uses native grep) "Here they are..."
    *   *Main Agent:* (Reads output, marks WorkRail step as complete).
*   **Pros:** Leverages Subagent specialization and context isolation without complex tool config.
*   **Cons:** Main Agent's context window gets polluted with the management overhead; serial execution only.

### Tier 1: Solo Mode (Bronze)
*   **Requirement:** User has no subagents (or is using a standard chat interface).
*   **Behavior:** The Main Agent acts as the **Worker**. WorkRail dynamically injects "Persona Instructions" into the step prompt to simulate specialization.
    *   *WorkRail Prompt:* "ACT AS A RESEARCHER. Do not write code. Only gather context."
*   **Pros:** Works everywhere, zero configuration.
*   **Cons:** Single context window, risk of persona drift (e.g., trying to code during research).

---

## The Decision Logic (The Probe)

How does WorkRail know which tier to use? It uses a **"Verify then Delegate"** pattern (The Probe Protocol).

### 1. The Boot Check (Diagnostic Phase)
When a session starts (or via the `workflow-diagnose-environment` workflow), WorkRail guides the Main Agent to probe the environment:

1.  **Check for Subagents:** "Do you have a 'Researcher' subagent?"
    *   *No:* **Fallback to Tier 1 (Solo).**
    *   *Yes:* Proceed to step 2.

2.  **Check for Tool Access:** "Ask your Researcher to call `workflow_list`."
    *   *Success:* **Upgrade to Tier 3 (Delegation).**
    *   *Failure/Unknown:* **Fallback to Tier 2 (Proxy).**

### 2. The Runtime Handoff (Execution Phase)
When executing a workflow step that calls for a specialized routine:

*   **If Tier 3:** WorkRail provides the **Delegation Instruction**:
    > "Delegate the `routine-gather` workflow to your Researcher Subagent. Instruct them to run it using `workflow_next`."

*   **If Tier 2:** WorkRail provides the **Proxy Instruction**:
    > "Act as a Proxy. Read the steps of `routine-gather`. For each step, instruct your Researcher Subagent to perform the work via natural language. Validate their results yourself."

*   **If Tier 1:** WorkRail provides the **Persona Instruction**:
    > "ACT AS A RESEARCHER. Execute the `routine-gather` steps yourself. Focus purely on gathering context."

---

## Configuration & Assets

To support this protocol, WorkRail provides:

1.  **The Diagnostic Workflow:** A guided utility (`workflow-diagnose-environment.json`) to help users verify and configure their agents.
2.  **The Asset Pack:** Standardized definitions for common roles (Researcher, Architect, Builder, Reviewer) that users can copy-paste into their IDE configs.
    *   Includes System Prompts (for Tiers 1-3).
    *   Includes Tool Whitelists (for unlocking Tier 3).
3.  **The Config Cache:** A local file (`.workrail/config.json`) where the Diagnostic Workflow saves the environment state, so the Main Agent remembers the correct Tier across sessions.

---

## Summary of Flows

| Feature | Tier 3 (Delegate) | Tier 2 (Proxy) | Tier 1 (Solo) |
| :--- | :--- | :--- | :--- |
| **Orchestrator** | Main Agent | Main Agent | Main Agent |
| **Worker** | Subagent | Subagent | Main Agent |
| **Tools Used** | Subagent (Native + MCP) | Subagent (Native) | Main Agent (Native + MCP) |
| **Context** | Isolated | Shared/Polluted | Shared |
| **Config Req** | High (Tools + Prompts) | Low (Prompts) | None |
| **Scalability** | High | Medium | Low |

This protocol ensures WorkRail is never "broken" by a lack of configuration—it simply adapts its strategy to match the available tools.

