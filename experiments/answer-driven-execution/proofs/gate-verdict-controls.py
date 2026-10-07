"""Real parser/routing and unavailable-input controls, no live model inference."""
import argparse
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
MODEL = runpy.run_path(str(BASE/'gate-verdict.py'))
NODE = None
DIGEST = None
SOURCE = 'src/coordinators/gate-evaluator-dispatcher.ts'
SCHEMA = 'src/v2/durable-core/schemas/artifacts/gate-verdict.ts'
ARCHIVE = MODEL['ARCHIVE']
NEEDLE = "return uncertain('Evaluator session completed but produced no wr.gate_verdict artifact');"


class Controls(unittest.TestCase):
    def test_complete_observation_boundary(self):
        good = {'version': 1, 'rows': [{'case': case.value, 'verdict': verdict.value,
            'confidence': confidence, 'stepId': 'checked-step'}
            for case, (verdict, confidence) in MODEL['EXPECTED'].items()]}
        self.assertIsInstance(MODEL['decode'](json.dumps(good).encode()), MODEL['Observation'])
        variants = [{**good, 'version': True}, {**good, 'rows': []}, {**good, 'extra': 1},
                    {**good, 'rows': list(reversed(good['rows']))}]
        for field, value in [('verdict', 'invented'), ('confidence', True), ('stepId', 1), ('extra', 1)]:
            bad = copy.deepcopy(good); bad['rows'][0][field] = value; variants.append(bad)
        for value in variants:
            self.assertIsInstance(MODEL['decode'](json.dumps(value).encode()), MODEL['Failure'])
        raw = json.dumps(good).replace('"version": 1', '"version": 1, "version": 1')
        self.assertIsInstance(MODEL['decode'](raw.encode()), MODEL['Failure'])

    def test_missing_copied_runtime_cannot_use_ambient(self):
        with patch.dict(os.environ, {'FPIPE_IN_SABOTAGE': '1'}, clear=True):
            result = MODEL['observe'](ROOT, NODE, DIGEST)
            self.assertIsInstance(result, MODEL['Failure'])
            self.assertIn('capability', result.detail)

    def test_clean_actual_routing_and_parser(self):
        result = MODEL['observe'](ROOT, NODE, DIGEST)
        self.assertIsInstance(result, MODEL['Observation'], result)
        for row in result.rows:
            self.assertEqual((row.verdict, row.confidence), MODEL['EXPECTED'][row.case])
            self.assertEqual(row.step_id, 'checked-step')

    def test_mutations_reach_assertions_and_setup_failures_stay_unavailable(self):
        original = (ROOT/SOURCE).read_text()
        self.assertEqual(original.count(NEEDLE), 1)
        variants = {'clean': (original, 0),
            'semantic': (original.replace(NEEDLE, "return { verdict: 'approved', rationale: 'Incorrect approval', confidence: 'high', stepId };"), 1),
            'runtime': (original.replace(NEEDLE, "throw new Error('AssertionError: fake');"), 2),
            'syntax': (original.replace(NEEDLE, 'return ???;'), 2),
            'archive_missing': (original, 2), 'archive_corrupt': (original, 2),
            'lock_changed': (original, 2), 'schema_missing': (original, 2),
            'schema_semantic': (original, 1)}
        for name, (text, expected) in variants.items():
            with self.subTest(state=name), tempfile.TemporaryDirectory(prefix='verdict-proof-control-') as temp:
                root = Path(temp)
                for path in ('package.json', 'package-lock.json', SOURCE, SCHEMA, ARCHIVE):
                    if (name == 'archive_missing' and path == ARCHIVE) or (name == 'schema_missing' and path == SCHEMA):
                        continue
                    target = root/path; target.parent.mkdir(parents=True, exist_ok=True)
                    data = text.encode() if path == SOURCE else (ROOT/path).read_bytes()
                    if name == 'archive_corrupt' and path == ARCHIVE: data = data[:-1]
                    if name == 'schema_semantic' and path == SCHEMA:
                        self.assertEqual(data.count(b'.min(20)'), 1)
                        data = data.replace(b'.min(20)', b'.min(1)')
                    if name == 'lock_changed' and path == 'package-lock.json':
                        lock = json.loads(data); lock['packages']['node_modules/zod']['version'] = 'different'; data = json.dumps(lock).encode()
                    target.write_bytes(data)
                for path in ('gate-verdict.py', 'gate-verdict.mjs', 'metrics-outcome.py'):
                    shutil.copy2(BASE/path, root/path)
                node = root/'node'; node.write_bytes(NODE.read_bytes()); node.chmod(0o500)
                env = {'FPIPE_IN_SABOTAGE': '1', 'FPIPE_NODE_EXECUTABLE': str(node), 'FPIPE_NODE_SHA256': DIGEST}
                result = subprocess.run([sys.executable, str(root/'gate-verdict.py'), '--root', str(root),
                    '--node', str(NODE), '--sha256', DIGEST], env=env, capture_output=True, timeout=20)
                self.assertEqual(result.returncode, expected, result.stderr.decode())
                if name in ('semantic', 'schema_semantic'):
                    self.assertIn(b'AssertionError', result.stderr)
                    self.assertIn(b'assert row.verdict', result.stderr)
        self.assertEqual((ROOT/SOURCE).read_text(), original)

    def test_archive_rejects_unsafe_members_before_materializing(self):
        for name, kind in [('package/../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE),
                           ('package/link', tarfile.SYMTYPE), ('package/pipe', tarfile.FIFOTYPE),
                           ('package/duplicate', tarfile.REGTYPE)]:
            with self.subTest(member=name), tempfile.TemporaryDirectory(prefix='verdict-archive-control-') as temp:
                root = Path(temp)
                buffer = io.BytesIO()
                with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
                    member = tarfile.TarInfo(name); member.type = kind
                    member.size = 1 if kind == tarfile.REGTYPE else 0
                    archive.addfile(member, io.BytesIO(b'x') if member.size else None)
                    if name == 'package/duplicate': archive.addfile(member, io.BytesIO(b'x'))
                raw = buffer.getvalue()
                target = root/ARCHIVE; target.parent.mkdir(parents=True); target.write_bytes(raw)
                integrity = 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode()
                (root/'package-lock.json').write_text(json.dumps({'packages': {'node_modules/zod': {'integrity': integrity}}}))
                destination = root/'extracted'
                self.assertIsInstance(MODEL['materialize'](root, destination), MODEL['Failure'])
                self.assertFalse(destination.exists())


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    NODE, DIGEST = args.node, args.sha256
    unittest.main(argv=[__file__])
