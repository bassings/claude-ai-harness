#!/usr/bin/env python3
"""Stop hook: block ending a turn while a conducted plan has in-flight work
and no wake source was armed this turn.

Active only when <cwd>/.claude/active-plan exists (written by /conduct-plan),
so ordinary conversations are never blocked. Allows the stop when:
  - stop_hook_active is set (never double-block; the escape hatch),
  - the plan file is missing, fully done, or marked blocked-on-human,
  - the transcript tail shows a wake source armed since the last user turn
    (ScheduleWakeup, Monitor, or a background task/agent).
Otherwise returns {"decision": "block"} naming what to arm.

Test rig: plan_guard_decision() is pure; tests feed it fixtures.
"""
import json
import os
import sys

WAKE_MARKERS = (
    '"name":"ScheduleWakeup"', '"name": "ScheduleWakeup"',
    '"name":"Monitor"', '"name": "Monitor"',
    '"name":"Workflow"', '"name": "Workflow"',  # a launched workflow re-invokes on completion
    '"run_in_background":true', '"run_in_background": true',
    '"subagent_type"',  # a spawned agent re-invokes on completion
)
USER_TURN_MARKERS = ('"type":"user"', '"type": "user"')


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


def plan_guard_decision(cwd, stop_hook_active, transcript_lines):
    if stop_hook_active:
        return None
    marker = os.path.join(cwd, '.claude', 'active-plan')
    if not os.path.isfile(marker):
        return None
    try:
        with open(marker) as f:
            plan_path = f.read().strip()
    except OSError:
        return None
    if not os.path.isabs(plan_path):
        plan_path = os.path.join(cwd, plan_path)
    if not os.path.isfile(plan_path):
        return ('active-plan points at %s, which does not exist. Fix the '
                'pointer or remove .claude/active-plan.' % plan_path)
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
    if wake_armed_since_last_user_turn(transcript_lines):
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
    reason = plan_guard_decision(
        cwd,
        bool(payload.get('stop_hook_active')),
        tail_lines(payload.get('transcript_path', '')),
    )
    if reason:
        print(json.dumps({'decision': 'block', 'reason': reason}))
    sys.exit(0)


if __name__ == '__main__':
    main()
