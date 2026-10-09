import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

it('keeps the model selection authoring contract aligned with MCP behavior', () => {
  const root = resolve(__dirname, '../..');
  const spec = JSON.parse(readFileSync(resolve(root, 'spec/authoring-spec.json'), 'utf8'));
  const rules = spec.topics.flatMap((section: any) => section.rules);
  const rule = rules.find((candidate: any) => candidate.id === 'workflow-model-tier');
  expect(rule.sourceRefs.some((ref: any) => ref.path === 'src/v2/durable-core/domain/model-selection.ts')).toBe(true);
  expect(rule.checks.join('\n')).toContain('modelRouting');
  const guide = readFileSync(resolve(root, 'docs/authoring-v2.md'), 'utf8');
  expect(guide).toContain('modelRouting');
  expect(guide).toContain('initialModelRequest');
  expect(guide).toContain('client');
  expect(guide).not.toContain('Default to `mid` tier model ID');
  const executor = readFileSync(resolve(root, 'assets/agent-configs/firebender/workrail-executor.md'), 'utf8');
  expect(executor).toContain('modelRouting');
  expect(executor).toContain('unsupported');
});
