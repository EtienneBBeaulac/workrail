# Design: Full Pipeline Delivery Architecture

**Status:** Complete (wr.discovery session)
**Confidence:** High | **Selection tier:** strong_recommendation
**Design doc:** this file

---

## Problem

WorkTrain's autonomous full pipeline produces zero repository output. Sessions complete but no commit, PR, or merge ever happens. Three distinct failures:

1. **No branch isolation** -- `spawnSession('wr.coding-task')` omits `branchStrategy: 'worktree'`; coding session writes directly to main workspace checkout
2. **No delivery** -- no code path calls `git commit` or `gh pr create` for coordinator-spawned sessions
3. **Hollow merge** -- `{ kind: 'merged' }` is returned at `implement-shared.ts:132` without calling `deps.mergePR()`

---

## Selected Direction: Candidate A-revised

**Mechanism (7 changes):**

1. `spawnSession()` in `coordinator-deps.ts` accepts optional `branchStrategy?: 'worktree'`; passed ONLY for coding sessions, not discovery/shaping/review
2. New `src/coordinators/coordinator-delivery.ts`: `runCoordinatorDelivery(deps, recapMarkdown: string | null, branchName: string, workspacePath: string)` -- calls `parseHandoffArtifact(recapMarkdown)` for delivery content (`commitType`, `prTitle`, `prBody`), then `runDelivery()` from `delivery-action.ts`
3. `full-pipeline.ts` and `implement.ts`: after `getAgentResult()`, extract `CodingHandoffArtifactV1.branchName` from artifacts (for `pollForPR()`), then call `runCoordinatorDelivery(deps, recapMarkdown, artifact.branchName, workspace)`
4. `pollForPR()` called with `artifact.branchName` (not the wrong `codingHandle.slice(0,16)` pattern)
5. New `extractPrNumberFromUrl(prUrl: string): number | null` utility (parses `/pull/123`) for the merge call
6. `implement-shared.ts:132`: call `deps.mergePR(extractPrNumberFromUrl(prUrl), opts.workspace)` before returning `{ kind: 'merged' }`
7. Add observability log when `recapMarkdown` is null/empty (delivery skipped)

**Short-term complement (do first, 2 hours, zero risk):** Add commit instruction to `BASE_SYSTEM_PROMPT` in `src/daemon/core/system-prompt.ts`. Source: Claude Code coordinator prompt pattern. Closes delivery immediately for all daemon sessions without any engine change.

---

## Why this design

**`CodingHandoffArtifactV1` and `HandoffArtifact` are different types.** Critical finding from fresh-context validation:
- `CodingHandoffArtifactV1` has: `branchName`, `filesChanged`, `keyDecisions` (for review/audit context)
- `HandoffArtifact` (what `runDelivery()` needs) has: `commitType`, `commitScope`, `commitSubject`, `prTitle`, `prBody`
- The typed artifact is used ONLY for `branchName` (to fix the `pollForPR()` mismatch)
- The delivery content comes from `parseHandoffArtifact(recapMarkdown)` -- the handoff JSON block the coding workflow embeds in step notes

**`runDeliveryPipeline()` cannot be reused** -- it imports `WorkflowRunSuccess` and `DAEMON_SESSIONS_DIR` (daemon-only types). New standalone `runCoordinatorDelivery()` is the correct seam.

**`branchName` is a backward-pass field** (agent reports what it used) -- coordinator does not inject it forward. This is simpler and more reliable than coordinator-generated branch names.

---

## Runner-up

**Candidate C: delivery-as-first-class-phase** -- eliminated by YAGNI (no second consumer justifies the phase abstraction) and because the forward-injection model inverts the established data flow. `branchName` is already in the typed artifact.

---

## Residual Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `recapMarkdown` null (coding session ends early) | Tactical | Log + escalate; pipeline does not silently proceed |
| `branchName` in artifact incorrect | Tactical | `git push origin <badBranch>` fails → clear error |
| Worktree cleanup not owned by coordinator delivery | Follow-up | Startup recovery prunes orphaned worktrees |
| Crash-recovery may re-invoke delivery | Tactical | Duplicate PR attempt fails with `gh` error (non-silent) |
| `extractPrNumberFromUrl` returns null for malformed URL | Tactical | `mergePR(null)` → error path → escalation |

---

## Also from Claude Code Research (separate session)

The Claude Code research brief (`research/wr-research-ccloop-001/brief.md`) confirmed:
- **Worker self-commit via system prompt** closes B1+B6 immediately (2h, zero risk) -- the prompt-only short-term fix
- **Parallel tool execution** uses a 4-axis safety classification (`isConcurrencySafe`, `isReadOnly`, `isDestructive`, `interruptBehavior`) with `partitionToolCalls()` batching -- directly applicable to WorkRail's AgentLoop backlog item
- **Token-velocity stuck detection** (3+ continuations with delta < 500 tokens) is a complement to WorkRail's existing `repeated_tool_call` heuristic

---

## Key Codebase Locations

| File | Relevance |
|---|---|
| `src/coordinators/modes/full-pipeline.ts:632` | `branchPattern` wrong ID -- O1 fix here |
| `src/coordinators/modes/implement-shared.ts:132` | Hollow `{ kind: 'merged' }` -- add `mergePR()` call |
| `src/trigger/coordinator-deps.ts:237` | `spawnSession()` -- add `branchStrategy` param |
| `src/trigger/delivery-action.ts` | `runDelivery()` -- reuse for coordinator delivery |
| `src/v2/durable-core/schemas/artifacts/phase-handoff.ts:103` | `CodingHandoffArtifactV1.branchName` -- read for pollForPR |
| `src/daemon/core/system-prompt.ts:44` | `spawn_agent` entry -- add commit instruction here |

---

## Next Actions

1. **Now (2h, zero risk):** Add commit instruction to `BASE_SYSTEM_PROMPT`
2. **Next PR:** Implement the 7 changes above in a single PR
3. **Follow-up:** Worktree cleanup ownership for coordinator sessions
