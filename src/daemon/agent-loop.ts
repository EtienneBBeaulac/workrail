/**
 * Self-contained LLM agent loop for the WorkRail daemon.
 *
 * WHY this module exists: @mariozechner/pi-agent-core is a private npm package --
 * anyone outside Zillow gets a module-not-found crash on npm install. This module
 * replaces pi-agent-core's Agent class with a first-party implementation that
 * uses only public packages (@anthropic-ai/sdk, @anthropic-ai/bedrock-sdk).
 *
 * Design decisions:
 * - AgentClientInterface is a duck-typed injectable: both new Anthropic({ apiKey })
 *   and new AnthropicBedrock() satisfy it without any adapter shim. This follows
 *   the DI-for-boundaries principle from CLAUDE.md.
 * - Tool schemas are plain JSON Schema objects (Record<string, unknown>). The
 *   Anthropic SDK accepts raw JSON Schema for tool input_schema -- no TypeBox needed.
 * - steer() is queue-based, drained after each tool batch (before the next LLM call).
 *   This matches pi-agent-core's turn_end semantics exactly.
 * - AbortController is used internally so abort() cancels in-flight API calls.
 * - Unknown tool names return an error tool_result (is_error: true) and the loop
 *   continues rather than crashing -- LLMs occasionally hallucinate tool names.
 * - Tools throw on failure (pi-agent-core contract). AgentLoop propagates throws
 *   to prompt()'s caller; runWorkflow() catches at the outer boundary.
 */

import type Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable LLM client interface.
 *
 * Both new Anthropic({ apiKey }) from @anthropic-ai/sdk and
 * new AnthropicBedrock() from @anthropic-ai/bedrock-sdk satisfy this interface.
 *
 * WHY duck-typed: avoids importing concrete SDK types in the interface definition,
 * keeping this module decoupled from specific SDK versions.
 */
export interface AgentClientInterface {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
  };
}

/**
 * Result returned by a tool's execute() function.
 *
 * WHY tools return content array: matches the Anthropic messages API format
 * for tool_result blocks, which accept an array of content blocks.
 */
export interface AgentToolResult<T> {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly details: T;
}

/**
 * Tool definition used by AgentLoop.
 *
 * WHY inputSchema uses Record<string, unknown>: the Anthropic SDK's Tool.input_schema
 * accepts raw JSON Schema as Record<string, unknown> -- no TypeBox needed.
 *
 * WHY execute() throws on failure: pi-agent-core contract. The outer boundary
 * (runWorkflow) catches and returns a discriminated union error result.
 */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  /**
   * JSON Schema for the tool's input parameters.
   * Must be a valid JSON Schema object (type: 'object', properties: {...}).
   */
  readonly inputSchema: Record<string, unknown>;
  /** Human-readable label for logging. */
  readonly label: string;
  /**
   * Execute the tool call.
   * THROWS on failure (pi-agent-core contract) -- do not encode errors in content.
   */
  execute(toolCallId: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>>;
}

/**
 * Events emitted by AgentLoop.
 *
 * Only the events used by workflow-runner.ts are defined here (YAGNI).
 * Additional events can be added additively when needed.
 *
 * turn_end: fired after tool results are collected and appended, BEFORE the next
 *   LLM call. Subscribers may call steer() here to inject a message before the
 *   next turn. All subscribers are awaited before the steer queue is checked.
 *
 * agent_end: fired when the loop exits (end_turn with empty steer queue, or error/abort).
 */
export type AgentEvent =
  | { readonly type: 'turn_end'; readonly toolResults: ReadonlyArray<AgentToolCallResult> }
  | { readonly type: 'agent_end' };

/** Internal representation of a completed tool call (for turn_end event). */
export interface AgentToolCallResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: AgentToolResult<unknown> | null;
  readonly isError: boolean;
}

/** Internal message representation stored in state.messages. */
export type AgentInternalMessage =
  | AgentInternalUserMessage
  | AgentInternalAssistantMessage
  | AgentInternalToolResultMessage;

export interface AgentInternalUserMessage {
  readonly role: 'user';
  readonly content: string;
  readonly timestamp: number;
}

export interface AgentInternalAssistantMessage {
  readonly role: 'assistant';
  readonly stopReason: 'tool_use' | 'end_turn' | 'error';
  readonly errorMessage?: string;
  readonly content: ReadonlyArray<Anthropic.ContentBlock>;
}

export interface AgentInternalToolResultMessage {
  readonly role: 'user';
  readonly content: ReadonlyArray<Anthropic.ToolResultBlockParam>;
}

/** Options for constructing an AgentLoop. */
export interface AgentLoopOptions {
  /** System prompt sent with every LLM request. */
  readonly systemPrompt: string;
  /** Tools available to the LLM. */
  readonly tools: readonly AgentTool[];
  /** Injectable LLM client (Anthropic direct or AnthropicBedrock). */
  readonly client: AgentClientInterface;
  /** Model ID to use (e.g. 'claude-sonnet-4-5' or 'us.anthropic.claude-sonnet-4-6'). */
  readonly modelId: string;
  /**
   * Maximum tokens in the LLM response.
   * Default: 8192 (sufficient for Claude Sonnet models).
   */
  readonly maxTokens?: number;
  /**
   * Tool execution strategy.
   * Only 'sequential' is needed for WorkRail (tools have ordering requirements).
   */
  readonly toolExecution?: 'sequential';
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

/**
 * Self-contained LLM agent loop.
 *
 * Replaces @mariozechner/pi-agent-core's Agent class with identical semantics
 * for the surface area used by workflow-runner.ts.
 */
export class AgentLoop {
  private readonly _options: AgentLoopOptions;
  private readonly _listeners: Array<(event: AgentEvent) => Promise<void> | void> = [];
  private readonly _steerQueue: Array<AgentInternalUserMessage> = [];
  private _messages: AgentInternalMessage[] = [];
  private _abortController: AbortController = new AbortController();
  private _isRunning = false;
  /**
   * Tracks whether abort() was called before or during a prompt() call.
   * WHY separate flag: prompt() resets the AbortController at startup.
   * If abort() was called BEFORE prompt(), we need to honor it without a
   * valid AbortController signal.
   */
  private _aborted = false;

  constructor(options: AgentLoopOptions) {
    this._options = options;
  }

  /**
   * Subscribe to agent lifecycle events.
   *
   * Listeners are awaited in subscription order. Async listeners that call
   * steer() will have their message consumed in the current prompt() call.
   *
   * Returns an unsubscribe function.
   */
  subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx !== -1) this._listeners.splice(idx, 1);
    };
  }

  /**
   * Queue a message for injection after the current tool batch.
   *
   * WHY queue-based: steer() is called from a turn_end subscriber, which fires
   * after tool results are collected but before the next LLM call. The queue
   * is drained synchronously after all subscribers have been awaited.
   */
  steer(message: { role: 'user'; content: string; timestamp: number }): void {
    this._steerQueue.push({ role: 'user', content: message.content, timestamp: message.timestamp });
  }

  /**
   * Abort the current in-flight LLM call.
   *
   * WHY AbortController: the Anthropic SDK accepts an AbortSignal in request options.
   * Without this, abort() would only stop the loop from making another call --
   * the current in-flight call would run to completion.
   *
   * A new AbortController is created after each prompt() call so the loop
   * can be reused (though workflow-runner.ts creates a new AgentLoop per session).
   */
  abort(): void {
    this._aborted = true;
    this._abortController.abort();
  }

  /**
   * Current agent state.
   *
   * state.messages is readable after prompt() resolves. workflow-runner.ts
   * reads state.messages to extract the last assistant message's stopReason
   * and errorMessage after the loop completes.
   */
  get state(): {
    readonly messages: ReadonlyArray<AgentInternalMessage>;
  } {
    return { messages: this._messages };
  }

  /**
   * Start the agent loop with the given initial user message.
   *
   * Resolves when the loop exits (end_turn + empty steer queue, error, or abort).
   * Throws if a tool throws (pi-agent-core contract -- outer boundary catches).
   *
   * Loop algorithm:
   * 1. Append userMsg to messages
   * 2. Call client.messages.create() with AbortSignal
   * 3. Append assistant response to messages
   * 4. If tool_use: execute tools sequentially; unknown tools get error tool_result
   * 5. Emit turn_end; await all subscribers (subscribers may call steer())
   * 6. If steer queue non-empty: pop, append, go to step 2
   * 7. If end_turn + empty steer queue: emit agent_end, exit
   * 8. If error or abort: append error message, emit agent_end, exit
   */
  async prompt(message: { role: 'user'; content: string; timestamp: number }): Promise<void> {
    // Reset abort controller for this prompt() call.
    // WHY: allows the same AgentLoop instance to be used for multiple prompts
    // (though workflow-runner.ts creates a new instance per session).
    // NOTE: if abort() was called before prompt(), _aborted flag is set and
    // the loop will exit immediately without making an API call.
    if (!this._aborted) {
      this._abortController = new AbortController();
    }
    this._isRunning = true;

    // Append the initial user message.
    this._messages.push({ role: 'user', content: message.content, timestamp: message.timestamp });

    try {
      await this._runLoop();
    } finally {
      this._isRunning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: core loop
  // ---------------------------------------------------------------------------

  private async _runLoop(): Promise<void> {
    const { client, modelId, systemPrompt, tools, maxTokens = 8192 } = this._options;

    while (true) {
      // Check abort before each LLM call.
      // WHY check both: _aborted covers pre-prompt abort; _abortController.signal
      // covers abort() called during an in-flight API call or between loop iterations.
      if (this._aborted || this._abortController.signal.aborted) {
        this._appendErrorMessage('aborted');
        await this._emitEvent({ type: 'agent_end' });
        return;
      }

      // Build the messages array for the API call.
      // Filter to only LLM-compatible messages (user and assistant).
      const apiMessages = this._buildApiMessages();

      // Build tool definitions for the API call.
      const apiTools: Anthropic.Tool[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));

      let response: Anthropic.Message;
      try {
        response = await client.messages.create(
          {
            model: modelId,
            system: systemPrompt,
            messages: apiMessages,
            tools: apiTools,
            max_tokens: maxTokens,
          },
          { signal: this._abortController.signal },
        );
      } catch (err: unknown) {
        // Distinguish abort from genuine API error.
        const isAbort =
          this._abortController.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError');
        const message = err instanceof Error ? err.message : String(err);
        this._appendErrorMessage(isAbort ? 'aborted' : message);
        await this._emitEvent({ type: 'agent_end' });
        return;
      }

      // Append the assistant response to messages.
      const stopReason = this._mapStopReason(response.stop_reason);
      const assistantMsg: AgentInternalAssistantMessage = {
        role: 'assistant',
        stopReason,
        content: response.content,
      };
      this._messages.push(assistantMsg);

      // Handle tool use.
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      if (stopReason === 'tool_use' || toolUseBlocks.length > 0) {
        const toolResults = await this._executeTools(toolUseBlocks);

        // Append tool results as a user message.
        const toolResultBlocks: Anthropic.ToolResultBlockParam[] = toolResults.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.toolCallId,
          content: r.result?.content.map((c) => ({ type: 'text' as const, text: c.text })) ?? [
            { type: 'text', text: r.isError ? `Tool error: ${r.toolName}` : '(no output)' },
          ],
          is_error: r.isError,
        }));
        this._messages.push({ role: 'user', content: toolResultBlocks });

        // Emit turn_end after tool results are appended.
        // WHY: subscribers (e.g., workflow-runner.ts) call steer() here to inject
        // the next workflow step BEFORE the next LLM call.
        await this._emitEvent({ type: 'turn_end', toolResults });

        // Drain steer queue: inject one message at a time before the next LLM call.
        const steered = this._drainSteerQueue();
        if (steered > 0) {
          // Continue loop -- steer messages were added, make another LLM call.
          continue;
        }

        // No steer messages -- continue the loop (LLM may have more tool calls).
        continue;
      }

      // No tool calls -- agent wants to stop.
      if (stopReason === 'end_turn') {
        // Emit turn_end with empty tool results (no tools were called this turn).
        await this._emitEvent({ type: 'turn_end', toolResults: [] });

        // Drain steer queue: if a subscriber added a steer message, continue.
        const steered = this._drainSteerQueue();
        if (steered > 0) {
          continue;
        }

        // Loop complete.
        await this._emitEvent({ type: 'agent_end' });
        return;
      }

      // Error or unknown stop reason.
      const errorMsg = (assistantMsg as AgentInternalAssistantMessage).errorMessage ?? `Unexpected stop_reason: ${response.stop_reason ?? 'unknown'}`;
      this._appendErrorMessage(errorMsg);
      await this._emitEvent({ type: 'agent_end' });
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: helpers
  // ---------------------------------------------------------------------------

  /**
   * Execute tool calls sequentially.
   *
   * WHY sequential: workflow tools have ordering requirements (continue_workflow
   * must complete before Bash begins on the next step).
   *
   * WHY error tool_result for unknown tools: LLMs occasionally hallucinate tool names.
   * Crashing the loop would lose all progress. An error tool_result lets the LLM
   * recover gracefully.
   */
  private async _executeTools(
    toolUseBlocks: readonly Anthropic.ToolUseBlock[],
  ): Promise<AgentToolCallResult[]> {
    const results: AgentToolCallResult[] = [];

    for (const block of toolUseBlocks) {
      // Check abort before each tool execution.
      if (this._abortController.signal.aborted) {
        results.push({
          toolCallId: block.id,
          toolName: block.name,
          result: null,
          isError: true,
        });
        continue;
      }

      const tool = this._options.tools.find((t) => t.name === block.name);
      if (!tool) {
        // Unknown tool name -- return error tool_result and continue.
        // WHY: LLMs occasionally hallucinate tool names. Crashing would lose all progress.
        results.push({
          toolCallId: block.id,
          toolName: block.name,
          result: {
            content: [{ type: 'text', text: `Unknown tool: ${block.name}` }],
            details: null,
          },
          isError: true,
        });
        continue;
      }

      // Execute the tool. Let throws propagate -- this is the pi-agent-core contract.
      // WHY: tool failures are fatal to the current session. runWorkflow() catches at
      // the outer boundary and records the error. Swallowing tool throws here would
      // hide bugs and silently corrupt workflow state.
      //
      // NOTE: unknown tool names (hallucinated by the LLM) are handled above with an
      // error tool_result because they are recoverable. A tool that exists but throws
      // is a programmer-visible failure, not an LLM mistake.
      const params = (block.input ?? {}) as Record<string, unknown>;
      const result = await tool.execute(block.id, params);
      results.push({
        toolCallId: block.id,
        toolName: block.name,
        result,
        isError: false,
      });
    }

    return results;
  }

  /**
   * Drain the steer queue, appending each message to the conversation.
   * Returns the number of messages drained.
   */
  private _drainSteerQueue(): number {
    let count = 0;
    while (this._steerQueue.length > 0) {
      const msg = this._steerQueue.shift()!;
      this._messages.push(msg);
      count++;
    }
    return count;
  }

  /**
   * Emit an event to all subscribers in order.
   * All subscribers are awaited before returning.
   */
  private async _emitEvent(event: AgentEvent): Promise<void> {
    for (const listener of this._listeners) {
      await listener(event);
    }
  }

  /**
   * Append an assistant error message to state.messages.
   * Used when the loop exits due to abort or API error.
   */
  private _appendErrorMessage(errorMessage: string): void {
    this._messages.push({
      role: 'assistant',
      stopReason: 'error',
      errorMessage,
      content: [],
    });
  }

  /**
   * Convert the internal messages array to Anthropic API message format.
   *
   * The Anthropic API requires alternating user/assistant messages.
   * Internal messages use typed variants; the API needs MessageParam format.
   */
  private _buildApiMessages(): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of this._messages) {
      if (msg.role === 'assistant') {
        const assistantMsg = msg as AgentInternalAssistantMessage;
        result.push({
          role: 'assistant',
          content: assistantMsg.content as Anthropic.ContentBlockParam[],
        });
      } else if (msg.role === 'user') {
        const userMsg = msg as AgentInternalUserMessage | AgentInternalToolResultMessage;
        if (typeof userMsg.content === 'string') {
          // Plain user message
          result.push({ role: 'user', content: (userMsg as AgentInternalUserMessage).content });
        } else {
          // Tool result message
          result.push({
            role: 'user',
            content: (userMsg as AgentInternalToolResultMessage).content as Anthropic.ContentBlockParam[],
          });
        }
      }
    }

    return result;
  }

  /**
   * Map Anthropic's stop_reason string to our internal stop reason type.
   */
  private _mapStopReason(
    stopReason: string | null | undefined,
  ): 'tool_use' | 'end_turn' | 'error' {
    switch (stopReason) {
      case 'tool_use':
        return 'tool_use';
      case 'end_turn':
        return 'end_turn';
      case 'max_tokens':
        // WHY end_turn: max_tokens means the model was truncated at the token limit,
        // not that an error occurred. Treating it as end_turn lets the loop continue
        // on the next turn so the agent can pick up where it left off.
        return 'end_turn';
      default:
        return 'error';
    }
  }
}
