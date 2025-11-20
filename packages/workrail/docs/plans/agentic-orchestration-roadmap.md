# Product Plan: The "Agentic Orchestration" Evolution

## Executive Summary
This document outlines the roadmap for evolving WorkRail from a monolithic workflow engine into a **Composable, Agent-Aware Orchestration Platform**. This evolution enables WorkRail to leverage modern Agentic IDE features (Subagents, Parallel Execution) while maintaining universal compatibility and backward compatibility.

The rollout is structured in **3 Phased Tiers**, gated by feature flags, ensuring safe and iterative delivery.

---

## Phase 1: The "Manual" Prototype (Immediate Value)
**Goal:** Enable Subagent support *today* using existing primitives, verifying the "Agent Cascade Protocol" without core engine refactors.

**Feature Flag:** `WR_ENABLE_ROUTINES=true` (Optional)

### Key Deliverables:
1.  **The "Routine" Concept:**
    *   Creation of `workflows/routines/` directory.
    *   First Routine: `context-gathering.json` (A reusable, specialized micro-workflow).
2.  **The "Dual-Path" Handoff:**
    *   Modification of `ai-task-implementation.json` Step 1.
    *   Implementation of the "Delegate or Proxy" prompt pattern directly in the JSON.
3.  **The Diagnostic Suite:**
    *   `workflow-diagnose-environment.json`: A wizard to help users test their Subagent tool access.
    *   `docs/integrations/firebender.md`: Documentation on tool whitelisting constraints.

**User Experience:**
*   *Before:* Agent does everything linearly.
*   *After:* Agent is instructed to "Delegate to Researcher" manually. If capable, it runs the Routine parallel/isolated.

---

## Phase 2: The "Composition" Engine (Structural Health)
**Goal:** Modularize the system. Replace manual prompt copying with a structural "Assembler" that builds workflows from reusable fragments.

**Feature Flag:** `WR_ENABLE_COMPOSITION=true`

### Key Deliverables:
1.  **The Workflow Assembler:**
    *   Server-side logic to parse a `composition` field in Workflow JSON.
    *   Recursively loads and flattens referenced fragments (`fragments/*.json`).
    *   Calculates dynamic step indices (e.g., "Step 1 of [Unknown]").
2.  **Fragment Schema:**
    *   Formal definition of a "Fragment" (Inputs, Steps, Output Schema).
3.  **Refactored Core Workflows:**
    *   Splitting `ai-task-implementation.json` into `frag-gather`, `frag-plan`, `frag-execute`.
    *   Reassembling them via the new Composition engine.

**User Experience:**
*   *Transparent:* Users just see standard steps.
*   *Author Experience:* Massive improvement. Authors reuse "Gather" logic across 10 workflows instead of copying it.

---

## Phase 3: The "Adapter" Intelligence (Future Proofing)
**Goal:** Make workflows "Smart." Move conditional logic (Delegate vs. Proxy) out of text prompts and into the Schema/Engine.

**Feature Flag:** `WR_ENABLE_ADAPTERS=true`

### Key Deliverables:
1.  **The Adapter System:**
    *   `SubagentAdapter.ts`: Code that detects `capabilities.hasSubagents`.
    *   `CloudAdapter.ts`: (Future) For cloud execution.
2.  **Schema Variants:**
    *   New `variants` field in Workflow Schema.
    *   Logic to select a variant based on context flags (e.g., `if (hasSubagents) useDelegateVariant`).
3.  **Runtime Probe:**
    *   Automatic injection of "Capability Discovery" at the start of sessions.
    *   Persistent `WorkRailConfig` reading for environment settings.

**User Experience:**
*   *Magic:* WorkRail automatically detects if Subagents are available and switches the instructions to "Delegation Mode" without the user doing anything.

---

## Summary of Phased Rollout

| Phase | Focus | Technical Change | Risk | Value |
| :--- | :--- | :--- | :--- | :--- |
| **1. Prototype** | Manual Handoff | JSON Content only | Low | Immediate Subagent support |
| **2. Composition** | Modularity | Server Logic (Assembler) | Medium | Reusability & Maintainability |
| **3. Adapters** | Intelligence | Core Engine + Schema | High | Zero-Config "Magic" |

## Feature Flagging Strategy
All new logic will be wrapped in `WorkRailConfig.features.*` checks.
*   **Default:** All flags `false`.
*   **Opt-In:** Users enable via `.env` or `.workrail/config.json` to test new capabilities.
*   **Graduation:** Once a phase is stable, its flag defaults to `true` in the next major release.

