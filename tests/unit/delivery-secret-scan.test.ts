/**
 * Tests for the secret scan feature in src/trigger/delivery-action.ts
 *
 * Covers:
 * - scanForSecrets(): pure function, all critical patterns
 * - runDelivery() integration: scan gate, opt-out via secretScan: false
 *
 * Key invariant tested explicitly: the matched secret VALUE is never present in
 * the error message. Only pattern name, file path, and line number are surfaced.
 *
 * All tests use an injected fake execFn -- no child_process mock.
 * Call sequence when secretScan is enabled:
 *   Call 0: git add <files>
 *   Call 1: git diff --cached  (returns staged diff)
 *   Call 2: git commit -m <message>
 */

import { describe, expect, it, vi } from 'vitest';
import { scanForSecrets, runDelivery } from '../../src/trigger/delivery-action.js';
import type { HandoffArtifact, DeliveryFlags, ExecFn } from '../../src/trigger/delivery-action.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArtifact(overrides: Partial<HandoffArtifact> = {}): HandoffArtifact {
  return {
    commitType: 'feat',
    commitScope: 'trigger',
    commitSubject: 'feat(trigger): add secret scan',
    prTitle: 'feat(trigger): add secret scan',
    prBody: '## Summary\n- Added secret scan\n\n## Test plan\n- [ ] Tests pass',
    filesChanged: ['src/trigger/delivery-action.ts'],
    followUpTickets: [],
    ...overrides,
  };
}

function makeFlags(overrides: Partial<DeliveryFlags> = {}): DeliveryFlags {
  return { autoCommit: true, autoOpenPR: false, ...overrides };
}

// ---------------------------------------------------------------------------
// scanForSecrets() -- pure function tests (no execFn needed)
// ---------------------------------------------------------------------------

describe('scanForSecrets', () => {
  it('returns found=false for a clean diff with no secrets', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 export { x };
`;
    const result = scanForSecrets(diff);
    expect(result.found).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it('detects a GitHub token (ghp_ pattern) in an added line', () => {
    const fakeToken = 'ghp_' + 'A'.repeat(36);
    const diff = `diff --git a/src/config.ts b/src/config.ts
index abc1234..def5678 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const token = '${fakeToken}';
 export { x };
`;
    const result = scanForSecrets(diff);
    expect(result.found).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.name).toBe('GitHub token');
    expect(result.findings[0]?.file).toBe('src/config.ts');
    // Hunk starts at new line 1. Context line "const x = 1" = line 1. Added line = line 2.
    expect(result.findings[0]?.lineNumber).toBe(2);
  });

  it('detects an Anthropic key (sk-ant- pattern)', () => {
    const fakeKey = 'sk-ant-' + 'A'.repeat(90);
    const diff = `diff --git a/src/llm.ts b/src/llm.ts
index abc1234..def5678 100644
--- a/src/llm.ts
+++ b/src/llm.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const apiKey = '${fakeKey}';
 export {};
`;
    const result = scanForSecrets(diff);
    expect(result.found).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    const anthropicFinding = result.findings.find(f => f.name === 'Anthropic key');
    expect(anthropicFinding).toBeDefined();
    expect(anthropicFinding?.file).toBe('src/llm.ts');
  });

  it('does NOT include the matched value in findings -- only name, file, lineNumber', () => {
    const fakeToken = 'ghp_' + 'B'.repeat(36);
    const diff = `diff --git a/src/secret.ts b/src/secret.ts
index abc1234..def5678 100644
--- a/src/secret.ts
+++ b/src/secret.ts
@@ -1,1 +1,2 @@
+const tok = '${fakeToken}';
 export {};
`;
    const result = scanForSecrets(diff);
    expect(result.found).toBe(true);
    expect(result.findings).toHaveLength(1);

    // Critical invariant: the actual secret value must NOT appear anywhere in the findings
    const finding = result.findings[0];
    expect(finding).toBeDefined();
    if (finding) {
      // The finding object only has name, file, lineNumber -- no value field
      expect(Object.keys(finding)).toEqual(['name', 'file', 'lineNumber']);
      // Extra safety: the token itself is not stringified anywhere in the finding
      expect(JSON.stringify(finding)).not.toContain(fakeToken);
    }
  });

  it('detects a PEM private key header', () => {
    const diff = `diff --git a/keys/private.pem b/keys/private.pem
index abc1234..def5678 100644
--- a/keys/private.pem
+++ b/keys/private.pem
@@ -0,0 +1,3 @@
+-----BEGIN RSA PRIVATE KEY-----
+MIIEowIBAAKCAQEA...
+-----END RSA PRIVATE KEY-----
`;
    const result = scanForSecrets(diff);
    expect(result.found).toBe(true);
    const keyFinding = result.findings.find(f => f.name === 'Private key');
    expect(keyFinding).toBeDefined();
    expect(keyFinding?.file).toBe('keys/private.pem');
  });

  it('returns found=false for an empty diff', () => {
    const result = scanForSecrets('');
    expect(result.found).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it('does NOT flag secrets on removed lines (- prefix)', () => {
    // A secret being removed is a GOOD thing -- do not flag it
    const fakeToken = 'ghp_' + 'C'.repeat(36);
    const diff = `diff --git a/src/old.ts b/src/old.ts
index abc1234..def5678 100644
--- a/src/old.ts
+++ b/src/old.ts
@@ -1,3 +1,2 @@
 const x = 1;
-const oldToken = '${fakeToken}';
 export {};
`;
    const result = scanForSecrets(diff);
    expect(result.found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runDelivery() integration tests -- secret scan gate
// ---------------------------------------------------------------------------

describe('runDelivery -- secret scan gate', () => {
  /**
   * Build a fake execFn for the commit-only flow with secret scan enabled.
   * Call order: 0=git add, 1=git diff --cached, 2=gitleaks (ENOENT), 3=git commit
   *
   * WHY gitleaks call: runDelivery() attempts gitleaks after the pattern scan.
   * In tests gitleaks is not installed, so it throws ENOENT. The fake simulates this.
   */
  function makeExecWithCleanDiff(commitOutput = '[main abc1234] feat(trigger): add secret scan'): ExecFn {
    const gitleaksNotFound = Object.assign(new Error('gitleaks: command not found'), { code: 'ENOENT' });
    return vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                 // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                 // git diff --cached (empty = clean)
      .mockRejectedValueOnce(gitleaksNotFound)                           // gitleaks (ENOENT = not installed)
      .mockResolvedValueOnce({ stdout: commitOutput, stderr: '' }) as ExecFn;  // git commit
  }

  it('passes through cleanly when staged diff contains no secrets', async () => {
    const exec = makeExecWithCleanDiff();
    const result = await runDelivery(makeArtifact(), '/workspace', makeFlags(), exec);
    expect(result._tag).toBe('committed');
    // Verify git diff --cached was called
    const calls = (exec as ReturnType<typeof vi.fn>).mock.calls;
    const diffCall = calls.find((c: unknown[]) => Array.isArray(c) && c[0] === 'git' && Array.isArray(c[1]) && (c[1] as string[]).includes('diff'));
    expect(diffCall).toBeDefined();
  });

  it('returns phase: secret_scan error when diff contains a GitHub token', async () => {
    const fakeToken = 'ghp_' + 'D'.repeat(36);
    const dirtyDiff = `diff --git a/src/config.ts b/src/config.ts
index abc1234..def5678 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,1 +1,2 @@
+const tok = '${fakeToken}';
 export {};
`;
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                         // git add
      .mockResolvedValueOnce({ stdout: dirtyDiff, stderr: '' }) as ExecFn;      // git diff --cached

    const result = await runDelivery(makeArtifact(), '/workspace', makeFlags(), exec);
    expect(result._tag).toBe('error');
    if (result._tag === 'error') {
      expect(result.phase).toBe('secret_scan');
      // Details must mention the pattern name, file, and line number
      expect(result.details).toContain('GitHub token');
      expect(result.details).toContain('src/config.ts');
      // Details must NOT contain the actual secret value
      expect(result.details).not.toContain(fakeToken);
      // Details should include the opt-out hint
      expect(result.details).toContain('secretScan: false');
    }
    // git commit must NOT have been called -- delivery aborted before commit
    const calls = (exec as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>;
    const commitCall = calls.find(([file, args]) => file === 'git' && args[0] === 'commit');
    expect(commitCall).toBeUndefined();
  });

  it('returns phase: secret_scan error for Anthropic key (sk-ant- pattern)', async () => {
    const fakeKey = 'sk-ant-' + 'E'.repeat(90);
    const dirtyDiff = `diff --git a/src/llm.ts b/src/llm.ts
index abc1234..def5678 100644
--- a/src/llm.ts
+++ b/src/llm.ts
@@ -1,1 +1,2 @@
+const k = '${fakeKey}';
 export {};
`;
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: dirtyDiff, stderr: '' }) as ExecFn;

    const result = await runDelivery(makeArtifact(), '/workspace', makeFlags(), exec);
    expect(result._tag).toBe('error');
    if (result._tag === 'error') {
      expect(result.phase).toBe('secret_scan');
      expect(result.details).toContain('Anthropic key');
      // The actual key value must NOT appear in the error message
      expect(result.details).not.toContain(fakeKey);
    }
  });

  it('skips the scan entirely when secretScan: false is set in flags', async () => {
    // With secretScan: false, call sequence is: git add (0), git commit (1) -- no diff call
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                              // git add
      .mockResolvedValueOnce({ stdout: '[main abc1234] feat', stderr: '' }) as ExecFn; // git commit

    const flags = makeFlags({ secretScan: false });
    const result = await runDelivery(makeArtifact(), '/workspace', flags, exec);
    expect(result._tag).toBe('committed');

    // Only 2 calls: git add + git commit. No git diff --cached call.
    expect((exec as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    const calls = (exec as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>;
    const diffCall = calls.find(([file, args]) => file === 'git' && args.includes('diff'));
    expect(diffCall).toBeUndefined();
  });

  it('does NOT include the matched value in the error message (invariant)', async () => {
    const secretValue = 'ghp_' + 'F'.repeat(36);
    const dirtyDiff = `diff --git a/src/cfg.ts b/src/cfg.ts
index abc..def 100644
--- a/src/cfg.ts
+++ b/src/cfg.ts
@@ -1,1 +1,2 @@
+const t = '${secretValue}';
 export {};
`;
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: dirtyDiff, stderr: '' }) as ExecFn;

    const result = await runDelivery(makeArtifact(), '/workspace', makeFlags(), exec);
    expect(result._tag).toBe('error');
    if (result._tag === 'error') {
      // The actual secret value must NEVER appear in any part of the error output
      expect(result.details).not.toContain(secretValue);
      expect(result.phase).toBe('secret_scan');
    }
  });

  it('detects -----BEGIN RSA PRIVATE KEY----- in staged diff', async () => {
    const dirtyDiff = `diff --git a/keys/id_rsa b/keys/id_rsa
index abc..def 100644
--- a/keys/id_rsa
+++ b/keys/id_rsa
@@ -0,0 +1,3 @@
+-----BEGIN RSA PRIVATE KEY-----
+MIIEowIBAAKCAQEA...
+-----END RSA PRIVATE KEY-----
`;
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: dirtyDiff, stderr: '' }) as ExecFn;

    const result = await runDelivery(makeArtifact(), '/workspace', makeFlags(), exec);
    expect(result._tag).toBe('error');
    if (result._tag === 'error') {
      expect(result.phase).toBe('secret_scan');
      expect(result.details).toContain('Private key');
    }
  });
});
