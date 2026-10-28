import type { ExecutionMcpResult, McpCallToolResult } from '../../../src/mcp/types/workflow-tool-edition.js';
import { createV2ExecutionRenderEnvelope, attachV2ExecutionRenderMetadata } from '../../../src/mcp/render-envelope.js';

const pending = { stepId: 'first', title: 'First', prompt: 'Do the work.' };
const missingAuthority = {
  isComplete: false, pending,
  preferences: { autonomy: 'guided' as const, riskPolicy: 'balanced' as const },
  nextIntent: 'perform_pending_then_continue' as const, nextCall: null,
};
// @ts-expect-error publication requires the validated construction seam, including authority checks
const missingAuthorityResult: ExecutionMcpResult = { content: [], structuredContent: missingAuthority };
// @ts-expect-error a pending step alone cannot be published as an execution result
const incomplete: ExecutionMcpResult = { content: [], structuredContent: { pending } };
// @ts-expect-error the generic wire result cannot hide an incomplete execution result
const genericIncomplete: McpCallToolResult = { content: [], structuredContent: { pending } };
// @ts-expect-error render envelopes require a complete execution response
createV2ExecutionRenderEnvelope({ response: { pending }, lifecycle: 'start' });
// @ts-expect-error attaching lifecycle metadata cannot turn a pending step into execution state
attachV2ExecutionRenderMetadata({ response: { pending }, lifecycle: 'start' });
