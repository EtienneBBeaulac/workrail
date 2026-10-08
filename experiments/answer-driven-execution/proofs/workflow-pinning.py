"""Workflow continuity across three fresh worker processes and real durable storage."""
import argparse
from dataclasses import dataclass
from enum import Enum
import json
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import subprocess
import tempfile

BASE = Path(__file__).resolve().parent
SHARED = runpy.run_path(str(BASE / 'loop-initializer.py'))
Failure = SHARED['Failure']
unique = SHARED['unique']
PACKAGES = (*SHARED['PACKAGES'], '@scure/base', 'ajv', 'fast-deep-equal', 'fast-uri',
    'json-schema-traverse', 'zod-to-json-schema', 'require-from-string')
MAXIMUM_OUTPUT = 8192

class View(str, Enum):
    QUESTION = 'question'
    FINISHED = 'finished'

class Disposition(str, Enum):
    ACCEPTED = 'accepted'
    REJECTED = 'rejected'

@dataclass(frozen=True)
class Run:
    instruction: str
    exact_view: bool
    finish: View
    disposition: Disposition

@dataclass(frozen=True)
class Observation:
    original: Run
    replacement: Run

def materialize(root: Path, stage: Path, inputs: dict) -> Failure | None:
    try:
        if (set(inputs) != {'version', 'sources', 'dependencies'} or type(inputs['version']) is not int
                or inputs['version'] != 1 or inputs['dependencies'] != list(PACKAGES)
                or not isinstance(inputs['sources'], list) or not 1 <= len(inputs['sources']) <= 256
                or len(set(inputs['sources'])) != len(inputs['sources']) or stage.exists()):
            return Failure('Invalid fresh input declaration')
        sources = {}
        for relative in inputs['sources']:
            if not isinstance(relative, str):
                return Failure('Invalid source path')
            path = PurePosixPath(relative)
            if (str(path) != relative or path.is_absolute() or path.parts[0] not in
                    ('src', 'spec', 'workflows', 'tsconfig.base.json')):
                return Failure('Invalid source path')
            sources[relative] = SHARED['root_bytes'](root, relative, 1024 * 1024)
        if sum(map(len, sources.values())) > 4 * 1024 * 1024:
            return Failure('Source closure exceeds bound')
        lock = json.loads(SHARED['root_bytes'](root, 'package-lock.json', 4 * 1024 * 1024), object_pairs_hook=unique)
        libraries = {}
        for name in PACKAGES:
            declaration = lock['packages']['node_modules/' + name]
            basename = name.replace('@', '').replace('/', '-') if name.startswith('@') else name.split('/')[-1]
            relative = 'experiments/answer-driven-execution/proofs/vendor/' + basename + '-' + declaration['version'] + '.tgz'
            files = SHARED['archive_files'](SHARED['root_bytes'](root, relative, SHARED['MAXIMUM_ARCHIVE']), name, declaration)
            if isinstance(files, Failure):
                return files
            libraries[name] = files
        if sum(len(raw) for files in libraries.values() for raw in files.values()) > SHARED['MAXIMUM_EXPANDED']:
            return Failure('Dependency closure exceeds bound')
        stage.mkdir()
        for relative, raw in sources.items():
            path = stage / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        for name, files in libraries.items():
            for relative, raw in files.items():
                path = stage / 'node_modules' / name / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
        (stage / 'package.json').write_text('{}\n')
        return None
    except (OSError, ValueError, TypeError, KeyError, IndexError):
        return Failure('Declared input closure unavailable')

def decode(raw: bytes) -> Observation | Failure:
    try:
        row = json.loads(raw, object_pairs_hook=unique)
        expected = {'kind', 'originalKind', 'originalInstruction', 'replacementKind', 'replacementInstruction',
            'exactOriginalView', 'exactReplacementView', 'originalFinish', 'originalDisposition',
            'replacementFinish', 'replacementDisposition'}
        if (not isinstance(row, dict) or set(row) != expected or row['kind'] != 'observed'
                or row['originalKind'] != 'question' or row['replacementKind'] != 'question'):
            return Failure('Invalid complete observation')
        def run(prefix: str) -> Run:
            instruction = row[prefix + 'Instruction']
            exact = row['exact' + prefix.title() + 'View']
            if not isinstance(instruction, str) or len(instruction.encode('utf8')) > 4096 or type(exact) is not bool:
                raise ValueError('Invalid observed view')
            return Run(instruction, exact, View(row[prefix + 'Finish']), Disposition(row[prefix + 'Disposition']))
        return Observation(run('original'), run('replacement'))
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
        return Failure('Unreadable observation')

def assert_observation(observation: Observation) -> None:
    for name, run, instruction in [('original', observation.original, 'Original second'),
            ('replacement', observation.replacement, 'Replacement second')]:
        if (run.instruction != instruction or not run.exact_view or run.finish is not View.FINISHED
                or run.disposition is not Disposition.ACCEPTED):
            raise AssertionError('Retained workflow mismatch: ' + name)

def observe(root: Path, node: Path, digest: str) -> Observation | Failure:
    if not re.fullmatch('[0-9a-f]{64}', digest) or not node.is_absolute():
        return Failure('Declare absolute executable and SHA256')
    if os.environ.get('FPIPE_IN_SABOTAGE') == '1':
        copied = os.environ.get('FPIPE_NODE_EXECUTABLE')
        if not copied or os.environ.get('FPIPE_NODE_SHA256') != digest or not Path(copied).is_absolute():
            return Failure('Copied runtime capability missing or mismatched')
        node = Path(copied)
    if SHARED['file_digest'](node) != digest:
        return Failure('Executable identity mismatch')
    try:
        inputs = json.loads(SHARED['regular_bytes'](BASE / 'workflow-pinning.inputs.json', 64 * 1024), object_pairs_hook=unique)
        with tempfile.TemporaryDirectory(prefix='workflow-pinning-proof-') as temporary:
            temporary = Path(temporary)
            stage, folder = temporary / 'inputs', temporary / 'data'
            failure = materialize(root, stage, inputs)
            if failure is not None:
                return failure
            (folder / 'workflows').mkdir(parents=True)
            for mode in ('original', 'replacement', 'recover'):
                if mode != 'recover':
                    prompt = 'Original' if mode == 'original' else 'Replacement'
                    definition = {'id': 'continuity', 'name': 'Continuity', 'description': 'Retained definition',
                        'version': '1.0.0' if mode == 'original' else '2.0.0',
                        'steps': [{'id': step, 'title': title, 'prompt': prompt + ' ' + suffix}
                            for step, title, suffix in [('one', 'First', 'first'), ('two', 'Second', 'second')]]}
                    (folder / 'workflows' / 'continuity.json').write_text(json.dumps(definition))
                with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                    completed = subprocess.run([str(node), str(BASE / 'workflow-pinning.mjs'), str(stage), str(folder), mode],
                        cwd=stage, env={}, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                        timeout=15, preexec_fn=SHARED['output_limit'])
                    stdout.seek(0); stderr.seek(0)
                    raw, errors = stdout.read(MAXIMUM_OUTPUT + 1), stderr.read(MAXIMUM_OUTPUT + 1)
                if completed.returncode != 0 or len(raw) > MAXIMUM_OUTPUT or len(errors) > MAXIMUM_OUTPUT:
                    return Failure('Worker process unavailable or exceeded bounds')
                if mode != 'recover':
                    prepared = json.loads(raw, object_pairs_hook=unique)
                    if prepared != {'kind': 'prepared', 'mode': mode, 'instruction': prompt + ' second'}:
                        return Failure('Worker preparation unavailable')
            if SHARED['file_digest'](node) != digest:
                return Failure('Executable changed during observation')
            return decode(raw)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        return Failure('Worker observation unavailable')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    observed = observe(args.root, args.node, args.sha256)
    if isinstance(observed, Failure):
        parser.exit(2, observed.detail + '\n')
    assert_observation(observed)
