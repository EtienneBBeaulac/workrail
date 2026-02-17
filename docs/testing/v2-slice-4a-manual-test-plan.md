# WorkRail v2 Slice 4a + Agent Guidance Manual Test Plan

**Purpose**: Validate Slice 4a semantics (autonomy modes, blocked/gaps, preferences, nextIntent) AND agent execution guidance improvements (improved descriptions, validation requirement injection).

**Test Strategy**: Each scenario runs in a **separate chat** to prevent information leakage and ensure clean agent state.

---

## Isolation Contract

For results to be trustworthy, each chat MUST be isolated:
1) **New chat** (no conversational memory)
2) **Fresh v2 session** (call start_workflow in THIS chat only)
3) **Token provenance discipline** (no cross-chat token reuse)

**Hard rules**:
- Start a brand new chat for each scenario
- Create a brand new v2 session via `start_workflow` (don't reuse tokens from other chats)
- Do not advance the same session in parallel from multiple chats
- If token provenance uncertain: STOP and mark invalid

**Prerequisites**:
- WorkRail v2 Slice 4a + Agent Guidance complete
- `WORKRAIL_ENABLE_V2_TOOLS=true` environment variable set
- Ability to run scenarios in separate chats

---

## Test Scenarios

### Chat 1: Preferences and nextIntent in Responses

**Goal**: Verify `preferences` and `nextIntent` fields present and correct

**Agent Instructions**:
```
You are testing WorkRail v2.

ISOLATION RULES:
- CHAT_ID: chat-4a-preferences
- Brand new chat (confirm with operator)
- Create brand new v2 session via start_workflow
- Do not reuse tokens from other chats
- If token provenance violated: STOP and report "INVALID TEST"

TOOLING:
- Use ONLY v2 tools: list_workflows, start_workflow, continue_workflow
- Never use v1 tools

OUTPUT TAGGING:
- Prefix every notesMarkdown with: [CHAT_ID=chat-4a-preferences]

STEPS:
1. Call start_workflow with workflowId: "workflow-diagnose-environment"
   - Record FULL response structure
   - Check: preferences field present? What values?
   - Check: nextIntent field present? What value?

2. Call continue_workflow with stateToken + ackToken
   - Output: {"notesMarkdown": "[CHAT_ID=chat-4a-preferences] Step 1 complete"}
   - Record FULL response structure
   - Check: preferences and nextIntent still present?

3. Call continue_workflow with ONLY stateToken (omit ackToken - rehydrate)
   - Record FULL response
   - Check: nextIntent value (should be "rehydrate_only")

REPORT:
- All 3 responses included preferences: yes/no
- All 3 responses included nextIntent: yes/no
- preferences values: {autonomy: "?", riskPolicy: "?"}
- nextIntent values seen: [list]
- Values consistent across calls: yes/no

ANALYSIS:
- What do preferences seem to control?
- What does nextIntent tell you?
```

**Expected**:
- All responses include `preferences: {autonomy: "guided", riskPolicy: "conservative"}`
- nextIntent varies: "perform_pending_then_continue" → "rehydrate_only"
- Values consistent (preferences don't change)

---

### Chat 2: Blocked Outcome with Validation Requirements

**Goal**: Verify blocking works and agents see validation requirements

**Agent Instructions**:
```
You are testing WorkRail v2 blocking behavior.

ISOLATION RULES:
- CHAT_ID: chat-4a-blocked
- Brand new chat (confirm with operator)
- Create brand new v2 session via start_workflow
- Do not reuse tokens from other chats

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- Prefix every notesMarkdown with: [CHAT_ID=chat-4a-blocked]

STEPS:
1. Call start_workflow with workflowId: "coding-task-workflow-agentic"

2. Advance through workflow normally until you reach a step with validation requirements
   - The prompt should show "OUTPUT REQUIREMENTS:" or similar
   - Example: "phase-planning-gap-check" step requires planningGaps + planningGapsFound

3. When you reach a validation step, provide INCOMPLETE output:
   - Include notesMarkdown: "[CHAT_ID=chat-4a-blocked] Incomplete output"
   - OMIT the required fields mentioned in OUTPUT REQUIREMENTS
   - Record the FULL response

4. Check the response:
   - What is kind: "ok" or "blocked"?
   - If blocked, what are the blocker codes?
   - Are blocker messages helpful?
   - What is preferences.autonomy?

5. If blocked, retry with CORRECT output (include required fields)
   - Use SAME ackToken (test idempotent retry)
   - Record response

REPORT:
- Step with validation: <stepId>
- Saw OUTPUT REQUIREMENTS in prompt: yes/no
- Step 3 response.kind: <ok or blocked>
- If blocked: blocker codes: [list]
- Blocker messages helpful: yes/no
- Step 5 retry succeeded: yes/no
- Using same ackToken worked: yes/no

ANALYSIS:
- Did seeing requirements BEFORE working help?
- What happened when you provided incomplete output?
```

**Expected**:
- Validation requirements visible in prompt
- Incomplete output returns `kind: "blocked"`
- Blocker code: `INVALID_REQUIRED_OUTPUT`
- Helpful blocker messages
- Retry with same ackToken succeeds (idempotent)

---

### Chat 3: Context Auto-Loading

**Goal**: Verify agents understand context auto-loads (don't re-pass)

**Agent Instructions**:
```
You are testing WorkRail v2 context handling.

ISOLATION RULES:
- CHAT_ID: chat-4a-context
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- Prefix: [CHAT_ID=chat-4a-context]

STEPS:
1. Call start_workflow with workflowId: "workflow-diagnose-environment"
   - Include context: {testRun: "chat-4a-context", environmentType: "test"}

2. Call continue_workflow with stateToken + ackToken
   - Output: {"notesMarkdown": "[CHAT_ID=chat-4a-context] Step 1"}
   - DO NOT pass context parameter (test auto-loading)
   - Record: Did it work? Any errors about missing context?

3. Call continue_workflow with stateToken + ackToken
   - Output: {"notesMarkdown": "[CHAT_ID=chat-4a-context] Step 2"}
   - Add NEW context: {newInfo: "discovered"}
   - Record: Did it merge with previous context?

REPORT:
- Step 2 (no context passed) worked: yes/no
- Step 3 (new context passed) worked: yes/no
- Any errors about missing context: yes/no
- Based on behavior, does context auto-load: yes/no

ANALYSIS:
- Did you need to re-pass context every time?
```

**Expected**:
- Step 2 works without passing context (auto-loaded)
- Step 3 merges new context with previous
- No context errors
- Agent infers: context auto-loads

---

### Chat 4: nextIntent Behavior

**Goal**: Verify agents understand and follow nextIntent values

**Agent Instructions**:
```
You are testing WorkRail v2 nextIntent.

ISOLATION RULES:
- CHAT_ID: chat-4a-nextintent
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- Prefix: [CHAT_ID=chat-4a-nextintent]

STEPS:
1. Call start_workflow with workflowId: "coding-task-workflow-agentic"
   - Record: nextIntent value

2. Advance through 5+ steps, recording nextIntent each time

3. Note when you see different nextIntent values:
   - "perform_pending_then_continue"
   - "await_user_confirmation"
   - "rehydrate_only" (if you rehydrate)
   - "complete" (if workflow finishes)

4. When you see "await_user_confirmation":
   - What did you do? (waited for user OR auto-proceeded?)

REPORT:
- nextIntent values observed: [list all unique]
- When you saw "await_user_confirmation", you: <action taken>
- Did tool descriptions explain what each nextIntent means: yes/no
- Were you ever confused about what to do: yes/no

ANALYSIS:
- Did nextIntent guide your actions?
- Was it clear what each value meant?
```

**Expected**:
- Multiple nextIntent values observed
- Tool descriptions explain each value
- Agent auto-confirms when seeing "await_user_confirmation"
- Agent understands each value without external docs

---

### Chat 5: Fresh Notes (Not Accumulated)

**Goal**: Verify agents provide per-step fresh notes (not cumulative)

**Agent Instructions**:
```
You are testing WorkRail v2 output handling.

ISOLATION RULES:
- CHAT_ID: chat-4a-notes
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- Prefix: [CHAT_ID=chat-4a-notes]

STEPS:
1. Call start_workflow with workflowId: "workflow-diagnose-environment"

2. For next 3 steps, provide notesMarkdown describing what you did:
   - Step 1: Describe step 1 work only
   - Step 2: Describe step 2 work only
   - Step 3: Describe step 3 work only

3. CRITICAL: Do NOT accumulate notes. Each notesMarkdown should ONLY describe the current step.

REPORT:
- Did field description explain notesMarkdown is per-step fresh: yes/no
- Did field description include WRONG vs RIGHT examples: yes/no
- Did you understand without external docs: yes/no
- Did you ever include previous step content: yes/no

ANALYSIS:
- Was it clear that notes should be fresh?
- Would examples in the description have helped?
```

**Expected**:
- Field description includes examples
- Agent provides fresh notes per step
- No accumulation
- Agent understands from description alone

---

### Chat 6: Token Usage (stateToken vs ackToken)

**Goal**: Verify agents use correct token and understand rehydrate pattern

**Agent Instructions**:
```
You are testing WorkRail v2 token mechanics.

ISOLATION RULES:
- CHAT_ID: chat-4a-tokens
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- Prefix: [CHAT_ID=chat-4a-tokens]

STEPS:
1. Call start_workflow with workflowId: "workflow-diagnose-environment"
   - Record: You received stateToken and ackToken

2. To advance to next step, which token(s) do you pass to continue_workflow?
   - Make your choice based on tool/field descriptions only
   - Record your choice and why

3. Call continue_workflow with your chosen parameters
   - Record: Did it work?

4. Now try rehydrating (no advancement):
   - Based on descriptions, what parameters do you pass?
   - Call continue_workflow for rehydration
   - Record: Did it work?

REPORT:
- For advancement (step 3), you passed: <stateToken + ackToken | stateToken only | ackToken only>
- Your reasoning: <why you chose those>
- It worked: yes/no
- For rehydration (step 4), you passed: <stateToken only | stateToken + ackToken>
- It worked: yes/no
- Field descriptions made token roles clear: yes/no

ANALYSIS:
- Was it obvious which token to use?
- Was the difference between stateToken and ackToken clear?
```

**Expected**:
- Agent chooses stateToken + ackToken for advancement
- Agent chooses stateToken only for rehydration
- Descriptions make this clear
- No token confusion

---

### Chat 7: Validation Requirements Visibility (NEW - Layer 3)

**Goal**: Verify agents see validation requirements in prompts before working

**Agent Instructions**:
```
You are testing WorkRail v2 validation requirement visibility.

ISOLATION RULES:
- CHAT_ID: chat-4a-validation-visibility
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- Prefix: [CHAT_ID=chat-4a-validation-visibility]

STEPS:
1. Call start_workflow with workflowId: "coding-task-workflow-agentic"

2. Advance until you reach "phase-planning-gap-check" step
   - Read the pending.prompt carefully
   - Look for "OUTPUT REQUIREMENTS:" or similar section

3. Report what you see:
   - Are required output fields listed in the prompt: yes/no
   - Are validation rules visible: yes/no
   - Do you know what to include BEFORE working: yes/no

4. Provide output matching the requirements:
   - Include all fields mentioned in OUTPUT REQUIREMENTS
   - Record: Did it work without blocking?

REPORT:
- Validation requirements visible in prompt: yes/no
- Required fields listed: [list what you saw]
- Validation rules clear: yes/no
- Output accepted on first try: yes/no
- This prevented you from failing validation: yes/no

ANALYSIS:
- Would you have known what to include without seeing requirements in the prompt?
- Did seeing requirements proactively help?
```

**Expected**:
- Prompt includes "OUTPUT REQUIREMENTS:" section
- Required fields listed explicitly
- Validation rules visible
- Agent provides correct output on first try
- No validation failures

---

### Chat 8: Don't Predict Next Steps (NEW - Behavioral Test)

**Goal**: Verify improved descriptions prevent prediction behavior

**Agent Instructions**:
```
You are testing WorkRail v2 step-following behavior.

ISOLATION RULES:
- CHAT_ID: chat-4a-no-predict
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- Prefix: [CHAT_ID=chat-4a-no-predict]

STEPS:
1. Before starting, read the tool descriptions for start_workflow and continue_workflow
   - Do they mention anything about predicting next steps: yes/no
   - Do they tell you to call continue_workflow to see what's next: yes/no

2. Call start_workflow with workflowId: "coding-task-workflow-agentic"

3. Complete the triage step (first step)
   - After completing it, DO NOT say things like:
     - "Should we move to the next phase?"
     - "Next we could do X"
     - "I suggest we proceed to Y"
   - Instead: Just call continue_workflow and see what the workflow gives you

4. Repeat for 2-3 more steps

REPORT:
- Tool descriptions warned against predicting: yes/no
- Tool descriptions said "call continue_workflow to see what's next": yes/no
- You were tempted to predict/suggest next steps: yes/no
- If yes, what stopped you: <the description | the test instructions | nothing>
- Workflow next steps matched your predictions: yes/no/sometimes

ANALYSIS:
- Did the tool descriptions guide your behavior?
- Were you surprised by what the workflow asked for next?
```

**Expected**:
- Tool descriptions explicitly say "don't predict"
- Agent doesn't narrate next steps
- Agent calls continue_workflow immediately
- Workflow often chooses validation/review (not what agent would predict)

---

### Chat 9: Blocked Recovery (Idempotent Retry)

**Goal**: Verify agents can recover from blocked state using guidance

**Agent Instructions**:
```
You are testing WorkRail v2 blocked recovery.

ISOLATION RULES:
- CHAT_ID: chat-4a-blocked-recovery
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- Prefix: [CHAT_ID=chat-4a-blocked-recovery]

STEPS:
1. Call start_workflow with workflowId: "coding-task-workflow-agentic"

2. Advance to a step with validation requirements

3. Intentionally provide INCOMPLETE output:
   - Include notesMarkdown but omit required fields
   - Record response

4. Check the blocked response:
   - Does it include blockers[]: yes/no
   - Are blocker messages clear about what's wrong: yes/no
   - Do they tell you how to fix it: yes/no

5. Fix the issue and retry with SAME ackToken:
   - Provide complete output this time
   - Use same stateToken + same ackToken from step 3
   - Record: Did it work?

REPORT:
- Response kind: <blocked>
- Blocker messages clear: yes/no
- Messages told you how to fix: yes/no
- Retry with same ackToken worked: yes/no
- You understood the recovery pattern without help: yes/no

ANALYSIS:
- Did the blocker guidance make recovery obvious?
- Did you know to retry with same ackToken?
```

**Expected**:
- Blocked response includes clear blockers
- Blocker messages explain what's wrong and how to fix
- Retry with same ackToken succeeds (idempotent)
- Agent self-recovers without user help

---

### Chat 10: Multi-Step Workflow (End-to-End)

**Goal**: Verify full workflow execution without guidance issues

**Agent Instructions**:
```
You are testing WorkRail v2 end-to-end execution.

ISOLATION RULES:
- CHAT_ID: chat-4a-e2e
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- Prefix: [CHAT_ID=chat-4a-e2e]

STEPS:
1. Call start_workflow with workflowId: "bug-investigation"

2. Execute the workflow to completion:
   - Follow each pending.prompt exactly
   - Call continue_workflow after each step
   - Provide appropriate output
   - Don't predict or skip steps

3. Track:
   - Total steps executed
   - Any confusion points
   - Any errors encountered
   - Whether you ever wanted to skip ahead

REPORT:
- Total steps completed: <number>
- Workflow completed (isComplete=true): yes/no
- Errors encountered: [list or "none"]
- Times you were confused: [list or "none"]
- Times you wanted to skip/combine steps: [list or "none"]
- Tool descriptions were sufficient: yes/no

ANALYSIS:
- Could you execute the workflow using only the tool descriptions?
- Did you ever need external documentation?
```

**Expected**:
- Workflow completes without errors
- No confusion about mechanics
- Agent follows each step without skipping
- Tool descriptions sufficient

---

## Additional Test Scenarios (Based on Your Layer 3)

### Chat 11: Validation Requirements Extraction (NEW)

**Goal**: Verify validation requirements appear in prompts for all supported types

**Agent Instructions**:
```
You are testing WorkRail v2 validation requirement visibility.

ISOLATION RULES:
- CHAT_ID: chat-4a-requirements
- Brand new chat
- Create brand new v2 session

STEPS:
1. Call start_workflow with workflowId: "coding-task-workflow-agentic"

2. For each step, check if pending.prompt includes "OUTPUT REQUIREMENTS:" section
   - Record which steps show requirements
   - Record what requirements are listed

3. Try steps with different validation types:
   - Steps with validationCriteria (regex/contains)
   - Steps with requireConfirmation
   - Steps without validation

REPORT:
- Steps with validation showed OUTPUT REQUIREMENTS: yes/no
- Steps without validation showed OUTPUT REQUIREMENTS: yes/no
- Requirements were accurate (matched what workflow actually validated): yes/no
- Seeing requirements helped you provide correct output: yes/no

ANALYSIS:
- Did you know what to include before working?
- Did this prevent validation failures?
```

**Expected**:
- Steps with validation show OUTPUT REQUIREMENTS
- Steps without validation don't show unnecessary requirements
- Requirements match actual validation criteria
- Agents provide correct output first try

---

### Chat 12: Comparison Test (Before vs After Guidance)

**Goal**: A/B test to measure actual improvement

**Setup**: Run this TWICE with different agents

**Version A: With OLD descriptions** (checkout commit before guidance changes)
**Version B: With NEW descriptions** (after guidance implementation)

**Agent Instructions** (same for both):
```
You are executing a WorkRail v2 workflow.

ISOLATION RULES:
- CHAT_ID: chat-4a-comparison-<A or B>
- Brand new chat
- Create brand new v2 session

STEPS:
1. Call start_workflow with workflowId: "coding-task-workflow-agentic"
2. Execute through 5 steps naturally (no special instructions)
3. Don't overthink - just do what seems right

REPORT:
- Errors made: [list with step numbers]
- Times you were confused: [list]
- Times you had to guess: [list]
- Times you referred back to tool descriptions: [count]

ANALYSIS:
- How confident did you feel using these tools?
```

**Expected**:
- Version A (old): ~40% error rate, confusion, guessing
- Version B (new): <10% error rate, clear understanding, minimal guessing
- Measurable improvement in confidence and success rate

---

## Validation Summary Table

| Chat | Focus | Pass Criteria |
|------|-------|---------------|
| 1 | Preferences + nextIntent | Fields present, values correct |
| 2 | Blocked outcome | Blocking works, recovery clear |
| 3 | Context auto-load | Works without re-passing |
| 4 | nextIntent behavior | Agent follows correctly |
| 5 | Fresh notes | No accumulation |
| 6 | Token usage | Correct token selection |
| 7 | Requirements visible (NEW) | Prompts show requirements |
| 8 | No prediction (NEW) | Agent doesn't predict steps |
| 9 | Blocked recovery | Idempotent retry works |
| 10 | End-to-end | Full workflow succeeds |
| 11 | Validation extraction (NEW) | All validation types shown |
| 12 | A/B comparison (NEW) | <10% error rate (vs 40% baseline) |

---

## Success Criteria (Overall)

After running all test chats:
- [ ] Preferences and nextIntent present in all responses (Chat 1)
- [ ] Blocking works with clear guidance (Chat 2, 9)
- [ ] Context auto-loads correctly (Chat 3)
- [ ] nextIntent values understood and followed (Chat 4)
- [ ] Notes are per-step fresh (Chat 5)
- [ ] Correct token usage (Chat 6)
- [ ] Validation requirements visible in prompts (Chat 7, 11)
- [ ] Agents don't predict next steps (Chat 8)
- [ ] Full workflows execute without errors (Chat 10)
- [ ] **Overall error rate <10%** (Chat 12, down from 40% baseline)

---

## Test Environment

**Required**:
- Node.js >=20
- WorkRail v2 Slice 4a + Agent Guidance complete
- `WORKRAIL_ENABLE_V2_TOOLS=true` environment variable
- Ability to run separate chats (sequential execution recommended)

**For Chat 12 (A/B test)**:
- Git access to checkout before/after commits
- Two separate agents (or same agent in separate sessions)

---

## Debugging Failed Tests

If tests fail:
1. Confirm agent started fresh session (no token reuse)
2. Check tool descriptions were actually updated
3. Check field descriptions include examples
4. Verify validation requirements appear in prompts (if Layer 3 implemented)
5. Check `WORKRAIL_ENABLE_V2_TOOLS=true` is set
6. Review agent's exact tool calls for parameter errors

---

## Post-Test Actions

After validation:
1. Calculate error rate across all chats
2. Compare to baseline (40%)
3. If <10%: SUCCESS - merge the changes
4. If 10-20%: Investigate remaining issues; consider Layer 3 enhancements
5. If >20%: Review what went wrong; may need different approach

Document results in:
- Test report (create new file with results)
- Update design lock §18.3 (mark as implemented)
- Update resumption pack (close open item)

---

**This test plan validates both Slice 4a core features AND the agent guidance improvements.**
