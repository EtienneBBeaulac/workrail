# Performance Sweep -- April 2026

**Date:** 2026-04-07
**Status:** Discovery complete, issues filed

Six parallel discovery agents audited the full workrail codebase for performance and efficiency issues. This document consolidates all findings.

## Cross-cutting pattern

Every layer independently re-reads and re-computes from raw data on every call. Nothing is shared between layers. The same session event log is scanned 10+ times per `continue_workflow` call across the engine, prompt renderer, and session store.

## Findings by area

### 1. Session store & persistence (`src/v2/infra/local/session-store/`)

- `appendImpl` calls `loadTruthOrEmpty()` before every write -- a full manifest + all segment reads -- even though `ExecutionSessionGateV2` already loaded the session (double disk read per write)
- Two separate `open/write/fsync/close` cycles when snapshot pins are present; should be one
- 200 sequential `stat` calls in `readdirWithMtime` (for-loop, one at a time)
- Segment files read sequentially despite being independent and immutable once written
- `loadHealthySummaries` loads sessions sequentially with no concurrency cap and no cache
- `validateAppendPlan` re-runs Zod parse on every event in the plan -- already trusted data
- Full event payloads read in `loadTruthOrEmpty` just to extract `dedupeKey` fields
- `new TextDecoder()` allocated per segment read (should be module-level singleton)
- `mkdirp(eventsDir)` called on every `append`, not just session creation

### 2. V2 engine core (`src/v2/durable-core/`, `src/mcp/handlers/v2-execution/`)

- `continue_workflow` scans `truth.events` 6+ times per call across `continue-advance.ts`, `input-validation.ts`, `replay.ts` with no shared state
- Session loaded from disk a second time after the advance completes; same events scanned again
- `projectRunContextV2` called in `validateAdvanceInputs` then again inside `renderPendingPrompt`
- `projectAssessmentsV2` runs full scan on every step even when no assessment events exist
- Sortedness validation repeated in every projection (4+ times per advance) on data the store guarantees is sorted
- `createWorkflow(pinned.definition)` called on every advance for the same immutable workflow hash -- never cached
- `pinnedStore.get()` called twice on first-advance path when pin already found
- `deriveWorkflowHashRef` called 3 times with the same input per advance
- `hasPriorNotesInRun` adds a 4th+ event scan inside `renderPendingPrompt`

### 3. Workflow loading & registry (`src/infrastructure/storage/`, `src/mcp/handlers/`)

- N+1 `getWorkflowById` calls per `list_workflows`: 1 list + N individual fetches, then full 5-pass compilation + SHA-256 hash + disk read per workflow on every call
- New AJV instance + schema compilation on every request (`createWorkflowReaderForRequest`)
- Recursive filesystem walk of all remembered-root directories per request with workspace signal
- `CachingWorkflowStorage` uses linear `find` scan instead of `Map` lookup
- `listWorkflowSummaries` triggers full validation pass just to return metadata fields
- `statSync` blocking event loop in index build (`FileWorkflowStorage.buildWorkflowIndex`)
- `workflow.schema.json` re-read and JSON.parsed on every `workflow_get_schema` call
- `listWorkflowSummaries` and `loadAllWorkflows` as two parallel independent index reads

### 4. MCP handler layer (`src/mcp/handlers/`, `src/mcp/handler-factory.ts`)

- Output schema `.parse()` on every hot-path response on data the server itself produced (handlers for `continue_workflow`, `start_workflow`, `list_workflows`, etc. all call `Schema.parse()` on their own output)
- `V2BlockerReportSchema.superRefine()` runs O(n log n) duplicate-check on every parse
- `process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT` read as string comparison per call (not cached)
- `coerceJsonStringObjectFields` rebuilds object-field set from schema shape per call
- `JSON.stringify(..., null, 2)` with indentation on all machine-to-machine wire responses
- `getV2ExecutionRenderEnvelope` called twice per non-execution response
- Schema shape re-traversed on every validation error for suggestion generation

### 5. Console service & data projection (`src/v2/usecases/console-service.ts`)

- Full 500-session disk load + projection rebuild on every `/api/v2/sessions` request, no caching
- `/api/v2/worktrees` calls `getSessionList()` a second time (double the I/O)
- `projectRunDagV2` called 3-4 times on the same event array per session per request
- `resolveRunCompletion` always re-projects the DAG from events even when caller has it
- `projectRunStatusSignalsV2` internally calls `projectRunDagV2` + `projectGapsV2` again
- `projectSessionHealthV2` calls `projectRunDagV2` yet again
- `projectNodeOutputsV2` called twice per session summary (title extraction + recap)
- `projectNodeDetail` runs 5 independent full event-log scans sequentially
- `loadSegmentsRecursive` O(N^2) array allocations via spread per segment

### 6. Prompt rendering & content assembly (`src/v2/durable-core/domain/`)

- `renderPendingPrompt` runs 3 independent full-event-log projections (`projectRunContextV2`, `projectRunDagV2`, `projectNodeOutputsV2`) plus `hasPriorNotesInRun` scan
- `resolveParentLoopStep` and `getStepById` both do double-nested workflow traversal on every render
- `expandFunctionDefinitions` re-searches workflow definition on every call
- `buildChain`/`buildPathBackward` in `recap-recovery.ts` allocate O(N^2) `Set` objects per ancestry traversal
- `renderBudgetedRehydrateRecovery` encodes the same string 3 times in the budget-trim loop
- Tier lookup functions use `Array.find` over constant 2-3 element arrays (should be `Record`)
- Shared mutable global `g`-flag regex in `context-template-resolver.ts` (latent correctness bug)
- `dotPath.split('.')` allocates new array on every template token match
- `JSON.stringify` for node deduplication equality in `projectRunDagV2`

## Highest-leverage fixes

| Priority | Fix | Areas | Issues |
|---|---|---|---|
| 1 | `SessionIndex`: build once at load, thread through engine + renderer | Engine, renderer | #248 |
| 2 | `(sessionId, mtime)` projection cache in console service | Console | #249 |
| 3 | Remove output-side Zod `.parse()` on server-produced responses | MCP | #250 |
| 4 | Thread loaded session into `appendImpl` (eliminate double disk read) | Session store | #252 |
| 5 | Cache `createWorkflow` by hash; fix AJV singleton; fix fs walk | Engine, workflows | #254, #256 |
| 6 | Parallelize serial I/O (stat loop, segment reads) | Session store | #253 |
| 7 | Pre-index step/loop/function lookups at Workflow construction | Engine, renderer | #255 |
| 8 | Fix N+1 workflow fetches and recursive fs walk per request | Workflows | #256 |
| 9 | Fix serialization overhead (JSON indent, env vars, coercion) | MCP | #251 |
| 10 | Fix O(N^2) ancestry + budget loop re-encoding + minor allocations | Renderer | #257 |
