# Claude Code Source Deep Dive: WorkRail Auto Integration Patterns

**Discovery path:** `landscape_first`
**Date:** 2026-04-14
**Source:** `https://github.com/Archie818/Claude-Code` (leaked Claude Code source)
**Files read:** `compact.ts`, `sessionMemoryCompact.ts`, `sessionMemoryUtils.ts`, `sessionMemory.ts`, `prompts.ts`, `hooks.ts`, `types/hooks.ts`, `hooksConfigManager.ts`, `hooksSettings.ts`, `coordinatorMode.ts`, `bridge/sessionRunner.ts`

---

## Context / Ask

Deep dive on the leaked Claude Code source to extract concrete integration patterns for WorkRail Auto:
1. Full compaction system (three tiers) -- what survives each, how `executePreCompactHooks` works
2. Hooks API -- PreToolUse/PostToolUse: how registered, what data received, how they block/modify
3. Session memory -- `sessionMemoryUtils.ts`: what it is, how written/read
4. Coordinator/subagent model -- how Claude Code coordinates between coordinator and workers
5. `sessionRunner.ts` -- programmatic session initiation pattern for WorkRail Auto's daemon

---

## Path Recommendation

**`landscape_first`** -- the source is concrete and readable. The dominant need is understanding the existing system deeply before designing WorkRail's integration. No reframing needed; the problem is well-understood.

---

## Landscape Packet

### 1. Compaction System: Three Tiers

`src/commands/compact/compact.ts` + `src/services/compact/sessionMemoryCompact.ts` + `src/services/compact/microCompact.ts`

Claude Code has three distinct compaction mechanisms, applied in strict priority order:

#### Tier 1: Session Memory Compaction (preferred, no custom instructions)

```
trySessionMemoryCompaction(messages, agentId)
```

- **What it is:** Replaces the full conversation with a structured summary derived from a durable markdown file (`~/.claude/projects/<project>/session-memory.md`).
- **How it works:**
  1. Checks feature gates: `tengu_session_memory` AND `tengu_sm_compact` must both be true. Override: `ENABLE_CLAUDE_CODE_SM_COMPACT=1`.
  2. Waits for any in-progress memory extraction (15s timeout).
  3. Reads `lastSummarizedMessageId` -- the message UUID up to which session memory is current.
  4. Calls `calculateMessagesToKeepIndex()` -- determines which recent messages to preserve verbatim (starting from lastSummarizedIndex + 1, expanding backwards to meet minimums):
     - `minTokens: 10_000` (configurable via GrowthBook `tengu_sm_compact_config`)
     - `minTextBlockMessages: 5`
     - `maxTokens: 40_000` (hard cap)
  5. Builds `CompactionResult`: boundary marker + summary message (the session memory content formatted as a user message) + messages to keep.
  6. The summary message includes the full session memory content truncated to `MAX_TOTAL_SESSION_MEMORY_TOKENS = 12_000` tokens.
- **What survives:** The structured session memory doc + the last N messages (10k-40k tokens). Old conversation history is replaced by the memory doc.
- **Key invariant:** `adjustIndexToPreserveAPIInvariants()` ensures tool_use/tool_result pairs are never split. Thinking blocks sharing a `message.id` stay together.
- **If session memory is empty or gate is off:** Returns `null`, falls through to Tier 2.

#### Tier 2: Traditional Full Compaction (with optional Reactive path)

```
compactConversation(messages, context, cacheSafeParams, ..., customInstructions)
```

- **What it is:** Calls the Claude API to summarize the entire conversation into a single compact summary message.
- **Pre-step -- microcompaction:**
  ```
  microcompactMessages(messages, context)
  ```
  Strips tool results, large blobs, etc. to reduce tokens before the summarization API call.
- **Also runs `executePreCompactHooks` in the reactive path** (see Tier 2b below).
- **What survives:** A single LLM-generated summary message replaces all history. `setLastSummarizedMessageId(undefined)` is called -- resets the session memory boundary.
- **Reactive path (feature-gated):** `REACTIVE_COMPACT` feature -- runs pre-compact hooks concurrently with cache param building for performance.

#### Tier 3: Microcompact (emergency, standalone)

```
microcompactMessages(messages, context)
```

- Used as a pre-pass before Tier 2, and also usable standalone.
- Strips tool result content (keeps the tool call structure but removes large payloads), strips binary content, removes redundant whitespace.
- Token-based heuristics; does not call the Claude API.

#### The `executePreCompactHooks` Integration Point

```typescript
// src/utils/hooks.ts:3961
export async function executePreCompactHooks(
  compactData: { trigger: 'manual' | 'auto'; customInstructions: string | null },
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{ newCustomInstructions?: string; userDisplayMessage?: string }>
```

- Called in the **Tier 2 reactive path** (`compactViaReactive`), **concurrently** with `getCacheSharingParams`.
- Input: trigger type (`manual` | `auto`) + custom instructions.
- Hook scripts receive a JSON `PreCompactHookInput` on stdin.
- Hook return values:
  - `stdout` with content → appended as **custom compaction instructions** (injected into the summarization prompt)
  - Exit code 2 → **blocks compaction entirely**
  - Other exit codes → stderr shown to user, compaction continues
- The hook outputs are merged with any user-provided custom instructions via `mergeHookInstructions()`.
- **NOT called in the Tier 1 (session memory) path** -- session memory compaction runs hooks via `processSessionStartHooks('compact')` instead.

**WorkRail Auto integration point:** A `PreCompact` hook script can inject WorkRail's current step state as custom instructions into the summarization prompt. This ensures the LLM-generated summary explicitly mentions the current workflow state.

---

### 2. Hooks API: PreToolUse/PostToolUse

#### Registration Format

Hooks are stored in Claude settings files (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "~/.workrail/hooks/pre-tool-use.sh" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "~/.workrail/hooks/post-tool-use.sh" }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [
          { "type": "command", "command": "~/.workrail/hooks/pre-compact.sh" }
        ]
      }
    ]
  }
}
```

- **`matcher`** matches against `tool_name` for PreToolUse/PostToolUse, `trigger` for PreCompact.
- `"*"` or empty matcher = match all tools.
- Hook types: `command` (shell script), `prompt` (sends to model), `agent` (runs subagent), `http` (HTTP endpoint).

#### PreToolUse Hook Data

The hook script receives on stdin:

```json
{
  "session_id": "sess_abc123",
  "tool_name": "Bash",
  "tool_input": { "command": "git commit -m 'fix: something'" },
  "tool_use_id": "toolu_01abc",
  "hook_event_name": "PreToolUse"
}
```

#### PreToolUse Hook Response Protocol

The hook script outputs JSON:

```json
{
  "continue": true,
  "decision": "approve" | "block",
  "reason": "Why this decision was made",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "string",
    "updatedInput": { "command": "git commit --no-verify -m 'fix: something'" },
    "additionalContext": "Extra context injected into Claude's next turn"
  }
}
```

Key capabilities:

| Capability | How |
|---|---|
| **Block tool call** | `"decision": "block"` or `"hookSpecificOutput.permissionDecision": "deny"` |
| **Approve tool call** | `"decision": "approve"` or `"hookSpecificOutput.permissionDecision": "allow"` |
| **Modify tool input** | `"hookSpecificOutput.updatedInput": { ... }` -- replaces the tool input |
| **Inject context** | `"hookSpecificOutput.additionalContext": "string"` -- added to Claude's next message |
| **Stop conversation** | `"continue": false` + `"stopReason": "message"` |
| **Silent approve** | `exit 0`, empty stdout -- proceed without UI noise |

Exit code semantics (exit code overrides JSON when non-zero):
- `exit 0` -- proceed (stdout visible in transcript mode only)
- `exit 2` -- **blocking error**: stderr shown to model, tool call blocked
- Other non-zero -- stderr shown to user, tool proceeds

#### PostToolUse Hook Data

```json
{
  "session_id": "sess_abc123",
  "tool_name": "Write",
  "tool_input": { "file_path": "/src/foo.ts", "content": "..." },
  "tool_response": { "success": true, "output": "..." },
  "tool_use_id": "toolu_01abc",
  "hook_event_name": "PostToolUse"
}
```

PostToolUse response can inject `additionalContext` or update MCP tool output (`updatedMCPToolOutput`). Cannot block the tool (already ran).

#### PreCompact Hook Data

```json
{
  "session_id": "sess_abc123",
  "hook_event_name": "PreCompact",
  "trigger": "auto" | "manual",
  "custom_instructions": null
}
```

---

### 3. Session Memory: The Durable Store

#### Architecture

Session memory is a **markdown file** at `~/.claude/projects/<sha256-of-cwd>/session-memory.md` that is maintained by a background forked subagent running after each assistant turn.

```typescript
// src/services/SessionMemory/sessionMemoryUtils.ts
// Trigger thresholds:
DEFAULT_SESSION_MEMORY_CONFIG = {
  minimumMessageTokensToInit: 10000,  // First extraction
  minimumTokensBetweenUpdate: 5000,   // Subsequent extractions
  toolCallsBetweenUpdates: 3,         // Minimum tool calls between extractions
}
```

Extraction logic (`shouldExtractMemory()`):
- Must have `>= 10k` context tokens before first extraction.
- Subsequent extractions: `>= 5k` token growth AND `>= 3` tool calls since last extraction.
- OR: token threshold met AND last assistant turn has no tool calls (natural break point).
- `sequential()` wrapper -- only one extraction runs at a time.

#### The Session Memory File Template

```markdown
# Session Title
# Current State
# Task specification
# Files and Functions
# Workflow
# Errors & Corrections
# Codebase and System Documentation
# Learnings
# Key results
# Worklog
```

Custom templates are supported at `~/.claude/session-memory/config/template.md`.

#### Extraction Process

When threshold is met, a **forked subagent** (`runForkedAgent`) is launched with:
1. The full current conversation as context.
2. A prompt instructing it to edit the session memory file using the `Edit` tool.
3. The subagent calls `Edit` tool to update each section with info from the conversation.

The forked agent only has access to `Edit` on the memory file (`createMemoryFileCanUseTool(memoryPath)`).

#### The `lastSummarizedMessageId` Pointer

- Tracks which message was the most recent at the time of the last extraction.
- Used by Tier 1 compaction to determine the boundary: session memory is "current through this message."
- Messages after this ID are kept verbatim in the post-compaction result.
- Set to `undefined` after traditional (Tier 2) compaction -- the pointer is meaningless after a full summarization.

#### The `waitForSessionMemoryExtraction()` Barrier

- Before Tier 1 compaction runs, it waits up to 15 seconds for any in-progress extraction to finish.
- Uses a module-level `extractionStartedAt` timestamp.
- Extraction older than 60 seconds is considered stale and ignored.

---

### 4. Coordinator/Subagent Model

`src/coordinator/coordinatorMode.ts`

#### Mode Activation

```typescript
// Enabled via env var
process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'

function isCoordinatorMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
}
```

#### Coordinator Tools

In coordinator mode, the coordinator has access to:
- **`AgentTool`** -- spawn a new worker (full async subagent)
- **`SendMessageTool`** -- continue an existing worker by agent ID
- **`TaskStopTool`** -- kill a running worker

Workers do NOT have `AgentTool`, `SendMessageTool`, `TeamCreateTool`, `TeamDeleteTool`, `SendMessageTool`, `SyntheticOutputTool` -- only standard tools.

#### Worker Communication Protocol

Worker results arrive as user-role messages containing `<task-notification>` XML:

```xml
<task-notification>
<task-id>agent-a1b2c3</task-id>
<status>completed|failed|killed</status>
<summary>Agent "investigate auth bug" completed</summary>
<result>Found null pointer in src/auth/validate.ts:42...</result>
<usage>
  <total_tokens>45000</total_tokens>
  <tool_uses>23</tool_uses>
  <duration_ms>45000</duration_ms>
</usage>
</task-notification>
```

The coordinator NEVER acknowledges workers directly -- it only addresses the user. Worker results are internal signals.

#### Scratchpad Directory

When `tengu_scratch` gate is enabled, workers get a shared scratchpad directory for durable cross-worker knowledge:
```
Content: `Scratchpad directory: /tmp/scratch/sess_abc/`
Workers can read and write here without permission prompts.
```

#### Session Mode Resume

When resuming a session, `matchSessionMode()` detects whether the previous session was coordinator mode and flips `CLAUDE_CODE_COORDINATOR_MODE` accordingly. This means coordinator mode is durable across session resume.

---

### 5. sessionRunner.ts: Programmatic Session Initiation

`src/bridge/sessionRunner.ts`

#### Architecture

`sessionRunner.ts` implements a `SessionSpawner` that spawns child Claude Code CLI processes and communicates via NDJSON over stdin/stdout. This is the bridge between the server-side SDK and the CLI-based agent.

#### Key Interface

```typescript
type SessionSpawnOpts = {
  sessionId: string
  sdkUrl: string      // Session Ingress URL
  accessToken: string
  useCcrV2?: boolean
  workerEpoch?: number
  onFirstUserMessage?: (text: string) => void
}

type SessionHandle = {
  sessionId: string
  done: Promise<SessionDoneStatus>  // 'completed' | 'interrupted' | 'failed'
  activities: SessionActivity[]
  currentActivity: SessionActivity | null
  kill(): void
  forceKill(): void
  writeStdin(data: string): void
  updateAccessToken(token: string): void
}
```

#### Spawn Arguments

The child process is spawned with:

```
claude --print --sdk-url <URL> --session-id <ID> 
       --input-format stream-json 
       --output-format stream-json
       --replay-user-messages
       [--verbose] [--debug-file <path>] [--permission-mode <mode>]
```

Environment:
- `CLAUDE_CODE_SESSION_ACCESS_TOKEN` -- per-session auth token
- `CLAUDE_CODE_ENVIRONMENT_KIND=bridge` -- signals bridge mode
- `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2=1` -- transport flag
- `CLAUDE_CODE_FORCE_SANDBOX=1` -- sandbox mode (optional)

#### NDJSON Activity Detection

The runner parses stdout NDJSON line by line:
- `type: 'assistant'` with `content: [{type: 'tool_use', ...}]` → `tool_start` activity
- `type: 'assistant'` with `content: [{type: 'text', ...}]` → `text` activity
- `type: 'result'`, `subtype: 'success'` → session completed
- `type: 'control_request'`, `request.subtype: 'can_use_tool'` → forwarded to server for permission approval
- `type: 'user'` (not synthetic, not replay) → `onFirstUserMessage` callback

#### Token Refresh

Access tokens can be rotated mid-session:
```typescript
handle.updateAccessToken(newToken)
// Sends via stdin:
// { "type": "update_environment_variables", "variables": { "CLAUDE_CODE_SESSION_ACCESS_TOKEN": newToken } }
```

---

## Problem Frame Packet

**WorkRail Auto needs to:**

1. **Survive compaction** -- WorkRail session state must persist through context window resets.
2. **Observe tool calls** -- Record what the agent actually did (not just what it claimed) for evidence collection.
3. **Gate tool execution** -- Block or modify tool calls based on workflow state (e.g., require `record_evidence` before proceeding).
4. **Inject state into summaries** -- Ensure compaction summaries mention the current workflow step and continue token.
5. **Spawn sessions programmatically** -- WorkRail daemon needs to initiate Claude Code sessions without a human in the loop.

**Primary tensions:**

- WorkRail doesn't want to be coupled to Claude Code internals -- but the integration points (hooks, session memory) are the stable public surface.
- Hook scripts are shell-based by default, but `http` type hooks exist -- WorkRail daemon can receive hook events over HTTP without shell scripting.

**Assumptions to validate:**

- Session memory template can be customized (verified -- `~/.claude/session-memory/config/template.md`)
- PreCompact hooks fire for auto-compact (verified -- `trigger: 'auto'` matcher supported)
- Hooks can inject context into Claude's next turn (verified -- `additionalContext` field)
- HTTP hooks exist (verified -- `type: 'http'` in HookCommand)

---

## Candidate Integration Patterns

### Pattern A: PreCompact Hook (State Injection)

**Goal:** Ensure WorkRail's continue token and current step survive compaction.

**Implementation:**
```bash
# ~/.workrail/hooks/pre-compact.sh
# Registered in .claude/settings.json under PreCompact[trigger=auto]
SESSION_DATA=$(workrail daemon-state read)
echo "WORKRAIL_STATE: $SESSION_DATA"
```

The hook outputs WorkRail state as custom instructions. These become part of the compaction prompt, so the summary explicitly mentions the current step + token.

**Limits:** Only fires in Tier 2 (traditional compaction). Tier 1 (session memory compaction) uses `processSessionStartHooks('compact')` instead -- a SessionStart hook with `source=compact` fires instead. Both paths need coverage.

**Alternative:** Write WorkRail state directly into the session memory file as a new section (`# WorkRail State`) so it's part of the Tier 1 summary automatically. The `postSamplingHook` pattern allows this.

### Pattern B: Session Memory Section Injection

**Goal:** Persist WorkRail step notes across all three compaction tiers via the session memory file.

**Implementation:**
1. Add a `# WorkRail Workflow` section to the session memory template:
   ```
   ~/.claude/session-memory/config/template.md
   ```
   ```markdown
   # WorkRail Workflow
   _Current workflow ID, step ID, continue token, and step notes for recovery after context reset_
   ```
2. After each `continue_workflow` call, WorkRail daemon writes the current step state to the session memory file directly (not waiting for the extraction agent).
3. On the next auto-extraction, the extraction agent sees the WorkRail section and preserves it.

**Why this is the right tier:** Session memory survives ALL three compaction tiers (Tier 1 is literally built on it; Tier 2 summarization receives session memory content as input). This is the most durable integration point.

**Concrete write:** WorkRail daemon uses the session memory path (`~/.claude/projects/<hash>/session-memory.md`) and writes directly to the `# WorkRail Workflow` section.

### Pattern C: PreToolUse Hook (Evidence Collection)

**Goal:** Observe every tool call and record evidence for WorkRail's `requiredEvidence` gate.

**Implementation:**
```bash
# ~/.workrail/hooks/pre-tool-use.sh
# Matcher: * (all tools)
INPUT=$(cat)  # JSON on stdin
TOOL=$(echo "$INPUT" | jq -r '.tool_name')
SESSION=$(echo "$INPUT" | jq -r '.session_id')

# Record the evidence
workrail record-evidence --session "$SESSION" --tool "$TOOL" --input "$INPUT"

# Exit 0 = silent approve
exit 0
```

Or using HTTP hook type (more daemon-friendly):
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "http", "url": "http://localhost:3100/hooks/pre-tool-use" }
        ]
      }
    ]
  }
}
```

WorkRail daemon's HTTP server receives the hook, records the tool call as evidence, and returns `{"continue": true}` (or `{"decision": "block", "reason": "..."}` to gate).

**For WorkRail's `requiredEvidence` gate:** The PreToolUse hook running before `continue_workflow` can verify that required tool calls happened. Or inverted: PostToolUse hook records each tool call → WorkRail's evidence store → `continue_workflow` checks evidence store before advancing.

### Pattern D: sessionRunner Pattern (Daemon Session Initiation)

**Goal:** WorkRail daemon spawns and manages Claude Code sessions programmatically.

**What sessionRunner actually does:** It spawns a Claude Code CLI subprocess in bridge mode, communicating via NDJSON on stdin/stdout. This is the **pro.anthropic.com** cloud bridge pattern -- it requires a session access token from Anthropic's backend.

**What WorkRail Auto actually needs:** Direct Anthropic API calls (not the Claude Code CLI subprocess). The right reference is **pi-mono's `Agent` class** -- `@mariozechner/pi-agent-core` -- which calls the Anthropic API directly without spawning a subprocess.

**The sessionRunner pattern still teaches us:**
- Activity events (`tool_start`, `text`, `result`, `error`) are the right abstraction for live session monitoring.
- Token rotation via stdin is the right pattern for long-running daemon sessions.
- NDJSON over stdin/stdout is more reliable than HTTP for subprocess communication.
- `SessionDoneStatus = 'completed' | 'interrupted' | 'failed'` is the right terminal state model.

**WorkRail daemon equivalent:**
```typescript
// WorkRail's daemon session (using pi-mono, not sessionRunner)
type DaemonSessionHandle = {
  sessionId: string;
  workflowRunId: string;
  done: Promise<'completed' | 'interrupted' | 'failed'>;
  abort(): void;
  activities: ActivityEvent[];
}
```

---

## Challenge Notes

### Challenge: PreCompact vs. PostSampling Hooks for State Injection

PreCompact hooks only fire in Tier 2. Session memory compaction (Tier 1) skips them. WorkRail state written only via PreCompact is lost when Tier 1 runs.

**Resolution:** Inject WorkRail state via TWO mechanisms:
1. Write directly to the `# WorkRail Workflow` section of session memory after each step (ensures Tier 1 has it).
2. Register a PreCompact hook that re-states the current continue token as custom instructions (belt-and-suspenders for Tier 2).

WorkRail's own durable session store is the ground truth regardless -- but injecting into both channels maximizes the chance of context survival.

### Challenge: HTTP Hooks vs. Shell Hooks

HTTP hooks don't get stdin data the same way shell hooks do -- they receive an HTTP POST with the hook input as a JSON body. WorkRail daemon needs to run an HTTP server to receive these. Shell hooks are simpler but require a shell script that calls WorkRail's CLI.

**Resolution for MVP:** Shell script that calls `workrail record-evidence --json "$(cat)"`. The daemon listens on a Unix socket. Post-MVP: HTTP hook type, WorkRail daemon runs a small HTTP server.

### Challenge: Feature Gates Block Session Memory

`tengu_session_memory` and `tengu_sm_compact` GrowthBook gates must be enabled. External users have no control over these.

**Env var override exists:** `ENABLE_CLAUDE_CODE_SM_COMPACT=1` bypasses the gates.

**Resolution:** WorkRail daemon sets `ENABLE_CLAUDE_CODE_SM_COMPACT=1` when spawning sessions. In the long run, write WorkRail state directly to the session memory file -- this works regardless of whether SM compaction is enabled.

---

## Decision Log

### Selected Direction: Session Memory File as Primary Durability Layer

**Why it won:**
- Session memory survives ALL three compaction tiers (it's the source for Tier 1, input to Tier 2 summarization, unaffected by Tier 3).
- Direct file writes don't depend on hooks firing or feature gates.
- The template is user-customizable.
- Writing to a local file is trivially simple for the daemon.

**Strongest alternative: PreCompact hook injection**
- Why it lost: Only covers Tier 2 compaction. Requires hook registration setup. Feature-gate dependency.
- When it wins: Belt-and-suspenders complement to session memory writing.

**Accepted tradeoffs:**
- Direct session memory writes could conflict with the extraction subagent (last-write-wins). Mitigation: use section-append pattern; don't overwrite other sections.
- Session memory path is per-session (hash of cwd). WorkRail daemon must know the correct path for each Claude Code session it manages.

### HTTP Hooks for Evidence Collection

**Selected:** PostToolUse HTTP hook → WorkRail daemon HTTP server.

**Why:** Zero subprocess overhead, clean JSON, easy to observe/debug. The daemon already needs to run a server for the REST control plane.

**Implementation sketch:**
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "http", "url": "http://localhost:3456/hooks/post-tool-use" }]
      }
    ]
  }
}
```

WorkRail daemon handler:
```typescript
app.post('/hooks/post-tool-use', (req, res) => {
  const { tool_name, tool_input, tool_response, session_id } = req.body;
  evidenceStore.record(session_id, { tool_name, tool_input, tool_response });
  res.json({ continue: true });
});
```

---

## Final Summary

### Compaction System

Three tiers, strict priority:

1. **Tier 1 (Session Memory Compaction)** -- replaces conversation with session memory markdown + recent messages (10k-40k tokens kept). Gates: `tengu_session_memory` AND `tengu_sm_compact` (override: `ENABLE_CLAUDE_CODE_SM_COMPACT=1`). Does NOT run PreCompact hooks.
2. **Tier 2 (Traditional Compaction)** -- API call summarizes full history. Runs PreCompact hooks (reactive path only). Runs microcompact as pre-pass.
3. **Tier 3 (Microcompact)** -- strips tool results, large blobs. Pre-pass for Tier 2.

WorkRail state should be injected at Tier 1 (write to session memory file) not Tier 2 (PreCompact hook) for maximum durability.

### Hooks API

- Registered in `settings.json` under `hooks.{EventName}[{matcher, hooks:[]}]`.
- PreToolUse: receives `{session_id, tool_name, tool_input, tool_use_id}`. Can block (`decision: "block"`), approve, modify input (`updatedInput`), inject context (`additionalContext`).
- PostToolUse: receives same + `tool_response`. Can inject context, update MCP output. Cannot block.
- PreCompact: receives `{trigger: 'manual'|'auto', custom_instructions}`. stdout becomes compaction instructions. Exit 2 blocks compaction.
- HTTP hook type (`type: "http"`) sends JSON POST to WorkRail daemon's HTTP server. Clean integration path.
- Shell hook type (`type: "command"`) sends JSON on stdin. Must exit 0/2/other for semantic behavior.

### Session Memory

- Markdown file: `~/.claude/projects/<sha256-cwd>/session-memory.md`.
- Template: 10 sections (Session Title, Current State, Task Spec, Files, Workflow, Errors, Docs, Learnings, Key Results, Worklog).
- Updated by background forked subagent after each turn (when thresholds met: `>=10k` context tokens to init, `>=5k` token growth + `>=3` tool calls between updates).
- `lastSummarizedMessageId` tracks the compaction boundary.
- `waitForSessionMemoryExtraction()` ensures compaction waits for in-flight extraction (15s timeout).
- Custom template: `~/.claude/session-memory/config/template.md`.

**WorkRail injection:** Write a `# WorkRail Workflow` section directly to the session memory file after each step advance. The extraction agent will preserve it in subsequent updates.

### Coordinator/Subagent Model

- `CLAUDE_CODE_COORDINATOR_MODE=1` env var activates coordinator mode.
- Coordinator has `AgentTool` (spawn), `SendMessageTool` (continue), `TaskStopTool` (kill).
- Workers receive only standard tools (no coordinator tools).
- Worker results arrive as `<task-notification>` XML in user-role messages.
- Optional shared scratchpad dir (gate-dependent) for cross-worker durable state.
- Session mode is durable across resume (stored in session, restored via `matchSessionMode()`).

**WorkRail relevance:** The `AgentTool` dispatch + `<task-notification>` result collection pattern is the right subagent model for WorkRail's coordinator-spawning-subworkflow feature. WorkRail daemon's coordinator session holds the main workflow state; subworkflow sessions each run as workers dispatched via `AgentTool`.

### sessionRunner Pattern

- **What it does:** Spawns Claude Code CLI subprocess (`--print --sdk-url --session-id --input-format stream-json`), reads NDJSON activity events (tool_start, text, result, error, control_request).
- **What WorkRail daemon needs instead:** Direct Anthropic API calls via pi-mono's `Agent` class, NOT CLI subprocess spawning.
- **Key patterns to adopt:**
  - `SessionActivity[]` ring buffer (max 10) for live status display.
  - `SessionDoneStatus: 'completed' | 'interrupted' | 'failed'` terminal state enum.
  - Token rotation mid-session via structured message on stdin.
  - Activity-based event stream as the observable side-channel.

### Concrete WorkRail Auto Build Actions

1. **Session memory integration (highest value, implement now):**
   - Add `# WorkRail Workflow` section to session memory template.
   - Daemon writes current step state to section after each `continue_workflow`.
   - Path resolution: `~/.claude/projects/<sha256(cwd)>/session-memory.md`.

2. **PostToolUse HTTP hook (evidence collection):**
   - Register in `.claude/settings.json`: `PostToolUse` → `http` → `http://localhost:3456/hooks/post-tool-use`.
   - WorkRail daemon handler records evidence per session.
   - `continue_workflow` checks evidence store for `requiredEvidence` gate.

3. **PreCompact belt-and-suspenders:**
   - Register `PreCompact` shell hook that writes current continue token to stdout.
   - If session memory fails, the continue token survives in the Tier 2 summary.

4. **Coordinator mode for subworkflows:**
   - Set `CLAUDE_CODE_COORDINATOR_MODE=1` for coordinator sessions.
   - Subworkflow sessions are spawned as workers via `AgentTool`.
   - Results collected via `<task-notification>` pattern.
   - DO NOT use this for daemon-initiated sessions -- daemon uses pi-mono's `Agent` directly.

### Confidence Band

**High confidence** on the compaction tier architecture, hook registration format, session memory file structure and path, coordinator mode activation, and hook JSON protocol -- all read directly from source.

**Medium confidence** on the end-to-end flow for Tier 1 compaction triggering (feature gates required, tested by env var override) and on the `processSessionStartHooks('compact')` path in Tier 1.

**Gap:** Did not read `src/services/compact/compact.ts` (the service, not the command) in full -- specifically the `buildPostCompactMessages` and `annotateBoundaryWithPreservedSegment` functions. These are internal to the compaction result assembly and likely don't affect WorkRail's integration points.

### Next Actions

1. Implement `# WorkRail Workflow` section in session memory template (1 file edit, no new code).
2. Implement daemon HTTP hook endpoint (`POST /hooks/post-tool-use`) -- 30 lines.
3. Write `setup-hooks.sh` script that configures `.claude/settings.json` with WorkRail hooks.
4. Test with `ENABLE_CLAUDE_CODE_SM_COMPACT=1` env var to force Tier 1 compaction.
5. Validate that the `# WorkRail Workflow` section survives a manual `/compact` command.
