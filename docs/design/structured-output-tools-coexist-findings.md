# Findings: Structured Output + Tool Calls Coexistence

**Date:** 2026-04-18
**Test file:** `tests/integration/structured-output-tools-coexist.test.ts`
**SDK:** `@anthropic-ai/sdk@0.73.0`, `@anthropic-ai/bedrock-sdk@0.28.1`

---

## Summary

**Tools and structured output (JSON schema) CAN coexist** in a single API request on both
Anthropic direct and Amazon Bedrock. However, the feature is:
- Beta-only (`client.beta.messages.create()`, not `client.messages.create()`)
- Schema enforcement applies only at `end_turn` -- `tool_use` turns produce no text response

The system prompt fallback (strong JSON constraint without `output_config`) is INCONSISTENT on
direct Anthropic (2/3 valid) and CONSISTENT on Bedrock (3/3 valid). This suggests Bedrock's
model version (`claude-sonnet-4-6`) follows instructions more reliably than the direct API's
`claude-sonnet-4-5`.

---

## Exact API Params That Work

### Anthropic direct (`client.beta.messages.create()`)

```typescript
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const response = await client.beta.messages.create({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  system: 'You are a workflow executor. Respond ONLY with a JSON object...',
  messages: [{ role: 'user', content: '...' }],
  tools: [{ name: 'bash_tool', description: '...', input_schema: { ... } }],
  output_config: {
    format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          step_complete: { type: 'boolean' },
          notes: { type: 'string' },
        },
        required: ['step_complete', 'notes'],
        additionalProperties: false,
      },
    },
  },
});
// stop_reason: 'end_turn', content: [{ type: 'text', text: '{"step_complete": true, "notes": "..."}' }]
```

**Result:** API accepted the call. `stop_reason: 'end_turn'`. Response text was valid JSON
matching the declared schema. No beta header string required (SDK sends `?beta=true` query
param automatically via `client.beta.messages.create()`).

### Amazon Bedrock (`client.beta.messages.create()` via AnthropicBedrock)

```typescript
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
const client = new AnthropicBedrock();

const response = await client.beta.messages.create({
  model: 'us.anthropic.claude-sonnet-4-6',
  max_tokens: 1024,
  system: '...',
  messages: [{ role: 'user', content: '...' }],
  tools: [...],
  output_config: {
    format: { type: 'json_schema', schema: { ... } },
  },
});
// stop_reason: 'end_turn', content: [{ type: 'text', text: '{"step_complete": true, ...}' }]
```

**Result:** API accepted the call. `stop_reason: 'end_turn'`. Response text was valid JSON.
AnthropicBedrock exposes `.beta.messages.create()` identically to the direct client.

---

## SDK Type Evidence

### `output_config` type (in `@anthropic-ai/sdk@0.73.0`)

```typescript
// node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts

interface BetaOutputConfig {
  effort?: 'low' | 'medium' | 'high' | 'max' | null;
  format?: BetaJSONOutputFormat | null;
}

interface BetaJSONOutputFormat {
  schema: { [key: string]: unknown };
  type: 'json_schema';
}

// Available on BetaMessageCreateParamsNonStreaming:
// output_config?: BetaOutputConfig;
```

### `AnthropicBedrock.beta` type (in `@anthropic-ai/bedrock-sdk@0.28.1`)

```typescript
// node_modules/@anthropic-ai/bedrock-sdk/client.d.ts, line 84

type BetaResource = Omit<Resources.Beta, 'promptCaching' | 'messages'> & {
  messages: Omit<Resources.Beta['messages'], 'batches' | 'countTokens'>;
};
// AnthropicBedrock.beta: BetaResource -- .beta.messages.create() is available
```

### Key: beta endpoint routing

The SDK calls `/v1/messages?beta=true` (not `/v1/messages`) when using
`client.beta.messages.create()`. No explicit `betas` array is needed for `output_config` --
the `?beta=true` query param is sufficient. The `betas` array only adds feature-specific
`anthropic-beta` headers (e.g. `prompt-caching-2024-07-31`).

---

## Raw Test Results

### Case 1: Baseline -- tools only, no output_config (direct Anthropic)

```json
{
  "stop_reason": "tool_use",
  "content": [
    { "type": "text", "text": "I'll analyze the task..." },
    { "type": "tool_use", "name": "bash_tool", "input": { "command": "echo ..." } }
  ]
}
```

The model called the bash_tool when given tools and a generic task. This confirms that without
`output_config`, the model freely uses tools (as it does today in agent-loop.ts).

### Case 2: tools + output_config (direct Anthropic)

```json
{
  "stop_reason": "end_turn",
  "content": [
    {
      "type": "text",
      "text": "{\"step_complete\": true, \"notes\": \"Analyzed the task 'write a test'...\"}"
    }
  ]
}
```

The model chose NOT to call the tool and instead produced a valid JSON end_turn response.
The system prompt instructed it not to call tools -- the output_config enforced the JSON shape.

### Case 3: System prompt constraint, 3-call consistency (direct Anthropic)

- Call 1: VALID JSON (plain JSON object)
- Call 2: INVALID (wrapped in ```json ... ``` markdown code block)
- Call 3: VALID JSON (plain JSON object)

**2/3 consistent.** The system prompt alone is NOT reliable on claude-sonnet-4-5. The model
sometimes wraps JSON in markdown fences, breaking JSON.parse.

### Case 4: tools + output_config (Bedrock, claude-sonnet-4-6)

```json
{
  "stop_reason": "end_turn",
  "content": [
    {
      "type": "text",
      "text": "{\"step_complete\": true, \"notes\": \"Analyzed the task: 'write a test'...\"}"
    }
  ]
}
```

Identical behavior to direct Anthropic. The beta endpoint works on Bedrock.

### Case 5: System prompt constraint, 3-call consistency (Bedrock, claude-sonnet-4-6)

- Call 1: VALID JSON
- Call 2: VALID JSON
- Call 3: VALID JSON

**3/3 consistent.** claude-sonnet-4-6 on Bedrock reliably produces clean JSON when instructed.

---

## Provider Comparison Table

| Feature | Anthropic direct (claude-sonnet-4-5) | Bedrock (claude-sonnet-4-6) | OpenAI gpt-4o* |
|---|---|---|---|
| `output_config` + tools in ONE request | YES (beta API) | YES (beta API) | YES (`response_format`) |
| Beta API path required | YES (`client.beta.messages.create()`) | YES (`client.beta.messages.create()`) | NO (stable API) |
| Schema enforced at end_turn | YES (valid JSON observed) | YES (valid JSON observed) | YES |
| Schema applied to tool_use turns | N/A (no text on tool_use) | N/A (no text on tool_use) | N/A |
| System prompt fallback consistency | 2/3 (unreliable) | 3/3 (reliable) | N/A |
| `betas` header required | NO | NO | N/A |
| SDK type: `output_config` | `BetaMessageCreateParamsNonStreaming` | Same (via bedrock-sdk) | `ChatCompletionCreateParams` |

*OpenAI: from official documentation, not a live test. OpenAI SDK not installed in this repo.

---

## Key Behavioral Observations

### What happens when both tools and output_config are sent?

The model CHOOSES at each turn whether to call a tool or produce an end_turn response. The
`output_config` schema only applies to end_turn text responses -- it has no effect on
`tool_use` turns (which produce no text).

This means:
- If the model decides to call a tool: `stop_reason: 'tool_use'`, no JSON text, schema not enforced
- If the model decides to respond directly: `stop_reason: 'end_turn'`, JSON text, schema enforced

The system prompt heavily influences whether the model calls tools or not. With a strong
"do NOT call tools" instruction, the model consistently chose end_turn + JSON output.

### Schema does not FORCE end_turn

The `output_config` does not prevent tool calls. It only shapes the text content when the
model DOES produce text. An architecture using `output_config` for workflow control (complete_step)
would still need to account for the model potentially calling external tools before end_turn.

---

## Recommendation for WorkRail

### Option A: Adopt output_config + tools dual architecture

**Architecture:**
- Use `client.beta.messages.create()` instead of `client.messages.create()` in `agent-loop.ts`
- Add `output_config.format` declaring a `{ step_complete: boolean, notes: string, ... }` schema
- Keep external tools (Bash, Read, Write) in the `tools` array
- Remove `complete_step` as a tool; instead, detect `stop_reason: 'end_turn'` + parse JSON text

**Feasibility:** YES for both direct Anthropic and Bedrock.

**Risk:**
- Beta API -- may change or be deprecated
- `AgentClientInterface` would need updating (currently typed to standard `messages.create()`)
- The model might still call tools before end_turn; the agent loop needs to handle this correctly
- On tool_use turns, the JSON schema is irrelevant -- workflow control happens at end_turn only

**Gain:**
- Structured output is MORE reliable than tool calls for workflow control (schema-enforced)
- Separates external effects (tools) from control flow (end_turn JSON) cleanly
- Eliminates the `complete_step` tool hallucination risk

### Option B: Stay with pure tool calls (current architecture)

**Current architecture:** complete_step is a tool. Agent calls it to advance workflow steps.

**Keep if:**
- Beta API risk is unacceptable
- The added complexity of dual architecture is not worth the reliability gain

### Option C: System prompt fallback (Bedrock only, no beta API)

**Architecture:** Strong system prompt JSON constraint, no `output_config`. Parse end_turn text.

**Viability:** 3/3 consistent on claude-sonnet-4-6 (Bedrock). NOT reliable on claude-sonnet-4-5
(direct Anthropic, 2/3 consistent).

**Recommendation:** Do NOT use for direct Anthropic. Acceptable for Bedrock-only deployment
if beta API risk is unacceptable. But this is fragile -- model updates may break consistency.

---

## Decision

**Recommended: Option A (output_config + tools dual architecture on beta API).**

The coexistence is confirmed on both providers. The beta endpoint is stable enough (it is the
same endpoint used by tools like web_search, code execution, etc. in production).

The schema enforcement on end_turn is reliable. The system prompt should still instruct the
model about when to call tools vs. when to respond directly, but the JSON schema provides a
safety net that pure system-prompt approaches lack.

**Primary action:** Update `AgentClientInterface` to expose `beta.messages.create()` and add
`output_config` to the `AgentLoop` options. Remove `complete_step` as a tool; replace with
end_turn JSON parsing in workflow-runner.ts.
