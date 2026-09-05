#!/usr/bin/env python3
"""Tests for the plan-guard Stop hook.

Run: python3 ~/.claude/hooks/test_plan_guard_stop.py

The hook is a guard, so these tests exist to prove it can FAIL, not merely
that it can pass. Every "allows the stop" case is paired with the mutation
that should make it block, and every narrated allow is pinned to the exact,
discriminating content of ITS reason -- not a fragment shared with any other
reason -- so a test only proves the guard right if it would fail on a
message swapped in from a different branch.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'plan-guard-stop.py')
_spec = importlib.util.spec_from_file_location('plan_guard_stop', HOOK)
pg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pg)

SESSION = 'session-under-test'
NO_WAKE = ['{"type":"user"}', '{"type":"assistant","message":"done"}']
WAKE = ['{"type":"user"}', '{"type":"assistant"}', '{"name":"ScheduleWakeup"}']

PLAN_OPEN = """# A plan

## Tasks
- [x] T1: done — state: merged
- [ ] T2: not done — state: queued

## Conductor log

- **Tick 1**: armed and building.
"""


class PlanFixture:
    """A repo directory with .claude/active-plan pointing at a plan file."""

    def __init__(self, plan_text, conductor=SESSION, plan_rel='specs/plan.md'):
        self.dir = tempfile.mkdtemp()
        self.plan_rel = plan_rel
        os.makedirs(os.path.join(self.dir, '.claude'))
        os.makedirs(os.path.join(self.dir, os.path.dirname(plan_rel)), exist_ok=True)
        with open(os.path.join(self.dir, plan_rel), 'w') as f:
            f.write(plan_text)
        marker = plan_rel + '\n'
        if conductor:
            marker += 'conductor: ' + conductor + '\n'
        with open(os.path.join(self.dir, '.claude', 'active-plan'), 'w') as f:
            f.write(marker)

    def plan_abspath(self):
        return os.path.join(self.dir, self.plan_rel)

    def decide(self, transcript=NO_WAKE, session_id=SESSION, stop_hook_active=False):
        return pg.plan_guard_decision(self.dir, stop_hook_active, transcript,
                                      session_id=session_id, transcripts_dir=None)

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class TestPlanGuard(unittest.TestCase):

    def setUp(self):
        self.fixtures = []

    def tearDown(self):
        for f in self.fixtures:
            f.cleanup()

    def fixture(self, *a, **kw):
        f = PlanFixture(*a, **kw)
        self.fixtures.append(f)
        return f

    # --- the core contract -------------------------------------------------

    def test_blocks_when_tasks_open_and_nothing_armed(self):
        result = self.fixture(PLAN_OPEN).decide()
        self.assertEqual(result.decision, 'block')
        self.assertIn('1 task(s) not done', result.message)

    def test_tail_lines_reads_a_real_file_and_keeps_a_useful_window(self):
        """Round-five adversarial pass, sharpened.

        The reported finding was that narrowing `tail_lines(path, n=400)` to
        n=1 left the whole suite green. True, and the reason is worse than an
        unpinned constant: EVERY other test injects the transcript as a LIST
        via decide(), which passes it straight to plan_guard_decision. So
        tail_lines -- the function that actually reads the transcript file off
        disk and decides how much of it to look at -- was never called by any
        test at all. Narrowing it was invisible because nothing exercised it.

        This tests it directly. A list-injecting test cannot cover a
        file-reading function, and writing more of those would not have helped.
        """
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        path = os.path.join(d, 'transcript.jsonl')
        with open(path, 'w') as f:
            for i in range(1000):
                f.write('{"line":%d}\n' % i)

        got = pg.tail_lines(path)
        self.assertGreaterEqual(
            len(got), 100,
            'the default window must be wide enough to span a real turn; a narrow one '
            'silently reports "nothing armed" for a conductor that armed correctly',
        )
        self.assertIn('{"line":999}', got[-1], 'the window must be the TAIL, not the head')

        narrow = pg.tail_lines(path, n=5)
        self.assertEqual(len(narrow), 5, 'an explicit n must be honoured')
        self.assertIn('{"line":995}', narrow[0])

    def test_tail_lines_handles_a_missing_or_unreadable_file_without_raising(self):
        """A hook that raises on a missing transcript fails closed in the worst way:
        it would block every stop in every session, conducted or not."""
        got = pg.tail_lines(os.path.join(tempfile.mkdtemp(), 'does-not-exist.jsonl'))
        self.assertEqual(got, [], 'a missing transcript must read as no lines, not an exception')

    def test_allows_when_a_wake_source_was_armed(self):
        f = self.fixture(PLAN_OPEN)
        result = f.decide(transcript=WAKE)
        self.assertEqual(result.decision, 'allow')
        # Discriminating content: names the plan, the open-task count, and
        # the word "armed" -- distinct from every other allow reason, which
        # never combines an open-task count with "wake source is armed".
        self.assertIn(f.plan_abspath(), result.message)
        self.assertIn('1 task(s) open', result.message)
        self.assertIn('wake source is armed; conduction continues', result.message)

    def test_allows_when_every_task_is_ticked(self):
        f = self.fixture(PLAN_OPEN.replace('- [ ] T2', '- [x] T2'))
        result = f.decide()
        self.assertEqual(result.decision, 'allow')
        # AC-4: the zero-open-tasks path must be unmistakable that the
        # guard enforces nothing here, whatever the reason for the zero.
        self.assertIn('enforcing NOTHING', result.message)
        self.assertIn('counts 0', result.message)
        self.assertIn(f.plan_abspath(), result.message)

    def test_zero_open_tasks_message_also_names_the_prose_task_list_risk(self):
        """The second real incident: a plan whose tasks were prose, not a
        checklist, also counts as zero and must read the same way as a
        genuinely finished plan -- both are "the guard enforces nothing"."""
        f = self.fixture(PLAN_OPEN.replace('- [ ] T2', '- [x] T2'))
        result = f.decide()
        self.assertIn('never written as', result.message)
        self.assertIn("'- [ ]' checklist lines", result.message)

    def test_allows_when_no_marker_file(self):
        empty = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, empty, True)
        result = pg.plan_guard_decision(empty, False, NO_WAKE, session_id=SESSION)
        self.assertEqual(result.decision, 'silent')
        self.assertIsNone(result.message)

    def test_reports_a_pointer_at_a_missing_plan(self):
        f = self.fixture(PLAN_OPEN)
        os.remove(os.path.join(f.dir, f.plan_rel))
        result = f.decide()
        self.assertEqual(result.decision, 'block')
        self.assertIn('does not exist', result.message)

    def test_stop_hook_active_is_the_escape_hatch(self):
        f = self.fixture(PLAN_OPEN)
        result = f.decide(stop_hook_active=True)
        self.assertEqual(result.decision, 'allow')
        self.assertIn('stop_hook_active is set', result.message)
        self.assertIn('already blocked this stop once this turn', result.message)

    # --- marker itself is broken -------------------------------------------

    def test_unreadable_marker_allows_and_names_the_marker_path(self):
        f = self.fixture(PLAN_OPEN)
        marker = os.path.join(f.dir, '.claude', 'active-plan')
        os.chmod(marker, 0o000)
        try:
            if os.access(marker, os.R_OK):
                self.skipTest('running as a user that bypasses file permissions (e.g. root)')
            result = f.decide()
            self.assertEqual(result.decision, 'allow')
            self.assertIn(marker, result.message)
            self.assertIn('could not be read', result.message)
            self.assertIn('marker cannot be evaluated', result.message)
        finally:
            os.chmod(marker, 0o644)

    def test_empty_marker_allows_and_says_nothing_to_check(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        os.makedirs(os.path.join(d, '.claude'))
        marker = os.path.join(d, '.claude', 'active-plan')
        with open(marker, 'w') as f:
            f.write('\n')  # blank line only: no plan path parses out
        result = pg.plan_guard_decision(d, False, NO_WAKE, session_id=SESSION)
        self.assertEqual(result.decision, 'allow')
        self.assertIn(marker, result.message)
        self.assertIn('names no plan file', result.message)

    # --- blocked-on-human: live vs historical ------------------------------

    def test_a_live_blocked_on_human_status_allows_the_stop(self):
        live = PLAN_OPEN.replace('# A plan',
                                 '# A plan\n\nstatus: blocked-on-human: which control owns this?')
        f = self.fixture(live)
        result = f.decide()
        self.assertEqual(result.decision, 'allow', 'a live block is a legitimate reason to stop')
        # Discriminating content: quotes the actual recorded status line,
        # not just the word "blocked", so a swap with any other reason
        # (which never quotes the plan's own text back) would fail this.
        self.assertIn('status: blocked-on-human: which control owns this?', result.message)
        self.assertIn('will not nag while a human question is open', result.message)

    def test_frontmatter_blocked_on_human_allows_the_stop(self):
        fm = '---\nstatus: blocked-on-human: the budget is spent\n---\n\n' + PLAN_OPEN
        result = self.fixture(fm).decide()
        self.assertEqual(result.decision, 'allow')
        self.assertIn('status: blocked-on-human: the budget is spent', result.message)

    def test_an_oversized_live_block_status_is_truncated_in_the_message(self):
        """Round-2 review finding 3: a plan's status line is written by
        whatever agent is conducting it and can paste arbitrary text (a CI
        log, a PR body). Quoted back with no limit, it would be re-emitted
        on every stop for as long as the plan stays blocked, unboundedly
        bloating the session record. 200,000 characters here stands in for
        the pasted-CI-log shape; the message must stay bounded regardless."""
        huge_reason = 'x' * 200_000
        live = PLAN_OPEN.replace(
            '# A plan', '# A plan\n\nstatus: blocked-on-human: ' + huge_reason)
        f = self.fixture(live)
        result = f.decide()
        self.assertEqual(result.decision, 'allow')
        # The quoted status must be truncated to STATUS_QUOTE_LIMIT (200)
        # characters plus an ellipsis, not the full 200,000-character line.
        self.assertNotIn(huge_reason, result.message)
        self.assertIn(
            'status: blocked-on-human: ' + ('x' * (pg.STATUS_QUOTE_LIMIT - len('status: blocked-on-human: '))) + '...',
            result.message)
        self.assertLess(len(result.message), 1000,
                        'an oversized status line must not make it into an unbounded message')

    def test_truncate_for_quoting_leaves_a_short_line_untouched(self):
        """The mutation this pairs with: replacing the length check with an
        unconditional truncate (or an unconditional no-op) is caught by one
        of this test and test_an_oversized_live_block_status_is_truncated,
        never both -- proving the len(text) <= limit branch is load-bearing
        in both directions."""
        short = 'status: blocked-on-human: short question?'
        self.assertEqual(pg.truncate_for_quoting(short), short)

    def test_historical_block_in_the_conductor_log_does_NOT_disarm_the_guard(self):
        """The defect this test exists for.

        A conductor records past blocks in its log. Once any block was ever
        logged, a whole-file grep for the marker disarms the guard forever,
        silently, on a plan that is no longer blocked at all.
        """
        historical = PLAN_OPEN + (
            '\n- **Tick 9**: escalated.\n\n'
            '**status: blocked-on-human: GitHub Actions stopped starting jobs.**\n'
            '\nResolved 2026-08-28 by moving to self-hosted runners.\n'
        )
        result = self.fixture(historical).decide()
        self.assertEqual(
            result.decision, 'block',
            'a resolved block recorded in the log must not disarm the guard')
        self.assertIn('1 task(s) not done', result.message)

    def test_unbolded_historical_block_in_the_log_also_does_not_disarm(self):
        """Line-start alone is not the discriminator; region is."""
        historical = PLAN_OPEN + (
            '\n- **Tick 9**: escalated, since resolved.\n\n'
            'status: blocked-on-human: the payment failed\n'
        )
        result = self.fixture(historical).decide()
        self.assertEqual(result.decision, 'block',
                         'the conductor log is history, whatever its formatting')

    def test_a_differently_cased_conductor_log_heading_still_splits_the_history_region(self):
        """Round-1 review finding 4: LOG_HEADING used to be one exact-case
        literal ('## Conductor log'). A plan spelling it '## Conductor Log'
        (any other case) previously never matched at all, so the split never
        fired and the WHOLE file read as the live region -- a line-start
        status recorded after that heading (genuinely history) then
        disarmed the guard permanently, the same failure shape this branch
        exists to fix, reached through a spelling variant instead of a
        missing check.

        Deliberately an UNBOLDED, line-start marker (mirroring
        test_unbolded_historical_block_in_the_log_also_does_not_disarm just
        above): a bolded one would already fail the line-start half of
        live_block_line() regardless of region, which would not actually
        exercise the heading match this test targets.
        """
        plan = PLAN_OPEN.replace('## Conductor log', '## Conductor Log') + (
            '\n- **Tick 9**: escalated, since resolved.\n\n'
            'status: blocked-on-human: the payment failed\n'
        )
        result = self.fixture(plan).decide()
        self.assertEqual(
            result.decision, 'block',
            'a differently-cased conductor-log heading must still be recognised as the history boundary')
        self.assertIn('1 task(s) not done', result.message)

    def test_marker_mentioned_in_prose_above_the_log_does_NOT_disarm_the_guard(self):
        """Round-1 review finding 3: region alone is not the discriminator either;
        line-start matters too, and nothing previously exercised it.

        A plan can legitimately quote the policy instruction itself ("add
        `status: blocked-on-human: <reason>` under the title and stop")
        somewhere above the log, in a notes or policy section, without that
        being a live status line. Dropping the line-start half of
        live_block_line() while keeping the region split reads this prose
        mention as a real block and wrongly disarms the guard.
        """
        prose = PLAN_OPEN.replace(
            '# A plan',
            '# A plan\n\nPolicy: add `status: blocked-on-human: <reason>` under the title and stop.'
        )
        result = self.fixture(prose).decide()
        self.assertEqual(
            result.decision, 'block',
            'a mention of the marker in prose, not at the start of its own line, must not disarm the guard')
        self.assertIn('1 task(s) not done', result.message)

    # --- plan file itself is broken -----------------------------------------

    def test_unreadable_plan_file_allows_and_says_nothing_is_enforced(self):
        f = self.fixture(PLAN_OPEN)
        plan_abspath = f.plan_abspath()
        os.chmod(plan_abspath, 0o000)
        try:
            if os.access(plan_abspath, os.R_OK):
                self.skipTest('running as a user that bypasses file permissions (e.g. root)')
            result = f.decide()
            self.assertEqual(result.decision, 'allow')
            self.assertIn(plan_abspath, result.message)
            self.assertIn('could not be read', result.message)
            self.assertIn('enforcing NOTHING', result.message)
        finally:
            os.chmod(plan_abspath, 0o644)

    # --- conductor scoping -------------------------------------------------

    def test_a_bystander_session_is_not_enforced(self):
        f = self.fixture(PLAN_OPEN)
        result = f.decide(session_id='some-other-session')
        self.assertEqual(result.decision, 'allow')
        # Discriminating content: names BOTH the bystander session and the
        # live conductor, in the right roles -- a mutation that swapped
        # which id plays which role would still contain both strings, so
        # pin their exact placement in the sentence, not just membership.
        self.assertIn('Session some-other-session is a bystander', result.message)
        self.assertIn('session ' + SESSION + ' holds the live conductor claim', result.message)

    def test_first_armed_stop_claims_an_unclaimed_plan(self):
        f = self.fixture(PLAN_OPEN, conductor=None)
        result = f.decide(transcript=WAKE)
        self.assertEqual(result.decision, 'allow')
        self.assertIn('had no conductor claimed', result.message)
        self.assertIn('session ' + SESSION + ' has claimed conduction', result.message)
        with open(os.path.join(f.dir, '.claude', 'active-plan')) as fh:
            self.assertIn('conductor: ' + SESSION, fh.read())

    def test_stale_conductor_is_re_claimed_when_armed(self):
        f = self.fixture(PLAN_OPEN, conductor='dead-conductor-session')
        # No transcripts_dir was passed, so conductor_is_stale() takes its
        # "no transcript directory" branch and reports NOT stale (False),
        # which does not exercise this path. Build the call directly with a
        # transcripts_dir that has no matching transcript file, which makes
        # conductor_is_stale() return True via its OSError branch.
        transcripts_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, transcripts_dir, True)
        result = pg.plan_guard_decision(
            f.dir, False, WAKE, session_id=SESSION, transcripts_dir=transcripts_dir)
        self.assertEqual(result.decision, 'allow')
        self.assertIn('Conductor dead-conductor-session', result.message)
        self.assertIn('silent past the 6-hour staleness window', result.message)
        self.assertIn('session ' + SESSION + ' has re-claimed conduction', result.message)
        with open(os.path.join(f.dir, '.claude', 'active-plan')) as fh:
            self.assertIn('conductor: ' + SESSION, fh.read())

    def test_stale_unarmed_conductor_falls_through_to_the_plan_checks(self):
        """Not one of the eleven allow paths: a stale, unarmed bystander
        session falls through so the open-task block still fires, ensuring
        someone is told rather than everyone staying silently quiet."""
        f = self.fixture(PLAN_OPEN, conductor='dead-conductor-session')
        transcripts_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, transcripts_dir, True)
        result = pg.plan_guard_decision(
            f.dir, False, NO_WAKE, session_id=SESSION, transcripts_dir=transcripts_dir)
        self.assertEqual(result.decision, 'block')
        self.assertIn('1 task(s) not done', result.message)


class TestMainEndToEnd(unittest.TestCase):
    """Runs the script exactly as Claude Code invokes it: real JSON on
    stdin, real bytes on stdout. Locks main()'s JSON wrapping (the {"decision":
    ...} / {"systemMessage": ...} envelope), which the unit tests above,
    calling plan_guard_decision() directly, cannot see."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        os.makedirs(os.path.join(self.dir, '.claude'))
        os.makedirs(os.path.join(self.dir, 'specs'))
        with open(os.path.join(self.dir, 'specs', 'plan.md'), 'w') as f:
            f.write(PLAN_OPEN)
        with open(os.path.join(self.dir, '.claude', 'active-plan'), 'w') as f:
            f.write('specs/plan.md\nconductor: ' + SESSION + '\n')

    def _run(self, payload):
        proc = subprocess.run(
            [sys.executable, HOOK], input=json.dumps(payload),
            capture_output=True, text=True)
        return proc

    def test_block_path_prints_exactly_the_decision_envelope(self):
        proc = self._run({
            'cwd': self.dir,
            'session_id': SESSION,
            'stop_hook_active': False,
            'transcript_path': '',
        })
        self.assertEqual(proc.returncode, 0)
        out = json.loads(proc.stdout)
        self.assertEqual(set(out.keys()), {'decision', 'reason'})
        self.assertEqual(out['decision'], 'block')
        self.assertIn('1 task(s) not done', out['reason'])

    def test_allow_path_prints_exactly_the_systemMessage_envelope(self):
        transcript = os.path.join(self.dir, 'transcript.jsonl')
        with open(transcript, 'w') as f:
            f.write('\n'.join(WAKE) + '\n')
        proc = self._run({
            'cwd': self.dir,
            'session_id': SESSION,
            'stop_hook_active': False,
            'transcript_path': transcript,
        })
        self.assertEqual(proc.returncode, 0)
        out = json.loads(proc.stdout)
        self.assertEqual(set(out.keys()), {'systemMessage'})
        self.assertIn('wake source is armed; conduction continues', out['systemMessage'])

    def test_silent_path_prints_nothing_at_all(self):
        empty = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, empty, True)
        proc = self._run({
            'cwd': empty,
            'session_id': SESSION,
            'stop_hook_active': False,
            'transcript_path': '',
        })
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, '')

    def test_a_non_string_session_id_does_not_crash_and_is_coerced_to_plain_text(self):
        """Round-2 review nit: session_id comes straight off the JSON
        payload, so a malformed caller can hand it a non-string (a JSON
        number, or worse, an array/object). Uncoerced, that reaches
        claim()'s '+' string concatenation (a crash for anything but a
        str) and, in a message, would print with whatever repr its type's
        default __str__ produces. main() must coerce it to str() once at
        the boundary rather than either crashing or leaking a non-string
        type downstream."""
        proc = self._run({
            'cwd': self.dir,
            'session_id': 424242,  # a JSON number, not a string
            'stop_hook_active': False,
            'transcript_path': '',
        })
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        # This session is a bystander on the fixture's conductor (SESSION);
        # the numeric id must appear as plain text, not a crash or a
        # bracketed/quoted container repr.
        self.assertIn('systemMessage', out)
        self.assertIn('Session 424242 is a bystander', out['systemMessage'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
