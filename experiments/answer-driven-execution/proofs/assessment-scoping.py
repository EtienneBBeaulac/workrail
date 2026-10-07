"""Assert named-assessment consequence scoping and declaration order."""
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

helpers = runpy.run_path(str(Path(__file__).with_name('metrics-outcome.py')))
Failure = helpers['Failure']
unique = helpers['unique']
file_digest = helpers['file_digest']
output_limit = helpers['output_limit']
MAXIMUM_OUTPUT = helpers['MAXIMUM_OUTPUT']

class Case(str, Enum):
    MISSING = 'missing_named'
    HIGH = 'high_named'
    LOW = 'low_named'
    ORDERED = 'ordered'
    HIGH_RULE = 'high_rule'

class Kind(str, Enum):
    FOLLOWUP = 'require_followup'

class Level(str, Enum):
    LOW = 'low'
    HIGH = 'high'

@dataclass(frozen=True)
class Effect:
    kind: Kind
    assessment_id: str
    dimension_id: str
    trigger_level: Level
    guidance: str

@dataclass(frozen=True)
class Row:
    case: Case
    effects: tuple[Effect, ...]

@dataclass(frozen=True)
class Observation:
    rows: tuple[Row, ...]

EXPECTED = MappingProxyType({
    Case.MISSING: (), Case.HIGH: (),
    Case.LOW: (Effect(Kind.FOLLOWUP, 'named', 'confidence', Level.LOW, 'First guidance'),),
    Case.ORDERED: (Effect(Kind.FOLLOWUP, 'named', 'confidence', Level.LOW, 'First guidance'),
                   Effect(Kind.FOLLOWUP, 'named', 'confidence', Level.LOW, 'Second guidance')),
    Case.HIGH_RULE: (Effect(Kind.FOLLOWUP, 'named', 'confidence', Level.HIGH, 'High guidance'),),
})

def decode(raw: bytes) -> Observation | Failure:
    try:
        value = json.loads(raw, object_pairs_hook=unique)
        if (not isinstance(value, dict) or set(value) != {'version', 'rows'}
                or type(value['version']) is not int or value['version'] != 1
                or not isinstance(value['rows'], list) or len(value['rows']) != len(Case)):
            return Failure('Invalid observation population')
        rows = []
        for case, row in zip(Case, value['rows']):
            if (not isinstance(row, dict) or set(row) != {'case', 'effects'} or row['case'] != case
                    or not isinstance(row['effects'], list) or len(row['effects']) > 16):
                return Failure('Incomplete effect observation')
            effects = []
            for effect in row['effects']:
                if (not isinstance(effect, dict) or set(effect) != {'kind', 'assessmentId', 'dimensionId', 'triggerLevel', 'guidance'}
                        or any(not isinstance(effect[key], str) or len(effect[key]) > 1024 for key in effect)):
                    return Failure('Invalid consequence fields')
                effects.append(Effect(Kind(effect['kind']), effect['assessmentId'], effect['dimensionId'],
                    Level(effect['triggerLevel']), effect['guidance']))
            rows.append(Row(case, tuple(effects)))
        return Observation(tuple(rows))
    except (ValueError, UnicodeError, RecursionError):
        return Failure('Unreadable observation')

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


def assert_contract(result: Observation):
    for row in result.rows:
        assert row.effects == EXPECTED[row.case]

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
