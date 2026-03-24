# Available Workflows

> **Auto-generated** from workflow files. Run `workrail list` for the latest.
>
> Last updated: 2026-03-24

## Overview

WorkRail includes **20 production workflows** across multiple categories.

| Category | Count |
|----------|-------|
| Development | 1 |
| Debugging | 2 |
| Code Review | 2 |
| Documentation | 3 |
| Exploration & Analysis | 3 |
| Learning & Education | 3 |
| Other | 6 |

---

## Development

Feature implementation and coding workflows

### `coding-task-workflow-agentic`

**Agentic Task Dev Workflow (Lean • Notes-First • WorkRail Executor)** (v1.0.0)

The user guides the agent through understanding the task, selecting an approach, planning in slices, implementing incrementally, and verifying the result through explicit review and validation checkpoints.

- **Steps**: 12
- **File**: `workflows/coding-task-workflow-agentic.lean.v2.json`

## Debugging

Bug investigation and troubleshooting

### `bug-investigation`

**Bug Investigation** (v1.0.0)

A systematic bug investigation workflow that finds the true source of bugs through strategic planning and evidence-based analysis. Guides agents through plan-then-execute phases to avoid jumping to conclusions.

- **Steps**: 10
- **File**: `workflows/bug-investigation.json`

### `bug-investigation-agentic`

**Bug Investigation (v2 • Notes-First • WorkRail Executor)** (v2.0.0)

A v2-first bug investigation workflow focused on moving from theory to proof with notes-first durability, explicit trigger fields, de-anchored fresh-eye review, and investigation-only handoff boundaries.

- **Steps**: 9
- **File**: `workflows/bug-investigation.agentic.v2.json`

## Code Review

Merge request and code review processes

### `mr-review-workflow`

**Adaptive MR Review Workflow** (v0.2.0)

An adaptive workflow to guide an AI agent in performing a comprehensive code review. It adjusts its rigor based on MR complexity and includes checkpoints for architectural and self-critique to provide deep, actionable feedback.

- **Steps**: 10
- **File**: `workflows/mr-review-workflow.json`

### `mr-review-workflow-agentic`

**MR Review Workflow (v2 • Notes-First • Parallel Reviewer Families)** (v2.1.0)

A v2-first MR review workflow that uses a shared fact packet, parallel reviewer families, an explicit coverage ledger, and contradiction-driven synthesis to produce high-signal review output without duplicating context gathering.

- **Steps**: 9
- **File**: `workflows/mr-review-workflow.agentic.v2.json`

## Documentation

Creating and maintaining documentation

### `document-creation-workflow`

**Document Creation Workflow** (v0.0.1)

Create BROAD or COMPREHENSIVE documentation spanning multiple components/systems. Perfect for: project READMEs, complete API documentation, user guides covering multiple features, technical specifications for systems. Uses complexity triage (Simple/Standard/Complex) to adapt rigor. For SINGLE, BOUNDED subjects (one class, one integration), use scoped-documentation-workflow instead for better scope discipline.

- **Steps**: 11
- **File**: `workflows/document-creation-workflow.json`

### `documentation-update-workflow`

**Documentation Update & Maintenance Workflow** (v1.0.0)

UPDATE and MAINTAIN existing documentation. Analyzes Git history to detect staleness, identifies outdated sections, and systematically refreshes docs while preserving valuable content. Perfect for: refreshing docs after code changes, scheduled maintenance, addressing feedback. NOT for creating new docs - use scoped-documentation-workflow or document-creation-workflow for new documentation.

- **Steps**: 15
- **File**: `workflows/documentation-update-workflow.json`

### `scoped-documentation-workflow`

**Scoped Documentation Workflow** (v1.0.0)

Create documentation for a SINGLE, BOUNDED subject with strict scope enforcement. Perfect for: one class/component, one integration point, one mechanism, one architecture decision. Prevents documentation sprawl through continuous boundary validation (9+/10 scope compliance required). NOT for: project READMEs, multi-component systems, or comprehensive guides - use document-creation-workflow for those.

- **Steps**: 10
- **File**: `workflows/scoped-documentation-workflow.json`

## Exploration & Analysis

Understanding codebases and systems

### `adaptive-ticket-creation`

**Adaptive Ticket Creation Workflow** (v0.1.0)

An intelligent workflow for creating high-quality Jira tickets. Uses LLM-driven path selection to automatically choose between Simple, Standard, or Epic complexity paths based on request analysis.

- **Steps**: 9
- **File**: `workflows/adaptive-ticket-creation.json`

### `exploration-workflow`

**Comprehensive Adaptive Exploration Workflow** (v0.1.0)

An enterprise-grade exploration workflow featuring multi-phase research loops with saturation detection, evidence-based validation, diverse solution generation, and adversarial challenge patterns. Adapts methodology based on domain type (technical/business/creative) while ensuring depth through triangulation, confidence scoring, and systematic quality gates.

- **Steps**: 17
- **File**: `workflows/exploration-workflow.json`

### `intelligent-test-case-generation`

**Intelligent Test Case Generation from Tickets** (v0.0.1)

Transforms ticket requirements into systematic test cases using evidence-driven analysis, dual-brain processing (NLP + LLM), document discovery, and progressive scenario expansion. Produces integration and end-to-end tests optimized for developer readability and LLM consumption with confidence scoring and validation loops.

- **Steps**: 12
- **File**: `workflows/intelligent-test-case-generation.json`

## Learning & Education

Course design and learning materials

### `personal-learning-course-design`

**Personal Learning Course Design Workflow** (v1.0.0)

A systematic workflow for designing effective personal learning courses with three thoroughness paths: Quick Start (3-5 days for essential structure), Balanced (1-2 weeks for comprehensive system), and Comprehensive (2-3 weeks for professional-grade pedagogical depth). Adapts complexity based on user time constraints and learning design experience.

- **Steps**: 11
- **File**: `workflows/learner-centered-course-workflow.json`

### `personal-learning-materials-creation-branched`

**Personal Learning Materials Creation Workflow (Branched)** (v1.0.0)

A systematic workflow for creating high-quality learning materials with three thoroughness paths: Quick Start (essential materials), Balanced (comprehensive system), and Comprehensive (enterprise-grade). Adapts depth and features based on user time constraints and quality goals.

- **Steps**: 6
- **File**: `workflows/personal-learning-materials-creation-branched.json`

### `presentation-creation`

**Dynamic Presentation Creation Workflow** (v0.1.0)

A comprehensive workflow for creating dynamic, interesting, and insightful presentations. Guides users through audience analysis, content strategy, visual design, and delivery preparation to create compelling presentations that engage and inform.

- **Steps**: 9
- **File**: `workflows/presentation-creation.json`

## Other

Miscellaneous workflows

### `cross-platform-code-conversion`

**Cross-Platform Code Conversion** (v0.1.0)

Guides an agent through converting code from one platform to another (e.g., Android to iOS, iOS to Web). Triages files by difficulty, delegates easy literal translations to parallel subagents, then the main agent tackles platform-specific code requiring design decisions.

- **Steps**: 9
- **File**: `workflows/cross-platform-code-conversion.v2.json`

### `design-thinking-workflow`

**Design Thinking Workflow** (v0.0.1)

A structured-reflective design thinking process: Empathize → Define → multi-round Ideate → Synthesize → Prototype (learning artifact) → Test plan → Iterate (test/learn/refine).

- **Steps**: 11
- **File**: `workflows/design-thinking-workflow.json`

### `design-thinking-workflow-autonomous-agentic`

**Design Thinking Workflow (Autonomous, Tiered Agent Cascade)** (v0.1.0)

Autonomous design thinking: minimal human input; doc-first execution; supports Agent Cascade Protocol tiers (Solo/Proxy/Delegation) with explicit fallbacks.

- **Steps**: 16
- **File**: `workflows/design-thinking-workflow-autonomous.agentic.json`

### `relocation-workflow-us`

**Relocation Decision Workflow (US v1 — AreaSpec • Custom Areas • Dossier • Evidence • Ranking)** (v0.2.0)

A bias-resistant, evidence-driven relocation workflow for the United States. Helps users discover what they care about, generate a broad candidate pool (including optional custom areas), screen it with strict caps, deep-dive shortlisted areas, and produce a master dossier plus per-location profile docs with a transparent, explainable weighted ranking.

- **Steps**: 19
- **File**: `workflows/relocation-workflow-us.json`

### `workflow-diagnose-environment`

**Diagnostic: Environment & Subagents** (v1.0.0)

Automated capability detection for Agentic IDEs. Probes for subagent access and generates a local configuration file.

- **Steps**: 2
- **File**: `workflows/workflow-diagnose-environment.json`

### `workflow-for-workflows`

**Workflow Authoring Workflow (Lean, References-First)** (v2.0.0)

Guides an agent through creating a new WorkRail workflow: understand the task, choose the shape, draft the JSON, validate with real validators, review the method, and optionally refine.

- **Steps**: 8
- **File**: `workflows/workflow-for-workflows.v2.json`

---

## Using Workflows

Tell your AI agent which workflow to use:

```
"Use the bug-investigation workflow to debug this issue"
"Use the coding-task-workflow-agentic to implement this feature"
```

Or browse programmatically:

```bash
# List all workflows
workrail list

# Get details about a specific workflow
workrail list --verbose
```

## Creating Custom Workflows

See the [Workflow Authoring Guide](authoring.md) to create your own workflows.
