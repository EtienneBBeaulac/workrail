#!/usr/bin/env node

/**
 * Stamps a workflow JSON file with the current authoring spec version.
 *
 * Writes `validatedAgainstSpecVersion: N` to the workflow file, where N is the
 * current `version` in `spec/authoring-spec.json`. The stamp is what clears the
 * 'possible' staleness flag in list_workflows and inspect_workflow output.
 *
 * Usage:
 *   node scripts/stamp-workflow.ts <path-to-workflow.json>
 *   npm run stamp-workflow -- workflows/my-workflow.json
 *
 * The file must be committed after stamping for the signal to take effect.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function main(): void {
  const workflowPath = process.argv[2];

  if (!workflowPath) {
    console.error('Usage: stamp-workflow <path-to-workflow.json>');
    process.exit(1);
  }

  const absoluteWorkflowPath = path.resolve(workflowPath);

  if (!fs.existsSync(absoluteWorkflowPath)) {
    console.error(`File not found: ${absoluteWorkflowPath}`);
    process.exit(1);
  }

  // Read current spec version
  const specPath = path.join(repoRoot, 'spec', 'authoring-spec.json');
  let specVersion: number;
  try {
    const spec: unknown = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    if (typeof spec !== 'object' || spec === null || !('version' in spec)) {
      console.error(`spec/authoring-spec.json has no 'version' field`);
      process.exit(1);
    }
    const v = (spec as Record<string, unknown>)['version'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      console.error(`spec/authoring-spec.json 'version' is not a positive integer: ${v}`);
      process.exit(1);
    }
    specVersion = v;
  } catch (err) {
    console.error(`Failed to read spec/authoring-spec.json: ${err}`);
    process.exit(1);
  }

  // Read and update the workflow file
  let workflow: Record<string, unknown>;
  try {
    workflow = JSON.parse(fs.readFileSync(absoluteWorkflowPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    console.error(`Failed to parse workflow file: ${err}`);
    process.exit(1);
  }

  if (!workflow['id']) {
    console.error(`File does not look like a workflow (no 'id' field): ${absoluteWorkflowPath}`);
    process.exit(1);
  }

  const previous = workflow['validatedAgainstSpecVersion'];
  workflow['validatedAgainstSpecVersion'] = specVersion;

  fs.writeFileSync(absoluteWorkflowPath, JSON.stringify(workflow, null, 2) + '\n', 'utf-8');

  const relPath = path.relative(repoRoot, absoluteWorkflowPath);
  if (previous === specVersion) {
    console.log(`${relPath}: already stamped at v${specVersion} (no change)`);
  } else if (previous === undefined) {
    console.log(`${relPath}: stamped with v${specVersion} (was unstamped)`);
  } else {
    console.log(`${relPath}: updated stamp from v${previous} to v${specVersion}`);
  }
  console.log(`Remember to commit ${relPath} for the staleness signal to take effect.`);
}

main();
