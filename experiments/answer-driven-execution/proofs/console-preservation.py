"""Accepted legacy notes and review fields through real durable console projection."""
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
Failure = SHARED['Failure']
HELPERS = SHARED['SHARED']
unique = SHARED['unique']
MAXIMUM_OUTPUT = 8192
NOTES = '# Review\n\nPreserved café observations.\n'
EXPECTED_JSON = b'[{"confidence":"high","findings":[{"causalLink":{"effect":"output","trigger":"input"},"file":"control.ts","findingCategory":"correctness","remediation":"Keep exact data.","severity":"minor","startLine":1,"summary":"A control finding."}],"kind":"wr.review_verdict","summary":"One control finding.","verdict":"minor"}]'

class History(str, Enum):
    UNCHANGED = 'unchanged'
    CHANGED = 'changed'

@dataclass(frozen=True)
class PositivePopulation:
    count: int
    def __post_init__(self):
        if type(self.count) is not int or not 1 <= self.count <= 128:
            raise ValueError('Population must be a bounded positive integer')

@dataclass(frozen=True)
class CapturedJSON:
    canonical: bytes
    def __post_init__(self):
        if not isinstance(self.canonical, bytes) or not 1 <= len(self.canonical) <= 4096:
            raise ValueError('Captured JSON must be bounded bytes')
        value = json.loads(self.canonical, object_pairs_hook=unique)
        if encode_json(value) != self.canonical:
            raise ValueError('Captured JSON must be canonical')

def encode_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf8')

@dataclass(frozen=True)
class Observation:
    notes: str | None
    artifacts: CapturedJSON
    history: History
    files: PositivePopulation
    events: PositivePopulation

def decode(raw: bytes) -> Observation | Failure:
    try:
        row = json.loads(raw, object_pairs_hook=unique)
        if (not isinstance(row, dict) or set(row) != {'kind', 'notes', 'artifacts', 'unchangedBytes', 'files', 'events'}
                or row['kind'] != 'observed' or type(row['unchangedBytes']) is not bool
                or not isinstance(row['artifacts'], list)
                or row['notes'] is not None and not isinstance(row['notes'], str)
                or row['notes'] is not None and len(row['notes'].encode('utf8')) > 4096):
            return Failure('Invalid complete console observation')
        return Observation(row['notes'], CapturedJSON(encode_json(row['artifacts'])),
            History.UNCHANGED if row['unchangedBytes'] else History.CHANGED,
            PositivePopulation(row['files']), PositivePopulation(row['events']))
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
        return Failure('Console observation unreadable')

def assert_observation(value: Observation) -> None:
    if value.notes != NOTES:
        raise AssertionError('Exact accepted notes lost in console projection')
    if value.artifacts.canonical != EXPECTED_JSON:
        raise AssertionError('Exact accepted review metadata lost in console projection')
    if value.history is not History.UNCHANGED:
        raise AssertionError('Console read changed native durable storage')

def observe(root: Path, node: Path, digest: str) -> Observation | Failure:
    if not re.fullmatch('[0-9a-f]{64}', digest) or not node.is_absolute():
        return Failure('Declare absolute executable and SHA256')
    if os.environ.get('FPIPE_IN_SABOTAGE') == '1':
        copied = os.environ.get('FPIPE_NODE_EXECUTABLE')
        if not copied or os.environ.get('FPIPE_NODE_SHA256') != digest or not Path(copied).is_absolute():
            return Failure('Copied runtime capability missing or mismatched')
        node = Path(copied)
    if HELPERS['file_digest'](node) != digest:
        return Failure('Executable identity mismatch')
    try:
        inputs = json.loads(HELPERS['regular_bytes'](BASE / 'console-preservation.inputs.json', 64 * 1024), object_pairs_hook=unique)
        with tempfile.TemporaryDirectory(prefix='console-preservation-proof-') as temporary:
            stage = Path(temporary) / 'inputs'
            failure = SHARED['materialize'](root, stage, inputs)
            if failure is not None:
                return failure
            with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                result = subprocess.run([str(node), str(BASE / 'console-preservation.mjs'), str(stage)],
                    cwd=stage, env={}, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                    timeout=15, preexec_fn=HELPERS['output_limit'])
                stdout.seek(0); stderr.seek(0)
                raw, errors = stdout.read(MAXIMUM_OUTPUT + 1), stderr.read(MAXIMUM_OUTPUT + 1)
        if result.returncode != 0 or len(raw) > MAXIMUM_OUTPUT or len(errors) > MAXIMUM_OUTPUT:
            return Failure('Accepted fixture or projection unavailable within bounds')
        if HELPERS['file_digest'](node) != digest:
            return Failure('Executable changed during observation')
        return decode(raw)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return Failure('Console execution unavailable')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    result = observe(args.root, args.node, args.sha256)
    if isinstance(result, Failure):
        parser.exit(2, result.detail + '\n')
    assert_observation(result)
