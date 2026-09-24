import { afterEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { DaemonExecutionPolicy } from '../../../src/answer-v1/daemon-policy.js';
import { createAnswerTransport, type AnswerTransportCredentials } from '../../../src/daemon/runner/answer-transport.js';

const policy = (provider: 'anthropic' | 'amazon_bedrock'): DaemonExecutionPolicy => ({
  formatVersion: 1, profile: 'daemon_answers_v1',
  model: provider === 'anthropic' ? { provider, modelId: 'pinned-model' } : { provider, modelId: 'pinned-model', region: 'us-east-1' },
  systemPrompt: 'Retained instructions',
  limits: { expiresAtMs: 100000, maxModelCalls: 10, maxOutputTokens: 321, stallTimeoutMs: 5000, callTimeoutMs: 5000 },
  workspace: { kind: 'existing', workspacePath: resolve('.') },
  delivery: { kind: 'none' }, restart: { kind: 'requires_explicit_reconciliation' },
});
const credentials = (provider: 'anthropic' | 'amazon_bedrock'): AnswerTransportCredentials => provider === 'anthropic'
  ? { provider, apiKey: 'fake-explicit-key' }
  : { provider, accessKeyId: 'fake-access', secretAccessKey: 'fake-secret', sessionToken: 'fake-session' };
const input = { messages: [{ role: 'user' as const, content: 'Hello' }], tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' as const, properties: {} } }] };
const success = () => new Response(JSON.stringify({ id: 'reply', type: 'message', role: 'assistant', model: 'pinned-model',
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllEnvs());

it.each(['anthropic', 'amazon_bedrock'] as const)('pins %s settings and credentials despite ambient defaults and caller overrides', async provider => {
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://wrong.invalid');
  vi.stubEnv('ANTHROPIC_BEDROCK_BASE_URL', 'https://wrong.invalid');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-token');
  vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-anthropic-key');
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'ambient-bedrock-token');
  vi.stubEnv('AWS_REGION', 'eu-west-1');
  let requests = 0;
  const retained = policy(provider);
  const transport = createAnswerTransport(retained, credentials(provider), async (url, init) => {
    requests++;
    expect(init?.redirect).toBe('error');
    const address = new URL(String(url));
    expect(address.hostname).toBe(provider === 'anthropic' ? 'api.anthropic.com' : 'bedrock-runtime.us-east-1.amazonaws.com');
    const body = JSON.parse(String(init?.body));
    expect(body.system).toBe('Retained instructions');
    expect(body.max_tokens).toBe(321);
    expect(body.messages).toEqual(input.messages);
    expect(body.tools).toEqual(input.tools);
    if (provider === 'anthropic') {
      expect(body.model).toBe('pinned-model');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('fake-explicit-key');
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
    } else {
      expect(address.pathname).toContain('/model/pinned-model/invoke');
      expect(new Headers(init?.headers).get('x-api-key')).toBeNull();
      expect(new Headers(init?.headers).get('authorization')).toContain('Credential=fake-access/');
      expect(new Headers(init?.headers).get('x-amz-security-token')).toBe('fake-session');
    }
    return success();
  });
  if (transport.kind !== 'created') throw new Error(transport.reason);
  Reflect.set(retained, 'systemPrompt', 'changed after creation');
  const caller = { ...input, model: 'override', system: 'override', max_tokens: 999, stream: true };
  expect((await transport.send(caller, AbortSignal.timeout(5000))).id).toBe('reply');
  expect(requests).toBe(1);
});

it.each(['anthropic', 'amazon_bedrock'] as const)('never retries %s retryable responses or connection failures', async provider => {
  for (const status of [401, 429, 500, 'connection'] as const) {
    let requests = 0;
    const transport = createAnswerTransport(policy(provider), credentials(provider), async () => {
      requests++;
      if (status === 'connection') throw new Error('connection lost');
      return new Response('{}', { status, headers: { 'retry-after-ms': '1', 'content-type': 'application/json' } });
    });
    if (transport.kind !== 'created') throw new Error(transport.reason);
    await expect(transport.send(input, AbortSignal.timeout(5000))).rejects.toBeDefined();
    expect(requests).toBe(1);
  }
});

it.each(['anthropic', 'amazon_bedrock'] as const)('does not send %s when cancelled before invocation', async provider => {
  let requests = 0;
  const transport = createAnswerTransport(policy(provider), credentials(provider), async () => { requests++; return success(); });
  if (transport.kind !== 'created') throw new Error(transport.reason);
  await expect(transport.send(input, AbortSignal.abort())).rejects.toBeDefined();
  expect(requests).toBe(0);
});

it('refuses mismatched or empty credentials, unsafe region and timer overflow before network work', () => {
  const fetch = async () => { throw new Error('must not fetch'); };
  expect(createAnswerTransport(policy('anthropic'), credentials('amazon_bedrock'), fetch)).toEqual({ kind: 'refused', reason: 'credential_mismatch' });
  expect(createAnswerTransport(policy('anthropic'), { provider: 'anthropic', apiKey: '' }, fetch)).toEqual({ kind: 'refused', reason: 'missing_credentials' });
  const badRegion = { ...policy('amazon_bedrock'), model: { provider: 'amazon_bedrock' as const, modelId: 'pinned', region: 'evil.invalid/path' } };
  expect(createAnswerTransport(badRegion, credentials('amazon_bedrock'), fetch)).toEqual({ kind: 'refused', reason: 'unsupported_region' });
  const base = policy('anthropic');
  expect(createAnswerTransport({ ...base, limits: { ...base.limits, callTimeoutMs: 2147483648 } }, credentials('anthropic'), fetch))
    .toEqual({ kind: 'refused', reason: 'unsupported_call_timeout' });
});

it.each(['anthropic', 'amazon_bedrock'] as const)('propagates %s call deadline without retry', async provider => {
  vi.useFakeTimers();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let requests = 0;
  let observedSignal: AbortSignal | null | undefined;
  const base = policy(provider);
  try {
    const transport = createAnswerTransport({ ...base, limits: { ...base.limits, callTimeoutMs: 100 } }, credentials(provider), async (_url, init) => {
      requests++; observedSignal = init?.signal; entered();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted fetch')), { once: true });
      });
    });
    if (transport.kind !== 'created') throw new Error(transport.reason);
    const rejected = expect(transport.send(input, new AbortController().signal)).rejects.toBeDefined();
    await started;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(observedSignal?.aborted).toBe(true);
    expect(requests).toBe(1);
  } finally { vi.useRealTimers(); }
});


it('signs China requests without a session token despite ambient AWS credentials', async () => {
  vi.stubEnv('AWS_SESSION_TOKEN', 'ambient-session');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'ambient-access');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'ambient-secret');
  const base = policy('amazon_bedrock');
  const transport = createAnswerTransport({ ...base, model: { provider: 'amazon_bedrock', modelId: 'pinned', region: 'cn-north-1' } },
    { provider: 'amazon_bedrock', accessKeyId: 'explicit', secretAccessKey: 'explicit-secret' }, async (url, init) => {
      expect(new URL(String(url)).hostname).toBe('bedrock-runtime.cn-north-1.amazonaws.com.cn');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-amz-security-token')).toBeNull();
      expect(headers.get('authorization')).toContain('Credential=explicit/');
      return success();
    });
  if (transport.kind !== 'created') throw new Error(transport.reason);
  expect((await transport.send(input, AbortSignal.timeout(5000))).id).toBe('reply');
});

it('refuses invalid policy and incomplete static Bedrock credentials', () => {
  const fetch = async () => { throw new Error('must not fetch'); };
  expect(createAnswerTransport({ ...policy('anthropic'), systemPrompt: '' }, credentials('anthropic'), fetch))
    .toEqual({ kind: 'refused', reason: 'invalid_policy' });
  for (const field of ['accessKeyId', 'secretAccessKey', 'sessionToken']) {
    const supplied = { provider: 'amazon_bedrock' as const, accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'token', [field]: '  ' };
    expect(createAnswerTransport(policy('amazon_bedrock'), supplied, fetch)).toEqual({ kind: 'refused', reason: 'missing_credentials' });
  }
});

it.each(['anthropic', 'amazon_bedrock'] as const)('cancels in-flight %s fetch without retry', async provider => {
  const control = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let requests = 0;
  let observed: AbortSignal | null | undefined;
  const transport = createAnswerTransport(policy(provider), credentials(provider), async (_url, init) => {
    requests++; observed = init?.signal; entered();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('cancelled fetch')), { once: true });
    });
  });
  if (transport.kind !== 'created') throw new Error(transport.reason);
  const rejected = expect(transport.send(input, control.signal)).rejects.toBeDefined();
  await started; control.abort(); await rejected;
  expect(observed?.aborted).toBe(true);
  expect(requests).toBe(1);
});
