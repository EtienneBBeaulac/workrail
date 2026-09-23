#!/usr/bin/env python3
"""Run real host recovery writer and reader processes with SIGKILL interruption and durable restart.

Exercises host process recovery acceptance for:
- harness_control: Subprocess lifecycle, atomic barrier, SIGKILL interruption, and fresh reader rehydration.
- DI2: Delivery durable, no captured response; atomic redelivery (D1 -> D2), capture refusal of abandoned D1
       (invalid_delivery), fresh capture/prepare/dispatch on D2, and second-step advancement to completion.
- di2_runner: Public-runner-only recovery for durable delivery without captured response;
              fresh reader calls scheduler.recover(pointer) and recovered.runner.runTurn twice
              with queued fresh first and second responses, no diagnostic pre-recovery,
              advances with exact two distinct receipts, parsed notes, and modelCallCount 2.
- DI5: Engine commits, before caller receives result; fault seam after_engine_commit barrier blocks for
       SIGKILL, fresh reader recovers original accepted receipt and exact first payload, byte-identical
       journal across repeated recovery, no inference before successor delivery, exact two distinct notes.
- DI9: Stop commits before recovered dispatch; scheduler recovery returns stopped with exact reason/detail,
       inspector reads stopped state, zero inference/dispatch, no recovered execution.
- di9_unstopped: Valid unstopped prepared invocation control; replays prepared response once on restart,
                 verifies recovered PreparedAnswer against barrier original reply/invocation/response IDs
                 (DI4 original payload/opportunity mapping), completes successor with exact receipts and
                 single reader inference call.
- di4_runner: Public-runner-only recovery for prepared-before-dispatch interruption; fresh reader calls
              scheduler.recover(pointer) and recovered.runner.runTurn without diagnostic recovery,
              dispatches retained original without model call, completes successor with single reader
              inference call, exact distinct receipts, and verified retained payloads.
- di5_runner: Public-runner-only recovery for after-engine-commit interruption; fresh reader calls
              scheduler.recover(pointer) and recovered.runner.runTurn without diagnostic recovery,
              delivers fresh successor without repeating first model inference, exact final two notes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'experiments/answer-driven-execution/host-recovery.fixture.ts'
CONFIG = ROOT / 'experiments/answer-driven-execution/host-recovery.config.js'
CANDIDATE_MODULE = ROOT / 'src/answer-v1/host.ts'

FIRST_NOTES = 'First step substantive observation notes.'
SECOND_NOTES = 'Second step substantive observation notes.'

parser = argparse.ArgumentParser(description='Run host recovery acceptance experiment')
parser.add_argument('--output-dir', required=True, help='Directory to store logs, barrier proof, observations, and result.json')
parser.add_argument('--case', choices=['harness_control', 'di2', 'di2_runner', 'di5', 'di5_runner', 'di9', 'di9_unstopped', 'di4_runner'], action='append', help='Run selected cases; repeat to include positive controls')
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
    """Directly kill only the owned process group started by proc."""
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

def is_in_process_group(pid: int, pgid: int) -> bool:
    if type(pid) is not int or pid <= 0:
        return False
    if pid == pgid:
        return True
    try:
        return os.getpgid(pid) == pgid
    except (ProcessLookupError, OSError):
        return False

def validate_pointer_file(pointer_path: Path) -> tuple[bool, str]:
    if not pointer_path.exists():
        return False, f"Pointer file missing at {pointer_path}"
    try:
        data = json.loads(pointer_path.read_text(encoding='utf8'))
    except Exception as e:
        return False, f"Failed to parse pointer JSON: {e}"
    if not isinstance(data, dict):
        return False, 'Pointer must be an object'
    allowed_keys = {'formatVersion', 'executionId', 'recoveryLocator'}
    keys = set(data.keys())
    if keys != allowed_keys:
        return False, f"Pointer keys mismatch; expected {allowed_keys}, got {keys}"
    if type(data.get('formatVersion')) is not int or data.get('formatVersion') != 1:
        return False, f"Pointer formatVersion must be 1, got {data.get('formatVersion')}"
    if not isinstance(data.get('executionId'), str) or not data.get('executionId'):
        return False, "Pointer executionId must be a non-empty string"
    if not isinstance(data.get('recoveryLocator'), str) or not data.get('recoveryLocator'):
        return False, "Pointer recoveryLocator must be a non-empty string"
    for forbidden in ('owner', 'fence', 'epoch', 'lease'):
        if forbidden in data:
            return False, f"Forbidden key '{forbidden}' found in serialized pointer"
    return True, ""

cases_to_run = args.case or ['harness_control', 'di2', 'di2_runner', 'di5', 'di5_runner', 'di9', 'di9_unstopped', 'di4_runner']
overall_success = True

vitest_bin = str(ROOT / 'node_modules/.bin/vitest')
cmd_base = [vitest_bin, 'run', '--config', str(CONFIG), str(FIXTURE)]

for case in cases_to_run:
    run_nonce = secrets.token_hex(16)
    print(f"\n=== Running host recovery case: {case} (nonce: {run_nonce}) ===")
    case_record = {'case': case, 'runNonce': run_nonce, 'phases': [], 'status': 'pending'}
    report['cases'].append(case_record)
    save_report()

    try:
        with tempfile.TemporaryDirectory(prefix=f'workrail-host-recovery-{case}-') as temp_dir:
            root = Path(temp_dir)
            temp_data = root / 'data'
            temp_data.mkdir(parents=True, exist_ok=True)
            temp_workflows = root / 'workflows'
            temp_workflows.mkdir(parents=True, exist_ok=True)

            env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'NODE_ENV') if key in os.environ}
            env.update({
                'WORKRAIL_DATA_DIR': str(temp_data),
                'WORKFLOW_STORAGE_PATH': str(temp_workflows),
                'WORKRAIL_RESTART_ROOT': str(root),
                'WORKRAIL_RESTART_CASE': case,
                'WORKRAIL_RESTART_NONCE': run_nonce,
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
                # Monotonic deadline max 30s
                deadline = time.monotonic() + 30.0
                while time.monotonic() < deadline:
                    if barrier_path.exists():
                        try:
                            content = barrier_path.read_text(encoding='utf8')
                            data = json.loads(content)
                            if isinstance(data, dict) and data.get('ready') is True:
                                barrier_data = data
                                break
                        except (json.JSONDecodeError, OSError):
                            pass
                    if writer_proc.poll() is not None:
                        break
                    time.sleep(0.1)

                if not barrier_data:
                    writer_exit_code = writer_proc.poll()
                    writer_log_text = writer_log_path.read_text(encoding='utf8') if writer_log_path.exists() else ''
                    candidate_exists = CANDIDATE_MODULE.exists()

                    # Verify ENOENT independently on disk, never by string matching alone
                    if not candidate_exists and 'runtime_unavailable: src/answer-v1/host.ts' in writer_log_text:
                        print(f"[{case}] Verified runtime_unavailable: src/answer-v1/host.ts is absent (ENOENT verified independently).")
                        case_record['phases'].append({
                            'phase': 'write',
                            'barrierConfirmed': False,
                            'classification': 'runtime_unavailable',
                            'detail': 'Candidate factory src/answer-v1/host.ts is absent (ENOENT confirmed)',
                            'writerExitCode': writer_exit_code,
                            'sourceEnoentVerified': True,
                        })
                        case_record['status'] = 'runtime_unavailable'
                        case_record['writerExitCode'] = writer_exit_code
                        case_record['success'] = False
                        save_report()
                        overall_success = False
                        continue
                    elif 'runtime_error: src/answer-v1/host.ts' in writer_log_text:
                        print(f"[{case}] Observed runtime_error in src/answer-v1/host.ts.")
                        case_record['phases'].append({
                            'phase': 'write',
                            'barrierConfirmed': False,
                            'classification': 'runtime_error',
                            'detail': 'Candidate module threw runtime_error',
                            'writerExitCode': writer_exit_code,
                        })
                        case_record['status'] = 'runtime_error'
                        case_record['writerExitCode'] = writer_exit_code
                        case_record['success'] = False
                        save_report()
                        overall_success = False
                        continue
                    else:
                        writer_error = f"Writer exited prematurely with code {writer_exit_code} before acknowledged barrier"
                        case_record['phases'].append({
                            'phase': 'write',
                            'barrierConfirmed': False,
                            'error': writer_error,
                            'writerExitCode': writer_exit_code,
                        })
                        case_record['status'] = 'harness_error'
                        case_record['writerExitCode'] = writer_exit_code
                        case_record['success'] = False
                        save_report()
                        overall_success = False
                        continue

                # Strict barrier schema validation before kill
                writer_pid = barrier_data.get('writerPid')
                barrier_keys = {'ready', 'caseType', 'phase', 'runNonce', 'writerPid', 'recordedAt'} | {
                    'harness_control': set(), 'di2': {'d1'},
                    'di2_runner': {'d1'},
                    'di5': {'executionId'},
                    'di5_runner': {'executionId'},
                    'di9': {'executionId', 'stopReason', 'stopDetail'},
                    'di9_unstopped': {'executionId', 'originalReplyId', 'originalInvocationId', 'originalResponseId'},
                    'di4_runner': {'executionId', 'originalReplyId', 'originalInvocationId', 'originalResponseId'},
                }[case]
                barrier_valid = (
                    set(barrier_data) == barrier_keys and
                    barrier_data.get('ready') is True and
                    barrier_data.get('caseType') == case and
                    barrier_data.get('phase') == 'write' and
                    barrier_data.get('runNonce') == run_nonce and
                    is_in_process_group(writer_pid, writer_proc.pid) and
                    type(barrier_data.get('recordedAt')) is int and
                    'pointer' not in barrier_data  # Pointer not repeatedly copied in barrier
                )
                if not barrier_valid:
                    writer_error = f"Barrier validation failed: invalid schema or mismatched metadata: {barrier_data}"
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

                if case in ('di2', 'di2_runner', 'di5', 'di5_runner', 'di9', 'di9_unstopped', 'di4_runner'):
                    pointer_ok, pointer_err = validate_pointer_file(root / 'pointer.json')
                    if not pointer_ok:
                        writer_error = f"Serialized pointer validation failed: {pointer_err}"
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

                print(f"[{case}] Acknowledged barrier reached and schema verified. Terminating writer process group with SIGKILL...")
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
                    'writerExitCode': writer_proc.returncode if writer_proc else None,
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
                'killedWriterExitCode': writer_proc.returncode,
                'writerPid': writer_pid,
                'barrierPayload': barrier_data,
            })
            save_report()

            # --- Phase 2: Reader ---
            print(f"[{case}] Launching fresh reader process in isolated storage...")
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
                        reader_code = reader_proc.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        print(f"[{case}] Reader timed out!")
                        reader_code = 124
            except Exception as e:
                reader_launch_error = f"Reader process launch failed: {e}"
            finally:
                # Also clean up on interruption while waiting; never leave a reader orphaned.
                kill_process_group(reader_proc)

            # Preserve observations before temporary storage cleanup
            obs_data = None
            if obs_path.exists():
                try:
                    obs_content = obs_path.read_text(encoding='utf8')
                    obs_data = json.loads(obs_content)
                    (out_dir / f'{case}_observation.json').write_text(obs_content)
                except Exception as e:
                    print(f"[{case}] Warning: failed to preserve observation: {e}")

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

            # Reject nonzero reader exit code even if observation claims success
            if reader_code != 0:
                case_record['status'] = 'test_failed'
                case_record['error'] = f"Reader exited with non-zero code {reader_code}"
                case_record['success'] = False
                overall_success = False
                save_report()
                continue

            # Strict validation of observation schema and types
            if not isinstance(obs_data, dict):
                case_record['status'] = 'harness_error'
                case_record['error'] = "Reader observation must be a JSON object"
                case_record['success'] = False
                overall_success = False
                save_report()
                continue

            # Closed observation schemas reject booleans in numeric positions and extra fields.
            header_schema = {'caseType': str, 'phase': str, 'runNonce': str,
                             'readerPid': int, 'writerPid': int, 'success': bool}
            extra_schema = {
                'harness_control': {'storageBytesMatched': bool, 'barrierObserved': bool, 'storageIntact': bool},
                'di2': {'retainedReceiptCount': int, 'receipts': list, 'distinctReceipts': bool,
                        'abandonedD1Refused': bool, 'abandonedPreservedSnapshot': bool,
                        'finalExecution': str, 'finalTaskOutcome': str, 'materializedNotes': list},
                'di5': {'initialRecoveredReceiptCount': int, 'retainedReceiptCount': int,
                        'receipts': list, 'distinctReceipts': bool,
                        'repeatedRecoveryRetainedSameReceipt': bool,
                        'journalUnchangedAcrossRecovery': bool,
                        'modelCallCount': int, 'finalExecution': str,
                        'finalTaskOutcome': str, 'materializedNotes': list},
                'di5_runner': {'retainedReceiptCount': int, 'receipts': list, 'distinctReceipts': bool,
                               'modelCallCount': int, 'finalExecution': str, 'finalTaskOutcome': str,
                               'materializedNotes': list},
                'di9': {'stopped': bool, 'stopReason': str, 'stopDetail': str, 'modelCallCount': int,
                        'retainedAcceptedCount': int, 'executionState': str,
                        'journalUnchangedAcrossRecovery': bool, 'noRecoveredExecution': bool},
                'di9_unstopped': {'replayedOriginal': bool, 'retainedReceiptCount': int,
                        'receipts': list, 'distinctReceipts': bool, 'modelCallCount': int,
                        'materializedNotes': list, 'finalTaskOutcome': str},
                'di4_runner': {'retainedReceiptCount': int, 'receipts': list, 'distinctReceipts': bool,
                               'modelCallCount': int, 'finalExecution': str, 'finalTaskOutcome': str,
                               'materializedNotes': list},
                'di2_runner': {'retainedReceiptCount': int, 'receipts': list, 'distinctReceipts': bool,
                               'modelCallCount': int, 'finalExecution': str, 'finalTaskOutcome': str,
                               'materializedNotes': list},
            }[case]
            schema = {**header_schema, **extra_schema}
            schema_valid = set(obs_data) == set(schema) and all(type(obs_data[k]) is t for k, t in schema.items())
            if 'receipts' in obs_data:
                receipts = obs_data['receipts']
                schema_valid = schema_valid and isinstance(receipts, list) and len(receipts) == 2 and all(
                    isinstance(r, dict) and set(r) == {'id', 'disposition'} and
                    type(r['id']) is str and bool(r['id']) and r['disposition'] == 'accepted' for r in receipts)
                if schema_valid:
                    schema_valid = receipts[0]['id'] != receipts[1]['id']
            # Universal observation header validation
            reader_pid = obs_data.get('readerPid')
            base_obs_valid = (
                schema_valid and
                obs_data.get('caseType') == case and
                obs_data.get('phase') == 'read' and
                obs_data.get('runNonce') == run_nonce and
                type(reader_pid) is int and reader_pid > 0 and
                obs_data.get('writerPid') == writer_pid and
                reader_pid != writer_pid and  # Fresh reader process ID differs
                isinstance(obs_data.get('success'), bool) and
                obs_data.get('success') is True
            )

            if not base_obs_valid:
                case_record['status'] = 'harness_error'
                case_record['error'] = f"Reader observation metadata validation failed: {obs_data}"
                case_record['success'] = False
                overall_success = False
                save_report()
                continue

            # Evaluate status based on explicit observation predicates and schema
            if case == 'harness_control':
                if (obs_data.get('storageBytesMatched') is True and
                        obs_data.get('barrierObserved') is True and
                        obs_data.get('storageIntact') is True):
                    case_record['status'] = 'passed'
                    case_record['success'] = True
                else:
                    case_record['status'] = 'harness_error'
                    case_record['error'] = f"Harness control observation checks failed: {obs_data}"
                    case_record['success'] = False
                    overall_success = False

            elif case == 'di2':
                if (obs_data.get('retainedReceiptCount') == 2 and
                        isinstance(obs_data.get('distinctReceipts'), bool) and
                        obs_data.get('distinctReceipts') is True and
                        isinstance(obs_data.get('abandonedD1Refused'), bool) and
                        obs_data.get('abandonedD1Refused') is True and
                        isinstance(obs_data.get('abandonedPreservedSnapshot'), bool) and
                        obs_data.get('abandonedPreservedSnapshot') is True and
                        obs_data.get('finalExecution') == 'completed' and
                        obs_data.get('finalTaskOutcome') == 'unknown' and
                        obs_data.get('materializedNotes') == [FIRST_NOTES, SECOND_NOTES] and
                        isinstance(obs_data.get('receipts'), list) and
                        len(obs_data.get('receipts')) == 2 and
                        all(r.get('disposition') == 'accepted' and r.get('id') for r in obs_data.get('receipts'))):
                    case_record['status'] = 'passed'
                    case_record['success'] = True
                else:
                    case_record['status'] = 'test_failed'
                    case_record['error'] = f"DI2 observation failed invariant predicates: {obs_data}"
                    case_record['success'] = False
                    overall_success = False

            elif case == 'di5':
                if (obs_data.get('initialRecoveredReceiptCount') == 1 and
                        obs_data.get('retainedReceiptCount') == 2 and
                        isinstance(obs_data.get('distinctReceipts'), bool) and
                        obs_data.get('distinctReceipts') is True and
                        isinstance(obs_data.get('repeatedRecoveryRetainedSameReceipt'), bool) and
                        obs_data.get('repeatedRecoveryRetainedSameReceipt') is True and
                        isinstance(obs_data.get('journalUnchangedAcrossRecovery'), bool) and
                        obs_data.get('journalUnchangedAcrossRecovery') is True and
                        obs_data.get('modelCallCount') == 1 and
                        obs_data.get('finalExecution') == 'completed' and
                        obs_data.get('finalTaskOutcome') == 'unknown' and
                        obs_data.get('materializedNotes') == [FIRST_NOTES, SECOND_NOTES] and
                        isinstance(obs_data.get('receipts'), list) and
                        len(obs_data.get('receipts')) == 2 and
                        all(r.get('disposition') == 'accepted' and r.get('id') for r in obs_data.get('receipts'))):
                    case_record['status'] = 'passed'
                    case_record['success'] = True
                else:
                    case_record['status'] = 'test_failed'
                    case_record['error'] = f"DI5 observation failed invariant predicates: {obs_data}"
                    case_record['success'] = False
                    overall_success = False

            elif case == 'di9':
                if (isinstance(obs_data.get('stopped'), bool) and
                        obs_data.get('stopped') is True and
                        obs_data.get('stopReason') == 'cancelled' and
                        obs_data.get('stopDetail') == 'user abort requested' and
                        obs_data.get('executionState') == 'incomplete_cancelled' and
                        obs_data.get('retainedAcceptedCount') == 0 and
                        obs_data.get('modelCallCount') == 0 and
                        isinstance(obs_data.get('journalUnchangedAcrossRecovery'), bool) and
                        obs_data.get('journalUnchangedAcrossRecovery') is True and
                        isinstance(obs_data.get('noRecoveredExecution'), bool) and
                        obs_data.get('noRecoveredExecution') is True):
                    case_record['status'] = 'passed'
                    case_record['success'] = True
                else:
                    case_record['status'] = 'test_failed'
                    case_record['error'] = f"DI9 observation failed invariant predicates: {obs_data}"
                    case_record['success'] = False
                    overall_success = False

            elif case == 'di9_unstopped':
                if (isinstance(obs_data.get('replayedOriginal'), bool) and
                        obs_data.get('replayedOriginal') is True and
                        obs_data.get('retainedReceiptCount') == 2 and
                        isinstance(obs_data.get('distinctReceipts'), bool) and
                        obs_data.get('distinctReceipts') is True and
                        obs_data.get('modelCallCount') == 1 and
                        obs_data.get('materializedNotes') == [FIRST_NOTES, SECOND_NOTES] and
                        obs_data.get('finalTaskOutcome') == 'unknown' and
                        isinstance(obs_data.get('receipts'), list) and
                        len(obs_data.get('receipts')) == 2 and
                        all(r.get('disposition') == 'accepted' and r.get('id') for r in obs_data.get('receipts'))):
                    case_record['status'] = 'passed'
                    case_record['success'] = True
                else:
                    case_record['status'] = 'test_failed'
                    case_record['error'] = f"DI9 unstopped observation failed invariant predicates: {obs_data}"
                    case_record['success'] = False
                    overall_success = False

            elif case in ('di4_runner', 'di5_runner', 'di2_runner'):
                expected_model_calls = 2 if case == 'di2_runner' else 1
                if (obs_data.get('retainedReceiptCount') == 2 and
                        isinstance(obs_data.get('distinctReceipts'), bool) and
                        obs_data.get('distinctReceipts') is True and
                        obs_data.get('modelCallCount') == expected_model_calls and
                        obs_data.get('finalExecution') == 'completed' and
                        obs_data.get('finalTaskOutcome') == 'unknown' and
                        obs_data.get('materializedNotes') == [FIRST_NOTES, SECOND_NOTES] and
                        isinstance(obs_data.get('receipts'), list) and
                        len(obs_data.get('receipts')) == 2 and
                        all(r.get('disposition') == 'accepted' and r.get('id') for r in obs_data.get('receipts'))):
                    case_record['status'] = 'passed'
                    case_record['success'] = True
                else:
                    case_record['status'] = 'test_failed'
                    case_record['error'] = f"{case} observation failed invariant predicates: {obs_data}"
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
