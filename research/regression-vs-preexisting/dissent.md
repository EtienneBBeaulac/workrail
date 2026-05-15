# Dissent - Adversarial Review of Brief and F1

## Target

BLUF and Ranked Finding F1: "Semgrep cross-file analysis is explicitly disabled in PR/MR diff-aware scans"

## Strongest Argument Against

### 1. F1 does not support the BLUF's broader claim

F1 establishes a specific, accurate fact about Semgrep. However, the BLUF extrapolates from this to "All shipped diff-anchoring tools... have the same blind spot." This generalization is not supported by the evidence in the claims files.

The claims files contain no equivalent confirmation for SonarQube or Reviewdog on this specific point. What the claims do establish:
- SonarQube/SonarCloud scans the whole file at HEAD and compares against a stored scan of the target (SQ1-C3) - this is a full-file scan, not a diff-filtered scan. SonarQube does run across the full file in PR mode; it just compares outcomes. The claim that SonarQube misses HC-1 (transitive callers) is INFERRED (SQ3-C4 says "derived from SQ1-C7 + SQ1-C5 + general knowledge") - not sourced from SonarQube documentation.
- Reviewdog is a linter wrapper, not a static analyzer. It does not "miss callers" because it never had call-graph capability. Conflating Reviewdog with Semgrep as evidence of an "industry-wide" pattern inflates the claim.

**The gap**: The BLUF asserts F1 as evidence of an industry-wide pattern, but F1 only applies to Semgrep. No source in the claims files states "SonarQube does not analyze callers" in PR mode. SonarQube's full-file scan in PR mode could in principle run taint analysis (which follows data flow across functions) - the claims do not establish whether SonarQube's taint analysis in PR mode includes cross-function following.

### 2. The "verified" tag on F1 overstates corroboration strength

The two sources cited as corroborating F1 are:
- semgrep.dev (official Semgrep docs)
- raw.githubusercontent.com/semgrep/semgrep-docs (the same organization's documentation repo)

These are two files from the **same organization's documentation system**, not independent sources. The corroboration rule requires "distinct hostnames, not syndicated copies citing the same primary article." A company's main domain and their GitHub docs repo for the same documentation are effectively the same source. Under a strict reading of the corroboration rule, F1 should be **single-source**, not **verified**.

### 3. The recommended technique (NS1 - grep-based caller enumeration) rests on an inferred claim with no empirical backing

SQ5-C1 (Technique 1) is tagged `inferred` with derivation: "CodeRabbit multi-repo LLM approach + Semgrep gap -> intra-repo grep approach closes the gap." This is logical inference but:
- No evidence in the claims shows this technique has been tried or evaluated
- The brief's "What we do not know" section admits: "Whether a simple grep-based caller enumeration approach has been tried in any LLM review workflow and what false-positive rate to expect (no empirical data found)"
- The primary recommendation (NS1) in the BLUF and recommended next steps is thus based entirely on a gap-filling inference, not on empirical evidence of effectiveness

This means the BLUF's statement "addressable with two techniques that require no new engine primitives" is partly unfounded: the techniques are plausible but unvalidated. The brief presents them as solutions to a confirmed gap without confirming they actually solve the gap.

## Weakest Claim

The weakest single claim is **SQ5-C1 / Technique 1 (caller enumeration)**:
- Confidence: `inferred`
- Derivation: CodeRabbit multi-repo (which operates on different repos) is used as evidence for intra-repo grep being viable
- No source establishes: that grep-based caller injection improves LLM regression detection rate
- The analogy to CodeRabbit multi-repo is imprecise: CodeRabbit's research agent reads linked repos using an LLM to identify semantic impact, not by injecting raw call sites into a review prompt

## What Would Change This

The brief becomes more defensible if:
1. F1 is downgraded from VERIFIED to single-source (same-org dual-URL is not independent corroboration)
2. The BLUF narrows "All shipped diff-anchoring tools" to "Semgrep" or "tested tools"
3. NS1 is framed as "a hypothesis to test" not "a solution to implement"
4. A single pilot result (e.g., 5 real PRs reviewed with and without caller injection) would validate the technique claim

## Conclusion

The core factual findings (F1-F5) are sound and the hard case taxonomy is well-supported. The two structural weaknesses are: (a) F1's VERIFIED tag overstates independence of corroborating sources, and (b) the BLUF over-generalizes from Semgrep's specific limitation to all tools. The recommended next step (NS1) is a logical inference with no validation evidence - it should be framed as a hypothesis, not a solution.

**Dissent type:** weakest-claim (cannot mount a strong argument that the core findings are wrong, but can identify structural overstatements in corroboration and generalization)
