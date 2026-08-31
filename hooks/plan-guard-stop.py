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

Every ALLOW now states which of the eleven conditions applied, with one
deliberate exception (below). A stop that is allowed prints
{"systemMessage": "<reason>"} and exits 0 without blocking. This does not
print to the terminal: it is carried on stdout of an exit-0, non-blocking
Stop hook, which the client parses out of stdout and attaches to the session
record as its own entry (verified against a real transcript; see the spec
this shipped against). That is the reader this exists for -- the conductor
loop and anyone auditing the record -- not a claim that a human sees it
rendered on screen.

The one path that stays silent: no .claude/active-plan marker at all. This
Stop hook has no matcher, so it runs on every stop in every session with the
harness installed, whether or not that session has ever touched a plan; that
is the single most frequent path by a wide margin, and it means "this guard
has nothing to do here", not "the guard checked and decided". Narrating it
would put a plan-guard message on essentially every Claude Code stop, most
of which have nothing to do with conducted plans, which is the "noise
nobody reads" failure this change exists to avoid, not the one it exists to
fix. Every other allow, including the routine one below, fires only once a
plan is actually being conducted.

The routine, high-frequency case -- a wake source armed, tasks still open,
everything fine -- is deliberately NOT suppressed, unlike the no-marker
case above. Reasoning: the incident this guard exists to prevent was a
guard that had silently stopped enforcing anything for four days, on an
active plan, and was indistinguishable from a guard correctly deciding
"armed, all fine" on every one of those days, because both produce silence.
Muting exactly that tick again would recreate the same blind spot one level
down: a broken guard and a healthy, ticking one would again look identical
for as long as the plan stays armed. This message is kept short and
constant in shape precisely so it can be skimmed or ignored by a human while
still working as a heartbeat: its absence during an active plan is the
signal that the guard has gone quiet, checkable from the session record
without needing anyone to have been watching in real time.

Otherwise returns {"decision": "block", "reason": ...} naming what to arm;
that path and its exact wording are unchanged.

Test rig: plan_guard_decision() takes its inputs explicitly and returns a
GuardResult(decision, message) where decision is 'block', 'allow' or
'silent'; tests feed it fixture directories and synthetic transcript lines.
"""
import json
import os
import re
import sys
import time
from collections import namedtuple

WAKE_MARKERS = (
    '"name":"ScheduleWakeup"', '"name": "ScheduleWakeup"',
    '"name":"Monitor"', '"name": "Monitor"',
    '"name":"Workflow"', '"name": "Workflow"',  # a launched workflow re-invokes on completion
    '"run_in_background":true', '"run_in_background": true',
    '"subagent_type"',  # a spawned agent re-invokes on completion
)
USER_TURN_MARKERS = ('"type":"user"', '"type": "user"')
STALE_CONDUCTOR_SECONDS = 6 * 3600
BLOCKED_MARKER = 'status: blocked-on-human'
# Round-1 review finding 4: matched case-insensitively (any heading level,
# 'conductor log' in any case) rather than one exact literal string. A plan
# spelling it '## Conductor Log' previously never split at all, so the WHOLE
# file read as the live region forever -- a historical block in what is
# genuinely the log then permanently disarms the guard, the exact defect
# this branch fixes, just reached through a spelling variant instead of a
# missing check.
LOG_HEADING_RE = re.compile(r'^#+\s*conductor log\b', re.IGNORECASE)

# plan_guard_decision()'s return value. decision is one of:
#   'block'  -- the stop is refused; message is the reason a human/conductor
#               must act on before ending the turn.
#   'allow'  -- the stop is permitted, and message names which of the ten
#               narrated conditions allowed it.
#   'silent' -- the stop is permitted with no output at all (message is
#               None). Reserved for the single no-marker path; see the
#               module docstring for why that one path stays quiet.
GuardResult = namedtuple('GuardResult', ['decision', 'message'])


def _block(reason):
    return GuardResult('block', reason)


def _allow(reason):
    return GuardResult('allow', reason)


def _silent():
    return GuardResult('silent', None)


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


def _text_before_log_heading(plan_text):
    """Everything before the conductor-log heading, matched case-insensitively
    against any heading level (## Conductor log, ### conductor LOG, ...) rather
    than one exact literal. Returns the whole text unchanged if no such heading
    is found -- an unheaded plan has no history region to exclude, so every line
    stays eligible for a live block, matching the guard's fail-loud default."""
    lines = plan_text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if LOG_HEADING_RE.match(line.strip()):
            return ''.join(lines[:i])
    return plan_text


def live_block_line(plan_text):
    """Return the LIVE blocked-on-human status line (stripped), or None.

    A conductor logs every block it hits, so a whole-file search for the
    marker disarms the guard permanently the first time one is written: the
    plan reads as blocked forever, on a question that was answered days ago.
    Observed 2026-08-30, where a resolved billing escalation from 2026-08-27
    had left the guard silently off with seven tasks still open.

    So a live status must be BOTH above the conductor log (which is history
    by definition) and at the start of its own line. Put the status line in
    the plan's frontmatter or just under its title; a status written below
    the log is treated as history and the guard keeps nagging, which is the
    right way for a guard to fail.
    """
    head = _text_before_log_heading(plan_text)
    for line in head.splitlines():
        stripped = line.strip()
        if stripped.startswith(BLOCKED_MARKER):
            return stripped
    return None


def blocked_on_human(plan_text):
    """True only for a LIVE block; see live_block_line() for the rule."""
    return live_block_line(plan_text) is not None


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
        return _allow(
            'Plan guard: allowed without a fresh check. stop_hook_active is '
            'set, meaning this hook already blocked this stop once this '
            'turn; blocking again would loop, so this retry is let through '
            'unconditionally.'
        )
    marker = os.path.join(cwd, '.claude', 'active-plan')
    if not os.path.isfile(marker):
        return _silent()  # no plan is being conducted here; see module docstring
    try:
        plan_path, conductor = read_marker(marker)
    except OSError:
        return _allow(
            'Plan guard: allowed. %s exists but could not be read (OSError); '
            'an unreadable marker cannot be evaluated, so nothing is '
            'enforced against it.' % marker
        )
    if not plan_path:
        return _allow(
            'Plan guard: allowed. %s exists but names no plan file (empty '
            'or malformed marker); there is nothing to check, so nothing '
            'is enforced.' % marker
        )
    if not os.path.isabs(plan_path):
        plan_path = os.path.join(cwd, plan_path)
    if not os.path.isfile(plan_path):
        return _block('active-plan points at %s, which does not exist. Fix the '
                'pointer or remove .claude/active-plan.' % plan_path)

    armed = wake_armed_since_last_user_turn(transcript_lines)

    # Conductor scoping: enforce only against the conducting session.
    if conductor and session_id:
        if conductor != session_id:
            if not conductor_is_stale(conductor, transcripts_dir):
                return _allow(
                    'Plan guard: allowed. Session %s is a bystander on '
                    'plan %s; session %s holds the live conductor claim.'
                    % (session_id, plan_path, conductor)
                )
            if armed:
                claim(marker, plan_path, session_id)  # re-claim a dead conductor's plan
                return _allow(
                    'Plan guard: allowed. Conductor %s on plan %s has been '
                    'silent past the %d-hour staleness window; session %s '
                    'has re-claimed conduction with a wake source armed.'
                    % (conductor, plan_path, STALE_CONDUCTOR_SECONDS // 3600,
                       session_id)
                )
            # stale conductor and this session is not conducting either:
            # fall through to the plan checks so SOMEONE is told.
    elif session_id and armed:
        claim(marker, plan_path, session_id)  # first armed stop claims conduction
        return _allow(
            'Plan guard: allowed. Plan %s had no conductor claimed; '
            'session %s has claimed conduction with a wake source armed.'
            % (plan_path, session_id)
        )

    try:
        with open(plan_path) as f:
            plan = f.read()
    except OSError:
        return _allow(
            'Plan guard: allowed, and this is worth reading. %s exists but '
            'could not be read (OSError), a race between the existence '
            'check and the read. The guard is enforcing NOTHING on this '
            'plan while it cannot read it.' % plan_path
        )
    line = live_block_line(plan)
    if line is not None:
        return _allow(
            'Plan guard: allowed. %s carries a live blocked-on-human '
            'status (%s); the guard will not nag while a human question '
            'is open.' % (plan_path, line)
        )
    open_tasks = plan.count('- [ ]')
    if open_tasks == 0:
        return _allow(
            'Plan guard: allowed, and this is worth reading. %s counts 0 '
            "open ('- [ ] ') tasks. The guard is enforcing NOTHING on this "
            'plan right now: either it is genuinely finished (delete '
            ".claude/active-plan), or its tasks were never written as "
            "'- [ ] ' checklist lines -- which counts as zero too and "
            'disarms the guard exactly as silently.' % plan_path
        )
    if armed:
        return _allow(
            'Plan guard: allowed. %s has %d task(s) open and a wake '
            'source is armed; conduction continues.' % (plan_path, open_tasks)
        )
    return _block(
        'Plan %s has %d task(s) not done and no wake source was armed '
        'this turn. Before stopping: arm a wake source (a background '
        'watch such as `gh pr checks <n> --watch`, a Monitor, or '
        'ScheduleWakeup), or mark the plan `status: blocked-on-human: '
        '<the question>`, or tick the remaining tasks done.'
        % (plan_path, open_tasks)
    )


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
    result = plan_guard_decision(
        cwd,
        bool(payload.get('stop_hook_active')),
        tail_lines(transcript_path),
        session_id=session_id,
        transcripts_dir=os.path.dirname(transcript_path) if transcript_path else None,
    )
    if result.decision == 'block':
        print(json.dumps({'decision': 'block', 'reason': result.message}))
    elif result.decision == 'allow':
        print(json.dumps({'systemMessage': result.message}))
    sys.exit(0)


if __name__ == '__main__':
    main()
