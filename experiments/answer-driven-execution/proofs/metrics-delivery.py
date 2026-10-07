"""Assert selected-run commit provenance from strict copied-source observations."""
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
from types import MappingProxyType

# Reuse the sealed boundary primitives without changing the existing R8 definition.
helpers = runpy.run_path(str(Path(__file__).with_name('metrics-outcome.py')))
Failure = helpers['Failure']
unique = helpers['unique']
file_digest = helpers['file_digest']
output_limit = helpers['output_limit']
MAXIMUM_OUTPUT = helpers['MAXIMUM_OUTPUT']


class Case(str, Enum):
    MATCHING = 'matching'
    CONTEXT = 'context'
    COMPLETED = 'completed'
    OTHER_CONTEXT = 'other_context'
    OTHER_COMPLETED = 'other_completed'
    OTHER_BEFORE_MATCH = 'other_before_match'
    EMPTY_MATCH = 'empty_match'


EXPECTED = MappingProxyType({
    Case.MATCHING: ('a' * 40,),
    Case.CONTEXT: ('b' * 40,),
    Case.COMPLETED: ('c' * 40,),
    Case.OTHER_CONTEXT: ('b' * 40,),
    Case.OTHER_COMPLETED: ('c' * 40,),
    Case.OTHER_BEFORE_MATCH: ('a' * 40,),
    Case.EMPTY_MATCH: ('b' * 40,),
})


@dataclass(frozen=True)
class Row:
    case: Case
    actual: tuple[str, ...]
    completed: bool


@dataclass(frozen=True)
class Observation:
    rows: tuple[Row, ...]


def decode(raw: bytes) -> Observation | Failure:
    try:
        value = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError, RecursionError):
        return Failure('Unreadable observation')
    if (not isinstance(value, dict) or set(value) != {'version', 'rows'}
            or type(value['version']) is not int or value['version'] != 1
            or not isinstance(value['rows'], list) or len(value['rows']) != len(Case)):
        return Failure('Invalid observation shape')
    rows = []
    for case, row in zip(Case, value['rows']):
        if (not isinstance(row, dict) or set(row) != {'case', 'actual', 'completed'}
                or row['case'] != case or type(row['completed']) is not bool
                or not isinstance(row['actual'], list) or len(row['actual']) > 32
                or any(not isinstance(sha, str) or re.fullmatch(r'[0-9a-f]{40}', sha) is None for sha in row['actual'])):
            return Failure('Incomplete or invalid provenance observation')
        rows.append(Row(case, tuple(row['actual']), row['completed']))
    return Observation(tuple(rows))


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
    bridge = Path(__file__).with_suffix('.mjs')
    try:
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            # The child shares the outer proof group, so its cancellation reaches Node.
            result = subprocess.run([str(node), str(bridge), str(root)], env={}, stdin=subprocess.DEVNULL,
                stdout=stdout, stderr=stderr, timeout=10, preexec_fn=output_limit)
            stdout.seek(0); stderr.seek(0)
            raw = stdout.read(MAXIMUM_OUTPUT + 1); errors = stderr.read(MAXIMUM_OUTPUT + 1)
    except (OSError, subprocess.SubprocessError):
        return Failure('Observation execution unavailable')
    if result.returncode != 0 or len(raw) > MAXIMUM_OUTPUT or len(errors) > MAXIMUM_OUTPUT:
        return Failure('Observation did not complete within bounds')
    if file_digest(node) != digest:
        return Failure('Executable changed during observation')
    return decode(raw)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    result = observe(args.root, args.node, args.sha256)
    if isinstance(result, Failure):
        parser.exit(2, result.detail + '\n')
    # Assertions belong to the declared definition, not the observation producer.
    for row in result.rows:
        assert row.completed
        assert row.actual == EXPECTED[row.case]
