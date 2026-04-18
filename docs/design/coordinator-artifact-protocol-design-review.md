# Design Review Findings: Coordinator Artifact Protocol

**Status:** Review complete  
**Date:** 2026-04-18  
**Design reviewed:** Candidate A from coordinator-artifact-protocol-design-candidates.md

---

## Tradeoff Review

| Tradeoff | Acceptable? | When it stops being acceptable |
|----------|-------------|-------------------------------|
| N+1 HTTP calls for all-node aggregation | Yes (localhost, ~50-100ms) | If coordinator is called for sessions with 50+ nodes |
| `source?` optional on `ReviewFindings` | Yes (observability only, not routing) | If future code switches exhaustively on `source` |
| `.strict()` schema | Yes (follows existing precedent) | If LLM consistently emits extra fields causing Zod failures |
| `required: false` in outputContract | Yes (transition strategy) | Once 10+ consecutive sessions confirm 100% artifact emission |

---

## Failure Mode Review

| Failure Mode | Severity | Handling | Missing Mitigation |
|-------------|----------|----------|--------------------|
| Missing `makeContinueWorkflowTool` onComplete update | LOW | TypeScript won't catch (optional param) -- manual verification required | Code comment at both call sites |
| Per-node HTTP fetch failure during aggregation | LOW | Graceful fallback to keyword scan | Per-node try/catch + WARN logging |
| Agent emits malformed artifact (wrong enum, missing field) | MEDIUM | `safeParse` fails silently without logging | `[WARN coord:reason=artifact_parse_failed]` logging REQUIRED |
| `runs[0].nodes` undefined for empty sessions | NONE | Null check + empty-array fallback | None |
| `required: false` default behavior | NONE | Engine correctly reads `required: false` and skips validation | None |

---

## Runner-Up / Simpler Alternative Review

**Runner-up (tip-node only):** Disqualified by task spec 'CRITICAL: must aggregate artifacts across ALL session nodes'. No elements worth incorporating.

**Simpler variant (skip `lastStepArtifacts`):** The pr-review coordinator reads via HTTP, not via `WorkflowRunSuccess`. Skipping would satisfy the coordinator use case. Rejected because the task spec explicitly requires it, and it's the foundation for `spawn_agent` artifact surfacing (post-MVP).

**Simpler variant (skip `onComplete` change):** Would leave `WorkflowRunSuccess.lastStepArtifacts` always undefined. Rejected -- inconsistent state.

---

## Philosophy Alignment

**Satisfied:** validate-at-boundaries, errors-as-data, functional/declarative, prefer-fakes, exhaustiveness (closed enums), immutability.

**Under tension (accepted):**
- `source?` optional vs. type-safety-first: minor, observability-only field
- `required: false` vs. make-illegal-states-unrepresentable: time-boxed transition strategy

---

## Findings

### RED (must fix before shipping)

**R1: `readVerdictArtifact()` must log on malformed artifact**
If the agent emits an artifact with `kind: 'wr.review_verdict'` but wrong schema, `safeParse` fails silently. Without logging, FM3 (malformed artifact) is invisible and prevents monitoring of the artifact emission rate.

Required: `process.stderr.write('[WARN coord:reason=artifact_parse_failed ...]')` when `safeParse` fails AND the artifact has `kind === 'wr.review_verdict'`.

**R2: Per-node fetch errors must be caught individually**
The current outer `try/catch` in `getAgentResult` covers the entire function. The new implementation walks multiple nodes -- if one node fetch throws, the outer catch aborts the entire aggregation. Each per-node fetch must be wrapped individually so one failure doesn't discard all other nodes' artifacts.

---

### ORANGE (fix before C1 -> C2 graduation)

**O1: Log when keyword scan fires on a session that had artifacts**
The coordinator cannot distinguish 'artifact never emitted' from 'artifact emitted but invalid' without checking. Add a log entry when `readVerdictArtifact` returns null but `artifacts.length > 0`. This enables the graduation metric (10+ sessions with 0 fallback warnings).

Required log: `[INFO coord:source=keyword_scan reason=no_valid_artifact artifactCount=N]`

**O2: Divergence detection warning**
If both artifact severity (from `readVerdictArtifact`) and keyword-scan severity (from `parseFindingsFromNotes`) are available and disagree, log at WARN. Design doc recommends this (ORANGE finding). Protects against semantic inconsistency between notes and artifact.

---

### YELLOW (future consideration)

**Y1: `source?` optional on `ReviewFindings`**
Making `source` required would improve type safety. Currently deferred to avoid breaking 4 existing test literals. When those tests are updated for other reasons, upgrade `source` to required.

**Y2: Post-graduation: remove keyword scan fallback**
Once the graduation criterion is met, `parseFindingsFromNotes` callers can be removed from the coordinator routing logic. The `unknown` severity variant can also be removed from `ReviewSeverity`.

---

## Recommended Revisions

1. **R1:** In `readVerdictArtifact()`, check if `raw` object has `kind === 'wr.review_verdict'` before `safeParse`. If kind matches but safeParse fails, log WARN.
2. **R2:** In `getAgentResult()` implementation, wrap each per-node HTTP fetch in its own try/catch. Failed nodes are skipped with a WARN log; successful nodes contribute their artifacts.
3. **O1:** After the artifact/keyword-scan decision in the coordinator, log `source` with the artifact count context.
4. **O2:** Add divergence check: run keyword scan on `recapMarkdown` when an artifact is found; if severities disagree, log WARN.

---

## Residual Concerns

1. **`continue_workflow` onComplete call site:** `makeContinueWorkflowTool` is marked DEPRECATED for daemon sessions, but it still calls `onComplete`. The new `artifacts?` parameter must be passed from `params.artifacts` at line 1046. Must be verified manually -- TypeScript won't catch a missing optional parameter.

2. **`.strict()` vs. LLM reliability:** If the LLM adds extra fields (e.g., `rationale`, `notes`) to the artifact, `.strict()` causes Zod failure. With `required: false`, this just triggers the keyword-scan fallback. Acceptable during transition. If the failure rate is high in production, consider switching to `.strip()`.

3. **Convention only:** `V1` suffix on `ReviewVerdictArtifactV1Schema` is a convention, not enforced. No migration path exists for schema changes. Future schema evolution must use a new type (`ReviewVerdictArtifactV2Schema`) in parallel until old sessions are retired.
