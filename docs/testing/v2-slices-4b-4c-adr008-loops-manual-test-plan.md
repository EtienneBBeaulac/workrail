# WorkRail v2 Slices 4b, 4c + ADR 008 + Loop Artifacts Manual Test Plan

**Purpose**: Systematically verify Slice 4b (export/import bundles), Slice 4c-i (checkpoint_workflow), Slice 4c-ii (resume_session), ADR 008 (blocked node retry), and loop control artifacts work correctly.

**Test Strategy**: Each scenario runs in a **separate chat** to prevent information leakage and ensure clean agent state. The human operator reviews all tool call responses directly in the chat -- agents do NOT need to record or paste responses.

---

## Isolation Contract

For results to be trustworthy, each chat MUST be isolated:
1) **New chat** (no conversational memory)
2) **Fresh v2 session** (call start_workflow in THIS chat only, unless testing resume_session)
3) **Token provenance discipline** (no cross-chat token reuse, except where resume_session explicitly requires it)

**Hard rules**:
- Start a brand new chat for each scenario
- Create a brand new v2 session via `start_workflow` (don't reuse tokens from other chats)
- Do not advance the same session in parallel from multiple chats
- **All tool calls MUST be sequential** -- wait for each call to complete before making the next one. Never batch multiple WorkRail calls in parallel. The session lock enforces single-writer; parallel calls will fail with SESSION_LOCKED.
- If token provenance uncertain: STOP and mark invalid

**Prerequisites**:
- WorkRail v2 all slices complete
- `WORKRAIL_ENABLE_V2_TOOLS=true` environment variable set
- Ability to run scenarios in separate chats

---

## Operator Runbook

### How to run a test

1. Open a new chat
2. Paste the **Agent Instructions** block (the content inside the ``` fences) as your first message
3. Let the agent run to completion -- do not intervene unless it asks or gets stuck
4. Read the agent's ANALYSIS section and compare against the **Expected Outcomes**
5. Fill in the Validation Summary Table row for that chat

### What to look for

You see every tool call and response in the chat. When evaluating:
- **Did the agent discover the behavior?** Check the ANALYSIS for correct conclusions the agent reached independently (not from hints in the instructions)
- **Did the tool responses make sense?** Scan the raw JSON for unexpected fields, missing data, or error codes
- **Did the agent recover from errors?** For C-section tests, watch whether the agent found the retry path without external help

### Execution order

**Phase 1 -- Independent (any order):**
A1, A2, A3, A4, A5, D1, D2, D3, D4, D5

**Phase 2 -- Sequential (creates sessions for later tests):**
B1a (creates session) -> B1b (resumes it)
E1 (creates session with markers)

**Phase 3 -- Depends on Phase 2 sessions:**
B2, B3, B5 (all need B1a's session)
E2 (needs E1's session)

**Phase 4 -- Special setup:**
B4 (needs fresh data directory -- back up and clear `~/.workrail/data/sessions/`, run, restore)
B5 (needs 6+ sessions -- run after several other tests have created sessions, or create extras)
E3 (operator-only filesystem check -- run after E1 and E2)

**Phase 5 -- Blocked retry (independent, but long):**
C1, C2, C3, C4, C5 (each requires advancing through multiple workflow steps to reach a validation point)

### When to intervene

- **Agent asks a question**: Answer it honestly but don't reveal Expected Outcomes
- **Agent gets stuck in a loop**: Let it try 3 times, then mark the test as failed
- **Agent uses wrong tools**: If it calls v1 tools, remind it "use only v2 tools" -- this is a test setup issue, not a test failure
- **Agent says "INVALID TEST"**: The isolation contract was violated. Discard and restart

### Estimated time

- A-section: ~3 min per chat (short workflows)
- B-section: ~2 min per chat (mostly resume calls)
- C-section: ~5 min per chat (need to advance through multiple steps to reach validation)
- D-section: ~3 min per chat (test-artifact-loop-control is small)
- E-section: ~3 min for E1, ~2 min for E2, ~5 min for E3 (manual filesystem check)
- Total: ~60-75 min for all 23 scenarios

---

## Section A: Checkpoint Workflow (Slice 4c-i) -- 5 Scenarios

### Chat A1: Checkpoint Behavior Discovery

**Goal**: Agent discovers what checkpoint_workflow does through experimentation

**Agent Instructions**:
```
You are running WorkRail v2 slice validation.

ISOLATION RULES:
- CHAT_ID: chat-4c-checkpoint-basic
- Brand new chat (confirm with operator)
- Create brand new v2 session via start_workflow
- Do not reuse tokens from other chats
- If token provenance violated: STOP and report "INVALID TEST"

TOOLING:
- Use ONLY v2 tools: list_workflows, start_workflow, continue_workflow, checkpoint_workflow
- Never use v1 tools

OUTPUT TAGGING:
- When providing output via continue_workflow, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-4c-checkpoint-basic] ..."}}
- The CHAT_ID prefix helps the operator track which test chat produced which session data

STEPS:
1. Call start_workflow with workflowId: "workflow-diagnose-environment"

2. Call checkpoint_workflow with the checkpointToken from step 1

3. The checkpoint_workflow response should include a nextCall.
   Use it to call continue_workflow.
   What is the pending step? Is it the same or different from step 1?

4. Now actually advance the workflow:
   Call continue_workflow with the stateToken and ackToken from step 1
   Provide output: {"output": {"notesMarkdown": "[CHAT_ID=chat-4c-checkpoint-basic] Step 1 complete"}}

ANALYSIS:
- What does checkpoint_workflow seem to do?
- How does it differ from continue_workflow with ackToken?
- Did calling checkpoint_workflow change where you were in the workflow?
```

**Expected Outcomes** (operator-only, do not share with agent):
- checkpoint_workflow returns `{ checkpointNodeId, stateToken, nextCall }` pointing to the original node
- nextCall contains a rehydrate template (stateToken only, no ackToken)
- After checkpoint, the same step is still pending (no advancement)
- Advance after checkpoint works normally
- Agent should independently discover: "Checkpoint marks progress without advancing"

---

### Chat A2: Repeated Checkpoint Calls

**Goal**: Agent discovers checkpoint idempotency behavior

**Agent Instructions**:
```
You are running WorkRail v2 slice validation.

ISOLATION RULES:
- CHAT_ID: chat-4c-checkpoint-repeat
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-4c-checkpoint-repeat] ..."}}

STEPS:
1. Call start_workflow with workflowId: "workflow-diagnose-environment"

2. Call checkpoint_workflow with the checkpointToken.
   Wait for the response.

3. Call checkpoint_workflow again with the SAME checkpointToken.
   Wait for the response.

4. Call checkpoint_workflow a THIRD time with the SAME checkpointToken.
   Wait for the response.

5. Compare all three responses.

ANALYSIS:
- What happens when you call checkpoint_workflow multiple times with the same token?
- Were any of the responses different from each other?
- Did any call fail or produce an error?
```

**Expected Outcomes** (operator-only):
- All three calls succeed with identical responses
- Agent independently discovers idempotency

---

### Chat A3: Wrong Tokens for Checkpoint

**Goal**: Test checkpoint_workflow error handling with various incorrect tokens

**Agent Instructions**:
```
You are running WorkRail v2 slice validation.

ISOLATION RULES:
- CHAT_ID: chat-4c-checkpoint-errors
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-4c-checkpoint-errors] ...

STEPS:
1. Call start_workflow with workflowId: "workflow-diagnose-environment"

Now test checkpoint_workflow with WRONG tokens:

TEST 1: Call checkpoint_workflow with the stateToken (not checkpointToken)
TEST 2: Call checkpoint_workflow with the ackToken (not checkpointToken)
TEST 3: Tamper with the checkpointToken (change the last character) and call checkpoint_workflow
TEST 4: Call checkpoint_workflow with checkpointToken: "not-a-real-token"
TEST 5: Call checkpoint_workflow with the ORIGINAL (correct) checkpointToken

ANALYSIS:
- Were the error messages helpful enough to diagnose each problem?
- Did the failed calls affect anything? Could you still use the correct token afterward?
```

**Expected Outcomes** (operator-only):
- Tests 1-4 produce specific error codes (TOKEN_INVALID_FORMAT, TOKEN_BAD_SIGNATURE, etc.)
- Test 5 succeeds (errors are non-destructive)
- Error messages are actionable

---

### Chat A4: Checkpoint Tokens Across Steps

**Goal**: Agent discovers the relationship between checkpoint tokens and workflow advancement

**Agent Instructions**:
```
You are running WorkRail v2 slice validation.

ISOLATION RULES:
- CHAT_ID: chat-4c-checkpoint-lifecycle
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-4c-checkpoint-lifecycle] ...

STEPS:
1. Call start_workflow with workflowId: "bug-investigation"
   Note the checkpointToken (call it checkpointToken_step0)

2. Call checkpoint_workflow with checkpointToken_step0

3. Advance step 1: continue_workflow with stateToken + ackToken
   Provide output: {"output": {"notesMarkdown": "[CHAT_ID=chat-4c-checkpoint-lifecycle] Step 1"}}
   Note the new checkpointToken (call it checkpointToken_step1)

4. Compare checkpointToken_step0 and checkpointToken_step1 -- same or different?

5. Call checkpoint_workflow with checkpointToken_step0 (the OLD one)

6. Call checkpoint_workflow with checkpointToken_step1 (the NEW one)

ANALYSIS:
- What is the relationship between checkpointTokens and workflow steps?
- What happens to old checkpointTokens when you advance?
```

**Expected Outcomes** (operator-only):
- Tokens are different after advancing (each step gets its own)
- Old token may still work (idempotent on old node) or fail with scope error
- New token works on current node

---

### Chat A5: Checkpoint During a Loop

**Goal**: Test whether checkpointing inside a loop interferes with loop mechanics

**Agent Instructions**:
```
You are running WorkRail v2 slice validation.

ISOLATION RULES:
- CHAT_ID: chat-4c-checkpoint-in-loop
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-4c-checkpoint-in-loop] ...

STEPS:
1. Call start_workflow with workflowId: "test-artifact-loop-control"

2. Read the pending prompt carefully. Follow its instructions to provide
   the required output (it will tell you the format needed).
   Use "continue" as your decision.

3. You should enter the loop body. Before advancing, call checkpoint_workflow
   with the current checkpointToken.

4. Continue advancing through the loop normally, following the prompts.

5. When you reach a loop decision point, provide a "stop" decision
   (following the format described in the prompt).

6. Complete the remaining steps until the workflow finishes.

ANALYSIS:
- Did checkpointing inside the loop cause any problems?
- Did checkpoint change your position in the loop?
- Did the loop exit when you said "stop"?
- Did the workflow complete?
```

**Expected Outcomes** (operator-only):
- Checkpoint succeeds during loop
- Loop continues normally afterward (orthogonal to loop control)
- Stop decision exits loop
- Workflow completes

---

## Section B: Resume Session (Slice 4c-ii) -- 5 Scenarios

### Chat B1: Cross-Chat Session Discovery

**Goal**: Verify resume_session discovers sessions from previous chats

**Setup**: This test requires TWO chats.

**Chat B1a -- Setup chat (create a session to resume)**:
```
You are creating a test session for WorkRail v2 resume testing.

ISOLATION RULES:
- CHAT_ID: chat-4c-resume-setup
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-4c-resume-setup] ...

STEPS:
1. Call start_workflow with workflowId: "bug-investigation"

2. Advance through 2 steps:
   - Step 1 output: {"output": {"notesMarkdown": "[CHAT_ID=chat-4c-resume-setup] Investigating memory leak in UserService"}}
   - Step 2 output: {"output": {"notesMarkdown": "[CHAT_ID=chat-4c-resume-setup] Found root cause: unbounded cache in UserService.getProfile()"}}

3. STOP. Do NOT complete the workflow. The operator will start Chat B1b.
```

**Chat B1b -- Resume chat**:
```
You are testing WorkRail v2 session resumption.

ISOLATION RULES:
- CHAT_ID: chat-4c-resume-discover
- Brand new chat
- Do NOT create a new session -- you are trying to find an existing one

TOOLING:
- Use ONLY v2 tools: resume_session, continue_workflow
- Do NOT call start_workflow

STEPS:
1. Call resume_session with NO parameters (empty object or just {})

2. Examine the response. How many candidates were returned?
   For each candidate, what information is provided?

3. If any candidate looks like it could be from a "bug-investigation" workflow,
   use its stateToken with continue_workflow (no ackToken) to rehydrate.
   What step is pending? Does it make sense as a continuation?

4. If you can advance, call continue_workflow with stateToken + ackToken
   Provide output: {"output": {"notesMarkdown": "[CHAT_ID=chat-4c-resume-discover] Resuming and continuing"}}

ANALYSIS:
- Was the resume_session response sufficient to choose the right session?
- How did you decide which candidate to pick?
- Did the resumed workflow pick up where it left off?
```

**Expected Outcomes** (operator-only):
- resume_session returns `{ candidates: [...], totalEligible: N }`
- Candidates include sessionId, stateToken, snippet, whyMatched
- bug-investigation session found
- Rehydrate shows the pending step after step 2
- Advance works from resumed session

---

### Chat B2: Query-Based Session Filtering

**Goal**: Test how different queries affect resume_session results

**Setup**: Requires session from B1a (with "UserService memory leak" notes).

**Agent Instructions**:
```
You are testing WorkRail v2 resume_session query behavior.

ISOLATION RULES:
- CHAT_ID: chat-4c-resume-query
- Brand new chat
- Do NOT create a new session

TOOLING:
- Use ONLY v2 tools: resume_session

STEPS:
1. Call resume_session with query: "UserService memory leak"
2. Call resume_session with query: "nonexistent-foobar-gibberish-12345"
3. Call resume_session with query: "bug-investigation"
4. Call resume_session with NO query (empty/default)

5. Compare all four responses: How did the number of candidates change?
   Did the ordering change? Did the whyMatched values differ?

ANALYSIS:
- How does the query parameter affect results?
- What do the different whyMatched values seem to mean?
- Is there a ranking pattern you can identify?
```

**Expected Outcomes** (operator-only):
- "UserService memory leak" matches via `matched_notes` (Tier 3)
- Gibberish query returns fewer/no results
- "bug-investigation" matches via `matched_workflow_id` (Tier 4)
- Empty query returns results via `recency_fallback` (Tier 5)
- Agent discovers the ranking pattern without being told

---

### Chat B3: Git Context in Resume

**Goal**: Test how git branch affects resume_session matching

**Setup**: Session from B1a must exist.

**Agent Instructions**:
```
You are testing WorkRail v2 resume_session with git context.

ISOLATION RULES:
- CHAT_ID: chat-4c-resume-git
- Brand new chat
- Do NOT create a new session

TOOLING:
- Use ONLY v2 tools: resume_session

STEPS:
1. Call resume_session with NO parameters
   Note the whyMatched values for each candidate.

2. Call resume_session with gitBranch: "main"
   Compare whyMatched values with step 1.

3. Call resume_session with gitBranch: "nonexistent-branch-xyz"
   Are any candidates still returned?

ANALYSIS:
- Did the gitBranch parameter change the matching?
- What happens when the branch doesn't match any session?
```

**Expected Outcomes** (operator-only):
- Auto-detected branch may produce `matched_branch` or `matched_head_sha` results
- Nonexistent branch still returns candidates via lower tiers (graceful degradation)

---

### Chat B4: Resume with No Sessions

**Goal**: Verify resume_session behavior when no sessions exist

**Setup**: Ideally run against a fresh data directory. If not feasible, skip.

**Agent Instructions**:
```
You are testing WorkRail v2 resume_session on a fresh system.

ISOLATION RULES:
- CHAT_ID: chat-4c-resume-empty
- Brand new chat
- Do NOT create a new session
- IMPORTANT: This test needs a fresh data directory

STEPS:
1. Call resume_session with NO parameters

ANALYSIS:
- How does resume_session handle the case where no sessions exist?
- Was it an error or an empty result?
```

**Expected Outcomes** (operator-only):
- Returns `{ candidates: [], totalEligible: 0 }` -- no error

---

### Chat B5: Result Count Limits

**Goal**: Test whether resume_session limits the number of candidates

**Setup**: 6+ sessions must exist (create them first if needed).

**Agent Instructions**:
```
You are testing WorkRail v2 resume_session result limits.

ISOLATION RULES:
- CHAT_ID: chat-4c-resume-cap
- Brand new chat
- Do NOT create a new session

TOOLING:
- Use ONLY v2 tools: resume_session

STEPS:
1. Call resume_session with NO parameters
   Count the number of candidates and note the totalEligible field.

ANALYSIS:
- Is there a maximum number of candidates returned?
- If totalEligible is larger than the candidate count, what does that tell you?
```

**Expected Outcomes** (operator-only):
- candidates.length <= 5
- totalEligible may be > 5
- Agent discovers the cap independently

---

## Section C: Blocked Node Retry (ADR 008) -- 5 Scenarios

### Chat C1: Recovering from a Blocked Response

**Goal**: Agent discovers the retry mechanism by getting blocked and finding a way to recover

**Agent Instructions**:
```
You are testing WorkRail v2 output validation behavior.

ISOLATION RULES:
- CHAT_ID: chat-adr008-retry-basic
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-adr008-retry-basic] ...

STEPS:
1. Call start_workflow with workflowId: "coding-task-workflow-agentic"

2. Advance through the workflow until you reach a step where the pending.prompt
   includes output requirements (look for sections describing required output).
   For each step without special requirements, provide normal output and advance.

3. When you reach a step with output requirements,
   intentionally provide INCOMPLETE output: include only notesMarkdown,
   omit whatever the prompt said was required.

4. Examine the response carefully.
   What is the response kind?
   What fields are present that were NOT in a normal "ok" response?
   Is there any information suggesting how to fix the problem?
   Is there any token or mechanism that looks like it could help you retry?

5. Based on what you found in the response, attempt to fix the issue.
   If you found a mechanism for retrying, use it.
   Provide correct output this time (include what the prompt required).

ANALYSIS:
- Was the blocked response self-explanatory?
- Did you understand how to recover without external documentation?
- What mechanism did you use to retry?
```

**Expected Outcomes** (operator-only):
- Agent gets blocked response with `kind: "blocked"`
- Agent discovers `retryAckToken` and `blockers` array in the response
- Agent independently figures out to use retryAckToken as the ackToken for retry
- Retry with correct output succeeds
- Key test: can the agent self-recover from the response alone?

---

### Chat C2: Chained Recovery Attempts

**Goal**: Test behavior when multiple retry attempts are needed

**Agent Instructions**:
```
You are testing WorkRail v2 repeated blocking behavior.

ISOLATION RULES:
- CHAT_ID: chat-adr008-retry-chain
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-adr008-retry-chain] ...

STEPS:
1. Call start_workflow with workflowId: "coding-task-workflow-agentic"
2. Advance to a step with output requirements

3. Provide INCOMPLETE output (intentionally wrong)

4. Attempt to fix it using whatever retry mechanism you discovered,
   but provide DIFFERENT incomplete output (still wrong)

5. Compare the retry mechanisms from steps 3 and 4 -- are they the same or different?

6. Now provide CORRECT output using the latest retry mechanism

ANALYSIS:
- What happens when you fail validation multiple times?
- Does the retry mechanism change between attempts?
- Can you chain retries until you get it right?
```

**Expected Outcomes** (operator-only):
- Each blocked attempt returns a different retryAckToken
- Agent discovers tokens change between retries
- Final retry with correct output succeeds

---

### Chat C3: Blocked Response Field Inventory

**Goal**: Thoroughly document the blocked response structure through observation

**Agent Instructions**:
```
You are testing WorkRail v2 blocked response structure.

ISOLATION RULES:
- CHAT_ID: chat-adr008-blocked-structure
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-adr008-blocked-structure] ...

STEPS:
1. Call start_workflow with workflowId: "coding-task-workflow-agentic"
2. Advance to a step with output requirements

3. Provide EMPTY output (just notesMarkdown in the output wrapper, omit everything else):
   {"output": {"notesMarkdown": "[CHAT_ID=chat-adr008-blocked-structure] Deliberately empty"}}

4. For EVERY field in the response, describe:
   - Field name
   - Value type
   - What it seems to contain
   - Whether it was present in normal "ok" responses

ANALYSIS:
- Is the response self-contained enough to recover from?
- What information helps you understand what went wrong?
- What information helps you fix it?
```

**Expected Outcomes** (operator-only):
- Agent documents all fields including blockers, retryable, retryAckToken, validation
- Agent identifies blockers with code/message/suggestedFix as the error detail
- Agent finds retryAckToken as the recovery mechanism
- Agent determines the response is self-contained for recovery

---

### Chat C4: Replay After Retry

**Goal**: Test retry idempotency by calling the same retry twice

**Agent Instructions**:
```
You are testing WorkRail v2 retry replay behavior.

ISOLATION RULES:
- CHAT_ID: chat-adr008-retry-replay
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-adr008-retry-replay] ...

STEPS:
1. Call start_workflow with workflowId: "coding-task-workflow-agentic"
2. Advance to a step with output requirements
3. Provide incomplete output to get blocked

4. Retry with CORRECT output using the retry mechanism (call this response_1)

5. Retry AGAIN with the SAME mechanism and SAME output (call this response_2)

6. Compare response_1 and response_2 field by field

ANALYSIS:
- What happens when you replay the same retry?
- Is the retry mechanism reusable or one-time?
```

**Expected Outcomes** (operator-only):
- Both responses are identical (idempotent)
- Agent discovers retries are safe to replay

---

### Chat C5: Original Token vs Retry Token After Block

**Goal**: Agent discovers the difference between the original ackToken and the retry token

**Agent Instructions**:
```
You are testing WorkRail v2 token behavior after validation failure.

ISOLATION RULES:
- CHAT_ID: chat-adr008-token-comparison
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-adr008-token-comparison] ...

STEPS:
1. Call start_workflow with workflowId: "coding-task-workflow-agentic"
   Note the ackToken (call it ackToken_original)

2. Advance to a step with output requirements

3. Provide incomplete output using ackToken_original to get blocked.
   Note the retry mechanism the response provides.

4. Try continue_workflow with ackToken_original AGAIN + CORRECT output
   (use the original ackToken, NOT the retry mechanism)

5. Try continue_workflow with the retry mechanism + CORRECT output

6. Compare the two responses from steps 4 and 5

ANALYSIS:
- What is the difference between using the original token vs the retry mechanism?
- Which one should you use after getting blocked?
- Why do you think they behave differently?
```

**Expected Outcomes** (operator-only):
- Original ackToken replays the cached blocked response (idempotent -- same input/token produces same result)
- retryAckToken with correct output succeeds (new attempt)
- Agent independently discovers: original = replay, retry token = fresh attempt

---

## Section D: Loop Control Artifacts -- 5 Scenarios

### Chat D1: Loop Workflow Execution (Discovery-Based)

**Goal**: Agent executes a loop workflow using ONLY the prompts for guidance

**Agent Instructions**:
```
You are testing WorkRail v2 loop behavior.

ISOLATION RULES:
- CHAT_ID: chat-loop-basic
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-loop-basic] ...

STEPS:
1. Call start_workflow with workflowId: "test-artifact-loop-control"

2. Read the pending.prompt CAREFULLY. It will tell you what output format is needed.
   Follow the prompt's instructions exactly to provide the required output.
   Use a "continue" decision.

3. Continue following the workflow prompts. For each step, read the prompt
   and provide whatever output the prompt asks for.

4. When you reach a step that asks for a loop decision, provide "continue" once,
   then "stop" the next time.

5. Complete any remaining steps until the workflow finishes.

ANALYSIS:
- Was the prompt sufficient to understand what output was needed?
- How did the loop behave? What controlled whether it continued or stopped?
- Did you need any external documentation beyond the prompts?
- How many times did you go through the loop body?
```

**Expected Outcomes** (operator-only):
- Agent follows workflow prompts to produce loop control artifacts
- Prompt includes OUTPUT REQUIREMENTS with artifact format
- "continue" causes iteration, "stop" exits loop
- Agent produces correct artifacts from prompt instructions alone (not pre-taught)
- Key test: are the workflow prompts self-explanatory?

---

### Chat D2: Deliberately Invalid Loop Output

**Goal**: Test validation error messages for various invalid artifact shapes

**Agent Instructions**:
```
You are testing WorkRail v2 loop output validation.

ISOLATION RULES:
- CHAT_ID: chat-loop-invalid
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-loop-invalid] ...

STEPS:
1. Call start_workflow with workflowId: "test-artifact-loop-control"
   Read the prompt to understand what output format is expected.

2. Provide output that is DELIBERATELY WRONG in different ways.
   After each attempt, use whatever retry mechanism is available
   to try the next variant.

   Attempt A: Provide output with NO artifacts field at all
   {"output": {"notesMarkdown": "[CHAT_ID=chat-loop-invalid] No artifacts"}}

   Attempt B: Provide output with an empty artifacts array
   {"output": {"notesMarkdown": "[CHAT_ID=chat-loop-invalid] Empty", "artifacts": []}}

   Attempt C: Provide output with an artifact that has the wrong "kind"
   {"output": {"notesMarkdown": "[CHAT_ID=chat-loop-invalid] Wrong kind", "artifacts": [{"kind": "wrong", "loopId": "test-iteration", "decision": "continue"}]}}

   Attempt D: Provide output with a correct kind but invalid "decision" value
   {"output": {"notesMarkdown": "[CHAT_ID=chat-loop-invalid] Bad decision", "artifacts": [{"kind": "wr.loop_control", "loopId": "test-iteration", "decision": "maybe"}]}}

3. Finally, provide CORRECT output (follow the prompt's format exactly)

ANALYSIS:
- Were the error messages specific to each type of mistake?
- Could you have fixed each error from the error message alone?
- Did the correct output succeed after all the failed attempts?
```

**Expected Outcomes** (operator-only):
- Each invalid variant produces a blocked response with specific error details
- Error messages differ based on what was wrong (missing artifact, wrong kind, invalid value)
- Correct output succeeds after retries
- Key test: are validation errors specific and actionable?

---

### Chat D3: Omitting Required Output

**Goal**: Test what happens when a step requires special output but the agent provides only basic notes

**Agent Instructions**:
```
You are testing WorkRail v2 output requirement enforcement.

ISOLATION RULES:
- CHAT_ID: chat-loop-omitted
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-loop-omitted] ...

STEPS:
1. Call start_workflow with workflowId: "test-artifact-loop-control"

2. Ignore the output format requirements in the prompt.
   Just provide plain notes:
   {"output": {"notesMarkdown": "[CHAT_ID=chat-loop-omitted] I did the work but just wrote notes"}}

3. Examine the response. Does it explain what was missing?
   Does it tell you what format was actually needed?

4. Based solely on the error response, try to provide correct output.

ANALYSIS:
- What happens when you ignore output format requirements?
- Is the error response enough to understand what was needed?
- Could you fix it from the error alone (without re-reading the original prompt)?
```

**Expected Outcomes** (operator-only):
- Agent gets blocked with explanation that a specific artifact is required
- Error message describes what's needed
- Agent recovers using error guidance
- Key test: can the agent recover from "I didn't read the requirements" using error messages alone?

---

### Chat D4: Loop Safety Bounds

**Goal**: Discover what happens when the agent always says "continue"

**Agent Instructions**:
```
You are testing WorkRail v2 loop limits.

ISOLATION RULES:
- CHAT_ID: chat-loop-max
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-loop-max] ...

STEPS:
1. Call start_workflow with workflowId: "test-artifact-loop-control"

2. Follow the prompts. Whenever you need to provide a loop decision,
   ALWAYS choose "continue" -- never choose "stop".

3. Count how many times you go through the loop body.
   Keep going until something changes.

ANALYSIS:
- Is there a limit on how many times the loop can iterate?
- What happened when the limit was reached?
- Did the workflow continue after the loop stopped?
```

**Expected Outcomes** (operator-only):
- Loop runs exactly 3 iterations (maxIterations: 3)
- Loop stops automatically despite agent choosing "continue"
- Workflow proceeds to the final step
- Agent discovers maxIterations as a safety bound independently

---

### Chat D5: Metadata Variants

**Goal**: Test whether optional metadata fields affect validation

**Agent Instructions**:
```
You are testing WorkRail v2 loop output flexibility.

ISOLATION RULES:
- CHAT_ID: chat-loop-metadata
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-loop-metadata] ...

STEPS:
1. Call start_workflow with workflowId: "test-artifact-loop-control"

2. Read the prompt. The required output format may mention optional metadata.
   Provide output with ALL metadata fields the schema might accept:
   Include reason, issuesFound, iterationIndex, confidence along with the
   required fields. Use "continue" as your decision.

3. In the next loop decision, provide output with NO metadata at all
   (just the required fields, no metadata object).

4. In the next loop decision, provide output with only "reason" in metadata.
   Use "stop" as decision.

ANALYSIS:
- Does the amount of metadata affect whether your output is accepted?
- Which fields appear to be required vs optional?
```

**Expected Outcomes** (operator-only):
- All three variants accepted
- Metadata is purely optional / informational
- Agent confirms through experimentation that metadata doesn't affect validation

---

## Section E: Export/Import Bundles (Slice 4b) -- 3 Scenarios

Note: Export/import bundles are NOT exposed as MCP tools. These tests validate the underlying durability via observable side effects.

### Chat E1: Session Data Persistence

**Goal**: Verify step outputs persist durably across calls

**Agent Instructions**:
```
You are testing WorkRail v2 data persistence.

ISOLATION RULES:
- CHAT_ID: chat-4b-persistence
- Brand new chat
- Create brand new v2 session

TOOLING:
- Use ONLY v2 tools

OUTPUT TAGGING:
- When providing output, use: {"output": {"notesMarkdown": "[CHAT_ID=chat-4b-persistence] ...

STEPS:
1. Call start_workflow with workflowId: "workflow-diagnose-environment"

2. For each step, provide UNIQUE, identifiable output:
   - Step 1: {"output": {"notesMarkdown": "[CHAT_ID=chat-4b-persistence] UNIQUE_MARKER_ALPHA: Diagnosed network configuration"}}
   - Step 2: {"output": {"notesMarkdown": "[CHAT_ID=chat-4b-persistence] UNIQUE_MARKER_BETA: Found DNS resolution issue"}}
   - Step 3: {"output": {"notesMarkdown": "[CHAT_ID=chat-4b-persistence] UNIQUE_MARKER_GAMMA: Applied firewall rules"}}

3. After 3+ steps, call continue_workflow with ONLY stateToken (no ackToken)
   to rehydrate. What step is pending?

ANALYSIS:
- Do step outputs appear to persist between calls?
- Does the workflow remember where you were?
```

**Expected Outcomes** (operator-only):
- All outputs accepted
- Rehydrate shows correct next pending step
- Workflow state is durable

---

### Chat E2: Cross-Chat Persistence via Resume

**Goal**: Verify session data survives across chats

**Setup**: Uses session created in E1.

**Agent Instructions**:
```
You are testing WorkRail v2 cross-chat data durability.

ISOLATION RULES:
- CHAT_ID: chat-4b-cross-chat
- Brand new chat
- Do NOT create a new session

TOOLING:
- Use ONLY v2 tools: resume_session, continue_workflow

STEPS:
1. Call resume_session with query: "UNIQUE_MARKER_ALPHA"

2. Call resume_session with query: "UNIQUE_MARKER_BETA"

3. Did both queries find the same session?

4. If a session was found, use its stateToken to rehydrate with
   continue_workflow (no ackToken). What step is pending?

ANALYSIS:
- Are step output notes searchable in future chats?
- Does the workflow pick up where the previous chat left off?
```

**Expected Outcomes** (operator-only):
- Both queries find the same session via `matched_notes`
- Rehydrate shows correct pending step

---

### Chat E3: Session Event Log Structure (Filesystem Verification)

**Goal**: Verify session files on disk have correct structure

**Setup**: Requires filesystem access. This test is for the OPERATOR, not the agent.

**Operator Instructions**:
```
After running E1 and E2, verify the session data on disk:

1. Find the session directory:
   ls ~/.workrail/data/sessions/sess_*/

2. For each session directory, check:
   - manifest.jsonl exists and is valid JSONL
   - Event files (*.jsonl) exist in segments/
   - Each event has: kind, eventIndex, sessionId, scope
   - Events are in ascending eventIndex order

3. Check event kinds present:
   - session_created (first event)
   - run_started
   - node_created (one per step)
   - edge_created (connecting steps)
   - advance_recorded (one per advancement)
   - node_output_appended (one per output submission)

4. Verify output notes contain UNIQUE_MARKER strings:
   grep -r "UNIQUE_MARKER" ~/.workrail/data/sessions/

EXPECTED:
- All event files valid JSONL
- Event indices monotonically increasing
- Output notes persisted verbatim
- Manifest records reference correct segment files
```

---

## Validation Summary Table

After executing all chats, the human operator fills this table:

| Chat | Section | Focus | Pass/Fail | Notes |
|------|---------|-------|-----------|-------|
| A1 | Checkpoint | Behavior discovery | | |
| A2 | Checkpoint | Repeated calls | | |
| A3 | Checkpoint | Wrong tokens | | |
| A4 | Checkpoint | Token lifecycle | | |
| A5 | Checkpoint | Inside a loop | | |
| B1 | Resume | Cross-chat discovery | | |
| B2 | Resume | Query filtering | | |
| B3 | Resume | Git context | | |
| B4 | Resume | Empty state | | |
| B5 | Resume | Result count limits | | |
| C1 | Blocked Retry | Recovery discovery | | |
| C2 | Blocked Retry | Chained recovery | | |
| C3 | Blocked Retry | Response inventory | | |
| C4 | Blocked Retry | Retry replay | | |
| C5 | Blocked Retry | Original vs retry token | | |
| D1 | Loop Control | Prompt-driven execution | | |
| D2 | Loop Control | Invalid output variants | | |
| D3 | Loop Control | Omitted requirements | | |
| D4 | Loop Control | Safety bounds | | |
| D5 | Loop Control | Metadata flexibility | | |
| E1 | Export/Import | Data persistence | | |
| E2 | Export/Import | Cross-chat persistence | | |
| E3 | Export/Import | Filesystem structure (operator) | | |

---

## Success Criteria

After running all test chats:
- [ ] Agent independently discovers checkpoint behavior (A1)
- [ ] Agent discovers checkpoint idempotency (A2)
- [ ] Checkpoint rejects invalid tokens with actionable errors (A3)
- [ ] Agent discovers token-per-step lifecycle (A4)
- [ ] Checkpoint doesn't interfere with loops (A5)
- [ ] Agent finds and resumes previous session (B1)
- [ ] Agent discovers ranking pattern from query experiments (B2)
- [ ] Git context affects matching gracefully (B3)
- [ ] Empty state handled without errors (B4)
- [ ] Agent observes candidate cap (B5)
- [ ] Agent self-recovers from blocked state (C1)
- [ ] Agent discovers retry tokens change per attempt (C2)
- [ ] Agent documents blocked response completely (C3)
- [ ] Agent discovers retry idempotency (C4)
- [ ] Agent discovers original vs retry token difference (C5)
- [ ] Agent produces correct artifacts from prompts alone (D1)
- [ ] Validation errors are specific per mistake type (D2)
- [ ] Agent recovers from omitted requirements using errors (D3)
- [ ] Agent discovers maxIterations safety bound (D4)
- [ ] Agent confirms metadata is optional through experimentation (D5)
- [ ] Data persists across calls and chats (E1, E2)
- [ ] Event log structure is correct (E3)

---

## Test Environment

**Required**:
- Node.js >=20
- WorkRail v2 all slices complete
- `WORKRAIL_ENABLE_V2_TOOLS=true` environment variable
- Ability to run separate chats (sequential execution recommended)

**For resume tests (B1-B5)**:
- At least one prior session must exist (B1a creates it)
- Git repository with known branch for B3

**For export/import tests (E3)**:
- Filesystem access to `~/.workrail/data/sessions/`

---

## Debugging Failed Tests

If tests fail:
1. Confirm agent started fresh session (no token reuse) unless testing resume
2. Check `WORKRAIL_ENABLE_V2_TOOLS=true` is set
3. For checkpoint tests: verify the tool is available via list of tools
4. For resume tests: verify prior sessions exist on disk
5. For blocked retry tests: verify the workflow step actually has validation requirements
6. For loop tests: use `test-artifact-loop-control` workflow (purpose-built for testing)
7. Review agent's exact tool calls for parameter errors
8. Check terminal output for stack traces

---

## Post-Test Analysis

After all tests:
1. Review agent analysis sections for unexpected behaviors
2. Check `~/.workrail/data/sessions/` directory structure
3. Verify event logs contain expected event kinds
4. Confirm no orphan files or corrupted JSONL
5. Calculate error rate across all chats
6. Key metric: How many scenarios did the agent navigate correctly using ONLY tool responses and workflow prompts (no external docs)?
