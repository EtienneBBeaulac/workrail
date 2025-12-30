# v2 Lock Enforcement Coverage Report

> **Auto-generated** — Do not edit manually.
> Registry version: 1.0.0

---

## Summary

| Metric | Value |
|--------|-------|
| Total locks | 109 |
| Covered | 109 |
| Uncovered | 0 |
| Coverage | **100%** |

## Coverage by Category

| Category | Total | Covered | % |
|----------|-------|---------|---|
| architecture | 5 | 5 | 100% |
| bundle | 6 | 6 | 100% |
| errors | 8 | 8 | 100% |
| hashing | 4 | 4 | 100% |
| model | 3 | 3 | 100% |
| projection | 3 | 3 | 100% |
| protocol | 14 | 14 | 100% |
| schema | 32 | 32 | 100% |
| storage | 16 | 16 | 100% |
| tokens | 16 | 16 | 100% |
| types | 2 | 2 | 100% |

## Covered Locks

<details>
<summary>Click to expand (109 locks)</summary>

| Lock ID | Test Files |
|---------|------------|
| `ack-idempotency-key` | `tests/unit/v2/session-store-idempotency-with-fakes.test.ts`, `tests/unit/v2/session-store-idempotency.test.ts` |
| `ack-replay-idempotent` | `tests/unit/v2/session-store-idempotency-with-fakes.test.ts`, `tests/unit/v2/session-store-idempotency.test.ts` |
| `ack-token-payload-fields` | `tests/unit/v2/tokens.test.ts` |
| `advance-append-capable` | `tests/unit/v2/v2-execution-protocol.test.ts` |
| `append-plan-atomic` | `tests/unit/v2/session-store-idempotency-with-fakes.test.ts`, `tests/unit/v2/session-store-idempotency.test.ts`, `tests/unit/v2/session-store.test.ts` |
| `autonomy-closed-set` | `tests/unit/v2/schema-locks.test.ts` |
| `blocker-budget` | `tests/unit/v2/budget-enforcement.test.ts` |
| `blocker-codes-closed-set` | `tests/unit/v2/schema-locks.test.ts` |
| `branded-id-types` | `tests/unit/v2/ids.test.ts` |
| `budget-enforcement` | `tests/unit/v2/notes-markdown.test.ts` |
| `bundle-errors-closed-set` | `tests/unit/v2/export-bundle-schema.test.ts` |
| `bundle-format-single-json` | `tests/unit/v2/export-bundle-schema.test.ts` |
| `bundle-import-as-new` | `tests/unit/v2/export-bundle-schema.test.ts` |
| `bundle-import-validates-first` | `tests/unit/v2/export-bundle-schema.test.ts` |
| `bundle-integrity-jcs-sha256` | `tests/unit/v2/export-bundle-schema.test.ts` |
| `bundle-tokens-not-portable` | `tests/unit/v2/export-bundle-schema.test.ts` |
| `checkpoint-idempotency` | `tests/unit/v2/tokens.test.ts` |
| `checkpoint-token-payload-fields` | `tests/unit/v2/tokens.test.ts` |
| `context-budget-256kb` | `tests/unit/v2/v2-execution-protocol.test.ts` |
| `context-json-only` | `tests/unit/v2/v2-execution-protocol.test.ts` |
| `context-no-echo` | `tests/unit/v2/v2-execution-protocol.test.ts` |
| `context-not-durable` | `tests/unit/v2/v2-execution-protocol.test.ts` |
| `crash-safe-append` | `tests/unit/v2/session-store.test.ts` |
| `crash-state-detection` | `tests/unit/v2/session-store.test.ts` |
| `data-dir-workrail-owned` | `tests/unit/v2/data-dir.test.ts` |
| `decision-trace-bounded` | `tests/unit/v2/budget-enforcement.test.ts` |
| `dedupe-key-idempotent` | `tests/unit/v2/session-store-idempotency-with-fakes.test.ts`, `tests/unit/v2/session-store-idempotency.test.ts`, `tests/unit/v2/session-store.test.ts` |
| `dedupe-key-stable` | `tests/unit/v2/session-store-idempotency-with-fakes.test.ts`, `tests/unit/v2/session-store-idempotency.test.ts` |
| `determinism` | `tests/unit/v2/notes-markdown.test.ts` |
| `durable-core-no-buffer` | `tests/architecture/v2-import-boundaries.test.ts` |
| `durable-core-no-node-imports` | `tests/architecture/v2-import-boundaries.test.ts` |
| `edge-cause-closed-set` | `tests/unit/v2/run-dag-projection.test.ts` |
| `edge-kind-closed-set` | `tests/unit/v2/run-dag-projection.test.ts` |
| `error-budget-details` | `tests/unit/v2/mcp-error-envelope.test.ts` |
| `error-envelope-shape` | `tests/unit/v2/mcp-error-envelope.test.ts` |
| `error-no-throw-across-mcp` | `tests/unit/v2/mcp-error-envelope.test.ts` |
| `error-retry-via-field` | `tests/unit/v2/mcp-error-envelope.test.ts` |
| `error-self-correcting` | `tests/unit/v2/mcp-error-envelope.test.ts` |
| `errors-as-data` | `tests/unit/v2/keyring-adapter.test.ts`, `tests/unit/v2/pinned-workflow-store-adapter.test.ts` |
| `event-index-monotonic-contiguous` | `tests/unit/v2/run-dag-projection.test.ts`, `tests/unit/v2/session-store.test.ts` |
| `event-index-zero-based` | `tests/unit/v2/session-store.test.ts` |
| `event-kinds-closed-set` | `tests/unit/v2/schema-locks.test.ts` |
| `execution-gated-by-health` | `tests/unit/v2/execution-session-gate.test.ts` |
| `gaps-append-only-resolution` | `tests/unit/v2/gaps-projection.test.ts` |
| `hash-format-sha256-hex` | `tests/unit/v2/golden-hashes/golden-hashes.test.ts`, `tests/unit/v2/jcs.test.ts` |
| `illegal-states-unrepresentable` | `tests/unit/v2/notes-markdown.test.ts` |
| `infra-only-node-io` | `tests/architecture/v2-import-boundaries.test.ts` |
| `jcs-rfc-8785` | `tests/unit/v2/golden-hashes/golden-hashes.test.ts`, `tests/unit/v2/jcs.test.ts` |
| `keyring-32-byte-entropy` | `tests/unit/v2/tokens.test.ts` |
| `keyring-two-keys` | `tests/unit/v2/tokens.test.ts` |
| `keyring-verification-order` | `tests/unit/v2/tokens.test.ts` |
| `manifest-index-monotonic-contiguous` | `tests/unit/v2/session-store.test.ts` |
| `no-throws-across-boundaries` | `tests/unit/v2/keyring-adapter.test.ts`, `tests/unit/v2/pinned-workflow-store-adapter.test.ts` |
| `non-assumable-choice-closed-set` | `tests/unit/v2/schema-locks.test.ts` |
| `non-tip-advance-creates-fork` | `tests/unit/v2/v2-execution-protocol.test.ts` |
| `notes-markdown-budget` | `tests/unit/v2/budget-enforcement.test.ts` |
| `orphan-segment-ignored` | `tests/unit/v2/session-store.test.ts` |
| `output-channel-closed-set` | `tests/unit/v2/output-ordering.test.ts` |
| `output-ordering-deterministic` | `tests/unit/v2/output-ordering.test.ts` |
| `paths-relative-only` | `tests/unit/v2/session-manifest-schema.test.ts` |
| `pin-after-close` | `tests/unit/v2/session-store.test.ts` |
| `ports-interfaces-only` | `tests/architecture/v2-import-boundaries.test.ts` |
| `preferences-node-attached` | `tests/unit/v2/preferences-projection.test.ts` |
| `preferred-tip-algorithm` | `tests/unit/v2/run-dag-projection.test.ts` |
| `preferred-tip-no-timestamps` | `tests/unit/v2/run-dag-projection.test.ts` |
| `preferred-tip-per-run` | `tests/unit/v2/run-dag-projection.test.ts` |
| `projection-cache-rebuildable` | `tests/unit/v2/projection-cache.test.ts` |
| `reason-code-unified` | `tests/unit/v2/schema-locks.test.ts` |
| `rehydrate-pure-no-writes` | `tests/unit/v2/v2-execution-protocol.test.ts` |
| `replay-fact-returning` | `tests/unit/v2/v2-execution-protocol.test.ts` |
| `replay-fail-closed` | `tests/unit/v2/v2-execution-protocol.test.ts` |
| `risk-policy-closed-set` | `tests/unit/v2/schema-locks.test.ts` |
| `risk-policy-guardrails` | `tests/unit/v2/run-status-signals-projection.test.ts` |
| `run-status-closed-set` | `tests/unit/v2/schema-locks.test.ts` |
| `runs-are-dags` | `tests/unit/v2/run-dag-projection.test.ts` |
| `salvage-read-only` | `tests/unit/v2/v2-execution-protocol.test.ts` |
| `schema-additive-within-version` | `tests/unit/v2/schema-locks.test.ts` |
| `schema-modules-load-safe` | `tests/unit/v2/schema-load.test.ts` |
| `schema-unknown-fields-ignored-conditionally` | `tests/unit/v2/schema-locks.test.ts` |
| `schema-unknown-version-fail-fast` | `tests/unit/v2/schema-locks.test.ts` |
| `schema-versioned` | `tests/unit/v2/schema-locks.test.ts` |
| `segment-digest-verification` | `tests/unit/v2/session-store.test.ts` |
| `session-health-closed-set` | `tests/unit/v2/execution-session-gate.test.ts` |
| `single-writer-per-session` | `tests/unit/v2/execution-session-gate.test.ts`, `tests/unit/v2/session-store.test.ts` |
| `snapshot-completed-sorted` | `tests/unit/v2/execution-snapshot.test.ts` |
| `snapshot-content-addressed` | `tests/unit/v2/golden-hashes/golden-hashes.test.ts` |
| `snapshot-discriminated-union` | `tests/unit/v2/execution-snapshot.test.ts` |
| `snapshot-impossible-state-rejected` | `tests/unit/v2/execution-snapshot.test.ts` |
| `snapshot-loop-id-unique` | `tests/unit/v2/execution-snapshot.test.ts` |
| `snapshot-pending-explicit` | `tests/unit/v2/execution-snapshot.test.ts` |
| `snapshot-rehydration-only` | `tests/unit/v2/execution-snapshot.test.ts` |
| `state-token-payload-fields` | `tests/unit/v2/tokens.test.ts` |
| `step-instance-key-delimiter-safe` | `tests/unit/v2/step-instance-key.test.ts` |
| `step-instance-key-format` | `tests/unit/v2/step-instance-key.test.ts` |
| `test-fakes-usage` | `tests/unit/v2/session-store-idempotency-with-fakes.test.ts` |
| `token-format-prefix-version-payload-sig` | `tests/unit/v2/tokens.test.ts` |
| `token-kind-closed-set` | `tests/unit/v2/tokens.test.ts` |
| `token-prefix-closed-set` | `tests/unit/v2/tokens.test.ts` |
| `token-prefix-kind-match` | `tests/unit/v2/tokens.test.ts` |
| `token-signature-input-canonical-only` | `tests/unit/v2/golden-hashes/golden-hashes.test.ts`, `tests/unit/v2/tokens.test.ts` |
| `token-signature-timing-safe` | `tests/unit/v2/tokens.test.ts` |
| `token-signing-hmac-sha256` | `tests/unit/v2/tokens.test.ts` |
| `token-validation-errors-closed-set` | `tests/unit/v2/mcp-error-envelope.test.ts` |
| `truncation-marker-format` | `tests/unit/v2/budget-enforcement.test.ts` |
| `type-escapes-quarantined` | `tests/architecture/v2-type-safety.test.ts` |
| `user-only-dependency-closed-set` | `tests/unit/v2/schema-locks.test.ts` |
| `witness-required-for-append` | `tests/unit/v2/execution-session-gate.test.ts` |
| `witness-scope-enforced` | `tests/unit/v2/execution-session-gate.test.ts` |
| `workflow-hash-jcs-sha256` | `tests/unit/v2/golden-hashes/golden-hashes.test.ts` |

</details>

---

## How to Add Coverage

Add `@enforces` annotations to your test files:

```typescript
/**
 * @enforces event-index-zero-based
 * @enforces event-index-monotonic-contiguous
 */
describe('session event ordering', () => {
  // tests that verify these locks...
});
```

Then run: `npm run generate:locks`
