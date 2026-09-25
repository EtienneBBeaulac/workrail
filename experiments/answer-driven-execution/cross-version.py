#!/usr/bin/env python3
"""Run a real source writer and reader in isolated trees, without user data."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import tempfile
import argparse
import sys

if sys.version_info < (3, 12):
    raise SystemExit("Use Python 3.12 or newer for safe archive extraction")

ROOT = Path(__file__).resolve().parents[2]
BASELINE = '396cdfa4e665afa993b50fcf0ec59ca53a2167db'
parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', required=True)
parser.add_argument('--direction', choices=['upgrade', 'rollback'], default='upgrade')
parser.add_argument('--require-blocked-state', action='store_true', help='Unmet acceptance: rehydration exposes the saved blocker')
args = parser.parse_args()
out = Path(args.output_dir).resolve()
if out.exists() and (not out.is_dir() or any(out.iterdir())):
    raise SystemExit(f'Output path must be a new or empty directory: {out}')
out.mkdir(parents=True, exist_ok=True)

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode().strip()

head = git('rev-parse', 'HEAD')
if git('status', '--porcelain', '--', 'src', 'workflows', 'package.json', 'package-lock.json'):
    raise SystemExit('Commit engine/workflow/dependency edits first: this probe tests clean source archives')
lock = git('rev-parse', 'HEAD:package-lock.json')
if lock != git('rev-parse', BASELINE + ':package-lock.json'):
    raise SystemExit('Dependency lock changed: prepare revision-specific dependencies before running')
fixture = ROOT / 'experiments/answer-driven-execution/cross-version.fixture.ts'
writerRevision = BASELINE if args.direction == 'upgrade' else head
readerRevision = head if args.direction == 'upgrade' else BASELINE
report = {'writer': writerRevision, 'reader': readerRevision, 'checkoutHead': head, 'direction': args.direction, 'readerUsesWorkingTree': False,
          'requireBlockedState': args.require_blocked_state, 'lockBlob': lock, 'fixtureSha256': hashlib.sha256(fixture.read_bytes()).hexdigest(),
          'runnerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'configSha256': hashlib.sha256((fixture.parent / 'cross-version.config.js').read_bytes()).hexdigest(), 'phases': []}
with tempfile.TemporaryDirectory(prefix='workrail-cross-version-') as temp:
    root = Path(temp)
    for phase, revision in [('write', writerRevision), ('read', readerRevision)]:
        tree = root / (phase + '-source')
        tree.mkdir()
        archive = root / (phase + '.tar')
        subprocess.run(['git', 'archive', '--format=tar', '-o', str(archive), revision], cwd=ROOT, check=True)
        with tarfile.open(archive) as source:
            source.extractall(tree, filter='data')
        (tree / 'node_modules').symlink_to((ROOT / 'node_modules').resolve(), target_is_directory=True)
        target = tree / fixture.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(fixture, target)
        config = tree / 'experiments/answer-driven-execution/cross-version.config.js'
        shutil.copyfile(ROOT / config.relative_to(tree), config)
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG') if key in os.environ}
        env.update({'WORKRAIL_COMPAT_ROOT': str(root / 'fixture-state'), 'WORKRAIL_COMPAT_PHASE': phase, 'WORKRAIL_COMPAT_REQUIRE_BLOCKED': '1' if args.require_blocked_state else '0', 'WORKRAIL_DATA_DIR': str(root / 'fixture-state' / 'state')})
        command = [str(tree / 'node_modules/.bin/vitest'), 'run', '--config', str(config), './' + str(target.relative_to(tree))]
        with (out / (phase + '.log')).open('w') as log:
            process = subprocess.Popen(command, cwd=tree, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = process.wait(timeout=120)
            except subprocess.TimeoutExpired:
                code = 124
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
        report['phases'].append({'phase': phase, 'exitCode': code})
        (out / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        if code:
            raise SystemExit(code)
print(json.dumps(report, indent=2))
