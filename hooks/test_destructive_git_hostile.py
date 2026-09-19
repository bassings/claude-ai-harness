#!/usr/bin/env python3
"""AC-SEC-4: across a generated set of at least 1,000 hostile commands, the
guard process must exit ONLY 0 or 2 -- never 1, never any other code, and
never with a Python traceback on stderr. Split out from
hooks/test_destructive_git_cases.py (its own docstring notes this is
allowed) because this file's job is different in kind: the corpus proves the
guard reaches the RIGHT verdict on a known shape; this file proves it never
CRASHES on an unknown one.

Two passes, for a real reason, not belt-and-braces for its own sake:

  * The bulk (>=1000 generated hostile commands, deterministic via a fixed
    random seed) is driven IN-PROCESS through the guard's own `main()`
    function, with stdin/stdout/stderr redirected and `sys.exit` caught as
    `SystemExit` -- this is the EXACT code path a real hook invocation runs
    (main() -> evaluate() -> sys.exit), just without paying for 1,000+
    fresh Python process startups. A crash anywhere in that call graph
    still surfaces here as an uncaught exception, which unittest reports as
    a failure exactly like a subprocess traceback would.
  * A smaller, explicit sample (the four named pathological shapes, plus a
    handful of the generated set) is ALSO run as a REAL subprocess, to
    confirm the actual OS-level exit code and stderr contract holds for the
    genuinely deployed script, not just for a function call within this
    test's own process.

Run: python3 -m unittest discover -s hooks -p 'test_*.py'
"""
import importlib.util
import io
import json
import os
import random
import shlex
import subprocess
import sys
import tempfile
import time
import unittest

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
GUARD_PATH = os.path.join(HOOKS_DIR, 'destructive-git-guard.py')

_spec = importlib.util.spec_from_file_location('destructive_git_guard_hostile', GUARD_PATH)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)

MIN_HOSTILE_COMMANDS = 1000

BASE_COMMANDS = [
    'git reset --hard',
    'git checkout -- x',
    'git clean -f',
    'git stash drop',
    'git restore x',
    'echo hi',
    'git -c clean.requireForce=false clean -d',
]


def mutate_unbalanced_single_quote(s):
    return s + "'"


def mutate_unbalanced_double_quote(s):
    return s + '"'


def mutate_unterminated_subst(s):
    return 'echo $(' + s


def mutate_unterminated_backtick(s):
    return 'echo `' + s


def mutate_control_char_soup(s, rng):
    ops = ['&&', ';', '|', '\n', '&', '||']
    pieces = [s]
    for _ in range(rng.randint(1, 5)):
        pieces.append(rng.choice(ops))
        pieces.append(rng.choice(BASE_COMMANDS))
    return ''.join(pieces)


def mutate_wrapper_chain(s, rng):
    wrappers = ['nohup', 'sudo', 'sudo -u x', 'timeout 5', 'env', 'env -i', 'command', 'exec',
                'bash -c', 'sh -c']
    chain = s
    for _ in range(rng.randint(1, 10)):
        chain = rng.choice(wrappers) + ' ' + chain
    return chain


def mutate_non_ascii(s, rng):
    junk = ''.join(rng.choice('日本語🚀€ñ中文​‮') for _ in range(rng.randint(1, 8)))
    return s + ' ' + junk


def mutate_weird_whitespace(s, rng):
    return s.replace(' ', rng.choice(['\t', '  ', ' \t ']))


def mutate_padding(s, rng):
    return s + ' ' + ('A' * rng.randint(100, 5000))


def mutate_mixed_quote_fragments(s, rng):
    return s + rng.choice(["'\"'", "\"'\"", "'''", '"""', "'$('", '"`"'])


MUTATORS_STRING_ONLY = [mutate_unbalanced_single_quote, mutate_unbalanced_double_quote,
                        mutate_unterminated_subst, mutate_unterminated_backtick]
MUTATORS_WITH_RNG = [mutate_control_char_soup, mutate_wrapper_chain, mutate_non_ascii,
                     mutate_weird_whitespace, mutate_padding, mutate_mixed_quote_fragments]


def naive_deep_nesting(base, depth):
    """A `bash -c '` opened `depth` times with no attempt at correct
    escaping (a genuinely, correctly escaped `depth`-deep nest is
    combinatorially infeasible to construct at all -- see the PR body's
    timing note: escaping roughly doubles the quote count per level). The
    point of this fixture is that the guard must survive wildly unbalanced,
    garbage-nested input without crashing, not that the nesting is
    semantically valid shell."""
    return ("bash -c '" * depth) + base + ("'" * depth)


def generate_hostile_commands(count, seed=20260919):
    """Deterministic (fixed seed) set of at least `count` hostile command
    strings, covering every category AC-SEC-4 names by name (unbalanced
    quotes, an unterminated `$(`, a bash -c nested 1,000 deep, a 1 MiB
    command string) plus a combinatorial spread of randomised mutations
    over BASE_COMMANDS so the set is not just those four exact strings."""
    rng = random.Random(seed)
    commands = []

    # The four explicitly named pathological shapes.
    commands.append("git reset --hard'")  # unbalanced single quote
    commands.append('git reset --hard"')  # unbalanced double quote
    commands.append('echo $(git reset --hard')  # unterminated $(
    commands.append(naive_deep_nesting('git reset --hard', 1000))  # bash -c nested 1,000 deep
    commands.append('git reset --hard ' + ('A' * (1024 * 1024)))  # a 1 MiB command string

    for s in MUTATORS_STRING_ONLY:
        for base in BASE_COMMANDS:
            commands.append(s(base))

    while len(commands) < count:
        base = rng.choice(BASE_COMMANDS)
        mutator = rng.choice(MUTATORS_WITH_RNG)
        commands.append(mutator(base, rng))

    return commands


HOSTILE_COMMANDS = generate_hostile_commands(MIN_HOSTILE_COMMANDS)

TRACEBACK_MARKER = 'Traceback (most recent call last)'


class TestHostileCommandsInProcess(unittest.TestCase):
    """The bulk pass: every generated hostile command driven through the
    guard's REAL main() function in-process (stdin/stdout/stderr
    redirected, sys.exit caught) -- fast enough to cover 1,000+ commands in
    one run, and it exercises the exact same call graph a real hook
    invocation does."""

    def setUp(self):
        self.assertGreaterEqual(len(HOSTILE_COMMANDS), MIN_HOSTILE_COMMANDS,
                                 'the hostile generator must produce at least %d commands' % MIN_HOSTILE_COMMANDS)

    def _drive_main(self, command, cwd):
        payload = json.dumps({
            'tool_name': 'Bash',
            'tool_input': {'command': command},
            'cwd': cwd,
            'hook_event_name': 'PreToolUse',
        })
        old_stdin, old_stdout, old_stderr = sys.stdin, sys.stdout, sys.stderr
        sys.stdin = io.StringIO(payload)
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        try:
            with self.assertRaises(SystemExit) as ctx:
                guard.main()
            return ctx.exception.code, sys.stderr.getvalue()
        finally:
            sys.stdin, sys.stdout, sys.stderr = old_stdin, old_stdout, old_stderr

    def test_every_hostile_command_exits_0_or_2_never_crashes(self):
        cwd = tempfile.mkdtemp(prefix='destructive-git-hostile-')
        try:
            subprocess.run(['git', 'init', '-q', '-b', 'master'], cwd=cwd,
                            capture_output=True, timeout=10)
            for index, command in enumerate(HOSTILE_COMMANDS):
                with self.subTest(index=index, command=command[:80]):
                    code, stderr = self._drive_main(command, cwd)
                    self.assertIn(code, (0, 2, None),
                                  'hostile command #%d exited %r, must be 0 or 2 (or None, which '
                                  'sys.exit() normalises to 0): %r...' % (index, code, command[:80]))
                    self.assertNotIn(TRACEBACK_MARKER, stderr,
                                      'hostile command #%d produced a traceback on stderr: %r...' % (index, command[:80]))
        finally:
            subprocess.run(['rm', '-rf', cwd])


class TestHostileCommandsAsRealProcesses(unittest.TestCase):
    """A smaller sample, run as REAL subprocesses of the actual script, to
    confirm the OS-level exit code and stderr contract holds for the
    deployed hook, not just for a function call inside this test process."""

    def _sample(self):
        # The four named pathological shapes plus a fixed, deterministic
        # slice of the generated set.
        return HOSTILE_COMMANDS[:5] + HOSTILE_COMMANDS[5:len(HOSTILE_COMMANDS):97][:25]

    def test_sampled_hostile_commands_as_real_subprocesses(self):
        cwd = tempfile.mkdtemp(prefix='destructive-git-hostile-proc-')
        try:
            subprocess.run(['git', 'init', '-q', '-b', 'master'], cwd=cwd,
                            capture_output=True, timeout=10)
            for index, command in enumerate(self._sample()):
                payload = json.dumps({
                    'tool_name': 'Bash',
                    'tool_input': {'command': command},
                    'cwd': cwd,
                    'hook_event_name': 'PreToolUse',
                })
                with self.subTest(index=index, command=command[:80]):
                    result = subprocess.run(
                        [sys.executable, GUARD_PATH], input=payload,
                        capture_output=True, text=True, timeout=10,
                    )
                    self.assertIn(result.returncode, (0, 2),
                                  'process exited %s for %r...' % (result.returncode, command[:80]))
                    self.assertNotIn(TRACEBACK_MARKER, result.stderr,
                                      'process printed a traceback for %r...' % (command[:80]))
        finally:
            subprocess.run(['rm', '-rf', cwd])

    def test_the_worst_known_hostile_input_is_fast_and_refused(self):
        # K1 review round 2: PR #3's CI failure, reproduced locally before
        # the fix -- HOSTILE_COMMANDS[4] is the 1 MiB command (`git reset
        # --hard` plus ~1 MiB of trailing padding as one token), and
        # split_segments() alone took ~8s on this machine BEFORE
        # MAX_COMMAND_LENGTH_CHARS existed, comfortably over the 10s budget
        # this test's own subprocess.run() enforces, under any real
        # contention. This is a NAMED regression test for that exact
        # command, not just a member of the generated set: an explicit,
        # tight, STATED budget (2000ms -- roughly 50x the ~36ms measured
        # after the fix, and 5x tighter than the general 10s subprocess
        # spawn timeout above), and the SPECIFIC expected outcome (refused,
        # not merely "0 or 2"), naming the oversize reason.
        WORST_CASE_BUDGET_MS = 2000
        oversize_command = HOSTILE_COMMANDS[4]
        self.assertGreater(len(oversize_command), guard.MAX_COMMAND_LENGTH_CHARS,
                            'sanity: HOSTILE_COMMANDS[4] must still be the over-cap command this test names')
        cwd = tempfile.mkdtemp(prefix='destructive-git-hostile-worst-case-')
        try:
            subprocess.run(['git', 'init', '-q', '-b', 'master'], cwd=cwd,
                            capture_output=True, timeout=10)
            payload = json.dumps({
                'tool_name': 'Bash',
                'tool_input': {'command': oversize_command},
                'cwd': cwd,
                'hook_event_name': 'PreToolUse',
            })
            start = time.monotonic()
            result = subprocess.run(
                [sys.executable, GUARD_PATH], input=payload,
                capture_output=True, text=True, timeout=10,
            )
            elapsed_ms = (time.monotonic() - start) * 1000.0
            self.assertLess(
                elapsed_ms, WORST_CASE_BUDGET_MS,
                'the 1 MiB command took %.1fms, over the explicit %sms worst-case budget '
                '(PR #3 measured ~8-9s for this shape before MAX_COMMAND_LENGTH_CHARS existed)'
                % (elapsed_ms, WORST_CASE_BUDGET_MS))
            self.assertEqual(
                result.returncode, 2,
                'an over-cap command must be REFUSED, not allowed -- it could still hide a real '
                'destructive git call in the padding (got exit %s, stderr: %s)'
                % (result.returncode, result.stderr))
            self.assertIn('parsing cap', result.stderr,
                           'the refusal must name the oversize reason, not some other rule: %s' % result.stderr)
        finally:
            subprocess.run(['rm', '-rf', cwd])


class TestOversizeGitSubstringDecision(unittest.TestCase):
    """K1 review round 3: refusing EVERY over-cap command blocked ordinary
    work -- this hook runs on every Bash call, and an agent routinely
    writes a large file through one (a heredoc, generated test data).
    Measured: `echo hi ` followed by 70,000 x's was refused with exit 2
    against b9db050, purely for being long, with no `git` anywhere in it.

    The fix (round 3): over the cap, refuse only when the raw text contains
    the substring `git`; otherwise allow without parsing. These three cases
    pin the decision in both directions, plus its accepted cost."""

    def _run(self, command, cwd):
        payload = json.dumps({
            'tool_name': 'Bash',
            'tool_input': {'command': command},
            'cwd': cwd,
            'hook_event_name': 'PreToolUse',
        })
        start = time.monotonic()
        result = subprocess.run(
            [sys.executable, GUARD_PATH], input=payload,
            capture_output=True, text=True, timeout=10,
        )
        elapsed_ms = (time.monotonic() - start) * 1000.0
        return result, elapsed_ms

    def test_a_70000_char_command_with_no_git_substring_is_allowed(self):
        # The exact shape measured against b9db050: over the cap, no `git`
        # anywhere, purely a large harmless write. Also fast: the
        # allow-without-parsing path is a single linear scan, not a parse.
        command = 'echo hi ' + ('x' * 70000)
        self.assertGreater(len(command), guard.MAX_COMMAND_LENGTH_CHARS,
                            'sanity: this command must still be over the cap')
        self.assertNotIn('git', command, 'sanity: this command must contain no `git` substring at all')
        cwd = tempfile.mkdtemp(prefix='destructive-git-hostile-oversize-no-git-')
        try:
            subprocess.run(['git', 'init', '-q', '-b', 'master'], cwd=cwd, capture_output=True, timeout=10)
            result, elapsed_ms = self._run(command, cwd)
            self.assertEqual(
                result.returncode, 0,
                'a large command with no `git` substring must be ALLOWED without being parsed -- '
                'this hook runs on every Bash call, and refusing ordinary large writes (a heredoc, '
                'generated test data) is exactly the noise that gets a guard disabled. '
                'Got exit %s, stderr: %s' % (result.returncode, result.stderr))
            self.assertLess(elapsed_ms, 2000,
                             'the no-git allow path took %.1fms -- it must be a cheap linear scan, never a parse'
                             % elapsed_ms)
        finally:
            subprocess.run(['rm', '-rf', cwd])

    def test_the_1mib_git_reset_hard_case_still_refused_within_budget(self):
        # The fix must not have reopened round 2's hole: a real destructive
        # command over the cap stays refused, and stays fast.
        command = 'git reset --hard ' + ('A' * 1048576)
        cwd = tempfile.mkdtemp(prefix='destructive-git-hostile-oversize-with-git-')
        try:
            subprocess.run(['git', 'init', '-q', '-b', 'master'], cwd=cwd, capture_output=True, timeout=10)
            result, elapsed_ms = self._run(command, cwd)
            self.assertEqual(result.returncode, 2,
                              'an over-cap command containing `git reset --hard` must still be refused')
            self.assertLess(elapsed_ms, 2000, 'refusing an over-cap git command took %.1fms, over budget' % elapsed_ms)
        finally:
            subprocess.run(['rm', '-rf', cwd])

    def test_a_70000_char_heredoc_body_mentioning_git_is_refused_accepted_cost(self):
        # The accepted cost of checking the RAW text (before heredoc-body
        # stripping): an over-cap heredoc body that merely MENTIONS git,
        # and would ordinarily be inert text once parsed, is refused
        # instead of being cheaply parsed to find out it was harmless --
        # confirming it really is inert needs the same expensive parse the
        # length cap exists to avoid. Pinned here so this cost stays a
        # documented choice, not a silent surprise if someone later "fixes"
        # it by parsing first and cheapens the guarantee round 2 exists for.
        body_line = 'please never run git reset --hard here\n'
        command = "cat <<'EOF' > generated-fixture.txt\n" + body_line * 2000 + "EOF\n"
        self.assertGreater(len(command), guard.MAX_COMMAND_LENGTH_CHARS,
                            'sanity: this heredoc must still be over the cap')
        self.assertIn('git', command, 'sanity: the heredoc body must mention git')
        cwd = tempfile.mkdtemp(prefix='destructive-git-hostile-oversize-heredoc-')
        try:
            subprocess.run(['git', 'init', '-q', '-b', 'master'], cwd=cwd, capture_output=True, timeout=10)
            result, elapsed_ms = self._run(command, cwd)
            self.assertEqual(
                result.returncode, 2,
                'an over-cap heredoc whose body mentions `git` is refused -- the accepted cost of '
                'checking the raw text before heredoc stripping, not a bug')
            self.assertLess(elapsed_ms, 2000, 'refusing an over-cap heredoc took %.1fms, over budget' % elapsed_ms)
        finally:
            subprocess.run(['rm', '-rf', cwd])


class TestHostilePayloadShapes(unittest.TestCase):
    """The two categories that are not really "commands" at all: a
    malformed PAYLOAD (empty / non-JSON), and a non-ASCII cwd path."""

    def _run_raw(self, stdin_text, cwd=None):
        result = subprocess.run(
            [sys.executable, GUARD_PATH], input=stdin_text,
            capture_output=True, text=True, timeout=10,
            cwd=cwd,
        )
        return result

    def test_empty_stdin(self):
        result = self._run_raw('')
        self.assertEqual(result.returncode, 0)
        self.assertNotIn(TRACEBACK_MARKER, result.stderr)

    def test_non_json_stdin(self):
        result = self._run_raw('this is not json {{{')
        self.assertEqual(result.returncode, 0)
        self.assertNotIn(TRACEBACK_MARKER, result.stderr)

    def test_json_array_instead_of_object(self):
        result = self._run_raw('["Bash", "git reset --hard"]')
        self.assertEqual(result.returncode, 0)
        self.assertNotIn(TRACEBACK_MARKER, result.stderr)

    def test_non_ascii_cwd_path(self):
        base = tempfile.mkdtemp(prefix='destructive-git-hostile-unicode-')
        weird = os.path.join(base, '日本語-repo-​')
        os.makedirs(weird, exist_ok=True)
        try:
            subprocess.run(['git', 'init', '-q', '-b', 'master'], cwd=weird,
                            capture_output=True, timeout=10)
            payload = json.dumps({
                'tool_name': 'Bash',
                'tool_input': {'command': 'git reset --hard'},
                'cwd': weird,
                'hook_event_name': 'PreToolUse',
            })
            result = subprocess.run(
                [sys.executable, GUARD_PATH], input=payload,
                capture_output=True, text=True, timeout=10,
            )
            self.assertIn(result.returncode, (0, 2))
            self.assertNotIn(TRACEBACK_MARKER, result.stderr)
        finally:
            subprocess.run(['rm', '-rf', base])


if __name__ == '__main__':
    unittest.main()
