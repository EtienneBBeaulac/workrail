const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const repoRoot = path.resolve(__dirname, '..');
const schemaPath = path.join(repoRoot, 'spec', 'authoring-spec.schema.json');
const specPath = path.join(repoRoot, 'spec', 'authoring-spec.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fail(message, details) {
  console.error(message);
  if (details) {
    console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  }
  process.exit(1);
}

function validateAgainstSchema(schema, data) {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    fail('authoring-spec schema validation failed', validate.errors);
  }
}

function validateRuleIdsAndScopes(spec) {
  const knownScopes = new Set(spec.scopeCatalog.map((entry) => entry.id));
  const seenRuleIds = new Set();
  const duplicateRuleIds = [];
  const missingScopes = [];
  const badCurrentPlannedEnforcement = [];
  const badPlannedEnforcement = [];
  const badPlannedStatus = [];
  const missingRefs = [];

  const validateRef = (ref, ruleId, field) => {
    const fullPath = path.join(repoRoot, ref.path);
    if (!fs.existsSync(fullPath)) {
      missingRefs.push({ ruleId, field, path: ref.path });
      return;
    }

    if (ref.path.endsWith('.json')) {
      try {
        JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } catch (error) {
        missingRefs.push({
          ruleId,
          field,
          path: ref.path,
          reason: `Invalid JSON: ${error.message}`
        });
      }
    }
  };

  const visitRule = (rule, bucket) => {
    if (seenRuleIds.has(rule.id)) {
      duplicateRuleIds.push(rule.id);
    } else {
      seenRuleIds.add(rule.id);
    }

    for (const scope of rule.scope) {
      if (!knownScopes.has(scope)) {
        missingScopes.push({ ruleId: rule.id, scope });
      }
    }

    for (const ref of rule.exampleRefs ?? []) {
      validateRef(ref, rule.id, 'exampleRefs');
    }

    for (const ref of rule.sourceRefs ?? []) {
      validateRef(ref, rule.id, 'sourceRefs');
    }

    const hasPlanned = (rule.enforcement ?? []).includes('planned');
    const hasRuntimeTruth = (rule.enforcement ?? []).some((mode) =>
      mode === 'runtime' || mode === 'validator' || mode === 'ci'
    );

    if (bucket === 'current' && hasPlanned) {
      badCurrentPlannedEnforcement.push({ ruleId: rule.id, enforcement: rule.enforcement });
    }

    if (bucket === 'planned') {
      if (rule.status !== 'planned') {
        badPlannedStatus.push({ ruleId: rule.id, status: rule.status });
      }
      if (!hasPlanned || hasRuntimeTruth) {
        badPlannedEnforcement.push({ ruleId: rule.id, enforcement: rule.enforcement });
      }
    }
  };

  for (const topic of spec.topics) {
    for (const rule of topic.rules) {
      visitRule(rule, 'current');
    }
  }

  for (const topic of spec.plannedTopics ?? []) {
    for (const rule of topic.rules) {
      visitRule(rule, 'planned');
    }
  }

  for (const rule of spec.plannedRules ?? []) {
    visitRule(rule, 'planned');
  }

  if (
    duplicateRuleIds.length > 0 ||
    missingScopes.length > 0 ||
    badCurrentPlannedEnforcement.length > 0 ||
    badPlannedEnforcement.length > 0 ||
    badPlannedStatus.length > 0 ||
    missingRefs.length > 0
  ) {
    fail('authoring-spec structural sanity checks failed', {
      duplicateRuleIds,
      missingScopes,
      badCurrentPlannedEnforcement,
      badPlannedEnforcement,
      badPlannedStatus,
      missingRefs
    });
  }
}

function main() {
  const schema = readJson(schemaPath);
  const spec = readJson(specPath);

  validateAgainstSchema(schema, spec);
  validateRuleIdsAndScopes(spec);

  console.log('authoring-spec validation passed');
}

main();
