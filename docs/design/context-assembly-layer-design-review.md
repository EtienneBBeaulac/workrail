# Context Assembly Layer -- Design Review Findings

**Reviewing:** Candidate B-hybrid (ContextAssembler service + typed assembledContext field on WorkflowTrigger)
**Date:** 2026-04-19

---

## Tradeoff Review

| Tradeoff | Acceptable? | What would make it unacceptable |
|---|---|---|
| Context serialized to string for agent consumption | YES (agents consume natural language) | If coordinators need to inspect bundle content for dispatch decisions -- not a planned use case |
| 150 LOC new module vs. 50 LOC inline | YES (justified by multi-coordinator reuse) | If second coordinator never arrives within 6 months |
| buildSystemPrompt() change (3 lines) | YES (daemon-only, not engine) | If buildSystemPrompt() is treated as a versioned public API -- it is not |
| workflow-runner.ts imports ContextBundle | YES (coupling direction is correct) | If ContextBundle grows to include I/O -- it must remain a pure value type |

---

## Failure Mode Review

| Failure Mode | Design handling | Missing mitigation | Risk |
|---|---|---|---|
| renderContextBundle() accumulates coordinator-specific formatting | Not addressed in v1 | Add `RenderOpts` interface with optional section labels | LOW |
| Agent ignores assembled context (attention threshold) | Section appended at end of system prompt | Test with prior session notes first; add reference in step prompts | **MEDIUM -- existential** |
| gitDiff source fails silently | Per-field Result<T,string> -- fails gracefully | Add WARN log in coordinator when source fails | LOW |
| Second coordinator wants different rendering | Not addressed | RenderOpts mitigation from FM1 | LOW (v1) |

---

## Runner-Up / Simpler Alternative Review

**Candidate A strength incorporated:** Typed `assembledContext?: ContextBundle` field on `WorkflowTrigger` is cleaner than string-in-context-map. This is the B-hybrid improvement over pure Candidate B.

**Simpler alternative (prior session notes only):** Would satisfy 3/5 acceptance criteria but NOT criterion 4 (pr-review.ts shrinks by 100 LOC). Not sufficient.

**Hybrid adopted:** B + typed field from A. This is the recommended design.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Dependency injection for boundaries | SATISFIED |
| Errors are data | SATISFIED |
| Immutability by default | SATISFIED |
| Make illegal states unrepresentable | SATISFIED (discriminated union) |
| Compose with small, pure functions | SATISFIED |
| Validate at boundaries | SATISFIED |
| YAGNI | ACCEPTABLE TENSION (coding_task kind is speculative but planned) |
| Explicit domain types | MINOR TENSION -- define SessionNote as a proper interface, not string |

---

## Findings

### RED (blocking)

None.

### ORANGE (should be addressed before implementation)

**O1: Assembled context visibility to agent is unverified**

The system prompt injection in `buildSystemPrompt()` adds the assembled context section AFTER the base system prompt and workspace context. In a dense system prompt (32KB CLAUDE.md + soul file), the assembled context may receive insufficient agent attention. This is the existential risk for the design.

**Required action before implementation:** Run one session with only `priorSessionNotes` injected. Verify the agent cites or references the prior session notes in its first turn. If it does not, investigate prompt positioning.

### YELLOW (note before implementation)

**Y1: SessionNote is not defined as a domain type**

`ContextAssemblerDeps.listRecentSessions` returns `Result<readonly SessionNote[], string>`. `SessionNote` must be defined as a proper `readonly` interface:
```typescript
export interface SessionNote {
  readonly sessionId: string;
  readonly recapSnippet: string;
  readonly sessionTitle: string | null;
  readonly gitBranch: string | null;
  readonly lastModifiedMs: number;
}
```
This maps directly to `HealthySessionSummary` fields in `LocalSessionSummaryProviderV2`.

**Y2: renderContextBundle needs RenderOpts stub**

Even in v1, add an optional `RenderOpts` parameter to `renderContextBundle()` (empty interface for now). This preserves the extension point without implementing it.

**Y3: WARN logging for source failures**

When `bundle.gitDiff.kind === 'err'`, the coordinator should log at WARN level. Add this to the coordinator refactor spec.

---

## Recommended Revisions

1. **Keep B-hybrid:** ContextAssembler service + typed `assembledContext?: ContextBundle` field on `WorkflowTrigger`. Do NOT use string-in-context-map.
2. **Add O1 mitigation:** Pilot test with `priorSessionNotes` source only before wiring all three sources.
3. **Define `SessionNote` interface** in `src/context-assembly/types.ts` before implementation.
4. **Add `RenderOpts` stub** to `renderContextBundle()` signature.
5. **Add WARN logs** in coordinator when source fails.
6. **Position assembled context section** in `buildSystemPrompt()` BEFORE the referenceUrls section (higher attention) -- small positioning change.

---

## Residual Concerns

1. **Second coordinator timeline is unscheduled.** The multi-coordinator reuse argument for Candidate B over A depends on a second coordinator being built. If this is more than 6 months away, Candidate A is the pragmatic choice.
2. **`LocalSessionSummaryProviderV2` wiring.** The session summary provider is currently wired only to the MCP server/console path. Using it from `ContextAssemblerDeps` requires either re-exporting its ports or constructing a lightweight adapter. Scope should be confirmed during shaping.
3. **git diff strategy.** `git diff HEAD~1 --stat` gives a file list; `git diff HEAD~1` gives full diff content. Full diff for large PRs could be 50-100KB. The v1 strategy should be `--stat` (file names and change counts only) -- this fits in the assembled context without hitting budget limits.
