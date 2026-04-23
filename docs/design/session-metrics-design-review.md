# Session Metrics -- Design Review Findings

*Review findings for the selected direction: Candidate A (flat context_set keys + projectSessionMetricsV2 projection)*

---

## Tradeoff Review

| Tradeoff | Assessment | Condition for Reversal |
|----------|-----------|----------------------|
| JsonValue storage, typed projection output | Acceptable. Consistent with isAutonomous/parentSessionId precedent. | If metrics_outcome drives workflow branching → migrate to typed artifact contract |
| No enforcement, relies on step prompting | Acceptable IF prompting guidance is included. Without it, feature is functionally dead. | N/A -- enforcement is a Phase 2 enhancement |
| Advisory git stats (LOC, files) | Acceptable with clear "agent-reported" UI labeling. | Phase 2 (Candidate C) removes this tradeoff |
| Flat key namespace (metrics_ prefix) | Acceptable. mergeContext semantics are design-locked at §18.2. | If 20+ metrics keys make context debugging painful → introduce sub-object with explicit full-replacement semantics |

---

## Failure Mode Review

| Failure Mode | Covered | Missing Mitigation | Risk |
|-------------|---------|-------------------|------|
| Convention adoption near-zero without step prompting | Partially -- docs required, but template not specified | Concrete reusable step prompt template in docs/authoring-v2.md | HIGH |
| Inconsistent key names (metrics_pr_number vs metrics_pr_numbers) | Silently returns null (acceptable) | None required for Phase 1 | LOW |
| Nested metrics object shallow-merge footgun | NOT covered by design | Explicit WARNING in authoring docs against using nested context.metrics = {...} | MEDIUM |
| Malformed projection values | Requires defensive coercion implementation | Projection must coerce/null, not throw, on malformed types | MEDIUM |

---

## Runner-Up / Simpler Alternative Review

**From runner-up (Candidate C):** `metrics_git_head_end` should be included in Phase 1 convention as an advisory key with explicit Phase 2 upgrade path (same key, automatic source in Phase 2). No design change needed -- this is additive.

**Simpler variant:** `metrics_outcome` only (single key, closed enum). Valid as a scope reduction if Phase 1 must ship quickly. Full spec is already scope-appropriate.

**Hybrid:** `metrics_outcome` as the primary/required recommendation; all others optional. Already how the design is structured.

**Conclusion:** No material design changes from comparison. Design is well-scoped.

---

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| YAGNI | ✅ Satisfied |
| Immutability | ✅ Satisfied |
| Validate at boundaries | ✅ Satisfied (projection coercion) |
| Functional/declarative | ✅ Satisfied |
| Determinism | ✅ Satisfied |
| Prefer explicit domain types | ⚠️ Tension -- JsonValue storage (acceptable, consistent with existing precedent) |
| Type safety as first line of defense | ⚠️ Tension -- no compile-time guarantee on agent output (acceptable for advisory data) |
| Make illegal states unrepresentable | ⚠️ Tension -- malformed values coerced to null (acceptable for advisory data) |
| Architectural fixes over patches | ✅ Satisfied -- projection layer, not a special case |

---

## Findings

### RED (Blocking or Critical)

None identified. Design does not violate any hard invariants.

### ORANGE (Important, Must Address Before Ship)

**O1: Convention adoption requires concrete step prompt template**
The design as specified requires a step prompt template in `docs/authoring-v2.md`. Without a copy-paste ready prompt that workflow authors can add to their final step, adoption will be near-zero and the feature will appear broken. This is a REQUIRED deliverable alongside the code changes.

**O2: Explicit warning against nested metrics objects**
The shallow merge footgun (`context.metrics = {...}` gets fully replaced on partial updates) must be explicitly warned against in the authoring docs. Without this, workflow authors who follow intuition will silently lose metric data.

### YELLOW (Advisories, Can Be Addressed in Follow-Up)

**Y1: Defensive projection coercion must be implemented**
The `projectSessionMetricsV2` projection must coerce malformed values to null rather than propagating or throwing. E.g., if `metrics_pr_numbers` is the string `"123"` instead of `[123]`, return `null` for that field. Implement this defensively at the projection boundary.

**Y2: Console UI must label advisory metrics**
The console display must show "agent-reported" or equivalent label for all Phase 1 metrics to avoid false precision. Do not present advisory LOC counts as authoritative. This is a UX requirement, not a code requirement.

**Y3: Document escalation trigger for type safety**
If `metrics_outcome` is ever used to drive automated workflow behavior (conditional branching, auto-dispatch), the type-safety tension becomes critical. Document this escalation condition in the design notes so future feature work knows when to migrate to a typed artifact contract.

---

## Recommended Revisions

1. **Add to Phase 1 scope:** A reusable final-step prompt template in `docs/authoring-v2.md` -- exact wording for a "report outcomes" step that instructs the agent to set `metrics_outcome`, `metrics_pr_numbers`, and other relevant keys. (O1)

2. **Add to authoring docs:** A warning section "Do not use context.metrics = {...}" explaining the shallow merge footgun and why flat `metrics_*` keys are required. (O2)

3. **Add to projection implementation spec:** Defensive coercion: all metrics fields return `null` if absent or malformed; projection never throws on bad metric values. (Y1)

4. **Add to console UI spec:** Advisory labeling for all Phase 1 metrics values. "Agent-reported" tag or equivalent. (Y2)

5. **Include `metrics_git_head_end` in Phase 1 convention** with documentation that this is advisory and will be superseded by automatic capture in Phase 2. (from runner-up borrowing)

---

## Residual Concerns

1. **Primary framing risk unverified:** We have not verified whether agents are already self-reporting outcomes informally in step notes. If they are, Phase 1 may duplicate effort or conflict with existing informal conventions. **Recommendation:** Before shipping, sample 10-20 recent session event logs and check whether any `context_set` events already contain outcome-like data.

2. **`metrics_git_head_end` reliability:** Agents may forget to run `git rev-parse HEAD` or may report the wrong commit (e.g., the HEAD before their final commit). Phase 1 should document this as advisory with low confidence, and Phase 2 should be prioritized to make it authoritative.

3. **Console projection callsite:** `console-service.ts` calls `projectRunContextV2` today; adding a call to `projectSessionMetricsV2` is additive but adds latency to session summary loading. If metrics projection is expensive (it shouldn't be for a simple key-read), it should be lazy-loaded or cached alongside the existing summary cache.
