"""Assert real reads verify every artifact of complete synthetic Stage A/B declarations."""
import argparse
from dataclasses import dataclass
from enum import Enum
import json
import os
from pathlib import Path
import re
import resource
import runpy
import subprocess
import tempfile
from types import MappingProxyType

helpers = runpy.run_path(str(Path(__file__).with_name('gate-verdict.py')))
Failure = helpers['Failure']
unique = helpers['unique']
file_digest = helpers['file_digest']
materialize = helpers['materialize']
MAXIMUM_OUTPUT = 256 * 1024

def output_limit():
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAXIMUM_OUTPUT, MAXIMUM_OUTPUT))

class Stage(str, Enum):
    A = 'A'
    B = 'B'

class Fault(str, Enum):
    INTACT = 'intact'
    CHANGED = 'changed'
    MISSING = 'missing'

class Kind(str, Enum):
    VERIFIED = 'manifest_verified'
    REJECTED = 'rejected'
    CANCELLED = 'cancelled'

class Phase(str, Enum):
    DECLARATIVE = 'declarative'
    ARTIFACTS = 'artifacts'

@dataclass(frozen=True)
class Case:
    stage: Stage
    fault: Fault
    target: str | None

# Independent specification; never inferred from production extraction or bridge output.
ARTIFACTS = MappingProxyType({
    Stage.A: tuple(sorted(['proofs/protocol.md', 'bin/workrail-baseline', 'bin/workrail-candidate',
        'workflows/stage-a-base.json', 'workflows/stage-a-cand.json', 'proofs/obs-checker.json',
        'proofs/timeout.json', 'proofs/fe-malformed.json', 'proofs/fe-lost-response.json'] +
        [f'fixtures/stage-a-{scenario}-{rep}.json' for scenario in
            ['ordinary', 'malformed', 'lost_response', 'finished_recovery'] for rep in range(1, 6)])),
    Stage.B: tuple(sorted(['proofs/protocol-b.md', 'bin/workrail-baseline-b', 'bin/workrail-candidate-b',
        'workflows/stage-b-base.json', 'workflows/stage-b-cand.json', 'proofs/obs-checker-b.json',
        'proofs/timeout-b.json', 'proofs/fe-missing-summary.json', 'proofs/fe-partial.json',
        'proofs/stage-b-review-equiv.json'] + [f'fixtures/stage-b-{scenario}-{rep}.json' for scenario in
            ['missing_summary', 'recovery_after_partial_work'] for rep in range(1, 6)])),
})
CASES = tuple(case for stage in Stage for case in (Case(stage, Fault.INTACT, None),
    *(Case(stage, fault, path) for path in ARTIFACTS[stage] for fault in [Fault.CHANGED, Fault.MISSING])))

class ErrorKind(str, Enum):
    SCHEMA_ERROR = 'schema_error'
    UNMATCHED_ENVIRONMENT = 'unmatched_environment'
    INVALID_STAGE_SCENARIO = 'invalid_stage_scenario'
    MISSING_SCENARIO_PAIR = 'missing_scenario_pair'
    DUPLICATE_SCENARIO_PAIR = 'duplicate_scenario_pair'
    INVALID_ARM_ORDER = 'invalid_arm_order'
    DUPLICATE_RUN_ID = 'duplicate_run_id'
    DUPLICATE_WORKSPACE_PATH = 'duplicate_workspace_path'
    INVALID_WORKSPACE_PATH = 'invalid_workspace_path'
    OVERLAPPING_WORKSPACE_PATH = 'overlapping_workspace_path'
    INVALID_ARTIFACT_PATH = 'invalid_artifact_path'
    SHARED_OBSERVATION_VALUE = 'shared_observation_value'
    BUDGET_EXCEEDED = 'budget_exceeded'
    INVALID_INVALIDATION_POLICY = 'invalid_invalidation_policy'
    MISSING_PREFLIGHT_PROOF = 'missing_preflight_proof'
    DUPLICATE_PREFLIGHT_PROOF = 'duplicate_preflight_proof'
    OUT_OF_STAGE_PREFLIGHT_PROOF = 'out_of_stage_preflight_proof'
    DISALLOWED_STAGE_PROOF = 'disallowed_stage_proof'
    UNSUPPORTED_FAULT_SCHEDULE = 'unsupported_fault_schedule'
    DUPLICATE_FAULT_DEFINITION = 'duplicate_fault_definition'
    OUT_OF_STAGE_FAULT_DEFINITION = 'out_of_stage_fault_definition'
    CONFLICTING_ARTIFACT_HASH = 'conflicting_artifact_hash'
    READ_ERROR = 'read_error'
    INVALID_CONTENT_TYPE = 'invalid_content_type'
    HASH_MISMATCH = 'hash_mismatch'


@dataclass(frozen=True)
class Error:
    kind: ErrorKind
    path: str | None

@dataclass(frozen=True)
class Row:
    case: Case
    kind: Kind
    scope: str | None
    trial_authorization: bool | None
    total_trials: int | None
    verified_count: int | None
    phase: Phase | None
    errors: tuple[Error, ...]
    reads: tuple[str, ...]

@dataclass(frozen=True)
class Observation:
    rows: tuple[Row, ...]

def decode(raw: bytes) -> Observation | Failure:
    try:
        value = json.loads(raw, object_pairs_hook=unique)
        if (not isinstance(value, dict) or set(value) != {'version', 'rows'}
                or type(value['version']) is not int or value['version'] != 1
                or not isinstance(value['rows'], list) or len(value['rows']) != len(CASES)):
            return Failure('Invalid observation population')
        rows = []
        for case, row in zip(CASES, value['rows']):
            if (not isinstance(row, dict) or set(row) != {'stage', 'fault', 'target', 'kind', 'scope',
                    'trialAuthorization', 'totalPlannedTrials', 'verifiedArtifactCount', 'phase', 'errors', 'reads'}
                    or (row['stage'], row['fault'], row['target']) != (case.stage, case.fault, case.target)
                    or (row['scope'] is not None and (not isinstance(row['scope'], str) or len(row['scope']) > 128))
                    or (row['trialAuthorization'] is not None and type(row['trialAuthorization']) is not bool)
                    or any(row[key] is not None and type(row[key]) is not int for key in ['totalPlannedTrials', 'verifiedArtifactCount'])
                    or not isinstance(row['errors'], list) or len(row['errors']) > 64
                    or not isinstance(row['reads'], list) or len(row['reads']) > 64
                    or any(not isinstance(path, str) or len(path) > 256 for path in row['reads'])):
                return Failure('Incomplete or malformed artifact observation')
            errors = []
            for error in row['errors']:
                if (not isinstance(error, dict) or set(error) != {'kind', 'path'}
                        or not isinstance(error['kind'], str) or len(error['kind']) > 64
                        or (error['path'] is not None and (not isinstance(error['path'], str) or len(error['path']) > 256))):
                    return Failure('Invalid error observation')
                errors.append(Error(ErrorKind(error['kind']), error['path']))
            rows.append(Row(case, Kind(row['kind']), row['scope'], row['trialAuthorization'], row['totalPlannedTrials'],
                row['verifiedArtifactCount'], None if row['phase'] is None else Phase(row['phase']), tuple(errors), tuple(row['reads'])))
        return Observation(tuple(rows))
    except (ValueError, UnicodeError, RecursionError):
        return Failure('Unreadable artifact observation')

def observe(root: Path, node: Path, digest: str) -> Observation | Failure:
    if not root.is_absolute() or not node.is_absolute() or re.fullmatch(r'[0-9a-f]{64}', digest) is None:
        return Failure('Declare absolute source/runtime paths and SHA256')
    if os.environ.get('FPIPE_IN_SABOTAGE') == '1':
        copied = os.environ.get('FPIPE_NODE_EXECUTABLE')
        if not copied or os.environ.get('FPIPE_NODE_SHA256') != digest or not Path(copied).is_absolute():
            return Failure('Copied runtime capability missing or mismatched')
        node = Path(copied)
    if file_digest(node) != digest:
        return Failure('Executable identity mismatch')
    try:
        with tempfile.TemporaryDirectory(prefix='verdict-dependency-') as temp:
            dependency = materialize(root, Path(temp)/'zod')
            if isinstance(dependency, Failure):
                return dependency
            with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                result = subprocess.run([str(node), str(Path(__file__).with_suffix('.mjs')), str(root), str(dependency)],
                    env={}, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                    timeout=15, preexec_fn=output_limit)
                stdout.seek(0); stderr.seek(0)
                raw = stdout.read(MAXIMUM_OUTPUT + 1); errors = stderr.read(MAXIMUM_OUTPUT + 1)
    except (OSError, subprocess.SubprocessError):
        return Failure('Observation execution unavailable')
    if result.returncode != 0 or len(raw) > MAXIMUM_OUTPUT or len(errors) > MAXIMUM_OUTPUT:
        return Failure('Observation did not complete within bounds')
    if file_digest(node) != digest:
        return Failure('Executable changed during observation')
    return decode(raw)


def assert_contract(result: Observation):
    for row in result.rows:
        assert tuple(sorted(row.reads)) == ARTIFACTS[row.case.stage]
        if row.case.fault is Fault.INTACT:
            assert row.kind is Kind.VERIFIED and row.phase is None and not row.errors
            assert row.scope == 'declaration_and_artifact_bytes_only' and row.trial_authorization is False
            assert row.total_trials == (40 if row.case.stage is Stage.A else 20)
            assert row.verified_count == len(ARTIFACTS[row.case.stage])
        else:
            assert row.kind is Kind.REJECTED and row.phase is Phase.ARTIFACTS
            assert row.scope is None and row.trial_authorization is None and row.verified_count is None and row.total_trials is None
            expected = ErrorKind.HASH_MISMATCH if row.case.fault is Fault.CHANGED else ErrorKind.READ_ERROR
            assert row.errors == (Error(expected, row.case.target),)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    result = observe(args.root, args.node, args.sha256)
    if isinstance(result, Failure):
        parser.exit(2, result.detail + '\n')
    assert_contract(result)
