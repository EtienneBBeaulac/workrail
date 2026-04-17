/**
 * validate-authoring-coverage.js
 *
 * Checks that key workflow authoring surfaces each have at least one active rule
 * in spec/authoring-spec.json. Uses a frozen manifest approach: a labeled map of
 * { humanLabel: scopeId } pairs. Each scope ID must appear in at least one
 * status:"active" rule's scope array.
 *
 * Exit 0 = all required scopes are covered.
 * Exit 1 = one or more required scopes have no active rule coverage.
 *
 * Advisory (non-failing) warning is emitted if a required scope ID is not in the
 * scopeCatalog. The catalog check is informational; coverage is the hard gate.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const specPath = path.join(repoRoot, 'spec', 'authoring-spec.json');

// ---------------------------------------------------------------------------
// Required scopes manifest
//
// Each key is a human-readable label; each value is the exact scope ID that
// must appear in at least one active rule's scope array.
//
// This is a frozen manifest -- new authoring surfaces must be added here
// manually when active rules are authored for them.
//
// TODO: Add the following scopes once active rules are authored for them:
//   - step.context-capture      (runCondition is underdocumented)
//   - workflow.extension-points (templateCall has no dedicated active rule yet)
//   - step.prompt-blocks        (the promptBlocks structure has no active rule)
// ---------------------------------------------------------------------------
const REQUIRED_SCOPES = Object.freeze({
  metaGuidance:           'workflow.meta-guidance',
  features:               'workflow.features',
  references:             'workflow.references',
  assessments:            'workflow.assessments',
  promptFragments:        'step.prompt-fragment',
  requireConfirmation:    'step.confirmation',
  outputContract:         'step.output-requirements',
  assessmentRefs:         'step.assessment-refs',
  assessmentConsequences: 'step.assessment-consequences',
  loop:                   'loop.step',
  loopDecision:           'loop.decision',
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fail(message, details) {
  console.error(message);
  if (details) {
    if (typeof details === 'string') {
      console.error(details);
    } else {
      console.error(JSON.stringify(details, null, 2));
    }
  }
  process.exit(1);
}

/**
 * Collect all scope IDs covered by at least one status:"active" rule.
 * Only iterates spec.topics -- spec.plannedTopics and spec.plannedRules
 * contain planned-status rules which do not count as active coverage.
 */
function collectActiveScopeIds(spec) {
  const activeScopes = new Set();
  for (const topic of spec.topics ?? []) {
    for (const rule of topic.rules ?? []) {
      if (rule.status === 'active') {
        for (const scopeId of rule.scope ?? []) {
          activeScopes.add(scopeId);
        }
      }
    }
  }
  return activeScopes;
}

function main() {
  const spec = readJson(specPath);

  const catalogScopeIds = new Set((spec.scopeCatalog ?? []).map((entry) => entry.id));
  const activeScopeIds = collectActiveScopeIds(spec);

  const uncoveredLabels = [];

  for (const [label, scopeId] of Object.entries(REQUIRED_SCOPES)) {
    // Advisory: warn if the scope ID is not in the catalog (spec inconsistency)
    if (!catalogScopeIds.has(scopeId)) {
      console.warn(
        `[authoring-coverage] advisory: scope "${scopeId}" (${label}) is not in scopeCatalog -- ` +
        `this may indicate a spec inconsistency`
      );
    }

    // Coverage check: fail if no active rule covers this scope ID
    if (!activeScopeIds.has(scopeId)) {
      uncoveredLabels.push({ label, scopeId });
    }
  }

  if (uncoveredLabels.length > 0) {
    fail('authoring-coverage check failed: required scopes have no active rule coverage', {
      uncoveredScopes: uncoveredLabels,
    });
  }

  console.log('authoring-coverage check passed');
}

main();
