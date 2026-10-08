"""Bounded native checkpoint/fork assertion, separate from observation execution."""
import argparse
from dataclasses import dataclass
from enum import Enum
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import tempfile

BASE = Path(__file__).resolve().parent
SHARED = runpy.run_path(str(BASE / 'workflow-pinning.py'))
RUNTIME = runpy.run_path(str(BASE / 'metrics-outcome.py'))
Failure = SHARED['Failure']


class Preservation(str, Enum):
    RETAINED = 'retained'
    CHANGED = 'changed'


class OperationOutcome(str, Enum):
    REFUSED = 'validation_failed'
    ACCEPTED = 'accepted'


class Contract(str, Enum):
    CHECKPOINT = 'checkpoint'
    FORK = 'fork'


@dataclass(frozen=True)
class PositivePopulation:
    value: int

    def __post_init__(self):
        if type(self.value) is not int or not 1 <= self.value <= 128:
            raise ValueError('Invalid positive native population')


@dataclass(frozen=True)
class Checkpoint:
    identity: Preservation
    replay_history: Preservation
    original_snapshot: Preservation
    prior_events: Preservation
    wrong_history: Preservation
    wrong_fixture_bytes: Preservation
    wrong_operation: OperationOutcome
    fixture_files: PositivePopulation
    original_task: str | None
    advanced_task: str | None


@dataclass(frozen=True)
class Fork:
    children: PositivePopulation
    tips: PositivePopulation
    first_task: str | None
    second_task: str | None
    response: Preservation
    history: Preservation
    prior_events: Preservation
    children_are_tips: Preservation


@dataclass(frozen=True)
class Observation:
    checkpoint: Checkpoint
    fork: Fork


FIELDS = frozenset(('kind', 'checkpointIdentityPreserved', 'replayHistoryIdentical',
    'wrongOperation', 'wrongHistoryIdentical', 'wrongFixtureBytesIdentical',
    'nativeFixtureFiles', 'originalSnapshotPreserved', 'priorCheckpointEventsPreserved',
    'checkpointPending', 'advancedPending', 'distinctChildren', 'tips', 'child1Pending',
    'child2Pending', 'forkResponseIdentical', 'forkReplayHistoryIdentical',
    'priorForkEventsPreserved', 'forkChildrenAreTips'))


def decode(raw: bytes) -> Observation | Failure:
    try:
        value = json.loads(raw, object_pairs_hook=SHARED['unique'])
        if not isinstance(value, dict) or set(value) != FIELDS or value['kind'] != 'prototype':
            raise ValueError('Incomplete observation')

        def preserved(name):
            observed = value[name]
            if type(observed) is not bool:
                raise ValueError('Invalid native comparison')
            return Preservation.RETAINED if observed else Preservation.CHANGED

        def task(name):
            observed = value[name]
            if observed is not None and (not isinstance(observed, str)
                    or not 1 <= len(observed.encode('utf8')) <= 128):
                raise ValueError('Invalid task identity')
            return observed

        if value['wrongOperation'] not in ('validation_failed', 'accepted'):
            raise ValueError('Unexpected native refusal')
        checkpoint = Checkpoint(preserved('checkpointIdentityPreserved'),
            preserved('replayHistoryIdentical'), preserved('originalSnapshotPreserved'),
            preserved('priorCheckpointEventsPreserved'), preserved('wrongHistoryIdentical'),
            preserved('wrongFixtureBytesIdentical'), OperationOutcome(value['wrongOperation']),
            PositivePopulation(value['nativeFixtureFiles']), task('checkpointPending'), task('advancedPending'))
        fork = Fork(PositivePopulation(value['distinctChildren']), PositivePopulation(value['tips']),
            task('child1Pending'), task('child2Pending'), preserved('forkResponseIdentical'),
            preserved('forkReplayHistoryIdentical'), preserved('priorForkEventsPreserved'),
            preserved('forkChildrenAreTips'))
        return Observation(checkpoint, fork)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        return Failure('Invalid complete native observation')


def verify(observation: Observation, contract: Contract) -> None:
    if contract is Contract.CHECKPOINT:
        cp = observation.checkpoint
        assert cp.identity is Preservation.RETAINED
        assert cp.replay_history is Preservation.RETAINED
        assert cp.original_snapshot is Preservation.RETAINED
        assert cp.prior_events is Preservation.RETAINED
        assert cp.wrong_history is Preservation.RETAINED
        assert cp.wrong_fixture_bytes is Preservation.RETAINED
        assert cp.wrong_operation is OperationOutcome.REFUSED
        assert cp.original_task == 'one' and cp.advanced_task == 'two'
    else:
        fork = observation.fork
        assert fork.children.value == 2 and fork.tips.value == 2
        assert fork.first_task == fork.second_task == 'two'
        assert fork.response is Preservation.RETAINED
        assert fork.history is Preservation.RETAINED
        assert fork.prior_events is Preservation.RETAINED
        assert fork.children_are_tips is Preservation.RETAINED


def observe(root: Path, node: Path, digest: str) -> Observation | Failure:
    if not root.is_absolute() or not node.is_absolute() or re.fullmatch('[0-9a-f]{64}', digest) is None:
        return Failure('Explicit source/runtime capability required')
    if os.environ.get('FPIPE_IN_SABOTAGE') == '1':
        copied = os.environ.get('FPIPE_NODE_EXECUTABLE')
        if not copied or not Path(copied).is_absolute() or os.environ.get('FPIPE_NODE_SHA256') != digest:
            return Failure('Copied runtime capability required')
        node = Path(copied)
    if RUNTIME['file_digest'](node) != digest:
        return Failure('Runtime identity mismatch')
    try:
        inputs = json.loads(Path(__file__).with_suffix('.inputs.json').read_bytes(),
                           object_pairs_hook=SHARED['unique'])
        with tempfile.TemporaryDirectory(prefix='legacy-continuity-') as directory:
            stage = Path(directory) / 'source'
            error = SHARED['materialize'](root, stage, inputs)
            if error is not None:
                return error
            fixture = Path(directory) / 'fixture'
            fixture.mkdir()
            (fixture / 'workflows').mkdir()
            with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                result = subprocess.run([str(node), str(Path(__file__).with_suffix('.mjs')),
                    str(stage), str(fixture)], env={}, stdin=subprocess.DEVNULL,
                    stdout=stdout, stderr=stderr, timeout=25, preexec_fn=RUNTIME['output_limit'])
                stdout.seek(0)
                stderr.seek(0)
                raw = stdout.read(8193)
                errors = stderr.read(8193)
            if result.returncode != 0 or len(raw) > 8192 or len(errors) > 8192:
                return Failure('Native observation unavailable within bounds')
            if RUNTIME['file_digest'](node) != digest:
                return Failure('Runtime changed during observation')
            return decode(raw)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        return Failure('Native input or execution unavailable')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--contract', type=Contract, required=True)
    args = parser.parse_args()
    observation = observe(args.root, args.node, args.sha256)
    if isinstance(observation, Failure):
        parser.exit(2, observation.detail + '\n')
    verify(observation, args.contract)
