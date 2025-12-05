# Available Workflows

> **Auto-generated** from workflow files. Run `workrail list` for the latest.
>
> Last updated: 2025-12-05

## Overview

WorkRail includes **14 production workflows** across multiple categories.

| Category | Count |
|----------|-------|
| Debugging | 1 |
| Code Review | 2 |
| Documentation | 3 |
| Exploration & Analysis | 3 |
| Learning & Education | 3 |
| Other | 2 |

---

## Debugging

Bug investigation and troubleshooting

### `bug-investigation`

**Bug Investigation** (v1.0.0)

A systematic bug investigation workflow that finds the true source of bugs through strategic planning and evidence-based analysis. Guides agents through plan-then-execute phases to avoid jumping to conclusions.

- **Steps**: 10
- **File**: `workflows/bug-investigation.json`

## Code Review

Merge request and code review processes

### `coding-task-workflow-with-loops`

**Excellent Adaptive Coding Workflow with Devil's Advocate Review** (v0.8.0)

Comprehensive AI coding workflow with bidirectional re-triage, deep analysis, intelligent clarification, devil's advocate review, automation levels, failure bounds, tool fallbacks, and context documentation for production-ready development.

- **Steps**: 23
- **File**: `workflows/coding-task-workflow-with-loops.json`

### `mr-review-workflow`

**Adaptive MR Review Workflow** (v0.2.0)

An adaptive workflow to guide an AI agent in performing a comprehensive code review. It adjusts its rigor based on MR complexity and includes checkpoints for architectural and self-critique to provide deep, actionable feedback.

- **Steps**: 10
- **File**: `workflows/mr-review-workflow.json`

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

### `workflow-diagnose-environment`

**Diagnostic: Environment & Subagents** (v1.0.0)

Automated capability detection for Agentic IDEs. Probes for subagent access and generates a local configuration file.

- **Steps**: 2
- **File**: `workflows/workflow-diagnose-environment.json`

### `workflow-for-workflows`

**Progressive Workflow Creation Guide** (v0.1.0)

An adaptive meta-workflow that guides users through creating high-quality workflow templates with personalized learning paths. Offers three experience-based approaches: Basic (step-by-step with detailed explanations), Intermediate (balanced guidance with examples), and Advanced (comprehensive features with expert context). All paths can produce sophisticated workflows - the difference is in explanation depth and feature introduction timing.

- **Steps**: 14
- **File**: `workflows/workflow-for-workflows.json`

---

## Using Workflows

Tell your AI agent which workflow to use:

```
"Use the bug-investigation workflow to debug this issue"
"Use the coding-task-workflow-with-loops to implement this feature"
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
