# ADR 002: Four-Layer Context Classification Model

**Status:** Accepted
**Date:** 2024-07-27

## Context

To intelligently manage the LLM context window and storage, the system needs a way to differentiate the importance of various pieces of information within a workflow's context. A simple, undifferentiated approach would treat all data equally, leading to suboptimal compression and potential loss of critical information when the context budget is exceeded.

We considered several approaches:
1.  **No Classification:** Treat all context as a single blob. Simple, but ineffective.
2.  **Binary Classification:** A simple `critical` / `non-critical` flag. Better, but lacks nuance for gradual compression.
3.  **Content-Based Scoring:** Use algorithms to score the importance of text. Potentially powerful, but complex and computationally expensive for a real-time system.
4.  **A Multi-Layered Hierarchy:** A predefined set of importance levels that context can be sorted into.

## Decision

We will adopt a **four-layer context classification hierarchy**, which categorizes information into one of four levels:

1.  **CRITICAL:** Essential information that must never be compressed or dropped (e.g., user goals, final outputs).
2.  **IMPORTANT:** High-value information that should be preserved, but can be compressed under pressure (e.g., reasoning chains, implementation plans).
3.  **USEFUL:** Detailed information that is valuable but can be aggressively compressed or summarized (e.g., code examples, verbose tool outputs).
4.  **EPHEMERAL:** Temporary data that can be safely dropped between steps (e.g., debug logs, timestamps).

Classification will be implemented using a hybrid approach: automatic pattern-based rules (e.g., regex on context keys) as a baseline, with optional, explicit hints in the workflow schema and manual agent overrides (`workflow_mark_critical`) for fine-grained control.

## Consequences

### Positive:
-   **Intelligent Compression:** Provides clear, tiered priorities for the compression engine, ensuring that the most critical information is preserved with the highest fidelity.
-   **Efficient Token Management:** Allows the system to make informed decisions about what to summarize or drop when facing context window limits.
-   **Research-Validated:** This model is based on research into effective token distribution, which shows it aligns well with typical information patterns in complex tasks.
-   **Flexible and Controllable:** The combination of automatic rules and manual overrides provides a powerful system that is both easy to use by default and highly controllable for advanced workflows.

### Negative:
-   **Requires Upfront Definition:** The patterns for automatic classification need to be well-defined and maintained.
-   **Potential for Misclassification:** If patterns are not reliable, information could be assigned to the wrong category, although the manual override acts as a safeguard.
-   **Minor Agent Overhead:** While mostly automatic, the agent needs to be aware of the system to use the override tool effectively. 