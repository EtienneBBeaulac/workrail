import type Anthropic from '@anthropic-ai/sdk';
import { AgentLoop, type AgentLoopOptions, type AgentTool } from '../agent-loop.js';
import type { ModelInferenceBoundary } from '../../answer-v1/contracts/host-composition.js';
import type { RawModelResponse } from '../../answer-v1/contracts/invocation-contract.js';

/** Composition supplies workspace capabilities only. Engine mutation stays in the host. */
export type AnswerModelOptions = Pick<AgentLoopOptions,
  'client' | 'modelId' | 'systemPrompt' | 'maxTokens' | 'callbacks' | 'stallTimeoutMs'
> & { readonly workspaceTools: readonly AgentTool[] };

const answerTool: AgentTool = {
  name: 'answer_work', label: 'Answer work',
  description: 'Submit your answer to the current instruction. This ends the current turn.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['answer'],
    properties: { answer: { type: 'object', additionalProperties: false, required: ['notes'],
      properties: { notes: { type: 'string' } } } },
  },
  async execute() {
    return { content: [{ type: 'text', text: 'Answer requires host capture.' }], details: { kind: 'refused' } };
  },
};

function raw(response: Anthropic.Message): RawModelResponse {
  return {
    providerResponseId: response.id,
    responseText: response.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    calls: response.content.filter(block => block.type === 'tool_use').map(block => ({
      id: block.id, name: block.name, argumentsJson: JSON.stringify(block.input),
    })),
  };
}

export type CreateDaemonAnswerModelResult =
  | { readonly kind: 'created'; readonly model: ModelInferenceBoundary }
  | { readonly kind: 'refused'; readonly reason: 'unsupported_workspace_tool' | 'duplicate_tool_name' };

/** Each durable delivery gets its own loop. No mutable successor token reaches a tool.
 * A response containing an answer is returned in full, including other calls, before
 * any of its tools run. Selection, retention and replay belong to the canonical host.
 * This is explicit composition, not activation of the legacy daemon profile. */
export function createDaemonAnswerModel(options: AnswerModelOptions): CreateDaemonAnswerModelResult {
  const names = options.workspaceTools.map(tool => tool.name);
  const workspaceNames = new Set(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'report_issue']);
  if (names.some(name => !workspaceNames.has(name))) {
    return { kind: 'refused', reason: 'unsupported_workspace_tool' };
  }
  if (new Set(names).size !== names.length) return { kind: 'refused', reason: 'duplicate_tool_name' };
  const { workspaceTools, ...loopOptions } = options;
  const tools = [...workspaceTools, answerTool];
  return { kind: 'created', model: { async generate(input, signal) {
    if (signal.aborted) return { kind: 'cancelled' };
    let response: RawModelResponse | undefined;
    const loop = new AgentLoop({ ...loopOptions, tools,
      responseHandoff: { toolName: answerTool.name, accept(message) { response = raw(message); } },
    });
    const abort = () => loop.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      await loop.prompt({ role: 'user', content: JSON.stringify(input), timestamp: 0 });
      if (signal.aborted) return { kind: 'cancelled' };
      if (response) return { kind: 'completed', response };
      const last = loop.state.messages.at(-1);
      return { kind: 'unavailable', detail: last?.role === 'assistant' && last.stopReason === 'error'
        ? last.errorMessage ?? 'Model failed' : 'Model ended without submitting an answer' };
    } catch (error) {
      return signal.aborted ? { kind: 'cancelled' } : { kind: 'unavailable', detail: String(error) };
    } finally {
      signal.removeEventListener('abort', abort);
      loop.abort();
    }
  } } };
}
