#!/usr/bin/env python3
"""Run real daemon writer and reader processes with SIGKILL interruption and durable restart.

Strengthens F037/R28 invocation replay obligation using real makeCompleteStepTool,
real engine handlers, and actual subprocess interruption.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'experiments/answer-driven-execution/daemon-restart.fixture.ts'
CONFIG = ROOT / 'experiments/answer-driven-execution/daemon-restart.config.js'

FIRST_NOTES = 'First task substantive notes documenting the execution evidence in detail for step 1.'
SECOND_NOTES = 'Second task substantive notes documenting the execution evidence in detail for step 2.'

parser = argparse.ArgumentParser(description='Run daemon restart acceptance experiment')
parser.add_argument('--output-dir', required=True, help='Directory to store logs, barrier proof, observations, and result.json')
parser.add_argument('--case', choices=['duplicate', 'fresh'], help='Run only a specific case (duplicate or fresh)')
args = parser.parse_args()

def git(*cmd: str) -> str:
    return subprocess.check_output(['git', *cmd], cwd=ROOT).decode().strip()

# 1. Require clean source tree before running
dirty_status = git('status', '--porcelain', '--', 'src', 'workflows', 'package.json', 'package-lock.json')
if dirty_status:
    raise SystemExit(f"Refusing to run: core source/dependency tree is dirty:\n{dirty_status}")

# 2. Require output-dir to be fresh/empty
out_dir = Path(args.output_dir).resolve()
if out_dir.exists() and any(out_dir.iterdir()):
    raise SystemExit(f"Output directory {out_dir} exists and is not empty. Provide a fresh or empty directory.")
out_dir.mkdir(parents=True, exist_ok=True)

# 3. Capture exact commit, tree, lock, and file identities
head = git('rev-parse', 'HEAD')
src_tree = git('rev-parse', 'HEAD:src')
workflows_tree = git('rev-parse', 'HEAD:workflows')
package_lock = git('rev-parse', 'HEAD:package-lock.json')
fixture_sha256 = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
config_sha256 = hashlib.sha256(CONFIG.read_bytes()).hexdigest()
runner_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()

report = {
    'head': head,
    'srcTree': src_tree,
    'workflowsTree': workflows_tree,
    'packageLock': package_lock,
    'runnerSha256': runner_sha256,
    'fixtureSha256': fixture_sha256,
    'configSha256': config_sha256,
    'cases': [],
}

def save_report():
    (out_dir / 'result.json').write_text(json.dumps(report, indent=2) + '\n')

save_report()

def kill_process_group(proc):
    """Directly kill the process group owned by proc.

    Because all subprocesses are launched with start_new_session=True,
    the process group ID is proc.pid. Calling os.getpgid(proc.pid) can fail
    once the leader exits, leaving orphaned child processes alive.
    Targeting os.killpg(proc.pid, ...) kills the entire group directly.
    """
    if not proc or proc.pid is None:
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=5)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            pass

def check_replay_invariant_violation(obs):
    """Check explicit predicates demonstrating invocation replay defect.

    The replay invariant requires that redelivering step 1 completion must NOT:
    - trigger completion callback (onCompleteCalled must be False)
    - mark workflow complete (toolResult.isComplete must be False)
    - duplicate notes or consume step 2 (materializedNotes must equal [FIRST_NOTES])
    """
    if not obs or not isinstance(obs, dict):
        return False, []
    violations = []
    if obs.get('onCompleteCalled') is True:
        violations.append("completion callback was triggered on duplicate redelivery (onCompleteCalled == True)")
    if obs.get('toolResult', {}).get('isComplete') is True:
        violations.append("workflow reported complete on duplicate redelivery (toolResult.isComplete == True)")
    notes = obs.get('materializedNotes', [])
    if len(notes) > 1 or (len(notes) == 1 and notes[0] != FIRST_NOTES):
        violations.append(f"notes modified or duplicated: {notes}")
    return len(violations) > 0, violations

cases_to_run = [args.case] if args.case else ['fresh', 'duplicate']
overall_success = True

vitest_bin = str(ROOT / 'node_modules/.bin/vitest')
cmd_base = [vitest_bin, 'run', '--config', str(CONFIG), str(FIXTURE)]

for case in cases_to_run:
    print(f"\n=== Running case: {case} ===")
    case_record = {'case': case, 'phases': [], 'status': 'pending'}
    report['cases'].append(case_record)
    save_report()

    try:
        with tempfile.TemporaryDirectory(prefix=f'workrail-daemon-restart-{case}-') as temp_dir:
            root = Path(temp_dir)
            temp_home = root / 'home'
            temp_home.mkdir(parents=True, exist_ok=True)
            temp_data = root / 'data'
            temp_data.mkdir(parents=True, exist_ok=True)
            temp_workflows = root / 'workflows'
            temp_workflows.mkdir(parents=True, exist_ok=True)

            env = {key: os.environ[key] for key in ('PATH', 'TMPDIR', 'LANG', 'NODE_ENV') if key in os.environ}
            env.update({
                'HOME': str(temp_home),
                'WORKRAIL_DATA_DIR': str(temp_data),
                'WORKFLOW_STORAGE_PATH': str(temp_workflows),
                'WORKRAIL_ENABLE_SESSION_TOOLS': 'false',
                'WORKRAIL_ENABLE_V2_TOOLS': 'true',
                'WORKRAIL_RESTART_ROOT': str(root),
                'WORKRAIL_RESTART_CASE': case,
            })

            # --- Phase 1: Writer ---
            print(f"[{case}] Launching writer process...")
            writer_env = dict(env)
            writer_env['WORKRAIL_RESTART_PHASE'] = 'write'
            writer_log_path = out_dir / f'{case}_writer.log'
            barrier_path = root / 'barrier.json'

            writer_proc = None
            writer_interrupted = False
            barrier_data = None
            writer_error = None

            try:
                with open(writer_log_path, 'w') as writer_log:
                    writer_proc = subprocess.Popen(
                        cmd_base,
                        cwd=ROOT,
                        env=writer_env,
                        stdout=writer_log,
                        stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
            except Exception as e:
                writer_error = f"Writer process launch failed: {e}"
                case_record['phases'].append({
                    'phase': 'write',
                    'barrierConfirmed': False,
                    'error': writer_error,
                })
                case_record['status'] = 'harness_error'
                case_record['success'] = False
                save_report()
                overall_success = False
                continue

            try:
                # Monotonic deadline max 60s
                deadline = time.monotonic() + 60.0
                while time.monotonic() < deadline:
                    if barrier_path.exists():
                        try:
                            content = barrier_path.read_text(encoding='utf8')
                            data = json.loads(content)
                            if data.get('ready') is True:
                                barrier_data = data
                                break
                        except (json.JSONDecodeError, OSError):
                            pass
                    if writer_proc.poll() is not None:
                        writer_error = f"Writer process exited prematurely with code {writer_proc.poll()} before writing acknowledged barrier"
                        break
                    time.sleep(0.1)

                if not barrier_data:
                    if not writer_error:
                        writer_error = "Writer did not reach acknowledged barrier within 60s timeout"
                    case_record['phases'].append({
                        'phase': 'write',
                        'barrierConfirmed': False,
                        'error': writer_error,
                    })
                    case_record['status'] = 'harness_error'
                    case_record['success'] = False
                    save_report()
                    overall_success = False
                    continue

                print(f"[{case}] Acknowledged barrier reached. Terminating writer process group with SIGKILL...")
                try:
                    os.killpg(writer_proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

                try:
                    writer_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(writer_proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    writer_proc.wait(timeout=5)

                if writer_proc.returncode == -signal.SIGKILL:
                    writer_interrupted = True
                    print(f"[{case}] Writer child successfully terminated with SIGKILL (returncode == -SIGKILL).")
                else:
                    writer_interrupted = False
                    writer_error = f"Writer returncode was {writer_proc.returncode}, expected -SIGKILL (-{int(signal.SIGKILL)})"
                    print(f"[{case}] Warning: {writer_error}")

            finally:
                kill_process_group(writer_proc)

            if not writer_interrupted:
                case_record['phases'].append({
                    'phase': 'write',
                    'barrierConfirmed': barrier_data is not None,
                    'killedWithSigkill': False,
                    'error': writer_error,
                })
                case_record['status'] = 'harness_error'
                case_record['success'] = False
                save_report()
                overall_success = False
                continue

            # Copy barrier proof out before temp dir cleanup
            if barrier_path.exists():
                shutil.copyfile(barrier_path, out_dir / f'{case}_barrier.json')

            case_record['phases'].append({
                'phase': 'write',
                'barrierConfirmed': True,
                'killedWithSigkill': True,
                'workrailSessionId': barrier_data.get('workrailSessionId'),
                'daemonSessionId': barrier_data.get('daemonSessionId'),
                'successorPendingStepId': barrier_data.get('successorPendingStepId'),
            })
            save_report()

            # --- Phase 2: Reader ---
            print(f"[{case}] Launching fresh reader process (reconstructing strictly from durable sidecar)...")
            reader_env = dict(env)
            reader_env['WORKRAIL_RESTART_PHASE'] = 'read'
            reader_log_path = out_dir / f'{case}_reader.log'
            obs_path = root / 'reader-observation.json'

            reader_code = None
            reader_proc = None
            reader_launch_error = None

            try:
                with open(reader_log_path, 'w') as reader_log:
                    reader_proc = subprocess.Popen(
                        cmd_base,
                        cwd=ROOT,
                        env=reader_env,
                        stdout=reader_log,
                        stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
                    try:
                        reader_code = reader_proc.wait(timeout=60)
                    except subprocess.TimeoutExpired:
                        print(f"[{case}] Reader timed out!")
                        reader_code = 124
            except Exception as e:
                reader_launch_error = f"Reader process launch failed: {e}"

            # Preserve observations before cleanup
            obs_data = None
            if obs_path.exists():
                try:
                    obs_content = obs_path.read_text(encoding='utf8')
                    obs_data = json.loads(obs_content)
                    (out_dir / f'{case}_observation.json').write_text(obs_content)
                except Exception as e:
                    print(f"[{case}] Warning: failed to preserve observation: {e}")

            # Clean up reader process group
            kill_process_group(reader_proc)

            if reader_launch_error is not None:
                case_record['phases'].append({
                    'phase': 'read',
                    'error': reader_launch_error,
                })
                case_record['status'] = 'harness_error'
                case_record['success'] = False
                save_report()
                overall_success = False
                continue

            print(f"[{case}] Reader finished with exit code {reader_code}.")
            case_record['phases'].append({
                'phase': 'read',
                'exitCode': reader_code,
                'observationCaptured': obs_data is not None,
            })

            # Evaluate status based on explicit observation predicates and exit code
            if case == 'fresh':
                if reader_code == 0:
                    # Reject zero exit lacking expected observations
                    if (obs_data is not None and
                            obs_data.get('caseType') == 'fresh' and
                            obs_data.get('onCompleteCalled') is True and
                            obs_data.get('toolResult', {}).get('isComplete') is True and
                            obs_data.get('materializedNotes') == [FIRST_NOTES, SECOND_NOTES]):
                        case_record['status'] = 'passed'
                        case_record['success'] = True
                    else:
                        case_record['status'] = 'harness_error'
                        case_record['error'] = 'Zero exit lacking expected observations for fresh case'
                        case_record['success'] = False
                        overall_success = False
                elif reader_code == 124:
                    case_record['status'] = 'timeout'
                    case_record['success'] = False
                    overall_success = False
                else:
                    case_record['status'] = 'test_failed' if obs_data is not None else 'harness_error'
                    case_record['error'] = f"Fresh reader exited with code {reader_code}"
                    if obs_data is not None:
                        case_record['observation'] = obs_data
                    case_record['success'] = False
                    overall_success = False

            elif case == 'duplicate':
                if reader_code == 0:
                    # Reject zero exit lacking expected observations
                    if (obs_data is not None and
                            obs_data.get('caseType') == 'duplicate' and
                            obs_data.get('onCompleteCalled') is False and
                            obs_data.get('toolResult', {}).get('isComplete') is False and
                            obs_data.get('materializedNotes') == [FIRST_NOTES]):
                        case_record['status'] = 'passed'
                        case_record['success'] = True
                    else:
                        case_record['status'] = 'harness_error'
                        case_record['error'] = 'Zero exit lacking expected observations for duplicate case'
                        case_record['success'] = False
                        overall_success = False
                elif reader_code == 124:
                    case_record['status'] = 'timeout'
                    case_record['success'] = False
                    overall_success = False
                else:
                    # Distinguish replay invariant violation based on explicit observation predicates
                    is_violation, violations = check_replay_invariant_violation(obs_data)
                    if is_violation:
                        case_record['status'] = 'invariant_failed'
                        case_record['violationDetails'] = violations
                        case_record['observation'] = obs_data
                    else:
                        case_record['status'] = 'harness_error' if obs_data is None else 'test_failed'
                        case_record['error'] = f"Duplicate reader exited with code {reader_code} but observation did not demonstrate replay invariant violation"
                        if obs_data is not None:
                            case_record['observation'] = obs_data
                    case_record['success'] = False
                    overall_success = False

            save_report()

    except Exception as e:
        print(f"[{case}] Harness error during case execution: {e}")
        case_record['status'] = 'harness_error'
        case_record['error'] = str(e)
        case_record['success'] = False
        save_report()
        overall_success = False
        continue

print("\n=== Final Report ===")
print(json.dumps(report, indent=2))

if not overall_success:
    sys.exit(1)
else:
    sys.exit(0)
