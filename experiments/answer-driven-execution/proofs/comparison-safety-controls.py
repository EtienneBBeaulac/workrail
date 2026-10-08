"""Separate unsafe-admission proof, safety classification and unavailable inputs."""
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
MODEL = runpy.run_path(str(BASE/'comparison-safety.py'))
NODE = None
DIGEST = None


class Controls(unittest.TestCase):
    def payload(self):
        reasons = [[], ['lost_accepted_work'], ['duplicate_obligation'], ['unauthorized_effect'], ['recovery_mutated_run']]
        return {'version': 1, 'rows': [{'case': case.value, 'kind': 'scored',
            'status': 'measurement_thresholds_met' if index == 0 else 'rejected_safety',
            'scope': 'normalized_stage_a_evidence_only', 'releaseApproval': False,
            'trialIssues': [], 'safety': reasons[index], 'population': 40}
            for index, case in enumerate(MODEL['Case'])]}

    def test_complete_typed_population_required(self):
        good = self.payload()
        self.assertIsInstance(MODEL['decode'](json.dumps(good).encode()), MODEL['Observation'])
        variants = [{'version': True, 'rows': good['rows']}, {'version': 1, 'rows': []},
                    {'version': 1, 'rows': list(reversed(good['rows']))}, {**good, 'extra': 1}]
        for field, value in [('kind', 'invented'), ('status', 'invented'), ('releaseApproval', 1),
                             ('safety', ['invented']), ('population', True), ('trialIssues', [42])]:
            changed = copy.deepcopy(good); changed['rows'][0][field] = value; variants.append(changed)
        for value in variants:
            self.assertIsInstance(MODEL['decode'](json.dumps(value).encode()), MODEL['Failure'])
        duplicate = json.dumps(good).replace('"version": 1', '"version": 1, "version": 1')
        self.assertIsInstance(MODEL['decode'](duplicate.encode()), MODEL['Failure'])

    def test_schema_rejection_and_wrong_admission_are_semantic_failures(self):
        good = self.payload()
        for name in ['invalid', 'admitted']:
            changed = copy.deepcopy(good)
            if name == 'admitted': changed['rows'][1]['status'] = 'measurement_thresholds_met'
            else:
                changed['rows'][1] = {'case': 'lost', 'kind': 'invalid_input', 'status': None, 'scope': None,
                    'releaseApproval': None, 'trialIssues': None, 'safety': None, 'population': None}
            observed = MODEL['decode'](json.dumps(changed).encode())
            self.assertIsInstance(observed, MODEL['Observation'])
            with self.assertRaises(AssertionError): MODEL['assert_contract'](observed)

    def test_copied_runtime_never_falls_back(self):
        with patch.dict(os.environ, {'FPIPE_IN_SABOTAGE': '1'}, clear=True):
            self.assertIsInstance(MODEL['observe'](ROOT, NODE, DIGEST), MODEL['Failure'])

    def test_wrong_runtime_refuses(self):
        self.assertIsInstance(MODEL['observe'](ROOT, NODE, '0'*64), MODEL['Failure'])

    def test_real_scorer_rejects_four_valid_unsafe_cases(self):
        observed = MODEL['observe'](ROOT, NODE, DIGEST)
        self.assertIsInstance(observed, MODEL['Observation'], observed)
        MODEL['assert_contract'](observed)

    def test_actual_mutants_and_unavailable_inputs(self):
        source = 'experiments/answer-driven-execution/usability-scorer.mts'
        original = (ROOT/source).read_text()
        start = original.index('  const status = candidateSafety ?')
        end = original.index('\n  return { status', start)
        admission = original[:start] + "  const status = 'measurement_thresholds_met' as const;" + original[end:]
        variants = {'unsafe_admission': (admission, 1, None),
                    'syntax': ('invalid TypeScript !!!', 2, None),
                    'import': ("import 'undeclared-dependency';\n" + original, 2, None),
                    'absent': (None, 2, None),
                    'corrupt_archive': (original, 2, 'archive'),
                    'lock_drift': (original, 2, 'lock')}
        # These supplementary mutants establish classification, not necessarily admission.
        for reason in ['lost_accepted_work', 'duplicate_obligation', 'unauthorized_effect', 'recovery_mutated_run']:
            variants['classification_' + reason] = (original.replace(f"safety.push('{reason}')", 'safety.push()'), 1, None)
        inputs = ['package.json', 'package-lock.json', source,
                  'experiments/answer-driven-execution/proofs/metrics-outcome.py',
                  'experiments/answer-driven-execution/proofs/gate-verdict.py',
                  'experiments/answer-driven-execution/proofs/vendor/zod-3.25.76.tgz',
                  'experiments/answer-driven-execution/proofs/comparison-safety.py',
                  'experiments/answer-driven-execution/proofs/comparison-safety.mjs']
        for name, (content, expected, dependency_fault) in variants.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for path in inputs:
                    target = root/path; target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(ROOT/path, target)
                if content is None: (root/source).unlink()
                else: (root/source).write_text(content)
                if dependency_fault == 'archive':
                    (root/'experiments/answer-driven-execution/proofs/vendor/zod-3.25.76.tgz').write_bytes(b'corrupt')
                elif dependency_fault == 'lock':
                    lock = json.loads((root/'package-lock.json').read_text())
                    lock['packages']['node_modules/zod']['integrity'] = 'sha512-wrong'
                    (root/'package-lock.json').write_text(json.dumps(lock))
                else: self.assertNotEqual(content, original)
                result = subprocess.run([sys.executable, str(root/'experiments/answer-driven-execution/proofs/comparison-safety.py'),
                    '--root', str(root), '--node', str(NODE), '--sha256', DIGEST],
                    env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                if expected == 1: self.assertIn('AssertionError', result.stderr)
                else: self.assertNotIn('AssertionError', result.stderr)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    NODE, DIGEST = args.node, args.sha256
    unittest.main(argv=[sys.argv[0]])
