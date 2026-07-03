import { executeStartWorkflow, defaultPreferences } from '../../src/v2/usecases/start-workflow.js';
import type { V2StartWorkflowInput } from '../../src/mcp/v2/tools.js';
import type { ToolContext } from '../../src/mcp/types.js';
import { toPendingStep } from '../../src/mcp/output-schemas.js';
import { deriveNextIntent } from '../../src/mcp/handlers/v2-state-conversion.js';
import { buildNextCall } from '../../src/mcp/handlers/v2-execution/index.js';
import { buildStepContentEnvelope } from '../../src/mcp/step-content-envelope.js';
import { attachV2ExecutionRenderMetadata } from '../../src/mcp/render-envelope.js';

/**
 * A test-only helper that bypasses the MCP boundary (and its onboarding injection)
 * to directly start a workflow in the core engine. This should be used for all 
 * core engine tests (projections, retries, etc) to avoid MCP-specific behavior.
 */
export async function startWorkflowForTest(
  input: V2StartWorkflowInput,
  ctx: Pick<ToolContext, 'v2' | 'featureFlags' | 'workflowService'>,
  internalContext?: Readonly<Record<string, string>>
) {
  const deps = {
    workflowReader: ctx.workflowService,
    crypto: ctx.v2.crypto,
    idFactory: ctx.v2.idFactory,
    tokenCodecPorts: ctx.v2.tokenCodecPorts,
    tokenAliasStore: ctx.v2.tokenAliasStore,
    entropy: ctx.v2.entropy,
    snapshotStore: ctx.v2.snapshotStore,
    fallbackWorkflowReader: ctx.workflowService,
    sessionStore: ctx.v2.sessionStore,
    pinnedStore: ctx.v2.pinnedStore,
    gate: ctx.v2.gate,
    validationPipelineDeps: ctx.v2.validationPipelineDeps,
    featureFlags: ctx.featureFlags,
  };

  const res = await executeStartWorkflow(deps, { ...input, injectOnboarding: false }, internalContext);
  
  if (res.isErr()) {
    return { type: 'error' as const, error: res.error.message, code: res.error.kind };
  }

  const pending = toPendingStep(res.value.meta);
  const preferences = defaultPreferences;
  const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete: false, pending: res.value.meta });

  const contentEnvelope = buildStepContentEnvelope({
    meta: res.value.meta,
    references: res.value.resolvedReferences,
  });

  const parsed = {
    continueToken: res.value.continueToken,
    checkpointToken: res.value.checkpointToken,
    isComplete: false,
    pending,
    preferences,
    nextIntent,
    nextCall: buildNextCall({ continueToken: res.value.continueToken, isComplete: false, pending }),
  };

  return {
    type: 'success' as const,
    data: attachV2ExecutionRenderMetadata({
      response: parsed,
      lifecycle: 'start',
      contentEnvelope,
    }),
  };
}
