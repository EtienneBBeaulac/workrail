"""Portable controls for selected-run delivery provenance and copied runtime errors."""
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
MODEL = runpy.run_path(str(BASE/'metrics-delivery.py'))
NODE = None
DIGEST = None


class Controls(unittest.TestCase):
    def payload(self):
        return {'version': 1, 'rows': [{'case': case.value, 'actual': list(MODEL['EXPECTED'][case]), 'completed': True}
                                     for case in MODEL['Case']]}

    def test_schema_requires_complete_typed_ordered_cases(self):
        good = self.payload()
        self.assertIsInstance(MODEL['decode'](json.dumps(good).encode()), MODEL['Observation'])
        variants = [{'version': True, 'rows': good['rows']}, {'version': 1, 'rows': []},
                    {'version': 1, 'rows': list(reversed(good['rows']))}, {**good, 'extra': 1}]
        for field, value in [('case', 'invented'), ('actual', [True]), ('actual', ['short']), ('completed', 1)]:
            changed = copy.deepcopy(good); changed['rows'][0][field] = value; variants.append(changed)
        for value in variants:
            self.assertIsInstance(MODEL['decode'](json.dumps(value).encode()), MODEL['Failure'])
        raw = json.dumps(good).replace('"version": 1', '"version": 1, "version": 1')
        self.assertIsInstance(MODEL['decode'](raw.encode()), MODEL['Failure'])

    def test_missing_copied_runtime_does_not_fall_back(self):
        with patch.dict(os.environ, {'FPIPE_IN_SABOTAGE': '1'}, clear=True):
            self.assertIsInstance(MODEL['observe'](ROOT, NODE, DIGEST), MODEL['Failure'])

    def test_mismatched_runtime_refuses(self):
        self.assertIsInstance(MODEL['observe'](ROOT, NODE, '0'*64), MODEL['Failure'])

    def test_actual_projection_preserves_all_provenance_cases(self):
        result = MODEL['observe'](ROOT, NODE, DIGEST)
        self.assertIsInstance(result, MODEL['Observation'], result)
        self.assertTrue(all(row.completed and row.actual == MODEL['EXPECTED'][row.case] for row in result.rows))

    def test_semantic_mutants_and_infrastructure_failures_are_distinct(self):
        source = 'src/v2/projections/session-metrics.ts'
        original = (ROOT/source).read_text()
        precedence = 'deliveryShas.length > 0 ? deliveryShas :'
        scope = 'if (e.kind !== EVENT_KIND.DELIVERY_RECORDED) continue;\n    if (e.scope?.runId !== runCompletedRunId) continue;'
        self.assertEqual(original.count(precedence), 1); self.assertEqual(original.count(scope), 1)
        variants = {
            'clean': (original, 0),
            'precedence': (original.replace(precedence, 'false ? deliveryShas :'), 1),
            'scope': (original.replace(scope, 'if (e.kind !== EVENT_KIND.DELIVERY_RECORDED) continue;'), 1),
            'runtime': (original.replace(precedence, "(() => { throw new Error('AssertionError: fake'); })() ? deliveryShas :"), 2),
            'syntax': (original.replace(precedence, '??? ? deliveryShas :'), 2),
            'observation': (original, 2),
        }
        for name, (text, expected) in variants.items():
            with self.subTest(state=name), tempfile.TemporaryDirectory(prefix='delivery-proof-') as temp:
                root = Path(temp)
                for path in ('package.json', source, 'src/v2/durable-core/constants.ts'):
                    target = root/path; target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(text.encode() if path == source else (ROOT/path).read_bytes())
                for path in ('metrics-delivery.py', 'metrics-delivery.mjs', 'metrics-outcome.py'):
                    shutil.copy2(BASE/path, root/path)
                if name == 'observation':
                    (root/'metrics-delivery.mjs').write_text('process.stdout.write(JSON.stringify({version:1,rows:[]}));')
                node = root/'node'; node.write_bytes(NODE.read_bytes()); node.chmod(0o500)
                env = {'FPIPE_IN_SABOTAGE': '1', 'FPIPE_NODE_EXECUTABLE': str(node), 'FPIPE_NODE_SHA256': DIGEST}
                result = subprocess.run([sys.executable, str(root/'metrics-delivery.py'), '--root', str(root),
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
