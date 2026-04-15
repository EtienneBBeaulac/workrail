# WorkRail Autonomous MVP -- Design Candidates

> Raw investigative material for the main agent. Not a final decision.

## Problem Understanding

### Core Tensions

1. **Notes-only MVP vs. actual use case.** The daemon needs to prove the autonomous thesis. But WorkRail's existing workflows are designed for human+IDE agents. A daemon producing only text notes is a mechanical proof, not a product demo. Resolution: the mechanical proof IS the thesis. A purpose-built demo workflow handles output quality.

2. **Single-message-per-step vs. context continuity.** No message accumulation across steps. But WorkRail's ancestry recap system injects prior step summaries into `pending.prompt`. Cross-step context is handled by the engine.

3. **LlmDriver injection vs. hardcoded Anthropic call.** Philosophy says 'DI for boundaries.' A hardcoded call is untestable without a real API key. The interface adds ~24 lines but makes `runWorkflow` unit-testable.

4. **EngineResult error mapping vs. throwing.** All `EngineResult<T>` errors must map to `CompletionReport` without throwing.

### What Makes This Hard

- Resource cleanup: `engine.close()` only called if engine was successfully created. `try/finally` pattern.
- `StepResponse.ackToken` is `AckToken | null` -- null case must be guarded.
- `StepResponse.kind` is `'ok' | 'blocked'` -- junior developer would miss the `blocked` variant.
- System prompt design: `pending.prompt` gives step instructions; LLM also needs role and output format context.

### Likely Seam

`src/daemon/run-workflow.ts` -- caller of `src/engine/engine-factory.ts`. Zero modifications to engine/mcp/v2.

## Philosophy Constraints

- **Errors are data:** `runWorkflow()` returns `Promise<CompletionReport>`, never throws.
- **Exhaustiveness:** `CompletionReport` is a discriminated union (completed | failed | blocked | max_steps_reached).
- **Immutability:** All daemon types use `readonly`.
- **DI for boundaries:** `LlmDriver` is an injected interface.
- **YAGNI:** No callbacks or hooks beyond what MVP needs.
- **Validate at boundaries:** `WorkflowTrigger` validated at entry point.

## Impact Surface

- `src/engine/engine-factory.ts` -- NOT modified, only called
- `src/engine/types.ts` -- NOT modified, only imported
- No MCP handlers, v2 durable-core, or existing tests affected

## Candidates

### Candidate 1: Minimal Loop on Engine API (Recommended)

**Summary:** 4 files, ~125 lines. `runWorkflow(trigger, llmDriver?)` calls `createWorkRailEngine()` and drives the start/continue loop. `LlmDriver` is injected (defaults to `createAnthropicDriver`).

**File structure:**
```
src/daemon/
  types.ts         -- WorkflowTrigger, CompletionReport, LlmDriver  (~35 lines)
  llm-driver.ts    -- createAnthropicDriver(apiKey, model): LlmDriver  (~45 lines)
  run-workflow.ts  -- runWorkflow(trigger, llmDriver?): Promise<CompletionReport>  (~80 lines)
  index.ts         -- re-exports  (~5 lines)
```

**Core types:**
```typescript
export interface WorkflowTrigger {
  readonly workflowId: string;
  readonly goal: string;
  readonly workspacePath?: string;
  readonly dataDir?: string;
  readonly anthropicApiKey?: string;
  readonly model?: string;   // default: 'claude-sonnet-4-5'
  readonly maxSteps?: number; // default: 50
}

export type CompletionReport =
  | { readonly kind: 'completed';         readonly stepCount: number }
  | { readonly kind: 'failed';            readonly reason: string;  readonly stepCount?: number }
  | { readonly kind: 'blocked';           readonly blockers: readonly { code: string; message: string }[]; readonly stepCount: number }
  | { readonly kind: 'max_steps_reached'; readonly stepCount: number };

export interface LlmDriver {
  callStep(systemPrompt: string, stepPrompt: string): Promise<string>;
}
```

**Core loop (pseudocode):**
```typescript
export async function runWorkflow(
  trigger: WorkflowTrigger,
  llmDriver?: LlmDriver,
): Promise<CompletionReport> {
  const driver = llmDriver ?? createAnthropicDriver(trigger.anthropicApiKey!, trigger.model);
  const engineResult = await createWorkRailEngine({ dataDir: trigger.dataDir });
  if (!engineResult.ok) return { kind: 'failed', reason: engineResult.error.message };

  const engine = engineResult.value;
  try {
    const startResult = await engine.startWorkflow(trigger.workflowId, trigger.goal);
    if (!startResult.ok) return { kind: 'failed', reason: startResult.error.message, stepCount: 0 };

    let current = startResult.value;
    let stepCount = 0;
    const sysPrompt = buildSystemPrompt(trigger.goal);

    while (!current.isComplete) {
      if (stepCount >= (trigger.maxSteps ?? 50)) {
        return { kind: 'max_steps_reached', stepCount };
      }
      if (current.kind === 'blocked') {
        return { kind: 'blocked', blockers: current.blockers, stepCount };
      }
      if (!current.pending || !current.ackToken) {
        return { kind: 'failed', reason: 'Engine returned no pending step or ackToken', stepCount };
      }

      const notes = await driver.callStep(sysPrompt, current.pending.prompt);
      const cont = await engine.continueWorkflow(current.stateToken, current.ackToken, { notesMarkdown: notes });
      if (!cont.ok) return { kind: 'failed', reason: cont.error.message, stepCount };
      current = cont.value;
      stepCount++;
    }

    return { kind: 'completed', stepCount };
  } finally {
    await engine.close();
  }
}
```

**Boundary:** `src/daemon/` -- zero engine modifications.
**Why best-fit:** The `WorkRailEngine` docstring explicitly describes this use case: 'bot-as-orchestrator -- the caller reads agentRole + prompt from each step, constructs its own system prompts enriched with domain context.'

**Failure mode:** `ackToken` null on a non-complete step. Handled by the guard returning `CompletionReport.failed`.
**Repo-pattern relationship:** Follows `engine-factory.ts` exactly (EngineResult mapping pattern).
**Gains:** 125 lines, fully testable, no subprocess, no new infrastructure.
**Losses:** Notes-only (tool use deferred).
**Scope judgment:** Best-fit.
**Philosophy fit:** Fully honors errors-as-data, exhaustiveness, immutability, DI, YAGNI.

---

### Candidate 2: Callback-Based Embedded SDK

**Summary:** Replace `LlmDriver` with `WorkflowCallbacks { onStep(stepId, prompt, stepCount): Promise<string> }`. No Anthropic dep in library.

**Key difference:** The daemon is a generic 'workflow driver.' Anthropic integration is a convenience wrapper, not part of the library.

**Tensions resolved:** Same as Candidate 1, plus Phase 2 tool use doesn't require API change.
**Tensions accepted:** More complex API. Callers must implement their own LLM integration.
**Scope judgment:** Slightly too broad for MVP. The `LlmDriver` interface in Candidate 1 is effectively the same seam.

---

### Candidate 3: MCP Subprocess Driver

**Summary:** Spawn MCP server as child process, use stdio MCP client.

**Failure mode:** EPIPE on stdout (AGENTS.md explicitly warns about this).
**Scope judgment:** Too broad. Contradicts `engine-factory.ts` existence.

## Comparison and Recommendation

**Recommendation: Candidate 1.**

The `WorkRailEngine` API docstring literally describes this use case. Candidate 2's seam is preserved via `LlmDriver.callStep` -- the naming difference is cosmetic. Candidate 3 is wrong architectural direction.

## Self-Critique

**Strongest counter-argument:** If the daemon is a one-off proof script, `LlmDriver` injection is speculative. A 100-line single-file script would be simpler.

**Pivot condition:** If Phase 2 tool use is committed to the next sprint, upgrade to Candidate 2's callback shape now. Otherwise, stay with Candidate 1.

**Assumption that would invalidate this design:** `pending.prompt` is insufficient for useful LLM output without tool access. Mitigation: author a purpose-built test workflow with reasoning-only steps.

## Open Questions for the Main Agent

1. Is `pending.prompt` sufficient for useful output on reasoning-only steps? (Prototype-learning uncertainty.)
2. Should `anthropicApiKey` be required at boundary or fall back to `process.env.ANTHROPIC_API_KEY`?
3. What is the right model default?
4. Should `src/daemon/` be internal or exported from package.json?
