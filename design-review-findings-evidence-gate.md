# Design Review Findings: WorkRail Evidence Gate MVP

> Concise, actionable findings for main-agent synthesis. Not a final decision document.

## Tradeoff Review

| Tradeoff | Verdict | Condition under which it fails |
|----------|---------|-------------------------------|
| Pull model is assertion gate, not observation gate | Acceptable -- IF named and documented accurately | Feature is described as "observation-based enforcement" when it is assertion-based |
| B-path upgrade deferred | Acceptable -- seam is designed in | B-path requires breaking schema change (avoided by including source field from MVP) |
| Substring matching only (no regex) | Acceptable -- MVP limitation | Workflow authors need to distinguish `npm test` from `npm test:unit` |
| Continue token exposed to hook subprocess | NOT addressed -- needs ev_ token design | B-path implemented without narrow-scope token (hook gains advance authority) |

## Failure Mode Review

| Failure Mode | Design handles it | Risk | Mitigation |
|-------------|------------------|------|-----------|
| Agent calls record_evidence without running tool | No (accepted) | Medium | Honest naming, docs, B-path upgrade |
| Hook not configured, requiredEvidence declared | Yes (REQUIRED_CAPABILITY_UNAVAILABLE) | Low for MVP | Blocker with setup guide |
| B-path token exposure | Not yet | Medium-high | ev_ narrow-scope token (design now, implement with B-path) |
| Evidence from prior step leaks | Yes (nodeId scoping) | Low | Continue token scoping |
| Malformed token on record_evidence | Yes (boundary validation) | Low | ResultAsync error variant |

**Highest-risk failure mode:** Pull model trust gap (silent -- no error signal when tool is skipped).

## Runner-Up / Simpler Alternative Review

**B-path elements worth incorporating into MVP:**
1. `source: "agent" | "hook"` field on `evidence_recorded` event -- already incorporated after adversarial challenge
2. `ev_` evidence token type (narrow-scope, no advance authority) -- should be defined in spec now, even if CLI is deferred
3. Concrete `suggestedFix` URL in `REQUIRED_CAPABILITY_UNAVAILABLE` blocker -- placeholder acceptable in MVP

**Simpler variants reviewed:**
- Notes-presence check: Candidate D. Fails -- no typed blocker, no evidence store.
- Evidence field on `continue_workflow` input: Fails -- wrong semantics (evidence recorded multiple times; mixing "done" with "observed").

**Conclusion:** Candidate A is already the minimal design that satisfies all five acceptance criteria.

## Philosophy Alignment

**Satisfied (7 principles):** errors-are-data, exhaustiveness, validate-at-boundaries, immutability, explicit-domain-types, document-why, YAGNI-with-discipline.

**Under tension (2 principles -- both accepted):**
- `make-illegal-states-unrepresentable`: pull model allows assertion without execution. Cannot be resolved at the type level; the architectural fix (push hook) is the B-path.
- `architectural-fixes-over-patches`: pull model is a better patch, not a fix. Accepted: the seam is designed so the fix can be applied incrementally.

---

## Findings

### Red (Blocking)

None. The design is implementable and the acceptance criteria are satisfied.

### Orange (Should address before implementation)

**O1 -- ev_ token design is missing from spec**
The B-path upgrade requires hook subprocesses to call `record_evidence` without advance authority. Using the continue token (which has advance authority) for this is a security surface. An `ev_` narrow-scope evidence token should be designed in the spec now, even if the CLI implementation is deferred. Without this, implementing B-path later may require a breaking API change.

*Recommended revision:* Add `ev_<base64url-24>` token type to the `record_evidence` tool spec. Derivation: HMAC of `sessionId + nodeId` with a server secret. Accepted only by `record_evidence`, not by `continue_workflow`.

**O2 -- Blocker message must be self-documenting about assertion vs observation**
The `EVIDENCE_NOT_SATISFIED` blocker message must clearly state that this is an assertion gate, not an observation gate. If the message says only "Required evidence not satisfied," users will not understand the trust model.

*Recommended revision:* Blocker message template: "Required evidence not satisfied: [tool] with pattern '[pattern]' and exit code [N] was not recorded for this step. Note: this is an assertion gate -- install the evidence_collection hook for structural enforcement."

### Yellow (Address in follow-up)

**Y1 -- Regex pattern matching not supported in MVP**
Substring matching cannot distinguish `npm test` from `npm test:unit`. This is acceptable for MVP but should be tracked as a known limitation.

*Recommended revision:* Add optional `patternType: "substring" | "regex"` field to `requiredEvidence` entries in the schema. MVP implements `substring` only; `regex` is a post-MVP addition.

**Y2 -- AND vs OR semantics for multiple requiredEvidence entries is not in the schema**
The spec states AND semantics (all entries must be satisfied) but the schema does not encode this. If future versions need OR semantics, a schema change will be required.

*Recommended revision:* Add `evidenceMode: "all" | "any"` field to step-level requiredEvidence config, defaulting to `"all"`.

**Y3 -- Workflow authoring guidance is missing**
Workflow authors need to know: what tool names are valid? What exit codes are available? How does pattern matching work?

*Recommended revision:* Add a `requiredEvidence` section to the workflow authoring guide with examples.

---

## Recommended Revisions (Prioritized)

1. **(O1)** Add ev_ token type to the spec. Define derivation, scope, and lifetime. No implementation required for MVP pull model.
2. **(O2)** Write the `EVIDENCE_NOT_SATISFIED` blocker message template. Make "assertion gate" explicit.
3. **(Y1)** Add `patternType` field to the schema definition as a placeholder. Default: "substring". No regex engine needed in MVP.
4. **(Y2)** Add `evidenceMode` field to step-level requiredEvidence config. Default: "all".

---

## Residual Concerns

1. **Enforcement theater risk is real.** If the documentation or marketing describes this feature as "evidence-based enforcement" without the assertion vs observation qualification, users will be misled. This is a product communication risk, not a code risk. Flagged for product review.

2. **The pull model's trust gap is silent.** When an agent skips `record_evidence`, the gate blocks loudly. But when an agent calls `record_evidence` without running the tool, the gate passes silently. There is no observable signal. This is the hardest failure mode to mitigate without the push hook.

3. **B-path timeline is unresolved.** The MVP design is compatible with B-path, but there is no committed timeline for B-path delivery. If B-path is never shipped, the assertion gate becomes the permanent state. The enforcement theater risk compounds over time.
