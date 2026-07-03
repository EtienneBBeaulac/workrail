import { executeStartWorkflow } from '../../src/v2/usecases/start-workflow.js';
import type { V2StartWorkflowInput } from '../../src/mcp/v2/tools.js';
import type { ToolContext } from '../../src/mcp/types.js';
import { toPendingStep, deriveNextIntent } from '../../src/v2/durable-core/prompts/index.js';
import { defaultPreferences } from '../../src/v2/durable-core/tokens/preferences.js';
import { buildNextCall } from '../../src/mcp/handlers/v2-execution/build-next-call.js';

/**
 * A test-only helper that bypasses the MCP boundary (and its onboarding injection)
 * to directly start a workflow in the core engine. This should be used for all 
 * core engine tests (projections, retries, etc) to avoid MCP-specific behavior.
 */
export async function startWorkflowForTest(
  input: V2StartWorkflowInput,
  ctx: Pick<ToolContext, 'v2' | 'featureFlags'>,
  internalContext?: Readonly<Record<string, string>>
) {
  const deps = {
    workflowReader: ctx.v2.workflowService,
    crypto: ctx.v2.crypto,
    idFactory: ctx.v2.idFactory,
    tokenCodecPorts: ctx.v2.tokenCodecPorts,
    tokenAliasStore: ctx.v2.tokenAliasStore,
    entropy: ctx.v2.entropy,
    snapshotStore: ctx.v2.snapshotStore,
    sessionStore: ctx.v2.sessionEventLogStore,
    pinnedStore: ctx.v2.pinnedStore,
    gate: ctx.v2.executionGate,
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

  return {
    type: 'success' as const,
    data: {
      response: {
        continueToken: res.value.response.continueToken,
        checkpointToken: res.value.response.checkpointToken,
        isComplete: false,
        pending,
        preferences,
        nextIntent,
        nextCall: buildNextCall({ continueToken: res.value.response.continueToken, isComplete: false, pending }),
      },
      contentEnvelope: res.value.contentEnvelope,
      sessionId: res.value.sessionId,
    },
  };
}
