"""Portable source-definition controls with an explicitly supplied runtime."""
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
MODEL = runpy.run_path(str(BASE/'metrics-outcome.py'))
NODE = None
DIGEST = None


class Controls(unittest.TestCase):
    def payload(self):
        return {'version': 1, 'supported': sorted(outcome.value for outcome in MODEL['OUTCOMES']), 'completed': True, 'unknown': None,
                'reported': [{'expected': value.value, 'actual': value.value, 'completed': True}
                             for value in MODEL['OUTCOMES']]}

    def test_schema_requires_exact_complete_population_and_scalar_types(self):
        good = self.payload()
        self.assertIsInstance(MODEL['decode'](json.dumps(good).encode()), MODEL['Observation'])
        variants = []
        for field, value in [('version', True), ('completed', 1), ('unknown', 'invented'),
                             ('reported', []), ('supported', good['supported'] + ['invented']), ('reported', list(reversed(good['reported'])))]:
            variants.append({**good, field: value})
        altered = copy.deepcopy(good); altered['reported'][0]['actual'] = True; variants.append(altered)
        altered = copy.deepcopy(good); altered['reported'][0]['extra'] = 1; variants.append(altered)
        for value in variants:
            self.assertIsInstance(MODEL['decode'](json.dumps(value).encode()), MODEL['Failure'])
        raw = json.dumps(good).replace('"version": 1', '"version": 1, "version": 1')
        self.assertIsInstance(MODEL['decode'](raw.encode()), MODEL['Failure'])

    def test_missing_copied_capability_never_uses_ordinary_runtime(self):
        with patch.dict(os.environ, {'FPIPE_IN_SABOTAGE': '1'}, clear=True):
            result = MODEL['observe'](ROOT, NODE, DIGEST)
            self.assertIsInstance(result, MODEL['Failure'])
            self.assertIn('capability', result.detail)

    def test_runtime_mismatch_refuses_before_observation(self):
        self.assertIsInstance(MODEL['observe'](ROOT, NODE, '0'*64), MODEL['Failure'])

    def test_clean_actual_projection_preserves_all_reported_outcomes(self):
        result = MODEL['observe'](ROOT, NODE, DIGEST)
        self.assertIsInstance(result, MODEL['Observation'], result)
        self.assertTrue(result.completed)
        self.assertIsNone(result.unknown)
        self.assertTrue(all(row.completed and row.expected == row.actual for row in result.reported))

    def test_actual_semantic_and_infrastructure_mutants_have_distinct_cli_results(self):
        source = 'src/v2/projections/session-metrics.ts'
        needle = "const outcomeRaw = metricsContext['metrics_outcome'];"
        original = (ROOT/source).read_text()
        self.assertEqual(original.count(needle), 1)
        variants = {
            'clean': (original, 0),
            'semantic': (original.replace(needle, "const outcomeRaw = metricsContext['metrics_outcome'] ?? 'success';"), 1),
            'runtime': (original.replace(needle, "const outcomeRaw = (() => { throw new Error('AssertionError: fake'); })();"), 2),
            'syntax': (original.replace(needle, 'const outcomeRaw = ???;'), 2),
            'population': (original, 2),
        }
        for name, (text, expected) in variants.items():
            with self.subTest(state=name), tempfile.TemporaryDirectory(prefix='metrics-proof-') as temp:
                root = Path(temp)
                for path in ('package.json', source, 'src/v2/durable-core/constants.ts'):
                    target = root/path; target.parent.mkdir(parents=True, exist_ok=True)
                    data = text.encode() if path == source else (ROOT/path).read_bytes()
                    if name == 'population' and path.endswith('constants.ts'):
                        before = b"['success', 'partial', 'abandoned', 'error'] as const"
                        self.assertEqual(data.count(before), 1)
                        data = data.replace(before, b"['success', 'partial', 'abandoned', 'error', 'invented'] as const")
                    target.write_bytes(data)
                for path in ('metrics-outcome.py', 'metrics-outcome.mjs'):
                    shutil.copy2(BASE/path, root/path)
                node = root/'node'; node.write_bytes(NODE.read_bytes()); node.chmod(0o500)
                env = {'FPIPE_IN_SABOTAGE': '1', 'FPIPE_NODE_EXECUTABLE': str(node),
                       'FPIPE_NODE_SHA256': DIGEST}
                result = subprocess.run([sys.executable, str(root/'metrics-outcome.py'), '--root', str(root),
                    '--node', str(NODE), '--sha256', DIGEST], env=env, capture_output=True, timeout=20)
                self.assertEqual(result.returncode, expected, result.stderr.decode())
        self.assertEqual((ROOT/source).read_text(), original)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    NODE, DIGEST = args.node, args.sha256
    unittest.main(argv=[__file__])
