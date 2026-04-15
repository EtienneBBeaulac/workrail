# Claude Code Source Deep Dive -- WorkRail Auto Integration Points

**Source:** `https://github.com/Archie818/Claude-Code`
**Date:** 2026-04-14
**Purpose:** Extract everything from the leaked Claude Code source relevant to WorkRail Auto daemon design.

---

## Path Recommendation: `landscape_first`

This is a pure research task -- we need to understand existing mechanisms before designing WorkRail's integration points. The risk is not framing the wrong problem; the risk is building the wrong integration point because we misread the source. `landscape_first` is the correct path.

---

## Constraints / Anti-goals

- Do not design WorkRail code here -- this is findings only.
- Do not speculate about Claude Code internals beyond what the source shows.
- Focus exclusively on what matters for WorkRail Auto: compaction hooks, evidence collection, session memory injection, programmatic session initiation.

---

## 1. Compaction System -- Three Tiers

### Tier 1: Session Memory Compaction (`sessionMemoryCompact.ts`)

**What it is:** The preferred compaction path. Instead of re-summarizing the entire conversation with a new API call, it uses an existing server-side session memory file as the summary. Only runs if:
- Feature gate `tengu_session_memory` AND `tengu_sm_compact` are both enabled, OR
- Env var `ENABLE_CLAUDE_CODE_SM_COMPACT=1` is set (also works for eval/testing)

**How it works:**
1. `trySessionMemoryCompaction(messages, agentId?)` is called first in the compaction pipeline
2. It reads session memory from `getSessionMemoryPath()` (a file on disk)
3. It finds the `lastSummarizedMessageId` -- the most recently-summarized message UUID
4. It calculates which messages to keep via `calculateMessagesToKeepIndex()`:
   - Starts from `lastSummarizedIndex + 1`
   - Expands backwards until `minTokens=10,000` and `minTextBlockMessages=5` are met
   - Hard cap at `maxTokens=40,000`
   - All defaults remotely configurable via GrowthBook (`tengu_sm_compact_config`)
5. It builds a `CompactionResult` using the session memory content as the summary, with `messagesToKeep` as the fresh context
6. Calls `processSessionStartHooks('compact', {...})` to restore CLAUDE.md and other context
7. Returns the result -- **no API call made**, no LLM invocation for summarization

**Key functions:**
- `getSessionMemoryContent()` -- reads the session memory file
- `setLastSummarizedMessageId(messageId)` -- marks the compaction boundary (exported, writable)
- `calculateMessagesToKeepIndex(messages, lastSummarizedIndex)` -- determines message retention window
- `adjustIndexToPreserveAPIInvariants(messages, startIndex)` -- ensures no orphaned tool_use/tool_result pairs
- `shouldUseSessionMemoryCompaction()` -- gate check (respects env var override)

**WorkRail Auto integration point:** Session memory compaction is the cheapest and fastest compaction path. WorkRail's daemon can **write WorkRail step notes directly into the session memory file** at `getSessionMemoryPath()` before compaction fires. When Tier 1 compaction runs, the step notes become part of the summary. This survives the compaction because the session memory file is on disk -- it's not in the context window. The `setLastSummarizedMessageId(undefined)` call after legacy compaction resets the boundary, but SM compaction preserves it.

**The injection interface:** The session memory file is a plain file at a known path. WorkRail writes to it via a `PreCompact` hook (see Section 3). The hook output becomes `newCustomInstructions` which are merged into the compaction prompt. Alternatively, WorkRail can write directly to the session memory file path (bypassing the hook) -- the session memory content is read directly by `getSessionMemoryContent()`.

---

### Tier 2: Full Conversation Compaction (`compact.ts` service, `compactConversation()`)

**What it is:** The traditional compaction path. Makes a real LLM API call to summarize the conversation.

**How it works:**
1. Runs `executePreCompactHooks({ trigger, customInstructions })` BEFORE summarization
2. Hook output (`newCustomInstructions`) is merged with user instructions via `mergeHookInstructions()`
3. Passes the merged instructions to the LLM as the compaction prompt
4. Runs microcompaction first to reduce token count before the API call
5. After successful compaction, calls `setLastSummarizedMessageId(undefined)` to clear the boundary

**`executePreCompactHooks` signature:**
```typescript
executePreCompactHooks(
  compactData: { trigger: 'manual' | 'auto'; customInstructions: string | null },
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<{ newCustomInstructions?: string; userDisplayMessage?: string }>
```

**`PreCompactHookInput` fields (from hooks.ts, hookEvent = 'PreCompact'):**
- `hook_event_name: 'PreCompact'`
- `trigger: 'manual' | 'auto'`
- `custom_instructions: string | null`
- Plus base fields: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `agent_id`, `agent_type`

**Hook registration:** In `~/.claude/settings.json` under `hooks.PreCompact`. Format:
```json
{
  "PreCompact": [{ "matcher": "auto", "hooks": [{ "type": "command", "command": "path/to/script.sh" }] }]
}
```
Matcher is `trigger` value -- `"auto"` or `"manual"` or `"*"` for both.

**Hook output protocol:** If the hook exits 0 and outputs text, that text becomes `newCustomInstructions` and gets merged into the compaction prompt. The compaction LLM therefore receives the WorkRail step notes as additional compaction instructions. This means WorkRail can say: "Include this structured context in your summary: [step notes]".

**WorkRail integration:** Register a `PreCompact` hook via `setup-hooks.sh`. The hook script reads WorkRail's current session store (via a WorkRail CLI call), formats the current step notes as structured context, and outputs that text to stdout. The compaction LLM incorporates this into the summary.

---

### Tier 3: Microcompaction (`microCompact.ts`)

**What it is:** Token reduction without summarization. Runs BEFORE Tier 2 (legacy compact calls it before the API call). Not a standalone compaction tier -- it reduces message size while keeping message count.

**Two microcompaction paths:**
1. **Cached microcompact** (`CACHED_MICROCOMPACT` feature gate): Uses the Anthropic cache editing API (`cache_edits`) to delete old tool results from the cached prompt prefix without invalidating the cache. No visible message mutation -- cache edits are applied at the API layer. Tracks which tool IDs to delete, builds `CacheEditsBlock`, queues it as `pendingCacheEdits`.
2. **Time-based microcompact**: When the gap since the last assistant message exceeds a threshold (e.g., 30+ minutes), content-clears old tool results in the message array directly. Triggered by stale cache detection.

**Compactable tools:** `Read`, `Bash`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `Edit`, `Write` -- not MCP tools.

**Key function:** `estimateMessageTokens(messages)` -- used by both SM compaction and autocompaction to measure context size. Pads by 4/3 for conservative estimation.

**WorkRail relevance:** Low. Microcompaction is orthogonal to WorkRail -- it doesn't need any hooks. The key insight is that microcompaction runs FIRST, so by the time PreCompact hooks fire (in Tier 2) or SM compaction uses the session memory (Tier 1), the message array is already reduced. WorkRail's hooks don't need to worry about microcompaction.

---

### Compaction Pipeline Order (`compact.ts` command)

```
getMessagesAfterCompactBoundary()  // Filter out already-compacted messages
  │
  ├─ (no custom instructions?) trySessionMemoryCompaction()  // Tier 1
  │       ├─ success → runPostCompactCleanup(), return
  │       └─ null → continue
  │
  ├─ (reactive mode?) compactViaReactive()  // Tier 2a
  │       ├─ executePreCompactHooks() + getCacheSharingParams() concurrently
  │       └─ reactiveCompactOnPromptTooLong()
  │
  └─ (legacy mode) microcompactMessages() → compactConversation()  // Tier 2b
          ├─ executePreCompactHooks()  // HOOK FIRES HERE
          └─ summarize via LLM API call
```

**Key insight:** `trySessionMemoryCompaction()` is checked FIRST, before PreCompact hooks run. If SM compaction succeeds, PreCompact hooks are NEVER executed. WorkRail's PreCompact hook only fires for Tier 2 (legacy/reactive) compaction. If WorkRail wants to inject notes into Tier 1 (SM compaction), it must write to the session memory file directly.

**PostCompact hooks** (`executePostCompactHooks`): Receive `{ trigger, compact_summary }` -- the LLM-generated summary text. WorkRail could use this to log that a compaction happened and verify its notes made it into the summary.

---

## 2. Hooks System -- Full Architecture

### Hook Registration

Hooks are registered in `~/.claude/settings.json` (user-level) or `<project>/.claude/settings.json` (project-level) under a `hooks` key:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "~/.workrail/hooks/pre-tool-use.sh" }]
      }
    ],
    "PostToolUse": [...],
    "PreCompact": [...],
    "Stop": [...]
  }
}
```

### Hook Event Types (full list from `HOOK_EVENTS` constant)

```typescript
const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'UserPromptSubmit',
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'PermissionRequest', 'PermissionDenied',
  'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  'Elicitation', 'ElicitationResult',
  'ConfigChange', 'WorktreeCreate', 'WorktreeRemove',
  'InstructionsLoaded', 'CwdChanged', 'FileChanged',
]
```

### PreToolUse Hook

**Fired:** Before every tool call. The hook receives the tool name and full input.

**PreToolUseHookInput** (from `createBaseHookInput` + tool-specific fields):
- `hook_event_name: 'PreToolUse'`
- `tool_name: string` -- e.g., `'Bash'`, `'Write'`, `'mcp__workrail__continue_workflow'`
- `tool_input: object` -- the full tool input object
- `session_id`, `transcript_path`, `cwd`, `permission_mode`, `agent_id`, `agent_type`

**Hook output for PreToolUse:**
```json
{
  "continue": false,            // Block the tool call
  "decision": "block",          // Or "approve"
  "reason": "string",           // Why blocked
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",   // "allow" | "deny" | "ask"
    "permissionDecisionReason": "string",
    "updatedInput": { ... }     // Modify the tool input before execution
  }
}
```

**`updatedInput` field:** A PreToolUse hook can MODIFY the tool input. The modified input is used for execution. This is the gate mechanism -- WorkRail's `requiredEvidence` gate can block `continue_workflow` calls by returning `permissionDecision: "deny"`.

### PostToolUse Hook

**Fired:** After every tool call completes successfully.

**PostToolUseHookInput:**
- `hook_event_name: 'PostToolUse'`
- `tool_name: string`
- `tool_input: object`
- `tool_response: object` -- the full tool result
- `session_id`, `transcript_path`, `cwd`, `agent_id`, `agent_type`

**Hook output for PostToolUse:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "string",      // Injected as system message after the tool result
    "updatedMCPToolOutput": unknown     // Override the MCP tool's output
  }
}
```

**`additionalContext` field:** PostToolUse can inject text into the conversation as a system message after each tool call. This is how WorkRail's evidence collection works: when the daemon sees a `Bash` or `Write` tool call that matches a required evidence criterion, the PostToolUse hook logs it and optionally injects a confirmation message.

**`updatedMCPToolOutput` field:** For MCP tool calls, PostToolUse can completely override the tool's output. This is powerful -- WorkRail could intercept `continue_workflow` results and modify them. However, this is probably not needed for MVP.

### Stop Hook

**Fired:** When the agent produces a final response (stopping the loop).

**StopHookInput:**
- `hook_event_name: 'Stop'`
- `stop_reason: string`
- Plus base fields

**Hook output:** `{ "continue": false }` or blocking error. A Stop hook can **prevent the session from terminating** by returning a blocking error with `continue: true` (or non-zero exit code with message). This is the mechanism for requiring evidence before the agent can report "done".

### Hook Execution Flow

All hooks execute as subprocess shell commands (or HTTP requests for `type: 'http'` hooks). The flow:

1. Input is serialized to JSON and written to the hook script's stdin
2. Hook script runs; stdout is parsed
3. If stdout starts with `{`, it's parsed as `HookJSONOutput` (Zod-validated)
4. `continue: false` → `preventContinuation = true`
5. `decision: 'block'` → tool execution blocked, `blockingError` returned to model
6. Exit code 2 → treated as blocking error regardless of stdout

**Async hooks:** Hooks can return `{"async": true}` as their first line to be backgrounded. The main loop continues without waiting. WorkRail's evidence collection hooks should be synchronous for correctness.

**Timeout:** Default 10 minutes per hook (`TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000`). Configurable per hook via `timeout` field in settings.

**Trust check:** All hooks require workspace trust in interactive mode. In non-interactive (SDK) mode, trust is implicit -- always executes. The daemon runs in non-interactive mode, so WorkRail's hooks always fire.

---

## 3. Subagent / Coordinator Model

### Architecture

Claude Code has a `--coordinator` mode (`CLAUDE_CODE_COORDINATOR_MODE=1` env var, `feature('COORDINATOR_MODE')` gate). The coordinator is a special Claude instance that:

- Owns communication with the user (all messages go through it)
- Does not do direct implementation work
- Spawns worker agents via the `AgentTool` (`AGENT_TOOL_NAME`)
- Continues workers via `SendMessageTool` (`SEND_MESSAGE_TOOL_NAME`)
- Stops workers via `TaskStopTool` (`TASK_STOP_TOOL_NAME`)
- Workers report back as `<task-notification>` user-role messages

### Worker Capabilities

Workers have access to standard tools (Bash, Read, Write, etc.) plus MCP tools from connected servers plus project Skills. The coordinator's system prompt (`getCoordinatorSystemPrompt()`) explicitly lists worker tools and workflow.

**Key implication for WorkRail Auto:** In coordinator mode, the WorkRail MCP tools (`start_workflow`, `continue_workflow`) are available to workers (as MCP tools from the connected WorkRail MCP server). The coordinator could dispatch a worker to "advance the workflow" while the coordinator manages communication. However, this creates session token complications -- the continue token must be passed between coordinator and worker.

### `CoordinatorTaskPanel` Component

Renders a live panel of running agent tasks. Each task has:
- `startTime`, `evictAfter` (visibility timeout)
- Status: running, completed, failed, killed
- `summary`, `result` (from `<task-notification>`)
- `usage.total_tokens`, `usage.tool_uses`, `usage.duration_ms`

Tasks are evicted from display after their `evictAfter` timestamp passes (1-second tick).

### Result Flow

Workers communicate results back to the coordinator as user-role messages containing XML:
```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <status>completed|failed|killed</status>
  <summary>{human-readable status}</summary>
  <result>{agent's final text response}</result>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
</task-notification>
```

The coordinator never thanks or acknowledges workers -- it synthesizes findings and communicates only with the user. Workers run autonomously; the coordinator is the only surface the user sees.

### Coordinator System Prompt Key Rules

From `getCoordinatorSystemPrompt()`:
- "Every message you send is to the user. Worker results and system notifications are internal signals, not conversation partners."
- "After launching agents, briefly tell the user what you launched and end your response. Never fabricate or predict agent results."
- "Continue workers whose work is complete via SendMessageTool to take advantage of their loaded context."
- "Verification means proving the code works, not confirming it exists."

**WorkRail Auto relevance:** This is a clean reference model for WorkRail's subagent design. WorkRail's coordinator session holds the main workflow state. Workers are dispatched for parallel steps (e.g., multiple reviewers in an MR review workflow). Workers report back via WorkRail's session store, not in-context communication -- more robust than Claude Code's XML notification pattern.

The key difference: WorkRail's workers don't communicate back via in-context messages. They `continue_workflow` on their own sub-session. The coordinator polls the WorkRail session store (or receives a WebSocket push) to learn when a worker's sub-step is complete. This is the more durable pattern from the backlog.

---

## 4. Session Memory System

### What Session Memory Is

Session memory is a **persistent, server-maintained summary** of the current session's work. It lives at `getSessionMemoryPath()` -- a file path derived from `~/.claude/` and the session ID. It is:
- Written by a background extraction process (not on the hot path)
- Read by `getSessionMemoryContent()` during SM compaction
- Structured as sections (the exact format is in `services/SessionMemory/prompts.ts` -- not read, but `truncateSessionMemoryForCompact()` references `isSessionMemoryEmpty()` which checks for a template)

### Update Triggers

From `sessionMemoryUtils.ts`, session memory is updated when:
- `hasMetInitializationThreshold(currentTokenCount)` returns true: `currentTokenCount >= 10,000` tokens
- `hasMetUpdateThreshold(currentTokenCount)` returns true: `tokensSinceLastExtraction >= 5,000`
- `getToolCallsBetweenUpdates()` tool calls have occurred since last update: default 3

All thresholds are remotely configurable via GrowthBook.

### State Management

Key module-level state in `sessionMemoryUtils.ts`:
- `lastSummarizedMessageId: string | undefined` -- the UUID of the last message included in session memory
- `extractionStartedAt: number | undefined` -- timestamp when background extraction started (for waiting)
- `tokensAtLastExtraction: number` -- context size at last extraction (for delta threshold)
- `sessionMemoryInitialized: boolean` -- whether the init threshold has been met

Key exported functions:
- `setLastSummarizedMessageId(id)` -- **directly settable** -- marks what has been summarized
- `markExtractionStarted()` / `markExtractionCompleted()` -- for concurrency control
- `waitForSessionMemoryExtraction()` -- waits up to 15s for background extraction; 1-min staleness timeout
- `recordExtractionTokenCount(count)` -- tracks context size at extraction time
- `resetSessionMemoryState()` -- resets all state (useful for testing)

### WorkRail Auto Integration

**Direct write pattern:** WorkRail's daemon can write to the session memory file directly at `getSessionMemoryPath()` before triggering compaction. The session memory file is just a file -- no special API needed. WorkRail writes a structured section like:

```markdown
## WorkRail Session State
**Workflow:** mr-review-workflow-agentic (session: sess_abc123)
**Current Step:** 3/8 -- Code Review
**Step Notes:**
- Reviewed 14 files in src/messaging/
- Found 3 issues: [details]
**Pending Steps:** 4 (Synthesis), 5 (Evidence Gate), 6 (Report), 7 (Cleanup)
```

When SM compaction fires next, this section is included in the `summaryContent` passed to the post-compact message. The new session starts with this context.

**`setLastSummarizedMessageId` manipulation:** WorkRail could also call this (if it has in-process access) to control which messages get summarized. But since WorkRail is MCP-server-side (not in-process with Claude Code), the file-write path is the practical approach.

**The `waitForSessionMemoryExtraction()` contract:** SM compaction calls this before reading session memory. A 1-minute staleness check prevents waiting for a stuck extraction. WorkRail doesn't need to replicate this -- it just needs to write before compaction fires.

---

## 5. `sessionRunner.ts` -- Programmatic Session Initiation

### What It Is

`src/bridge/sessionRunner.ts` is the bridge layer between the Claude Code server (web/desktop) and a spawned child Claude CLI process. It is **not** a standalone session runner for the WorkRail daemon -- it's specific to how Claude.ai's web frontend orchestrates a local Claude Code subprocess.

### Architecture

`createSessionSpawner(deps)` returns a `SessionSpawner` with a `spawn(opts, dir)` method. The spawner:
1. Spawns a child `claude` process with flags:
   - `--print` (non-interactive)
   - `--sdk-url <url>` (connect to session ingress)
   - `--session-id <id>`
   - `--input-format stream-json`
   - `--output-format stream-json`
   - `--replay-user-messages`
2. Passes an auth token via env: `CLAUDE_CODE_SESSION_ACCESS_TOKEN`
3. Streams NDJSON from child stdout, parsing tool calls and results
4. Detects `control_request` messages for permission delegation back to the server

### `SessionSpawnOpts` fields
```typescript
type SessionSpawnOpts = {
  sessionId: string
  sdkUrl: string
  accessToken: string
  useCcrV2?: boolean
  workerEpoch?: number
  onFirstUserMessage?: (text: string) => void
}
```

### `SessionHandle` interface
```typescript
type SessionHandle = {
  sessionId: string
  done: Promise<SessionDoneStatus>  // 'completed' | 'interrupted' | 'failed'
  activities: SessionActivity[]     // Ring buffer of last 10 activities
  accessToken: string
  lastStderr: string[]              // Ring buffer of last 10 stderr lines
  currentActivity: SessionActivity | null
  kill(): void                      // SIGTERM
  forceKill(): void                 // SIGKILL
  writeStdin(data: string): void    // Send control messages to child
  updateAccessToken(token: string): void  // Refresh auth token mid-session
}
```

### `SessionActivity` types
- `{ type: 'tool_start', summary: string, timestamp: number }` -- e.g., "Reading src/foo.ts"
- `{ type: 'text', summary: string, timestamp: number }` -- assistant text (first 80 chars)
- `{ type: 'result', summary: string, timestamp: number }` -- session completed
- `{ type: 'error', summary: string, timestamp: number }` -- session failed

### WorkRail Relevance

The sessionRunner pattern confirms the subprocess model: Claude CLI is spawned with `--print --session-id --input-format stream-json --output-format stream-json`. The child process streams NDJSON lines. WorkRail's daemon does not need to replicate this bridge -- WorkRail calls the Anthropic API directly via pi-mono's `Agent` class. The sessionRunner is Claude.ai's web server talking to a local Claude CLI, not a programmatic API client.

**What WorkRail takes from this:**
1. `SessionActivity` as a reference design for WorkRail's live console activity feed
2. `done: Promise<SessionDoneStatus>` as a reference for WorkRail's daemon session lifecycle
3. The ring-buffer pattern (max 10 activities, max 10 stderr lines) for the console live view
4. `updateAccessToken()` pattern -- for future token refresh in long-running daemon sessions

---

## 6. Synthesis -- Integration Points for WorkRail Auto

### The Four Integration Points

| Integration Point | Mechanism | When It Fires | WorkRail Use |
|---|---|---|---|
| **PreCompact hook** | Shell command in `settings.json:hooks.PreCompact` | Before Tier 2 (legacy/reactive) compaction | Inject step notes as additional compaction instructions |
| **Session memory file** | Direct file write to `getSessionMemoryPath()` | Checked at Tier 1 SM compaction | Write WorkRail step notes as a section; survives all compaction tiers |
| **PreToolUse hook** | Shell command matching `mcp__workrail__*` | Before WorkRail MCP tool calls | Evidence gate -- block `continue_workflow` if required evidence not collected |
| **PostToolUse hook** | Shell command matching `Bash|Write|Edit` | After code-modifying tool calls | Evidence collection -- record what tools were actually called |

### Context Survival Strategy (Revised)

The backlog assumed WorkRail uses PreCompact hooks for context survival. After reading the source:

**Better approach: dual-channel injection**

1. **Write to session memory file** (primary) -- survives Tier 1 SM compaction and is included as the summary. WorkRail writes a structured section to the session memory file whenever a step note is saved. This doesn't require any hook.

2. **PreCompact hook** (backup) -- fires for Tier 2 compaction only. Hook outputs step notes as custom instructions for the LLM summarizer. The LLM includes WorkRail's notes in the generated summary.

3. **WorkRail session store** (ground truth) -- always. The session store is the canonical record regardless of what happens to Claude's context. This is the mechanism for recovery after complete context loss.

The file-write approach is simpler and more reliable than the hook approach for Tier 1 compaction. Both should be used.

### Evidence Collection (Revised)

From reading the PostToolUse hook contract:

**MVP approach (assertion gate):** WorkRail's `requiredEvidence` field declares what the agent must do. The agent asserts in its notes that it did it. The engine checks the assertion. This requires zero hooks.

**Full approach (observed evidence via hooks):** A PostToolUse hook fires after every `Bash`, `Write`, `Edit` call. The hook logs the tool call to WorkRail's evidence log. The PreToolUse hook for `continue_workflow` checks the evidence log before allowing the advance. If required evidence is not present, `permissionDecision: "deny"` blocks the advance.

**PostToolUse hook output for evidence collection:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "WorkRail: Recorded Bash tool call as evidence."
  }
}
```

The `additionalContext` is injected as a system message -- Claude sees it. This means WorkRail's evidence collection is visible to the agent, which is the correct behavior (the agent should know what evidence has been collected).

### PreToolUse Hook for Evidence Gate

For gating `continue_workflow`:
```json
// settings.json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "mcp__workrail__continue_workflow",
      "hooks": [{
        "type": "command",
        "command": "~/.workrail/hooks/evidence-gate.sh"
      }]
    }]
  }
}
```

The hook script checks WorkRail's evidence log (a JSON file written by the PostToolUse hook) and blocks the `continue_workflow` call if required evidence is missing.

### Daemon Session Initiation (Confirmed Pattern)

WorkRail's daemon does NOT use `sessionRunner.ts`. That's for the Claude.ai web server. WorkRail calls the Anthropic API directly via pi-mono's `Agent` class. The daemon:
1. Creates an `Agent` instance with WorkRail's MCP tools as `AgentTool<>` definitions
2. Calls `agentLoop(prompts, context, config)` -- the loop handles multi-turn conversation
3. `getFollowUpMessages` returns `[]` when `continue_workflow` returns `isComplete: true`
4. WorkRail's MCP tools (`start_workflow`, `continue_workflow`) are called by the Agent as tool uses
5. The daemon calls these tool handlers directly (same-process) without HTTP overhead

The `SessionActivity` ring buffer pattern from sessionRunner.ts informs the console live view -- WorkRail's daemon should maintain a similar ring buffer of recent tool calls for display in the console.

---

## 7. Open Questions and Design Decisions

1. **Session memory file path resolution:** `getSessionMemoryPath()` in Claude Code uses the Claude-side session ID. WorkRail's daemon creates a new Claude API session each time (via pi-mono). How does WorkRail know which session memory file path corresponds to the active Claude session? Answer: In autonomous mode, WorkRail controls the session (it's calling the API directly). The session memory path is determined by Claude Code's session ID -- but WorkRail's daemon doesn't use Claude Code, it uses the Anthropic API directly via pi-mono. Session memory is a Claude Code feature, not an Anthropic API feature. WorkRail's daemon doesn't have access to Claude Code's session memory system.

   **Revised understanding:** The session memory injection approach only applies when WorkRail runs as an MCP server alongside Claude Code (human-driven sessions). For autonomous daemon sessions, WorkRail injects context through the **system prompt** at session initialization time, not through Claude Code's session memory file.

2. **Hook registration for daemon mode:** Hooks are registered in `settings.json`. For daemon mode, WorkRail controls the entire Claude process setup. WorkRail can pass a custom `settings.json` path or inject hooks programmatically. For human-driven sessions, hooks are registered once via `setup-hooks.sh`.

3. **Coordinator mode for WorkRail:** Should WorkRail's daemon run Claude in coordinator mode? Answer from the source: Only beneficial if WorkRail wants parallel worker agents managed by a coordinator. For simple sequential workflows, coordinator mode adds complexity. Use it only for workflows that explicitly declare parallel steps.

---

## Decision Log

- **Path:** `landscape_first` -- correct choice. Pure research task, no design problem to frame.
- **Web search:** Not available in this environment. All research done via `gh api` to read the source directly.
- **Subagent delegation:** Not used -- reading ~10 files is not a parallelization opportunity worth the overhead. Main agent read everything directly.
- **Session memory file injection for daemon:** Rejected. The session memory file is a Claude Code internal file; the daemon calls the Anthropic API directly and doesn't have access to it. Correct approach for daemon: inject context via system prompt.
- **PreCompact hook for context survival:** Valid only for human-driven MCP sessions where Claude Code is the runtime. For daemon mode, no hooks are needed -- the daemon controls the system prompt.

---

## Final Summary

The Claude Code source reveals five concrete integration points for WorkRail Auto:

1. **Session memory file (human-driven sessions only):** Write step notes to `getSessionMemoryPath()` to survive Tier 1 SM compaction. This is cheap and doesn't require hooks.

2. **PreCompact hook:** Register in `settings.json:hooks.PreCompact`, matcher `"*"`. The hook outputs step notes as custom instructions. The compaction LLM incorporates them into the summary. This covers Tier 2 compaction (when Tier 1 is unavailable or disabled).

3. **PostToolUse hook for evidence collection:** Register with matcher `"Bash|Write|Edit"`. The hook logs each tool call to WorkRail's evidence file. The `additionalContext` output field injects confirmation back to the agent.

4. **PreToolUse hook for evidence gate:** Register with matcher `"mcp__workrail__continue_workflow"`. The hook checks the evidence file and blocks the advance if required evidence is missing. Uses `permissionDecision: "deny"` in the JSON output.

5. **Daemon system prompt injection (autonomous sessions):** WorkRail's daemon injects step notes and session state into the system prompt when initializing a fresh pi-mono `Agent` session. No hooks needed -- the daemon controls the API call.

The coordinator/subagent model confirms WorkRail's design: coordinator holds state, workers run sub-tasks. The result communication mechanism (XML task-notification messages) is a reference, but WorkRail's own session store is more durable and doesn't require in-context communication between coordinator and workers.

The `sessionRunner.ts` is a bridge for the Claude.ai web UI, not a programmatic API client -- WorkRail's daemon builds its own LLM call layer via pi-mono instead.

---

## 8. Final Recommendation

### Selected Direction: Candidate A (Human-Driven Sessions) + Candidate C (Daemon Mode)

These are complementary, not alternatives. Both must be implemented.

**Candidate A -- 4 hooks for human-driven Claude Code + WorkRail MCP sessions:**

| Hook | File | Matcher | Purpose |
|------|------|---------|---------|
| PreCompact | `~/.workrail/hooks/pre-compact.sh` | `*` | Outputs current step notes as custom compaction instructions. LLM incorporates into summary. |
| PostToolUse | `~/.workrail/hooks/post-tool-use.sh` | `Bash\|Write\|Edit\|FileWriteTool\|FileEditTool` | Appends tool call to evidence log `~/.workrail/evidence/{session_id}-{agent_id}.ndjson` |
| PreToolUse | `~/.workrail/hooks/pre-tool-use.sh` | `mcp__workrail__continue_workflow` | Checks evidence log against requiredEvidence. Deny if log exists and evidence absent. Fail-open if log missing. |
| PostCompact (optional) | `~/.workrail/hooks/post-compact.sh` | `*` | Detects SM compaction bypass (WorkRail notes absent from compact_summary). Injects recovery prompt. |

**Candidate C -- daemon mode (WorkRail daemon + Anthropic API via pi-mono):**
- Before each `agentLoop()` call: prepend `<workrail_session_state>` XML block to system prompt with last 3 step note summaries (~200 tokens each), current step title, and next step titles.
- Before each `executeContinueWorkflow()` call: in-process evidence check against `tool_call_observed` events in session store (current step scope only).

**Candidate B (deferred):** Write WorkRail state section to Claude Code session memory file. Activate when SM compaction becomes default for >50% of users.

### Confidence Band: HIGH

All integration points confirmed by actual source code. One empirical test required before shipping: verify PreToolUse hook fires for `mcp__workrail__continue_workflow`. If it doesn't, fallback: move evidence check server-side to `executeContinueWorkflow` handler.

### Residual Risks (3)

1. **PreToolUse hook on MCP tools unverified** -- empirical test required. Fallback documented.
2. **SM compaction bypass** -- silent degradation when Tier 1 fires. Optional PostCompact hook for detection. Full fix via Candidate B when SM compaction is default.
3. **Unified evidence store deferred to v2** -- separate NDJSON file per session/agent is MVP. v2: WorkRail CLI writes to session store directly.

### Implementation Checklist (in priority order)

1. `scripts/setup-hooks.sh` -- update to register 4 hook scripts (merging into existing settings.json, not overwriting)
2. `~/.workrail/hooks/pre-compact.sh` -- reads WorkRail session store via CLI, outputs step notes
3. `~/.workrail/hooks/post-tool-use.sh` -- appends to `{session_id}-{agent_id}.ndjson` evidence log
4. `~/.workrail/hooks/pre-tool-use.sh` -- reads evidence log, checks required evidence, deny or allow
5. **Empirical test**: verify PreToolUse hook fires for MCP tool `mcp__workrail__continue_workflow`
6. `src/daemon/runWorkflow.ts` -- system prompt injection (WorkRail state XML block)
7. In-process evidence gate before `executeContinueWorkflow()`
8. `~/.workrail/hooks/post-compact.sh` (optional) -- SM compaction bypass detection
