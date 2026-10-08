"""Assert unsafe normalized comparison evidence is rejected by the actual scorer."""
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

helpers = runpy.run_path(str(Path(__file__).with_name('gate-verdict.py')))
Failure = helpers['Failure']
unique = helpers['unique']
file_digest = helpers['file_digest']
output_limit = helpers['output_limit']
MAXIMUM_OUTPUT = helpers['MAXIMUM_OUTPUT']
materialize = helpers['materialize']

class Case(str, Enum):
    INTACT = 'intact'
    LOST = 'lost'
    DUPLICATE = 'duplicate'
    WRONG_RUN = 'wrong_run'
    RECOVERY_WRITE = 'recovery_write'

class Kind(str, Enum):
    SCORED = 'scored'
    INVALID = 'invalid_input'

class Status(str, Enum):
    REJECTED = 'rejected_safety'
    INCOMPLETE = 'incomplete_evidence'
    NO_ADVANTAGE = 'no_advantage'
    INCONCLUSIVE = 'inconclusive'
    MET = 'measurement_thresholds_met'

class Safety(str, Enum):
    LOST = 'lost_accepted_work'
    DUPLICATE = 'duplicate_obligation'
    WRONG_RUN = 'unauthorized_effect'
    RECOVERY_WRITE = 'recovery_mutated_run'

@dataclass(frozen=True)
class Row:
    case: Case
    kind: Kind
    status: Status | None
    scope: str | None
    release_approval: bool | None
    trial_issues: tuple[str, ...] | None
    safety: tuple[Safety, ...] | None
    population: int | None

@dataclass(frozen=True)
class Observation:
    rows: tuple[Row, ...]

def decode(raw: bytes) -> Observation | Failure:
    try:
        value = json.loads(raw, object_pairs_hook=unique)
        if (not isinstance(value, dict) or set(value) != {'version', 'rows'}
                or type(value['version']) is not int or value['version'] != 1
                or not isinstance(value['rows'], list) or len(value['rows']) != len(Case)):
            return Failure('Invalid observation population')
        rows = []
        for case, row in zip(Case, value['rows']):
            if (not isinstance(row, dict) or set(row) != {'case', 'kind', 'status', 'scope', 'releaseApproval', 'trialIssues', 'safety', 'population'}
                    or row['case'] != case):
                return Failure('Incomplete scorer observation')
            kind = Kind(row['kind'])
            if kind is Kind.INVALID:
                if any(row[key] is not None for key in ['status', 'scope', 'releaseApproval', 'trialIssues', 'safety', 'population']):
                    return Failure('Invalid unscored observation')
                rows.append(Row(case, kind, None, None, None, None, None, None))
                continue
            if (not isinstance(row['scope'], str) or len(row['scope']) > 128
                    or type(row['releaseApproval']) is not bool or type(row['population']) is not int
                    or not isinstance(row['safety'], list) or len(row['safety']) > 80
                    or not isinstance(row['trialIssues'], list) or len(row['trialIssues']) > 80
                    or any(not isinstance(issue, str) or len(issue) > 128 for issue in row['trialIssues'])):
                return Failure('Invalid scored fields')
            rows.append(Row(case, kind, Status(row['status']), row['scope'], row['releaseApproval'],
                tuple(row['trialIssues']), tuple(Safety(safety) for safety in row['safety']), row['population']))
        return Observation(tuple(rows))
    except (ValueError, UnicodeError, RecursionError):
        return Failure('Unreadable scorer observation')

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
                    timeout=10, preexec_fn=output_limit)
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
    expected = {Case.INTACT: (), Case.LOST: (Safety.LOST,), Case.DUPLICATE: (Safety.DUPLICATE,),
        Case.WRONG_RUN: (Safety.WRONG_RUN,), Case.RECOVERY_WRITE: (Safety.RECOVERY_WRITE,)}
    for row in result.rows:
        assert row.kind is Kind.SCORED
        assert row.status is (Status.MET if row.case is Case.INTACT else Status.REJECTED)
        assert row.scope == 'normalized_stage_a_evidence_only' and row.release_approval is False
        assert row.population == 40 and row.trial_issues == ()
        assert row.safety == expected[row.case]

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
