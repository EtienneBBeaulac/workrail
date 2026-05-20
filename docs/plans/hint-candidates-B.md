# Hint Candidates B: Position-Anchored Artifact Guidance

**Date:** 2026-05-20
**Angle:** Riskiest assumption is attention-based, not content-based. Every candidate must
address WHERE guidance appears, not just WHAT it says.

**Problem summary:** Agent on step phase-4c (wr.loop_control contract) fails 66 turns /
1.7M tokens without submitting the required artifact. The step prompt has the canonical
example but appeared 60+ turns ago. The blocked feedback is wrong (says fix notesMarkdown,
wrong type in limit-exceeded error). The agent may be ignoring correct guidance because it
is too far back in context to receive reliable attention.

---

## Approach 1 (p=0.55): Contract-aware suggestedFix in reason-model.ts

**Primary mechanism:** Fix the wrong suggestedFix text for non-assessment artifact
contracts in `reasonToBlocker()` so that every blocked response -- whether at attempt 1,
2, or 3 -- names the correct parameter path and includes the canonical scaffold inline.

### How it addresses position vs. content tension

This is purely a content fix in the engine layer. It does NOT address position -- guidance
is still only in the tool result (as an `is_error: false` tool_result block), appearing
after the failed tool call in the conversation history. The agent reads the blocked
response to get the retry token, so the guidance is adjacent to the failed call. For
early failures (attempt 1-2), this approach may be sufficient because the blocked result
text is the last content in the conversation at the point of failure. For late failures
at 66 turns, the cumulative context weight may still cause the guidance to be ignored.

### Key tradeoffs

- Easiest change: two string literals in `reason-model.ts`, one condition in `advance.ts`
- Correctness: fixes the wrong-advice bug that actively misdirects the agent
- Position: still only in the tool result; no cortex-layer amplification
- Extensibility: each new contractRef needs a new branch in reasonToBlocker, OR the logic
  must call into the artifact schema's `getBlockedMessage()` function. The latter satisfies
  the "one change in one place" criterion by dispatching through a registry.

### Implementation sketch

In `src/v2/durable-core/domain/reason-model.ts`, `reasonToBlocker()`:

```typescript
// Before (wrong for non-assessment contracts):
case 'missing_required_output':
  suggestedFix: contractRef === ASSESSMENT_CONTRACT_REF
    ? 'Call continue_workflow without output to rehydrate ...'
    : 'Call continue_workflow without output to rehydrate the current step, then retry with output.notesMarkdown ...'

// After (contract-specific, using the artifact schema's own guidance):
case 'missing_required_output':
  const contractGuidance = getContractBlockedGuidance(contractRef);
  suggestedFix: contractGuidance
    ?? 'Retry with the required artifact in output.artifacts.';
```

Where `getContractBlockedGuidance(contractRef)` is a registry function in
`artifacts/index.ts` that routes to the correct `getBlockedMessage()` function, returns
null for unknown contractRefs. One new function; no per-contract code changes.

For `blocked_attempt_limit_exceeded` in `advance.ts`, replace the hardcoded
`wr.assessment` message with a lookup: load the step's outputContract from the snapshot
(already available as `snap.enginePayload.engineState.blocked.blockers[0]?.pointer.contractRef`
after reading the blocked snapshot) and format the scaffold from that contractRef.

### Survives framing test

- If content-based: YES -- fixes the wrong advice and the wrong type in limit-exceeded.
  Blocked responses now say the right thing. Good chance the agent follows correct guidance
  on first blocked response.
- If position-based: PARTIAL -- guidance is still only in the tool result. If the agent
  cannot attend to guidance that appeared in tool results 50+ turns ago, this does not
  help. The tool result at the moment of failure IS adjacent to the current action, but
  for failure 1 this is fine and for failure 3 (limit-exceeded) the error still appears
  in the current turn. For failures between 1-3, the blocked response is adjacent to the
  failed call, so position may be adequate for 66-turn cases too.

---

## Approach 2 (p=0.35): Steer-amplified blocked feedback via turn_end subscriber

**Primary mechanism:** After each `complete_step` or `continue_workflow` that returns a
blocked response, use `scope.onSteer()` (which pushes to `state.pendingSteerParts`) from
inside the tool's execute() function to inject the exact artifact scaffold into the NEXT
turn via `agent.steer()`. Guidance appears as a user-role message immediately before the
agent's next LLM call -- not embedded in the tool result, not 60 turns back.

### How it addresses position vs. content tension

This is a position fix with a content fix embedded. The steer message is injected at
`turn_end`, which fires after tool results are collected and BEFORE the next LLM call.
The resulting user-role message appears immediately adjacent to the point of action. The
content of the steer message can be identical to the step prompt's scaffold, or can be
more focused ("RETRY REQUIRED: your last complete_step was blocked because..."). The key
insight: the agent's attention is highest on the last user-turn message before the LLM
call, which is where the steer message lands.

### Key tradeoffs

- Strong position guarantee: steer message always appears in the most recent user turn
- Requires the tool to know it should steer, not just return a blocked result text
- The blocked result text is ALSO returned as a tool result -- the steer message is
  additive, not a replacement. This creates redundancy, which may be noise for short
  sessions but insurance for long ones.
- Daemon-only initially: `scope.onSteer` is a daemon-layer concept; MCP-direct callers
  do not have a steer mechanism. However, VISION-ALIGNED criterion requires the fix to
  work across entry points. For MCP callers, the blocked tool result text is the only
  feedback channel, so this approach partially violates the vision criterion.
- Extensibility: the steer content should come from the same `getContractBlockedGuidance()`
  registry as Approach 1. One registry call, one steer push -- no per-contract branching
  at the tool layer.

### Implementation sketch

In `src/daemon/tools/continue-workflow.ts`, inside `makeCompleteStepTool().execute()`,
after building the `feedback` string for the blocked path:

```typescript
if (out.kind === 'blocked') {
  // ... existing blocked handling ...

  // Position fix: inject the contract scaffold as a steer message so it
  // appears in the next user turn, immediately adjacent to the agent's
  // next LLM call. The tool result feedback is also present, but the
  // steer message ensures the guidance is at the TOP of the next context
  // window rather than embedded in a tool result from the previous turn.
  const contractRef = out.blockers.blockers.find(
    b => b.pointer.kind === 'output_contract'
  )?.pointer.contractRef;
  if (contractRef) {
    const scaffold = getContractBlockedGuidance(contractRef);
    if (scaffold) {
      scope.onSteer(
        `REQUIRED ACTION: Your last complete_step was blocked (${contractRef}).\n\n${scaffold}\n\nRetry complete_step now with the corrected artifacts field.`
      );
    }
  }

  return { content: [{ type: 'text', text: feedback }], details: out };
}
```

`scope.onSteer` pushes to `state.pendingSteerParts`; the turn_end subscriber drains it
via `injectPendingSteps()` and calls `agent.steer()`. The steer message appears as the
last user-role message before the next LLM call.

### Survives framing test

- If content-based: YES -- the steer content is accurate (uses contract registry). Even
  if position were not the root cause, the agent sees correct guidance.
- If position-based: YES -- the steer message is at the point of failure, not 60 turns
  back. This is the fix that directly addresses the riskiest assumption. If the model
  cannot attend to tool results from 50+ turns ago but reliably attends to the most
  recent user-turn message, this approach fixes the failure mode.

---

## Approach 3 (p=0.15): Adaptive steer budget with attempt counter

**Primary mechanism:** Track how many consecutive blocked attempts have occurred on a
given step in `SessionState` (a new field: `consecutiveBlockedAttempts: number`). Scale
the steer content to become more emphatic and more specific with each attempt. Attempt 1:
brief reminder. Attempt 2: full scaffold with parameter path. Attempt 3: halt signal +
full scaffold + explicit instruction to abandon other work and fix this.

### How it addresses position vs. content tension

Both: position fix via steer() on each blocked attempt; content fix via escalating
specificity. The hypothesis behind this approach is that the agent may be correctly
reading the first blocked response but still failing because of competing priorities
(other context from 60+ turns of work). The escalating message forces the current
failure to the TOP of the next turn's user context with increasing urgency.

### Key tradeoffs

- Complexity: requires tracking attempt counter in SessionState, resetting it on
  successful advance, reading it in the tool execute path
- Diagnostic value: the attempt counter in SessionState is observable via WorkTrain
  diagnose -- operators can see "agent was blocked 3 times on step X" in session state
- Noise: attempt 1 steer message is a mild reminder; attempt 3 is loud. The escalation
  is intentional but may cause a well-functioning agent to see noise it does not need.
- MCP gap: same as Approach 2 -- steer is daemon-only. MCP clients see only the blocked
  tool result text, which is fixed by Approach 1 but not amplified.
- Extensibility: one new SessionState field, one counter increment in the tool, one reset
  on advance. New contractRefs automatically use the registry for their scaffold content.

### Implementation sketch

New field in `SessionState`:
```typescript
consecutiveBlockedAttempts: number;  // reset to 0 on each advanceStep()
```

In `makeCompleteStepTool().execute()` on blocked path:
```typescript
scope.onConsecutiveBlock?.(); // increments state.consecutiveBlockedAttempts

const attempt = state.consecutiveBlockedAttempts; // read after increment
const scaffold = getContractBlockedGuidance(contractRef) ?? '';
if (attempt === 1) {
  scope.onSteer(`Your complete_step was blocked. ${scaffold}`);
} else if (attempt === 2) {
  scope.onSteer(
    `BLOCKED AGAIN (attempt ${attempt}). You must submit the artifact in the ` +
    `"artifacts" field of complete_step, not in notesMarkdown.\n\n${scaffold}`
  );
} else {
  scope.onSteer(
    `CRITICAL: Step blocked ${attempt} times. Stop all other work. ` +
    `The ONLY call you must make is complete_step with this exact artifact:\n\n${scaffold}`
  );
}
```

`advanceStep()` resets `state.consecutiveBlockedAttempts = 0`.

### Survives framing test

- If content-based: YES -- content escalates with each attempt, covering more potential
  misconceptions (wrong field, wrong type, wrong format) progressively.
- If position-based: YES -- steer messages appear at the current turn on every blocked
  attempt. Even at attempt 3 at turn 66, the steer fires immediately before the next
  LLM call.

---

## Approach 4 (p=0.08): System prompt artifact contract injection at session start

**Primary mechanism:** When a workflow step has an outputContract, inject the contract's
full scaffold into the SYSTEM PROMPT for the session, not just the step prompt. System
prompts are prepended to every API call and receive privileged attention from the model.
For sessions that use `buildSystemPrompt()`, extend it to include a "Required artifacts
for this workflow" section derived from compiling all outputContracts declared across the
workflow's steps.

### How it addresses position vs. content tension

This is a position fix at the system level. The system prompt is always at position 0
in the context window, but unlike user-turn messages it appears BEFORE the entire
conversation and receives the model's full attention at every turn. The risk is that
"always present" is equivalent to "always ignorable" -- the model may anchor on recent
context regardless of system prompt content. The mechanism is different from steer: it
does not change the relative position of guidance vs the failed call, but it ensures
the guidance is in the privileged system prompt rather than a user-role message.

### Key tradeoffs

- Architectural: this is a compile-time change (scan all workflow steps for outputContracts,
  emit their scaffolds into the system prompt). No runtime state changes.
- Position: system prompt appears at the top of every call -- it is never "60 turns ago."
  However, it is also never "right next to the failed call." For very long contexts, the
  model's attention to early parts of the system prompt may still decay.
- Noise: every step in the session has the same system prompt, even steps that do not
  require artifacts. Steps without outputContracts receive irrelevant guidance.
- Scope creep: `buildSystemPrompt()` is in `src/daemon/core/session-context.ts`.
  Modifying it requires compiling workflow steps to find all outputContracts -- this is
  reasonable since `firstStepPrompt` is already available at that point.
- Extensibility: the registry approach works here too. `getContractBlockedGuidance()`
  is called once per unique contractRef in the workflow, at session start. No per-contract
  code changes.
- Vision alignment: system prompt injection affects ALL entry points (MCP and daemon)
  because both call `buildSystemPrompt()` or equivalent.

### Implementation sketch

In `src/daemon/core/session-context.ts`, `buildSessionContext()`:

```typescript
// Extract all unique outputContracts from workflow steps (compile-time, not runtime)
const artifactContracts = extractOutputContracts(firstStepPrompt, workflow);
// ... hypothetical; requires workflow definition access here
const contractSection = artifactContracts.length > 0
  ? `\n\n## Required artifacts in this workflow\n\n` +
    artifactContracts
      .map(ref => getContractBlockedGuidance(ref))
      .filter(Boolean)
      .join('\n\n')
  : '';

const systemPrompt = `${BASE_SYSTEM_PROMPT}${contractSection}\n\n...`;
```

This would need the workflow definition to be available at `buildSessionContext()` time,
which it currently is not -- the workflow is loaded in the tool layer, not the session
context layer. This is a moderate architectural change.

### Survives framing test

- If content-based: YES -- the system prompt contains accurate, complete scaffolds for
  each required artifact type.
- If position-based: UNCERTAIN -- the system prompt is always first, but the model's
  attention to system prompt content at turn 66 in a 1.7M-token context is an empirical
  question. Evidence from production LLM deployments suggests system prompts maintain
  higher attention than archived user turns, but this is not guaranteed. This approach
  is the position-fix equivalent of "write it big enough to be seen from far away" --
  it puts guidance in the highest-priority slot available.

---

## Approach 5 (p=0.04): Token-level self-repair: inject schema as tool description mutation

**Primary mechanism:** Mutate the `complete_step` tool description dynamically when the
current step has an outputContract. Instead of a static description, generate a step-
specific description that includes the contract scaffold inline in the tool's JSON schema
description field. Since tool descriptions are part of the tools array in every
`client.messages.create()` call, this guidance is structurally adjacent to the tool
invocation -- the model must read the tool definition to call it.

### How it addresses position vs. content tension

This is a structural position fix at the LLM API level. Tool descriptions are part of
the tools array parameter, not the messages array. They appear in every API call
regardless of conversation length, and the model processes them as part of understanding
which tools are available. Unlike user-turn messages or system prompts, tool descriptions
cannot be "60 turns ago" -- they are always fresh in each API call. The hypothesis is
that when the correct format is embedded in the tool definition the agent must read to
call the tool, it cannot miss the guidance.

### Key tradeoffs

- Novel: this approach exploits the tool definition channel, which is separate from
  both the conversation messages and the system prompt. To our knowledge this is not a
  documented best practice, which is why p=0.04.
- Dynamic tool mutation: `AgentLoop` currently holds the tools array as a static
  readonly at construction time. Making tool descriptions dynamic requires either (a)
  rebuilding the tools array per-turn, or (b) a mutable description accessor on AgentTool.
  Option (b) is cleaner -- the tool returns its current description from a getter, which
  closes over `state.currentOutputContract` from the daemon scope.
- API surface: tool descriptions have an undocumented character limit; very long
  descriptions may be truncated or produce API errors. The scaffold for `wr.loop_control`
  is ~200 chars -- well within any plausible limit.
- Extensibility: the registry approach works here. `getContractBlockedGuidance()` is
  called from the description getter, parameterized by the current step's contractRef.
  No per-contract code changes.
- Complexity: requires AgentLoop to accept a description factory OR tool mutation API.
  This is a non-trivial change to the agent loop's interface contract.
- Vision alignment: this affects all callers of AgentLoop (daemon only, since MCP calls
  execute through the handler layer without AgentLoop). MCP clients do not benefit.

### Implementation sketch

Add a mutable description field to `AgentTool`:

```typescript
export interface AgentTool {
  readonly name: string;
  // description can be a getter so the tool returns step-specific text
  readonly description: string;  // existing -- or:
  getDescription?(): string;     // new: if present, called per API call
  // ...
}
```

In `AgentLoop._runLoop()`, when building `apiTools`:
```typescript
const apiTools: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.getDescription ? t.getDescription() : t.description,
  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
}));
```

In `makeCompleteStepTool()`, the description getter closes over `scope.getCurrentOutputContract()`:
```typescript
getDescription(): string {
  const contract = scope.getCurrentOutputContract?.();
  if (!contract) return STATIC_COMPLETE_STEP_DESCRIPTION;
  const scaffold = getContractBlockedGuidance(contract.contractRef);
  return scaffold
    ? `${STATIC_COMPLETE_STEP_DESCRIPTION}\n\nCurrent step requires: ${scaffold}`
    : STATIC_COMPLETE_STEP_DESCRIPTION;
}
```

`scope.getCurrentOutputContract()` would return the `outputContract` from the compiled
step definition for the current pending step -- this is available in the daemon scope via
the running session state.

### Survives framing test

- If content-based: YES -- the scaffold is in the tool description, accurate and
  complete, derived from the contract registry.
- If position-based: YES (strong hypothesis) -- tool definitions are injected fresh
  into every API call, bypassing the conversation history entirely. If the model's
  failure is that it cannot attend to user-turn messages from 60 turns ago, tool
  descriptions are structurally immune to this failure mode. This is the highest-
  confidence position fix in the set, but also the most architecturally invasive.

---

## Cross-candidate comparison

| | Approach 1 | Approach 2 | Approach 3 | Approach 4 | Approach 5 |
|---|---|---|---|---|---|
| Fixes wrong content | YES | YES | YES | YES | YES |
| Fixes position | PARTIAL | YES | YES | PARTIAL | YES (structural) |
| Daemon-only | NO | YES | YES | NO | YES |
| MCP path coverage | YES | NO | NO | YES | NO |
| New contractRef: one change | YES (registry) | YES (registry) | YES (registry) | YES (registry) | YES (registry) |
| Complexity | LOW | MEDIUM | MEDIUM | MEDIUM-HIGH | HIGH |
| Survives 66-turn long context | UNCERTAIN | LIKELY | LIKELY | UNCERTAIN | HIGH |

## Recommended pairing

Approach 1 + Approach 2 together:
- Approach 1 fixes the wrong advice in the engine layer for ALL entry points (MCP + daemon),
  addressing the content bug.
- Approach 2 adds position amplification for daemon sessions, ensuring the corrected
  guidance also appears at the right location in the conversation.
- Together they are the content fix + position fix with minimum code change and maximum
  entry-point coverage.
- Neither requires code changes per new contractRef (both use the `getContractBlockedGuidance()`
  registry).
- Together they satisfy all five criteria: consistency (Approach 1 makes the engine the
  single source of truth), one-change extensibility (registry), correct wrong-kind feedback
  (Approach 1), guidance at the right time (Approach 2), and all entry points (Approach 1
  covers MCP, Approach 2 covers daemon).
