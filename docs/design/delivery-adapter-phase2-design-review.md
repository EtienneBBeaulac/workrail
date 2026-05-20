# Delivery Adapter Phase 2 -- Design Review Findings

**Design under review:** Migration shim + TriggerDefinition.deliveryConfig + route() forwarding

---

## Tradeoff Review

| Tradeoff | Verdict | Condition under which it fails |
|---|---|---|
| synthesizeDeliveryConfig always produces a value (cli_inbox fallback) | Acceptable | Fails if tests assert exact TriggerDefinition shape -- verified none do |

## Failure Mode Review

| Failure mode | Risk | Mitigation |
|---|---|---|
| Adapter ordering wrong (review before commit) | MEDIUM | Unit test synthesizeDeliveryConfig with all field combinations; ordering explicit in code |
| Test fixtures break on TriggerDefinition shape | LOW (resolved) | Verified: no toMatchObject/toEqual on TriggerDefinition in trigger-store.test.ts |

## Runner-Up / Simpler Alternative Review

Simpler variants (lazy synthesis in route(), skip TriggerDefinition field) all recreate the dispatch() gap. Selected approach is already minimal.

## Philosophy Alignment

All principles satisfied. Intentional tension: 'no delivery configured' encoded as `{ adapters: [cli_inbox] }` not field absence -- correct for the 'no silent loss' invariant.

---

## Findings

**No RED or ORANGE findings.**

**YELLOW: Unit test for synthesizeDeliveryConfig must cover multi-adapter ordering**
The function must produce `[git_commit, github_draft_review]` for triggers with both `autoCommit + reviewerIdentity`. If ordering is wrong, Phase 3 would attempt to create a review against a commit that doesn't exist yet. Test must assert the ordering explicitly, not just the presence of both adapters.

---

## Recommended Revisions

1. Unit tests for `synthesizeDeliveryConfig` must cover: no-delivery-fields → cli_inbox; reviewerIdentity-only → github_draft_review; autoCommit-only → git_commit; both → [git_commit, github_draft_review] in that order.

---

## Residual Concerns

None blocking. Phase 2 is the minimal wiring step before Phase 3 activates `adapter.deliver()`.
