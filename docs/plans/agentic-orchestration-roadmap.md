# Product Plan: The "Agentic Orchestration" Evolution

## Executive Summary
This document outlines the roadmap for evolving WorkRail from a monolithic workflow engine into a **Composable, Agent-Aware Orchestration Platform**. This evolution enables WorkRail to
use modern Agentic IDE features (Subagents, Parallel Execution) while maintaining universal compatibility and backward compatibility.

The rollout is structured in **3 Phased Tiers**, gated by feature flags, ensuring safe and iterative delivery.

---

## Phase 1: The "Manual" Prototype (Completed)
**Goal:** Enable Subagent support *today* using existing primitives, verifying the "Agent Cascade Protocol" without core engine refactors.

**Feature Flag:** `WORKRAIL_ENABLE_AGENTIC_ROUTINES=true`

### Key Deliverables:
1.  **The "Routine" Concept:**
    *   Creation of `workflows/routines/` directory (hidden unless flag enabled).
    *   Core Routines: `context-gathering`, `hypothesis-challenge`, `plan-analysis`, `execution-simulation`, `feature-implementation`.
    *   **Ideate -> Plan -> Execute** strategy pattern implemented in all routines.
2.  **The "Dual-Path" Handoff:**
    *   Creation of `bug-investigation.agentic.json` with manual delegation instructions.
    *   Implementation of the "Delegate or Proxy" prompt pattern directly in the JSON.
3.  **The Diagnostic Suite:**
    *   `workflow-diagnose-environment.json`: Agent-driven wizard to probe capabilities and generate config.
    *   `docs/integrations/firebender.md`: Documentation on tool whitelisting constraints.

**User Experience:**
*   *Before:* Agent does everything linearly.
*   *After:* Agent is instructed to "Delegate to Researcher" manually. If capable, it runs the Routine parallel/isolated.

---

## Phase 2: The "Composition & Middleware" Engine (Next Up)
**Goal:** Modularize the system and enable **Auto-Injection**. Replace manual prompt copying with a structural "Assembler" that builds workflows dynamically.

**Feature Flag:** `WORKRAIL_ENABLE_COMPOSITION=true`

### Key Deliverables:
1.  **The Workflow Assembler:**
    *   Server-side logic to parse a `composition` field in Workflow JSON.
    *   Recursively loads and flattens referenced fragments/routines.
2.  **Workflow Middleware:**
    *   **Auto-Injection:** Logic to inject required steps based on workflow metadata.
    *   *Example:* If workflow `requires: ["subagents"]`, automatically prepend `routine-environment-handshake`.
    *   Eliminates the need for every workflow to manually include setup steps.
3.  **Fragment Schema:**
    *   Formal definition of a "Fragment" (Inputs, Steps, Output Schema).

**User Experience:**
*   *Transparent:* Users just see standard steps, but they are dynamically assembled.
*   *Magic Setup:* Workflows automatically verify environment capabilities without the user needing to run a manual setup wizard every time.

---

## Phase 3: The "Adapter" Intelligence (Future Proofing)
**Goal:** Make workflows "Smart." Move conditional logic (Delegate vs. Proxy) out of text prompts and into the Schema/Engine.

**Feature Flag:** `WORKRAIL_ENABLE_ADAPTERS=true`

### Key Deliverables:
1.  **The Adapter System:**
    *   `SubagentAdapter.ts`: Code that detects `capabilities.hasSubagents`.
    *   `CloudAdapter.ts`: (Future) For cloud execution.
2.  **Schema Variants:**
    *   New `variants` field in Workflow Schema.
    *   Logic to select a variant based on context flags (e.g., `if (hasSubagents) useDelegateVariant`).
3.  **Runtime Probe & Persistence:**
    *   Refined `routine-environment-handshake` that is smarter about caching capabilities.
    *   Persistent `WorkRailConfig` reading for environment settings.

**User Experience:**
*   *Adaptive:* WorkRail automatically detects if Subagents are available and switches the instructions to "Delegation Mode" without the user doing anything.

---

## Backlog Candidates / Open Product Directions

### Authorable Response Supplements

**Goal:** Let workflow authors declare small, typed response-boundary supplements that WorkRail can deliver separately from the main authored step prompt.

**Why it matters:**
*   Keeps the primary step prompt user-voiced while still allowing start/resume-only guidance.
*   Makes current runtime-owned supplement behavior explicit and eventually authorable.
*   Gives workflow-for-workflows and future linting a real schema surface instead of relying on hidden server policy.

**Constraints:**
*   Should be a **narrow, typed feature**, not arbitrary extra prompt sludge.
*   Must preserve separation between **core step instructions** and **delivery-owned framing**.
*   `once_per_session` semantics must be explicit: policy-level first, durable tracking only if truly required later.

**Likely shape:**
*   A dedicated workflow field such as `responseSupplements`
*   Typed supplement kinds, lifecycle targeting (`start`, `rehydrate`, maybe `advance`), and explicit delivery modes
*   Strong validation and authoring guidance to prevent misuse

---

## Summary of Phased Rollout

| Phase | Focus | Technical Change | Risk | Value |
| :--- | :--- | :--- | :--- | :--- |
| **1. Prototype** | Manual Handoff | JSON Content only | Low | Immediate Subagent support |
| **2. Composition** | Modularity & Injection | Server Logic (Assembler) | Medium | Reusability & Auto-Setup |
| **3. Adapters** | Intelligence | Core Engine + Schema | High | Zero-Config "Magic" |

## Feature Flagging Strategy
All new logic will be wrapped in `WorkRailConfig.features.*` checks.
*   **Default:** All flags `false`.
*   **Opt-In:** Users enable via `.env` or `.workrail/config.json` to test new capabilities.
*   **Graduation:** Once a phase is stable, its flag defaults to `true` in the next major release.
