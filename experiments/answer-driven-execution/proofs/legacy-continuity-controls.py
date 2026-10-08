"""Native baseline, semantic source mutations, restoration and refusal controls."""
import argparse
import copy
import json
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest

BASE = Path(__file__).resolve().parent
MODEL = runpy.run_path(str(BASE / 'legacy-continuity.py'))
ROOT = NODE = DIGEST = None
MUTATIONS = (
    ('checkpoint-replay', 'src/mcp/handlers/v2-checkpoint.ts',
     'const dedupeKey = `checkpoint:${String(sessionId)}:${String(runId)}:${String(nodeId)}:${String(attemptId)}`;',
     'const dedupeKey = `checkpoint:${String(sessionId)}:${String(runId)}:${String(nodeId)}:${String(attemptId)}:${idFactory.mintEventId()}`;', 'checkpoint'),
    ('snapshot-rehydrate', 'src/mcp/handlers/v2-execution/continue-rehydrate.ts',
     'snapshotStore.getExecutionSnapshotV1(nodeCreated.data.snapshotRef)',
     "snapshotStore.getExecutionSnapshotV1(truth.events.filter((e): e is Extract<import('../../../v2/durable-core/schemas/session/index.js').DomainEventV1, { kind: 'node_created' }> => e.kind === 'node_created' && e.scope?.runId === String(runId) && e.data.nodeKind !== 'checkpoint').at(-1)!.data.snapshotRef)", 'checkpoint'),
    ('fork-sibling', 'src/mcp/handlers/v2-execution/continue-advance.ts',
     '          recordedEvent: existing,',
     "          recordedEvent: existing.data.outcome.kind === 'advanced' ? { ...existing, data: { ...existing.data, outcome: { ...existing.data.outcome, toNodeId: truth.events.find((e): e is Extract<DomainEventV1, { kind: 'edge_created' }> => e.kind === 'edge_created' && e.data.fromNodeId === String(nodeId))!.data.toNodeId } } } : existing,", 'fork'),
)


def copy_inputs(root, target):
    inputs = json.loads((BASE / 'legacy-continuity.inputs.json').read_text())
    lock = json.loads((root / 'package-lock.json').read_text())
    paths = [*inputs['sources'], 'package.json', 'package-lock.json']
    for name in MODEL['SHARED']['PACKAGES']:
        entry = lock['packages']['node_modules/' + name]
        basename = name.replace('@', '').replace('/', '-') if name.startswith('@') else name.split('/')[-1]
        paths.append('experiments/answer-driven-execution/proofs/vendor/' + basename + '-' + entry['version'] + '.tgz')
    for relative in paths:
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / relative, destination)


class Controls(unittest.TestCase):
    def example(self):
        flags = ('checkpointIdentityPreserved', 'replayHistoryIdentical', 'wrongHistoryIdentical',
            'wrongFixtureBytesIdentical', 'originalSnapshotPreserved', 'priorCheckpointEventsPreserved',
            'forkResponseIdentical', 'forkReplayHistoryIdentical', 'priorForkEventsPreserved', 'forkChildrenAreTips')
        return dict(kind='prototype', wrongOperation='validation_failed', nativeFixtureFiles=7,
            checkpointPending='one', advancedPending='two', distinctChildren=2, tips=2,
            child1Pending='two', child2Pending='two', **{flag: True for flag in flags})

    def test_strict_complete_wire_and_positive_populations(self):
        good = self.example()
        self.assertIsInstance(MODEL['decode'](json.dumps(good).encode()), MODEL['Observation'])
        variants = [{}, {**good, 'extra': 1}, {**good, 'nativeFixtureFiles': True},
                    {**good, 'nativeFixtureFiles': 0}, {**good, 'tips': 129},
                    {**good, 'wrongOperation': 'invented'}, {**good, 'checkpointIdentityPreserved': 1}]
        missing = copy.deepcopy(good)
        del missing['priorForkEventsPreserved']
        variants.append(missing)
        for value in variants:
            self.assertIsInstance(MODEL['decode'](json.dumps(value).encode()), MODEL['Failure'])
        duplicate = json.dumps(good).replace('"kind": "prototype"', '"kind": "prototype", "kind": "prototype"')
        self.assertIsInstance(MODEL['decode'](duplicate.encode()), MODEL['Failure'])

    def test_valid_wrong_observations_reach_each_contract_assertion(self):
        for field, value, contract in [('checkpointPending', None, 'checkpoint'),
                ('originalSnapshotPreserved', False, 'checkpoint'),
                ('wrongFixtureBytesIdentical', False, 'checkpoint'),
                ('distinctChildren', 3, 'fork'), ('forkResponseIdentical', False, 'fork'),
                ('forkChildrenAreTips', False, 'fork')]:
            wire = self.example()
            wire[field] = value
            observed = MODEL['decode'](json.dumps(wire).encode())
            self.assertIsInstance(observed, MODEL['Observation'])
            with self.assertRaises(AssertionError):
                MODEL['verify'](observed, MODEL['Contract'](contract))

    def test_real_native_baseline(self):
        observed = MODEL['observe'](ROOT, NODE, DIGEST)
        self.assertIsInstance(observed, MODEL['Observation'], observed)
        for contract in MODEL['Contract']:
            MODEL['verify'](observed, contract)

    def test_actual_source_mutations_restore_both_contracts(self):
        for name, subject, find, replacement, contract in MUTATIONS:
            with self.subTest(mutation=name), tempfile.TemporaryDirectory(prefix='legacy source control ') as directory:
                copied = Path(directory) / 'root'
                copy_inputs(ROOT, copied)
                target = copied / subject
                original = target.read_text()
                self.assertEqual(original.count(find), 1)
                target.write_text(original.replace(find, replacement))
                observed = MODEL['observe'](copied, NODE, DIGEST)
                self.assertIsInstance(observed, MODEL['Observation'], observed)
                with self.assertRaises(AssertionError):
                    MODEL['verify'](observed, MODEL['Contract'](contract))
                # Mutants must leave the other operation family usable.
                if name == 'fork-sibling':
                    MODEL['verify'](observed, MODEL['Contract'].CHECKPOINT)
                    self.assertEqual(observed.fork.children.value, 2)
                    self.assertEqual(observed.fork.tips.value, 2)
                    self.assertIs(observed.fork.history, MODEL['Preservation'].RETAINED)
                else:
                    MODEL['verify'](observed, MODEL['Contract'].FORK)
                target.write_text(original)
                restored = MODEL['observe'](copied, NODE, DIGEST)
                self.assertIsInstance(restored, MODEL['Observation'], restored)
                for selected in MODEL['Contract']:
                    MODEL['verify'](restored, selected)

    def test_source_and_runtime_refusals_are_not_semantic_red(self):
        self.assertIsInstance(MODEL['observe'](ROOT, NODE, '0' * 64), MODEL['Failure'])
        self.assertIsInstance(MODEL['observe'](ROOT, Path('/missing-node'), DIGEST), MODEL['Failure'])
        subject = Path('src/mcp/handlers/v2-checkpoint.ts')
        with tempfile.TemporaryDirectory(prefix='legacy unavailable ') as directory:
            copied = Path(directory) / 'root'
            copy_inputs(ROOT, copied)
            target = copied / subject
            original = target.read_bytes()
            target.unlink()
            self.assertIsInstance(MODEL['observe'](copied, NODE, DIGEST), MODEL['Failure'])
            target.symlink_to(ROOT / subject)
            self.assertIsInstance(MODEL['observe'](copied, NODE, DIGEST), MODEL['Failure'])
            target.unlink()
            target.write_bytes(b'invalid TypeScript !!!')
            self.assertIsInstance(MODEL['observe'](copied, NODE, DIGEST), MODEL['Failure'])
            target.write_bytes(original)
            archive = next((copied / 'experiments/answer-driven-execution/proofs/vendor').glob('zod-*.tgz'))
            archive.write_bytes(archive.read_bytes()[:-1])
            self.assertIsInstance(MODEL['observe'](copied, NODE, DIGEST), MODEL['Failure'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    ROOT, NODE, DIGEST = args.root, args.node, args.sha256
    unittest.main(argv=[__file__])
