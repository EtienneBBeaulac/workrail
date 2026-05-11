#!/usr/bin/env python3
"""
WorkTrain session analysis script.

Usage:
  python3 scripts/session-analysis.py                        # analyse all non-success sessions
  python3 scripts/session-analysis.py <sessionId-prefix>     # single session deep-dive
  python3 scripts/session-analysis.py --workflow wr.discovery  # filter by workflow
  python3 scripts/session-analysis.py --fleet               # fleet-level summary only

Reads from:
  ~/.workrail/events/daemon/*.jsonl  -- LLM turns, tool calls, step boundaries
  ~/.workrail/data/sessions/<sess>/  -- step names, session store events
  ~/.workrail/data/snapshots/        -- compiled workflow state (step IDs)
  ~/.workrail/data/execution-stats.jsonl  -- outcome index
"""

import json
import glob
import sys
import os
import datetime
from collections import defaultdict, Counter

HOME = os.path.expanduser('~')
DAEMON_EVENTS_DIR = f'{HOME}/.workrail/events/daemon'
SESSIONS_DIR = f'{HOME}/.workrail/data/sessions'
SNAPSHOTS_DIR = f'{HOME}/.workrail/data/snapshots'
EXEC_STATS = f'{HOME}/.workrail/data/execution-stats.jsonl'

# ── Helpers ──────────────────────────────────────────────────────────────────

def fmt_dur(ms):
    s = int(ms / 1000)
    m, s = divmod(s, 60)
    if m == 0: return f'{s}s'
    return f'{m}m {s:02d}s'

def fmt_ts(ms):
    return datetime.datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M')

def pct_bar(pct, width=20):
    filled = int(pct / 100 * width)
    return '█' * filled + '░' * (width - filled)

# ── Data loading ─────────────────────────────────────────────────────────────

def load_all_daemon_events():
    """Load all daemon events from all daily files, keyed by sessionId."""
    by_session = defaultdict(list)
    for f in sorted(glob.glob(f'{DAEMON_EVENTS_DIR}/*.jsonl')):
        with open(f, errors='replace') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                sid = e.get('sessionId') or e.get('workrailSessionId') or ''
                if sid:
                    by_session[sid].append(e)
    # Sort each session's events by timestamp
    for sid in by_session:
        by_session[sid].sort(key=lambda e: e.get('ts', 0))
    return by_session

def load_session_store(wrid):
    """Load WorkRail session store events and return (events, completed_steps, pending_step)."""
    sess_dir = f'{SESSIONS_DIR}/{wrid}'
    if not os.path.isdir(sess_dir):
        return [], [], None

    events = []
    for f in sorted(glob.glob(f'{sess_dir}/events/*.jsonl')):
        with open(f, errors='replace') as fh:
            for line in fh:
                try:
                    events.append(json.loads(line.strip()))
                except Exception:
                    pass

    # Read manifest to find snapshot refs
    try:
        manifest_events = []
        with open(f'{sess_dir}/manifest.jsonl', errors='replace') as f:
            for line in f:
                try:
                    manifest_events.append(json.loads(line.strip()))
                except Exception:
                    pass
        snap_pins = sorted(
            [(e.get('eventIndex', 0), e.get('snapshotRef'))
             for e in manifest_events if e.get('kind') == 'snapshot_pinned']
        )
    except Exception:
        return events, [], None

    if not snap_pins:
        return events, [], None

    # Read final snapshot
    final_ref = snap_pins[-1][1].replace('sha256:', 'sha256_') + '.json'
    try:
        with open(f'{SNAPSHOTS_DIR}/{final_ref}') as f:
            snap = json.load(f)
        engine = snap['enginePayload']['engineState']
        completed = engine.get('completed', {}).get('values', [])
        pending_step = engine.get('pending', {}).get('step', {}).get('stepId')
        return events, completed, pending_step
    except Exception:
        return events, [], None

def load_exec_stats():
    stats = []
    try:
        with open(EXEC_STATS) as f:
            for line in f:
                try:
                    stats.append(json.loads(line.strip()))
                except Exception:
                    pass
    except Exception:
        pass
    return stats

# ── Session analysis ─────────────────────────────────────────────────────────

def analyse_session(process_sid, daemon_evts, wrid=None):
    """
    Build a complete diagnostic record for one session.

    Returns a dict with:
      sid, wrid, workflow, outcome, detail, start_ts, end_ts, duration_ms,
      total_turns, total_in_tokens, total_out_tokens,
      step_timeline: [{step_id, start_ms, duration_ms, turns, in_tokens, out_tokens}],
      stuck_tool, stuck_args, pending_step, steps_completed, steps_remaining,
      failure_category
    """
    if not daemon_evts:
        return None

    run_start = daemon_evts[0]['ts']
    run_end = daemon_evts[-1]['ts']
    duration_ms = run_end - run_start

    # Basic session metadata
    started_evt = next((e for e in daemon_evts if e.get('kind') == 'session_started'), None)
    completed_evt = next((e for e in daemon_evts if e.get('kind') == 'session_completed'), None)
    aborted_evt = next((e for e in daemon_evts if e.get('kind') == 'session_aborted'), None)
    stuck_evt = next((e for e in daemon_evts if e.get('kind') == 'agent_stuck'), None)

    workflow = started_evt.get('workflowId', '?') if started_evt else '?'
    outcome = completed_evt.get('outcome', 'orphaned') if completed_evt else ('aborted' if aborted_evt else 'orphaned')
    detail = completed_evt.get('detail', '') if completed_evt else (aborted_evt.get('reason', '') if aborted_evt else '')

    # Resolve wrid
    if not wrid:
        for e in daemon_evts:
            wrid_candidate = e.get('workrailSessionId')
            if wrid_candidate:
                wrid = wrid_candidate
                break

    # LLM turns
    llm_turns = [(e['ts'], e.get('inputTokens', 0), e.get('outputTokens', 0))
                 for e in daemon_evts if e.get('kind') == 'llm_turn_completed']
    total_turns = len(llm_turns)
    total_in = sum(i for _, i, _ in llm_turns)
    total_out = sum(o for _, _, o in llm_turns)

    # Tool calls
    tool_calls = [(e['ts'], e.get('toolName', '?')) for e in daemon_evts if e.get('kind') == 'tool_call_started']

    # Step boundaries (daemon step_advanced events)
    step_boundaries = [run_start] + sorted(
        [e['ts'] for e in daemon_evts if e.get('kind') == 'step_advanced']
    ) + [run_end]

    # Load session store for step names
    store_events, completed_steps, pending_step = ([], [], None)
    if wrid:
        store_events, completed_steps, pending_step = load_session_store(wrid)

    # Top-level steps only (filter out sub-routine dot notation)
    top_steps = [s for s in completed_steps if '.' not in s]

    # Build step timeline -- guard against more completed steps than boundaries
    step_timeline = []
    for i, step_id in enumerate(top_steps):
        if i >= len(step_boundaries) - 1:
            break
        t_start = step_boundaries[i]
        t_end = step_boundaries[i + 1] if i + 1 < len(step_boundaries) else run_end
        dur = t_end - t_start
        turns = sum(1 for ts, _, _ in llm_turns if t_start <= ts < t_end)
        in_tok = sum(inp for ts, inp, _ in llm_turns if t_start <= ts < t_end)
        out_tok = sum(out for ts, _, out in llm_turns if t_start <= ts < t_end)
        step_timeline.append({
            'step_id': step_id,
            'start_ms': t_start - run_start,
            'duration_ms': dur,
            'turns': turns,
            'in_tokens': in_tok,
            'out_tokens': out_tok,
        })

    # Pending (timeout) step activity
    if top_steps and len(top_steps) < len(step_boundaries):
        last_boundary = step_boundaries[len(top_steps)]
    else:
        last_boundary = step_boundaries[-1] if step_boundaries else run_start
    pending_turns = sum(1 for ts, _, _ in llm_turns if ts >= last_boundary)
    pending_in = sum(inp for ts, inp, _ in llm_turns if ts >= last_boundary)
    pending_out = sum(out for ts, _, out in llm_turns if ts >= last_boundary)
    pending_dur = run_end - last_boundary

    # Failure category
    stuck_tool = stuck_evt.get('toolName') if stuck_evt else None
    stuck_args = stuck_evt.get('argsSummary', '')[:120] if stuck_evt else None
    stuck_reason = stuck_evt.get('reason') if stuck_evt else None

    if outcome == 'success':
        category = 'success'
    elif outcome in ('stuck', 'timeout') and 'repeated_tool_call' in detail:
        category = f'stuck/repeated_tool_call/{stuck_tool or "?"}'
    elif outcome == 'timeout' and 'wall_clock' in detail:
        category = 'timeout/wall_clock'
    elif outcome == 'timeout' and 'max_turns' in detail:
        category = 'timeout/max_turns'
    elif outcome == 'error' and any(p in detail.lower() for p in ['model identifier', 'invalid model', 'api key', 'authentication']):
        category = 'config/bad_model'
    elif outcome in ('aborted', 'error') and 'aborted' in detail:
        category = 'infra/aborted'
    elif outcome == 'orphaned':
        category = 'orphaned'
    else:
        category = f'other/{outcome}'

    # Workflow step count (from workflow JSON)
    wf_total_steps = _load_workflow_step_count(workflow)

    return {
        'sid': process_sid,
        'wrid': wrid,
        'workflow': workflow,
        'outcome': outcome,
        'detail': detail,
        'category': category,
        'start_ts': run_start,
        'end_ts': run_end,
        'duration_ms': duration_ms,
        'total_turns': total_turns,
        'total_in_tokens': total_in,
        'total_out_tokens': total_out,
        'step_timeline': step_timeline,
        'pending_step': pending_step or detail or '?',
        'pending_turns': pending_turns,
        'pending_in_tokens': pending_in,
        'pending_out_tokens': pending_out,
        'pending_duration_ms': pending_dur,
        'steps_completed': len(top_steps),
        'wf_total_steps': wf_total_steps,
        'steps_remaining': max(0, wf_total_steps - len(top_steps) - 1) if wf_total_steps else None,
        'stuck_tool': stuck_tool,
        'stuck_reason': stuck_reason,
        'stuck_args': stuck_args,
    }


_wf_step_cache = {}

def _load_workflow_step_count(workflow_id):
    if workflow_id in _wf_step_cache:
        return _wf_step_cache[workflow_id]
    wf_file = f'{HOME}/.workrail'  # not easily available; try repo
    for candidate in [
        f'workflows/{workflow_id}.json',
        f'workflows/{workflow_id.replace("wr.", "wr.")}.json',
    ]:
        try:
            with open(candidate) as f:
                wf = json.load(f)
            count = len(wf.get('steps', []))
            _wf_step_cache[workflow_id] = count
            return count
        except Exception:
            pass
    _wf_step_cache[workflow_id] = None
    return None

# ── Display ───────────────────────────────────────────────────────────────────

def print_session_deep_dive(s):
    """Print a detailed step-by-step breakdown for one session."""
    total_dur = s['duration_ms']

    print(f'\n{"="*80}')
    print(f'SESSION: {s["sid"][:20]}...')
    print(f'Workflow:  {s["workflow"]}')
    print(f'Started:   {fmt_ts(s["start_ts"])}')
    print(f'Duration:  {fmt_dur(total_dur)}')
    print(f'Outcome:   {s["outcome"].upper()}  →  {s["category"]}')
    if s['detail']:
        print(f'Detail:    {s["detail"][:100]}')
    print(f'LLM turns: {s["total_turns"]} total | {s["total_in_tokens"]:,} in + {s["total_out_tokens"]:,} out tokens')
    print(f'Steps:     {s["steps_completed"]} completed / {s["wf_total_steps"] or "?"} total')
    if s['stuck_tool']:
        print(f'Stuck on:  {s["stuck_tool"]}({s["stuck_args"]})')
    print()

    if not s['step_timeline']:
        print('  (no step timeline available -- session may have died before first step)')
        return

    # Column headers
    print(f'  {"Step":<44} {"Start":>7} {"Duration":>9} {"Turns":>6} {"In-tok":>9} {"Out-tok":>8} {"% time":>7}')
    print(f'  {"-"*44} {"-"*7} {"-"*9} {"-"*6} {"-"*9} {"-"*8} {"-"*7}')

    for step in s['step_timeline']:
        pct = step['duration_ms'] / total_dur * 100
        bar = pct_bar(pct, width=8)
        start_m = step['start_ms'] / 60000
        print(f'  ✓ {step["step_id"]:<43} {start_m:>6.1f}m {fmt_dur(step["duration_ms"]):>9} '
              f'{step["turns"]:>6} {step["in_tokens"]:>9,} {step["out_tokens"]:>8,} '
              f'{pct:>6.1f}%')

    # Pending/timeout step
    last_start = s['steps_completed'] * 0  # approximate
    for step in s['step_timeline']:
        last_start = step['start_ms'] + step['duration_ms']
    pend_pct = s['pending_duration_ms'] / total_dur * 100
    pend_start_m = last_start / 60000
    indicator = '→ TIMEOUT' if 'timeout' in s['category'] or 'wall_clock' in s['detail'] else \
                '→ STUCK' if 'stuck' in s['category'] else '→ ...'
    print(f'  {indicator} {s["pending_step"]:<40} {pend_start_m:>6.1f}m {fmt_dur(s["pending_duration_ms"]):>9} '
          f'{s["pending_turns"]:>6} {s["pending_in_tokens"]:>9,} {s["pending_out_tokens"]:>8,} '
          f'{pend_pct:>6.1f}%')

    # Per-step stats
    if s['step_timeline']:
        durations = [step['duration_ms'] for step in s['step_timeline']]
        turns_list = [step['turns'] for step in s['step_timeline']]
        slowest = max(s['step_timeline'], key=lambda x: x['duration_ms'])
        most_turns = max(s['step_timeline'], key=lambda x: x['turns'])
        print()
        print(f'  Stats: avg step {fmt_dur(int(sum(durations)/len(durations)))} | '
              f'slowest: {slowest["step_id"][:35]} ({fmt_dur(slowest["duration_ms"])}) | '
              f'most turns: {most_turns["step_id"][:35]} ({most_turns["turns"]})')

        if s['steps_remaining'] and len(durations) > 0:
            avg_step_ms = sum(durations) / len(durations)
            est_remaining = avg_step_ms * s['steps_remaining'] / 60000
            total_needed = total_dur / 60000 + est_remaining
            print(f'  Needed to complete: ~{total_needed:.0f}m total '
                  f'(+{est_remaining:.0f}m more for {s["steps_remaining"]} remaining steps)')


def print_fleet_summary(sessions):
    """Print a fleet-level summary across all sessions."""
    non_trivial = [s for s in sessions if s['total_turns'] >= 3]
    if not non_trivial:
        print('No sessions with 3+ LLM turns found.')
        return

    print(f'\n{"="*80}')
    print(f'FLEET SUMMARY  ({len(non_trivial)} sessions with 3+ turns)')
    print(f'{"="*80}')

    # Outcome breakdown
    categories = Counter(s['category'] for s in non_trivial)
    print(f'\nFailure categories:')
    for cat, count in categories.most_common():
        pct = count / len(non_trivial) * 100
        bar = pct_bar(pct, width=25)
        print(f'  {bar}  {pct:4.0f}%  {count:3}  {cat}')

    # Per-workflow breakdown
    wf_groups = defaultdict(list)
    for s in non_trivial:
        wf_groups[s['workflow']].append(s)

    print(f'\nPer-workflow breakdown:')
    for wf, wf_sessions in sorted(wf_groups.items(), key=lambda x: -len(x[1])):
        outcomes = Counter(s['category'] for s in wf_sessions)
        successes = sum(1 for s in wf_sessions if s['outcome'] == 'success')
        avg_dur = sum(s['duration_ms'] for s in wf_sessions) / len(wf_sessions)
        avg_turns = sum(s['total_turns'] for s in wf_sessions) / len(wf_sessions)
        print(f'\n  {wf}  ({len(wf_sessions)} sessions, {successes}/{len(wf_sessions)} success, avg {fmt_dur(int(avg_dur))}, avg {avg_turns:.0f} turns)')
        for cat, count in outcomes.most_common(5):
            print(f'    {count:3}  {cat}')

    # Step bottleneck analysis for timeout sessions
    timeout_sessions = [s for s in non_trivial if 'timeout' in s['category'] and s['step_timeline']]
    if timeout_sessions:
        print(f'\nStep bottleneck analysis ({len(timeout_sessions)} timeout sessions with step data):')

        # Which step do sessions time out on?
        pending_counter = Counter(s['pending_step'] for s in timeout_sessions if s['pending_step'])
        print(f'\n  Timed out on step:')
        for step, count in pending_counter.most_common(10):
            print(f'    {count:3}  {step}')

        # Per-step average duration across completed sessions
        step_durations = defaultdict(list)
        for s in timeout_sessions:
            for step in s['step_timeline']:
                step_durations[step['step_id']].append(step['duration_ms'])

        if step_durations:
            print(f'\n  Average step durations across timeout sessions:')
            print(f'  {"Step":<50} {"Count":>6} {"Avg dur":>9} {"Max dur":>9} {"Avg turns":>10}')
            print(f'  {"-"*50} {"-"*6} {"-"*9} {"-"*9} {"-"*10}')
            step_turns = defaultdict(list)
            for s in timeout_sessions:
                for step in s['step_timeline']:
                    step_turns[step['step_id']].append(step['turns'])

            for step_id in sorted(step_durations, key=lambda x: -sum(step_durations[x])/len(step_durations[x])):
                durs = step_durations[step_id]
                turns = step_turns.get(step_id, [])
                avg_d = sum(durs) / len(durs)
                max_d = max(durs)
                avg_t = sum(turns) / len(turns) if turns else 0
                print(f'  {step_id:<50} {len(durs):>6} {fmt_dur(int(avg_d)):>9} {fmt_dur(max_d):>9} {avg_t:>10.1f}')

    # Token burn analysis
    total_tokens = sum(s['total_in_tokens'] + s['total_out_tokens'] for s in non_trivial)
    timeout_tokens = sum(s['total_in_tokens'] + s['total_out_tokens'] for s in non_trivial if 'timeout' in s['category'])
    print(f'\nToken burn:')
    print(f'  Total across all sessions:   {total_tokens:>15,}')
    print(f'  Burned on timeout sessions:  {timeout_tokens:>15,}  ({timeout_tokens*100//max(total_tokens,1)}% waste)')
    avg_per_session = total_tokens // len(non_trivial) if non_trivial else 0
    print(f'  Avg per session:             {avg_per_session:>15,}')


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    fleet_only = '--fleet' in args
    workflow_filter = None
    session_filter = None

    skip_next = False
    for i, arg in enumerate(args):
        if skip_next:
            skip_next = False
            continue
        if arg == '--workflow' and i + 1 < len(args):
            workflow_filter = args[i + 1]
            skip_next = True
        elif arg not in ('--fleet', '--workflow') and not arg.startswith('--'):
            session_filter = arg

    print('Loading daemon events...', file=sys.stderr)
    by_session = load_all_daemon_events()
    print(f'  Found {len(by_session)} sessions in daemon logs', file=sys.stderr)

    print('Analysing sessions...', file=sys.stderr)
    sessions = []
    for sid, evts in by_session.items():
        s = analyse_session(sid, evts)
        if s:
            sessions.append(s)

    sessions.sort(key=lambda s: s['start_ts'], reverse=True)

    # Filter (apply before fleet summary)
    if workflow_filter:
        sessions = [s for s in sessions if workflow_filter in s['workflow']]
    if session_filter:
        sessions = [s for s in sessions if s['sid'].startswith(session_filter) or
                    (s['wrid'] and s['wrid'].startswith(session_filter))]

    if session_filter and sessions:
        # Deep dive into specific session(s)
        for s in sessions[:3]:
            print_session_deep_dive(s)
    else:
        # Fleet summary (default, or explicit --fleet)
        print_fleet_summary(sessions)
        if not fleet_only:
            # Also show the 5 most recent non-success sessions with turns
            non_success = [s for s in sessions if s['outcome'] != 'success' and s['total_turns'] >= 3]
            for s in non_success[:5]:
                print_session_deep_dive(s)


if __name__ == '__main__':
    main()
