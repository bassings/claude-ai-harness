#!/usr/bin/env python3
"""Stop hook: block ending a turn while a conducted plan has in-flight work
and no wake source was armed this turn.

Active only when <cwd>/.claude/active-plan exists (written by /conduct-plan),
so ordinary conversations are never blocked.

Conductor scoping: the hook learns who conducts from behaviour. The first
session that stops with a wake source armed over an unclaimed plan is stamped
into the marker file (`conductor: <session_id>`). From then on, only that
session is enforced; other sessions in the repo stop freely. A claim goes
stale when the conductor's transcript has been silent for six hours, at which
point the next armed session re-claims.

Allows the stop when:
  - stop_hook_active is set (never double-block; the escape hatch),
  - another session holds a live conductor claim (bystander),
  - the plan file is missing, fully done, or marked blocked-on-human,
  - the transcript tail shows a wake source armed since the last user turn
    (ScheduleWakeup, Monitor, Workflow launch, or a background task/agent).
Otherwise returns {"decision": "block"} naming what to arm.

Test rig: plan_guard_decision() takes its inputs explicitly; tests feed it
fixture directories and synthetic transcript lines.
"""
import json
import os
import sys
import time

WAKE_MARKERS = (
    '"name":"ScheduleWakeup"', '"name": "ScheduleWakeup"',
    '"name":"Monitor"', '"name": "Monitor"',
    '"name":"Workflow"', '"name": "Workflow"',  # a launched workflow re-invokes on completion
    '"run_in_background":true', '"run_in_background": true',
    '"subagent_type"',  # a spawned agent re-invokes on completion
)
USER_TURN_MARKERS = ('"type":"user"', '"type": "user"')
STALE_CONDUCTOR_SECONDS = 6 * 3600


def tail_lines(path, n=400):
    try:
        with open(path, 'rb') as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 512 * 1024))
            data = f.read().decode('utf-8', errors='replace')
        return data.splitlines()[-n:]
    except OSError:
        return []


def wake_armed_since_last_user_turn(lines):
    last_user = -1
    for i, line in enumerate(lines):
        # tool_result lines also carry type:user; only count ones with no tool markers
        if any(m in line for m in USER_TURN_MARKERS) and 'tool_result' not in line:
            last_user = i
    window = lines[last_user + 1:] if last_user >= 0 else lines
    return any(m in line for line in window for m in WAKE_MARKERS)


def read_marker(marker):
    """Return (plan_path, conductor_id) from the marker file."""
    plan_path, conductor = None, None
    with open(marker) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith('conductor:'):
                conductor = line.split(':', 1)[1].strip()
            elif plan_path is None:
                plan_path = line
    return plan_path, conductor


def conductor_is_stale(conductor_id, transcripts_dir):
    """A claim is stale when the conductor's transcript is silent for 6h.
    Unknown/missing transcript counts as stale, so a dead session cannot
    hold the claim forever."""
    if not transcripts_dir:
        return False
    path = os.path.join(transcripts_dir, conductor_id + '.jsonl')
    try:
        return (time.time() - os.stat(path).st_mtime) > STALE_CONDUCTOR_SECONDS
    except OSError:
        return True


def claim(marker, plan_path, session_id):
    try:
        with open(marker, 'w') as f:
            f.write(plan_path + '\n' + 'conductor: ' + session_id + '\n')
    except OSError:
        pass


def plan_guard_decision(cwd, stop_hook_active, transcript_lines,
                        session_id=None, transcripts_dir=None):
    if stop_hook_active:
        return None
    marker = os.path.join(cwd, '.claude', 'active-plan')
    if not os.path.isfile(marker):
        return None
    try:
        plan_path, conductor = read_marker(marker)
    except OSError:
        return None
    if not plan_path:
        return None
    if not os.path.isabs(plan_path):
        plan_path = os.path.join(cwd, plan_path)
    if not os.path.isfile(plan_path):
        return ('active-plan points at %s, which does not exist. Fix the '
                'pointer or remove .claude/active-plan.' % plan_path)

    armed = wake_armed_since_last_user_turn(transcript_lines)

    # Conductor scoping: enforce only against the conducting session.
    if conductor and session_id:
        if conductor != session_id:
            if not conductor_is_stale(conductor, transcripts_dir):
                return None  # bystander session; the conductor is enforced
            if armed:
                claim(marker, plan_path, session_id)  # re-claim a dead conductor's plan
                return None
            # stale conductor and this session is not conducting either:
            # fall through to the plan checks so SOMEONE is told.
    elif session_id and armed:
        claim(marker, plan_path, session_id)  # first armed stop claims conduction
        return None

    try:
        with open(plan_path) as f:
            plan = f.read()
    except OSError:
        return None
    if 'status: blocked-on-human' in plan:
        return None
    open_tasks = plan.count('- [ ]')
    if open_tasks == 0:
        return None
    if armed:
        return None
    return ('Plan %s has %d task(s) not done and no wake source was armed '
            'this turn. Before stopping: arm a wake source (a background '
            'watch such as `gh pr checks <n> --watch`, a Monitor, or '
            'ScheduleWakeup), or mark the plan `status: blocked-on-human: '
            '<the question>`, or tick the remaining tasks done.'
            % (plan_path, open_tasks))


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    cwd = payload.get('cwd') or os.getcwd()
    transcript_path = payload.get('transcript_path', '')
    session_id = payload.get('session_id')
    if not session_id and transcript_path.endswith('.jsonl'):
        session_id = os.path.basename(transcript_path)[:-6]
    reason = plan_guard_decision(
        cwd,
        bool(payload.get('stop_hook_active')),
        tail_lines(transcript_path),
        session_id=session_id,
        transcripts_dir=os.path.dirname(transcript_path) if transcript_path else None,
    )
    if reason:
        print(json.dumps({'decision': 'block', 'reason': reason}))
    sys.exit(0)


if __name__ == '__main__':
    main()
