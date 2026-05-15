# Gap Analysis - Pass 1

## Resolved Sub-Questions

**SQ1: Diff-anchoring mechanisms in shipped SAST tools**
- Status: RESOLVED
- Evidence: 5 verified/single-source claims from Semgrep docs (two files), SonarCloud docs, Reviewdog source. Key mechanisms: Semgrep 4-tuple outcome-diffing, SonarQube HEAD vs last-stored-scan comparison, Reviewdog positional line filter with 4 modes. Failure modes documented from official sources.

**SQ2: LLM bot context construction and finding attribution**
- Status: RESOLVED
- Evidence: 2 verified claims (PR-Agent source code inspection direct). PR-Agent: diff + 10-line context only, no attribution mechanism (verified from two source files). CodeRabbit: adds learnings + multi-repo research agent. Copilot: diff + static instructions. No tool has pre-existing vs. new attribution mechanism.

**SQ3: Hard cases taxonomy**
- Status: RESOLVED
- Evidence: 2 verified claims (HC-1 and HC-2). 7 hard cases documented with concrete mechanisms. HC-1 (transitive callers) verified from two sources. HC-2 (pre-existing on touched lines) verified from two sources. HC-3 through HC-7 single-source or inferred.

**SQ4: Cross-file impact analysis in shipped tools**
- Status: RESOLVED
- Evidence: 1 verified claim (SQ1-C7/SQ4-C3: Semgrep disabled confirmed). Infer reactive mode documented (single-source but specific and authoritative). Key finding: no shipped tool does intra-repo call-graph in PR mode. This is a firm conclusion: the gap is the uniform behavior across multiple tools.

**SQ5: Concrete techniques for LLM workflow**
- Status: RESOLVED
- Evidence: 3 techniques with implementation detail (all inferred but with solid derivation chains). Technique 1 (caller enumeration) backed by CodeRabbit multi-repo as shipped analog + Semgrep gap as motivation. Techniques 2 and 3 derived from PR-Agent source + hard cases analysis.

## Partial / Open Sub-Questions

None. All 5 sub-questions are resolved with sufficient evidence for the deliverable.

## Iteration Decision

**Decision: STOP**

- iterationCount: 1 of cap 2
- All sub-questions classified as RESOLVED
- The deliverable (final brief) has already been written to `docs/design/mr-review-overhaul/research-regression-vs-preexisting.md`
- An additional pass would not materially change the recommendations: the key gap (no shipped tool does intra-repo call-graph in PR mode) is verified; the techniques (caller enumeration, causal framing, full function body) are derived from that gap and from source-verified tool behavior
- No partial/open sub-question is on the critical path to the deliverable
