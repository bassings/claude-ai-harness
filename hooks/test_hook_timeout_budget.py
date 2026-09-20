#!/usr/bin/env python3
"""K1 review round 1: hooks/hooks.json's registered timeout for the
destructive-git guard must be strictly greater than the guard's own
worst-case per-segment subprocess budget. A Claude Code PreToolUse hook
that times out does not block the tool call -- it lets it PROCEED -- so a
registered timeout at or below the guard's own worst case turns a
genuinely slow (not hung) git call into a silent allow of exactly the
command this guard exists to refuse.

Finds the guard's hook entry by its COMMAND (the script path in `args`),
never by its position in hooks.json, so reordering the PreToolUse/Bash
group's two entries (the guard and the snapshot hook) cannot silently
point this test at the wrong one.

Run: python3 -m unittest discover -s hooks -p 'test_*.py'
"""
import importlib.util
import json
import os
import unittest

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
GUARD_PATH = os.path.join(HOOKS_DIR, 'destructive-git-guard.py')
HOOKS_JSON_PATH = os.path.join(HOOKS_DIR, 'hooks.json')

_spec = importlib.util.spec_from_file_location('destructive_git_guard_timeout_check', GUARD_PATH)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)


def find_hook_entry_by_script(hooks_json, script_basename):
    """Search every hook group under every event in hooks_json['hooks'] for
    an entry whose `args[0]` names `script_basename` by basename (the
    registered path carries a `${CLAUDE_PLUGIN_ROOT}` prefix, which
    os.path.basename ignores same as any other path). Returns the matching
    entry dict, or None -- never assumes a fixed event name or list index,
    so reordering hooks.json's groups or entries cannot silently point this
    at the wrong hook."""
    for groups in hooks_json.get('hooks', {}).values():
        for group in groups:
            for entry in group.get('hooks', []):
                args = entry.get('args') or []
                if args and os.path.basename(args[0]) == script_basename:
                    return entry
    return None


class TestHookTimeoutBudget(unittest.TestCase):

    def setUp(self):
        with open(HOOKS_JSON_PATH) as fh:
            self.hooks_json = json.load(fh)

    def test_destructive_git_guard_timeout_exceeds_its_own_worst_case_budget(self):
        entry = find_hook_entry_by_script(self.hooks_json, 'destructive-git-guard.py')
        self.assertIsNotNone(entry, 'hooks.json has no entry registering destructive-git-guard.py')
        self.assertIn('timeout', entry, 'the destructive-git-guard.py hook entry has no timeout at all')
        registered = entry['timeout']
        self.assertGreater(
            registered, guard.WORST_CASE_SEGMENT_SECONDS,
            'hooks.json registers a %ss timeout for destructive-git-guard.py, which is not strictly '
            'greater than the guard\'s own worst-case per-segment budget of %ss '
            '(MAX_SUBPROCESS_CALLS_PER_SEGMENT=%s x SUBPROCESS_TIMEOUT_SECONDS=%ss) -- a hook that '
            'times out lets the tool call PROCEED, so this would silently allow a destructive command '
            'whenever the measuring git call is merely slow, not hung.'
            % (registered, guard.WORST_CASE_SEGMENT_SECONDS, guard.MAX_SUBPROCESS_CALLS_PER_SEGMENT,
               guard.SUBPROCESS_TIMEOUT_SECONDS))

    def test_the_other_two_registered_hooks_are_unchanged_at_10(self):
        # Round 1 asked to raise ONLY the destructive-git-guard.py entry.
        # Pinned here so a future edit that "helpfully" raises the others
        # too is caught -- each hook's timeout is its own decision.
        snapshot = find_hook_entry_by_script(self.hooks_json, 'git-snapshot.py')
        stop_hook = find_hook_entry_by_script(self.hooks_json, 'plan-guard-stop.py')
        self.assertIsNotNone(snapshot, 'hooks.json has no entry registering git-snapshot.py')
        self.assertIsNotNone(stop_hook, 'hooks.json has no entry registering plan-guard-stop.py')
        self.assertEqual(snapshot.get('timeout'), 10)
        self.assertEqual(stop_hook.get('timeout'), 10)


if __name__ == '__main__':
    unittest.main()
