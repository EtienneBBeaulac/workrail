/**
 * Anthropic client construction for daemon agent sessions.
 *
 * WHY this module: buildAgentClient is a pure function that selects and
 * constructs the correct LLM client from trigger config and process env.
 * No I/O, no file system access. The SDK imports are here (not in core/)
 * because this module constructs SDK client objects -- it is the I/O boundary
 * for LLM client setup.
 *
 * WHY NOT in core/: this module imports @anthropic-ai/sdk and
 * @anthropic-ai/bedrock-sdk, which are SDK dependencies (not pure code).
 * The architecture test for core/ excludes agent-client.ts from the
 * no-SDK-imports rule precisely because it must import these SDKs.
 *
 * Callers: buildPreAgentSession() in workflow-runner.ts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { WorkflowTrigger } from '../types.js';

/**
 * Build the Anthropic (or AnthropicBedrock) client and resolve the model ID.
 *
 * Pure: no I/O. Reads only the trigger config and process.env.
 * Throws with a clear message on invalid model format -- the caller wraps
 * in a try/catch that returns _tag: 'error'.
 *
 * WHY pure: model selection is a pure computation from trigger + env. Extracting
 * it makes the logic testable without real API keys or a running daemon session.
 *
 * Model format: "provider/model-id" (e.g. "amazon-bedrock/claude-sonnet-4-6").
 * When absent, detects AWS credentials in env (Bedrock) vs. direct API key.
 *
 * @param trigger - WorkflowTrigger carrying optional agentConfig.model override.
 * @param apiKey - Anthropic API key (used only when not using Bedrock).
 * @param env - Process environment variables (for AWS credential detection).
 */
export function buildAgentClient(
  trigger: WorkflowTrigger,
  apiKey: string,
  env: NodeJS.ProcessEnv,
): { agentClient: Anthropic | AnthropicBedrock; modelId: string } {
  if (trigger.agentConfig?.model) {
    // Parse "provider/model-id" -- split on the first slash only.
    const slashIdx = trigger.agentConfig.model.indexOf('/');
    if (slashIdx === -1) {
      throw new Error(
        `agentConfig.model must be in "provider/model-id" format, got: "${trigger.agentConfig.model}"`,
      );
    }
    const provider = trigger.agentConfig.model.slice(0, slashIdx);
    const modelId = trigger.agentConfig.model.slice(slashIdx + 1);
    const agentClient: Anthropic | AnthropicBedrock =
      provider === 'amazon-bedrock' ? new AnthropicBedrock() : new Anthropic({ apiKey });
    return { agentClient, modelId };
  }

  // Default: use Bedrock when AWS credentials are present, direct API otherwise.
  // WHY: avoids personal API key charges when AWS credentials are available.
  const usesBedrock = !!env['AWS_PROFILE'] || !!env['AWS_ACCESS_KEY_ID'];
  if (usesBedrock) {
    return {
      agentClient: new AnthropicBedrock(),
      modelId: 'us.anthropic.claude-sonnet-4-6',
    };
  }
  return {
    agentClient: new Anthropic({ apiKey }),
    modelId: 'claude-sonnet-4-6',
  };
}
