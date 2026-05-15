# Research Brief: Pre-existing Bugs vs. Regressions in LLM PR Review

**Status:** Complete  
**Date:** 2026-05-15  
**Question:** How do automated tools distinguish pre-existing bugs from regressions introduced by a PR? What techniques can be practically implemented in wr.mr-review?

---

## Summary

Every shipped PR review tool uses some form of diff-anchoring to scope findings to the current PR, but all of them have a fundamental gap: they cannot detect regressions that manifest in unchanged code. The hard cases are well-defined and tractable with two specific techniques that require no new engine primitives.

---

## 1. How Shipped Tools Do Diff-Anchoring (SQ1)

### Semgrep

**Mechanism:** Two-scan outcome diffing. Semgrep scans the full codebase (or targeted files) at both the baseline commit and HEAD, identifies findings by a 4-tuple `(rule ID, file path, syntactic context, index)`, and reports only findings present in HEAD but not in baseline. The key is that `syntactic context` is the actual code lines - not a line number - so findings survive pure refactoring moves.

**Failure modes:**
- Cross-file (interprocedural) analysis is explicitly disabled for diff-aware (PR) scans. "Note that cross-file analysis does not currently run on diff-aware (pull request or merge request) scans." It only runs on full scans.
- A pre-existing bug on a line that was syntactically modified by the PR gets a new fingerprint and appears as a new finding.
- Baseline staleness is not an issue here since Semgrep re-scans at baseline commit.

### SonarQube / SonarCloud

**Mechanism:** Scans HEAD commit of the PR branch, compares against the most recent stored scan of the target branch. Reports only issues in HEAD that are not in the last scan of the target.

**Failure modes:**
- **Documented staleness bug:** If the target branch's scan is outdated (new issues were added to the target since the last full scan), those pre-existing issues appear in the PR analysis. Official docs state: "In cases where T includes new issues added since the most recent scan (the scan is outdated) those additional issues will appear as part of the pull request analysis, even though they were not introduced by the pull request."
- New-code period uses git blame date: any line whose blame points to the PR commit is "new code." A pre-existing bug on a reformatted or nearby-edited line gets blamed to the PR.

### Reviewdog

**Mechanism:** Pure positional line filtering. Takes linter output (file + line), filters against `git diff` output. Four filter modes:
- `added` (default): findings on added/modified lines only
- `diff_context`: findings within N lines of changed lines
- `file`: all findings in any modified file (regardless of line)
- `nofilter`: report everything

**Failure modes:**
- `added` mode (default) misses regressions in unchanged files entirely.
- `file` mode over-reports: surfaces pre-existing bugs in touched files, creating review fatigue.
- Platform limitation: GitHub PR Review API cannot post inline comments outside the diff. Findings outside the diff hunk become Check annotations, not inline comments.

---

## 2. How LLM PR Review Bots Construct Context (SQ2)

### PR-Agent (Qodo) - source-verified

**Context injected:**
- The diff, extended with `PATCH_EXTRA_LINES_BEFORE` and `PATCH_EXTRA_LINES_AFTER` context lines (default unknown, max 10 each)
- PR title, branch name, description, commit messages
- AI-generated file summaries (optional feature)
- Nothing about the full codebase or callers

**Attribution mechanism:** None. The system prompt says "focus only on issues introduced by this PR" and "note that you only see changed code segments, not the entire codebase." There is no mechanism to determine if a flagged issue pre-existed.

**Incremental mode (-i flag):** Reviews only files changed since the last review (for reviewing new pushes to an already-reviewed PR). Does NOT distinguish pre-existing from new bugs - it still sees only the diff of new changes.

### CodeRabbit

**Context injected:**
- Diff (like all tools)
- Learnings: per-organization natural-language review preferences, injected on every review
- Code guidelines: AGENTS.md, .cursorrules, copilot-instructions.md auto-detected
- Web search: may query external docs for CVE/library info
- Multi-repo analysis: LLM "research agent" checks linked repositories for cross-repo impact

**Attribution mechanism:** None for pre-existing vs. new within a single repo. Multi-repo analysis provides cross-repo regression detection but does not provide intra-repo caller analysis.

**Most relevant feature for this problem:** Multi-repo analysis (shipped, configurable via `.coderabbit.yaml`) uses an LLM research agent to check whether changes break consumers in linked repos. This is the only shipped LLM review feature that does any form of impact analysis beyond the raw diff.

### GitHub Copilot Code Review

**Context injected:** Diff plus custom instructions from `.github/copilot-instructions.md`. No mechanism for pre-existing vs. new distinction. Documented limitation: "may not identify all problems, especially where changes are large or complex."

---

## 3. Hard Cases Taxonomy (SQ3)

These are the regression patterns that diff-anchoring cannot catch:

### HC-1: Transitive callers in unchanged files (hardest)
PR changes `function foo(a: string, b: number)` to `foo(a: string, b: string, c: number)`. Callers in `otherFile.ts` (unchanged) still pass two args. The bug exists in `otherFile.ts`, a file not in the diff. No SAST tool surfaces this in PR mode. TypeScript compiler catches it at CI build time but LLM review misses it.

### HC-2: Pre-existing bug surfaced by touching nearby code
A function had a pre-existing null check bug. PR adds a new feature to the same function, changing lines near the bug. The bug's syntactic fingerprint is now "new" (Semgrep) or the blame date is now the PR (SonarQube). The bug appears as a regression even though it was not introduced by the PR.

### HC-3: Stale base scan (SonarQube specific)
Main branch had bugs added after the last full scan. Those bugs appear in the PR analysis as if the PR introduced them.

### HC-4: Type/schema drift in consumers
PR changes a TypeScript interface or database schema. Consumers in unchanged files now pass wrong types. Compiler catches this, but LLM reviewing only the changed file cannot see the downstream break.

### HC-5: Invariant violation in unchanged code
PR changes the behavior of a function that callers rely on for a documented or implicit invariant. The invariant is only visible from the callers, which are in unchanged files. PR-Agent explicitly instructs the LLM "do not speculate that a change might break other code unless you can identify the specific affected code path from the diff context" - this conservatism suppresses the signal.

### HC-6: Large noisy diffs (refactor + functional change combined)
A PR renames variables across many files AND introduces a bug. The regression signal is diluted in diff noise. LLM attention spreads too thin.

### HC-7: Reviewdog over-report (false regression direction)
Using `filter-mode=file` surfaces pre-existing bugs in touched files as if they were regressions. This trains reviewers to ignore tool output.

---

## 4. Cross-File Impact Analysis in Shipped Tools (SQ4)

The honest answer: **no shipped tool does intra-repo call-graph analysis during a PR review scan.**

| Tool | Cross-file in PR mode? | Mechanism |
|------|------------------------|-----------|
| Semgrep Pro | **No** | Explicitly disabled for diff-aware scans |
| SonarQube | **No** | Taint analysis only in full scans |
| Facebook Infer (reactive mode) | **Partial** | Re-analyzes callers of changed procedures, but requires full build capture; not a PR review tool |
| CodeRabbit multi-repo | **Cross-repo only, LLM-based** | Research agent checks linked repos; not intra-repo call-graph |
| Reviewdog file mode | **File-level only** | Reports all findings in touched files; no caller discovery |

**Infer's reactive mode** is the only shipped tool that propagates analysis to callers of changed procedures (`infer run --reactive` re-analyzes "modified files/procedures and their dependencies"). But Infer requires build system integration, is limited to C/Java/ObjC, and is designed for offline batch analysis, not real-time PR review.

---

## 5. Recommended Techniques for wr.mr-review (SQ5)

### Technique 1: Caller-enumeration pre-processing step (ranked #1)

**What it is:** Before the LLM review step, run a lightweight code search to find callers of all changed function/method signatures. Inject the caller list into the review context: "The following functions in unchanged files call the modified functions: [file:line caller1], [file:line caller2]..."

**What it addresses:** HC-1 (transitive callers), HC-5 (invariant violations).

**Implementation in wr.mr-review:**
- Workflow step: parse the diff for changed function signatures
- Run `git grep -n "functionName"` or use `ripgrep` for each changed name
- Collect results by file (exclude the changed files themselves to avoid noise)
- Inject into LLM review context as structured list: "Potential impact: the following call sites in unchanged files reference changed functions"
- Ask the LLM to evaluate whether each changed function's contract has changed in a way that would affect these callers

**Requires engine primitives?** No. This is a workflow step that uses bash/filesystem tools. The LLM step just receives richer context.

**Limitations:** Simple name-based grep has false positives (overloaded methods, same-named functions in different modules). Can be tightened with language-specific tools (TypeScript LSP, Python rope). The grep approach is good enough for 80% of cases.

**Confidence:** High. This is essentially what CodeRabbit's multi-repo agent does (search linked repos for affected code) but applied intra-repo.

---

### Technique 2: Explicit causal framing in the review prompt (ranked #2)

**What it is:** Add a structured reasoning step to the review prompt that asks the LLM to classify each finding by causal attribution before reporting it.

**Current state (PR-Agent):** Prompt says "focus only on issues introduced by this PR" but provides no reasoning scaffold. LLM complies but cannot verify.

**Proposed change:**

```
For each potential issue you identify:
1. State whether the issue could have existed before this PR
2. If yes: describe what specific change in this PR made it newly relevant or visible
3. Only flag issues where you can articulate a causal connection to the changed lines
```

**What it addresses:** HC-2 (pre-existing on touched lines), HC-5 (invariant violations), HC-6 (noisy diffs). Forces the LLM to reason about causality rather than proximity.

**Implementation:** Prompt template change in the wr.mr-review workflow's review step. No engine changes.

**Confidence:** Medium. LLMs can reason this way but will hallucinate causality explanations. Works best when combined with Technique 1 (more context = better causal reasoning).

---

### Technique 3: Diff scope expansion with explicit boundary marking (ranked #3)

**What it is:** Instead of injecting only the changed hunks, inject the full bodies of changed functions (if they fit in budget) and explicitly mark which lines are new vs. unchanged. PR-Agent's 10-line context cap is too small for most function bodies.

**What it addresses:** HC-2 (pre-existing on nearby lines - LLM can see the full function context and distinguish the pre-existing pattern), HC-5 (invariant visible in full function body).

**Implementation:**
- For each changed function in the diff, fetch the complete function body (not just the hunk)
- Mark added lines with `[NEW]`, removed lines with `[REMOVED]`, unchanged lines with `[UNCHANGED]`
- Ask the LLM to reason about the function as a whole, not just the changed lines

**Requires engine primitives?** No. Pre-processing step in the workflow. Requires language-aware function boundary detection (can be approximated with heuristics for most languages).

**Limitation:** Token budget pressure. Works for PRs with few changed functions; degrades for large PRs.

---

## 6. Hard Cases Each Technique Handles

| Hard Case | Technique 1 (Caller enum) | Technique 2 (Causal framing) | Technique 3 (Full function body) |
|-----------|--------------------------|------------------------------|----------------------------------|
| HC-1: Transitive callers | **Yes** | Partial | No |
| HC-2: Pre-existing on touched lines | No | **Yes** | **Yes** |
| HC-3: Stale base scan | No | No | No (not an LLM problem) |
| HC-4: Type drift | Partial | Partial | Partial |
| HC-5: Invariant violation | **Yes** | **Yes** | **Yes** |
| HC-6: Noisy diffs | No | **Yes** | Partial |
| HC-7: Over-report | No | **Yes** | No |

HC-3 is not addressable by LLM workflow changes - it requires ensuring base branch scans are current (infrastructure problem).

---

## 7. Implementation Priority

**Priority 1 - Technique 1 (caller enumeration):** Highest signal-to-effort ratio. Addresses the hardest case (HC-1, transitive callers). Pure workflow pre-processing, no engine changes. Implement as a workflow step that runs before the main LLM review.

**Priority 2 - Technique 2 (causal framing):** Low cost (prompt change), medium gain. Improves precision across all cases where the LLM has enough context. Implement by updating the review step's prompt template.

**Priority 3 - Technique 3 (full function body):** Useful for small PRs, degrades at scale. Consider making it conditional on PR size (lines changed < threshold).

---

## 8. What None of the Tools Do (Opportunities)

1. **Storing a "known issues" baseline**: No tool persists a list of known pre-existing findings per file and uses it to filter PR findings. This would require a database but would perfectly solve HC-2.

2. **Intra-repo call-graph analysis in PR mode**: The gap between Infer's reactive mode (great analysis, wrong platform) and all LLM tools (no call-graph) is clear. A lightweight approach (grep-based caller enumeration) captures 80% of the value at 5% of the cost.

3. **Confidence-weighted attribution**: No tool produces a confidence score for "was this introduced by the PR?" A two-pass LLM approach (first pass: suspect pre-existing; second pass: confirm regression) could produce this.

---

## Sources

| Source | Type | Used For |
|--------|------|----------|
| Semgrep docs: diff-aware scanning, findings-ci.md | Tool docs | SQ1 mechanism |
| Semgrep Pro cross-file analysis docs | Tool docs | SQ4 (confirmed disabled in PR mode) |
| SonarCloud PR analysis docs | Tool docs | SQ1 mechanism, HC-3 |
| SonarCloud new code definition docs | Tool docs | SQ1 mechanism |
| Reviewdog README (source) | OSS source | SQ1 filter modes |
| PR-Agent: pr_reviewer.py, pr_processing.py (source) | OSS source | SQ2 context construction |
| PR-Agent: pr_reviewer_prompts.toml (source) | OSS source | SQ2 prompt template |
| CodeRabbit: learnings, multi-repo, web-search docs | Product docs | SQ2 context features |
| GitHub Copilot code review responsible-use docs | Product docs | SQ2 limitations |
| Facebook Infer: infer-workflow docs | Tool docs | SQ4 reactive mode |
