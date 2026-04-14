# Design Candidates: WorkRail Console Three-Layer Execution Trace

## Problem Understanding

### Core tensions
- **T1: Spatial anchoring vs surface count** -- Layer 2 floating overlay provides spatial context (near the node) but creates two simultaneous surfaces from one click
- **T2: Ambient deduplication** -- `[ RUN ROUTING ]` in Layer 2 and Layer 1 TRACE timeline both show context_fact/divergence items with no node ref; two authoritative surfaces for the same data
- **T3: State count** -- four independent state dimensions (active tab, overlay open, selected node, right panel loaded) without an explicit state machine; some combinations are illegal (overlay in TRACE tab)
- **T4: Layer 3 delivery sequencing** -- ghost nodes require `skipped_step` kind not present in `ConsoleExecutionTraceItemKind`; backend change needed before ghost nodes can ship

### Real seam
`useSessionDetailViewModel` owns `selectedNode` and is the right place for `activeTab: 'dag' | 'trace'` per run. Overlay open/close state is transient and local to `RunLineageDag`. Routing content in `NodeDetailSection` would live in the SECTION_REGISTRY.

### What makes it hard
- Overlay must be positioned in scroll-container coordinates and respond to scroll events (node may scroll out of view)
- `[ N NEW ]` button requires tracking first unread trace index and resetting on scroll
- Layer 3 edge cause diamonds require computing bezier midpoints of ReactFlow edges
- Tab strip must live inside `RunLineageDag` header but tab state needs to survive RunCard re-renders
- Single click currently opens `NodeDetailSection`; Layer 2 overlay would open two simultaneous surfaces from one gesture

---

## Philosophy Constraints

**Make illegal states unrepresentable:** overlay-in-TRACE is illegal; must be structurally prevented, not just runtime-guarded  
**Immutability by default:** routing content should be derived from `(selectedNode, executionTraceSummary)`, not stored in a separate overlay state variable  
**YAGNI with discipline:** overlay positioning infrastructure is non-trivial; requires concrete user need to justify  
**Exhaustiveness everywhere:** tab x overlay x selectedNode transitions must be fully specified  
**SECTION_REGISTRY extension contract:** `NodeDetailSection.tsx:94` was explicitly designed for one-entry additions  

---

## Impact Surface

- `NodeDetailSection` SECTION_REGISTRY -- one-entry extension is the intended pattern
- `useSessionDetailViewModel` `selectedNode` state -- must remain single source of truth; no parallel selection concept
- `RunLineageDag` scroll container -- overlay positioning and existing tooltip (z-50) share this space; new overlay needs z-60+
- `CutCornerBox` around RunCard -- `relative` positioning; overflow implications for inner positioned elements
- `focusNodeInViewport` at `RunLineageDag.tsx:61` -- already handles scroll-to-node; reusable for bidirectional trace navigation

---

## Candidates

### Candidate A: Proposed design as-is (floating overlay, Layer 2)

**Summary:** Floating overlay near clicked DAG node shows routing context (`[ WHY SELECTED ]`, `[ CONDITIONS EVALUATED ]`, `[ LOOP ]`, `[ DIVERGENCE ]`); ambient items in `[ RUN ROUTING ]` section visible without node selection.

**Tensions resolved:** T1 (spatial anchoring wins -- overlay is adjacent to the node)  
**Tensions accepted:** T2 (ambient items appear in both Layer 2 `[ RUN ROUTING ]` and Layer 1 TRACE timeline), T3 (four state dimensions, state machine unspecified)

**Boundary:** `RunLineageDag` internals + new overlay component positioned in scroll-container coordinates (above z-50 tooltip)

**Why this boundary:** Spatial relevance requires the overlay to be in the DAG canvas coordinate space

**Failure mode:** User clicks node, two surfaces open simultaneously (overlay + right panel). No clear read order. Split-attention cost on every node click. HIGH severity.

**Repo-pattern relationship:** Departs. No existing click-triggered spatially-anchored overlay. Tooltip (z-50) is hover-only, not click-triggered.

**Gains:** Spatial anchor -- routing context adjacent to the node while it is visually present  
**Gives up:** Click-destination clarity, state machine simplicity, YAGNI, structural prevention of overlay-in-TRACE illegal state

**Scope judgment:** Too broad for the click simplicity constraint without resolving the click-destination ambiguity

**Philosophy fit:** Conflicts with make-illegal-states-unrepresentable (overlay-in-TRACE can occur without explicit guard), YAGNI (overlay positioning non-trivial)

---

### Candidate B: Routing section inside NodeDetailSection (simplest path)

**Summary:** Add `routing` and `run_routing` entries to `NodeDetailSection` SECTION_REGISTRY. `routing` section filters `executionTraceSummary.items` by `refs.some(r => r.kind === 'node_id' && r.value === nodeId)`. `run_routing` section shows items with no `node_id` ref (ambient context). No overlay. No new state dimensions.

**Data flow:** `NodeDetailSection` receives `executionTraceSummary?: ConsoleExecutionTraceSummary | null` as a new prop. Content derived, not stored. Null guard at one location.

**Tensions resolved:** T1 (surface simplicity wins), T2 (ambient items have one primary location -- right panel `run_routing` section), T3 (two state dimensions: selectedNode + activeTab)  
**Tensions accepted:** T1 tradeoff (no spatial anchor -- user reads routing in right panel, not adjacent to DAG node)

**Boundary:** `NodeDetailSection.tsx` SECTION_REGISTRY -- one-entry addition, no structural changes elsewhere

**Why this boundary:** The SECTION_REGISTRY was explicitly designed for this extension. Zero new infrastructure. The prop addition is backward-compatible (`?` optional).

**Failure mode:** Right panel becomes long with many sections on data-rich nodes. The routing section should be collapsible. LOW severity -- manageable.

**Repo-pattern relationship:** Follows exactly. SECTION_REGISTRY at line 94 is the intended extension point.

**Gains:** Zero new surface logic, zero z-index management, zero click-destination ambiguity. Null guard at one location. One-entry addition consistent with SECTION_REGISTRY contract.  
**Gives up:** Spatial anchor for routing context

**Scope judgment:** Best-fit

**Philosophy fit:** Honors all principles. Strongest fit.

---

### Candidate C: Bidirectional TRACE-DAG linking (Layer 2 as navigation bridge)

**Summary:** No floating overlay. When a node is selected, a `routingEventCount` badge appears on the DAG tab header ("3 routing events"). In TRACE tab, the first trace entry with a `node_id` ref matching `selectedNodeId` auto-scrolls into view and is highlighted with an amber accent border. TRACE entries with `node_id` refs navigate back to the DAG node via `focusNodeInViewport` on click.

**Data flow:** `routingEventCount = executionTraceSummary.items.filter(i => i.refs.some(r => r.kind === 'node_id' && r.value === selectedNodeId)).length`. Derived, not stored. `highlightedTraceIndices` is a derived Set.

**Tensions resolved:** T1 (middle path -- no overlay, but navigable bidirectional link), T2 (ambient items only in TRACE tab, no duplication), T3 (two state dimensions + derived sets)  
**Tensions accepted:** T1 tradeoff (routing context requires tab switch; not immediately visible on node click)

**Boundary:** RunCard tab header (badge count) + TRACE tab render (highlight) + existing `focusNodeInViewport` reuse

**Why this boundary:** Three small wiring points at existing seams. `focusNodeInViewport` at `RunLineageDag.tsx:61` already exists.

**Failure mode:** Discovery -- users may not notice the badge count nudge on the DAG tab header and may not know to switch to TRACE to find routing context. MEDIUM severity -- mitigable with stronger visual affordance (e.g., glowing badge).

**Repo-pattern relationship:** Adapts. `focusNodeInViewport` reuse is exact. `OverviewRail` RailDot click-to-navigate is a precedent for trace entry navigation.

**Gains:** Clean state machine, no ambient duplication, TRACE is canonical routing surface, bidirectional link closes narrative/spatial gap  
**Gives up:** Immediate routing visibility on node click, spatial anchor

**Scope judgment:** Best-fit

**Philosophy fit:** Honors all principles. Strong fit.

---

## Comparison and Recommendation

### Tension matrix
| Tension | A (overlay) | B (right panel section) | C (bidirectional link) |
|---|---|---|---|
| T1 spatial anchoring | Resolved (spatial wins) | Accepted (simplicity wins) | Middle path |
| T2 ambient deduplication | NOT resolved | Resolved | Resolved |
| T3 state count | NOT resolved | Resolved | Resolved |
| T4 ghost nodes | Same for all (backend gate) | Same | Same |

### Recommended composite: B + C badge nudge (not A)

- **Layer 1 (TRACE tab):** implement exactly as proposed. Zero backend cost, CSS already exists.
- **Layer 2 (routing for selected node):** Candidate B -- add `routing` section to SECTION_REGISTRY. Resolves T1/T2/T3 simultaneously at the cleanest boundary.
- **Layer 2 discoverability nudge:** Candidate C badge -- `routingEventCount` on DAG tab header when node is selected. Cheap signal pointing toward TRACE tab.
- **Layer 3:** edge cause diamonds, loop brackets, CAUSE button -- implement. Ghost nodes gated on backend `skipped_step` confirmation.

This preserves the three-layer concept while fixing the weakest element (floating overlay). The overlay is not rejected as wrong -- it is deferred until spatial anchoring is validated as a real user need.

---

## Self-Critique

**Strongest counter-argument:** Spatial anchor is real value. In a complex DAG (15+ nodes), looking away to the right panel adds cognitive load. If user research shows this matters, Candidate A is justified.

**Pivot conditions:**
1. User research confirms spatial anchoring reduces debugging time meaningfully -- adopt overlay
2. Users report confusion about which node's routing context the right panel is showing -- validates spatial disambiguation need
3. Backend confirms `skipped_step` kind in the same iteration -- changes the Layer 3 cost-benefit calculation

**What assumption, if wrong, invalidates this:** If the primary use case is live debugging (not post-run review), spatial immediacy matters more. Ambient context in DAG view is more valuable for live debugging than for post-run analysis.

---

## Open Questions for the Main Agent

1. Is the primary use case post-run review or live debugging? This changes whether spatial immediacy matters.
2. For `[ RUN ROUTING ]` ambient section in Layer 2: if it's dropped in favor of TRACE tab as the sole ambient surface, is there any scenario where a user needs ambient routing context while in DAG mode without wanting to switch tabs?
3. Was the floating overlay specifically chosen for any reason other than spatial anchoring? (e.g., performance, rendering constraint, user research finding?)
4. What is the timeline on backend confirmation for `skipped_step` kind?
