# CONTEXT.md — Console CPU Spiral Fix (Issue #240)

**Workflow:** coding-task-workflow-agentic v1.5.0  
**Date:** 2026-04-06  
**Status:** Planning phase — context gathered, ready for implementation

---

## 1. Task Summary

Fix a three-part feedback loop causing 140% CPU usage in the workrail MCP server console. A `continue_workflow` call writes session files, `fs.watch` fires, SSE broadcasts `change`, the client invalidates both `['sessions']` and `['worktrees']` queries, the worktrees endpoint fans out to 606 concurrent git subprocesses (12.5s), the response triggers more session writes, and the loop repeats. Three targeted changes break the loop: (1) remove worktrees invalidation from the SSE handler, (2) cap git subprocess concurrency to 8, (3) filter the `fs.watch` callback to `.jsonl` files only.

---

## 2. Conversation Preferences

- No emojis in code or docs
- No em-dashes in written content
- Prefer architectural fixes over patches (coding philosophy)
- Do not commit .md files unless explicitly asked
- Errors as values (Result types), not exceptions

---

## 3. Triage

- **rigorMode:** STANDARD
- **auditDepth:** normal
- **maxQuestions:** 3
- **maxParallelism:** 1
- **taskComplexity:** Medium
- **riskLevel:** Low
- **automationLevel:** High
- **docDepth:** None (CONTEXT.md + implementation_plan.md only)
- **prStrategy:** SinglePR

---

## 3b. Environment Capabilities

- **delegationMode:** solo (MCP tools not available in Claude Code CLI; workrail MCP is Claude Desktop only)

---

## 4. Inputs and Sources

- GitHub issue: EtienneBBeaulac/workrail#240
- Design doc: `/Users/etienneb/git/personal/workrail/docs/design/console-performance-discovery.md` (Candidate D selected)
- Target files (all read):
  - `console/src/api/hooks.ts` (Change 1)
  - `src/v2/usecases/worktree-service.ts` (Change 2)
  - `src/v2/usecases/console-routes.ts` (Change 3)

---

## 5. User Rules and Philosophies (`userRules`)

From AGENTS.md, CLAUDE.md, and codebase patterns:

- Immutability by default; mutation behind explicit APIs
- Architectural fixes over patches — change invariants, not add special cases
- Errors as data — Result types, not throw
- Validate at boundaries, trust inside
- Determinism over cleverness
- Compose with small, pure functions
- YAGNI with discipline
- Document "why", not "what"
- No emojis in code or docs
- No em-dashes in written content
- No auto-commit of .md files
- Branch naming: `fix/etienneb/<name>`
- Commit type: `fix(console)` for this work
- Do not throw exceptions

---

## 6. Decision Log

### Entry 1: Triage and Approach Selection (Phase 0)

- **Decision:** STANDARD rigor, SinglePR, taskComplexity=Medium, automationLevel=High
- **Why:** 3 files touched, all changes are pre-designed in the discovery doc, no business unknowns, requirements fully specified
- **Alternatives:** THOROUGH rigor was considered but overkill given the design doc already captured landscape, candidates, and adversarial challenges
- **Impacted files:** console/src/api/hooks.ts, src/v2/usecases/worktree-service.ts, src/v2/usecases/console-routes.ts
- **User feedback:** N/A (automationLevel=High)
- **Surprises:** None; design doc is comprehensive

### Entry 2: Architecture Selection (from design doc)

- **Decision:** Candidate D (Compound Fix) as selected in design doc
- **Why:** Breaks the feedback loop at all three layers; each change is independently valuable; minimum implementation complexity; can be implemented in hours
- **Alternatives:** Candidate A (Typed SSE Events) is the right long-term model but adds server-side watcher lifecycle complexity; deferred as follow-on
- **Impacted files:** Same 3 files above
- **User feedback:** Design doc reflects user-approved direction
- **Surprises:** The `fs.watch` callback in console-routes.ts does not filter by filename — fires for any file change in the sessions directory, including non-.jsonl temp files. This confirms Change 3 is necessary.

---

## 7. Unexpected Discoveries and Deviations

- `watchSessionsDir` in console-routes.ts calls `broadcastChange()` unconditionally on every `fs.watch` callback. The callback signature is `(eventType, filename)` — `filename` is available and can be used to filter to `.jsonl` only.
- The `broadcastChange` debounce is 200ms — this is already in the code. Change 3 reduces the events that reach it, but the debounce remains useful.
- The `fs.watch` callback in Node.js receives `(eventType: string, filename: string | null)` — `filename` can be null on some platforms. The filter must guard against null.

---

## 8. Relevant Files (max 10)

| File | Why it matters |
|------|----------------|
| `console/src/api/hooks.ts` | Change 1: remove `invalidateQueries(['worktrees'])` from `useWorkspaceEvents` |
| `src/v2/usecases/worktree-service.ts` | Change 2: add semaphore around `enrichWorktree` |
| `src/v2/usecases/console-routes.ts` | Change 3: filter `fs.watch` callback to `.jsonl` files |
| `docs/design/console-performance-discovery.md` | The authoritative design document for this fix |

---

## 9. Artifacts Index

- `CONTEXT.md` (this file) — workflow execution log
- `implementation_plan.md` — to be created in Phase 5 planning

---

## 10. Progress

- [x] Phase 0: Triage
- [x] Phase 0b: Minimum inputs gate
- [x] Phase 0c: Base context doc (this file)
- [x] Phase 1: Context gathering
- [x] Phase 2: Invariants
- [x] Phase 3+: Architecture and slices (design doc pre-selected Candidate D)
- [x] Implementation: all 3 changes complete
- [x] Verification: `npm run build` passes; `npx vitest run` passes (pre-existing git/integration failures unrelated to changes)

**Branch:** fix/etienneb/console-cpu-spiral (to be created)  
**Status:** Ready for PR

---

## Machine State Checkpoint

*Will be populated after first workflow_next call (not applicable — running workflow manually).*
