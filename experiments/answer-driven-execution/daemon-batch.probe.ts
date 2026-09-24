/** Real AgentLoop + real complete_step adapter; fake model and token-idempotent engine.
 * No gateway, full workflow-runner lifecycle, or process-restart proof.
 */
import 'reflect-metadata';
import { expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { okAsync } from 'neverthrow';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentLoop, type AgentClientInterface } from '../../src/daemon/agent-loop.js';
import { makeCompleteStepTool } from '../../src/daemon/tools/continue-workflow.js';
import { DAEMON_SESSIONS_DIR } from '../../src/daemon/tools/_shared.js';
import type { V2ToolContext } from '../../src/mcp/types.js';

type Execute = NonNullable<Parameters<typeof makeCompleteStepTool>[7]>;
const successorPrompt = 'SECOND_TASK_ONLY_VISIBLE_AFTER_FIRST_RESULT_8347';
const notes = 'I inspected the assigned source and recorded the evidence for this exact task.';
const toolCall = (id: string): Anthropic.ToolUseBlock => ({ type: 'tool_use', id, name: 'complete_step', input: { notes } });
const message = (id: string, calls: Anthropic.ToolUseBlock[]): Anthropic.Message => ({
  id, type: 'message', role: 'assistant', model: 'fixture-model', stop_sequence: null,
  stop_reason: calls.length ? 'tool_use' : 'end_turn',
  content: calls.length ? calls : [{ type: 'text', text: 'Finished the response.' }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

it.each(['same-response', 'separate-responses'] as const)(
  'allows only delivered work to be completed: %s', async arrangement => {
    const sessionId = randomUUID();
    const firstToken = 'ct_first_opportunity_12345678901234567890';
    const secondToken = 'ct_second_opportunity_12345678901234567890';
    let currentToken = firstToken;
    let latestModelSawSuccessor = false;
    const observations: Array<{ token: string; modelSawSuccessor: boolean }> = [];
    const committed = new Set<string>();
    const requests: boolean[] = [];
    const responses = arrangement === 'same-response'
      ? [message('response-1', [toolCall('call-1'), toolCall('call-2')]), message('response-end', [])]
      : [message('response-1', [toolCall('call-1')]), message('response-2', [toolCall('call-2')]), message('response-end', [])];
    const client: AgentClientInterface = { messages: { create: async params => {
      latestModelSawSuccessor = JSON.stringify(params.messages).includes(successorPrompt);
      requests.push(latestModelSawSuccessor);
      const next = responses.shift();
      if (!next) throw new Error('Unexpected extra model request');
      return next;
    } } };
    const execute: Execute = input => {
      observations.push({ token: input.continueToken, modelSawSuccessor: latestModelSawSuccessor });
      committed.add(input.continueToken);
      const complete = input.continueToken === secondToken;
      return okAsync({ response: {
        kind: 'ok', continueToken: secondToken, isComplete: complete,
        pending: complete ? null : { stepId: 'second', title: 'Second task', prompt: successorPrompt },
        preferences: { autonomy: 'full_auto_never_stop', riskPolicy: 'balanced' },
        nextIntent: 'perform_pending_then_continue',
        nextCall: { tool: 'continue_workflow', params: { continueToken: secondToken } },
      } }) as ReturnType<Execute>;
    };
    const tool = makeCompleteStepTool(sessionId, {} as V2ToolContext, () => currentToken,
      (_text, token) => { currentToken = token; }, () => {},
      token => { currentToken = token; }, { CompleteStepParams: {} }, execute);
    const agent = new AgentLoop({ systemPrompt: 'Complete the delivered task.', tools: [tool], client, modelId: 'fixture-model' });
    try {
      await agent.prompt({ role: 'user', content: 'Complete the first task.', timestamp: 0 });
      expect(requests).toEqual(arrangement === 'same-response' ? [false, true] : [false, true, true]);
      expect(observations[0]).toEqual({ token: firstToken, modelSawSuccessor: false });
      if (arrangement === 'separate-responses') {
        expect(observations).toEqual([
          { token: firstToken, modelSawSuccessor: false },
          { token: secondToken, modelSawSuccessor: true },
        ]);
        expect([...committed]).toEqual([firstToken, secondToken]);
      } else {
        expect(observations.filter(item => item.token === secondToken && !item.modelSawSuccessor),
          'A pre-generated answer cannot consume a task absent from its model request').toEqual([]);
        expect([...committed]).toEqual([firstToken]);
      }
    } finally {
      agent.abort();
      await rm(join(DAEMON_SESSIONS_DIR, `${sessionId}.json`), { force: true });
    }
  });

it('an invalid first selected answer cannot fall through to a later answer', async () => {
  let executions = 0;
  const responses = [message('invalid-batch', [
    { ...toolCall('invalid'), input: { notes: '' } }, toolCall('later'),
  ]), message('end', [])];
  const client: AgentClientInterface = { messages: { create: async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected extra request');
    return response;
  } } };
  const execute: Execute = () => { executions++; throw new Error('No answer from this response may execute'); };
  const tool = makeCompleteStepTool(randomUUID(), {} as V2ToolContext, () => 'first',
    () => {}, () => {}, () => {}, { CompleteStepParams: {} }, execute);
  const agent = new AgentLoop({ systemPrompt: 'Complete the delivered task.', tools: [tool], client, modelId: 'fixture-model' });
  try {
    await agent.prompt({ role: 'user', content: 'Complete the first task.', timestamp: 0 });
    expect(executions).toBe(0);
    expect(responses).toHaveLength(0);
  } finally { agent.abort(); }
});
