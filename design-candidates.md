# Design Candidates: PR #405 Review Findings

## Problem Understanding

### Tensions
1. **Verify completeness vs. readability** -- adding 5 new verify items (4 from F5, 1 from F15) risks making the block unwieldy. But missing checks means pipeline invariants go unenforced.
2. **Dead code removal vs. behavior preservation** -- the OR branch `affectedDomains is unclear` is dead (any array, including `[]`, passes), but removing it must not change effective behavior for any valid input. Confirmed safe: the procedure always produces an array value.
3. **Documentation verbosity in procedural JSON** -- F1 asks for explanatory text inside a decision list used by an LLM. Mixing prose with selection rules risks agent misinterpretation.

### Likely Seam
All changes are within `promptBlocks` of the single step `classify-task` in `workflows/classify-task-workflow.json`:
- `verify` array: F5 (4 items) + F15 (1 item)
- `procedure` array item [1] (large classification string): F14 (simplify wr.discovery), F15 (add Large rule), F1 (chore note)
- `constraints` array: F6 (single-line array constraint)

### What Makes It Hard
- The procedure is a single long escaped JSON string -- surgical edits required to avoid breaking JSON syntax.
- F15 has two interdependent parts (verify check + procedure rule) that must be internally consistent.
- F1 requires a judgment call on placement: inline note vs. new rule bullet vs. metaGuidance.

---

## Philosophy Constraints

From `CLAUDE.md`:
- **Make illegal states unrepresentable** -- verify block is the enforcement mechanism; incomplete verify = unrepresented invariants
- **YAGNI with discipline** -- remove dead OR branch, don't leave speculative code
- **Document 'why', not 'what'** -- F1 fix must explain intent behind chore pipeline inclusion
- **Determinism over cleverness** -- verify checks must be unambiguous conditionals
- **Immutability by default** -- change only what is necessary

No philosophy conflicts detected.

---

## Impact Surface

- No runtime code depends on this JSON file's internal prompt text
- Schema validation (`workrail validate`) must still pass
- PR test plan examples (4 scenarios) must remain valid under the updated logic
- The `touchesArchitecture` definition in the procedure already mentions Large implies true -- F15 makes this explicit as a rule and a verify check, which is consistent

---

## Candidates

### Candidate A: Minimal in-place edits (recommended)

**Summary:** Add verify items using the existing `"If X, Y."` style, simplify the wr.discovery rule in-place, add the Large-rule note as a sentence appended to the touchesArchitecture definition, add a parenthetical note to the coding-task inclusion rule for chore, add a constraint for single-line arrays.

- **Tensions resolved:** Completeness (all invariants now verified). Dead code removed. Documentation added without polluting decision logic.
- **Tensions accepted:** Inline parenthetical for chore is less visible than a standalone bullet.
- **Boundary:** `promptBlocks` only. Correct seam.
- **Failure mode:** The chore parenthetical `-- note: chore is included because chores can require code changes and benefit from review` might be missed in a quick scan. Unlikely to cause agent misinterpretation since it starts with `-- note:`.
- **Repo-pattern relationship:** Follows exactly -- matches verify and procedure style already in the file.
- **Gains:** Minimal diff, clean review, no structural changes.
- **Losses:** Chore rationale is slightly buried.
- **Scope:** Best-fit. Only the target file changes.
- **Philosophy fit:** Honors YAGNI, Make Illegal States Unrepresentable, Document 'why'. No conflicts.

---

### Candidate B: Chore note as named bullet in pipeline rules

**Summary:** Same as A except the chore explanation becomes a standalone note bullet in the pipeline rules: `- (Note) chore taskType is included in the coding path because chores can require code changes and benefit from review.`

- **Tensions resolved:** More discoverable documentation.
- **Tensions accepted:** Non-functional bullet mixed into a decision list -- agents may attempt to evaluate it as a selection rule.
- **Boundary:** Same as A.
- **Failure mode:** Medium risk -- an LLM reading the pipeline rules might try to interpret the note bullet as a conditional rule and produce incorrect pipelines.
- **Repo-pattern relationship:** Adapts -- existing pipeline rules are all selection rules, not explanatory notes.
- **Gains:** Better documentation visibility.
- **Losses:** Pollutes the decision structure; risk of agent misinterpretation.
- **Scope:** Best-fit.
- **Philosophy fit:** Honors Document 'why'. Minor tension with Determinism over cleverness.

---

## Comparison and Recommendation

**Recommendation: Candidate A**

The pipeline rules section is a decision list used by the LLM to produce `recommendedPipeline`. Adding a non-rule bullet (Candidate B) risks the agent treating it as a selection rule. The parenthetical in Candidate A appended to the existing coding-task inclusion rule is unambiguous advisory prose that does not add a new decision branch.

Candidate A also follows existing repo patterns exactly and produces the smallest possible diff.

---

## Self-Critique

**Strongest counter-argument:** A parenthetical inline note is easy to miss during a quick scan. Candidate B makes the rationale more visible.

**Narrower option that lost:** Omit F1 entirely. Lost because the task explicitly requires documenting the decision.

**Broader option considered:** Move the chore explanation to a `metaGuidance` entry. No evidence that authors regularly consult metaGuidance for pipeline rationale -- would be non-standard placement.

**Invalidating assumption:** If the LLM agent treats `-- note:` parentheticals differently than expected. Low risk given clear advisory framing.

**Pivot condition:** If review feedback says the inline parenthetical is too subtle, upgrade to Candidate B or add the note to `metaGuidance`.

---

## Open Questions for the Main Agent

1. F1 asks to document why chore includes coding+review, OR alternatively add chore to the exclusion list alongside `docs` and `investigation`. The task description says the intent is to document the inclusion -- confirm this is correct.
2. The F15 verify check reads: "If `taskComplexity` is `Large`, `touchesArchitecture` must be `true`." Confirm this wording is acceptable.
