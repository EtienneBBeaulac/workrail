# Research Brief: Pre-existing Bugs vs. Regressions in LLM PR Review

## Intake Question (verbatim)

How do automated tools distinguish pre-existing bugs from regressions introduced by a PR? What techniques do static analysis tools, code review bots, and LLM-based reviewers use to anchor findings to changed lines vs pre-existing issues?

---

## BLUF

Among the tested tools - Semgrep, SonarQube, Reviewdog, PR-Agent, CodeRabbit, and GitHub Copilot code review - the dominant technique is diff-anchoring, and all have a shared blind spot: regressions that manifest in unchanged code (callers, consumers, invariant holders) are invisible in PR mode. Semgrep explicitly documents that cross-file (interprocedural) analysis does not run during PR scans. PR-Agent's source code confirms it has no attribution mechanism and deliberately suppresses second-order reasoning. The gap is real, well-defined, and partially addressable with two lightweight techniques: (1) a pre-processing step that enumerates callers of changed functions via grep and injects them into the LLM context (unvalidated, recommended as a hypothesis to test), and (2) an explicit causal framing in the review prompt that forces the LLM to articulate why each finding is attributable to the current PR.

---

## Ranked Findings

**F1 - Semgrep cross-file analysis is explicitly disabled in PR/MR diff-aware scans [HIGH, single-source authoritative]**
- Evidence for: Semgrep official docs (semgrep.dev/docs/semgrep-code): "Note that cross-file analysis does not currently run on diff-aware (pull request or merge request) scans." [unconfirmed - single authoritative source]
- Evidence against: No counter-evidence found.
- Note: Two citations point to the same organization's documentation system (semgrep.dev and github.com/semgrep/semgrep-docs); not independently corroborated.

**F2 - No tested LLM PR review tool has a mechanism to distinguish pre-existing bugs from regressions [HIGH]**
- Evidence for: PR-Agent source code (pr_reviewer_prompts.toml + pr_processing.py in Codium-ai/pr-agent): prompt says "focus only on issues introduced by this PR" but provides no verification or attribution mechanism. Two distinct files in same codebase confirm this. (VERIFIED within source)
- Evidence against: CodeRabbit multi-repo analysis provides cross-repo impact detection [unconfirmed - single source, docs.coderabbit.ai], but this is cross-repo only and not a pre-existing vs. regression distinction mechanism.

**F3 - HC-1 (transitive callers in unchanged files) is missed by all diff-anchoring approaches [HIGH, inferred]**
- Evidence for: Semgrep cross-file disabled in PR mode (semgrep.dev, F1) + Reviewdog 'added' filter only covers changed lines (github.com/reviewdog README, SQ1-C5). Derived: no tool covers unchanged-file callers. (INFERRED from two sources)
- Evidence against: CodeRabbit multi-repo research agent covers cross-repo callers [unconfirmed - single source]. Intra-repo unchanged callers: no evidence of any tool addressing this.
- Derivation chain: SQ1-C7 (Semgrep disabled) + SQ1-C5 (Reviewdog positional filter) + SQ4-C5 (synthesis: no tool has intra-repo caller analysis in PR mode)

**F4 - SonarQube PR analysis can attribute pre-existing bugs as regressions when the base branch scan is stale [MEDIUM]**
- Evidence for: SonarCloud official docs: "In cases where T includes new issues added since the most recent scan (the scan is outdated) those additional issues will appear as part of the pull request analysis, even though they were not introduced by the pull request." [unconfirmed - single source, docs.sonarsource.com]
- Evidence against: No counter-evidence found.

**F5 - Facebook Infer's reactive mode is the only shipped tool that re-analyzes callers of changed procedures, but it is not a PR review tool [MEDIUM]**
- Evidence for: Infer official docs (fbinfer.com): reactive mode "analyzes modified files/procedures and their dependencies." [unconfirmed - single source]
- Evidence against: Not applicable to LLM-based review workflows; requires full build system integration and is offline-only.

---

## Contradictions

None found. Sources are consistent across tested tools. The industry pattern is uniform: diff-anchoring without cross-file analysis in PR mode, across both SAST tools and LLM review bots.

---

## Falsified Priors

None. No prior ledger existed before this research session.

---

## What We Now Know

- Semgrep's diff-aware mechanism: 4-tuple fingerprint (rule ID, file path, syntactic context, index) outcome-diffing across baseline and HEAD commits. Cross-file analysis explicitly disabled in PR mode.
- SonarQube's PR mechanism: scan HEAD of PR branch, compare against last stored scan of target. Failure mode: stale base scan causes false regression attribution.
- Reviewdog: pure positional filter with 4 modes. Default 'added' mode misses all unchanged-file regressions.
- PR-Agent: injects diff + max 10 context lines, no attribution mechanism (source-verified). Prompt explicitly suppresses second-order reasoning.
- CodeRabbit: adds learnings and a cross-repo research agent. No intra-repo attribution mechanism.
- Hard case taxonomy: 7 categories. HC-1 (transitive callers) and HC-2 (pre-existing on touched lines) are the most common.

## What We Still Do Not Know

- Whether grep-based caller injection improves LLM regression detection rate (no empirical data; technique is a hypothesis)
- Exact token budget impact of injecting caller lists for real-world PRs at various PR sizes
- Whether SonarQube's taint analysis in PR mode follows data flow across functions within a single scan (not addressed in any fetched source)
- Academic empirical evaluation of pre-existing vs. regression precision/recall for any shipped LLM review tool (no relevant papers found in arxiv search; PatchGuru paper found is adjacent but not directly applicable)

---

## Implications for wr.mr-review

The good-enough criterion was: "confidently choose 1-2 concrete techniques with enough detail to author workflow changes or engine primitives." That is met with appropriate uncertainty.

The data establishes: (a) the industry gap is real and uniform across tested tools, (b) no LLM tool has an attribution mechanism, and (c) two techniques are architecturally sound and require no new engine primitives, though neither has been empirically validated.

---

## Recommended Next Steps

**NS1 (High priority, low cost): HYPOTHESIS - Implement grep-based caller enumeration as a pre-processing workflow step in wr.mr-review and measure precision.**
- Hypothesis: injecting changed-function callers from unchanged files reduces false-negative rate for HC-1 regressions
- Implementation cost: 1 workflow step, ~50 lines, no engine changes
- Validation: run on 5-10 real PRs with known regression types; measure how often the caller list surfaces the right file
- Remaining unknown: false-positive rate of name-based grep (overloaded methods, naming collisions)

**NS2 (Medium priority, near-zero cost): Update wr.mr-review review step prompt with explicit causal attribution framing.**
- Replace "focus only on issues introduced by this PR" with structured: "For each issue: state whether it could have pre-existed, describe the causal connection to changed lines, only flag with articulate causation."
- Addresses HC-2, HC-5, HC-6
- Validation: evaluate on 5-10 PRs; check whether LLM causation explanations are credible or hallucinated

**NS3 (Low priority, optional): Full function body injection (Technique 3) for small PRs only.**
- Token-budget-gated; conditional on PR size < threshold
- Pursue only if NS1 and NS2 prove insufficient

---

## Dissent

The adversarial review identified two structural weaknesses:

**1. F1's corroboration is same-organization, not independent.** The two sources cited (semgrep.dev and raw.githubusercontent.com/semgrep/semgrep-docs) are the same organization's documentation system. This is one authoritative source, not two independent sources. F1 is correctly tagged as single-source authoritative (HIGH) but not independently verified.

**2. BLUF over-generalization:** The original draft said "All shipped diff-anchoring tools" but the evidence only covers Semgrep, SonarQube, Reviewdog, PR-Agent, CodeRabbit, and Copilot. The BLUF now correctly says "tested tools." SonarQube's cross-function taint analysis in PR mode was not explicitly tested; it may or may not follow cross-function flow within a single PR scan.

**3. NS1 is a hypothesis, not a confirmed solution.** The original brief presented caller enumeration as a solution. It is a logical inference from the gap - not an empirically validated technique. Framed as a hypothesis to validate.

---

## Premortem

If this brief turns out to be wrong six months from now, the most likely reason is that SonarQube's PR analysis already includes cross-function taint analysis in a way that addresses some of the HC-1 and HC-5 cases (this was not explicitly confirmed or denied in the fetched sources), or that grep-based caller injection generates so many false positives (due to naming collisions and overloaded methods in large codebases) that it increases reviewer fatigue rather than reducing it, making the recommended NS1 counter-productive.

---

## Evidence Base

[1] Semgrep diff-aware scan docs: https://raw.githubusercontent.com/semgrep/semgrep-docs/main/src/components/reference/_diff-aware-scanning.mdx  
[2] Semgrep findings-ci.md: https://raw.githubusercontent.com/semgrep/semgrep-docs/main/docs/semgrep-ci/findings-ci.md  
[3] Semgrep cross-file analysis docs: https://semgrep.dev/docs/semgrep-code/semgrep-pro-engine-intro/  
[4] SonarCloud PR analysis docs: https://docs.sonarsource.com/sonarcloud/improving/pull-request-analysis/  
[5] SonarCloud new code definition: https://docs.sonarsource.com/sonarcloud/improving/new-code-definition/  
[6] Reviewdog README: https://raw.githubusercontent.com/reviewdog/reviewdog/master/README.md  
[7] PR-Agent pr_reviewer.py: https://raw.githubusercontent.com/Codium-ai/pr-agent/main/pr_agent/tools/pr_reviewer.py  
[8] PR-Agent pr_processing.py: https://raw.githubusercontent.com/Codium-ai/pr-agent/main/pr_agent/algo/pr_processing.py  
[9] PR-Agent pr_reviewer_prompts.toml: https://raw.githubusercontent.com/Codium-ai/pr-agent/main/pr_agent/settings/pr_reviewer_prompts.toml  
[10] CodeRabbit learnings docs: https://docs.coderabbit.ai/knowledge-base/learnings  
[11] CodeRabbit multi-repo analysis docs: https://docs.coderabbit.ai/knowledge-base/multi-repo-analysis/  
[12] GitHub Copilot code review responsible use: https://docs.github.com/en/copilot/responsible-use-of-github-copilot-features/responsible-use-of-github-copilot-code-review  
[13] Facebook Infer workflow docs: https://fbinfer.com/docs/infer-workflow/

---

## Appendix A: Priors Ledger

No priors existed before this research session. Priors ledger initialized in research/regression-vs-preexisting/priors-ledger.json (empty).

---

## Appendix B: Source Map

See research/regression-vs-preexisting/source-map.md for the 8-entry source map (S1-S8) covering Semgrep, SonarQube, PR-Agent, CodeRabbit, GitHub API, academic papers, alert noise literature, and Reviewdog/CodeClimate.

---

## Appendix C: Dependency Matrix

See research/regression-vs-preexisting/dependency-matrix.json for the sub-question dependency graph and topological ordering (SQ1 -> SQ2 -> SQ3 -> SQ4 -> SQ5).

---

## Appendix D: Gap Analysis Log

See research/regression-vs-preexisting/gap-analysis.md. All 5 sub-questions classified RESOLVED after pass 1. Iteration stopped at count 1 of cap 2.
