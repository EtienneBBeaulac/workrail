"""Initializer decisions through the real compiler and interpreter, with sealed inputs."""
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
import stat
import subprocess
import tarfile
import tempfile

HELPERS = runpy.run_path(str(Path(__file__).with_name('metrics-outcome.py')))
Failure = HELPERS['Failure']
unique = HELPERS['unique']
file_digest = HELPERS['file_digest']
output_limit = HELPERS['output_limit']
MAXIMUM_OUTPUT = 8192
PACKAGES = ('typescript', 'reflect-metadata', 'tsyringe', 'neverthrow', 'zod', 'tsyringe/node_modules/tslib')
MAXIMUM_ARCHIVE = 12 * 1024 * 1024
MAXIMUM_EXPANDED = 64 * 1024 * 1024

class Case(str, Enum):
    WHILE_CONTINUE = 'while_continue'
    WHILE_STOP = 'while_stop'
    UNTIL_CONTINUE = 'until_continue'
    UNTIL_STOP = 'until_stop'

class Step(str, Enum):
    INITIALIZE = 'initialize'
    BODY = 'body'
    FINISH = 'finish'

class State(str, Enum):
    INIT = 'init'
    RUNNING = 'running'
    COMPLETE = 'complete'

class Phase(str, Enum):
    COMPILE = 'compile'
    INITIALIZE = 'initialize'
    SEED = 'seed'
    BODY = 'body'
    FINISH = 'finish'

@dataclass(frozen=True)
class Observed:
    case: Case
    selected: Step | None
    visited: tuple[Step, ...]
    complete: bool
    state: State
    pending: Step | None

@dataclass(frozen=True)
class Refused:
    case: Case
    phase: Phase

@dataclass(frozen=True)
class Observation:
    rows: tuple[Observed | Refused, ...]

def captured_bytes(fd: int, limit: int) -> bytes:
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError('Input is not bounded regular bytes')
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            data = handle.read(limit + 1)
        after = os.fstat(fd)
        if (len(data) > limit or (before.st_ino, before.st_size, before.st_mtime_ns)
                != (after.st_ino, after.st_size, after.st_mtime_ns)):
            raise ValueError('Input changed during read')
        return data
    finally:
        os.close(fd)

def regular_bytes(path: Path, limit: int) -> bytes:
    return captured_bytes(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), limit)

def root_bytes(root: Path, relative: str, limit: int) -> bytes:
    parts = relative.split('/')
    if any(part in ('', '.', '..') for part in parts) or any(char in relative for char in ('\\', '\0', '\n', '\r')):
        raise ValueError('Invalid relative input')
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    return captured_bytes(descriptor, limit)

def archive_files(raw: bytes, name: str, declaration: dict) -> dict[str, bytes] | Failure:
    try:
        integrity = 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode()
        if not raw or len(raw) > MAXIMUM_ARCHIVE or declaration['integrity'] != integrity:
            return Failure('Dependency archive identity mismatch')
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
                if len(files) >= 1500 or member.size > MAXIMUM_ARCHIVE or total > MAXIMUM_EXPANDED:
                    return Failure('Dependency archive exceeds bound')
                payload = archive.extractfile(member).read(member.size + 1)
                if len(payload) != member.size:
                    return Failure('Incomplete dependency archive member')
                files[member.name] = payload
        package = json.loads(files['package/package.json'], object_pairs_hook=unique)
        if package['name'] != name.split('/node_modules/')[-1] or package['version'] != declaration['version']:
            return Failure('Dependency package identity mismatch')
        for field in ('dependencies', 'optionalDependencies', 'peerDependencies'):
            if package.get(field, {}) != declaration.get(field, {}):
                return Failure('Dependency metadata mismatch')
        return {str(PurePosixPath(*PurePosixPath(path).parts[1:])): payload for path, payload in files.items()}
    except (OSError, ValueError, TypeError, KeyError, tarfile.TarError):
        return Failure('Dependency archive unavailable')

def materialize(root: Path, stage: Path, inputs: dict) -> Failure | None:
    try:
        if (set(inputs) != {'version', 'sources', 'routines', 'dependencies'}
                or type(inputs['version']) is not int or inputs['version'] != 1
                or inputs['dependencies'] != list(PACKAGES) or not isinstance(inputs['sources'], list)
                or not 1 <= len(inputs['sources']) <= 128 or len(set(inputs['sources'])) != len(inputs['sources'])):
            return Failure('Invalid input declaration')
        if stage.exists():
            return Failure('Materialization requires a fresh directory')
        source_files = {}
        for relative in inputs['sources']:
            path = PurePosixPath(relative)
            if (not isinstance(relative, str) or str(path) != relative or path.is_absolute()
                    or any(part in ('', '.', '..') for part in relative.split('/'))
                    or any(char in relative for char in ('\\', '\0', '\n', '\r'))
                    or path.parts[0] not in ('src', 'workflows', 'tsconfig.base.json')):
                return Failure('Invalid source path')
            source_files[relative] = root_bytes(root, relative, 1024 * 1024)
        if sum(map(len, source_files.values())) > 4 * 1024 * 1024:
            return Failure('Source closure exceeds bound')
        lock = json.loads(root_bytes(root, 'package-lock.json', 4 * 1024 * 1024), object_pairs_hook=unique)
        libraries = {}
        for name in PACKAGES:
            declaration = lock['packages']['node_modules/' + name]
            path = 'experiments/answer-driven-execution/proofs/vendor/' + name.split('/')[-1] + '-' + declaration['version'] + '.tgz'
            files = archive_files(root_bytes(root, path, MAXIMUM_ARCHIVE), name, declaration)
            if isinstance(files, Failure):
                return files
            libraries[name] = files
        if sum(len(data) for files in libraries.values() for data in files.values()) > MAXIMUM_EXPANDED:
            return Failure('Dependency closure exceeds bound')
        # No observer runs until the complete source and dependency closure validates.
        stage.mkdir()
        for relative, data in source_files.items():
            path = stage / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        for name, files in libraries.items():
            for relative, data in files.items():
                path = stage / 'node_modules' / name / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
        return None
    except (OSError, ValueError, TypeError, KeyError):
        return Failure('Declared input closure unavailable')

def decode(raw: bytes, routines: list[str]) -> Observation | Failure:
    try:
        value = json.loads(raw, object_pairs_hook=unique)
        if (not isinstance(value, dict) or set(value) != {'version', 'rows', 'routines', 'routineWarnings'}
                or type(value['version']) is not int or value['version'] != 1
                or value['routines'] != routines or type(value['routineWarnings']) is not int or value['routineWarnings'] != 0
                or not isinstance(value['rows'], list) or len(value['rows']) != len(Case)):
            return Failure('Invalid observation or routine context')
        rows = []
        for case, row in zip(Case, value['rows']):
            if not isinstance(row, dict) or row.get('case') != case:
                return Failure('Incomplete case population')
            if row.get('kind') == 'refused':
                if set(row) != {'case', 'kind', 'phase'} or row['phase'] not in tuple(Phase):
                    return Failure('Invalid domain refusal')
                rows.append(Refused(case, Phase(row['phase'])))
            elif row.get('kind') == 'observed':
                if (set(row) != {'case', 'kind', 'selected', 'visited', 'isComplete', 'state', 'pending'}
                        or row['selected'] not in (None, *Step) or row['pending'] not in (None, *Step)
                        or not isinstance(row['visited'], list) or not 1 <= len(row['visited']) <= 4
                        or any(step not in tuple(Step) for step in row['visited'])
                        or type(row['isComplete']) is not bool or row['state'] not in tuple(State)):
                    return Failure('Invalid observed path')
                rows.append(Observed(case, None if row['selected'] is None else Step(row['selected']),
                    tuple(Step(step) for step in row['visited']), row['isComplete'], State(row['state']),
                    None if row['pending'] is None else Step(row['pending'])))
            else:
                return Failure('Unknown observation kind')
        return Observation(tuple(rows))
    except (ValueError, TypeError, UnicodeError, RecursionError):
        return Failure('Unreadable observation')

def assert_observation(value: Observation) -> None:
    for row in value.rows:
        if isinstance(row, Refused):
            raise AssertionError('Valid case refused: ' + row.case.value + '/' + row.phase.value)
        continuing = row.case in (Case.WHILE_CONTINUE, Case.UNTIL_CONTINUE)
        expected = (Step.INITIALIZE, Step.BODY, Step.FINISH) if continuing else (Step.INITIALIZE, Step.FINISH)
        if (row.selected is not (Step.BODY if continuing else Step.FINISH) or row.visited != expected
                or not row.complete or row.state is not State.COMPLETE or row.pending is not None):
            raise AssertionError('Initializer path mismatch: ' + row.case.value)

def observe(root: Path, node: Path, digest: str) -> Observation | Failure:
    if not re.fullmatch('[0-9a-f]{64}', digest) or not node.is_absolute():
        return Failure('Declare absolute executable and SHA256')
    if os.environ.get('FPIPE_IN_SABOTAGE') == '1':
        copied = os.environ.get('FPIPE_NODE_EXECUTABLE')
        if not copied or os.environ.get('FPIPE_NODE_SHA256') != digest or not Path(copied).is_absolute():
            return Failure('Copied runtime capability missing or mismatched')
        node = Path(copied)
    if file_digest(node) != digest:
        return Failure('Executable identity mismatch')
    try:
        inputs = json.loads(regular_bytes(Path(__file__).with_name('loop-initializer.inputs.json'), 32 * 1024), object_pairs_hook=unique)
        with tempfile.TemporaryDirectory(prefix='loop-initializer-proof-') as temporary:
            stage = Path(temporary) / 'inputs'
            failure = materialize(root, stage, inputs)
            if failure is not None:
                return failure
            with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                result = subprocess.run([str(node), str(Path(__file__).with_suffix('.mjs')), str(stage)],
                    cwd=stage, env={}, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                    timeout=15, preexec_fn=output_limit)
                stdout.seek(0); stderr.seek(0)
                raw = stdout.read(MAXIMUM_OUTPUT + 1); errors = stderr.read(MAXIMUM_OUTPUT + 1)
        if result.returncode != 0 or len(raw) > MAXIMUM_OUTPUT or len(errors) > MAXIMUM_OUTPUT:
            return Failure('Observation did not complete within bounds')
        if file_digest(node) != digest:
            return Failure('Executable changed during observation')
        return decode(raw, inputs['routines'])
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return Failure('Observation unavailable')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    result = observe(args.root, args.node, args.sha256)
    if isinstance(result, Failure):
        parser.exit(2, result.detail + '\n')
    assert_observation(result)
