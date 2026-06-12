# Design Doc: Benchmark Phase 0 Variance Audit & Task Corpus

> [!NOTE]
> This design document is a human-readable presentation of the benchmark pilot. The canonical execution state and context variables are maintained dynamically inside the WorkRail session state.

## Context / Ask
* **Stated Goal:** Benchmark: design task corpus and Phase 0 variance audit (issue #1135)
* **Reframed Problem:** How can we quantitatively prove that the structured step-by-step guidance of WorkRail MCP has a statistically significant effect on task success that is distinguishable from model capability and task difficulty, using the simplest possible verification setup?
* **Goal Type:** `solution_statement` (originally prescribing a task corpus and audit, reframed to focus on statistical verification of structured guidance).

## Path Recommendation
* **Path:** `design_first`
* **Rationale:** The dominant risk is conceptual: if we design the wrong tasks or the wrong pilot verification, we won't get a clear, statistically meaningful signal. We need to focus on shaping the task characteristics (favorable, neutral, adversarial) and the audit methodology before any code is written.

### Constraints / Anti-goals
### Constraints
* **Low Overhead:** Must keep the trial matrix reasonably sized (e.g. N=72 total runs) to minimize API cost and execution latency.
* **Deterministic Only:** Scoring must rely entirely on deterministic criteria (linter, compilation, unit test passes) to avoid needing complex AI judging pipelines.
* **Task Breadth:** Must define at least 6 distinct task instances (2 WorkRail-Favorable, 2 Neutral, 2 WorkRail-Adversarial) to provide sufficient group levels for a mathematically stable random intercept `(1 | TaskInstance)` in the Linear Mixed-Effects Model.
  * *WorkRail-Favorable:* High-step complexity, strong phase boundaries, explicit contract checking.
  * *Neutral:* Standard coding task with minor step ordering requirements.
  * *WorkRail-Adversarial:* Injects a subtle false premise (AskBench-style) or ambiguous constraint requiring step validation.
* **Model/Approach Matrix:** Use at least 2 models (e.g., Claude 3.5 Sonnet vs. GPT-4o-mini) and 2 approaches (WorkRail MCP vs. Vanilla Prompting).
* **Write-Protection & Sandboxing:** Grader must copy original, un-modifiable tests and configuration files over the agent's workspace before grading to prevent the agent from cheating the grading assertions.

### Anti-goals
* Building a full production-grade, multi-model automated runner.
* Implementing AI-assisted scoring rubrics or qualitative evaluation.
* Publishing benchmark results externally.
* Spending excessive API budget.

## Problem Domain & Ambitiousness
* **Problem Domain:** `software`
* **Solution Ambitiousness:** `best_fit` (a highly rigorous but scoped pilot that directly addresses the variance hypothesis).

## Landscape Packet
* **Current State:** The repository contains a micro-benchmark for binary token sizes (`scripts/benchmark-token-size.ts`) but no workflow execution benchmarking or runner logic.
* **Precedents & Academic Work:**
  * **Sphinx (PR Reviews, Jan 2026):** Highlighted the need for structured ground truth (comparing pseudo-modified inputs with merged outputs) and checklist-based verification points rather than open-ended evaluation, minimizing human subjectivity.
  * **AskBench (Agent Overconfidence, Feb/Apr 2026):** Evaluated models on their ability to identify false premises and missing information (AskMind/AskOverconfidence) and refuse to proceed without clarification.
  * **LLM Variance Decomposition:** Literature indicates LLM evaluations are highly sensitive to prompts, decoding noise, and task difficulty, necessitating formal mixed-effects models rather than simple averages to isolate the interaction protocol's effect.
* **Hard Constraints:**
  * Must use deterministic grading only (linters, compiler checks, unit tests) to keep evaluation variance at absolute zero.
  * Must respect a strict computational budget (N=60 maximum total runs for the pilot).
* **Obvious Contradictions & Trade-offs:**
  * *Complexity Ceiling/Floor:* If tasks are too complex, both approaches will fail (0% success). If too simple, both will succeed (100% success). We must design tasks at a "Goldilocks" difficulty level where the structured guidance of WorkRail helps but vanilla prompting gets lost.
  * *Metric Saturation:* Binary pass/fail (0/1) reduces statistical sensitivity. We should use a fractional success metric (e.g. percentage of unit tests passed) to capture partial progress.
* **Evidence Gaps:**
  * No baseline data on temperature sensitivity or stochastically driven variation on these specific coding tasks.
  * No existing data on how Claude 3.5 Sonnet or GPT-4o-mini perform under our WorkRail MCP workflow vs. vanilla prompting.

## Problem Frame Packet
* **Primary Stakeholders:** EtienneBBeaulac (repo owner/user), developers using or evaluating WorkRail, AI agent engineers.
* **Lived-use Jobs & Outcomes:** Establish a repeatable, low-cost pilot testing framework that empirically validates whether WorkRail's structured, step-by-step guidance yields superior coding outcomes over standard vanilla prompts.
* **Key Tensions:**
  * *Task Complexity Balance:* Avoiding floor effects (tasks are too hard and both fail) and ceiling effects (tasks are too easy and both succeed).
  * *Deterministic Verification vs. Semantic Quality:* Using fast, cheap binary tests vs. capturing structural code elegance.
  * *API Running Cost vs. Statistical Confidence:* Keeping trials low (N=60) while ensuring enough power to isolate approach effects from temperature-induced seed noise.
  * *Prompt Isolation:* Ensuring the vanilla prompt doesn't benefit from hidden hints or structure meant for the WorkRail workflow.
* **Reframes / How Might We (HMW) Questions:**
  * *HMW* design a software task that *cannot* be solved in a single LLM generation (vanilla) but is easily completed when decomposed into explicit, contract-validated steps (WorkRail)?
  * *HMW* measure the semantic quality of code generated under both approaches using *only* deterministic checks (e.g., static analysis, size checks, file presence, lint rules) without using an LLM judge?
* **Primary Framing Risk:** If we find that the baseline success rate of both vanilla and WorkRail prompting on all candidate coding tasks is either 0% (too hard for both) or 100% (solved easily by both in one shot), then deterministic metrics are completely saturated. This would make the current framing (deterministic-only pilot) wrong, forcing us to either introduce qualitative AI evaluation (contrary to our constraints) or dynamically scale task difficulty.
* **Core Hypothesis:** The structured step-by-step constraint enforcement and contract validation of the WorkRail MCP server statistically reduces agent drift and hallucination/overconfidence compared to vanilla prompting, particularly on multi-step tasks or tasks with false premises.
* **Statistical Model:**
  To partition variance and isolate the effect of the interaction protocol (Approach), we will use a Linear Mixed-Effects Model (LMM):
  $$\text{Score} \sim \text{Approach} + \text{Model} + \text{TaskCategory} + (1 \mid \text{TaskInstance})$$
  * *Fixed Effects:*
    * **Approach:** WorkRail MCP vs. Vanilla Prompting (the primary variable of interest).
    * **Model:** High Tier (e.g., Claude 3.5 Sonnet) vs. Low Tier (e.g., GPT-4o-mini).
    * **TaskCategory:** WorkRail-favorable, neutral, WorkRail-adversarial.
  * *Random Intercept:* `(1 | TaskInstance)` to control for baseline difficulty variance of individual tasks.
  * *Variance Partitioning:* Decompose total variance into:
    $$V_{\text{Total}} = V_{\text{Approach}} + V_{\text{Model}} + V_{\text{TaskCategory}} + V_{\text{Approach} \times \text{Model}} + V_{\text{Residual}}$$
    Where $V_{\text{Residual}}$ captures seed-level decoding stochasticity.
  * *Balanced Design:* 2 Approaches $\times$ 2 Models $\times$ 6 Task Instances $\times$ 3 Replications (Seeds) = 72 total runs.
  * *Pre-Pilot Equivalence Check:* To isolate state-machine value from prompt text density, a small pre-pilot (N=10 runs) will compare Claude 3.5 Sonnet on WorkRail MCP vs. a single-turn Checklist prompt.

## Decision Criteria & Ideal End State
* **Ideal End State:** An automated, low-cost continuous integration benchmark that automatically evaluates every pull request or workflow modification. It runs on a diverse, statistically balanced corpus of 100+ real-world-like software tasks across 5+ different model families. It uses a combination of rigorous deterministic tests and highly calibrated, multi-agent consensus AI judges to compute a multi-dimensional score (precision, recall, code quality, safety). The results are saved in a version-controlled database and presented as a live dashboard in the WorkRail Console, showing exactly where a change improved or degraded performance, with statistical confidence bounds automatically calculated to prevent overreacting to noise.

### Decision Criteria
The candidates for the Phase 0 task corpus and pilot design will be evaluated against the following criteria (sorted by weight/priority):
1. **Goldilocks Difficulty Target (Quality-Aspirational) [Weight: 5]**
   * *Description:* Task definitions must be carefully calibrated to ensure that success rates are non-saturated (between 10% and 90%) for the candidate approaches, maximizing the ability of the statistical test to detect approach-level variance.
2. **Task Categorization Distinctness (Quality-Aspirational) [Weight: 4]**
   * *Description:* The task corpus must clearly isolate Favorable (multi-step dependency), Neutral (standard single-phase coding), and Adversarial (false-premise/implicit ambiguity) conditions.
3. **Production Reusability (Vision-Aligned) [Weight: 4]**
   * *Description:* The dummy repo structure and task corpus must be designed as a realistic software project so that they can be graduated directly into CI regression smoke tests for WorkRail platform releases.
4. **Deterministic Grading Boundary (Compatibility Threshold) [Weight: 3]**
   * *Description:* Grading must rely entirely on automated, deterministic script executions (compilation, test passes, lint status) and require no manual or LLM-assisted evaluation during execution.
5. **Experimental Balance and Statistical Power (Compatibility Threshold) [Weight: 2]**
   * *Description:* Must strictly support a fully-crossed balanced factorial structure (2 Approaches x 2 Models x 6 Task Instances x 3 Seeds = 72 runs) to enable clean multi-way ANOVA with random task effects.

## Candidate Directions
* **Path Emphasis:** As a `design_first` path, candidate generation must produce at least one option that reframes the benchmarking problem rather than simply wrapping obvious script/runner options.
* **Angle A Focus:** Focus on high complexity, multi-step coding tasks, anchoring to the ideal end state.
* **Angle B Focus:** Focus on low-cost, deterministic verification and minimizing runner overhead, anchoring to the riskiest assumption.
* **Angle C Focus:** Focus on Goldilocks difficulty and adversarial false-premises (AskBench-style), anchoring to the primary framing risk.

## Challenge Notes
*(To be populated during adversarial reviews/validation)*

## Pre-Mortem Risks
1. **Control Prompt Invalidation:** This direction will fail if the Pseudo-WorkRail A/B control prompt is either too confusing (causing the model to fail due to prompt length) or too helpful (yielding 100% success without the state-machine), making the comparison statistically meaningless.
2. **API Rate-Limit Bottlenecks:** This direction will fail if we hit API rate limits or quota exhaustion during the 90 trial runs (3 arms x 2 models x 3 tasks x 5 seeds), preventing us from completing the crossed-factorial design necessary for the ANOVA.
3. **Task Goldilocks Miscalibration:** This direction will fail if the task difficulty cannot be dynamically calibrated (or is statically miscalibrated), resulting in all 60 runs failing (floor effect) or passing (ceiling effect), resulting in zero sum of squares for the Approach factor in the ANOVA.

## Resolution Notes
*(To be populated during resolution steps)*

## Decision Log
| ID | Decision | Rationale | Status |
|----|----------|-----------|--------|
| DEC-001 | Use `design_first` path | Conceptual task definition is the highest risk factor. | Approved |
| DEC-002 | Confirm `design_first` with `THOROUGH` rigor | Landscape research validated that task definition is the primary source of evaluation variance, requiring careful design. | Approved |
| DEC-003 | Need prototype/pilot script | A pilot runner script is required to automate N=60 runs and execute LMM ANOVA analysis. | Approved |
| DEC-004 | Select Candidate 1 as Winner | Candidate 1 avoids floor/ceiling saturation via progressive fractional success grading, runs in <1s, and easily graduates to a CI regression test. | Approved |
| DEC-005 | Select Candidate 2 as Runner-up | Candidate 2 is excellent for showcasing ambiguity handling but relies on artificial task structures and has high multi-turn execution costs. | Approved |

### Comparison to Ideal End State
The selected direction (Candidate 1: progressive deterministic grading on local mock workspaces) serves as the necessary, low-cost foundation (Phase 0 pilot) for the Benchmark. It falls short of the `idealEndState` (which includes 100+ tasks, consensus LLM judges, and a live Console dashboard) by design, to respect our constraints on trial overhead and avoid qualitative evaluation complexity. However, its modular architecture allows for the future addition of LLM-as-a-judge nodes and integration into the Console.

## Frame Validity Check
* **Status:** `valid`
* **Findings:** The literature review (Sphinx, AskBench) confirmed that evaluating structured guidance requires highly targeted task criteria (checklist-based deterministic verification, false premises) and statistical controls (random task effects). The problem frame remains highly valid and is reinforced by these findings.

## Resolution Notes / Tradeoff Review
1. **Tradeoff: Progressive Multi-Phase Checker as a proxy for Code Quality.**
   * *Verification:* Evaluating syntax, type safety (`tsc`), and incremental unit tests provides a zero-variance, continuous metric (0.0 to 1.0) without the latency and API cost of LLM-as-a-judge evaluators.
   * *Hidden Assumption:* Assumes the agent cannot cheat by hardcoding inputs or editing read-only test suites.
   * *Trigger for failure:* The task design allows the agent to modify tests or bypass execution boundaries.
   * *Mitigation:* The benchmark runner will ensure that tests, linter configs, and build scripts are write-protected and out-of-scope for agent edits.
2. **Tradeoff: Static Task Difficulty Calibration.**
   * *Verification:* Upfront manual calibration ensures a clean, balanced factorial matrix for statistical ANOVA modeling.
   * *Hidden Assumption:* The targeted models' capabilities will remain relatively stable during the pilot execution period.
   * *Trigger for failure:* Model updates cause success rates to saturate at either 0% or 100%, neutralizing statistical power.
   * *Mitigation:* We will monitor raw run results. If saturation occurs, we will adjust mock interfaces or inject extra compilation barriers to re-calibrate difficulty.
3. **Tradeoff: Testing System-Level Bundle instead of isolating prompt density.**
   * *Verification:* Highly aligned with WorkRail's user-facing value proposition (is the engine + prompt + workflow combination effective?).
   * *Hidden Assumption:* System-level validation is sufficient to build operator trust.
   * *Trigger for failure:* The project requires academic, isolated proof of the state-machine's contribution vs. prompt content.
   * *Mitigation:* We can introduce the A/B prompt structure equalizer later as a secondary, optional research arm.

## Failure Mode Review & Mitigations
1. **Infinite Loops in Generated Code Hang the Runner:**
   * *Coverage:* The runner script wraps all compile, build, and test shell subprocesses in strict execution timeouts (e.g. 5 seconds).
   * *Missing Mitigation:* A global run-level timeout must wrap the entire benchmark loop to protect against hangs during agent initialization or workspace setup.
   * *Adjudication:* Covered. Subprocess execution wrapper handles timeouts as structured error data.
2. **Syntactic Errors Block Imports & Crash Grader:**
   * *Coverage:* The runner executes ESLint syntax validation *before* compiler checks, awarding 10% credit for syntax-clean submissions even if they fail compilation.
   * *Missing Mitigation:* Grader execution code must run in an isolated try/catch boundary that captures stderr and exits gracefully without crashing the master orchestrator.
   * *Adjudication:* Covered. Subprocess output is piped and parsed as string data.
3. **Static Difficulty Saturation (Floor/Ceiling Effects):**
   * *Coverage:* Progressive grading checkpoints (lint $\rightarrow$ compile $\rightarrow$ tests) prevent raw binary saturation.
   * *Missing Mitigation:* If model updates cause success rates to saturate, we need alternative task complexities.
   * *Adjudication:* **Highest-risk failure mode.** Mitigation: We will define an "Advanced" version of the Favorable task (e.g. adding strict interface constraints or generic type parameters) that can be swapped in if Claude 3.5 Sonnet achieves 1.0 success on the standard version too easily.

## Candidate Comparison & Hybridization
1. **Borrowing Runner-Up (Candidate 2) Strengths:**
   * *Strength:* Candidate 2's ability to trigger high-variance failure modes via false premises.
   * *Hybrid Integration:* We will structure the **Adversarial Task** in the task corpus as a false-premise bug-fix task (AskBench style). This embeds Candidate 2's adversarial prompt design as a core category within Candidate 1's static mock codebase corpus, without needing a dynamic mutation injector script.
2. **Simpler Alternative (Binary Grader) Analysis:**
   * *Shortcoming:* A pure binary grader (1/0 success) is simpler but suffers from metric saturation (floor/ceiling effects), making statistical ANOVA/LMM testing highly unstable for a pilot count of N=60.
   * *Conclusion:* Candidate 1's progressive checkpoints are the minimum viable complexity required to extract continuous fractional data and protect statistical validity.
3. **Hybridizing with Candidate 4 (LMM Integration):**
   * *Hybrid Integration:* Instead of executing the complex, strawman Pseudo-WorkRail concatenator (Candidate 4's 90-run design), we will run Candidate 1's standard 2-arm (WorkRail vs. Vanilla) 60-run design. We will then apply Candidate 4's Linear Mixed-Effects Model (LMM) regression to analyze the fractional continuous scores (0.0 to 1.0), accounting for random task difficulty intercepts `(1|TaskInstance)`.

## Philosophy Alignment
* **Both-Sides-of-the-Fence Execution (Satisfied):** The benchmark runner utilizes standard local tooling (`eslint`, `tsc`, `vitest`) that executes polymorphically in headless CI daemon jobs and interactive dev environments.
* **Errors as Data (Satisfied):** Grader subprocesses capture compilation exits, linter warnings, and test failures as typed `Result` union objects rather than throwing exceptions, enabling structured analysis.
* **Simplicity Bias / YAGNI (Satisfied):** Rejected Candidate 4's complex prompt concatenator and database orchestrator, defaulting to standard local file copies and JSONL log outputs.
* **Adversarial Scrutiny (Satisfied):** Embedded AskBench-style false premises in the Adversarial Task category to challenge prompting limits.
* **Acceptable Tensions:**
  * *Deterministic vs. Code Elegance:* Checking only lint/compile/tests misses qualitative elegance. This is acceptable for Phase 0 because deterministic checks have zero grading variance, ensuring that all measured variance is driven by the execution protocol.

## Final Summary
*   **Final Recommendation (Hybrid Winner):** We recommend implementing a hybrid of **Candidate 1** and **Candidate 4**. The pilot will use Candidate 1's progressive checkpoints (ESLint syntax check $\rightarrow$ `tsc` compilation $\rightarrow$ test suite compilation $\rightarrow$ unit test assertions) on a minimalist mock codebase to generate continuous fractional scores (0.0 to 1.0) for every run. We will then apply Candidate 4's Linear Mixed-Effects Model (LMM) regression to analyze the resulting dataset (**72 trials: 2 Approaches x 2 Models x 6 Tasks x 3 Seeds**), controlling for random task intercepts `(1|TaskInstance)` with the required minimum group size for statistical validity.
*   **Strongest Alternative:** **Candidate 2 (Adversarial False-Premise Injector)**, which we hybridized by mapping its false-premise concepts directly into the "Adversarial Task" of Candidate 1's static corpus.
*   **Recommendation Confidence Band:** `medium` (reflecting the need for manual task difficulty calibration).
*   **Residual Risks & Resolved Mitigations:**
  1. *Calibration Overhead:* Upfront task calibration is required to ensure task difficulties are in the non-saturated zone (10%-90%) for both models.
  2. *Process Timeout Safety:* Infinite loop bugs in generated agent code could hang the runner. *Mitigation:* Subprocess timeouts (5s) and a global run timeout will be enforced.
  3. *Syntax Grading Brittleness:* Syntactic style variations could block ESLint checks. *Mitigation:* ESLint config will be restricted to checking basic parse/syntax validity rather than stylistic formatting.
  4. *Agent Tampering / Cheating:* An optimizing agent could bypass grading tests by modifying workspace configurations. *Mitigation:* The runner script will overwrite all test files with original, write-protected versions prior to grading.
  5. *Checklist Equivalence (Engine Redundancy):* The risk that prompt text detail alone drives success, rather than WorkRail's engine protocol. *Mitigation:* Run a pre-pilot Checklist Equivalence Test (N=10 runs) as a gating check before launching the full 72-run matrix.
*   **Next Actions:**
  1. Create the benchmark runner in `tests/benchmark/run-benchmark.ts`.
  2. Implement the 6 mock repository tasks in `tests/benchmark/corpus/` (2 Favorable, 2 Neutral, 2 Adversarial).
  3. Execute the pre-pilot Checklist Equivalence Test (N=10 runs) using Claude 3.5 Sonnet to gate engine efficacy.
  4. Script the automated crossed-factorial runner for the full N=72 run matrix.
  5. Output results as JSONL and execute the LMM statistical regression script.
