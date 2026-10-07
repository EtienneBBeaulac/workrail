"""Assessment scope/order mutants and strict unavailable-evidence controls."""
import argparse
import copy
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
MODEL = runpy.run_path(str(BASE/'assessment-scoping.py'))
NODE = None
DIGEST = None


class Controls(unittest.TestCase):
    def payload(self):
        return {'version': 1, 'rows': [{'case': case.value, 'effects': [
            {'kind': effect.kind.value, 'assessmentId': effect.assessment_id,
             'dimensionId': effect.dimension_id, 'triggerLevel': effect.trigger_level.value,
             'guidance': effect.guidance} for effect in MODEL['EXPECTED'][case]]} for case in MODEL['Case']]}

    def test_complete_typed_population_required(self):
        good = self.payload()
        self.assertIsInstance(MODEL['decode'](json.dumps(good).encode()), MODEL['Observation'])
        variants = [{'version': True, 'rows': good['rows']}, {'version': 1, 'rows': []},
                    {'version': 1, 'rows': list(reversed(good['rows']))}, {**good, 'extra': 1}]
        for field, value in [('kind', 'invented'), ('triggerLevel', True), ('guidance', 42), ('extra', 'x')]:
            changed = copy.deepcopy(good); changed['rows'][2]['effects'][0][field] = value; variants.append(changed)
        for value in variants:
            self.assertIsInstance(MODEL['decode'](json.dumps(value).encode()), MODEL['Failure'])
        duplicate = json.dumps(good).replace('"version": 1', '"version": 1, "version": 1')
        self.assertIsInstance(MODEL['decode'](duplicate.encode()), MODEL['Failure'])

    def test_well_formed_wrong_effects_are_assertion_failures(self):
        good = self.payload(); good['rows'][2]['effects'] = []
        observed = MODEL['decode'](json.dumps(good).encode())
        self.assertIsInstance(observed, MODEL['Observation'])
        with self.assertRaises(AssertionError): MODEL['assert_contract'](observed)

    def test_copied_runtime_never_falls_back(self):
        with patch.dict(os.environ, {'FPIPE_IN_SABOTAGE': '1'}, clear=True):
            self.assertIsInstance(MODEL['observe'](ROOT, NODE, DIGEST), MODEL['Failure'])

    def test_wrong_runtime_refuses(self):
        self.assertIsInstance(MODEL['observe'](ROOT, NODE, '0'*64), MODEL['Failure'])

    def test_real_subject_passes(self):
        observed = MODEL['observe'](ROOT, NODE, DIGEST)
        self.assertIsInstance(observed, MODEL['Observation'], observed)
        MODEL['assert_contract'](observed)

    def test_actual_source_mutants_and_unavailable_inputs(self):
        source = 'src/mcp/handlers/v2-advance-core/assessment-consequences.ts'
        original = (ROOT/source).read_text()
        variants = {
            'scope': (original.replace('args.recordedAssessments.filter(r => r.assessmentId === scopedToAssessment)', 'args.recordedAssessments'), 1),
            'guidance': (original.replace('guidance: consequence.effect.guidance,', "guidance: 'lost guidance',"), 1),
            'order': (original.replace('for (const consequence of args.step.assessmentConsequences)', 'for (const consequence of args.step.assessmentConsequences.toReversed())'), 1),
            'syntax': ('invalid TypeScript !!!', 2),
            'import': ("import 'undeclared-dependency';\n" + original, 2),
            'absent': (None, 2),
        }
        inputs = ['package.json', source, 'experiments/answer-driven-execution/proofs/metrics-outcome.py',
                  'experiments/answer-driven-execution/proofs/assessment-scoping.py',
                  'experiments/answer-driven-execution/proofs/assessment-scoping.mjs']
        for name, (content, expected) in variants.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for path in inputs:
                    target = root/path; target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(ROOT/path, target)
                if content is None: (root/source).unlink()
                else:
                    self.assertNotEqual(content, original)
                    (root/source).write_text(content)
                run = subprocess.run([sys.executable, str(root/'experiments/answer-driven-execution/proofs/assessment-scoping.py'),
                    '--root', str(root), '--node', str(NODE), '--sha256', DIGEST],
                    env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True, timeout=15)
                self.assertEqual(run.returncode, expected, run.stdout + run.stderr)
                if expected == 1: self.assertIn('AssertionError', run.stderr)
                else: self.assertNotIn('AssertionError', run.stderr)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    NODE, DIGEST = args.node, args.sha256
    unittest.main(argv=[sys.argv[0]])
