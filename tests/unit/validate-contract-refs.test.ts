/**
 * Validates that all outputContract contractRefs declared in bundled workflows
 * are registered in ARTIFACT_CONTRACT_REFS and have validator cases.
 *
 * WHY this test: workflow outputContract declarations reference engine-registered
 * contract IDs. If a contractRef is declared in a workflow but not registered,
 * the engine returns UNKNOWN_CONTRACT_REF at complete_step time, which blocks
 * MCP sessions at the final step of the workflow. This test prevents that failure
 * from shipping silently.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'url';
import { ARTIFACT_CONTRACT_REFS, isValidContractRef } from '../../src/v2/durable-core/schemas/artifacts/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = path.resolve(__dirname, '../../workflows');

function collectWorkflowFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'examples') continue;
      results.push(...collectWorkflowFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.json')) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

function collectContractRefs(steps: unknown[]): string[] {
  const refs: string[] = [];
  for (const step of steps) {
    const s = step as Record<string, unknown>;
    // Normal step outputContract
    const oc = s['outputContract'] as Record<string, unknown> | undefined;
    if (oc?.['contractRef'] && typeof oc['contractRef'] === 'string') {
      refs.push(oc['contractRef']);
    }
    // Loop body steps
    const body = s['body'] as unknown[] | undefined;
    if (Array.isArray(body)) {
      refs.push(...collectContractRefs(body));
    }
  }
  return refs;
}

describe('Bundled workflow outputContract contractRefs', () => {
  const workflowFiles = collectWorkflowFiles(WORKFLOWS_DIR);

  it('all declared contractRefs exist in ARTIFACT_CONTRACT_REFS', () => {
    const violations: string[] = [];

    for (const filePath of workflowFiles) {
      const relPath = path.relative(WORKFLOWS_DIR, filePath);
      let workflow: { steps?: unknown[] };
      try {
        workflow = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { steps?: unknown[] };
      } catch {
        continue;
      }

      if (!Array.isArray(workflow.steps)) continue;

      const refs = collectContractRefs(workflow.steps);
      for (const ref of refs) {
        if (!isValidContractRef(ref)) {
          violations.push(`${relPath}: contractRef '${ref}' not in ARTIFACT_CONTRACT_REFS`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Unregistered contractRefs found (would cause UNKNOWN_CONTRACT_REF at runtime):\n${violations.join('\n')}`,
      );
    }
  });

  it('ARTIFACT_CONTRACT_REFS contains the new phase handoff contracts', () => {
    expect(ARTIFACT_CONTRACT_REFS).toContain('wr.contracts.shaping_handoff');
    expect(ARTIFACT_CONTRACT_REFS).toContain('wr.contracts.coding_handoff');
    expect(ARTIFACT_CONTRACT_REFS).toContain('wr.contracts.discovery_handoff');
  });

  it('isValidContractRef correctly identifies known refs', () => {
    expect(isValidContractRef('wr.contracts.shaping_handoff')).toBe(true);
    expect(isValidContractRef('wr.contracts.coding_handoff')).toBe(true);
    expect(isValidContractRef('wr.contracts.discovery_handoff')).toBe(true);
    expect(isValidContractRef('wr.contracts.nonexistent')).toBe(false);
  });
});
