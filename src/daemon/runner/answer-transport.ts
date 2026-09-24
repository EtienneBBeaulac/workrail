import Anthropic from '@anthropic-ai/sdk';
import type { ClientOptions } from '@anthropic-ai/sdk/client';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { decodeDaemonExecutionPolicy, type DaemonExecutionPolicy } from '../../answer-v1/daemon-policy.js';

/** Ephemeral credentials, never part of a retained execution policy. */
export type AnswerTransportCredentials =
  | Readonly<{ provider: 'anthropic'; apiKey: string }>
  | Readonly<{ provider: 'amazon_bedrock'; accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;

export type AnswerTransportInput = Pick<Anthropic.MessageCreateParamsNonStreaming, 'messages' | 'tools'>;
export type CreateAnswerTransportResult =
  | Readonly<{ kind: 'created'; send(input: AnswerTransportInput, signal: AbortSignal): Promise<Anthropic.Message> }>
  | Readonly<{ kind: 'refused'; reason: 'invalid_policy' | 'credential_mismatch' | 'missing_credentials' | 'unsupported_region' | 'unsupported_call_timeout' }>;

/** One send is one SDK attempt. The host must reserve budget before calling it.
 * Only conversation and tools vary per call; retained model, prompt and output limit
 * cannot be overridden by the loop. This does not grant execution or restart authority. */
export function createAnswerTransport(
  policy: DaemonExecutionPolicy,
  credentials: AnswerTransportCredentials,
  fetch: NonNullable<ClientOptions['fetch']>,
): CreateAnswerTransportResult {
  const decoded = decodeDaemonExecutionPolicy(policy);
  if (decoded.kind !== 'validated') return { kind: 'refused', reason: 'invalid_policy' };
  const retained = decoded.policy;
  if (retained.model.provider !== credentials.provider) return { kind: 'refused', reason: 'credential_mismatch' };
  if (retained.limits.callTimeoutMs > 2147483647) return { kind: 'refused', reason: 'unsupported_call_timeout' };
  const settings = { fetch, maxRetries: 0, timeout: retained.limits.callTimeoutMs, fetchOptions: { redirect: 'error' as const } };
  let client: Anthropic | AnthropicBedrock;
  if (credentials.provider === 'anthropic') {
    if (!credentials.apiKey.trim()) return { kind: 'refused', reason: 'missing_credentials' };
    client = new Anthropic({ ...settings, apiKey: credentials.apiKey, authToken: null,
      baseURL: 'https://api.anthropic.com' });
  } else {
    if (!credentials.accessKeyId.trim() || !credentials.secretAccessKey.trim()
      || credentials.sessionToken !== undefined && !credentials.sessionToken.trim())
      return { kind: 'refused', reason: 'missing_credentials' };
    // The endpoint is constructed here, never taken from mutable environment defaults.
    if (retained.model.provider !== 'amazon_bedrock') return { kind: 'refused', reason: 'credential_mismatch' };
    const region = retained.model.region;
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) return { kind: 'refused', reason: 'unsupported_region' };
    const domain = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
    client = new AnthropicBedrock({ ...settings, apiKey: '', awsRegion: region,
      awsAccessKey: credentials.accessKeyId, awsSecretKey: credentials.secretAccessKey,
      awsSessionToken: credentials.sessionToken ?? null, skipAuth: false,
      // The Bedrock SDK inherits the direct SDK's ambient API-key fallback.
      defaultHeaders: { 'x-api-key': null },
      baseURL: `https://bedrock-runtime.${region}.${domain}` });
  }
  return { kind: 'created', async send(input, signal) {
    return client.messages.create({ messages: input.messages, tools: input.tools,
      model: retained.model.modelId, system: retained.systemPrompt, max_tokens: retained.limits.maxOutputTokens,
    }, { signal });
  } };
}
