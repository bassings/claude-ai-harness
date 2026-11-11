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
import re
import tempfile
import unittest

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
GUARD_PATH = os.path.join(HOOKS_DIR, 'destructive-git-guard.py')
HOOKS_JSON_PATH = os.path.join(HOOKS_DIR, 'hooks.json')
REPO_ROOT = os.path.dirname(HOOKS_DIR)

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


GUARD_SCRIPT = 'destructive-git-guard.py'
HOOKS_JSON_ORIGIN = 'hooks/hooks.json'

# A fenced block of ANY info string (json, JSON, jsonc, `json title=...`,
# untagged), at any indentation of the fence. Selection is by content, not tag.
_FENCE_RE = re.compile(r'^[ \t]*```[^\n]*\n(.*?)^[ \t]*```[ \t]*$', re.DOTALL | re.MULTILINE)


def hook_entries(snippet):
    """Every dict anywhere in a parsed snippet that carries `args`."""
    found = []

    def walk(node):
        if isinstance(node, dict):
            if 'args' in node:
                found.append(node)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(snippet)
    return found


def extract_hook_snippets(text, origin):
    """Parse every fenced block in `text`, whatever its tag, whose body names
    the guard or carries `"args"` and starts like JSON (`{`, `[`, or a `/`
    comment), returning [(origin, parsed)]. A candidate
    that does not parse as JSON RAISES rather than being skipped (jsonc
    comments included): a snippet this test cannot read is a snippet it cannot
    vouch for."""
    snippets = []
    for match in _FENCE_RE.finditer(text):
        body = match.group(1)
        if GUARD_SCRIPT not in body and '"args"' not in body:
            continue
        if body.lstrip()[:1] not in ('{', '[', '/'):
            # Shell, prose or other non-JSON text that merely mentions the
            # guard. `/` is kept as a candidate start so a jsonc block that
            # opens with a comment fails loudly as unparseable.
            continue
        try:
            snippets.append((origin, json.loads(body)))
        except ValueError as exc:
            raise AssertionError('%s has a hook snippet that is not valid JSON: %s' % (origin, exc))
    return snippets


def collect_documented_snippets(repo_root):
    """Hook snippets from README.md, every .md file under docs/ (recursively)
    and hooks/hooks.json, so moving a snippet between them cannot hide it."""
    sources = [os.path.join(repo_root, 'README.md')]
    for dirpath, _dirs, files in os.walk(os.path.join(repo_root, 'docs')):
        sources.extend(os.path.join(dirpath, f) for f in sorted(files) if f.endswith('.md'))
    snippets = []
    for path in sources:
        with open(path, encoding='utf-8') as fh:
            snippets.extend(extract_hook_snippets(fh.read(), os.path.relpath(path, repo_root)))
    with open(os.path.join(repo_root, 'hooks', 'hooks.json'), encoding='utf-8') as fh:
        snippets.append((HOOKS_JSON_ORIGIN, json.load(fh)))
    return snippets


def snippet_problems(snippets, worst_case_seconds):
    """Problems across `snippets`: no DOCUMENTED guard snippet (hooks.json
    always names the guard, so it cannot count toward this or the check would
    be vacuous), a guard timeout absent or not strictly above the worst case,
    or `~` in any args."""
    problems = []
    guard_seen = 0
    for origin, snippet in snippets:
        for entry in hook_entries(snippet):
            args = entry['args']
            for arg in args:
                if '~' in arg:
                    problems.append('%s: args contains "~" (%r); a tilde is not expanded in args, so the hook exits 2 and refuses every Bash call' % (origin, arg))
            if any(os.path.basename(arg) == GUARD_SCRIPT for arg in args):
                if origin != HOOKS_JSON_ORIGIN:
                    guard_seen += 1
                timeout = entry.get('timeout')
                if not isinstance(timeout, (int, float)) or timeout <= worst_case_seconds:
                    problems.append('%s: %s registered with timeout %r, not strictly greater than its worst case of %ss' % (origin, GUARD_SCRIPT, timeout, worst_case_seconds))
    if guard_seen == 0:
        problems.append('no hook snippet naming %s found in README.md, docs/ or hooks/hooks.json' % GUARD_SCRIPT)
    return problems


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

    def test_every_documented_hook_snippet_is_within_budget_and_free_of_tilde_args(self):
        problems = snippet_problems(collect_documented_snippets(REPO_ROOT), guard.WORST_CASE_SEGMENT_SECONDS)
        self.assertEqual(problems, [])

    def test_snippet_check_flags_a_low_guard_timeout_a_tilde_and_a_missing_guard(self):
        worst = guard.WORST_CASE_SEGMENT_SECONDS
        low = [('x.md', {'hooks': [{'args': ['/h/destructive-git-guard.py'], 'timeout': worst}]})]
        self.assertEqual(len(snippet_problems(low, worst)), 1)
        tilde = [('x.md', {'hooks': [{'args': ['~/.claude/hooks/destructive-git-guard.py'], 'timeout': worst + 1}]})]
        self.assertEqual(len(snippet_problems(tilde, worst)), 1)
        absent = [('x.md', {'hooks': [{'args': ['/h/git-snapshot.py'], 'timeout': 10}]})]
        self.assertEqual(len(snippet_problems(absent, worst)), 1)
        manifest_only = [(HOOKS_JSON_ORIGIN, {'hooks': [{'args': ['/p/destructive-git-guard.py'], 'timeout': worst + 1}]})]
        self.assertEqual(len(snippet_problems(manifest_only, worst)), 1)

    def test_a_guard_snippet_at_timeout_10_is_found_whatever_its_fence_tag(self):
        worst = guard.WORST_CASE_SEGMENT_SECONDS
        bad = '{"hooks": [{"args": ["/h/destructive-git-guard.py"], "timeout": 10}]}'
        for tag in ('json title="settings.json"', 'JSON', 'jsonc', 'json5', ''):
            with self.subTest(tag=tag), tempfile.TemporaryDirectory() as root:
                os.makedirs(os.path.join(root, 'docs'))
                os.makedirs(os.path.join(root, 'hooks'))
                with open(os.path.join(root, 'hooks', 'hooks.json'), 'w') as fh:
                    fh.write('{"hooks": {}}')
                with open(os.path.join(root, 'README.md'), 'w') as fh:
                    fh.write('```json\n{"hooks": [{"args": ["/h/destructive-git-guard.py"], "timeout": 60}]}\n```\n')
                with open(os.path.join(root, 'docs', 'old.md'), 'w') as fh:
                    fh.write('prose\n\n```%s\n%s\n```\n' % (tag, bad))
                problems = snippet_problems(collect_documented_snippets(root), worst)
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(os.path.join('docs', 'old.md'), problems[0])

    def test_non_json_fences_mentioning_the_guard_are_not_hook_snippets(self):
        worst = guard.WORST_CASE_SEGMENT_SECONDS
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, 'hooks'))
            with open(os.path.join(root, 'hooks', 'hooks.json'), 'w') as fh:
                fh.write('{"hooks": {}}')
            with open(os.path.join(root, 'README.md'), 'w') as fh:
                fh.write('```json\n{"hooks": [{"args": ["/h/destructive-git-guard.py"], "timeout": 60}]}\n```\n'
                         '```bash\ncp hooks/destructive-git-guard.py ~/.claude/hooks/\n```\n'
                         '```text\nthe destructive-git-guard.py hook\n```\n')
            self.assertEqual(snippet_problems(collect_documented_snippets(root), worst), [])

    def test_a_jsonc_block_with_a_leading_comment_fails_loudly_rather_than_being_skipped(self):
        text = '```jsonc\n// settings\n{"hooks": [{"args": ["/h/destructive-git-guard.py"], "timeout": 10}]}\n```\n'
        with self.assertRaises(AssertionError):
            extract_hook_snippets(text, 'x.md')

    def test_a_guard_registered_as_a_later_arg_is_still_checked(self):
        worst = guard.WORST_CASE_SEGMENT_SECONDS
        later = [('x.md', {'hooks': [{'args': ['-u', '/h/destructive-git-guard.py'], 'timeout': 10}]})]
        problems = snippet_problems(later, worst)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn('timeout 10', problems[0])

    def test_snippets_are_found_under_docs_and_unparseable_ones_fail_loudly(self):
        worst = guard.WORST_CASE_SEGMENT_SECONDS
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, 'docs', 'nested'))
            os.makedirs(os.path.join(root, 'hooks'))
            with open(os.path.join(root, 'README.md'), 'w') as fh:
                fh.write('no snippet here\n')
            with open(os.path.join(root, 'hooks', 'hooks.json'), 'w') as fh:
                fh.write('{"hooks": {}}')
            nested = os.path.join('docs', 'nested', 'a.md')
            with open(os.path.join(root, nested), 'w') as fh:
                fh.write('```json\n{"hooks": [{"args": ["/h/destructive-git-guard.py"], "timeout": %d}]}\n```\n' % (worst + 1))
            found = collect_documented_snippets(root)
            self.assertIn(nested, [origin for origin, _ in found])
            self.assertEqual(snippet_problems(found, worst), [])
            with open(os.path.join(root, 'docs', 'broken.md'), 'w') as fh:
                fh.write('```json\n{"args": ["/h/destructive-git-guard.py",]}\n```\n')
            with self.assertRaises(AssertionError):
                collect_documented_snippets(root)


if __name__ == '__main__':
    unittest.main()
