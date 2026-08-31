#!/usr/bin/env python3
"""Tests for the plan-guard Stop hook.

Run: python3 ~/.claude/hooks/test_plan_guard_stop.py

The hook is a guard, so these tests exist to prove it can FAIL, not merely
that it can pass. Every "allows the stop" case is paired with the mutation
that should make it block.
"""
import importlib.util
import os
import shutil
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
        reason = self.fixture(PLAN_OPEN).decide()
        self.assertIsNotNone(reason, 'guard must block an unarmed stop')
        self.assertIn('1 task(s) not done', reason)

    def test_allows_when_a_wake_source_was_armed(self):
        self.assertIsNone(self.fixture(PLAN_OPEN).decide(transcript=WAKE))

    def test_allows_when_every_task_is_ticked(self):
        done = PLAN_OPEN.replace('- [ ] T2', '- [x] T2')
        self.assertIsNone(self.fixture(done).decide())

    def test_allows_when_no_marker_file(self):
        empty = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, empty, True)
        self.assertIsNone(pg.plan_guard_decision(empty, False, NO_WAKE, session_id=SESSION))

    def test_reports_a_pointer_at_a_missing_plan(self):
        f = self.fixture(PLAN_OPEN)
        os.remove(os.path.join(f.dir, f.plan_rel))
        reason = f.decide()
        self.assertIsNotNone(reason)
        self.assertIn('does not exist', reason)

    def test_stop_hook_active_is_the_escape_hatch(self):
        self.assertIsNone(self.fixture(PLAN_OPEN).decide(stop_hook_active=True))

    # --- blocked-on-human: live vs historical ------------------------------

    def test_a_live_blocked_on_human_status_allows_the_stop(self):
        live = PLAN_OPEN.replace('# A plan',
                                 '# A plan\n\nstatus: blocked-on-human: which control owns this?')
        self.assertIsNone(self.fixture(live).decide(),
                          'a live block is a legitimate reason to stop')

    def test_frontmatter_blocked_on_human_allows_the_stop(self):
        fm = '---\nstatus: blocked-on-human: the budget is spent\n---\n\n' + PLAN_OPEN
        self.assertIsNone(self.fixture(fm).decide())

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
        reason = self.fixture(historical).decide()
        self.assertIsNotNone(
            reason, 'a resolved block recorded in the log must not disarm the guard')
        self.assertIn('1 task(s) not done', reason)

    def test_unbolded_historical_block_in_the_log_also_does_not_disarm(self):
        """Line-start alone is not the discriminator; region is."""
        historical = PLAN_OPEN + (
            '\n- **Tick 9**: escalated, since resolved.\n\n'
            'status: blocked-on-human: the payment failed\n'
        )
        self.assertIsNotNone(self.fixture(historical).decide(),
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
        blocked_on_human() regardless of region, which would not actually
        exercise the heading match this test targets.
        """
        plan = PLAN_OPEN.replace('## Conductor log', '## Conductor Log') + (
            '\n- **Tick 9**: escalated, since resolved.\n\n'
            'status: blocked-on-human: the payment failed\n'
        )
        reason = self.fixture(plan).decide()
        self.assertIsNotNone(
            reason,
            'a differently-cased conductor-log heading must still be recognised as the history boundary')
        self.assertIn('1 task(s) not done', reason)

    def test_marker_mentioned_in_prose_above_the_log_does_NOT_disarm_the_guard(self):
        """Round-1 review finding 3: region alone is not the discriminator either;
        line-start matters too, and nothing previously exercised it.

        A plan can legitimately quote the policy instruction itself ("add
        `status: blocked-on-human: <reason>` under the title and stop")
        somewhere above the log, in a notes or policy section, without that
        being a live status line. Dropping the line-start half of
        blocked_on_human() while keeping the region split reads this prose
        mention as a real block and wrongly disarms the guard.
        """
        prose = PLAN_OPEN.replace(
            '# A plan',
            '# A plan\n\nPolicy: add `status: blocked-on-human: <reason>` under the title and stop.'
        )
        reason = self.fixture(prose).decide()
        self.assertIsNotNone(
            reason, 'a mention of the marker in prose, not at the start of its own line, must not disarm the guard')
        self.assertIn('1 task(s) not done', reason)

    # --- conductor scoping -------------------------------------------------

    def test_a_bystander_session_is_not_enforced(self):
        self.assertIsNone(self.fixture(PLAN_OPEN).decide(session_id='some-other-session'))

    def test_first_armed_stop_claims_an_unclaimed_plan(self):
        f = self.fixture(PLAN_OPEN, conductor=None)
        self.assertIsNone(f.decide(transcript=WAKE))
        with open(os.path.join(f.dir, '.claude', 'active-plan')) as fh:
            self.assertIn('conductor: ' + SESSION, fh.read())


if __name__ == '__main__':
    unittest.main(verbosity=2)
