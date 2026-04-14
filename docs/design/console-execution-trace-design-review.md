# Design Review Findings: Console Execution-Trace Explainability

> Temporary workflow artifact for the wr.discovery run. Not canonical state.

## Tradeoff Review

**Cross-category question placement:** Questions that span categories (e.g., "did the loop run or was it skipped by a runCondition?") are placed in the category where a user would first look. Verified: Q-L6 covers the loop-vs-runCondition distinction explicitly and is placed in the iteration/loop category, but Q-R1 in decision/routing also addresses the skip-vs-fast-path distinction. No question is orphaned -- the cross-reference is handled by the data-source citations in each question's answer description.

**Temporal ordering left to the design team:** The five-category order from the brief happens to align with a natural user-discovery sequence (structural → routing → quality → iteration → outcome). No reordering needed. Verified: structural questions come first (what does the DAG show?), routing second (why does it look that way?), which matches how a user investigates.

**Step notes/output placed in outcome/result:** Q-O5 ("What did each step actually produce?") is correctly in outcome/result. Count of step-output-visibility questions is 1. Not warranted as a separate category.

---

## Failure Mode Review

**Missing scenario coverage (brief's five scenarios):** Verified against all five brief scenarios:
- 2-node DAG for 10-step workflow: Q-S1, Q-S2, Q-R1, Q-R6 -- covered
- Assessment gate fired and agent redid a step: Q-Q1, Q-Q2, Q-Q3 -- covered
- Loop ran 3 iterations: Q-L1, Q-L2, Q-L3, Q-L5 -- covered
- Workflow used a fast path: Q-R1, Q-R6, Q-S1, Q-R2 -- covered
- blocked_attempt nodes appearing alongside regular steps: Q-S3, Q-O3 -- covered

All five scenarios verified. No missing coverage.

**Workflow version pinning gap:** The question "Was this run on the latest workflow definition, or a pinned older version?" is not explicitly enumerated. This relates to `workflowHash` pinning semantics -- a real user question but secondary to execution-trace explainability. Severity: Yellow (acknowledged gap, not blocking).

**Loop 0-iteration scenario:** Q-L4 explicitly covers the "validation loop ran 0 times" scenario, grounded in the design locks' requirement that `entered_loop` + `evaluated_condition` + `exited_loop` must all be recorded even for 0-iteration loops. Covered.

---

## Runner-Up / Simpler Alternative Review

**Candidate 2 (temporal order):** Has one element worth noting -- the brief's own category order is already a good temporal sequence. No merge needed. The output presents categories in brief order.

**Simpler variant (flat unordered list):** Would fail acceptance criterion 2 (must be grouped by user mental model). The grouping is load-bearing for design team usability. Not viable.

**Merging similar questions (e.g., Q-L2 and Q-L3):** Rejected -- the questions are genuinely distinct (iteration count vs exit reason vs max-iterations-hit). Merging would reduce specificity without reducing length meaningfully.

---

## Philosophy Alignment

- **Exhaustiveness everywhere:** Satisfied. 32 questions covering all five brief scenarios including edge cases (0-iteration loops, fast paths, blocked_attempts, degraded gaps, fork/branch topology).
- **Explicit domain types over primitives:** Satisfied. Every question references a typed concept (runCondition, assessmentGate, loopIteration, gap_recorded, blocked_attempt) with specific event types cited.
- **Surface information, don't hide it:** Satisfied. The list is comprehensive by design.
- **Document why, not what:** Satisfied. Each question includes why that specific data is the right answer, not just a data type.
- **YAGNI with discipline:** Under acceptable tension -- 32 questions is comprehensive, but the brief explicitly asks for the FULL set. YAGNI doesn't apply to discovery enumerations.

---

## Findings

**Yellow -- Workflow version pinning question not enumerated:**
The question "Was this run on the latest workflow definition, or on a pinned older version?" is a real user question (relates to `workflowHash` + workflow pinning semantics from the execution contract) but was not included in the five-category enumeration. This is a secondary explainability concern. Recommend adding as Q-S7 in the structural/navigation category.

No Red or Orange findings. All enumerated questions are grounded in real, existing engine events. The design is sound.

---

## Recommended Revisions

1. Add Q-S7 to the structural/navigation category: "Is this run on the current workflow definition, or was the workflow updated on disk since this run started?" -- answered by the `workflowHash` field in `run_started` event and the execution contract's "workflow changes on disk" divergence warning.
2. Strengthen Q-R2 to explicitly cover "where was that context variable value set, and was it set correctly?" -- the provenance question, not just the value question.

Both are additions to the enumeration, not structural changes.

---

## Residual Concerns

One: The question list covers single-run execution-trace explainability comprehensively. Multi-run and cross-run comparison questions (fork history, session overview) are not enumerated -- this is out of scope per the brief but acknowledged.

The design is ready for the synthesis/output step.
