# Ideas Backlog

Workflow and feature ideas that are worth capturing but not yet planned or designed.

## Workflow ideas

### Standup Status Generator

- **Status**: idea
- **Summary**: A workflow that automatically generates a daily standup status by aggregating activity across the user's tools since the last standup.
- **Data sources** (adaptive based on what the user has available):
  - Git history (commits, branches, PRs/MRs)
  - GitLab (merge requests, comments, reviews)
  - Jira (ticket transitions, comments, new assignments)
  - Other issue trackers or project management tools the user configures
- **Key behavior**:
  - Detect the last standup date (stored in session or inferred from history)
  - Aggregate activity since that date across all configured sources
  - Categorize into "what I did", "what I'm doing today", and "blockers"
  - Generate a concise, human-readable standup message
- **Design considerations**:
  - Should be tool-agnostic: detect available integrations and adapt
  - Could leverage MCP tool discovery to find available data sources at runtime
  - Needs a lightweight persistence mechanism for last-standup timestamp
  - Output format should be configurable (Slack message, plain text, structured JSON)

## Feature ideas

### Dashboard artifacts (replace file-based docs)

- **Status**: designed, not yet implemented
- **Summary**: Instead of having agents write markdown files into the working repo, agents would submit structured artifacts through `continue_workflow` output payloads. Artifacts are stored per-session and rendered in the console/dashboard. Eliminates repo pollution and gives users a single place to see all workflow outputs.
- **Key dependencies**: console/dashboard UI (does not exist yet), server-side artifact storage
- **Design doc**: `docs/reference/workflow-execution-contract.md` (section "Replacing File-Based Docs with Dashboard Artifacts")

### Derived / overlay workflows for bundled workflow specialization

- **Status**: parked idea
- **Note**: see `docs/roadmap/open-work-inventory.md` for details

### Workflow categories and category-first discovery

- **Status**: idea
- **Summary**: Improve workflow discovery by organizing bundled workflows into categories and teaching `list_workflows` to support a category-first exploration path instead of always returning one large flat list.
- **Why this seems useful**:
  - the workflow catalog is getting large enough that flat discovery is becoming noisy
  - agents often do not know the exact workflow ID they want, but they may know the task family (coding, review, docs, investigation, planning, learning)
  - category-first discovery could reduce prompt overload and make workflow selection feel more guided
- **Possible phase 1 shape**:
  - add workflow categories as metadata on workflow definitions or a registry-side mapping
  - extend `list_workflows` with an optional category-style input
  - if no category is passed, return:
    - category names
    - workflow count per category
    - a few representative workflow titles per category
    - guidance telling the agent to call `list_workflows` again with the category it wants
  - if a category is passed, return the full workflows for that category with names, descriptions, IDs, and hashes
- **Possible phase 2 shape**:
  - support multiple discovery views such as grouped-by-category, grouped-by-source, or full flat list
  - add filtering by category + source + maybe keywords
  - align category discovery with future platform / multi-root discovery work
- **Design questions**:
  - should categories live in workflow JSON, in a registry overlay, or be inferred from directory / naming conventions?
  - should `list_workflows` become polymorphic, or should category discovery be a separate read-only tool / mode?
  - how much summary content should the uncategorized response include before it becomes too verbose again?
  - how do categories interact with routines, examples, project workflows, and external workflow repositories?
- **Risks / tradeoffs**:
  - changing `list_workflows` is a real tool contract and output-schema change, not just a UI tweak
  - overloading one tool with too many discovery modes could make the contract less predictable
  - static categories can drift unless there is a clear ownership model
- **Related docs / context**:
  - `docs/plans/workrail-platform-vision.md` (already discusses grouped discovery by source)
  - `docs/roadmap/open-work-inventory.md` (legacy workflow modernization increases the need for better discovery)
  - current implementation: `src/mcp/handlers/v2-workflow.ts`, `src/mcp/v2/tools.ts`, `src/mcp/output-schemas.ts`
