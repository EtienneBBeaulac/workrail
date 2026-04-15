# Claude Code Source Analysis: WorkRail Auto Integration Patterns

**Date:** 2026-04-14  
**Source:** `https://github.com/Archie818/Claude-Code` (leaked source)  
**Purpose:** Identify concrete integration points for WorkRail Auto daemon

---

## Context / Ask

Deep dive on the leaked Claude Code source to produce concrete integration patterns for WorkRail Auto. Five areas:

1. Full compaction system (3 tiers)
2. Hooks API (PreToolUse/PostToolUse) for evidence collection
3. Session memory (persistence through compaction)
4. Coordinator/subagent model
5. sessionRunner.ts for programmatic session initiation

---

## Path Recommendation

**`landscape_first`** -- this is pure research/discovery. The landscape IS the output. No problem reframing needed; the ask is precisely scoped. Full spectrum would add overhead without improving output quality.

---

## Findings

### 1. Compaction System -- Three Tiers

**File:** `src/commands/compact/compact.ts` (287 lines, command layer)

The `/compact` command tries three tiers in order:

```
Tier 1: trySessionMemoryCompaction()   -- preferred, no API call, uses existing session memory file
Tier 2: compactConversation()          -- full LLM summarization, replaces all messages
Tier 3: microcompactMessages()         -- strip tool results/thinking before Tier 2
```

**Tier 1 -- Session Memory Compaction** (`src/services/compact/sessionMemoryCompact.ts`):
- Reads `~/.claude/projects/{cwd-hash}/{sessionId}/session-memory/summary.md`
- Uses `lastSummarizedMessageId` as the boundary -- only messages AFTER this ID are kept
- `calculateMessagesToKeepIndex()` expands backwards to meet minimums (10k-40k tokens, 5+ text-block messages)
- If session memory is empty or missing, falls back to Tier 2
- Config: `minTokens: 10_000`, `minTextBlockMessages: 5`, `maxTokens: 40_000`
- Gate: requires both `tengu_session_memory` AND `tengu_sm_compact` GrowthBook flags

**Tier 2 -- Full Compaction** (`src/services/compact/compact.ts`):
- Makes an LLM API call to summarize the entire conversation
- Replaces all messages with a summary message
- Sets `lastSummarizedMessageId = undefined` (resets the SM boundary)

**Tier 3 -- Microcompaction** (`src/services/compact/microCompact.ts`):
- Strips tool_result blocks, thinking blocks to reduce token count
- Runs BEFORE Tier 2 to reduce the summary payload
- No LLM call; purely mechanical stripping

**Pre/PostCompact hooks:**
- `executePreCompactHooks({ trigger: 'manual'|'auto', customInstructions })` runs before Tier 2
- Returns `newCustomInstructions` that get merged into the compaction prompt
- This is the injection point for WorkRail step notes

### 2. Hooks API

**File:** `src/utils/hooks.ts` (5022 lines), `src/schemas/hooks.ts`, `src/types/hooks.ts`

**Complete event list** (from `src/entrypoints/sdk/coreTypes.ts`):
```
PreToolUse, PostToolUse, PostToolUseFailure
UserPromptSubmit, SessionStart, SessionEnd
Stop, StopFailure
SubagentStart, SubagentStop
PreCompact, PostCompact
PermissionRequest, PermissionDenied
Notification, Setup, TeammateIdle
TaskCreated, TaskCompleted
Elicitation, ElicitationResult
ConfigChange, WorktreeCreate, WorktreeRemove
InstructionsLoaded, CwdChanged, FileChanged
```

**Hook types in settings.json:**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "my-observer.sh" },
          { "type": "http", "url": "https://workrail-daemon/hook", "headers": {...} },
          { "type": "prompt", "prompt": "Verify this tool call is safe..." },
          { "type": "agent", "prompt": "Run full verification..." }
        ]
      }
    ],
    "PostToolUse": [...],
    "PreCompact": [...]
  }
}
```

**How hooks are dispatched** (`executeHooksOutsideREPL`):
1. `getMatchingHooks(appState, sessionId, hookEvent, hookInput)` -- finds hooks where matcher matches tool name
2. All hooks run in parallel via `Promise.all`
3. JSON input piped to stdin (for `command` type) or POSTed (for `http` type)
4. Hook output is JSON parsed and validated via Zod schema

**PreToolUse hook data** (what the hook receives via stdin):
```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "git commit -am 'fix'" },
  "tool_use_id": "toolu_abc123",
  "session_id": "...",
  "cwd": "/path/to/project"
}
```

**PreToolUse hook response options:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "optional explanation",
    "updatedInput": { "command": "modified command" },
    "additionalContext": "text appended to tool result context"
  },
  "decision": "approve" | "block",
  "reason": "shown to agent if blocking",
  "continue": false,       // stops Claude completely
  "stopReason": "message"  // displayed when continue=false
}
```

**Key capabilities for WorkRail Auto:**
- `permissionDecision: "deny"` + `reason` = block a tool call (evidence gate)
- `permissionDecision: "allow"` = pre-approve without permission prompt
- `additionalContext` = inject text into tool result that agent sees
- `updatedInput` = modify the tool call before execution
- `continue: false` = halt the entire session (circuit breaker)

**PostToolUse hook response options:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "updatedMCPToolOutput": "...",   // override MCP tool response
    "additionalContext": "..."       // inject into tool result context
  }
}
```

**PreCompact hook response:**
```json
{
  "newCustomInstructions": "Always preserve WorkRail step notes: ...",
  "userDisplayMessage": "WorkRail notes injected before compaction"
}
```
The `newCustomInstructions` output gets merged into the compaction prompt -- this is how WorkRail injects step notes into the compaction summary.

**HTTP hooks** -- direct POST to a URL:
- Headers support env var interpolation: `"Authorization": "Bearer $WORKRAIL_TOKEN"`
- `allowedEnvVars` must list the vars for interpolation to work
- Response: same JSON schema as command hooks

### 3. Session Memory

**Files:** `src/services/SessionMemory/sessionMemory.ts` (495 lines), `sessionMemoryUtils.ts` (207 lines)

**What it is:** A markdown file at `~/.claude/projects/{cwd-hash}/{sessionId}/session-memory/summary.md` that is continuously updated by a background forked subagent. It extracts key facts from the conversation without interrupting the main flow.

**How it's maintained:**
- A `postSamplingHook` runs after every LLM response
- Triggers when: context > 10k tokens AND (5k+ new tokens OR 3+ new tool calls)
- A forked subagent (runs in background) reads the conversation and updates the summary.md
- Uses `FileEditTool` restricted to the session memory file only
- `setLastSummarizedMessageId()` marks how far the extraction has processed

**File path:** `getSessionMemoryDir()` returns `~/.claude/projects/{getProjectDir(getCwd())}/{getSessionId()}/session-memory/`

**WorkRail injection point:**
- The daemon can write directly to `summary.md` before the session starts, or via PreCompact hook
- Content format is structured markdown with sections (the template is in `src/services/SessionMemory/prompts.ts`)
- When Tier 1 compaction runs, this file IS the summary -- it directly becomes the post-compact context

### 4. Coordinator/Subagent Model

**File:** `src/coordinator/coordinatorMode.ts` (369 lines)

**Activation:** `CLAUDE_CODE_COORDINATOR_MODE=1` env var (behind `feature('COORDINATOR_MODE')` flag)

**How it works:**
- Coordinator has special tools: `AgentTool`, `SendMessageTool`, `TaskStopTool`
- Workers launched via `AgentTool({ description, subagent_type: "worker", prompt })` 
- Worker results return as user-role messages containing `<task-notification>` XML:
  ```xml
  <task-notification>
    <task-id>{agentId}</task-id>
    <status>completed|failed|killed</status>
    <summary>human readable</summary>
    <result>agent's final text</result>
    <usage><total_tokens>N</total_tokens>...</usage>
  </task-notification>
  ```
- Coordinator continues a worker via `SendMessageTool({ to: agentId, message: "..." })`
- Workers have standard tools + MCP tools from configured servers

**System prompt for coordinator** (`getCoordinatorSystemPrompt()`):
- Explicitly teaches the coordinator NOT to predict worker results
- "After launching agents, briefly tell the user what you launched and end your response"
- Workers each get their own tool permission context

**WorkRail relevance:**
- WorkRail's daemon should NOT use coordinator mode (it's cloud-hosted feature)
- The pattern of subagent-as-delegated-worker maps to WorkRail's `templateCall` / `mcp__nested-subagent__Task`
- Worker result delivery via user messages = WorkRail's pattern of `continue_workflow` advancing steps

**Scratchpad directory** (`CLAUDE_CODE_SCRATCHPAD_DIR`):
- Workers can read/write a shared dir without permission prompts
- Cross-worker durable knowledge store
- WorkRail's session notes in `~/.workrail/sessions/` serve the same purpose

**Permission handlers per mode** (`src/hooks/toolPermission/handlers/`):
- `coordinatorHandler.ts` -- handles Coordinator mode permission
- `swarmWorkerHandler.ts` -- handles worker permission
- `interactiveHandler.ts` -- interactive human permission

### 5. sessionRunner.ts

**File:** `src/bridge/sessionRunner.ts` (550 lines)

**What it is:** A process spawner for running Claude Code CLI programmatically. Used by the bridge (cloud/web UI) to spawn local Claude Code processes as child processes.

**NOT a daemon API** -- this is specifically for the web-bridge architecture where a server spawns Claude Code CLI processes per user session.

**Spawn interface:**
```typescript
createSessionSpawner({
  execPath: string,         // path to claude binary
  scriptArgs: string[],     // prepended args (for npm installs: [process.argv[1]])
  env: NodeJS.ProcessEnv,
  verbose: boolean,
  sandbox: boolean,
  permissionMode?: string,
  onDebug: (msg) => void,
  onActivity?: (sessionId, activity) => void,
  onPermissionRequest?: (sessionId, request, accessToken) => void
})
```

**Spawn options:**
```typescript
SessionSpawnOpts = {
  sessionId: string,
  sdkUrl: string,           // WebSocket URL to session-ingress
  accessToken: string,      // Anthropic API session token
  useCcrV2?: boolean,
  workerEpoch?: number,
}
```

**What the spawned CLI receives:**
```
claude --print --sdk-url WS_URL --session-id SESSION_ID
       --input-format stream-json --output-format stream-json
       --replay-user-messages
       [--permission-mode MODE]
```

**NDJSON event stream:**
- Child process emits NDJSON lines to stdout
- Bridge reads and parses tool activities: `extractActivities()` looks for `SDKAssistantMessage`, `SDKUserMessage`, tool use events
- Activities tracked: tool name + humanized verb ("Bash" -> "Running")
- First user message detection: skips `parent_tool_use_id != null` (tool results) and `isReplay` messages

**WorkRail relevance:**
- sessionRunner.ts is the BRIDGE pattern (web server -> local CLI process)
- WorkRail's daemon should use pi-mono's `Agent` class directly (Anthropic API), not spawn subprocess
- The `--sdk-url` pattern with WebSocket transport is cloud-specific; WorkRail calls Anthropic API directly
- Key insight: the CLI subprocess writes NDJSON to stdout. If WorkRail ever needs to call Claude Code as a subprocess (vs API directly), this is the integration protocol

---

## Concrete Integration Patterns for WorkRail Auto

### Pattern 1: PreCompact Hook -- Inject Step Notes into Compaction Summary

**What:** A shell script registered as `PreCompact` hook in `~/.claude/settings.json`

**Config:**
```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [
          {
            "type": "command",
            "command": "workrail inject-compact-notes --session-id $CLAUDE_SESSION_ID",
            "statusMessage": "WorkRail: injecting session notes..."
          }
        ]
      }
    ]
  }
}
```

**How it works:**
- Hook is called with `{ hook_event_name: "PreCompact", trigger: "auto"|"manual", custom_instructions: null }`
- Script reads `~/.workrail/sessions/{sessionId}/` -- gets the current step, notes from all completed steps
- Outputs JSON: `{ "newCustomInstructions": "WorkRail session state:\n- Step 3/7 complete\n- Key findings: ..." }`
- Claude Code merges this into the compaction prompt
- The summary WILL include WorkRail context because it's part of the custom instructions

**Why Tier 1 (session memory) is even better:**
- WorkRail daemon can write directly to `~/.claude/projects/{hash}/{sessionId}/session-memory/summary.md`
- When Tier 1 runs, this file IS the compact summary -- no compaction API call needed
- WorkRail step notes written here survive compaction at zero cost

### Pattern 2: HTTP Hook -- Evidence Gate for PreToolUse

**What:** An HTTP endpoint in the WorkRail daemon that validates tool calls against required evidence

**Config:**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3101/hooks/pre-tool-use",
            "headers": {
              "Authorization": "Bearer $WORKRAIL_DAEMON_TOKEN"
            },
            "allowedEnvVars": ["WORKRAIL_DAEMON_TOKEN"],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**Endpoint receives:**
```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "..." },
  "tool_use_id": "toolu_abc",
  "session_id": "session-xyz"
}
```

**Gate logic:** WorkRail daemon checks if the current step's `requiredEvidence` is satisfied:
- Evidence not yet recorded: respond with `{ "permissionDecision": "deny", "reason": "WorkRail: must record evidence for step 3 before this tool call is allowed" }`
- Evidence recorded: respond with `{ "permissionDecision": "allow" }`
- Emergency: respond with `{ "continue": false, "stopReason": "WorkRail: session terminated by policy" }`

**PostToolUse -- Evidence collection:**
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3101/hooks/post-tool-use"
          }
        ]
      }
    ]
  }
}
```
Endpoint receives the tool result and records it as evidence in the session store.

### Pattern 3: SessionStart Hook -- Inject WorkRail Context

**What:** A SessionStart hook that injects WorkRail context into the initial system prompt

**Config:**
```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "workrail inject-session-start --session-id $CLAUDE_SESSION_ID"
          }
        ]
      }
    ]
  }
}
```

**Response:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "WorkRail session state:\n\nWorkflow: coding-task-workflow\nCurrent step: 3/7 - Implement the change\nCompleted steps:\n- Step 1: Analyzed the codebase (notes: ...)\n- Step 2: Created implementation plan (notes: ...)\n\nRequired evidence for step 3: test_results_json, modified_files_list\nContinue token: ct_XXXX\n\nTo advance the workflow: call mcp__workrail__continue_workflow"
  }
}
```

This is the "context survival" pattern -- WorkRail injects a full recap of the session state at session start, so even if the context was compacted or this is a new session resuming a checkpoint, the agent knows exactly where it is.

### Pattern 4: Programmatic Session via Subprocess (for local mode)

If WorkRail needs to spawn a Claude Code subprocess (not Anthropic API directly):

```typescript
const spawner = createSessionSpawner({
  execPath: 'claude',                    // or full path
  scriptArgs: [],                        // empty for compiled binary
  env: { ...process.env, CLAUDE_CODE_COORDINATOR_MODE: undefined },
  verbose: false,
  sandbox: false,
  permissionMode: 'bypassPermissions',   // for daemon sessions
  onDebug: (msg) => logger.debug(msg),
  onActivity: (sessionId, activity) => {
    workrailDaemon.recordActivity(sessionId, activity)
  },
  onPermissionRequest: async (sessionId, request, token) => {
    // Delegate permission requests to WorkRail console for HITL
    const decision = await workrailConsole.requestPermission(sessionId, request)
    return decision
  }
})
```

**IMPORTANT:** This is NOT the preferred WorkRail daemon architecture. WorkRail calls Anthropic API directly via pi-mono's `Agent`. The subprocess model adds overhead and is harder to control. Use it only if you need Claude Code's full feature set (Skills, existing IDE integration, etc.).

### Pattern 5: Direct Session Memory Injection

WorkRail daemon writes directly to Claude Code's session memory file before/during a session:

```typescript
// Path: ~/.claude/projects/{base64(cwd)}/{sessionId}/session-memory/summary.md
const sessionMemoryPath = path.join(
  os.homedir(), '.claude', 'projects',
  encodeProjectDir(workspacePath),
  sessionId, 'session-memory', 'summary.md'
)

const workrailNotes = `## WorkRail Session State

**Workflow:** ${workflowId} -- ${workflowName}
**Session:** ${sessionId}
**Step:** ${currentStep} of ${totalSteps} -- ${stepTitle}

### Completed Steps
${completedSteps.map(s => `- Step ${s.index}: ${s.title}\n  ${s.notes}`).join('\n')}

### Current Step Requirements
${currentStep.requiredEvidence ? `Required evidence: ${currentStep.requiredEvidence.join(', ')}` : 'No evidence requirements'}

### Key Decisions
${keyDecisions.join('\n')}
`

await fs.writeFile(sessionMemoryPath, workrailNotes)
```

When Tier 1 compaction runs, this content IS the summary. Zero tokens spent on compaction, zero LLM calls, WorkRail context survives indefinitely.

---

## Key Decisions

1. **WorkRail daemon should NOT use sessionRunner.ts** -- that's the bridge pattern for spawning CLI subprocesses. WorkRail calls Anthropic API via pi-mono.

2. **Evidence gate = HTTP PreToolUse hook** -- register a hook in `~/.claude/settings.json` pointing to a local WorkRail daemon endpoint. The daemon gates tool calls based on required evidence state. Zero changes to Claude Code source.

3. **Compaction survival = two paths:**
   - **Preferred:** Direct session memory injection (write to `summary.md` before session starts and after each step)
   - **Fallback:** PreCompact hook that outputs `newCustomInstructions` with step notes

4. **Coordinator mode is NOT for WorkRail daemon** -- it's a cloud-hosted feature with specific tool requirements. WorkRail uses pi-mono's `agentLoop` directly.

5. **HITL via PermissionRequest hook** -- workflow steps that require human approval can use `permissionDecision: "ask"` to escalate to the console, OR WorkRail daemon returns `{ "continue": false }` and the console offers a resume.

---

## Decision Log

- 2026-04-14: Research source files directly from GitHub API. No GrowthBook flags needed for PreCompact/PreToolUse/PostToolUse hooks -- those are available to all users. Session memory compaction (Tier 1) is gated behind GrowthBook flags (`tengu_session_memory` + `tengu_sm_compact`) but direct file injection bypasses the gate entirely.
- 2026-04-14: sessionRunner.ts identified as bridge architecture (web server -> CLI subprocess), NOT the pattern for WorkRail daemon. WorkRail daemon calls Anthropic API directly.
- 2026-04-14: Confirmed HTTP hooks support env var interpolation via `allowedEnvVars` -- WorkRail daemon token can be passed securely without hardcoding.

---

## Final Summary

The five integration points for WorkRail Auto, ranked by implementation priority:

| Priority | Pattern | Where | What |
|----------|---------|-------|------|
| 1 | Direct session memory injection | WorkRail daemon writes `summary.md` | Cheapest compaction survival -- no LLM call |
| 2 | HTTP PreToolUse hook | `~/.claude/settings.json` + daemon endpoint | Evidence gate -- block/allow tool calls |
| 3 | HTTP PostToolUse hook | Same | Evidence collection -- record what agent did |
| 4 | PreCompact hook | Same | Fallback compaction survival if SM injection unavailable |
| 5 | SessionStart hook | Same | Context injection when resuming checkpointed sessions |

`sessionRunner.ts` is NOT a daemon integration point. It is the web bridge pattern (process spawner). WorkRail's daemon uses pi-mono's `Agent` directly.

Coordinator mode is NOT needed. WorkRail's own step enforcement + pi-mono's `agentLoop` provides equivalent orchestration with WorkRail's structural guarantees.
