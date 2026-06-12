# Design Review Findings: Cognitive Benchmark Methodology Redesign

This document summarizes the design review findings, tradeoff evaluations, failure modes, and philosophy alignment for the selected Hybrid Benchmark architecture.

---

## 1. Tradeoff Review

We evaluated three key tradeoffs accepted in the hybrid design:
1. **In-Process Virtual Duplex Loopback**: Emulates stdio boundaries in Node memory to run in <10ms. 
   - *Status*: Valid under standard conditions. 
   - *Risk*: Bypasses OS-level shebang and argv parsing during core sweeps.
2. **AST Gating & Write-Protected Overlays**: Restricts imports and copies protected test files to prevent cheating.
   - *Status*: Valid. Saves container setup times.
   - *Risk*: Vulnerable if the model executes shell escapes (e.g., `child_process.exec`) that bypass overlay directories.
3. **Wald's SPRT Sequential Analysis**: Early-stopping to bound API billing.
   - *Status*: Valid. Saves up to 80% in token cost.
   - *Risk*: Violates the i.i.d. assumption due to prompt caching and correlated model seeds, which may skew boundary thresholds.

---

## 2. Failure Mode Review

We audited the four primary failure modes:
- **Wald's SPRT Non-Convergence (Medium Severity)**: Wald's SPRT sequential analysis might loop indefinitely if distributions are highly non-normal or bimodal.
- **AST False Negatives (Low-Medium Severity)**: Strict import rules could block valid modern ES module code configurations.
- **Sandbox Escape via Shell Injection (High Severity - Most Dangerous)**: A model could run arbitrary shell commands to compromise the host process.
- **Token Budget Exhaustion (Medium Severity)**: Running deep multi-step workflows could lead to token cost spikes during debugging.

---

## 3. Runner-Up & Simpler Alternative Review

- **Strengths Borrowed from Candidate 1**: The prompt-equalized concatenated control arm and Wald SPRT sequential analysis are layered on top of Candidate 2's secure virtual loopback.
- **Simpler Alternative (Direct Vitest testing of JS handlers)**: Insufficient because it does not verify transport-level JSON-RPC serialization, EPIPE socket failures, or input/output schema parsing, and cannot prevent model cheating.

---

## 4. Philosophy Alignment

- **Satisfied Principles**:
  - *Three separate systems -- do not conflate them*: The runner is decoupled from the Console dashboard, logging results to disk.
  - *Zero LLM turns for routing*: Step transitions and control arms run programmatically via TypeScript coordinator logic.
  - *Prefer fakes over mocks*: Uses memory duplex stream loopback fakes rather than spy mocks.
  - *Errors as data*: Graded checkpoints (compile, syntax, tests) are mapped to fractional score components (0.0 to 1.0) rather than exceptions.
- **Tensions**:
  - *Environmental Hermeticism vs. YAGNI*: Balanced by using in-process loopbacks with AST gatekeepers and overlays for local runs, reserving containers for CI.
  - *Task Realism vs. Local Velocity*: Balanced by designing micro-scoped multi-file workspaces that execute in <1s.

---

## 5. Audit Findings

### [ORANGE] Finding 1: Shell Escape vulnerability in bare-metal in-process loopbacks
- *Description*: Running generated code locally without virtualization exposes the host process to shell injection or file deletion if the agent uses dynamic property access to invoke execution commands.
- *Severity*: Moderate-High.

### [ORANGE] Finding 2: SPRT i.i.d. assumption violation due to prompt caching
- *Description*: LLM trials are non-independent due to prompt caching, shared seeds, and correlated error states, which violates Wald SPRT assumptions and can cause boundary decision errors.
- *Severity*: Moderate.

### [YELLOW] Finding 3: AST parser false negatives on ES module formatting
- *Description*: TS Compiler API matching may fail on complex re-exports or dynamic imports, causing valid developer solutions to fail grading.
- *Severity*: Low.

---

## 6. Recommended Revisions

1. **SPRT Safe Termination Safeguard**: Implement a hard maximum trial limit (e.g. `--max-trials=100`) in the runner. If reached, fallback to standard OLS/LMM analysis and log a non-convergence warning.
2. **AST Execution Hardening**: Hardcheck the AST gatekeeper to scan for dynamic executions (e.g. `eval`, `Function`, `child_process.exec`, `spawn`, `module.constructor`) and restrict modifications to package dependencies.
3. **Non-Privileged Local Runs**: Enforce that local benchmark runs run as a non-privileged system user, and integrate Docker/gVisor sandboxing in the nightly CI regression pipeline.

---

## 7. Residual Concerns

- We cannot guarantee 100% security against zero-day Node/OS exploits if a rogue agent escapes the AST gatekeeper during bare-metal local execution.
- Collinearity in regression analysis under Concatenated prompt budgets may introduce modeling noise due to non-linear context degradation in modern LLMs.
