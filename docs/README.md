# Documentation Index

> **Internal documentation for WorkRail development**

## Architecture & Design

- **[Architecture Guide](implementation/02-architecture.md)** - System architecture and design principles
- **[Agent Cascade Protocol](design/agent-cascade-protocol.md)** - Capability-tiered execution model for agentic environments
- **[Subagent Design Principles](design/subagent-design-principles.md)** - Durable guidance for subagent roles, delegation, and audit patterns

## Development Guides

- **[Testing Strategy](implementation/04-testing-strategy.md)** - Testing approach and quality assurance
- **[Security Guide](implementation/05-security-guide.md)** - Security model and practices
- **[Performance Guide](implementation/06-performance-guide.md)** - Performance optimization strategies
- **[Deployment Guide](implementation/07-deployment-guide.md)** - Deployment strategies and operations

## Planning

- **[Planning System](planning/README.md)** - How ideas, roadmap items, tickets, and focused plans fit together
- **[Docs Taxonomy and Migration Plan](planning/docs-taxonomy-and-migration-plan.md)** - Concrete plan for consolidating `docs/` directories over time
- **[GitHub Ticketing Playbook](planning/github-ticketing-playbook.md)** - Phase 1 operating playbook for the single-dev, agent-assisted GitHub workflow
- **[Ideas Backlog](ideas/backlog.md)** - Low-friction inbox for raw product and system ideas
- **[Now / Next / Later](roadmap/now-next-later.md)** - Lightweight cross-cutting roadmap view
- **[Open Work Inventory](roadmap/open-work-inventory.md)** - Consolidated list of partial, unimplemented, and parked work
- **[Legacy Planning Status Map](roadmap/legacy-planning-status.md)** - Explicit status for the major older planning docs
- **[Next Up](tickets/next-up.md)** - Groomed near-term tickets
- **[Workflow Validation Roadmap](plans/workflow-validation-roadmap.md)** - Canonical planning/status doc for the validation initiative
- **[Workflow Validation Design](plans/workflow-validation-design.md)** - Canonical durable design for the validation initiative
- **[Workflow v2 Roadmap](plans/workflow-v2-roadmap.md)** - Canonical planning/status doc for WorkRail v2
- **[Workflow v2 Design](plans/workflow-v2-design.md)** - Canonical durable design for WorkRail v2
- **[Prompt Fragments](plans/prompt-fragments.md)** - Canonical finished summary for the prompt fragments feature
- **[Agent-Managed Ticketing Design](plans/agent-managed-ticketing-design.md)** - Live design doc for a single-dev GitHub ticketing system that works well with agents

### Planning directory roles

- **`docs/plans/`** - initiative-specific canonical plan/design docs
- **`docs/roadmap/`** - cross-cutting priorities and status views
- **`docs/planning/`** - meta-docs about the planning system itself

## Workflow Development

- **[Workflow Authoring Principles (v2)](authoring-v2.md)** - Cross-workflow authoring rules and principles
- **[Simple Workflow Guide](implementation/09-simple-workflow-guide.md)** - Creating custom workflows
- **[Advanced Validation Guide](implementation/13-advanced-validation-guide.md)** - Advanced validation techniques

## Reference

- **[Loop Documentation](features/loops.md)** - Loop support and patterns
- **[API Specification](../spec/mcp-api-v1.0.md)** - Complete API documentation
- **[Configuration Reference](configuration.md)** - Environment variables, Git repos, paths
- **[Release Policy](reference/releases.md)** - Semantic-release behavior, major-version approval, and dry-run flows
- **[Troubleshooting Guide](reference/troubleshooting.md)** - Common issues and solutions

---

*For user-focused documentation, see the [main README](../README.md)*
