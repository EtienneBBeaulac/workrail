"""Real source mutations and unavailable-input controls for initializer semantics."""
import argparse
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import runpy
import shutil
import tarfile
import tempfile
import unittest

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
MODEL = runpy.run_path(str(BASE / 'loop-initializer.py'))
INPUTS = json.loads((BASE / 'loop-initializer.inputs.json').read_text())
NODE = None
DIGEST = None

class Controls(unittest.TestCase):
    def shadow(self):
        temporary = tempfile.TemporaryDirectory(prefix='loop proof controls ')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / 'source'
        files = list(INPUTS['sources']) + ['package-lock.json']
        files += ['experiments/answer-driven-execution/proofs/' + name for name in
            ('loop-initializer.py', 'loop-initializer.mjs', 'loop-initializer.inputs.json', 'metrics-outcome.py')]
        files += [str(path.relative_to(ROOT)) for path in (BASE / 'vendor').glob('*.tgz')]
        for relative in files:
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, destination)
        return root

    def payload(self):
        return {'version': 1, 'routines': INPUTS['routines'], 'routineWarnings': 0,
            'rows': [{'case': case.value, 'kind': 'observed', 'selected': 'body' if case.value.endswith('continue') else 'finish',
                'visited': ['initialize', 'body', 'finish'] if case.value.endswith('continue') else ['initialize', 'finish'],
                'isComplete': True, 'state': 'complete', 'pending': None} for case in MODEL['Case']]}

    def test_strict_complete_observation_population(self):
        good = self.payload()
        observation = MODEL['decode'](json.dumps(good).encode(), INPUTS['routines'])
        self.assertIsInstance(observation, MODEL['Observation'])
        MODEL['assert_observation'](observation)
        variants = []
        for field, value in [('version', True), ('routineWarnings', False), ('routines', []), ('rows', [])]:
            variants.append({**good, field: value})
        variants.append({**good, 'extra': 1})
        variants.append({**good, 'rows': list(reversed(good['rows']))})
        for field, value in [('case', 'unknown'), ('kind', 'unknown'), ('isComplete', 1), ('state', 'unknown'),
                ('pending', 'unknown'), ('visited', ['unknown']), ('extra', 1)]:
            altered = copy.deepcopy(good)
            altered['rows'][0][field] = value
            variants.append(altered)
        for value in variants:
            self.assertIsInstance(MODEL['decode'](json.dumps(value).encode(), INPUTS['routines']), MODEL['Failure'])
        self.assertIsInstance(MODEL['decode'](b'{"version":1,"version":1}', INPUTS['routines']), MODEL['Failure'])

    def test_domain_refusal_and_false_completion_reach_assertions(self):
        for replacement in [{'case': 'while_continue', 'kind': 'refused', 'phase': 'compile'},
                {**self.payload()['rows'][0], 'isComplete': False}]:
            payload = self.payload()
            payload['rows'][0] = replacement
            observation = MODEL['decode'](json.dumps(payload).encode(), INPUTS['routines'])
            self.assertIsInstance(observation, MODEL['Observation'])
            with self.assertRaises(AssertionError):
                MODEL['assert_observation'](observation)

    def test_actual_original_and_space_containing_source_root(self):
        for root in (ROOT, self.shadow()):
            observation = MODEL['observe'](root, NODE, DIGEST)
            self.assertIsInstance(observation, MODEL['Observation'], observation)
            MODEL['assert_observation'](observation)

    def test_initializer_only_mutation_preserves_body_stop_and_completion(self):
        root = self.shadow()
        path = root / 'src/application/services/workflow-interpreter.ts'
        source = path.read_text()
        find = 'let decisionArtifacts = artifacts;'
        self.assertEqual(source.count(find), 1)
        path.write_text(source.replace(find, "let decisionArtifacts = state.kind === 'running' && state.loopStack.length === 0 ? [] : artifacts;"))
        observation = MODEL['observe'](root, NODE, DIGEST)
        self.assertIsInstance(observation, MODEL['Observation'], observation)
        for row in observation.rows:
            self.assertIsInstance(row, MODEL['Observed'])
            self.assertTrue(row.complete)
            if row.case.value.endswith('continue'):
                self.assertEqual(row.visited, (MODEL['Step'].INITIALIZE, MODEL['Step'].BODY, MODEL['Step'].FINISH))
            else:
                self.assertEqual(row.selected, MODEL['Step'].BODY)
        with self.assertRaises(AssertionError):
            MODEL['assert_observation'](observation)
        path.write_text(source)
        MODEL['assert_observation'](MODEL['observe'](root, NODE, DIGEST))

    def test_actual_completion_and_compiler_refusal_mutations(self):
        root = self.shadow()
        path = root / 'src/application/services/workflow-interpreter.ts'
        source = path.read_text()
        find = "return ok({ state: { kind: 'complete' }, next: null, isComplete: true, trace });"
        self.assertEqual(source.count(find), 1)
        path.write_text(source.replace(find, find.replace('isComplete: true', 'isComplete: false')))
        observation = MODEL['observe'](root, NODE, DIGEST)
        self.assertIsInstance(observation, MODEL['Observation'], observation)
        with self.assertRaises(AssertionError):
            MODEL['assert_observation'](observation)
        path.write_text(source)
        compiler = root / 'src/application/services/workflow-compiler.ts'
        source = compiler.read_text()
        find = 'compile(workflow: Workflow, baseDir?: string): Result<CompiledWorkflow, DomainError> {'
        self.assertEqual(source.count(find), 1)
        compiler.write_text(source.replace(find, find + "\nreturn err(Err.invalidState('control refusal'));"))
        observation = MODEL['observe'](root, NODE, DIGEST)
        self.assertIsInstance(observation, MODEL['Observation'], observation)
        self.assertTrue(all(isinstance(row, MODEL['Refused']) and row.phase is MODEL['Phase'].COMPILE for row in observation.rows))
        with self.assertRaises(AssertionError):
            MODEL['assert_observation'](observation)

    def test_runtime_and_source_unavailability_is_distinct(self):
        self.assertIsInstance(MODEL['observe'](ROOT, NODE, '0' * 64), MODEL['Failure'])
        self.assertIsInstance(MODEL['observe'](ROOT, Path('/absent/loop-proof-node'), DIGEST), MODEL['Failure'])
        root = self.shadow()
        path = root / 'src/application/services/workflow-interpreter.ts'
        source = path.read_text()
        path.unlink()
        self.assertIsInstance(MODEL['observe'](root, NODE, DIGEST), MODEL['Failure'])
        path.write_text('not valid TypeScript {')
        self.assertIsInstance(MODEL['observe'](root, NODE, DIGEST), MODEL['Failure'])
        path.write_text(source)
        directory = root / 'src/application'
        retained = root / 'retained-application'
        directory.rename(retained)
        directory.symlink_to(retained, target_is_directory=True)
        self.assertIsInstance(MODEL['observe'](root, NODE, DIGEST), MODEL['Failure'])

    def test_archive_identity_and_unsafe_members_refuse(self):
        root = self.shadow()
        archive = root / 'experiments/answer-driven-execution/proofs/vendor/neverthrow-8.2.0.tgz'
        raw = archive.read_bytes()
        archive.write_bytes(raw[:-1] + bytes([raw[-1] ^ 1]))
        self.assertIsInstance(MODEL['observe'](root, NODE, DIGEST), MODEL['Failure'])
        for name, symlink in [('package/../outside', False), ('package/x\\outside', False), ('package/link', True)]:
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
                member = tarfile.TarInfo(name)
                if symlink:
                    member.type = tarfile.SYMTYPE
                    member.linkname = '../outside'
                    tar.addfile(member)
                else:
                    member.size = 1
                    tar.addfile(member, io.BytesIO(b'x'))
            payload = buffer.getvalue()
            declaration = {'version': '8.2.0', 'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(payload).digest()).decode()}
            self.assertIsInstance(MODEL['archive_files'](payload, 'neverthrow', declaration), MODEL['Failure'])

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    NODE = args.node
    DIGEST = args.sha256
    unittest.main(argv=['loop-initializer-controls'], verbosity=1)
