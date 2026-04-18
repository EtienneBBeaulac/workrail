/**
 * Unit tests for AgentLoop in src/daemon/agent-loop.ts.
 *
 * Strategy: use a FakeAnthropicClient class that returns deterministic response
 * sequences. No real API calls. Follows the "prefer fakes over mocks" principle
 * from CLAUDE.md.
 *
 * WHY a fake class instead of a mock library: the FakeAnthropicClient is
 * a realistic substitute that validates behavior under controlled conditions.
 * Spy/mock libraries add indirection and don't improve coverage here.
 */

import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  AgentLoop,
  type AgentClientInterface,
  type AgentTool,
  type AgentToolResult,
  type AgentEvent,
} from '../../src/daemon/agent-loop.js';
import { tmpPath } from '../helpers/platform.js';

// ---------------------------------------------------------------------------
// FakeAnthropicClient
// ---------------------------------------------------------------------------

/**
 * A deterministic fake Anthropic client for testing.
 *
 * Initialized with a response sequence. Each call to messages.create()
 * returns the next response in the sequence. Throws if the sequence is empty.
 */
class FakeAnthropicClient implements AgentClientInterface {
  private _responses: Array<Anthropic.Message>;
  public callCount = 0;
  public lastParams: Anthropic.MessageCreateParamsNonStreaming | null = null;

  constructor(responses: Anthropic.Message[]) {
    this._responses = [...responses];
  }

  messages = {
    create: async (
      params: Anthropic.MessageCreateParamsNonStreaming,
      _options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message> => {
      this.callCount++;
      this.lastParams = params;
      const response = this._responses.shift();
      if (!response) throw new Error('FakeAnthropicClient: no more responses');
      return response;
    },
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Build a minimal Anthropic.Message with end_turn stop reason. */
function makeEndTurnMessage(text = 'Done.'): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-test',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** Build an Anthropic.Message with a single tool_use block. */
function makeToolUseMessage(
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown> = {},
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: toolUseId,
        name: toolName,
        input,
      },
    ],
    model: 'claude-test',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** Build a no-op tool that returns a fixed result. */
function makeTool(
  name: string,
  result: string = '(tool output)',
): AgentTool & { executionCount: number } {
  let executionCount = 0;
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    label: name,
    get executionCount() { return executionCount; },
    async execute(_toolCallId: string, _params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      executionCount++;
      return {
        content: [{ type: 'text', text: result }],
        details: { toolName: name },
      };
    },
  };
}

/** Build a throwing tool. */
function makeThrowingTool(name: string, errorMessage: string): AgentTool {
  return {
    name,
    description: `Throwing test tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    label: name,
    async execute(): Promise<AgentToolResult<unknown>> {
      throw new Error(errorMessage);
    },
  };
}

const USER_MSG = { role: 'user' as const, content: 'Start the workflow.', timestamp: 0 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop', () => {
  describe('loop termination', () => {
    it('terminates on end_turn with no tool calls', async () => {
      const client = new FakeAnthropicClient([makeEndTurnMessage()]);
      const agent = new AgentLoop({
        systemPrompt: 'You are a test agent.',
        tools: [],
        client,
        modelId: 'claude-test',
      });

      await agent.prompt(USER_MSG);

      expect(client.callCount).toBe(1);
      const messages = agent.state.messages;
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant') as
        | { role: 'assistant'; stopReason: string }
        | undefined;
      expect(lastAssistant?.stopReason).toBe('end_turn');
    });

    it('state.messages contains the correct stopReason after end_turn', async () => {
      const client = new FakeAnthropicClient([makeEndTurnMessage('Workflow complete.')]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [],
        client,
        modelId: 'claude-test',
      });

      await agent.prompt(USER_MSG);

      const messages = agent.state.messages;
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === 'assistant') as { role: 'assistant'; stopReason: string; errorMessage?: string } | undefined;
      expect(lastAssistant).toBeDefined();
      expect(lastAssistant?.stopReason).toBe('end_turn');
      expect(lastAssistant?.errorMessage).toBeUndefined();
    });

    it('treats max_tokens stop_reason as end_turn and exits cleanly', async () => {
      // WHY: max_tokens means the model was truncated at the token limit, not that an
      // error occurred. _mapStopReason maps 'max_tokens' -> 'end_turn' so the loop exits
      // cleanly rather than propagating a spurious error to the caller.
      const maxTokensMsg: Anthropic.Message = { ...makeEndTurnMessage(), stop_reason: 'max_tokens' };
      const client = new FakeAnthropicClient([maxTokensMsg]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [],
        client,
        modelId: 'claude-test',
      });

      await agent.prompt(USER_MSG);

      const messages = agent.state.messages;
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant') as
        | { role: 'assistant'; stopReason: string; errorMessage?: string }
        | undefined;
      expect(lastAssistant).toBeDefined();
      expect(lastAssistant?.stopReason).toBe('end_turn');
      expect(lastAssistant?.errorMessage).toBeUndefined();
    });
  });

  describe('tool execution', () => {
    it('executes a tool call and makes a second LLM call with results', async () => {
      const tool = makeTool('my_tool', 'tool result text');
      const client = new FakeAnthropicClient([
        makeToolUseMessage('my_tool', 'call_1'),
        makeEndTurnMessage(),
      ]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [tool],
        client,
        modelId: 'claude-test',
      });

      await agent.prompt(USER_MSG);

      expect(tool.executionCount).toBe(1);
      expect(client.callCount).toBe(2);
    });

    it('includes tool results in the second LLM call messages', async () => {
      const tool = makeTool('my_tool', 'the result content');
      const client = new FakeAnthropicClient([
        makeToolUseMessage('my_tool', 'call_1'),
        makeEndTurnMessage(),
      ]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [tool],
        client,
        modelId: 'claude-test',
      });

      await agent.prompt(USER_MSG);

      // The second call should include the tool result in messages
      expect(client.lastParams).not.toBeNull();
      const messages = client.lastParams!.messages;
      // Should have: initial user msg, assistant (tool_use), user (tool_result)
      expect(messages.length).toBeGreaterThanOrEqual(3);
      const lastUserMsg = messages[messages.length - 1];
      expect(lastUserMsg!.role).toBe('user');
      expect(Array.isArray(lastUserMsg!.content)).toBe(true);
    });

    it('executes multiple tool calls in one turn sequentially', async () => {
      const executionOrder: string[] = [];

      const toolA: AgentTool = {
        name: 'tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object', properties: {} },
        label: 'Tool A',
        async execute(): Promise<AgentToolResult<unknown>> {
          executionOrder.push('a');
          return { content: [{ type: 'text', text: 'A done' }], details: null };
        },
      };

      const toolB: AgentTool = {
        name: 'tool_b',
        description: 'Tool B',
        inputSchema: { type: 'object', properties: {} },
        label: 'Tool B',
        async execute(): Promise<AgentToolResult<unknown>> {
          executionOrder.push('b');
          return { content: [{ type: 'text', text: 'B done' }], details: null };
        },
      };

      // Both tools in one assistant message
      const twoToolMessage: Anthropic.Message = {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_a', name: 'tool_a', input: {} },
          { type: 'tool_use', id: 'call_b', name: 'tool_b', input: {} },
        ],
        model: 'claude-test',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      };

      const client = new FakeAnthropicClient([twoToolMessage, makeEndTurnMessage()]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [toolA, toolB],
        client,
        modelId: 'claude-test',
      });

      await agent.prompt(USER_MSG);

      expect(executionOrder).toEqual(['a', 'b']); // Sequential, in order
    });
  });

  describe('steer() injection', () => {
    it('injects a steer message after tool batch and makes another LLM call', async () => {
      const tool = makeTool('continue_workflow');
      const client = new FakeAnthropicClient([
        makeToolUseMessage('continue_workflow', 'call_1'),
        makeEndTurnMessage('Injected and done.'),
      ]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [tool],
        client,
        modelId: 'claude-test',
      });

      // Subscribe and call steer() only on the first turn_end (after tool execution)
      let steered = false;
      agent.subscribe(async (event: AgentEvent) => {
        if (event.type === 'turn_end' && !steered) {
          steered = true;
          agent.steer({ role: 'user', content: 'Next step instructions.', timestamp: 1 });
        }
      });

      await agent.prompt(USER_MSG);

      // 1st call: initial; 2nd call: after tool result + steer injection
      expect(client.callCount).toBe(2);
    });

    it('steer message appears in the next LLM call', async () => {
      const tool = makeTool('some_tool');
      const client = new FakeAnthropicClient([
        makeToolUseMessage('some_tool', 'call_1'),
        makeEndTurnMessage(),
      ]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [tool],
        client,
        modelId: 'claude-test',
      });

      let steeredOnce = false;
      agent.subscribe(async (event: AgentEvent) => {
        if (event.type === 'turn_end' && !steeredOnce) {
          steeredOnce = true;
          agent.steer({ role: 'user', content: 'STEER_CONTENT', timestamp: 1 });
        }
      });

      await agent.prompt(USER_MSG);

      // The second call should include the steered message
      const messages = client.lastParams!.messages;
      const messageContents = messages
        .filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      const hasSteer = messageContents.some((c) => c.includes('STEER_CONTENT'));
      expect(hasSteer).toBe(true);
    });
  });

  describe('abort()', () => {
    it('stops the loop when abort() is called before prompt()', async () => {
      const client = new FakeAnthropicClient([makeEndTurnMessage()]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [],
        client,
        modelId: 'claude-test',
      });

      agent.abort();
      await agent.prompt(USER_MSG);

      // Aborted before LLM call -- no API calls made
      expect(client.callCount).toBe(0);
      const messages = agent.state.messages;
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant') as
        | { role: 'assistant'; stopReason: string; errorMessage?: string }
        | undefined;
      expect(lastAssistant?.stopReason).toBe('error');
      expect(lastAssistant?.errorMessage).toContain('aborted');
    });
  });

  describe('unknown tool name', () => {
    it('returns error tool_result for unknown tool and continues the loop', async () => {
      // LLM calls a tool that doesn't exist, then after error result, returns end_turn
      const client = new FakeAnthropicClient([
        makeToolUseMessage('nonexistent_tool', 'call_1'),
        makeEndTurnMessage('Recovered.'),
      ]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [], // No tools registered
        client,
        modelId: 'claude-test',
      });

      // Should NOT throw -- loop continues with error tool_result
      await expect(agent.prompt(USER_MSG)).resolves.toBeUndefined();

      // Two LLM calls: first with tool_use, second after error tool_result
      expect(client.callCount).toBe(2);
    });

    it('error tool_result for unknown tool includes the tool name', async () => {
      const client = new FakeAnthropicClient([
        makeToolUseMessage('ghost_tool', 'call_1'),
        makeEndTurnMessage(),
      ]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [],
        client,
        modelId: 'claude-test',
      });

      // Subscribe to turn_end to capture tool results
      const capturedResults: Array<{ toolName: string; isError: boolean }> = [];
      agent.subscribe(async (event: AgentEvent) => {
        if (event.type === 'turn_end') {
          event.toolResults.forEach((r: unknown) => {
            const result = r as { toolName: string; isError: boolean };
            capturedResults.push({ toolName: result.toolName, isError: result.isError });
          });
        }
      });

      await agent.prompt(USER_MSG);

      expect(capturedResults).toHaveLength(1);
      expect(capturedResults[0]!.toolName).toBe('ghost_tool');
      expect(capturedResults[0]!.isError).toBe(true);
    });
  });

  describe('tool errors (throwing tools)', () => {
    it('wraps tool throws as isError tool_result -- prompt() does not throw and loop continues', async () => {
      // WHY: a tool throw (e.g. bash exit code 1) must not kill the session.
      // The LLM must receive the error as an isError tool_result so it can recover.
      const throwingTool = makeThrowingTool('bad_tool', 'Tool execution failed');
      const client = new FakeAnthropicClient([
        makeToolUseMessage('bad_tool', 'call_1'),
        makeEndTurnMessage(), // second LLM call after isError result
      ]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [throwingTool],
        client,
        modelId: 'claude-test',
      });

      const capturedResults: Array<{ toolName: string; isError: boolean; content: string }> = [];
      agent.subscribe(async (event: AgentEvent) => {
        if (event.type === 'turn_end') {
          event.toolResults.forEach((r) => {
            capturedResults.push({
              toolName: r.toolName,
              isError: r.isError,
              content: r.result?.content[0]?.text ?? '',
            });
          });
        }
      });

      // Tool throws -> prompt() must NOT throw -- loop must continue
      await expect(agent.prompt(USER_MSG)).resolves.toBeUndefined();

      // Loop continued -- two LLM calls (first with tool_use, second after isError result)
      expect(client.callCount).toBe(2);

      // isError result was produced with the correct error message
      expect(capturedResults).toHaveLength(1);
      expect(capturedResults[0]!.toolName).toBe('bad_tool');
      expect(capturedResults[0]!.isError).toBe(true);
      expect(capturedResults[0]!.content).toContain('Tool execution failed');
    });
  });

  describe('state.messages shape', () => {
    it('last assistant message has role, stopReason, and no errorMessage on success', async () => {
      const client = new FakeAnthropicClient([makeEndTurnMessage()]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [],
        client,
        modelId: 'claude-test',
      });

      await agent.prompt(USER_MSG);

      const messages = agent.state.messages;
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant') as
        | { role: 'assistant'; stopReason: string; errorMessage?: string }
        | undefined;
      expect(lastAssistant).toBeDefined();
      expect(lastAssistant?.role).toBe('assistant');
      expect(lastAssistant?.stopReason).toBe('end_turn');
      expect(lastAssistant?.errorMessage).toBeUndefined();
    });

    it('messages array starts with the initial user message', async () => {
      const client = new FakeAnthropicClient([makeEndTurnMessage()]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [],
        client,
        modelId: 'claude-test',
      });

      await agent.prompt(USER_MSG);

      const messages = agent.state.messages;
      expect(messages.length).toBeGreaterThanOrEqual(2); // user + assistant
      const firstMsg = messages[0] as { role: string; content?: unknown };
      expect(firstMsg.role).toBe('user');
    });
  });

  describe('subscribe()', () => {
    it('returns an unsubscribe function that stops future event delivery', async () => {
      let eventCount = 0;
      const client = new FakeAnthropicClient([makeEndTurnMessage()]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [],
        client,
        modelId: 'claude-test',
      });

      const unsubscribe = agent.subscribe(() => { eventCount++; });
      unsubscribe(); // Unsubscribe immediately

      await agent.prompt(USER_MSG);

      expect(eventCount).toBe(0); // No events delivered after unsubscribe
    });

    it('emits turn_end event with empty toolResults when LLM has no tool calls', async () => {
      const receivedEvents: AgentEvent[] = [];
      const client = new FakeAnthropicClient([makeEndTurnMessage()]);
      const agent = new AgentLoop({
        systemPrompt: 'System prompt.',
        tools: [],
        client,
        modelId: 'claude-test',
      });

      agent.subscribe(async (event) => { receivedEvents.push(event); });
      await agent.prompt(USER_MSG);

      const turnEndEvent = receivedEvents.find((e) => e.type === 'turn_end');
      expect(turnEndEvent).toBeDefined();
      expect((turnEndEvent as { type: 'turn_end'; toolResults: unknown[] }).toolResults).toHaveLength(0);

      const agentEndEvent = receivedEvents.find((e) => e.type === 'agent_end');
      expect(agentEndEvent).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// AgentLoopCallbacks tests
// ---------------------------------------------------------------------------

describe('AgentLoop callbacks', () => {
  it('onLlmTurnStarted fires before the API call with correct messageCount', async () => {
    const client = new FakeAnthropicClient([makeEndTurnMessage()]);
    const startedCalls: Array<{ messageCount: number }> = [];

    const agent = new AgentLoop({
      systemPrompt: 'test',
      tools: [],
      client,
      modelId: 'test-model',
      callbacks: {
        onLlmTurnStarted: (info) => { startedCalls.push(info); },
      },
    });

    await agent.prompt(USER_MSG);

    // One LLM call was made. onLlmTurnStarted should have fired once.
    expect(startedCalls).toHaveLength(1);
    // The initial user message is 1 message in the conversation.
    expect(startedCalls[0]!.messageCount).toBe(1);
  });

  it('onLlmTurnCompleted fires after the API call with token counts and stop reason', async () => {
    const client = new FakeAnthropicClient([makeEndTurnMessage()]);
    const completedCalls: Array<{ stopReason: string; outputTokens: number; inputTokens: number; toolNamesRequested: readonly string[] }> = [];

    const agent = new AgentLoop({
      systemPrompt: 'test',
      tools: [],
      client,
      modelId: 'test-model',
      callbacks: {
        onLlmTurnCompleted: (info) => { completedCalls.push(info); },
      },
    });

    await agent.prompt(USER_MSG);

    expect(completedCalls).toHaveLength(1);
    // makeEndTurnMessage returns usage: { input_tokens: 10, output_tokens: 5 }.
    expect(completedCalls[0]!.inputTokens).toBe(10);
    expect(completedCalls[0]!.outputTokens).toBe(5);
    expect(completedCalls[0]!.stopReason).toBe('end_turn');
    expect(completedCalls[0]!.toolNamesRequested).toEqual([]);
  });

  it('onLlmTurnCompleted reports tool names when LLM requests tool calls', async () => {
    const tool = makeTool('Bash', '(bash output)');
    const client = new FakeAnthropicClient([
      makeToolUseMessage('Bash', 'call-1', { command: 'echo hi' }),
      makeEndTurnMessage(),
    ]);
    const completedCalls: Array<{ toolNamesRequested: readonly string[] }> = [];

    const agent = new AgentLoop({
      systemPrompt: 'test',
      tools: [tool],
      client,
      modelId: 'test-model',
      callbacks: {
        onLlmTurnCompleted: (info) => { completedCalls.push(info); },
      },
    });

    await agent.prompt(USER_MSG);

    // First turn: tool_use. Second turn: end_turn.
    expect(completedCalls).toHaveLength(2);
    expect(completedCalls[0]!.toolNamesRequested).toEqual(['Bash']);
    expect(completedCalls[1]!.toolNamesRequested).toEqual([]);
  });

  it('onToolCallStarted fires before tool execute with truncated argsSummary', async () => {
    const tool = makeTool('Bash', '(output)');
    const client = new FakeAnthropicClient([
      makeToolUseMessage('Bash', 'call-1', { command: 'git status' }),
      makeEndTurnMessage(),
    ]);
    const startedCalls: Array<{ toolName: string; argsSummary: string }> = [];
    const executionOrder: string[] = [];

    // Intercept execute() to record ordering.
    const wrappedTool = {
      ...tool,
      async execute(toolCallId: string, params: Record<string, unknown>) {
        executionOrder.push('execute');
        return tool.execute(toolCallId, params);
      },
    };

    const agent = new AgentLoop({
      systemPrompt: 'test',
      tools: [wrappedTool],
      client,
      modelId: 'test-model',
      callbacks: {
        onToolCallStarted: (info) => {
          executionOrder.push('onToolCallStarted');
          startedCalls.push(info);
        },
      },
    });

    await agent.prompt(USER_MSG);

    expect(startedCalls).toHaveLength(1);
    expect(startedCalls[0]!.toolName).toBe('Bash');
    expect(startedCalls[0]!.argsSummary).toContain('git status');
    // onToolCallStarted must fire BEFORE execute().
    expect(executionOrder[0]).toBe('onToolCallStarted');
    expect(executionOrder[1]).toBe('execute');
  });

  it('onToolCallCompleted fires after successful execute with durationMs and resultSummary', async () => {
    const tool = makeTool('Read', 'file contents here');
    const client = new FakeAnthropicClient([
      makeToolUseMessage('Read', 'call-1', { filePath: tmpPath('test.txt') }),
      makeEndTurnMessage(),
    ]);
    const completedCalls: Array<{ toolName: string; durationMs: number; resultSummary: string }> = [];

    const agent = new AgentLoop({
      systemPrompt: 'test',
      tools: [tool],
      client,
      modelId: 'test-model',
      callbacks: {
        onToolCallCompleted: (info) => { completedCalls.push(info); },
      },
    });

    await agent.prompt(USER_MSG);

    expect(completedCalls).toHaveLength(1);
    expect(completedCalls[0]!.toolName).toBe('Read');
    expect(typeof completedCalls[0]!.durationMs).toBe('number');
    expect(completedCalls[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(completedCalls[0]!.resultSummary).toBe('file contents here');
  });

  it('onToolCallFailed fires when tool.execute() throws, loop continues', async () => {
    // A tool that always throws.
    const throwingTool: AgentTool = {
      name: 'BadTool',
      description: 'always throws',
      inputSchema: { type: 'object', properties: {} },
      label: 'BadTool',
      async execute(): Promise<AgentToolResult<unknown>> {
        throw new Error('intentional failure');
      },
    };

    const client = new FakeAnthropicClient([
      makeToolUseMessage('BadTool', 'call-1'),
      makeEndTurnMessage(), // Loop continues after the tool failure.
    ]);
    const failedCalls: Array<{ toolName: string; durationMs: number; errorMessage: string }> = [];

    const agent = new AgentLoop({
      systemPrompt: 'test',
      tools: [throwingTool],
      client,
      modelId: 'test-model',
      callbacks: {
        onToolCallFailed: (info) => { failedCalls.push(info); },
      },
    });

    await agent.prompt(USER_MSG);

    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0]!.toolName).toBe('BadTool');
    expect(failedCalls[0]!.errorMessage).toContain('intentional failure');
    expect(typeof failedCalls[0]!.durationMs).toBe('number');
  });

  it('a throwing callback does not crash the agent loop', async () => {
    const client = new FakeAnthropicClient([makeEndTurnMessage()]);

    const agent = new AgentLoop({
      systemPrompt: 'test',
      tools: [],
      client,
      modelId: 'test-model',
      callbacks: {
        // All callbacks throw -- the loop must still complete normally.
        onLlmTurnStarted: () => { throw new Error('callback error'); },
        onLlmTurnCompleted: () => { throw new Error('callback error'); },
      },
    });

    // Must not throw. Loop completes normally despite throwing callbacks.
    await expect(agent.prompt(USER_MSG)).resolves.toBeUndefined();

    const messages = agent.state.messages;
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg?.role).toBe('assistant');
  });
});
