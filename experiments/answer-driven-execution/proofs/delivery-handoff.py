"""Assert the real delivery command contract; injected execution has no remote effects."""
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

helpers = runpy.run_path(str(Path(__file__).with_name('metrics-outcome.py')))
Failure = helpers['Failure']
unique = helpers['unique']
file_digest = helpers['file_digest']
output_limit = helpers['output_limit']
MAXIMUM_OUTPUT = helpers['MAXIMUM_OUTPUT']

class Case(str, Enum):
    COMPLETE = 'complete'
    COMMIT_TYPE = 'commitType'
    COMMIT_SCOPE = 'commitScope'
    COMMIT_SUBJECT = 'commitSubject'
    PR_TITLE = 'prTitle'
    PR_BODY = 'prBody'
    FILES = 'filesChanged'

class Kind(str, Enum):
    OK = 'ok'
    ERR = 'err'

class Executable(str, Enum):
    GIT = 'git'
    GH = 'gh'
    GITLEAKS = 'gitleaks'

@dataclass(frozen=True)
class Command:
    file: Executable
    args: tuple[str, ...]
    cwd: str
    timeout: int

@dataclass(frozen=True)
class Row:
    case: Case
    refusal: Kind | None
    refusal_calls: tuple[Command, ...]
    kind: Kind
    value: str | None
    calls: tuple[Command, ...]
    body: str | None
    body_exists: bool

@dataclass(frozen=True)
class Observation:
    rows: tuple[Row, ...]

def commands(value):
    if not isinstance(value, list) or len(value) > 16:
        raise ValueError('Invalid command population')
    result = []
    for cmd in value:
        if (not isinstance(cmd, dict) or set(cmd) != {'file', 'args', 'cwd', 'timeout'}
                or not isinstance(cmd['args'], list) or len(cmd['args']) > 16
                or any(not isinstance(arg, str) or len(arg) > 1024 for arg in cmd['args'])
                or not isinstance(cmd['cwd'], str) or type(cmd['timeout']) is not int):
            raise ValueError('Invalid command observation')
        result.append(Command(Executable(cmd['file']), tuple(cmd['args']), cmd['cwd'], cmd['timeout']))
    return tuple(result)

def decode(raw: bytes) -> Observation | Failure:
    try:
        value = json.loads(raw, object_pairs_hook=unique)
        if (not isinstance(value, dict) or set(value) != {'version', 'rows'}
                or type(value['version']) is not int or value['version'] != 1
                or not isinstance(value['rows'], list) or len(value['rows']) != len(Case)):
            return Failure('Invalid observation population')
        rows = []
        for case, row in zip(Case, value['rows']):
            if (not isinstance(row, dict) or set(row) != {'case', 'refusal', 'refusalCalls', 'kind', 'value', 'calls', 'body', 'bodyExists'}
                    or row['case'] != case or type(row['bodyExists']) is not bool
                    or any(v is not None and not isinstance(v, str) for v in [row['value'], row['body']])):
                return Failure('Incomplete or malformed observation')
            rows.append(Row(case, None if row['refusal'] is None else Kind(row['refusal']),
                commands(row['refusalCalls']), Kind(row['kind']), row['value'], commands(row['calls']), row['body'], row['bodyExists']))
        return Observation(tuple(rows))
    except (ValueError, TypeError, UnicodeError, RecursionError):
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
        assert row.refusal is (None if row.case is Case.COMPLETE else Kind.ERR)
        assert not row.refusal_calls
        assert row.kind is Kind.OK and row.value == 'https://github.com/example/proof/pull/42'
        assert len(row.calls) == 5
        add, diff, scanner, commit, pr = row.calls
        assert add.file is Executable.GIT and add.args == ('add', 'src/first.ts', 'docs/path with spaces.md')
        assert diff.file is Executable.GIT and diff.args == ('diff', '--cached')
        assert scanner.file is Executable.GITLEAKS and scanner.args == ('detect', '--source', '.', '--staged', '--no-git')
        assert commit.file is Executable.GIT and commit.args == ('commit', '-m', 'feat(mcp): retain exact handoff\n\nCo-authored-by: WorkTrain <worktrain@noreply.local>')
        assert pr.file is Executable.GH and len(pr.args) == 6
        assert pr.args[:5] == ('pr', 'create', '--title', '[WT] retain exact handoff', '--body-file')
        assert Path(pr.args[5]).is_absolute()
        assert row.body == '## Summary\nLiteral `text`, $(example), and quotation "marks".\n\n--- | \U0001f916 **Automated by WorkTrain**'
        assert not row.body_exists
        assert all(cmd.cwd == '/proof-workspace' and cmd.timeout == 60000 for cmd in row.calls)

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
