"""Real command-contract mutants and unavailable-runtime controls."""
import argparse
import copy
from dataclasses import asdict
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
MODEL = runpy.run_path(str(BASE/'delivery-handoff.py'))
NODE = None
DIGEST = None


class Controls(unittest.TestCase):
    def payload(self):
        observed = MODEL['observe'](ROOT, NODE, DIGEST)
        self.assertIsInstance(observed, MODEL['Observation'], observed)
        rows = []
        for row in observed.rows:
            rows.append({'case': row.case.value, 'refusal': None if row.refusal is None else row.refusal.value,
                'refusalCalls': [asdict(cmd) for cmd in row.refusal_calls], 'kind': row.kind.value,
                'value': row.value, 'calls': [asdict(cmd) for cmd in row.calls], 'body': row.body,
                'bodyExists': row.body_exists})
        return json.loads(json.dumps({'version': 1, 'rows': rows}))

    def test_complete_typed_population_required(self):
        good = self.payload()
        variants = [{'version': True, 'rows': good['rows']}, {'version': 1, 'rows': []},
                    {'version': 1, 'rows': list(reversed(good['rows']))}, {**good, 'extra': 1}]
        for field, value in [('case', 'invented'), ('kind', 'invented'), ('bodyExists', 1), ('body', 42)]:
            changed = copy.deepcopy(good); changed['rows'][0][field] = value; variants.append(changed)
        for field, value in [('file', 'invented'), ('args', [42]), ('timeout', True)]:
            changed = copy.deepcopy(good); changed['rows'][0]['calls'][0][field] = value; variants.append(changed)
        for value in variants:
            self.assertIsInstance(MODEL['decode'](json.dumps(value).encode()), MODEL['Failure'])
        duplicate = json.dumps(good).replace('"version": 1', '"version": 1, "version": 1')
        self.assertIsInstance(MODEL['decode'](duplicate.encode()), MODEL['Failure'])

    def test_semantic_differences_reach_assertions(self):
        good = self.payload()
        MODEL['assert_contract'](MODEL['decode'](json.dumps(good).encode()))
        changed = copy.deepcopy(good); changed['rows'][0]['calls'] = []
        observation = MODEL['decode'](json.dumps(changed).encode())
        self.assertIsInstance(observation, MODEL['Observation'])
        with self.assertRaises(AssertionError): MODEL['assert_contract'](observation)

    def test_copied_runtime_never_falls_back(self):
        with patch.dict(os.environ, {'FPIPE_IN_SABOTAGE': '1'}, clear=True):
            self.assertIsInstance(MODEL['observe'](ROOT, NODE, DIGEST), MODEL['Failure'])

    def test_wrong_runtime_refuses(self):
        self.assertIsInstance(MODEL['observe'](ROOT, NODE, '0'*64), MODEL['Failure'])

    def test_actual_source_mutants_and_unavailable_inputs(self):
        source = 'src/trigger/delivery-action.ts'
        original = (ROOT/source).read_text()
        variants = {
            'stage_all': (original.replace("['add', ...artifact.filesChanged]", "['add', '.']"), 1),
            'body': (original.replace("fs.writeFile(tmpFile, prBodyWithFooter, 'utf8')", "fs.writeFile(tmpFile, 'lost body', 'utf8')"), 1),
            'title': (original.replace('`[WT] ${artifact.prTitle}`', "'[WT] lost title'"), 1),
            'commit': (original.replace("['commit', '-m', commitMessage]", "['commit', '-m', 'lost commit']"), 1),
            'missing_body_accepted': (original.replace('const requiredStrings =', "if (raw['prBody'] === undefined) raw['prBody'] = 'fabricated body';\n  const requiredStrings ="), 1),
            'syntax': ('invalid TypeScript !!!', 2),
            'import': ("import 'undeclared-dependency';\n" + original, 2),
            'absent': (None, 2),
        }
        inputs = ['package.json', 'src/coordinators/coordinator-delivery.ts', source,
                  'src/runtime/result.ts', 'experiments/answer-driven-execution/proofs/metrics-outcome.py',
                  'experiments/answer-driven-execution/proofs/delivery-handoff.py',
                  'experiments/answer-driven-execution/proofs/delivery-handoff.mjs']
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
                run = subprocess.run([sys.executable, str(root/'experiments/answer-driven-execution/proofs/delivery-handoff.py'),
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
