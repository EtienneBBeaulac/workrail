"""Domain assertion definition for the copied Python/Node proof contract."""
import argparse
from dataclasses import dataclass
import hashlib
from enum import Enum
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import tempfile

class Outcome(str, Enum):
    SUCCESS = 'success'
    PARTIAL = 'partial'
    ABANDONED = 'abandoned'
    ERROR = 'error'


OUTCOMES = tuple(Outcome)
MAXIMUM_OUTPUT = 8192
MAXIMUM_EXECUTABLE = 256 * 1024 * 1024


@dataclass(frozen=True)
class Failure:
    detail: str


@dataclass(frozen=True)
class Reported:
    expected: Outcome
    actual: Outcome | None
    completed: bool


@dataclass(frozen=True)
class Observation:
    completed: bool
    unknown: Outcome | None
    reported: tuple[Reported, ...]


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate observation field')
        result[key] = value
    return result


def decode(raw: bytes) -> Observation | Failure:
    try:
        value = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError, RecursionError):
        return Failure('Unreadable observation')
    if (not isinstance(value, dict) or set(value) != {'version', 'supported', 'completed', 'unknown', 'reported'}
            or type(value['version']) is not int or value['version'] != 1
            or value['supported'] != sorted(outcome.value for outcome in OUTCOMES)
            or type(value['completed']) is not bool
            or value['unknown'] not in (None, *OUTCOMES)
            or not isinstance(value['reported'], list) or len(value['reported']) != len(OUTCOMES)):
        return Failure('Invalid observation shape')
    rows = []
    for expected, row in zip(OUTCOMES, value['reported']):
        if (not isinstance(row, dict) or set(row) != {'expected', 'actual', 'completed'}
                or row['expected'] != expected or row['actual'] not in (None, *OUTCOMES)
                or type(row['completed']) is not bool):
            return Failure('Incomplete or invalid reported outcome population')
        rows.append(Reported(expected, None if row['actual'] is None else Outcome(row['actual']), row['completed']))
    return Observation(value['completed'], None if value['unknown'] is None else Outcome(value['unknown']), tuple(rows))


def file_digest(path: Path) -> str | Failure:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as file:
            import stat
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAXIMUM_EXECUTABLE:
                return Failure('Invalid executable file')
            digest = hashlib.sha256()
            remaining = MAXIMUM_EXECUTABLE + 1
            while remaining:
                data = file.read(min(1024 * 1024, remaining))
                if not data:
                    return digest.hexdigest()
                digest.update(data)
                remaining -= len(data)
            return Failure('Executable exceeds bound')
    except OSError:
        return Failure('Executable unavailable')


def output_limit():
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAXIMUM_OUTPUT, MAXIMUM_OUTPUT))


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
    # Only valid observations reach semantic assertions in this declared definition.
    assert result.completed
    assert result.unknown is None
    for row in result.reported:
        assert row.completed
        assert row.actual == row.expected
