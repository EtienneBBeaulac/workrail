# Implementation Plan: Label-Based Queue Filter for github_queue_poll

## Problem Statement

The `github_queue_poll` trigger supports `queueType: label` and `queueLabel: "worktrain:ready"` in `triggers.yml`, but these fields are silently ignored. The `GitHubQueueConfig` type supports `type: 'label'` but throws `not_implemented` at runtime. Label-based queue filtering lets WorkTrain pick up issues without a dedicated bot account -- any issue labeled `worktrain:ready` becomes a candidate.

---

## Acceptance Criteria

1. `pollGitHubQueueIssues()` with `config.type === 'label'` and `config.queueLabel === 'worktrain:ready'` sends `GET /repos/:owner/:repo/issues?state=open&labels=worktrain%3Aready&per_page=100`
2. `pollGitHubQueueIssues()` with `config.type === 'label'` and no `config.queueLabel` returns `err({ kind: 'not_implemented', ... })` (config validation error path)
3. `pollGitHubQueueIssues()` with `config.type === 'assignee'` still works (regression)
4. `loadQueueConfig()` with `type: 'label'` and no `queueLabel` field in config.json returns `err(...)` (not `ok`)
5. `loadQueueConfig()` with `type: 'label'` and `queueLabel: 'worktrain:ready'` returns `ok(config)` with `config.queueLabel === 'worktrain:ready'`
6. `trigger-store.ts` parses `queueType` and `queueLabel` from triggers.yml into `GitHubQueuePollingSource`
7. `npm run build` succeeds (no TypeScript errors)
8. `npx vitest run tests/unit/github-queue-poller.test.ts` -- all tests pass
9. `npx vitest run` -- no regressions

---

## Non-Goals

- Do not touch `src/mcp/`
- Do not touch `polling-scheduler.ts`
- Do not implement `mention` or `query` queue types
- Do not refactor surrounding code
- Do not remove the existing `name?` field from `GitHubQueueConfig`

---

## Philosophy-Driven Constraints

- All boundary functions return `Result<T, E>` -- no throws
- All new interface fields are `readonly`
- Validation at load time (`loadQueueConfig`): err if `type==='label'` and `queueLabel` absent
- Defensive else branch in `pollGitHubQueueIssues`: unknown types return `not_implemented`
- `encodeURIComponent` / URLSearchParams for URL safety

---

## Invariants

- I1: `pollGitHubQueueIssues` with `type='assignee'` and `config.user` sends `assignee=<user>` param (unchanged)
- I2: `pollGitHubQueueIssues` with `type='label'` and `config.queueLabel` sends `labels=<encoded>` param
- I3: `pollGitHubQueueIssues` with `type='label'` and no `config.queueLabel` returns `err({ kind: 'not_implemented' })`
- I4: `pollGitHubQueueIssues` with any other type returns `err({ kind: 'not_implemented' })`
- I5: `loadQueueConfig` with `type='label'` and no `queueLabel` key in config.json returns `err(string)`
- I6: No throws at any boundary

---

## Selected Approach

**Additive optional field + load-time validation + poller URL branch**

Four changes:
1. `GitHubQueueConfig` interface: add `readonly queueLabel?: string`
2. `loadQueueConfig()`: parse `q['queueLabel']`, validate it when `type==='label'`
3. `GitHubQueuePollingSource` (types.ts): add `readonly queueType?: string`, `readonly queueLabel?: string`
4. `trigger-store.ts`: parse `queueType`/`queueLabel` in `ParsedTriggerRaw` + `setTriggerField()` + assembly block
5. `pollGitHubQueueIssues()`: replace hard not_implemented guard with assignee/label/else branching

Runner-up was discriminated union -- rejected due to scope constraint and unnecessary complexity for this bounded change.

---

## Vertical Slices

### Slice 1: `github-queue-config.ts` -- add `queueLabel` field + validation
**Files**: `src/trigger/github-queue-config.ts`
**What**: Add `readonly queueLabel?: string` to `GitHubQueueConfig` interface. In `loadQueueConfig()`, parse `q['queueLabel']` and add validation: if `rawType === 'label'` and `!queueLabel`, return `err('config.queue.queueLabel is required when type is "label"')`. Build the return object with `queueLabel` when present.
**Done when**: Interface has `queueLabel?`, validation fires correctly, `npm run build` clean.

### Slice 2: `types.ts` -- extend `GitHubQueuePollingSource`
**Files**: `src/trigger/types.ts`
**What**: Add `readonly queueType?: string` and `readonly queueLabel?: string` to `GitHubQueuePollingSource`.
**Done when**: Fields present in interface, build clean.

### Slice 3: `trigger-store.ts` -- parse `queueType`/`queueLabel` from YAML
**Files**: `src/trigger/trigger-store.ts`
**What**: 
- Add `queueType?: string` and `queueLabel?: string` to `ParsedTriggerRaw` interface
- Handle them in `setTriggerField()` switch
- In the `github_queue_poll` assembly block, read `raw.queueType` and `raw.queueLabel` and include them in the `GitHubQueuePollingSource` object
**Done when**: `triggers.yml` `self-improvement` trigger parses correctly with these fields; build clean.

### Slice 4: `github-queue-poller.ts` -- implement label branch
**Files**: `src/trigger/adapters/github-queue-poller.ts`
**What**: Replace the current `if (config.type !== 'assignee') return err(not_implemented)` guard with:
```typescript
if (config.type === 'assignee' && config.user) {
  url.searchParams.set('assignee', config.user);
} else if (config.type === 'label' && config.queueLabel) {
  url.searchParams.set('labels', config.queueLabel);
} else {
  return err({ kind: 'not_implemented', message: `Queue type "${config.type}" is not yet implemented` });
}
```
Remove the old `if (config.user)` block that was AFTER the guard.
Update JSDoc to reflect both supported types.
**Done when**: Function correctly handles both assignee and label, build clean.

### Slice 5: Tests -- update + add new tests
**Files**: `tests/unit/github-queue-poller.test.ts`
**What**:
- REPLACE existing test at line 126 (`returns not_implemented for non-assignee queue type`) -- this test currently expects not_implemented for `{type: 'label', name: 'my-label'}`. It MUST be replaced, not kept.
- ADD: `type: 'label'` with `queueLabel: 'worktrain:ready'` -> fetches with `labels=worktrain%3Aready` param
- ADD: `type: 'label'` without `queueLabel` -> returns err with kind not_implemented (or config validation path)
- KEEP as regression: `type: 'assignee'` test at line 105 (already tests assignee param)
- Update `makeConfig()` helper: `name?` field can stay but add examples with `queueLabel`
**Done when**: `npx vitest run tests/unit/github-queue-poller.test.ts` all pass.

---

## Test Design

| Test | Expected behavior | Assertion |
|------|-------------------|-----------|
| label type + queueLabel | fetches with `labels=` param | URL contains `labels=worktrain%3Aready` |
| label type + no queueLabel | returns not_implemented | `result.error.kind === 'not_implemented'` |
| assignee type + user (regression) | fetches with `assignee=` param | URL contains `assignee=bob` |

Existing tests for network_error, http_error, rate_limit, field mapping, maturity, idempotency: unchanged.

---

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Forgetting to replace test at line 126 | High | CI fails | Explicit: replace that test first |
| `polling-scheduler.ts` guard still blocks end-to-end | Certain | Production feature blocked | Document in PR description as follow-up |
| URL encoding of `:` in `worktrain:ready` | Low | Wrong API call | Use `url.searchParams.set()` which encodes automatically |

---

## PR Packaging Strategy

Single PR: `feat/queue-label-support`
Commit: `feat(trigger): implement label-based queue filter for github_queue_poll`

PR description should note: the `polling-scheduler.ts` guard at line 393 still checks `queueConfig.type !== 'assignee'` and will need a follow-up update for end-to-end production use. This PR implements the foundational layer.

---

## Philosophy Alignment Per Slice

| Slice | Principle | Status |
|-------|-----------|--------|
| 1 (config) | validate-at-boundaries | satisfied: err if type=label and queueLabel absent |
| 1 (config) | immutability by default | satisfied: readonly field |
| 2 (types) | explicit domain types | satisfied: typed fields not raw strings |
| 3 (trigger-store) | validate-at-boundaries | satisfied: queueType parsed and stored |
| 4 (poller) | Result types, no throws | satisfied: err() return, no throw |
| 4 (poller) | exhaustiveness | tension: else branch catches unknowns but not exhaustive switch |
| 5 (tests) | prefer fakes over mocks | satisfied: injectable fetchFn mock |
