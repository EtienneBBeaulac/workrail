import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

async function observe(root) {
  const subject = pathToFileURL(`${realpathSync(root)}/src/mcp/handlers/v2-advance-core/assessment-consequences.ts`).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === subject) throw new Error('Undeclared assessment runtime import');
    return nextResolve(specifier, context);
  }});
  const { evaluateAssessmentConsequences } = await import(subject);
  const assessment = (assessmentId, level) => ({ assessmentId, normalizationNotes: [],
    dimensions: [{ dimensionId: 'confidence', level, normalization: 'exact' }] });
  const rule = (level, guidance) => ({ when: { forAssessment: 'named', anyEqualsLevel: level },
    effect: { kind: 'require_followup', guidance } });
  const low = rule('low', 'First guidance');
  const second = rule('low', 'Second guidance');
  const high = rule('high', 'High guidance');
  const other = assessment('other', 'low');
  const cases = [
    ['missing_named', [low], [other]],
    ['high_named', [low], [other, assessment('named', 'high')]],
    ['low_named', [low], [other, assessment('named', 'low')]],
    ['ordered', [low, second], [assessment('named', 'low')]],
    ['high_rule', [low, high], [other, assessment('named', 'high')]],
  ];
  return { version: 1, rows: cases.map(([name, consequences, recordedAssessments]) => ({
    case: name, effects: evaluateAssessmentConsequences({
      step: { id: 'step', title: 'Step', prompt: 'Assess', assessmentRefs: ['named', 'other'],
        assessmentConsequences: consequences }, recordedAssessments,
    }),
  })) };
}

try {
  if (process.argv.length !== 3) throw new Error('Expected one source root');
  process.stdout.write(JSON.stringify(await observe(process.argv[2])));
} catch {
  process.stderr.write('Assessment consequence observation unavailable\n');
  process.exitCode = 2;
}
