# WorkRail v2 Slices 1-3 Manual Test Plan (Agent-Executable)

**Purpose**: Systematically verify v2 Slices 1-3 (read-only tools, append-only substrate, token orchestration) work correctly with existing v1 workflows.

**Test Strategy**: Each test scenario runs in a **separate chat** to prevent information leakage and ensure clean agent state. The agent executes test steps and reports detailed results.

**Prerequisites**:
- WorkRail v2 Slices 1-3 implementation complete
- `WORKRAIL_ENABLE_V2_TOOLS=true` set in environment
- At least one simple workflow exists (e.g., `bug-investigation.json`)

---

## Test Execution Instructions (Human Operator)

For each test chat below:
1. Start a **brand new chat** (critical for isolation)
2. Copy the "Agent Instructions" section verbatim
3. Let the agent execute without interruption
4. Collect the agent's final report
5. Verify against "Expected Outcomes"
6. Record pass/fail in the summary table

---

## Chat 1: Basic Execution Loop (Happy Path)

**Scenario**: Execute a workflow from start to completion using v2 tools.

**Information Isolation**: Agent learns workflow exists, executes it, and reports. No prior knowledge of v2 internals needed.

### Agent Instructions (copy verbatim into new chat)

```
You are testing WorkRail v2 basic execution. Follow these steps exactly and report results:

SETUP:
1. Verify v2 tools are available by calling list_workflows
   - Confirm you receive a response with workflow list
   - Pick the simplest workflow you find (prefer one with 2-3 steps, no loops)

EXECUTION:
2. Call start_workflow with the workflow ID you chose
   - Record the response structure (what fields are present)
   - Save stateToken, ackToken, and the pending step details

3. Complete the first pending step
   - Call continue_workflow with the stateToken and ackToken
   - Provide minimal output: {"notesMarkdown": "Step 1 complete"}
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
- ✅ `list_workflows` returns workflow list
- ✅ `start_workflow` returns: `{stateToken, ackToken, checkpointToken, isComplete: false, pending: {...}}`
- ✅ `continue_workflow` advances through steps
- ✅ Final call returns `isComplete: true, pending: null`
- ✅ All tokens are opaque strings (format: `st.v1.*`, `ack.v1.*`, `chk.v1.*`)
- ✅ No errors during happy path

---

## Chat 2: Rewind and Fork Behavior

**Scenario**: Test that rewinding creates forks, not state corruption.

**Information Isolation**: Agent executes workflow, then rewinds and continues from an earlier point. Must not know expected fork behavior beforehand.

### Agent Instructions (copy verbatim into new chat)

```
You are testing WorkRail v2 rewind behavior. Follow these steps exactly:

SETUP:
1. Call list_workflows and pick a simple workflow (2-3 steps minimum)
2. Call start_workflow with that workflow ID
   - Save ALL tokens from the response (stateToken_0, ackToken_0)

FIRST EXECUTION PATH:
3. Advance step 1: call continue_workflow with stateToken_0 and ackToken_0
   - Output: {"notesMarkdown": "Path A: step 1"}
   - Save the NEW tokens (stateToken_1, ackToken_1)

4. Advance step 2: call continue_workflow with stateToken_1 and ackToken_1
   - Output: {"notesMarkdown": "Path A: step 2"}
   - Save the NEW tokens (stateToken_2, ackToken_2)

REWIND TEST:
5. Now REWIND your chat to just after step 3 (before you called step 4)
   - Your chat history should show: setup, start, step 1 complete
   - Step 2 (Path A) should be deleted from your visible history

6. Take a DIFFERENT path: call continue_workflow with stateToken_1 and ackToken_1
   - Output: {"notesMarkdown": "Path B: step 2 alternative"}
   - Save the tokens (stateToken_2b, ackToken_2b)

REPORT (structured):
- Workflow ID: <id>
- stateToken_2 from original path: <first 20 chars>...
- stateToken_2b from rewind path: <first 20 chars>...
- Are these tokens different?: yes/no
- Did the second continue_workflow call succeed?: yes/no
- Any error about "already advanced" or "state mismatch"?: yes/no
- Did rewind cause any corruption errors?: yes/no

ANALYSIS:
- Based on the results, what do you think happened when you rewound and advanced again?
```

### Expected Outcomes
- ✅ Both `continue_workflow` calls succeed (no "already advanced" error)
- ✅ Tokens for the two paths are different (different nodes created)
- ✅ No corruption errors
- ✅ Agent should observe: "It appears rewinding created two separate paths from the same point"

---

## Chat 3: Idempotency and Replay

**Scenario**: Verify replaying the same ack is idempotent.

**Information Isolation**: Agent doesn't know what idempotency means in this context; just executes and observes.

### Agent Instructions (copy verbatim into new chat)

```
You are testing WorkRail v2 replay behavior. Follow these steps exactly:

SETUP:
1. Call list_workflows and pick a simple workflow
2. Call start_workflow
   - Save stateToken_0 and ackToken_0

FIRST ADVANCEMENT:
3. Call continue_workflow with stateToken_0 and ackToken_0
   - Output: {"notesMarkdown": "First execution"}
   - Record ENTIRE response (copy/paste the full JSON)
   - Save the new stateToken_1

REPLAY TEST:
4. Call continue_workflow AGAIN with the SAME stateToken_0 and ackToken_0
   - Output: {"notesMarkdown": "First execution"}
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
- ✅ Responses from steps 3 and 4 are **byte-identical** (same tokens, same pending)
- ✅ Only **one new node** was created (not two)
- ✅ Advancing from `stateToken_1` works normally
- ✅ Agent should infer: "Replaying the same ack doesn't create duplicate work"

---

## Chat 4: Rehydrate-Only Path (Pure, No Advancement)

**Scenario**: Verify `continue_workflow` without ackToken is pure and idempotent.

**Information Isolation**: Agent doesn't know "rehydrate" terminology; just observes behavior difference.

### Agent Instructions (copy verbatim into new chat)

```
You are testing WorkRail v2 continuation modes. Follow these steps exactly:

SETUP:
1. Call list_workflows and pick a simple workflow
2. Call start_workflow
   - Save stateToken_0

TEST WITHOUT ACK:
3. Call continue_workflow with ONLY stateToken_0 (omit ackToken parameter entirely)
   - Record the response
   - Note if you receive new tokens back
   - Note if pending step information is returned

4. Call continue_workflow with ONLY stateToken_0 AGAIN (second time, still no ackToken)
   - Record the response
   - Compare with step 3 response

5. Now call continue_workflow WITH stateToken_0 AND ackToken_0
   - Output: {"notesMarkdown": "Actually advancing now"}
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
- ✅ Calls without ackToken return: pending step info + fresh tokens (ack/checkpoint for potential future advancement)
- ✅ Multiple rehydrate calls return identical pending info (pure/deterministic)
- ✅ Rehydrate does NOT advance the workflow (stateToken stays the same)
- ✅ Only the call WITH ackToken actually advances
- ✅ Agent should infer: "Without ack = read current state; with ack = actually advance"

---

## Chat 5: Error Modes and Validation

**Scenario**: Test various error conditions.

**Information Isolation**: Agent tries invalid operations and reports what happens.

### Agent Instructions (copy verbatim into new chat)

```
You are testing WorkRail v2 error handling. Follow these steps and record ALL errors:

TEST 1: Missing workflow
1. Call start_workflow with workflowId: "nonexistent-workflow-12345"
   - Record error code and message

TEST 2: Invalid token format
2. Call list_workflows and pick any workflow
3. Call start_workflow with that workflow
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
- ✅ Test 1: `NOT_FOUND` error
- ✅ Test 2: `TOKEN_INVALID_FORMAT` or `VALIDATION_ERROR`
- ✅ Test 3: `TOKEN_SCOPE_MISMATCH` or `VALIDATION_ERROR`
- ✅ Test 4: Schema validation error (missing required field)
- ✅ All errors include actionable suggestions

---

## Chat 6: Token Security (Tampering Detection)

**Scenario**: Verify tokens are tamper-evident.

**Information Isolation**: Agent tampers with tokens and observes results.

### Agent Instructions (copy verbatim into new chat)

```
You are testing WorkRail v2 token security. Follow these steps:

SETUP:
1. Call list_workflows and pick any workflow
2. Call start_workflow
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
- ✅ Both tampering attempts fail with `TOKEN_BAD_SIGNATURE` or `VALIDATION_ERROR`
- ✅ Error messages indicate verification failed
- ✅ No execution occurs with tampered tokens
- ✅ Agent should infer: "Tokens are cryptographically signed and cannot be modified"

---

## Chat 7: Multi-Step Workflow End-to-End

**Scenario**: Execute a realistic workflow with multiple steps and verify durable outputs.

**Information Isolation**: Agent executes a full workflow and verifies outputs persist.

### Agent Instructions (copy verbatim into new chat)

```
You are testing WorkRail v2 end-to-end execution with outputs. Follow these steps:

SETUP:
1. Call list_workflows
2. Pick a workflow with at least 3 steps (avoid loops for this test)
3. Call start_workflow with that workflow ID

EXECUTION WITH OUTPUTS:
For each step (repeat until isComplete is true):
4. Read the pending.prompt
5. Call continue_workflow with current stateToken and ackToken
   - Provide output: {"notesMarkdown": "Completed step <stepId>: <brief summary of what the prompt asked>"}
6. Record:
   - New tokens received
   - Whether pending changed
   - Whether isComplete changed

FINAL VERIFICATION:
7. Count total steps executed
8. List all the output notes you provided

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
- ✅ Workflow executes to completion
- ✅ Each step returns updated tokens
- ✅ Final step returns `isComplete: true, pending: null`
- ✅ Outputs are accepted (no errors about invalid output format)
- ✅ Note: outputs may not be visible in responses (that's expected; they're stored durably)

---

## Chat 8: Deterministic Pinning (Workflow Hash Stability)

**Scenario**: Verify workflows are pinned and hash remains stable.

**Information Isolation**: Agent inspects workflows and observes hash behavior.

### Agent Instructions (copy verbatim into new chat)

```
You are testing WorkRail v2 workflow pinning and determinism. Follow these steps:

HASH INSPECTION:
1. Call list_workflows
   - Record the workflowHash for each workflow (if present)
   - Pick one workflow and note its workflowHash

2. Call inspect_workflow with that workflow ID
   - Record the workflowHash from the response
   - Compare with the hash from step 1

3. Call inspect_workflow AGAIN with the same workflow ID
   - Record the workflowHash
   - Compare with hashes from steps 1 and 2

EXECUTION WITH HASH:
4. Call start_workflow with that workflow ID
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
- ✅ `workflowHash` is consistent across all calls (deterministic)
- ✅ Format is `sha256:<64 hex chars>`
- ✅ Same workflow always produces same hash
- ✅ Hash may appear in response metadata (informational)
- ✅ Agent should infer: "Hash identifies a specific version of the workflow"

---

## Summary Verification Table

After executing all chats, the human operator fills this table:

| Chat | Scenario | Pass/Fail | Notes |
|------|----------|-----------|-------|
| 1 | Basic execution loop | ⬜ | |
| 2 | Rewind and fork | ⬜ | |
| 3 | Idempotency and replay | ⬜ | |
| 4 | Rehydrate-only (pure) | ⬜ | |
| 5 | Error modes | ⬜ | |
| 6 | Token tampering | ⬜ | |
| 7 | Multi-step with outputs | ⬜ | |
| 8 | Hash stability | ⬜ | |

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
- ❌ Cannot resume in a new chat (no `resume_session` yet)
- ❌ Cannot checkpoint without advancing (no `checkpoint_workflow` yet)
- ❌ Outputs don't appear in responses (storage works, but no recap/export yet)
- ❌ No blocked state behavior (advance_recorded supports it, but no blocker logic)

---

## Debugging Failed Tests

If any test fails:
1. Check `~/.workrail/data/sessions/` for persisted data
2. Verify `WORKRAIL_ENABLE_V2_TOOLS=true` is set
3. Check for lock file conflicts: `~/.workrail/data/sessions/<sessionId>/.lock`
4. Review agent's exact tool calls (were parameters malformed?)
5. Check for stack traces in terminal output

---

## Test Environment Notes

**Required:**
- Node.js >=20
- WorkRail v2 Slices 1-3 code complete
- `WORKRAIL_ENABLE_V2_TOOLS=true` environment variable
- Clean `~/.workrail/data/` directory (or delete before testing)

**Recommended:**
- Use a simple 2-3 step workflow for initial tests
- Test with a workflow that has NO loops first (loops add complexity)
- Run each chat in strict sequence (don't parallelize; session conflicts)

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
