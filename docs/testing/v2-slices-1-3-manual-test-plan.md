# WorkRail v2 Slices 1-3 Manual Test Plan (Agent-Executable)

**Purpose**: Systematically verify v2 Slices 1-3 (read-only tools, append-only substrate, token orchestration) work correctly with existing v1 workflows.

**Test Strategy**: Each test scenario runs in a **separate chat** to prevent information leakage and ensure clean agent state.

## Isolation Contract (prevents test bleed)
For results to be trustworthy, each chat MUST be isolated at three layers:
1) **New chat** (no conversational memory bleed)
2) **Fresh v2 session** (session-scoped correctness boundary)
3) **Token provenance discipline** (no cross-chat token reuse)

Hard rules (required):
- **Start a brand new chat** for each scenario.
- **In each chat, create a brand new v2 session** by calling `start_workflow` and only use tokens minted in that chat.
- **Do not reuse tokens across chats**. Treat tokens as single-scenario secrets.
- **If token provenance is uncertain** (copied from another chat, or you're not sure): STOP and mark the scenario invalid.
- **Do not advance the same session in parallel** from multiple chats (single-writer per session). Recommended: run all chats sequentially.

Why this works for Slices 1–3:
- The correctness properties being tested (rehydrate purity, replay/idempotency, fork-on-rewind) are session-scoped.
- Old sessions on disk do not affect these tests unless you reuse tokens or race on the same session.

Optional stronger durable isolation (only if feasible in your environment):
- Restart the WorkRail MCP server between chats with a fresh data root.

**Prerequisites**:
- WorkRail v2 Slices 1-3 implementation complete
- `WORKRAIL_ENABLE_V2_TOOLS=true` set in environment
- Ability to run each scenario in a separate chat (no parallel runs)

**Workflow Assignments** (use these exact workflow IDs):
| Chat | CHAT_ID | Workflow ID | Reason |
|------|---------|-------------|--------|
| 1 | `chat-1-happy-path` | `bug-investigation` | Multi-step, no loops, good for happy path |
| 2 | `chat-2-rewind-fork` | `workflow-diagnose-environment` | Simple (2-3 steps), fast rewind testing |
| 3 | `chat-3-idempotency-replay` | `workflow-diagnose-environment` | Simple, fast replay testing |
| 4 | `chat-4-rehydrate-only` | `workflow-diagnose-environment` | Simple, fast rehydrate testing |
| 5 | `chat-5-error-modes` | `workflow-diagnose-environment` | Any workflow works for error tests |
| 6 | `chat-6-token-security` | `workflow-diagnose-environment` | Any workflow works for token tests |
| 7 | `chat-7-multi-step` | `bug-investigation` | Multi-step, tests full execution |
| 8 | `chat-8-hash-stability` | `bug-investigation` | Multi-step, tests hash stability |

---

## Test Execution Instructions (Human Operator)

For each test chat below:
1. Start a **brand new chat** (critical for isolation).
2. Copy the entire **Agent Instructions** block for that chat (includes CHAT_ID and all rules).
3. Let the agent execute without interruption.
4. Collect the agent's final report.
5. Verify against "Expected Outcomes".
6. Record pass/fail in the summary table.

Stop condition:
- If token provenance is violated (a token from another chat is used, or provenance is uncertain), stop and restart the chat. Mark the attempt invalid.

Note: This plan assumes the WorkRail MCP server may be a single long-lived process. Durable isolation is achieved by creating a brand new v2 session in each chat via `start_workflow` and never reusing tokens across chats.

### Token Copy Discipline (Operator) (prevents agent token corruption)
Tokens must be used **exactly as returned**. LLM agents may accidentally mutate long opaque tokens when re-printing them.

Rules:
- When you need to save a token for later (Chat 2), copy it from the **tool response JSON** (the tool output block), not from any agent re-typed/re-printed token.
- Never retype tokens; always copy/paste.
- When recording logs, redact token values (first 16 chars + `…`), but keep a private copy of full tokens if you need them to continue the scenario.
- If you see `TOKEN_BAD_SIGNATURE` while using a token you believe is correct, assume copy/transcription corruption and **restart the chat**. Do **not** “work around” by starting a new session in the same chat.

---

## Chat 1: Basic Execution Loop (Happy Path)

**Scenario**: Execute a workflow from start to completion using v2 tools.

**Information Isolation**: Agent learns workflow exists, executes it, and reports. No prior knowledge of v2 internals needed.

### Agent Instructions (copy verbatim into new chat)

```
You are running WorkRail v2 slice validation.

SETUP:
- CHAT_ID is: chat-1-happy-path
- Use CHAT_ID in every output you submit.

NON-NEGOTIABLE ISOLATION RULES:
- Confirm with the operator that this is a brand new chat.
- Confirm you will create a brand new v2 session in THIS chat by calling start_workflow.
- Do not reuse tokens from any other test chat.
- Do not advance the same session in parallel from multiple chats.
- If token provenance is violated or uncertain: STOP and report "INVALID TEST: TOKEN CONTAMINATION".

TOOLING RULES:
- Use ONLY v2 tools: list_workflows, inspect_workflow, start_workflow, continue_workflow.
- Never use workflow_next or any v1 tools.
- Never inspect/decode token contents.
- Do not attempt any resume-like behavior; only use sessions created in this chat.

OUTPUT TAGGING RULES:
- Every notesMarkdown you submit MUST be prefixed with:
  [CHAT_ID=chat-1-happy-path][SCENARIO=basic-execution] 

REPORTING RULES:
- For each tool call, record: tool name, key inputs (redact tokens to first 16 chars + '…'), and the full response.
- If you hit an error: record code/message and STOP the chat.

---

You are testing WorkRail v2 basic execution. Follow these steps exactly and report results:

SETUP:
1. Verify v2 tools are available by calling list_workflows
   - Confirm you receive a response with workflow list
   - Confirm "bug-investigation" is in the list

EXECUTION:
2. Call start_workflow with workflowId: "bug-investigation"
   - Record the response structure (what fields are present)
   - Save stateToken, ackToken, and the pending step details

3. Complete the first pending step
   - Call continue_workflow with the stateToken and ackToken
   - Provide minimal output: {"notesMarkdown": "[CHAT_ID=chat-1-happy-path][SCENARIO=basic-execution] Step 1 complete"}
   - Record the response structure

4. Continue until workflow completes
   - Repeat step 3 for each subsequent step
   - Stop when isComplete becomes true

REPORT (structured):
- Workflow ID tested: <id>
- Total steps completed: <number>
- All tokens received were opaque strings: yes/no
- Pending prompts were non-empty: yes/no
- Final isComplete value: <value>
- Any errors encountered: <list or "none">
- Response structure consistency: <same fields every time? any surprises?>

DO NOT:
- Inspect token contents (they are opaque)
- Rewind the chat
- Use any v1 tools (workflow_next, etc.)
```

### Expected Outcomes
- `list_workflows` returns workflow list
- `start_workflow` returns: `{stateToken, ackToken, checkpointToken, isComplete: false, pending: {...}}`
- `continue_workflow` advances through steps
- Final call returns `isComplete: true, pending: null`
- All tokens are opaque strings (format: `st.v1.*`, `ack.v1.*`, `chk.v1.*`)
- No errors during happy path

---

## Chat 2: Rewind and Fork Behavior

**Scenario**: Test that rewinding creates forks, not state corruption.

**Information Isolation**: Agent executes workflow, then rewinds and continues from an earlier point. Must not know expected fork behavior beforehand.

### Agent Instructions (copy verbatim into new chat)

```
You are running WorkRail v2 slice validation.

SETUP:
- CHAT_ID is: chat-2-rewind-fork
- Use CHAT_ID in every output you submit.

NON-NEGOTIABLE ISOLATION RULES:
- Confirm with the operator that this is a brand new chat.
- Confirm you will create a brand new v2 session in THIS chat by calling start_workflow.
- Do not reuse tokens from any other test chat.
- If token provenance is violated or uncertain: STOP and report "INVALID TEST: TOKEN CONTAMINATION".

TOOLING RULES:
- Use ONLY v2 tools: list_workflows, inspect_workflow, start_workflow, continue_workflow.
- Never use workflow_next or any v1 tools.
- Never inspect/decode token contents.

OUTPUT TAGGING RULES:
- Every notesMarkdown you submit MUST be prefixed with:
  [CHAT_ID=chat-2-rewind-fork][SCENARIO=rewind-fork] 

---

This test requires OPERATOR PARTICIPATION with multiple stopping points.

PHASE 1A: SETUP + ADVANCE TO STEP 1
1. Call list_workflows and confirm "workflow-diagnose-environment" is available
2. Call start_workflow with workflowId: "workflow-diagnose-environment"
   - Save stateToken_0 and ackToken_0
3. Advance step 1: call continue_workflow with stateToken_0 and ackToken_0
   - Output: {"notesMarkdown": "[CHAT_ID=chat-2-rewind-fork][SCENARIO=rewind-fork] Path A: step 1"}
   - Save the NEW tokens (stateToken_1, ackToken_1)

4. STOP and print this message:

---
**CHECKPOINT REACHED - OPERATOR ACTION REQUIRED**

Step 1 is complete. I now have tokens for the rewind test checkpoint.

**SAVE THESE TOKENS NOW** (copy to notepad or external file):
- Copy `stateToken_1` and `ackToken_1` from the **Step 3 continue_workflow tool response JSON** (do not rely on any re-typed/re-printed token text).

When you have saved the tokens, reply with: "Tokens saved. Continue to Path A step 2."

I will then advance to step 2 in my NEXT response (which you will later rewind).

If the next `continue_workflow` fails with `TOKEN_BAD_SIGNATURE`, treat this as token transcription/copy corruption and restart the chat.
---

Then STOP and WAIT for operator response.

PHASE 1B: PATH A STEP 2 (in separate message - THIS IS WHAT GETS REWOUND)
5. When operator says "Continue to Path A step 2", advance step 2:
   - Call continue_workflow with stateToken_1 and ackToken_1
   - Output: {"notesMarkdown": "[CHAT_ID=chat-2-rewind-fork][SCENARIO=rewind-fork] Path A: step 2"}
   - Save stateToken_2 and ackToken_2

6. STOP and print this message:

---
**PATH A COMPLETE - REWIND NOW**

Path A step 2 is complete.

**SAVE THIS TOKEN** (the result of Path A):
- Copy `stateToken_2` from the **Path A step 2 continue_workflow tool response JSON** (do not rely on any re-typed/re-printed token text).

**NOW REWIND THE CHAT:**
1. Delete THIS message (my response containing Path A step 2)
2. Your chat should now end with my previous checkpoint message
3. After rewinding, paste: "Execute Path B with saved tokens:
   stateToken_1: [paste your saved stateToken_1]
   ackToken_1: [paste your saved ackToken_1]
   stateToken_2 from Path A: [paste your saved stateToken_2]"
---

Then STOP and WAIT for operator to rewind and provide tokens.

PHASE 2: PATH B (after rewind - agent has no memory of Phase 1B)
7. When operator provides the tokens, call continue_workflow with stateToken_1 and ackToken_1
   - Output: {"notesMarkdown": "[CHAT_ID=chat-2-rewind-fork][SCENARIO=rewind-fork] Path B: step 2 alternative"}
   - Save the response as stateToken_2b

8. Compare stateToken_2 (from operator, Path A) vs stateToken_2b (from this call, Path B)

REPORT (structured):
- Workflow ID: <id>
- stateToken_2 from Path A (operator provided): <first 20 chars>...
- stateToken_2b from Path B (this call): <first 20 chars>...
- Are these tokens different?: yes/no
- Did Path B continue_workflow succeed?: yes/no
- Any error about "already advanced" or "state mismatch"?: yes/no

ANALYSIS:
- Based on the results, what do you think happened when you advanced from the same checkpoint twice?
```

### Expected Outcomes
- Both `continue_workflow` calls succeed (no "already advanced" error)
- Tokens for the two paths are different (different nodes created)
- No corruption errors
- Agent should observe: "It appears rewinding created two separate paths from the same point"

---

## Chat 3: Idempotency and Replay

**Scenario**: Verify replaying the same ack is idempotent.

**Information Isolation**: Agent doesn't know what idempotency means in this context; just executes and observes.

### Agent Instructions (copy verbatim into new chat)

```
You are running WorkRail v2 slice validation.

SETUP:
- CHAT_ID is: chat-3-idempotency-replay
- Use CHAT_ID in every output you submit.

NON-NEGOTIABLE ISOLATION RULES:
- Confirm with the operator that this is a brand new chat.
- Confirm you will create a brand new v2 session in THIS chat by calling start_workflow.
- Do not reuse tokens from any other test chat.
- Do not advance the same session in parallel from multiple chats.
- If token provenance is violated or uncertain: STOP and report "INVALID TEST: TOKEN CONTAMINATION".

TOOLING RULES:
- Use ONLY v2 tools: list_workflows, inspect_workflow, start_workflow, continue_workflow.
- Never use workflow_next or any v1 tools.
- Never inspect/decode token contents.
- Do not attempt any resume-like behavior; only use sessions created in this chat.

OUTPUT TAGGING RULES:
- Every notesMarkdown you submit MUST be prefixed with:
  [CHAT_ID=chat-3-idempotency-replay][SCENARIO=idempotency-replay] 

REPORTING RULES:
- For each tool call, record: tool name, key inputs (redact tokens to first 16 chars + '…'), and the full response.
- If you hit an error: record code/message and STOP the chat.

---

You are testing WorkRail v2 replay behavior. Follow these steps exactly:

SETUP:
1. Call list_workflows and confirm "workflow-diagnose-environment" is available
2. Call start_workflow with workflowId: "workflow-diagnose-environment"
   - Save stateToken_0 and ackToken_0

FIRST ADVANCEMENT:
3. Call continue_workflow with stateToken_0 and ackToken_0
   - Output: {"notesMarkdown": "[CHAT_ID=chat-3-idempotency-replay][SCENARIO=idempotency-replay] First execution"}
   - Record ENTIRE response (copy/paste the full JSON)
   - Save the new stateToken_1

REPLAY TEST:
4. Call continue_workflow AGAIN with the SAME stateToken_0 and ackToken_0
   - Output: {"notesMarkdown": "[CHAT_ID=chat-3-idempotency-replay][SCENARIO=idempotency-replay] First execution"}
   - Record ENTIRE response again

5. Compare the two responses from steps 3 and 4
   - Are the stateToken values identical?: yes/no
   - Are the ackToken values identical?: yes/no
   - Are the pending prompts identical?: yes/no
   - Is the ENTIRE response structure identical?: yes/no

VERIFICATION:
6. Now try to advance from stateToken_1 (the token from step 3)
   - Did this work?: yes/no
   - If yes, did it create a NEW node or reuse an existing one?

REPORT (structured):
- Responses from step 3 and step 4 were identical: yes/no
- If not identical, list differences: <differences>
- Advancing from stateToken_1 worked: yes/no
- Total nodes created (infer from how many different stateTokens you received): <number>

ANALYSIS:
- What do you think "replay" means in this context?
```

### Expected Outcomes
- Responses from steps 3 and 4 are **byte-identical** (same tokens, same pending)
- Only **one new node** was created (not two)
- Advancing from `stateToken_1` works normally
- Agent should infer: "Replaying the same ack doesn't create duplicate work"

---

## Chat 4: Rehydrate-Only Path (Pure, No Advancement)

**Scenario**: Verify `continue_workflow` without ackToken is pure and idempotent.

**Information Isolation**: Agent doesn't know "rehydrate" terminology; just observes behavior difference.

### Agent Instructions (copy verbatim into new chat)

```
You are running WorkRail v2 slice validation.

SETUP:
- CHAT_ID is: chat-4-rehydrate-only
- Use CHAT_ID in every output you submit.

NON-NEGOTIABLE ISOLATION RULES:
- Confirm with the operator that this is a brand new chat.
- Confirm you will create a brand new v2 session in THIS chat by calling start_workflow.
- Do not reuse tokens from any other test chat.
- Do not advance the same session in parallel from multiple chats.
- If token provenance is violated or uncertain: STOP and report "INVALID TEST: TOKEN CONTAMINATION".

TOOLING RULES:
- Use ONLY v2 tools: list_workflows, inspect_workflow, start_workflow, continue_workflow.
- Never use workflow_next or any v1 tools.
- Never inspect/decode token contents.
- Do not attempt any resume-like behavior; only use sessions created in this chat.

OUTPUT TAGGING RULES:
- Every notesMarkdown you submit MUST be prefixed with:
  [CHAT_ID=chat-4-rehydrate-only][SCENARIO=rehydrate-only] 

REPORTING RULES:
- For each tool call, record: tool name, key inputs (redact tokens to first 16 chars + '…'), and the full response.
- If you hit an error: record code/message and STOP the chat.

---

You are testing WorkRail v2 continuation modes. Follow these steps exactly:

SETUP:
1. Call list_workflows and confirm "workflow-diagnose-environment" is available
2. Call start_workflow with workflowId: "workflow-diagnose-environment"
   - Save stateToken_0 and ackToken_0

TEST WITHOUT ACK:
3. Call continue_workflow with ONLY stateToken_0 (omit ackToken parameter entirely)
   - Record the response
   - Note if you receive new tokens back
   - Note if pending step information is returned

4. Call continue_workflow with ONLY stateToken_0 AGAIN (second time, still no ackToken)
   - Record the response
   - Compare with step 3 response

5. Now call continue_workflow WITH stateToken_0 AND ackToken_0
   - Output: {"notesMarkdown": "[CHAT_ID=chat-4-rehydrate-only][SCENARIO=rehydrate-only] Actually advancing now"}
   - Record the new stateToken_1

6. Call continue_workflow with ONLY stateToken_1 (no ackToken)
   - Record the response

REPORT (structured):
- Step 3 (first call without ack) returned tokens: yes/no
- Step 3 and step 4 responses were identical: yes/no
- Step 5 (with ack) returned DIFFERENT tokens than step 3: yes/no
- Step 6 (no ack on new state) returned pending for next step: yes/no
- Did any call without ackToken appear to "advance" the workflow?: yes/no

ANALYSIS:
- What's the difference between calling continue_workflow WITH vs WITHOUT ackToken?
```

### Expected Outcomes
- Calls without ackToken return: pending step info + fresh tokens (ack/checkpoint for potential future advancement)
- Multiple rehydrate calls return identical pending info (pure/deterministic)
- Rehydrate does NOT advance the workflow (stateToken stays the same)
- Only the call WITH ackToken actually advances
- Agent should infer: "Without ack = read current state; with ack = actually advance"

---

## Chat 5: Error Modes and Validation

**Scenario**: Test various error conditions.

**Information Isolation**: Agent tries invalid operations and reports what happens.

### Agent Instructions (copy verbatim into new chat)

```
You are running WorkRail v2 slice validation.

SETUP:
- CHAT_ID is: chat-5-error-modes
- Use CHAT_ID in every output you submit.

NON-NEGOTIABLE ISOLATION RULES:
- Confirm with the operator that this is a brand new chat.
- Confirm you will create a brand new v2 session in THIS chat by calling start_workflow.
- Do not reuse tokens from any other test chat.
- Do not advance the same session in parallel from multiple chats.
- If token provenance is violated or uncertain: STOP and report "INVALID TEST: TOKEN CONTAMINATION".

TOOLING RULES:
- Use ONLY v2 tools: list_workflows, inspect_workflow, start_workflow, continue_workflow.
- Never use workflow_next or any v1 tools.
- Never inspect/decode token contents.
- Do not attempt any resume-like behavior; only use sessions created in this chat.

OUTPUT TAGGING RULES:
- Every notesMarkdown you submit MUST be prefixed with:
  [CHAT_ID=chat-5-error-modes][SCENARIO=error-modes] 

REPORTING RULES:
- For each tool call, record: tool name, key inputs (redact tokens to first 16 chars + '…'), and the full response.
- Continue through all tests even if errors occur (this test expects errors).

---

You are testing WorkRail v2 error handling. Follow these steps and record ALL errors:

TEST 1: Missing workflow
1. Call start_workflow with workflowId: "nonexistent-workflow-12345"
   - Record error code and message

TEST 2: Invalid token format
2. Call list_workflows and confirm "workflow-diagnose-environment" is available
3. Call start_workflow with workflowId: "workflow-diagnose-environment"
   - Save the stateToken
4. Call continue_workflow with stateToken: "not-a-real-token"
   - Record error code and message

TEST 3: Mismatched tokens
5. Call start_workflow TWICE with the same workflow (two separate runs)
   - Save tokens from first run: stateToken_A, ackToken_A
   - Save tokens from second run: stateToken_B, ackToken_B
6. Call continue_workflow with stateToken_A and ackToken_B (mismatched)
   - Record error code and message

TEST 4: Missing required token
7. Call continue_workflow with ackToken but NO stateToken parameter
   - Record error code and message

REPORT (structured):
For each test, provide:
- Test number: <number>
- Error code received: <code>
- Error message (first 100 chars): <message>
- Error was actionable (told you what to do): yes/no

ANALYSIS:
- Did errors help you understand what went wrong?: yes/no
- Were any errors confusing or unclear?: yes/no/which ones
```

### Expected Outcomes
- Test 1: `NOT_FOUND` error
- Test 2: `TOKEN_INVALID_FORMAT` or `VALIDATION_ERROR`
- Test 3: `TOKEN_SCOPE_MISMATCH` or `VALIDATION_ERROR`
- Test 4: Schema validation error (missing required field)
- All errors include actionable suggestions

---

## Chat 6: Token Security (Tampering Detection)

**Scenario**: Verify tokens are tamper-evident.

**Information Isolation**: Agent tampers with tokens and observes results.

### Agent Instructions (copy verbatim into new chat)

```
You are running WorkRail v2 slice validation.

SETUP:
- CHAT_ID is: chat-6-token-security
- Use CHAT_ID in every output you submit.

NON-NEGOTIABLE ISOLATION RULES:
- Confirm with the operator that this is a brand new chat.
- Confirm you will create a brand new v2 session in THIS chat by calling start_workflow.
- Do not reuse tokens from any other test chat.
- Do not advance the same session in parallel from multiple chats.
- If token provenance is violated or uncertain: STOP and report "INVALID TEST: TOKEN CONTAMINATION".

TOOLING RULES:
- Use ONLY v2 tools: list_workflows, inspect_workflow, start_workflow, continue_workflow.
- Never use workflow_next or any v1 tools.
- Never inspect/decode token contents.
- Do not attempt any resume-like behavior; only use sessions created in this chat.

OUTPUT TAGGING RULES:
- Every notesMarkdown you submit MUST be prefixed with:
  [CHAT_ID=chat-6-token-security][SCENARIO=token-security] 

REPORTING RULES:
- For each tool call, record: tool name, key inputs (redact tokens to first 16 chars + '…'), and the full response.
- Continue through all tests even if errors occur (this test expects errors).

---

You are testing WorkRail v2 token security. Follow these steps:

SETUP:
1. Call list_workflows and confirm "workflow-diagnose-environment" is available
2. Call start_workflow with workflowId: "workflow-diagnose-environment"
   - Save the exact stateToken string

TAMPERING TESTS:
3. Create a tampered token by changing the LAST character of stateToken
   - If it ends with 'A', change to 'B'
   - If it ends with anything else, change to 'A'
   - Save as tamperedToken

4. Call continue_workflow with the tamperedToken (and no ackToken)
   - Record the error

5. Create a heavily tampered token:
   - Take the original stateToken
   - Replace the last 20 characters with "AAAAAAAAAAAAAAAAAAAA"
   - Save as heavyTamperedToken

6. Call continue_workflow with heavyTamperedToken
   - Record the error

REPORT (structured):
- Original stateToken format: <st.v1.XXXX.YYYY>
- Test 4 error code: <code>
- Test 4 error message: <message>
- Test 6 error code: <code>
- Test 6 error message: <message>
- Both tampering attempts were rejected: yes/no

ANALYSIS:
- What does this tell you about token security?
```

### Expected Outcomes
- Both tampering attempts fail with `TOKEN_BAD_SIGNATURE` or `VALIDATION_ERROR`
- Error messages indicate verification failed
- No execution occurs with tampered tokens
- Agent should infer: "Tokens are cryptographically signed and cannot be modified"

---

## Chat 7: Multi-Step Workflow End-to-End

**Scenario**: Execute a realistic workflow with multiple steps and verify durable outputs.

**Information Isolation**: Agent executes a full workflow and verifies outputs persist.

### Agent Instructions (copy verbatim into new chat)

```
You are running WorkRail v2 slice validation.

SETUP:
- CHAT_ID is: chat-7-multi-step
- Use CHAT_ID in every output you submit.

NON-NEGOTIABLE ISOLATION RULES:
- Confirm with the operator that this is a brand new chat.
- Confirm you will create a brand new v2 session in THIS chat by calling start_workflow.
- Do not reuse tokens from any other test chat.
- Do not advance the same session in parallel from multiple chats.
- If token provenance is violated or uncertain: STOP and report "INVALID TEST: TOKEN CONTAMINATION".

TOOLING RULES:
- Use ONLY v2 tools: list_workflows, inspect_workflow, start_workflow, continue_workflow.
- Never use workflow_next or any v1 tools.
- Never inspect/decode token contents.
- Do not attempt any resume-like behavior; only use sessions created in this chat.

OUTPUT TAGGING RULES:
- Every notesMarkdown you submit MUST be prefixed with:
  [CHAT_ID=chat-7-multi-step][SCENARIO=multi-step] 

REPORTING RULES:
- For each tool call, record: tool name, key inputs (redact tokens to first 16 chars + '…'), and the full response.
- If you hit an error: record code/message and STOP the chat.

---

You are testing WorkRail v2 end-to-end execution with outputs. Follow these steps:

SETUP:
1. Call list_workflows and confirm "bug-investigation" is available
2. Call start_workflow with workflowId: "bug-investigation"

EXECUTION WITH OUTPUTS:
For each step (repeat until isComplete is true):
3. Read the pending.prompt
4. Call continue_workflow with current stateToken and ackToken
   - Provide output: {"notesMarkdown": "[CHAT_ID=chat-7-multi-step][SCENARIO=multi-step] Completed step <stepId>: <brief summary of what the prompt asked>"}
5. Record:
   - New tokens received
   - Whether pending changed
   - Whether isComplete changed

FINAL VERIFICATION:
6. Count total steps executed
7. List all the output notes you provided

REPORT (structured):
- Workflow ID: <id>
- Total steps executed: <number>
- Workflow completed successfully: yes/no
- Final isComplete value: <true/false>
- All outputs provided: <list each notesMarkdown you sent>
- Did outputs persist between steps (could you see them in responses)?: yes/no/not visible in responses

ANALYSIS:
- Did the workflow execute predictably?
- Were the prompts clear and sequential?
```

### Expected Outcomes
- Workflow executes to completion
- Each step returns updated tokens
- Final step returns `isComplete: true, pending: null`
- Outputs are accepted (no errors about invalid output format)
- Note: outputs may not be visible in responses (that's expected; they're stored durably)

---

## Chat 8: Deterministic Pinning (Workflow Hash Stability)

**Scenario**: Verify workflows are pinned and hash remains stable.

**Information Isolation**: Agent inspects workflows and observes hash behavior.

### Agent Instructions (copy verbatim into new chat)

```
You are running WorkRail v2 slice validation.

SETUP:
- CHAT_ID is: chat-8-hash-stability
- Use CHAT_ID in every output you submit.

NON-NEGOTIABLE ISOLATION RULES:
- Confirm with the operator that this is a brand new chat.
- Confirm you will create a brand new v2 session in THIS chat by calling start_workflow.
- Do not reuse tokens from any other test chat.
- Do not advance the same session in parallel from multiple chats.
- If token provenance is violated or uncertain: STOP and report "INVALID TEST: TOKEN CONTAMINATION".

TOOLING RULES:
- Use ONLY v2 tools: list_workflows, inspect_workflow, start_workflow, continue_workflow.
- Never use workflow_next or any v1 tools.
- Never inspect/decode token contents.
- Do not attempt any resume-like behavior; only use sessions created in this chat.

OUTPUT TAGGING RULES:
- Every notesMarkdown you submit MUST be prefixed with:
  [CHAT_ID=chat-8-hash-stability][SCENARIO=hash-stability] 

REPORTING RULES:
- For each tool call, record: tool name, key inputs (redact tokens to first 16 chars + '…'), and the full response.
- If you hit an error: record code/message and STOP the chat.

---

You are testing WorkRail v2 workflow pinning and determinism. Follow these steps:

HASH INSPECTION:
1. Call list_workflows
   - Record the workflowHash for "bug-investigation" (if present)

2. Call inspect_workflow with workflowId: "bug-investigation"
   - Record the workflowHash from the response
   - Compare with the hash from step 1

3. Call inspect_workflow AGAIN with the same workflow ID
   - Record the workflowHash
   - Compare with hashes from steps 1 and 2

EXECUTION WITH HASH:
4. Call start_workflow with workflowId: "bug-investigation"
5. Look at the response structure
   - Is there any reference to workflowHash in the response?: yes/no/where
   - Does the hash appear in any tokens or metadata?

REPORT (structured):
- Workflow ID: <id>
- workflowHash from list_workflows: <hash or "not present">
- workflowHash from first inspect_workflow: <hash>
- workflowHash from second inspect_workflow: <hash>
- All hashes were identical: yes/no
- Hash format: <sha256:XXXX... or other>
- Hash appeared in start_workflow response: yes/no

ANALYSIS:
- What does "workflowHash" seem to represent?
- Does it change between calls or remain stable?
```

### Expected Outcomes
- `workflowHash` is consistent across all calls (deterministic)
- Format is `sha256:<64 hex chars>`
- Same workflow always produces same hash
- Hash may appear in response metadata (informational)
- Agent should infer: "Hash identifies a specific version of the workflow"

---

## Summary Verification Table

After executing all chats, the human operator fills this table:

| Chat | CHAT_ID | Scenario | Pass/Fail | Notes |
|------|---------|----------|-----------|-------|
| 1 | chat-1-happy-path | Basic execution loop | ⬜ | |
| 2 | chat-2-rewind-fork | Rewind and fork | ⬜ | |
| 3 | chat-3-idempotency-replay | Idempotency and replay | ⬜ | |
| 4 | chat-4-rehydrate-only | Rehydrate-only (pure) | ⬜ | |
| 5 | chat-5-error-modes | Error modes | ⬜ | |
| 6 | chat-6-token-security | Token tampering | ⬜ | |
| 7 | chat-7-multi-step | Multi-step with outputs | ⬜ | |
| 8 | chat-8-hash-stability | Hash stability | ⬜ | |

---

## Success Criteria (All Must Pass)

- [ ] All 8 chats executed without agent confusion
- [ ] Basic execution loop completes workflows successfully
- [ ] Rewinds create forks, not errors
- [ ] Replay is deterministic and idempotent
- [ ] Rehydrate doesn't advance state
- [ ] Errors are actionable and use expected codes
- [ ] Token tampering is detected
- [ ] Outputs are accepted and stored
- [ ] Hashes are stable

---

## Known Limitations (Expected "Fails")

These are NOT bugs; they are missing Slice 4+ features:
- Cannot resume in a new chat (no `resume_session` yet)
- Cannot checkpoint without advancing (no `checkpoint_workflow` yet)
- Outputs don't appear in responses (storage works, but no recap/export yet)
- Blockers/gaps UX may be incomplete depending on the workflow and mode (verify by observing `outcome`/`isComplete` behavior rather than expecting a specific UI).

---

## Debugging Failed Tests

If any test fails:
1. Confirm the agent started a fresh session in this chat via `start_workflow` (i.e., did not paste/reuse tokens from another chat).
2. Confirm tests were not run in parallel.
3. Review the agent's exact tool calls (were parameters malformed? were stateToken/ackToken mixed across runs?).
4. Verify `WORKRAIL_ENABLE_V2_TOOLS=true` is set.
5. (Optional, if you have local filesystem access) Check for lock file conflicts under the WorkRail data dir: `.../data/sessions/<sessionId>/.lock`.
6. Check for stack traces in terminal output.

---

## Test Environment Notes

**Required:**
- Node.js >=20
- WorkRail v2 Slices 1-3 code complete
- `WORKRAIL_ENABLE_V2_TOOLS=true` environment variable
- WorkRail v2 data dir is accessible (no special per-chat data dir setup is required for this plan)

**Recommended:**
- Run each chat in strict sequence (don't parallelize; session conflicts)
- Workflows are pre-assigned per chat (see table in Prerequisites)

---

## Optional: Stronger durable isolation (only if feasible)

If your environment lets you restart the WorkRail MCP server between chats, you can get even stronger isolation by starting each chat against an empty v2 durable store (fresh data dir). This is not required for Slices 1–3 if you follow the token/session isolation rules.

Options:
- Restart the MCP server with a fresh v2 data root (`WORKRAIL_DATA_DIR`), or
- Wipe the v2 data dir between chats.

---

## Post-Test Analysis (Human Review)

After all tests:
1. Review agent reports for unexpected behaviors
2. Check `~/.workrail/data/sessions/` directory structure
3. Verify event logs are well-formed JSONL
4. Spot-check a few `manifest.jsonl` files for correctness
5. Confirm no orphan segment files exist
6. Review any `.lock` files (should be cleaned up)

**If all tests pass**: Slice 3 is functionally correct for basic execution.  
**If tests fail**: categorize as bugs vs missing features vs test issues.
