# Delivery Adapter Phase 1 -- Implementation Plan (revised)

**Scope:** Add DeliveryAdapter interface infrastructure. Zero behavior change.
**Revision:** Migration shim deferred to Phase 2. Three blocking findings from plan audit addressed.

---

## Problem Statement

Workflow outputs have no configurable, platform-agnostic delivery path. This phase establishes the interface contract and config resolution layer that Phase 2 will activate.

## Acceptance Criteria

1. `npx vitest run` passes with no regressions
2. `tsc --noEmit` passes clean
3. No existing triggers.yml file requires modification
4. `WorkflowTrigger.deliveryConfig` is optional; all existing construction sites compile without change
5. `resolveDeliveryConfig(undefined, 'any-workflow', {})` returns `{ adapters: [{ kind: 'cli_inbox' }] }` (CLI inbox fallback)
6. `CliInboxAdapter.deliver()` writes a valid `{ id, message, timestamp }` entry to the outbox path and returns `{ kind: 'completed' }`
7. No imports from `src/trigger/` into `src/cli/commands/` (circular import check passes)

## Non-Goals

- Calling `adapter.deliver()` anywhere in production code paths (Phase 2)
- Migration shim synthesizing deliveryConfig from legacy fields (Phase 2 -- deferred, see rationale below)
- GitHub draft review adapter (Phase 2)
- Async polling / sidecar format (Phase 2)
- Gate inheritance of delivery config (Phase 2)
- `delivery_planned` session event (Phase 3)
- Deprecating `reviewerIdentity` field (Phase 3)
- GitLab / Slack adapters (Phase 4)
- `TriggerDefinition.deliveryConfig` field -- not needed in Phase 1 since no forwarding occurs yet

## Rationale for deferring migration shim

Phase 1 never calls `adapter.deliver()`. A migration shim that synthesizes `deliveryConfig` from `autoCommit`, `autoOpenPR`, `reviewerIdentity`, and `callbackUrl` in Phase 1 would be dead code -- the synthesized value is never read. Worse: the semantics of multi-adapter synthesis (e.g., a trigger with both `autoCommit: true` and `reviewerIdentity` set) require reasoning about delivery ordering that is only meaningful when `adapter.deliver()` is actually called. The shim must be written at the same time as the adapter call in Phase 2, when the ordering constraints are visible and testable.

## Philosophy-Driven Constraints

- `AdapterConfig` and `DeliveryReceipt` must be closed discriminated unions
- `DeliveryAdapter<K extends AdapterConfig['kind']>` must use a generic narrowed config type -- each adapter receives only its own config variant
- `DeliveryAdapter.adapterKind` must be `AdapterConfig['kind']` (constrained to the closed set, not `string`)
- `resolveDeliveryConfig()` must be a pure function: no I/O, no side effects
- `DeliveryAdapter.deliver()` must never throw -- errors flow as `DeliveryReceipt { kind: 'error' }`
- `DeliveryAdapter` lives in `src/trigger/` not `src/daemon/`
- `CliInboxAdapter` defines its outbox entry shape inline -- no import from `src/cli/commands/`
- `PollHandle.state: Record<string,unknown>` is an accepted tradeoff (adapter independence); bounded by `adapterId: AdapterConfig['kind']` discriminant (not unbranded `string`)

## Invariants

- `WorkflowTrigger.deliveryConfig` is always optional -- all existing callers compile without change
- `resolveDeliveryConfig()` always returns at least `{ adapters: [{ kind: 'cli_inbox' }] }` -- CLI inbox is the zero-config fallback
- `maybeRunDelivery()` and `maybeRunPostWorkflowActions()` are untouched
- No new hard errors added to `validateAndResolveTrigger()` in Phase 1 -- therefore `validateTriggerStrict()` sync invariant is preserved
- `TriggerDefinition` gains no new fields in Phase 1

---

## Selected Approach

New module `src/trigger/delivery-adapter.ts` containing:
- `AdapterConfig` discriminated union
- `DeliveryConfig` type: `{ readonly adapters: readonly AdapterConfig[] }`
- `PollHandle` type: `{ readonly adapterId: AdapterConfig['kind']; readonly state: Readonly<Record<string, unknown>> }`
- `DeliveryReceipt` discriminated union
- `DeliveryPayload` type
- `DeliveryAdapter<K extends AdapterConfig['kind']>` generic interface
- `resolveDeliveryConfig()` pure function
- `CliInboxAdapter` class implementing `DeliveryAdapter<'cli_inbox'>`

`WorkflowTrigger` in `src/daemon/types.ts` gains `readonly deliveryConfig?: DeliveryConfig`.

No changes to `TriggerDefinition`, `trigger-store.ts`, or `trigger-router.ts` in Phase 1.

---

## Vertical Slices

### Slice 1: Core types + interface in `src/trigger/delivery-adapter.ts`

New file. Key types:

```typescript
export type AdapterConfig =
  | { readonly kind: 'cli_inbox' }
  | { readonly kind: 'github_draft_review'; readonly token: string; readonly login: string }
  | { readonly kind: 'gitlab_mr_note'; readonly token: string; readonly baseUrl: string; readonly projectId: string }
  | { readonly kind: 'slack_webhook'; readonly webhookUrl: string }
  | { readonly kind: 'callback_url'; readonly url: string }
  | { readonly kind: 'git_commit'; readonly autoOpenPR: boolean; readonly secretScan: boolean };

export interface DeliveryConfig {
  readonly adapters: readonly AdapterConfig[];
}

export interface PollHandle {
  // WHY adapterId is AdapterConfig['kind'] (not string): constrained to the closed set of
  // known adapter kinds so startup recovery can exhaustively switch on it.
  readonly adapterId: AdapterConfig['kind'];
  readonly state: Readonly<Record<string, unknown>>; // adapter-specific; opaque at interface level
}

export type DeliveryReceipt =
  | { readonly kind: 'completed'; readonly destination: string }
  | { readonly kind: 'pending'; readonly pollHandle: PollHandle }
  | { readonly kind: 'error'; readonly message: string; readonly retryable: boolean };

export interface DeliveryPayload {
  readonly workflowId: string;
  readonly sessionId: string; // always available when deliver() is called
  readonly notes: string | null;
  readonly artifacts: readonly unknown[];
  readonly goal: string;
}

// WHY generic: each adapter receives only its own config variant (narrowed), not the full union.
// This prevents adapters from defensively narrowing what the type system already knows.
export interface DeliveryAdapter<K extends AdapterConfig['kind'] = AdapterConfig['kind']> {
  readonly adapterKind: K; // constrained to AdapterConfig['kind'], not string
  deliver(
    payload: DeliveryPayload,
    config: Extract<AdapterConfig, { kind: K }>,
  ): Promise<DeliveryReceipt>;
}

export function resolveDeliveryConfig(
  triggerDeliveryConfig: DeliveryConfig | undefined,
  _workflowId: string,
  _globalConfig: Readonly<Record<string, unknown>>,
): DeliveryConfig {
  // Phase 1: trigger-level config or CLI inbox fallback. Workflow-type and global config
  // tiers added in Phase 2 when the resolver is actually called.
  return triggerDeliveryConfig ?? { adapters: [{ kind: 'cli_inbox' }] };
}
```

**Done when:** `tsc --noEmit` passes. Unit test: `resolveDeliveryConfig(undefined, 'x', {})` returns CLI inbox.

### Slice 2: `CliInboxAdapter`

Add to `src/trigger/delivery-adapter.ts`:

```typescript
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// WHY inline (not imported from cli/commands/worktrain-inbox.ts):
// src/trigger/ must not import from src/cli/commands/ (architecture direction violation).
// The three-field shape is stable and trivial to define here.
interface OutboxEntry {
  readonly id: string;
  readonly message: string;
  readonly timestamp: string;
}

export class CliInboxAdapter implements DeliveryAdapter<'cli_inbox'> {
  readonly adapterKind = 'cli_inbox' as const;
  constructor(private readonly workrailDir: string) {}

  async deliver(
    payload: DeliveryPayload,
    _config: Extract<AdapterConfig, { kind: 'cli_inbox' }>,
  ): Promise<DeliveryReceipt> {
    const outboxPath = path.join(this.workrailDir, 'outbox.jsonl');
    const entry: OutboxEntry = {
      id: randomUUID(),
      message: `[${payload.workflowId}] ${payload.goal}`,
      timestamp: new Date().toISOString(),
    };
    try {
      await fs.appendFile(outboxPath, JSON.stringify(entry) + '\n', 'utf-8');
      return { kind: 'completed', destination: outboxPath };
    } catch (err) {
      return { kind: 'error', message: String(err), retryable: false };
    }
  }
}
```

**Done when:** Unit test: `CliInboxAdapter.deliver()` writes a parseable JSON line and returns `{ kind: 'completed' }`.

### Slice 3: `WorkflowTrigger.deliveryConfig` optional field

In `src/daemon/types.ts`, add to `WorkflowTrigger`:

```typescript
import type { DeliveryConfig } from '../trigger/delivery-adapter.js';

// Inside WorkflowTrigger interface:
/**
 * Delivery configuration resolved from trigger/workflow-type/global config.
 * When absent: CLI inbox is the fallback (handled by resolveDeliveryConfig()).
 * Populated by trigger-router.ts in Phase 2 when adapter.deliver() is first called.
 *
 * WHY optional: zero-change contract for all existing WorkflowTrigger construction sites.
 * WHY on WorkflowTrigger (not just TriggerDefinition): dispatch() callers receive
 * WorkflowTrigger directly and need delivery config without requiring a triggerId lookup.
 */
readonly deliveryConfig?: DeliveryConfig;
```

**Done when:** `tsc --noEmit` passes; all existing `WorkflowTrigger` construction sites compile without change; no changes to trigger-router.ts needed.

---

## Test Design

| Test | File | What it verifies |
|---|---|---|
| `resolveDeliveryConfig(undefined, ...)` returns CLI inbox | `tests/unit/delivery-adapter.test.ts` | CLI inbox zero-config fallback |
| `resolveDeliveryConfig({ adapters: [...] }, ...)` returns provided config | `tests/unit/delivery-adapter.test.ts` | Trigger-level config wins |
| `CliInboxAdapter.deliver()` writes JSON line + returns completed | `tests/unit/delivery-adapter.test.ts` | Adapter write contract |
| `CliInboxAdapter.deliver()` returns error (not throw) when fs.appendFile fails | `tests/unit/delivery-adapter.test.ts` | Errors as data |
| `AdapterConfig` union exhaustiveness (tsc) | compile-time | All variants handled |
| No imports from trigger/ into cli/commands/ | tsc + existing architecture test | Circular import prevention |

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Circular import trigger/ → cli/commands/ | ORANGE (resolved) | Inline OutboxEntry type in delivery-adapter.ts |
| `validateTriggerStrict()` sync invariant | ORANGE (resolved) | Phase 1 adds no new hard errors to validateAndResolveTrigger |
| Migration shim ordering/double-delivery trap | ORANGE (resolved) | Shim deferred to Phase 2 |
| Phase 1 sits as dead infrastructure | LOW | Phase 2 is planned next step |

---

## PR Packaging

SinglePR. Branch: `feat/etienneb/delivery-adapter-phase1`. Slices 1-3 in one PR.

PR description must state: "Phase 1 adds type infrastructure only. No production code calls `adapter.deliver()`. `maybeRunDelivery()` and `maybeRunPostWorkflowActions()` are untouched. Migration shim deferred to Phase 2."

---

## Philosophy Alignment

| Principle | Status | Why |
|---|---|---|
| Make illegal states unrepresentable | Satisfied | Closed discriminated unions; generic adapter narrows config |
| Types must constrain, not just label | Satisfied | `adapterKind: AdapterConfig['kind']` not `string`; generic `K` constrains config |
| Functional core / imperative shell | Satisfied | `resolveDeliveryConfig()` pure; `CliInboxAdapter.deliver()` imperative |
| Errors as data | Satisfied | `DeliveryReceipt` error variant; no throws |
| Exhaustiveness everywhere | Satisfied | Discriminated unions; switch-exhaustive possible |
| Dependency injection | Satisfied | `DeliveryAdapter` is an interface; `workrailDir` injected into `CliInboxAdapter` |
| Zero LLM turns for routing | Satisfied | `resolveDeliveryConfig()` is deterministic TypeScript |
| YAGNI with discipline | Tension (acceptable) | Phase 1 builds interface not yet called; justified as Phase 2 foundation with clear seam |
| PollHandle.state opaque blob | Tension (accepted) | `adapterId: AdapterConfig['kind']` bounds the tradeoff; widen to typed union in Phase 2 |
