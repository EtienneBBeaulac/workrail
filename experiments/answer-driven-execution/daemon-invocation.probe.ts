import { answerInvocationDirectory } from '../../src/daemon/tools/answer-invocation.js';
/** Existing daemon adapter with a token-idempotent fake engine boundary.
 * This exposes duplicate tool-call rebinding, not process restart or model-batch proof.
 */
import 'reflect-metadata';
import { expect, it } from 'vitest';
import { okAsync } from 'neverthrow';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeCompleteStepTool } from '../../src/daemon/tools/continue-workflow.js';
import { DAEMON_SESSIONS_DIR } from '../../src/daemon/tools/_shared.js';
import type { V2ToolContext } from '../../src/mcp/types.js';

type Execute = NonNullable<Parameters<typeof makeCompleteStepTool>[7]>;
const notes = 'I inspected the assigned source and recorded the evidence for this exact task.';
it.each(['duplicate', 'fresh'] as const)('binds %s tool-call delivery to its assigned work', async delivery => {
  const sessionId = randomUUID();
  const firstToken = 'ct_first_opportunity_12345678901234567890';
  const secondToken = 'ct_second_opportunity_12345678901234567890';
  let currentToken = firstToken;
  const seen: string[] = [];
  const committed = new Set<string>();
  const execute: Execute = input => {
    seen.push(input.continueToken);
    committed.add(input.continueToken); // engine commits once per token, including replay
    const complete = input.continueToken === secondToken;
    return okAsync({ response: {
      kind: 'ok', continueToken: secondToken, isComplete: complete,
      pending: complete ? null : { stepId: 'second', title: 'Second', prompt: 'New work.' },
      preferences: { autonomy: 'full_auto_never_stop', riskPolicy: 'balanced' },
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow', params: { continueToken: secondToken } },
    } }) as ReturnType<Execute>;
  };
  const tool = makeCompleteStepTool(sessionId, {} as V2ToolContext, () => currentToken,
    (_text, token) => { currentToken = token; }, () => {},
    token => { currentToken = token; }, { CompleteStepParams: {} }, execute);
  try {
    const signal = new AbortController().signal;
    await tool.execute('model-call-1', { notes }, signal);
    expect([...committed]).toEqual([firstToken]);
    await tool.execute(delivery === 'duplicate' ? 'model-call-1' : 'model-call-2', { notes }, signal);
    if (delivery === 'fresh') {
      expect([...committed]).toEqual([firstToken, secondToken]);
    } else {
      expect([...committed], 'Redelivery must not consume the successor opportunity').toEqual([firstToken]);
      expect(seen.every(token => token === firstToken)).toBe(true);
    }
  } finally {
    // Only the real adapter's owned sidecar is removed; existing daemon sessions are untouched.
    await rm(join(DAEMON_SESSIONS_DIR, `${sessionId}.json`), { force: true });
    await rm(answerInvocationDirectory(DAEMON_SESSIONS_DIR, sessionId), { recursive: true, force: true });
  }
});
