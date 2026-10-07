"""Bounded diagnostics and terminal outcomes for the recovery harness."""
from enum import Enum, IntEnum
from pathlib import Path
from typing import assert_never

class CaseStatus(str, Enum):
    PENDING = 'pending'
    PASSED = 'passed'
    HARNESS_ERROR = 'harness_error'
    HARNESS_TIMEOUT = 'harness_timeout'
    RUNTIME_UNAVAILABLE = 'runtime_unavailable'
    RUNTIME_ERROR = 'runtime_error'
    TEST_FAILED = 'test_failed'

class ExitCode(IntEnum):
    PASSED = 0
    CHECK_FAILED = 1
    TIMED_OUT = 124
    UNAVAILABLE = 126

def case_exit(status: CaseStatus) -> ExitCode:
    match status:
        case CaseStatus.PASSED:
            return ExitCode.PASSED
        case CaseStatus.HARNESS_TIMEOUT:
            return ExitCode.TIMED_OUT
        case CaseStatus.TEST_FAILED:
            return ExitCode.CHECK_FAILED
        case CaseStatus.PENDING | CaseStatus.HARNESS_ERROR | CaseStatus.RUNTIME_UNAVAILABLE | CaseStatus.RUNTIME_ERROR:
            return ExitCode.UNAVAILABLE
    assert_never(status)

def terminal_exit(statuses: tuple[CaseStatus, ...]) -> ExitCode:
    if not statuses:
        return ExitCode.UNAVAILABLE
    outcomes = tuple(case_exit(status) for status in statuses)
    if ExitCode.TIMED_OUT in outcomes:
        return ExitCode.TIMED_OUT
    if ExitCode.UNAVAILABLE in outcomes:
        return ExitCode.UNAVAILABLE
    if ExitCode.CHECK_FAILED in outcomes:
        return ExitCode.CHECK_FAILED
    return ExitCode.PASSED

def diagnostic_tail(path: Path) -> tuple[str, ...]:
    try:
        with path.open('rb') as handle:
            size=handle.seek(0,2)
            handle.seek(max(0,size-8192))
            text=handle.read(8192).decode('utf8',errors='replace')
    except OSError:
        return ('phase log unavailable',)
    lines=text.splitlines()
    retained=lines[-12:]
    if size>8192 or len(lines)>12:
        retained.insert(0,'earlier phase output omitted')
    return tuple(line[:512] for line in retained) or ('no phase output',)
