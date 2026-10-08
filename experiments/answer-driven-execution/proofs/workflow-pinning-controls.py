"""Continuity controls using actual stored workflow source mutations."""
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
MODEL = runpy.run_path(str(BASE / 'workflow-pinning.py'))
INPUTS = json.loads((BASE / 'workflow-pinning.inputs.json').read_text())
NODE = None
DIGEST = None
ANCHOR = '        })\n      );\n  }\n}'
OVERWRITE = '''        })
      ).andThen(() => this.fs.readdir(dir).mapErr(mapFsToStoreError)
        .andThen(entries => RA.combine(entries.filter(name => name.endsWith('.json'))
          .map(name => this.fs.writeFileBytes(nodePath.join(dir, name), bytes).mapErr(mapFsToStoreError))))
        .map(() => undefined));
  }
}'''

class Controls(unittest.TestCase):
    def shadow(self):
        temporary = tempfile.TemporaryDirectory(prefix='workflow continuity source ')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / 'source'
        files = INPUTS['sources'] + ['package-lock.json']
        files += ['experiments/answer-driven-execution/proofs/' + name for name in
            ('workflow-pinning.py', 'workflow-pinning.mjs', 'workflow-pinning.inputs.json', 'loop-initializer.py', 'metrics-outcome.py')]
        files += [str(path.relative_to(ROOT)) for path in (BASE / 'vendor').glob('*.tgz')]
        for relative in files:
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, destination)
        return root

    def good(self):
        return {'kind': 'observed', 'originalKind': 'question', 'originalInstruction': 'Original second',
            'replacementKind': 'question', 'replacementInstruction': 'Replacement second',
            'exactOriginalView': True, 'exactReplacementView': True, 'originalFinish': 'finished',
            'originalDisposition': 'accepted', 'replacementFinish': 'finished', 'replacementDisposition': 'accepted'}

    def test_strict_observation_schema(self):
        MODEL['assert_observation'](MODEL['decode'](json.dumps(self.good()).encode()))
        for field, invalid in [('kind', 'other'), ('originalKind', 'unavailable'), ('originalInstruction', None),
                ('exactOriginalView', 1), ('exactReplacementView', False), ('originalFinish', 'other'),
                ('replacementDisposition', 'other'), ('extra', True)]:
            row = {**self.good(), field: invalid}
            if field == 'exactReplacementView':
                observation = MODEL['decode'](json.dumps(row).encode())
                self.assertIsInstance(observation, MODEL['Observation'])
                with self.assertRaises(AssertionError): MODEL['assert_observation'](observation)
            else:
                self.assertIsInstance(MODEL['decode'](json.dumps(row).encode()), MODEL['Failure'])
        self.assertIsInstance(MODEL['decode'](b'{"kind":"observed","kind":"observed"}'), MODEL['Failure'])
        for field in self.good():
            row = self.good(); del row[field]
            self.assertIsInstance(MODEL['decode'](json.dumps(row).encode()), MODEL['Failure'])

    def test_original_and_separate_processes_with_spaced_source_path(self):
        for root in (ROOT, self.shadow()):
            observation = MODEL['observe'](root, NODE, DIGEST)
            self.assertIsInstance(observation, MODEL['Observation'], observation)
            MODEL['assert_observation'](observation)

    def test_overwriting_old_pin_changes_only_old_instruction(self):
        root = self.shadow()
        path = root / 'src/v2/infra/local/pinned-workflow-store/index.ts'
        original = path.read_text(); self.assertEqual(original.count(ANCHOR), 1)
        path.write_text(original.replace(ANCHOR, OVERWRITE))
        observation = MODEL['observe'](root, NODE, DIGEST)
        self.assertIsInstance(observation, MODEL['Observation'], observation)
        self.assertEqual(observation.original.instruction, 'Replacement second')
        self.assertFalse(observation.original.exact_view)
        self.assertEqual(observation.replacement.instruction, 'Replacement second')
        self.assertTrue(observation.replacement.exact_view)
        for run in (observation.original, observation.replacement):
            self.assertIs(run.finish, MODEL['View'].FINISHED)
            self.assertIs(run.disposition, MODEL['Disposition'].ACCEPTED)
        with self.assertRaises(AssertionError): MODEL['assert_observation'](observation)
        path.write_text(original)
        MODEL['assert_observation'](MODEL['observe'](root, NODE, DIGEST))

    def test_semantic_completion_rejection_and_receipt_loss_are_not_green(self):
        for field, bad in [('originalFinish', 'question'), ('originalDisposition', 'rejected'),
                ('replacementFinish', 'question'), ('replacementDisposition', 'rejected'), ('exactOriginalView', False)]:
            row = {**self.good(), field: bad}
            observation = MODEL['decode'](json.dumps(row).encode())
            self.assertIsInstance(observation, MODEL['Observation'])
            with self.assertRaises(AssertionError): MODEL['assert_observation'](observation)

    def test_missing_malformed_and_symlinked_source_are_unavailable(self):
        for mode in ('missing', 'syntax', 'symlink'):
            root = self.shadow(); path = root / 'src/answer-v1/worker.ts'
            if mode == 'syntax': path.write_text('const broken = ;')
            else:
                path.unlink()
                if mode == 'symlink': path.symlink_to(ROOT / 'src/answer-v1/worker.ts')
            self.assertIsInstance(MODEL['observe'](root, NODE, DIGEST), MODEL['Failure'])

    def test_runtime_and_archives_refuse_before_staging(self):
        self.assertIsInstance(MODEL['observe'](ROOT, NODE, '0' * 64), MODEL['Failure'])
        self.assertIsInstance(MODEL['observe'](ROOT, NODE.with_name('missing-node'), DIGEST), MODEL['Failure'])
        root = self.shadow()
        archive = root / 'experiments/answer-driven-execution/proofs/vendor/scure-base-2.2.0.tgz'
        archive.write_bytes(archive.read_bytes() + b'changed')
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder) / 'unpublished'
            self.assertIsInstance(MODEL['materialize'](root, stage, INPUTS), MODEL['Failure'])
            self.assertFalse(stage.exists())

    def test_declaration_rejects_undeclared_or_duplicate_inputs(self):
        for changed in ({**INPUTS, 'dependencies': INPUTS['dependencies'][:-1]},
                {**INPUTS, 'sources': INPUTS['sources'] + [INPUTS['sources'][0]]},
                {**INPUTS, 'sources': ['../outside']}, {**INPUTS, 'version': True}):
            with tempfile.TemporaryDirectory() as folder:
                stage = Path(folder) / 'unpublished'
                self.assertIsInstance(MODEL['materialize'](ROOT, stage, changed), MODEL['Failure'])
                self.assertFalse(stage.exists())

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    NODE, DIGEST = args.node, args.sha256
    unittest.main(argv=['workflow-pinning-controls'], verbosity=2)
