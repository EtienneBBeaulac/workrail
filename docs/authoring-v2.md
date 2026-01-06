# Workflow Authoring Guide (v2)

WorkRail v2 authoring is **JSON-first** and is designed for **determinism**, **rewind-safety**, and **resumability**.

> **Status:** v2 authoring is design-locked but not necessarily shipped yet. This doc is a v2-only entry point.

## Canonical references (v2)

- **Authoring model + JSON examples:** `docs/design/workflow-authoring-v2.md`
- **Execution contract (token-based):** `docs/reference/workflow-execution-contract.md`
- **Core design locks (anti-drift):** `docs/design/v2-core-design-locks.md`

## v2 authoring principles (high level)

### JSON-first authoring

WorkRail v2 uses **JSON** as the canonical authoring format. DSL and YAML remain possible future input formats, but for v2 we optimize for determinism and straightforward validation.

Workflows are hashed based on their **compiled canonical model** (after templates/features/contracts are expanded), not raw text, so the hash remains stable and deterministic.

### Authoring primitives (v2)

WorkRail v2 introduces several primitives for expressive workflows:

- **Capabilities** (workflow-global): declare optional agent capabilities like `delegation` or `web_browsing` (required/preferred).
- **Features** (compiler middleware): mostly toggle IDs; a small subset supports typed config objects (`{id, config}`).
- **Templates**: reusable step sequences, called explicitly via `type: "template_call"`.
- **Contract packs**: WorkRail-owned output schemas for structured artifacts (e.g., `wr.contracts.capability_observation`).
- **PromptBlocks** (optional): structure step prompts as blocks (goal/constraints/procedure/outputRequired/verify) which compile to deterministic text.
- **AgentRole**: workflow and/or step-level stance/persona (not system prompt control).

For detailed JSON syntax and examples, see: `docs/design/workflow-authoring-v2.md`.

### Baseline (Tier 0): notes-first

- **You can write workflows with no special authoring features.**
- The default durable output is a short recap in `output.notesMarkdown` (recorded by the agent when advancing or checkpointing).
- Structured artifacts are **optional** and must never be required for a workflow to be usable.

### Builtins (no user-defined plugins)

WorkRail v2 provides **built-in** building blocks that workflows (including external workflows) can reference:

- **Templates**: pre-built steps (or step sequences) authors can “call” to speed up authoring and ensure consistency.
- **Features**: deterministic, closed-set “middleware” applied by WorkRail (e.g., tier-aware instructions, formatting, durable recap guidance).
- **Contract packs**: server-side definitions for allowed artifact kinds and small examples (no schema authoring required by workflow authors).

External workflows can reference these builtins, but cannot define arbitrary new plugin code.

### Where injections happen: templates as anchors

When something needs to be injected at a specific point (“run an audit here”, “insert a standard gate here”), **template references are the primary anchor**:

- Explicit at the callsite (less hidden magic).
- Deterministic and debuggable.
- Avoids tag-taxonomy sprawl.

Tags can still exist as optional **classification** metadata (for UI organization and search), but should not be the primary injection mechanism.

### Step identity and provenance

To keep authoring simple:

- Author step IDs remain the primary, stable identifiers (what agents see as `pending.stepId`).
- Template-expanded/internal step IDs are **reserved/internal** and carry provenance (what injected them, where, and why).
- By default, injected steps should be **collapsed** for agent UX; provenance exists for debugging/auditing and advanced views.

### Versioning and determinism

- The canonical pin is a **content hash** of the **fully expanded compiled workflow** (including template expansions, feature application, and contract pack selection), not a human-maintained `version` string.
- Human `version` fields may exist as labels, but should not be the source of truth for determinism.

### Debugging and auditing

WorkRail v2 treats debugging/auditing as first-class:

- WorkRail should record a bounded “decision trace” (why a step was selected/skipped, loop decisions, fork detection) as durable data.
- Dashboards and exports can surface this trace for post-mortems without requiring the agent to carry debugging internals in chat.
- “Cognitive audits” (subagent auditor model) are supported via built-in templates/features, not bespoke author boilerplate.
