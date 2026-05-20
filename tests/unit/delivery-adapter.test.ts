import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  synthesizeDeliveryConfig,
  CliInboxAdapter,
  type DeliveryConfig,
  type DeliveryPayload,
} from '../../src/trigger/delivery-adapter.js';

// ---------------------------------------------------------------------------
// synthesizeDeliveryConfig
// ---------------------------------------------------------------------------

describe('synthesizeDeliveryConfig', () => {
  const reviewer = { platform: 'github', token: 'tok', login: 'user' };

  it('returns cli_inbox when no fields are set', () => {
    expect(synthesizeDeliveryConfig({})).toEqual({ source: 'synthesized', adapters: [{ kind: 'cli_inbox' }] });
  });

  it('returns git_commit when autoCommit is true', () => {
    const result = synthesizeDeliveryConfig({ autoCommit: true });
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]).toEqual({ kind: 'git_commit', autoOpenPR: false, secretScan: true });
  });

  it('reflects autoOpenPR and secretScan on git_commit adapter', () => {
    const result = synthesizeDeliveryConfig({ autoCommit: true, autoOpenPR: true, secretScan: false });
    expect(result.adapters[0]).toEqual({ kind: 'git_commit', autoOpenPR: true, secretScan: false });
  });

  it('returns github_draft_review when reviewerIdentity is set', () => {
    const result = synthesizeDeliveryConfig({ reviewerIdentity: reviewer });
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]).toEqual({ kind: 'github_draft_review', token: 'tok', login: 'user' });
  });

  it('does NOT include callback_url in synthesized adapters (callbackUrl has its own delivery path)', () => {
    // callbackUrl fires via deliveryPost() in trigger-router.ts, not through the adapter loop.
    // Adding it to synthesized adapters would create a dead entry that warns "not yet activated".
    const result = synthesizeDeliveryConfig({ callbackUrl: 'https://example.com/hook' });
    expect(result.adapters.every(a => a.kind !== 'callback_url')).toBe(true);
    // No other delivery configured -- falls back to cli_inbox
    expect(result.adapters[0]!.kind).toBe('cli_inbox');
  });

  it('puts git_commit before github_draft_review when both are set', () => {
    const result = synthesizeDeliveryConfig({ autoCommit: true, reviewerIdentity: reviewer });
    expect(result.adapters).toHaveLength(2);
    // WHY order matters: branch must exist before review can reference it
    expect(result.adapters[0]!.kind).toBe('git_commit');
    expect(result.adapters[1]!.kind).toBe('github_draft_review');
  });

  it('returns only git_commit and github_draft_review (not callback_url) when all three legacy fields set', () => {
    const result = synthesizeDeliveryConfig({
      autoCommit: true,
      reviewerIdentity: reviewer,
      callbackUrl: 'https://example.com/hook',
    });
    expect(result.adapters.map(a => a.kind)).toEqual(['git_commit', 'github_draft_review']);
  });
});

// ---------------------------------------------------------------------------
// CliInboxAdapter
// ---------------------------------------------------------------------------

describe('CliInboxAdapter', () => {
  let tmpDir: string;
  let adapter: CliInboxAdapter;

  const payload: DeliveryPayload = {
    workflowId: 'wr.test',
    sessionId: 'sess_abc123',
    goal: 'run unit test',
    notes: null,
    artifacts: [],
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-adapter-test-'));
    adapter = new CliInboxAdapter(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a valid JSON outbox entry and returns completed receipt', async () => {
    const receipt = await adapter.deliver(payload, { kind: 'cli_inbox' });

    expect(receipt.kind).toBe('completed');

    const outboxPath = path.join(tmpDir, 'outbox.jsonl');
    const content = await fs.readFile(outboxPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]!) as { id: string; message: string; timestamp: string };
    expect(typeof entry.id).toBe('string');
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/); // UUID v4 format
    expect(entry.message).toContain('wr.test');
    expect(entry.message).toContain('run unit test');
    expect(typeof entry.timestamp).toBe('string');
    expect(() => new Date(entry.timestamp)).not.toThrow();
  });

  it('appends multiple entries on successive calls', async () => {
    await adapter.deliver(payload, { kind: 'cli_inbox' });
    await adapter.deliver({ ...payload, goal: 'second call' }, { kind: 'cli_inbox' });

    const outboxPath = path.join(tmpDir, 'outbox.jsonl');
    const content = await fs.readFile(outboxPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('returns error receipt (not throw) when the outbox directory does not exist', async () => {
    const badAdapter = new CliInboxAdapter(path.join(tmpDir, 'nonexistent', 'deep', 'path'));
    const receipt = await badAdapter.deliver(payload, { kind: 'cli_inbox' });

    expect(receipt.kind).toBe('error');
    if (receipt.kind === 'error') {
      expect(typeof receipt.message).toBe('string');
      expect(receipt.retryable).toBe(false);
    }
  });

  it('adapterKind is cli_inbox', () => {
    expect(adapter.adapterKind).toBe('cli_inbox');
  });
});
