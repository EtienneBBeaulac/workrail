import type { V2ToolContext } from '../../types.js';
import type { V2StartWorkflowOutputSchema } from '../../output-schemas.js';
import { toPendingStep } from '../../output-schemas.js';
import { ResultAsync as RA } from 'neverthrow';
import type { SessionId } from '../../../v2/durable-core/ids/index.js';
import { executeStartWorkflow } from '../../../v2/usecases/start-workflow.js';
import { buildStepContentEnvelope, type StepContentEnvelope } from '../../step-content-envelope.js';
import { buildNextCall } from './index.js';
import { defaultPreferences } from '../../../v2/usecases/start-workflow.js';
import { deriveNextIntent } from '../v2-state-conversion.js';
import type { StartWorkflowError } from '../v2-execution-helpers.js';
import * as z from 'zod';

export interface StartWorkflowResult {
  readonly response: z.infer<typeof V2StartWorkflowOutputSchema>;
  readonly contentEnvelope: StepContentEnvelope;
  /** The newly created session ID. Used by the caller to fire token checkpoints. */
  readonly sessionId: SessionId;
}

export function executeStartWorkflowMCP(
  input: import('../../v2/tools.js').V2StartWorkflowInput,
  ctx: V2ToolContext,
  internalContext?: Readonly<Record<string, string>>,
): RA<StartWorkflowResult, StartWorkflowError> {
  const deps = {
    gate: ctx.v2.gate,
    sessionStore: ctx.v2.sessionStore,
    snapshotStore: ctx.v2.snapshotStore,
    pinnedStore: ctx.v2.pinnedStore,
    crypto: ctx.v2.crypto,
    tokenCodecPorts: ctx.v2.tokenCodecPorts,
    idFactory: ctx.v2.idFactory,
    validationPipelineDeps: ctx.v2.validationPipelineDeps,
    tokenAliasStore: ctx.v2.tokenAliasStore,
    entropy: ctx.v2.entropy,
    resolvedRootUris: ctx.v2.resolvedRootUris,
    rememberedRootsStore: ctx.v2.rememberedRootsStore,
    managedSourceStore: ctx.v2.managedSourceStore,
    workspaceResolver: ctx.v2.workspaceResolver,
    fallbackWorkflowReader: ctx.workflowService,
    featureFlags: ctx.featureFlags,
  };

  return executeStartWorkflow(deps, { ...input, injectOnboarding: true }, internalContext)
    .map((res) => {
      const pending = toPendingStep(res.meta);
      const preferences = defaultPreferences;
      const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete: false, pending: res.meta });

      const contentEnvelope = buildStepContentEnvelope({
        meta: res.meta,
        references: res.resolvedReferences,
      });

      const startWarnings = res.managedStoreError !== undefined
        ? [`Managed workflow source store was temporarily unavailable (${res.managedStoreError}). Managed sources were not loaded.`]
        : undefined;

      const parsed: z.infer<typeof V2StartWorkflowOutputSchema> = {
        continueToken: res.continueToken,
        checkpointToken: res.checkpointToken,
        isComplete: false,
        pending,
        preferences,
        nextIntent,
        nextCall: buildNextCall({ continueToken: res.continueToken, isComplete: false, pending }),
        ...(res.stalePaths.length > 0 ? { staleRoots: [...res.stalePaths] } : {}),
        ...(startWarnings !== undefined ? { warnings: startWarnings } : {}),
      };

      return {
        response: parsed,
        contentEnvelope,
        sessionId: res.sessionId,
      };
    })
    .mapErr((err) => err as StartWorkflowError);
}

export { executeStartWorkflowMCP as executeStartWorkflow };
