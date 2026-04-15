# WorkRail Autonomous MVP -- Design Review Findings

## Tradeoff Review

| Tradeoff | Condition for acceptability | Violation condition | Verdict |
|----------|----------------------------|---------------------|---------|
| Notes-only output (no tool execution) | Test workflow uses reasoning-only steps | Workflow steps require file I/O or code execution | Holds -- author a purpose-built test workflow |
| Single-message-per-step | WorkRail ancestry recap provides cross-step context | Steps depend on exact details from prior steps that ancestry recap compresses | Holds for typical steps; risk for long prior outputs |
| Singleton engine guard | MVP is single-workflow-per-process | Daemon embedded in host that also uses WorkRailEngine | Holds for MVP; document as known limitation |

## Failure Mode Review

| Failure Mode | Handled? | Missing Mitigation | Risk |
|-------------|----------|--------------------|------|
| `ackToken` null on non-complete step | Yes (guard -> `CompletionReport.failed`) | None | Low |
| `blocked` step variant | Yes (early return -> `CompletionReport.blocked`) | retryable vs non-retryable not distinguished | Low |
| LLM produces empty notes -> `MISSING_REQUIRED_NOTES` | Yes (engine catches, returns `blocked`) | None | Low |
| `createWorkRailEngine()` fails | Yes (early return before try/finally) | None | Low |
| Anthropic API call throws | **No** (throw escapes `runWorkflow`) | try/catch around `driver.callStep()` required | **HIGH** |

## Runner-Up / Simpler Alternative Review

- **Runner-up (Candidate 2 callbacks):** Only meaningful strength is naming clarity (`onStep` vs `callStep`). Not worth API change at MVP stage. `LlmDriver` naming acceptable.
- **Simpler variant (hardcoded Anthropic call, no LlmDriver):** Satisfies acceptance criteria but violates 'DI for boundaries.' Untestable without real API key. Rejected.
- **Hybrid adopted:** Boundary validation for `anthropicApiKey` when no `llmDriver` provided. Ergonomic default + testable injection in one function.

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Errors are data | Satisfied (after FM5 fix) |
| Exhaustiveness everywhere | Satisfied |
| Immutability by default | Satisfied |
| DI for boundaries | Satisfied |
| Validate at boundaries | Satisfied |
| YAGNI with discipline | Slight tension (StepOutput has context/artifacts) -- acceptable |
| Make illegal states unrepresentable | Partial tension (anthropicApiKey optionality) -- resolved by runtime validation |

## Findings

### RED: Unhandled throw from `driver.callStep()`

**Severity:** Red (blocking -- violates core philosophy contract)

The current design does not wrap `driver.callStep()` in a try/catch. If the Anthropic SDK throws (network error, rate limit, invalid API key), the exception propagates out of `runWorkflow()`. This violates the 'errors are data' contract: callers expect `Promise<CompletionReport>` never throws.

**Required fix:**
```typescript
let stepOutput: StepOutput;
try {
  stepOutput = await driver.callStep(sysPrompt, current.pending.prompt);
} catch (err) {
  return { kind: 'failed', reason: err instanceof Error ? err.message : String(err), stepCount };
}
```

### ORANGE: `LlmDriver.callStep` returns `string` instead of `StepOutput`

**Severity:** Orange (design smell -- locks out Phase 2 context/artifacts)

If `callStep` returns a string, the daemon cannot pass `context` or `artifacts` to `engine.continueWorkflow`. WorkRail's workflow authoring supports context variables that must be set by the executor. Returning `StepOutput` instead of `string` costs 4 lines and future-proofs the interface.

**Required fix:** Change `LlmDriver` to:
```typescript
export interface StepOutput {
  readonly notesMarkdown: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly artifacts?: readonly unknown[];
}
export interface LlmDriver {
  callStep(systemPrompt: string, stepPrompt: string): Promise<StepOutput>;
}
```

### YELLOW: Missing purpose-built test workflow

**Severity:** Yellow (prerequisite gap -- MVP proves nothing on existing bundled workflows)

Existing bundled workflows assume IDE tool access. The daemon needs a reasoning-only workflow to demonstrate the thesis. This is not a code defect but a prerequisite: `workflows/wr.autonomous-demo.json` must be authored alongside the daemon code.

**Suggested fix:** Author a 3-4 step workflow with steps like 'Analyze the following spec and identify the three most important design decisions' or 'Given the following problem statement, produce a structured solution outline.' No file I/O required.

### YELLOW: `anthropicApiKey` compile-time optionality

**Severity:** Yellow (compile-time gap -- caller can construct invalid trigger without detection)

`WorkflowTrigger.anthropicApiKey?: string` allows undefined. A caller who passes neither an API key nor a `llmDriver` will get a runtime error, not a compile error. The runtime boundary validation (`if (!llmDriver && !trigger.anthropicApiKey)`) handles this correctly, but ideally the type system would prevent the invalid state.

**Acceptable for MVP:** The alternative (two trigger types) adds more complexity than the problem warrants. Runtime validation with a clear error message is sufficient.

## Recommended Revisions

1. (RED) Add try/catch around `driver.callStep()` in the loop -- convert throws to `CompletionReport.failed`
2. (ORANGE) Change `LlmDriver.callStep` return type from `string` to `StepOutput` with optional `context` and `artifacts`
3. (YELLOW) Author `workflows/wr.autonomous-demo.json` alongside the daemon as the thesis-proof workflow
4. (YELLOW -- optional) Document `anthropicApiKey` optionality in JSDoc with clear note about when it's required

## Residual Concerns

1. **Prototype-learning uncertainty:** The quality of LLM notes on `pending.prompt` is unknown until a real run is made. Even with a reasoning-only workflow, the ancestry recap injection quality is untested in daemon mode.

2. **Singleton guard in tests:** Vitest runs tests in parallel workers. If multiple test files try `createWorkRailEngine()` simultaneously, the `engineActive` guard will cause test failures. Mitigation: each test file that creates an engine must call `close()` in `afterEach`, or use a fake engine that doesn't go through the factory.

3. **Model default:** The spec uses 'claude-sonnet-4-5' as the default model. This should be updated to whatever the latest generally-available Sonnet is at implementation time.
