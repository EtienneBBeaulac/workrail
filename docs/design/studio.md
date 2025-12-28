# WorkRail Studio (Console) — Product & UX Design Notes (v2)

This document captures the intended shape of the WorkRail Studio (“Console”) experience: what it shows, what it controls, and how it stays aligned with v2’s rewind-safe, append-only truth model.

This is a **design doc**, not an implementation spec.

## Purpose

- Provide a **glass dashboard** over the durable session/run graph (the truth).
- Provide a **console/preferences hub** for WorkRail-owned state (preferences, flags, sources) without attempting to control the agent or read the chat transcript.

## Hard boundaries (platform reality)

- Studio cannot read the chat transcript or “push buttons” into the agent conversation.
- Studio cannot introspect the agent’s environment/tooling; it can only rely on durable observations recorded by WorkRail.
- Studio may change WorkRail-owned state/configuration, but those changes only affect execution when the agent next calls `continue_workflow` / `checkpoint_workflow` (node boundary).

## Information architecture (top-level navigation)

Top-level:

- **Sessions**
- **Workflows**
- **Settings**

Import/export is session-scoped (not top-level):

- Import from Sessions list
- Export from Session detail

## Core object model (what users think in)

- **Session**: a workstream grouping (may be repo-agnostic); contains 0..N runs.
- **Run**: one workflow execution pinned to a `workflowHash`; contains a DAG of durable nodes.
- **Node**: a durable snapshot in the run DAG.
  - `nodeKind: step | checkpoint`
  - Nodes interleave in time order by default.
- **Branch**: a fork in the run DAG (rewinds create branches).

## Default views vs advanced views

Default views are intentionally opinionated to avoid “confusing soup”:

- Sessions default to a **single active run** view (run selector sidebar).
- Runs default to the **preferred tip path** (linearized) with forks collapsed at divergence points.

Advanced:

- Full DAG visualization with zoom/pan and filters.
- Debug mode reveals injected steps, decision traces, and internal IDs.

## Session UX

Sessions can be repo-agnostic. When available, Studio surfaces observations as high-signal metadata:

- repo/worktree
- branch / HEAD SHA
- workflow usage history

Sessions grouping:

- automatic grouping first (using observations and workflow usage as signals)
- manual grouping/tagging can be added later

## Run UX

Run status vocabulary:

- `in_progress`
- `blocked`
- `complete`
- `complete_with_gaps`

`complete_with_gaps` is treated as “done with follow-ups”, not “still in progress”.

## Checkpoints

Checkpoints create nodes (`nodeKind=checkpoint`) and are first-class in the run timeline.

Visualization preference:

- default: interleaved nodes in chronological order
- later: optional “group checkpoints under nearest step” view

## Preferences & modes UX

- Modes are **presets** (Studio-facing), backed by WorkRail-defined closed-set preferences.
- Preference changes are session-scoped by default.
- Changes are shown as:
  - **pending** (until next node is created)
  - **applied at node X** (once effective)

## Gaps UX

- Gaps are displayed on the node where they were created.
- Gaps roll up to run/session headers (unresolved counts).
- Gaps are append-only facts with append-only “resolved” markers (no mutation of history).

## Optional capabilities UX

Capabilities are limited to workflow-shaping/optionally required enhancements.

Studio shows:

- **requested** capability requirements (required/preferred)
- **observed** capability status (unknown/available/unavailable), including how it was determined (probe vs attempted use)

Probe steps are injected and collapsed by default, expandable for provenance.

Remediation is a short instruction + link (no wizard).

## Workflow discovery, inspection, and editing

Workflows UI should make it easy to distinguish:

- identity (id/name/kind)
- provenance (source)
- editability (protected vs editable)

Inspection supports a Source vs Compiled toggle:

- Source: what the author wrote (editable depending on source)
- Compiled: what will run and be hashed/pinned (`workflowHash`)

Pinned drift is explicit:

- runs execute pinned compiled snapshots; Studio shows when source has changed since pin

Bundled/core workflows are protected:

- Studio offers fork/copy into an editable namespace rather than editing in place

Saving is validation-gated:

- invalid workflows cannot be saved; errors are actionable

## Builtins catalog and discoverability (authoring ergonomics)

Workflows that reference builtins (templates, features, contract packs, capabilities, prompt refs) must be authorable without “secret menu” knowledge.

Studio should provide a first-class Builtins Catalog (under Workflows) that is:

- searchable and filterable by kind (`template`, `feature`, `contract_pack`, `capability`, `ref`)
- explicit about provenance (`bundled`), editability, and reserved namespaces (e.g., `wr.*`)
- actionable: each entry includes copyable JSON snippets and/or an “Insert” action for:
  - enabling a feature in `features[]`
  - inserting a `template_call` step
  - referencing a contract pack (`output.contractRef`)
  - declaring capability requirements (`capabilities.*`)
  - inserting a prompt reference (`wr.refs.*`) into `promptBlocks` (where allowed)

### Generated registry (avoid drift)

The catalog must be powered by a **generated registry** sourced from the same canonical builtin definitions the compiler uses (not hand-maintained UI metadata). This prevents “Studio vs engine” drift and allows compiled workflow preview to link provenance directly back to catalog entries.

### Contextual suggestions

While editing workflows, Studio should provide contextual discoverability:

- autocomplete for `features[]`, `templateId`, `output.contractRef`, and `wr.refs.*`
- validation feedback that can suggest builtins (e.g., “this workflow appears to assume web browsing; consider declaring `capabilities.web_browsing`”)

## Sources management

- Sources live under Settings but are deep-linked from Workflows.
- Collisions are allowed via deterministic priority (no auto-renaming IDs); Studio surfaces “winner vs shadowed” definitions.
- Sources should auto-refresh / reload on demand (no restart needed for content refresh).

## Feature flags and restart-required UX

- Flags live under Settings.
- Studio shows **desired vs applied** values.
- Flags are labeled as runtime-safe vs restart-required.
- Studio provides restart instructions (no restart button).

## Export/import

- Export is session-scoped (bundle-first; rendered exports later).
- Import is from Sessions list and defaults to import-as-new (no merges).
- Integrity check results are surfaced and actionable.
- Post-import provides “resume in chat” guidance (copyable prompt/query), not agent control.

## Auditability & decision traces

- Decision traces are collapsed by default.
- “Why this step?” is shown primarily when non-obvious, with full access in Debug mode.
- Bundles include bounded traces by default.

## Error states & recovery

- Blocked runs present a single unblock panel with copyable prompt.
  - Blocked state and its reasons must be representable as **durable, node-attached data** (not inferred from chat history), so Studio can explain “why blocked” after rewinds.
- Editor deep-links are opportunistic later; baseline is path/line/JSON pointer guidance.
- Corruption safe-mode (read-only salvage/export) is a later enhancement, but storage should be designed to allow it.
- If workflow source disappears, pinned snapshots remain usable; Studio shows “source missing, pinned used”.

## Pinned (later) features

- Session buttons / queued intents applied at next node boundary (preferences-like mechanism).

## Related tracked open items

- `docs/design/v2-core-design-locks.md` (locked decisions and remaining open edges are tracked there until a dedicated open-items tracker exists)
