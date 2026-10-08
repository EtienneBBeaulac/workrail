"""Native storage and real console projection mutations, with unavailable controls."""
import argparse
import copy
import json
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
MODEL = runpy.run_path(str(BASE / 'console-preservation.py'))
INPUTS = json.loads((BASE / 'console-preservation.inputs.json').read_text())
NODE = None
DIGEST = None

class Controls(unittest.TestCase):
    def shadow(self):
        temporary = tempfile.TemporaryDirectory(prefix='console source controls ')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / 'source'
        files = INPUTS['sources'] + ['package-lock.json']
        files += ['experiments/answer-driven-execution/proofs/' + name for name in
            ('console-preservation.py', 'console-preservation.mjs', 'console-preservation.inputs.json',
             'workflow-pinning.py', 'loop-initializer.py', 'metrics-outcome.py')]
        files += [str(path.relative_to(ROOT)) for path in (BASE / 'vendor').glob('*.tgz')]
        for relative in files:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        return root
    def good(self):
        return {'kind': 'observed', 'notes': MODEL['NOTES'], 'artifacts': json.loads(MODEL['EXPECTED_JSON']),
            'unchangedBytes': True, 'files': 8, 'events': 11}
    def test_strict_wire_and_nonempty_population(self):
        MODEL['assert_observation'](MODEL['decode'](json.dumps(self.good()).encode()))
        for field, value in [('kind', 'other'), ('files', True), ('events', 0), ('unchangedBytes', 1),
                ('notes', []), ('artifacts', {}), ('extra', 1)]:
            self.assertIsInstance(MODEL['decode'](json.dumps({**self.good(), field: value}).encode()), MODEL['Failure'])
        for field in self.good():
            row = self.good(); del row[field]
            self.assertIsInstance(MODEL['decode'](json.dumps(row).encode()), MODEL['Failure'])
        self.assertIsInstance(MODEL['decode'](b'{"kind":"observed","kind":"observed"}'), MODEL['Failure'])
    def test_valid_json_wrong_projection_reaches_semantic_assertions(self):
        for field, value in [('notes', None), ('artifacts', []), ('unchangedBytes', False)]:
            observed = MODEL['decode'](json.dumps({**self.good(), field: value}).encode())
            self.assertIsInstance(observed, MODEL['Observation'])
            with self.assertRaises(AssertionError): MODEL['assert_observation'](observed)
    def test_actual_native_original_and_spaced_source(self):
        for root in (ROOT, self.shadow()):
            observed = MODEL['observe'](root, NODE, DIGEST)
            self.assertIsInstance(observed, MODEL['Observation'], observed)
            MODEL['assert_observation'](observed)
            self.assertGreater(observed.files.count, 0)
            self.assertGreater(observed.events.count, 0)
    def test_real_findings_and_notes_mutants_preserve_other_dimensions(self):
        root = self.shadow(); path = root / 'src/v2/usecases/console-service.ts'; original = path.read_text()
        for name, find, replacement in [('findings', '    content: a.content,', '    content: { ...a.content, findings: [] },'),
                ('notes', '    return latest.payload.notesMarkdown;', '    return latest.payload.notesMarkdown.trim();')]:
            self.assertEqual(original.count(find), 1)
            path.write_text(original.replace(find, replacement))
            observed = MODEL['observe'](root, NODE, DIGEST)
            self.assertIsInstance(observed, MODEL['Observation'], observed)
            self.assertIs(observed.history, MODEL['History'].UNCHANGED)
            if name == 'findings':
                self.assertEqual(observed.notes, MODEL['NOTES'])
                self.assertEqual(json.loads(observed.artifacts.canonical)[0]['findings'], [])
            else:
                self.assertEqual(observed.artifacts.canonical, MODEL['EXPECTED_JSON'])
                self.assertEqual(observed.notes, MODEL['NOTES'].strip())
            with self.assertRaises(AssertionError): MODEL['assert_observation'](observed)
        path.write_text(original)
        MODEL['assert_observation'](MODEL['observe'](root, NODE, DIGEST))
    def test_actual_manifest_write_does_not_change_returned_notes_or_artifacts(self):
        root = self.shadow(); path = root / 'src/v2/usecases/console-service.ts'; original = path.read_text()
        find = '            const result = projectNodeDetail(truth.events, nodeId, stepLabels);'
        self.assertEqual(original.count(find), 1)
        source = "import { appendFileSync } from 'node:fs';\n" + original.replace(find,
            find + "\n            appendFileSync(this.ports.dataDir.sessionManifestPath(sessionId), '\\n');")
        path.write_text(source)
        observed = MODEL['observe'](root, NODE, DIGEST)
        self.assertIsInstance(observed, MODEL['Observation'], observed)
        self.assertEqual(observed.notes, MODEL['NOTES'])
        self.assertEqual(observed.artifacts.canonical, MODEL['EXPECTED_JSON'])
        self.assertIs(observed.history, MODEL['History'].CHANGED)
        with self.assertRaises(AssertionError): MODEL['assert_observation'](observed)
        path.write_text(original)
        MODEL['assert_observation'](MODEL['observe'](root, NODE, DIGEST))
    def test_missing_malformed_and_symlinked_source_are_unavailable(self):
        for mode in ('missing', 'syntax', 'symlink'):
            root = self.shadow(); path = root / 'src/v2/usecases/console-service.ts'
            if mode == 'syntax': path.write_text('const broken = ;')
            else:
                path.unlink()
                if mode == 'symlink': path.symlink_to(ROOT / 'src/v2/usecases/console-service.ts')
            self.assertIsInstance(MODEL['observe'](root, NODE, DIGEST), MODEL['Failure'])
    def test_runtime_and_archive_identity_refuse_before_publication(self):
        self.assertIsInstance(MODEL['observe'](ROOT, NODE, '0' * 64), MODEL['Failure'])
        self.assertIsInstance(MODEL['observe'](ROOT, NODE.with_name('missing-node'), DIGEST), MODEL['Failure'])
        root = self.shadow(); archive = root / 'experiments/answer-driven-execution/proofs/vendor/ajv-8.20.0.tgz'
        archive.write_bytes(archive.read_bytes() + b'changed')
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder) / 'unpublished'
            self.assertIsInstance(MODEL['SHARED']['materialize'](root, stage, INPUTS), MODEL['Failure'])
            self.assertFalse(stage.exists())

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    NODE, DIGEST = args.node, args.sha256
    unittest.main(argv=['console-preservation-controls'], verbosity=2)
