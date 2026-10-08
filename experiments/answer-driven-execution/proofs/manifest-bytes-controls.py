"""Whole declared artifact population, real byte faults and source mutants."""
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
MODEL = runpy.run_path(str(BASE/'manifest-bytes.py'))
NODE = None
DIGEST = None


class Controls(unittest.TestCase):
    def payload(self):
        rows = []
        for case in MODEL['CASES']:
            intact = case.fault is MODEL['Fault'].INTACT
            rows.append({'stage': case.stage.value, 'fault': case.fault.value, 'target': case.target,
                'kind': 'manifest_verified' if intact else 'rejected',
                'scope': 'declaration_and_artifact_bytes_only' if intact else None,
                'trialAuthorization': False if intact else None,
                'totalPlannedTrials': (40 if case.stage is MODEL['Stage'].A else 20) if intact else None,
                'verifiedArtifactCount': len(MODEL['ARTIFACTS'][case.stage]) if intact else None,
                'phase': None if intact else 'artifacts',
                'errors': [] if intact else [{'kind': 'hash_mismatch' if case.fault is MODEL['Fault'].CHANGED else 'read_error', 'path': case.target}],
                'reads': list(MODEL['ARTIFACTS'][case.stage])})
        return {'version': 1, 'rows': rows}

    def test_complete_typed_population_required(self):
        good = self.payload()
        self.assertEqual(len(good['rows']), 100)
        self.assertIsInstance(MODEL['decode'](json.dumps(good).encode()), MODEL['Observation'])
        variants = [{'version': True, 'rows': good['rows']}, {'version': 1, 'rows': []},
                    {'version': 1, 'rows': list(reversed(good['rows']))}, {**good, 'extra': 1}]
        for field, value in [('stage', 'C'), ('fault', 'invented'), ('kind', 'invented'),
                             ('trialAuthorization', 1), ('reads', [42]), ('verifiedArtifactCount', True)]:
            changed = copy.deepcopy(good); changed['rows'][0][field] = value; variants.append(changed)
        changed = copy.deepcopy(good); changed['rows'][1]['errors'][0]['kind'] = 'invented'; variants.append(changed)
        for value in variants:
            self.assertIsInstance(MODEL['decode'](json.dumps(value).encode()), MODEL['Failure'])
        duplicate = json.dumps(good).replace('"version": 1', '"version": 1, "version": 1')
        self.assertIsInstance(MODEL['decode'](duplicate.encode()), MODEL['Failure'])

    def test_missing_reads_and_wrong_authority_are_semantic_failures(self):
        for field, value in [('reads', []), ('trialAuthorization', True), ('verifiedArtifactCount', 0)]:
            changed = self.payload(); changed['rows'][0][field] = value
            observed = MODEL['decode'](json.dumps(changed).encode())
            self.assertIsInstance(observed, MODEL['Observation'])
            with self.assertRaises(AssertionError): MODEL['assert_contract'](observed)

    def test_copied_runtime_never_falls_back(self):
        with patch.dict(os.environ, {'FPIPE_IN_SABOTAGE': '1'}, clear=True):
            self.assertIsInstance(MODEL['observe'](ROOT, NODE, DIGEST), MODEL['Failure'])

    def test_wrong_runtime_refuses(self):
        self.assertIsInstance(MODEL['observe'](ROOT, NODE, '0'*64), MODEL['Failure'])

    def test_real_reader_and_all_declared_artifact_faults(self):
        observed = MODEL['observe'](ROOT, NODE, DIGEST)
        self.assertIsInstance(observed, MODEL['Observation'], observed)
        MODEL['assert_contract'](observed)

    def test_actual_mutants_and_unavailable_inputs(self):
        source = 'experiments/answer-driven-execution/study-manifest.mts'
        original = (ROOT/source).read_text()
        variants = {
            'accept_changed_bytes': (original.replace('if (actualSha256 !== entry.expectedSha256)', 'if (false)'), 1, None),
            'omit_stage_b_proof': (original.replace("if (manifest.stage === 'B') {\n    list.push(toEntry(", 'if (false) {\n    list.push(toEntry('), 1, None),
            'grant_trial_authority': (original.replace('trialAuthorization: false,', 'trialAuthorization: true,'), 1, None),
            'syntax': ('invalid TypeScript !!!', 2, None),
            'import': ("import 'undeclared-dependency';\n" + original, 2, None),
            'absent': (None, 2, None),
            'corrupt_archive': (original, 2, 'archive'),
            'lock_drift': (original, 2, 'lock'),
        }
        inputs = ['package.json', 'package-lock.json', source,
                  'experiments/answer-driven-execution/proofs/metrics-outcome.py',
                  'experiments/answer-driven-execution/proofs/gate-verdict.py',
                  'experiments/answer-driven-execution/proofs/vendor/zod-3.25.76.tgz',
                  'experiments/answer-driven-execution/proofs/manifest-bytes.py',
                  'experiments/answer-driven-execution/proofs/manifest-bytes.mjs',
                  'experiments/answer-driven-execution/proofs/manifest-byte-fixtures.mjs']
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
                result = subprocess.run([sys.executable, str(root/'experiments/answer-driven-execution/proofs/manifest-bytes.py'),
                    '--root', str(root), '--node', str(NODE), '--sha256', DIGEST],
                    env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True, timeout=25)
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
