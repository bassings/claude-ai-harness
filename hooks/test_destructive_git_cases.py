#!/usr/bin/env python3
"""The shared corpus runner (AC-K1-1). Reads hooks/destructive-git-cases.json
and, for every case, builds its `setup` in a fresh throwaway repository and
checks that hooks/destructive-git-guard.py's `evaluate()` agrees with its
`expect`.

Vendored byte-identical into codex-ai-harness (AC-C2-1, AC-SIMP-10) so both
guards run the SAME cases -- this file must therefore:

  * locate the guard and the corpus RELATIVE TO ITS OWN FILE, never via a
    path specific to either repo's layout;
  * import nothing from this repo's test/ helpers (AC-DATA-15/AC-SEC-5
    duplicate the small pieces it needs -- GIT_* stripping, a temp repo --
    rather than reaching into test/helpers/*.js, which a Python file in the
    vendored copy would not even have);
  * never pass a corpus string to a shell. A case's `command` is fed ONLY to
    `evaluate()` (AC-DATA-15); a case's `setup` is a list of operations from
    a CLOSED vocabulary (destructive-git-cases.json's own `setup_ops` key),
    applied here via direct subprocess argument lists or plain file writes,
    never `shell=True`, never `sh -c`, never a corpus value formatted into a
    command string (AC-SEC-5).

Run: python3 -m unittest discover -s hooks -p 'test_*.py'
(the same command CI and .githooks/pre-push already run).
"""
import hashlib
import importlib.util
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
import unittest

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
GUARD_PATH = os.path.join(HOOKS_DIR, 'destructive-git-guard.py')
CORPUS_PATH = os.path.join(HOOKS_DIR, 'destructive-git-cases.json')

_spec = importlib.util.spec_from_file_location('destructive_git_guard', GUARD_PATH)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)

# AC-QA-1: the corpus must hold at least 16 (the 2026-09-19 probe corpus)
# plus one per new rule this task adds. Three new rules: `git clean`,
# `git stash drop`, `git stash clear` -- each with its own REFUSAL reason
# (AC-OPS-11) and its own fail-closed measurement path (AC-DATA-3). Wrapper
# unwrapping is a normalisation improvement to EXISTING rules, not a new
# guarded shape, so it is not counted here.
NEW_RULE_COUNT = 3
CORPUS_FLOOR = 16 + NEW_RULE_COUNT

# GIT_* allowlist duplicated deliberately (same reasoning as the guard's own
# module docstring): this is vendored test infrastructure, not shared code,
# and must not depend on test/helpers/git-env.js, which the vendored copy in
# codex-ai-harness will not have.
GIT_ENV_ALLOWLIST = {
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
}


def clean_env():
    env = dict(os.environ)
    for key in list(env):
        if key.startswith('GIT_') and key not in GIT_ENV_ALLOWLIST:
            del env[key]
    # Deterministic identity for every fixture commit, regardless of the
    # invoking machine's own git config.
    env.update({
        'GIT_AUTHOR_NAME': 'Corpus Fixture',
        'GIT_AUTHOR_EMAIL': 'fixture@example.com',
        'GIT_COMMITTER_NAME': 'Corpus Fixture',
        'GIT_COMMITTER_EMAIL': 'fixture@example.com',
    })
    return env


def run_git(args, cwd):
    result = subprocess.run(
        ['git'] + args, cwd=cwd, env=clean_env(),
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError('fixture setup failed: git %s (in %s)\nstdout: %s\nstderr: %s'
                            % (' '.join(args), cwd, result.stdout, result.stderr))
    return result


def write_file(root, rel_path, content):
    full = os.path.join(root, rel_path)
    parent = os.path.dirname(full)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(full, 'w') as fh:
        fh.write(content)


# The closed setup-operation vocabulary (AC-SEC-5). Each entry takes
# (root, op) and applies exactly one declarative step. An op name outside
# this dict is UNKNOWN -- apply_setup() below raises rather than guessing.
def op_init(root, op):
    run_git(['init', '-q', '-b', op.get('branch', 'master')], root)


def op_commit(root, op):
    write_file(root, op['path'], op['content'])
    run_git(['add', '--', op['path']], root)
    run_git(['commit', '-q', '-m', 'seed: %s' % op['path']], root)


def op_write(root, op):
    write_file(root, op['path'], op['content'])


def op_gitignore(root, op):
    write_file(root, '.gitignore', '\n'.join(op['patterns']) + '\n')
    run_git(['add', '--', '.gitignore'], root)
    run_git(['commit', '-q', '-m', 'seed: .gitignore'], root)


def op_mkdir(root, op):
    os.makedirs(os.path.join(root, op['path']), exist_ok=True)


def op_nested_repo(root, op):
    nested = os.path.join(root, op['path'])
    os.makedirs(nested, exist_ok=True)
    run_git(['init', '-q', '-b', 'master'], nested)
    write_file(nested, 'inner.txt', 'committed\n')
    run_git(['add', '--', 'inner.txt'], nested)
    run_git(['commit', '-q', '-m', 'seed: inner.txt'], nested)
    write_file(nested, 'inner.txt', 'dirty\n')


def op_stash_push(root, op):
    run_git(['stash', 'push', '-q'], root)


def op_branch(root, op):
    run_git(['branch', op['name']], root)


def op_config(root, op):
    # REPOSITORY-local config deliberately: it overrides the invoking
    # developer's global config, so a case asserting what git would do with
    # (say) clean.requireForce set one way is not silently answered by a
    # machine that has it set the other way.
    run_git(['config', op['key'], op['value']], root)


SETUP_OPS = {
    'init': op_init,
    'commit': op_commit,
    'write': op_write,
    'gitignore': op_gitignore,
    'mkdir': op_mkdir,
    'nested_repo': op_nested_repo,
    'stash_push': op_stash_push,
    'branch': op_branch,
    'config': op_config,
}


def apply_setup(root, setup, declared_ops):
    for op in setup:
        name = op.get('op')
        if name not in declared_ops:
            raise ValueError('unknown setup op %r -- not in the closed vocabulary declared '
                              'by destructive-git-cases.json\'s own setup_ops key' % (name,))
        SETUP_OPS[name](root, op)


def load_corpus():
    if not os.path.isfile(CORPUS_PATH):
        raise AssertionError('hooks/destructive-git-cases.json is missing at %s' % CORPUS_PATH)
    with open(CORPUS_PATH) as fh:
        data = json.load(fh)
    cases = data.get('cases')
    if not isinstance(cases, list):
        raise AssertionError('destructive-git-cases.json has no top-level "cases" array')
    return data


CORPUS = load_corpus()
CASES = CORPUS['cases']
DECLARED_SETUP_OPS = set(CORPUS.get('setup_ops', {}).keys())


class TestCorpusFloor(unittest.TestCase):
    """AC-QA-1: the runner itself must be ABLE to fail on a missing or
    undersized corpus -- checked directly here, rather than only trusted to
    behave, per the mutation-testing standard (Method step 5: this was also
    proven manually by truncating a real copy of the corpus and watching
    this assertion go red -- see the PR body for that evidence)."""

    def test_corpus_meets_the_floor(self):
        self.assertGreaterEqual(
            len(CASES), CORPUS_FLOOR,
            'corpus holds %d cases, below the floor of %d (16 probe cases + %d new rules)'
            % (len(CASES), CORPUS_FLOOR, NEW_RULE_COUNT))

    def test_setup_vocabulary_is_declared_and_matches_the_runner(self):
        # AC-SEC-5: the vocabulary is defined ONCE, in the corpus file's own
        # setup_ops key -- this asserts the runner's SETUP_OPS dispatch table
        # doesn't silently drift from what the file declares as valid.
        self.assertEqual(set(SETUP_OPS.keys()), DECLARED_SETUP_OPS)

    def test_hostile_setup_op_fails_the_suite_and_creates_no_file(self):
        # AC-SEC-5, verbatim: a case naming a setup op that is really a
        # shell command-substitution payload must fail the suite (an
        # unknown op, never silently skipped or treated as a clean repo)
        # and must never actually run -- proving apply_setup() never
        # shells out to a corpus-supplied string.
        sentinel = os.path.join(tempfile.gettempdir(), 'destructive-git-guard-pwn-sentinel')
        if os.path.exists(sentinel):
            os.remove(sentinel)
        hostile_setup = [{'op': '$(touch %s)' % sentinel}]
        root = tempfile.mkdtemp()
        try:
            with self.assertRaises(ValueError):
                apply_setup(root, hostile_setup, DECLARED_SETUP_OPS)
            self.assertFalse(os.path.exists(sentinel),
                              'the hostile setup op must never be executed -- the sentinel file must not exist')
        finally:
            subprocess.run(['rm', '-rf', root])
            if os.path.exists(sentinel):
                os.remove(sentinel)


class TestCorpusCasesViaEvaluate(unittest.TestCase):
    """The correctness pass: every case, driven in-process against
    `evaluate()` directly (AC-DATA-15) -- never via a shell, never via a
    subprocess for this pass (that is the separate timing pass below)."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix='destructive-git-cases-')

    def tearDown(self):
        subprocess.run(['rm', '-rf', self._tmp])

    def test_every_case(self):
        for index, case in enumerate(CASES):
            with self.subTest(command=case['command'], index=index, note=case.get('note')):
                root = tempfile.mkdtemp(dir=self._tmp)
                apply_setup(root, case['setup'], DECLARED_SETUP_OPS)
                reason = guard.evaluate(case['command'], root)
                if case['expect'] == 'block':
                    self.assertIsNotNone(
                        reason,
                        'expected BLOCK for %r (%s) but evaluate() allowed it'
                        % (case['command'], case.get('note')))
                elif case['expect'] == 'allow':
                    self.assertIsNone(
                        reason,
                        'expected ALLOW for %r (%s) but evaluate() refused it: %s'
                        % (case['command'], case.get('note'), reason))
                else:
                    raise AssertionError('case %r has an unrecognised expect %r' % (case['command'], case['expect']))


class TestNewRuleRefusalReasons(unittest.TestCase):
    """AC-OPS-11: each new rule's refusal names its own reason, not the
    generic 'tracked, uncommitted change' wording that belongs to
    checkout/restore/reset."""

    def _first_matching(self, note_substring):
        for case in CASES:
            if note_substring in (case.get('note') or '') and case['expect'] == 'block':
                return case
        raise AssertionError('no block case found with note containing %r' % note_substring)

    def test_clean_refusal_names_untracked_or_ignored_files(self):
        case = self._first_matching("clean's refusal must name")
        root = tempfile.mkdtemp()
        try:
            apply_setup(root, case['setup'], DECLARED_SETUP_OPS)
            reason = guard.evaluate(case['command'], root)
            self.assertIsNotNone(reason)
            self.assertNotIn('tracked, uncommitted change', reason)
            self.assertRegex(reason.lower(), r'untracked|ignored')
        finally:
            subprocess.run(['rm', '-rf', root])

    def test_stash_drop_refusal_names_stash_entries(self):
        case = self._first_matching("stash drop's refusal must name")
        root = tempfile.mkdtemp()
        try:
            apply_setup(root, case['setup'], DECLARED_SETUP_OPS)
            reason = guard.evaluate(case['command'], root)
            self.assertIsNotNone(reason)
            self.assertNotIn('tracked, uncommitted change', reason)
            self.assertIn('stash', reason.lower())
        finally:
            subprocess.run(['rm', '-rf', root])


class TestRefusalQuotesTheCommandAsWritten(unittest.TestCase):
    """AC-ARCH-4 (round 4, M3): unwrapping a process wrapper must not invent
    arguments that then show up in the refusal. xargs supplies its trailing
    arguments at RUN time from another process's stdout, so the guard cannot
    know them; the invocation is marked as having unknown trailing
    arguments, and each scope takes its own conservative reading, instead of
    a synthetic `.` pathspec being appended to the token list. A refusal
    quoting a pathspec the agent never typed sends it looking for a command
    it did not run."""

    def setUp(self):
        self._root = tempfile.mkdtemp()
        run_git(['init', '-q', '-b', 'master'], self._root)
        write_file(self._root, 'tracked.txt', 'committed\n')
        run_git(['add', '--', 'tracked.txt'], self._root)
        run_git(['commit', '-q', '-m', 'seed'], self._root)
        write_file(self._root, 'scratch-untracked.txt', 'unsaved work\n')

    def tearDown(self):
        subprocess.run(['rm', '-rf', self._root])

    def test_an_xargs_wrapped_clean_is_quoted_without_a_synthetic_pathspec(self):
        reason = guard.evaluate('echo x | xargs git clean -fd', self._root)
        self.assertIsNotNone(reason, 'an xargs-fed clean over an untracked file must still be refused')
        self.assertIn('`git clean -fd`', reason,
                      'the refusal must quote the command as written; got: %s' % reason)

    def test_xargs_unwrapping_appends_no_token_of_its_own(self):
        self.assertEqual(
            guard.strip_prefix_wrapper(['xargs', '-n1', 'git', 'stash', 'drop']),
            (['git', 'stash', 'drop'], True),
            'unwrapping xargs must yield the inner command verbatim plus the '
            'unknown-trailing-arguments flag, never an invented token')


class TestFailClosedOnTimeout(unittest.TestCase):
    """AC-DATA-3's timeout clause: the measuring git call for `clean` and
    `stash drop`/`clear` fails CLOSED when the subprocess call itself times
    out. Stubbed (subprocess.run raises TimeoutExpired) rather than waiting
    on a real hang -- constructing an actual multi-second timeout
    deterministically has no declarative setup-op shape, and a real sleep
    would make the suite slow and occasionally flaky under load."""

    def setUp(self):
        self._real_run = guard.subprocess.run
        self._root = tempfile.mkdtemp()
        run_git(['init', '-q', '-b', 'master'], self._root)

    def tearDown(self):
        guard.subprocess.run = self._real_run
        subprocess.run(['rm', '-rf', self._root])

    def _raise_timeout(self, *args, **kwargs):
        raise guard.subprocess.TimeoutExpired(cmd=args[0] if args else 'git', timeout=10)

    def test_clean_fails_closed_on_timeout(self):
        guard.subprocess.run = self._raise_timeout
        reason = guard.evaluate('git clean -f', self._root)
        self.assertIsNotNone(reason, 'git clean must fail CLOSED when the measuring call times out')

    def test_stash_drop_fails_closed_on_timeout(self):
        guard.subprocess.run = self._raise_timeout
        reason = guard.evaluate('git stash drop', self._root)
        self.assertIsNotNone(reason, 'git stash drop must fail CLOSED when the measuring call times out')

    def test_checkout_still_fails_open_on_timeout(self):
        # Unchanged posture (AC-DATA-3): old rules keep failing OPEN when
        # their own measuring call cannot complete.
        guard.subprocess.run = self._raise_timeout
        write_file(self._root, 'tracked.txt', 'x\n')
        reason = guard.evaluate('git checkout -- tracked.txt', self._root)
        self.assertIsNone(reason, 'checkout must keep its fail-open posture on a timed-out measuring call')


class TestGitDirLeakDoesNotCorruptASentinelRepo(unittest.TestCase):
    """AC-DATA-15: a leaked GIT_DIR/GIT_WORK_TREE in this PROCESS's own
    environment must not let corpus fixture setup, or evaluate()'s own git
    calls, land in some other repository. Builds a sentinel repo with a
    dirty tracked file, points GIT_DIR/GIT_WORK_TREE at it for the duration
    of one real corpus case, and asserts the sentinel is byte-unchanged
    afterwards."""

    def test_leaked_git_dir_does_not_touch_the_sentinel(self):
        sentinel = tempfile.mkdtemp(prefix='sentinel-')
        fixture = tempfile.mkdtemp(prefix='fixture-')
        try:
            run_git(['init', '-q', '-b', 'master'], sentinel)
            write_file(sentinel, 'sentinel.txt', 'committed\n')
            run_git(['add', '--', 'sentinel.txt'], sentinel)
            run_git(['commit', '-q', '-m', 'seed'], sentinel)
            write_file(sentinel, 'sentinel.txt', 'dirty\n')
            before_head = run_git(['rev-parse', 'HEAD'], sentinel).stdout
            with open(os.path.join(sentinel, '.git', 'index'), 'rb') as fh:
                before_index = hashlib.sha256(fh.read()).hexdigest()
            with open(os.path.join(sentinel, 'sentinel.txt'), 'rb') as fh:
                before_bytes = fh.read()

            case = next(c for c in CASES if c['expect'] == 'block')
            leaked_env = dict(os.environ)
            leaked_env['GIT_DIR'] = os.path.join(sentinel, '.git')
            leaked_env['GIT_WORK_TREE'] = sentinel

            old_environ = dict(os.environ)
            os.environ.update({'GIT_DIR': leaked_env['GIT_DIR'], 'GIT_WORK_TREE': leaked_env['GIT_WORK_TREE']})
            try:
                apply_setup(fixture, case['setup'], DECLARED_SETUP_OPS)
                guard.evaluate(case['command'], fixture)
            finally:
                os.environ.clear()
                os.environ.update(old_environ)

            after_head = run_git(['rev-parse', 'HEAD'], sentinel).stdout
            with open(os.path.join(sentinel, '.git', 'index'), 'rb') as fh:
                after_index = hashlib.sha256(fh.read()).hexdigest()
            with open(os.path.join(sentinel, 'sentinel.txt'), 'rb') as fh:
                after_bytes = fh.read()
            self.assertEqual(before_head, after_head, 'the sentinel repo\'s HEAD moved -- a leaked GIT_DIR reached it')
            self.assertEqual(before_index, after_index, 'the sentinel repo\'s index checksum changed -- a leaked GIT_DIR reached it')
            self.assertEqual(before_bytes, after_bytes, 'the sentinel\'s dirty file changed -- a leaked GIT_DIR/GIT_WORK_TREE reached it')
        finally:
            subprocess.run(['rm', '-rf', sentinel])
            subprocess.run(['rm', '-rf', fixture])


class TestHookProcessContract(unittest.TestCase):
    """AC-QA-7 (timing) plus the exit-code contract, driven as REAL
    subprocesses of the guard (the actual deployed hook path), not just
    evaluate() -- proves main()'s JSON-in/exit-code-out dispatch agrees
    with evaluate()'s own verdict for the same corpus, and measures the
    real per-invocation wall time against the 57-98ms baseline measured
    2026-09-19."""

    def test_every_case_as_a_process_within_the_time_budget(self):
        durations = []
        tmp = tempfile.mkdtemp(prefix='destructive-git-cases-proc-')
        try:
            for case in CASES:
                root = tempfile.mkdtemp(dir=tmp)
                apply_setup(root, case['setup'], DECLARED_SETUP_OPS)
                payload = json.dumps({
                    'tool_name': 'Bash',
                    'tool_input': {'command': case['command']},
                    'cwd': root,
                    'hook_event_name': 'PreToolUse',
                })
                start = time.monotonic()
                result = subprocess.run(
                    [sys.executable, GUARD_PATH],
                    input=payload, capture_output=True, text=True,
                    env=clean_env(), timeout=1.0,
                )
                elapsed_ms = (time.monotonic() - start) * 1000.0
                durations.append(elapsed_ms)
                with self.subTest(command=case['command']):
                    self.assertLess(
                        elapsed_ms, 1000.0,
                        '%r took %.1fms, over the 1000ms per-invocation budget (AC-QA-7)'
                        % (case['command'], elapsed_ms))
                    self.assertIn(result.returncode, (0, 2),
                                  '%r exited %s, must be 0 or 2' % (case['command'], result.returncode))
                    expected_exit = 2 if case['expect'] == 'block' else 0
                    self.assertEqual(
                        result.returncode, expected_exit,
                        '%r (%s): process exit %s disagrees with evaluate()\'s verdict, expected %s. stderr: %s'
                        % (case['command'], case.get('note'), result.returncode, expected_exit, result.stderr))
                    if expected_exit == 2:
                        self.assertTrue(result.stderr.strip(), '%r: refusal must print a reason on stderr' % (case['command'],))
        finally:
            subprocess.run(['rm', '-rf', tmp])
        if durations:
            print('\ndestructive-git-cases timing: n=%d max=%.1fms median=%.1fms'
                  % (len(durations), max(durations), statistics.median(durations)), file=sys.stderr)


if __name__ == '__main__':
    unittest.main()
