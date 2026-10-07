"""Verdict routing assertions with the real schema and locked dependency bytes."""
import argparse
import base64
from dataclasses import dataclass
from enum import Enum
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import subprocess
import tarfile
import tempfile
from types import MappingProxyType

# Existing boundary primitives are witnessed too, without changing prior definitions.
helpers = runpy.run_path(str(Path(__file__).with_name('metrics-outcome.py')))
Failure = helpers['Failure']
unique = helpers['unique']
file_digest = helpers['file_digest']
output_limit = helpers['output_limit']
MAXIMUM_OUTPUT = helpers['MAXIMUM_OUTPUT']
ARCHIVE = 'experiments/answer-driven-execution/proofs/vendor/zod-3.25.76.tgz'
MAXIMUM_ARCHIVE = 2 * 1024 * 1024
MAXIMUM_EXPANDED = 8 * 1024 * 1024
MAXIMUM_FILES = 1024


class Verdict(str, Enum):
    APPROVED = 'approved'
    REJECTED = 'rejected'
    UNCERTAIN = 'uncertain'


class Case(str, Enum):
    MISSING = 'missing'
    APPROVED = 'approved'
    INVALID = 'invalid'
    REJECTED = 'rejected'
    UNCERTAIN = 'uncertain'


EXPECTED = MappingProxyType({Case.MISSING: (Verdict.UNCERTAIN, 'low'),
    Case.APPROVED: (Verdict.APPROVED, 'high'), Case.INVALID: (Verdict.UNCERTAIN, 'low'),
    Case.REJECTED: (Verdict.REJECTED, 'high'), Case.UNCERTAIN: (Verdict.UNCERTAIN, 'high')})


@dataclass(frozen=True)
class Row:
    case: Case
    verdict: Verdict
    confidence: str
    step_id: str


@dataclass(frozen=True)
class Observation:
    rows: tuple[Row, ...]


def decode(raw: bytes) -> Observation | Failure:
    try:
        value = json.loads(raw, object_pairs_hook=unique)
        if (not isinstance(value, dict) or set(value) != {'version', 'rows'}
                or type(value['version']) is not int or value['version'] != 1
                or not isinstance(value['rows'], list) or len(value['rows']) != len(Case)):
            return Failure('Invalid observation shape')
        rows = []
        for case, row in zip(Case, value['rows']):
            if (not isinstance(row, dict) or set(row) != {'case', 'verdict', 'confidence', 'stepId'}
                    or row['case'] != case or row['verdict'] not in tuple(Verdict)
                    or row['confidence'] not in ('high', 'medium', 'low')
                    or not isinstance(row['stepId'], str) or len(row['stepId']) > 128):
                return Failure('Incomplete or invalid verdict observation')
            rows.append(Row(case, Verdict(row['verdict']), row['confidence'], row['stepId']))
        return Observation(tuple(rows))
    except (ValueError, UnicodeError, RecursionError):
        return Failure('Unreadable observation')


def materialize(root: Path, destination: Path) -> Path | Failure:
    """Validate the complete archive before any file is published in a fresh directory."""
    try:
        with (root/ARCHIVE).open('rb') as file:
            raw = file.read(MAXIMUM_ARCHIVE + 1)
        lock = json.loads((root/'package-lock.json').read_bytes(), object_pairs_hook=unique)
        package = lock['packages']['node_modules/zod']
        integrity = 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode()
        if not raw or len(raw) > MAXIMUM_ARCHIVE or package['integrity'] != integrity:
            return Failure('Dependency archive integrity mismatch')
        files = {}
        total = 0
        with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
            for member in archive:
                parts = member.name.split('/')
                if (not member.isfile() or len(parts) < 2 or parts[0] != 'package'
                        or any(part in ('', '.', '..') for part in parts)
                        or any(char in member.name for char in ('\\', '\0', '\n', '\r'))
                        or member.name in files or member.size < 0):
                    return Failure('Invalid dependency archive member')
                total += member.size
                if len(files) >= MAXIMUM_FILES or total > MAXIMUM_EXPANDED:
                    return Failure('Dependency archive exceeds bound')
                data = archive.extractfile(member).read(member.size + 1)
                if len(data) != member.size:
                    return Failure('Incomplete dependency archive member')
                files[member.name] = data
        metadata = json.loads(files['package/package.json'], object_pairs_hook=unique)
        if (metadata['name'] != 'zod' or metadata['version'] != package['version']
                or metadata.get('dependencies') or metadata.get('optionalDependencies')
                or metadata.get('peerDependencies') or metadata.get('module') != './index.js'
                or 'package/index.js' not in files or 'package/LICENSE' not in files):
            return Failure('Unsupported dependency closure')
        if destination.exists():
            return Failure('Dependency destination must be fresh')
        destination.mkdir()
        for name, data in files.items():
            path = destination.joinpath(*PurePosixPath(name).parts[1:])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return destination
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError):
        return Failure('Dependency archive unavailable')


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


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    result = observe(args.root, args.node, args.sha256)
    if isinstance(result, Failure):
        parser.exit(2, result.detail + '\n')
    for row in result.rows:
        assert row.verdict == EXPECTED[row.case][0]
        assert row.confidence == EXPECTED[row.case][1]
        assert row.step_id == 'checked-step'
