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
import re
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


def resolve_inside(root, rel_path):
    """`rel_path` joined onto `root`, refusing anything that would land
    outside it. Belt and braces beside validate_setup_op()'s allowlist: the
    allowlist is a claim about the spelling, this is a check on the answer,
    and it is the one that cannot be reasoned wrong. os.path.join DISCARDS
    `root` entirely when the second argument is absolute, which is how an
    absolute `path` in a corpus case wrote outside the fixture (K1 review
    round 5, H4)."""
    root_real = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root_real, rel_path))
    if full != root_real and not full.startswith(root_real + os.sep):
        raise ValueError('setup path %r resolves to %r, outside the fixture directory %r'
                          % (rel_path, full, root_real))
    return full


def write_file(root, rel_path, content):
    full = resolve_inside(root, rel_path)
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
    os.makedirs(resolve_inside(root, op['path']), exist_ok=True)


def op_nested_repo(root, op):
    nested = resolve_inside(root, op['path'])
    os.makedirs(nested, exist_ok=True)
    run_git(['init', '-q', '-b', 'master'], nested)
    write_file(nested, 'inner.txt', 'committed\n')
    run_git(['add', '--', 'inner.txt'], nested)
    run_git(['commit', '-q', '-m', 'seed: inner.txt'], nested)
    # `dirty` defaults to true, which is what every case predating the
    # cwd-scoping ones wants. A CLEAN nested repo is what lets a case tell
    # "the guard measured the outer repo" apart from "the guard measured the
    # nested one" in BOTH directions, rather than only one.
    if op.get('dirty', True):
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


# --- The closed vocabulary's ARGUMENTS (AC-SEC-5, K1 review round 5, H4) ---
#
# Bounding the op NAMES above bounds nothing on its own: the arguments were
# handed straight to `git` and to file writes, so editing this repo's JSON
# corpus alone reached arbitrary command execution on the machine running
# the tests, and wrote files outside the fixture. codex-ai-harness vendors
# this runner, so it shipped there too. Everything below is an allowlist: a
# spelling that is not positively recognised is refused, never sanitised and
# never passed on.

MAX_SETUP_ARG_CHARS = 256
MAX_SETUP_CONTENT_CHARS = 65536

# A path inside the fixture. No absolute paths, no `..`, no `.`, no leading
# dash (which git would read as an option), and no character outside this
# set -- which excludes every shell metacharacter, whitespace, quote,
# backslash, NUL and `~`, none of which any real case needs.
FIXTURE_PATH_RE = re.compile(r'^[A-Za-z0-9._][A-Za-z0-9._/-]*$')

# A branch name. Same shape, and the leading-character rule is what stops
# `--help` or `-D` being passed where a name belongs.
GIT_NAME_RE = re.compile(r'^[A-Za-z0-9._][A-Za-z0-9._/-]*$')

# git config keys a case may set, each with the exact values it may be set
# to. An allowlist rather than a denylist BY DESIGN: git itself executes the
# value of core.fsmonitor, core.sshCommand, core.pager, core.editor,
# core.hooksPath, sequence.editor, diff.external, credential.helper,
# uploadpack.packObjectsHook and gpg.program; include.path pulls in another
# config file; and that list grows with every git release. Naming the
# handful of keys the corpus actually needs is the only form of this rule
# that stays correct without being maintained.
CONFIG_KEY_ALLOWLIST = {
    'clean.requireforce': ('true', 'false'),
}


def _reject(message):
    raise ValueError('rejected setup op: %s -- the corpus is DATA, and a case may not '
                      'reach outside its own fixture or make git run a command '
                      '(hooks/test_destructive_git_cases.py, AC-SEC-5)' % message)


def _check_str(value, label, limit=MAX_SETUP_ARG_CHARS):
    if not isinstance(value, str):
        _reject('%s must be a string, got %s' % (label, type(value).__name__))
    if not value or len(value) > limit:
        _reject('%s must be 1 to %d characters, got %d' % (label, limit, len(value)))
    return value


def _check_fixture_path(value, label='path'):
    _check_str(value, label)
    if not FIXTURE_PATH_RE.match(value):
        _reject('%s %r is not a plain relative path of [A-Za-z0-9._/-] starting with an '
                'alphanumeric, dot or underscore' % (label, value))
    if any(part in ('', '.', '..') for part in value.split('/')):
        _reject('%s %r contains an empty, `.` or `..` segment' % (label, value))


def _check_git_name(value, label):
    _check_str(value, label)
    if not GIT_NAME_RE.match(value):
        _reject('%s %r is not a plain git name of [A-Za-z0-9._/-] starting with an '
                'alphanumeric, dot or underscore (a leading dash would be read by git '
                'as an option)' % (label, value))


def _check_content(value, label='content'):
    if not isinstance(value, str):
        _reject('%s must be a string, got %s' % (label, type(value).__name__))
    if len(value) > MAX_SETUP_CONTENT_CHARS:
        _reject('%s is %d characters, over the %d cap'
                % (label, len(value), MAX_SETUP_CONTENT_CHARS))


def _check_patterns(value, label='patterns'):
    # .gitignore lines are file CONTENT, never an argv entry, so the
    # characters a gitignore pattern legitimately uses (`*`, `!`, `/`) are
    # fine here. The line separator is not, since they are joined by newline.
    if not isinstance(value, list) or not value:
        _reject('%s must be a non-empty list' % label)
    for entry in value:
        _check_str(entry, '%s entry' % label)
        if '\n' in entry or '\r' in entry or '\0' in entry:
            _reject('%s entry %r contains a line separator or NUL' % (label, entry))


def _check_bool(value, label):
    if not isinstance(value, bool):
        _reject('%s must be true or false, got %r' % (label, value))


def _check_config(op):
    key = _check_str(op['key'], 'config key')
    value = _check_str(op['value'], 'config value')
    allowed = CONFIG_KEY_ALLOWLIST.get(key.strip().lower())
    if allowed is None:
        _reject('config key %r is not one of the keys a case may set (%s)'
                % (key, ', '.join(sorted(CONFIG_KEY_ALLOWLIST))))
    if value not in allowed:
        _reject('config value %r is not one of the values %r may be set to (%s)'
                % (value, key, ', '.join(allowed)))


# Per op: (required argument names, optional argument names, validator). An
# op present in SETUP_OPS but absent here would be unvalidated, which
# TestSetupArgumentsAreBoundedNotJustOpNames asserts cannot happen.
SETUP_OP_SCHEMA = {
    'init': ((), ('branch',),
             lambda op: 'branch' in op and _check_git_name(op['branch'], 'branch')),
    'commit': (('path', 'content'), (),
               lambda op: (_check_fixture_path(op['path']), _check_content(op['content']))),
    'write': (('path', 'content'), (),
              lambda op: (_check_fixture_path(op['path']), _check_content(op['content']))),
    'gitignore': (('patterns',), (), lambda op: _check_patterns(op['patterns'])),
    'mkdir': (('path',), (), lambda op: _check_fixture_path(op['path'])),
    'nested_repo': (('path',), ('dirty',),
                    lambda op: (_check_fixture_path(op['path']),
                                'dirty' in op and _check_bool(op['dirty'], 'dirty'))),
    'stash_push': ((), (), lambda op: None),
    'branch': (('name',), (), lambda op: _check_git_name(op['name'], 'branch name')),
    'config': (('key', 'value'), (), _check_config),
}


def validate_setup_op(op):
    """Raise ValueError unless `op` is a well-formed instance of its declared
    operation: a known name, exactly the argument names that operation takes,
    and every argument inside its own allowlist."""
    if not isinstance(op, dict):
        _reject('a setup step must be an object, got %s' % (type(op).__name__,))
    name = op.get('op')
    schema = SETUP_OP_SCHEMA.get(name) if isinstance(name, str) else None
    if schema is None:
        _reject('unknown op %r' % (name,))
    required, optional, check = schema
    given = set(op) - {'op'}
    missing = set(required) - given
    if missing:
        _reject('op %r is missing %s' % (name, ', '.join(sorted(missing))))
    unknown = given - set(required) - set(optional)
    if unknown:
        _reject('op %r does not take %s' % (name, ', '.join(sorted(unknown))))
    check(op)


def apply_setup(root, setup, declared_ops):
    for op in setup:
        name = op.get('op') if isinstance(op, dict) else None
        if name not in declared_ops:
            raise ValueError('unknown setup op %r -- not in the closed vocabulary declared '
                              'by destructive-git-cases.json\'s own setup_ops key' % (name,))
        validate_setup_op(op)
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


class TestSetupArgumentsAreBoundedNotJustOpNames(unittest.TestCase):
    """AC-SEC-5, the half the op-name check never covered (K1 review round 5,
    H4). Bounding the op NAMES bounds nothing if their ARGUMENTS go straight
    to `git` or to a file write: editing the JSON corpus alone reached
    arbitrary command execution on the machine running the tests, and wrote
    files outside the fixture. Measured against the unvalidated runner:

      * {"op": "config", "key": "core.fsmonitor", "value": "touch <path>"}
        applied without complaint, and the NEXT git call in that fixture ran
        the command, because git runs core.fsmonitor itself. core.sshCommand,
        core.pager, core.hooksPath, include.path and others do the same.
      * {"op": "write", "path": "<absolute path>"} wrote outside the
        fixture: os.path.join discards `root` when the second argument is
        absolute.
      * {"op": "write", "path": "../<name>"} wrote into the fixture's parent.
      * {"op": "branch", "name": "--help"} passed a git OPTION where a branch
        name belongs.

    codex-ai-harness vendors this runner, so each of those shipped there
    too. Every hostile setup below must raise loudly and leave no trace."""

    def setUp(self):
        self._root = tempfile.mkdtemp(prefix='hostile-fixture-')
        run_git(['init', '-q', '-b', 'master'], self._root)
        self._sentinels = []

    def tearDown(self):
        subprocess.run(['rm', '-rf', self._root])
        for path in self._sentinels:
            if os.path.exists(path):
                os.remove(path)

    def _sentinel(self, name):
        path = os.path.join(tempfile.gettempdir(), 'destructive-git-cases-%s' % name)
        if os.path.exists(path):
            os.remove(path)
        self._sentinels.append(path)
        return path

    def _refuses(self, setup, sentinel=None, also_run_git=False):
        with self.assertRaises(ValueError):
            apply_setup(self._root, setup, DECLARED_SETUP_OPS)
        if also_run_git:
            # Anything the setup managed to plant in the repo's config would
            # fire on the next git call, so make one before checking.
            run_git(['status', '--porcelain'], self._root)
        if sentinel is not None:
            self.assertFalse(
                os.path.exists(sentinel),
                'the hostile setup left %s behind -- it must never take effect' % sentinel)

    def test_a_config_key_that_makes_git_run_a_command_is_refused(self):
        sentinel = self._sentinel('fsmonitor-pwn')
        self._refuses(
            [{'op': 'config', 'key': 'core.fsmonitor', 'value': 'touch %s' % sentinel}],
            sentinel=sentinel, also_run_git=True)

    def test_other_command_running_config_keys_are_refused_too(self):
        for key in ('core.sshCommand', 'core.pager', 'core.editor', 'core.hooksPath',
                    'include.path', 'diff.external', 'sequence.editor', 'credential.helper',
                    'uploadpack.packObjectsHook', 'gpg.program'):
            with self.subTest(key=key):
                sentinel = self._sentinel('config-pwn')
                self._refuses([{'op': 'config', 'key': key, 'value': 'touch %s' % sentinel}],
                              sentinel=sentinel, also_run_git=True)

    def test_a_config_value_outside_the_allowlist_is_refused(self):
        self._refuses([{'op': 'config', 'key': 'clean.requireForce', 'value': 'touch /tmp/x'}])

    def test_an_absolute_write_path_is_refused(self):
        sentinel = self._sentinel('absolute-write')
        self._refuses([{'op': 'write', 'path': sentinel, 'content': 'outside\n'}],
                      sentinel=sentinel)

    def test_a_dot_dot_write_path_is_refused(self):
        sibling = os.path.join(os.path.dirname(self._root), 'destructive-git-cases-escaped')
        if os.path.exists(sibling):
            os.remove(sibling)
        self._sentinels.append(sibling)
        self._refuses([{'op': 'write', 'path': '../destructive-git-cases-escaped',
                        'content': 'escaped\n'}], sentinel=sibling)

    def test_escaping_paths_are_refused_for_every_op_that_takes_one(self):
        for op_name, extra in (('write', {'content': 'x\n'}), ('commit', {'content': 'x\n'}),
                               ('mkdir', {}), ('nested_repo', {})):
            for path in ('/etc/passwd', '../escaped', 'a/../../escaped', './../escaped',
                         'a/b/../../../escaped'):
                with self.subTest(op=op_name, path=path):
                    op = {'op': op_name, 'path': path}
                    op.update(extra)
                    with self.assertRaises(ValueError):
                        apply_setup(self._root, [op], DECLARED_SETUP_OPS)

    def test_a_name_that_is_a_git_option_is_refused(self):
        for name in ('--help', '-D', '--edit-description'):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    apply_setup(self._root, [{'op': 'branch', 'name': name}], DECLARED_SETUP_OPS)
        with self.assertRaises(ValueError):
            apply_setup(self._root, [{'op': 'init', 'branch': '--bare'}], DECLARED_SETUP_OPS)

    def test_an_argument_of_the_wrong_type_is_refused(self):
        for op in ({'op': 'write', 'path': 5, 'content': 'x'},
                   {'op': 'write', 'path': 'a.txt', 'content': None},
                   {'op': 'gitignore', 'patterns': '.env'},
                   {'op': 'gitignore', 'patterns': ['.env', 7]},
                   {'op': 'nested_repo', 'path': 'n', 'dirty': 'false'}):
            with self.subTest(op=op):
                with self.assertRaises(ValueError):
                    apply_setup(self._root, [op], DECLARED_SETUP_OPS)

    def test_an_unknown_or_missing_argument_is_refused(self):
        for op in ({'op': 'write', 'path': 'a.txt'},
                   {'op': 'write', 'content': 'x'},
                   {'op': 'branch'},
                   {'op': 'config', 'key': 'clean.requireForce'},
                   {'op': 'write', 'path': 'a.txt', 'content': 'x', 'mode': '777'},
                   {'op': 'stash_push', 'path': '../escaped'}):
            with self.subTest(op=op):
                with self.assertRaises(ValueError):
                    apply_setup(self._root, [op], DECLARED_SETUP_OPS)

    def test_resolve_inside_contains_a_path_even_if_the_allowlist_were_wrong(self):
        # resolve_inside() is the SECOND layer, and apply_setup() never
        # reaches it with a hostile path because the allowlist rejects those
        # first -- so mutating it away leaves every test above green, and it
        # has to be exercised directly or it is a guard nobody has watched
        # fail. The allowlist is a claim about the spelling; this is a check
        # on the answer, and it is what would still hold if the regex were
        # ever loosened.
        outside = os.path.join(tempfile.gettempdir(), 'destructive-git-cases-never-written')
        self._sentinels.append(outside)
        for path in (outside, '../escaped', 'a/../../escaped', '/etc/passwd',
                     'ok/../../../escaped'):
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    resolve_inside(self._root, path)
        # ...while an ordinary fixture-relative path still resolves.
        self.assertEqual(resolve_inside(self._root, 'a/b.txt'),
                          os.path.join(os.path.realpath(self._root), 'a', 'b.txt'))
        self.assertFalse(os.path.exists(outside))

    def test_the_argument_schema_covers_exactly_the_declared_vocabulary(self):
        # The drift guard the op-name check already has, one level down: an op
        # added to SETUP_OPS with no argument schema would otherwise be
        # unvalidated, and nothing would say so.
        self.assertEqual(set(SETUP_OP_SCHEMA.keys()), set(SETUP_OPS.keys()))

    def test_every_real_corpus_case_passes_the_same_validation(self):
        # The validation is only worth having if the corpus lives inside it: a
        # rule the real cases cannot satisfy is a rule that gets loosened.
        for index, case in enumerate(CASES):
            with self.subTest(index=index, command=case['command']):
                for op in case['setup']:
                    validate_setup_op(op)


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


class TestLeakedGitDirCannotMakeTheGuardReadAnotherRepo(unittest.TestCase):
    """AC-DATA-15, the half the sentinel test above cannot reach. That one
    proves a leaked GIT_DIR does not WRITE to another repository. This one
    proves it does not let the guard READ one: point GIT_DIR/GIT_WORK_TREE
    at a second, CLEAN repo, judge a destructive command against a DIRTY
    fixture, and require the refusal.

    Ported from test/destructive-git-guard.test.js deliberately (K1 review
    round 4, M6). Mutating sanitized_git_env() to return the real
    environment left all 87 Python tests green and was caught only by that
    JS file, which codex-ai-harness does not vendor: the vendored runner
    would have shipped with no test at all for the guard's own GIT_*
    stripping, while its docstring claimed the protection."""

    def setUp(self):
        self._dirty = tempfile.mkdtemp(prefix='dirty-fixture-')
        run_git(['init', '-q', '-b', 'master'], self._dirty)
        write_file(self._dirty, 'tracked.txt', 'committed\n')
        run_git(['add', '--', 'tracked.txt'], self._dirty)
        run_git(['commit', '-q', '-m', 'seed'], self._dirty)
        write_file(self._dirty, 'tracked.txt', 'dirty\n')

        self._clean = tempfile.mkdtemp(prefix='clean-decoy-')
        run_git(['init', '-q', '-b', 'master'], self._clean)
        write_file(self._clean, 'tracked.txt', 'committed\n')
        run_git(['add', '--', 'tracked.txt'], self._clean)
        run_git(['commit', '-q', '-m', 'seed'], self._clean)

        self._leaked = {
            'GIT_DIR': os.path.join(self._clean, '.git'),
            'GIT_WORK_TREE': self._clean,
        }

    def tearDown(self):
        subprocess.run(['rm', '-rf', self._dirty])
        subprocess.run(['rm', '-rf', self._clean])

    def test_evaluate_still_refuses_with_a_leaked_git_dir_in_the_environment(self):
        saved = dict(os.environ)
        os.environ.update(self._leaked)
        try:
            reason = guard.evaluate('git checkout -- tracked.txt', self._dirty)
        finally:
            os.environ.clear()
            os.environ.update(saved)
        self.assertIsNotNone(
            reason,
            'a leaked GIT_DIR/GIT_WORK_TREE pointing at a clean repo made the guard read '
            'THAT repo instead of the dirty cwd it was asked about, and allow a command '
            'that discards uncommitted work -- the GIT_* namespace must be stripped before '
            'the measuring call (sanitized_git_env)')

    def test_the_deployed_hook_process_still_refuses_with_a_leaked_git_dir(self):
        # The same thing through main()'s real JSON-in/exit-code-out path,
        # with the variables in the process environment exactly as a leaked
        # one would arrive -- NOT via clean_env(), which strips them and
        # would stop this ever reaching the guard's own stripping.
        payload = json.dumps({
            'tool_name': 'Bash',
            'tool_input': {'command': 'git checkout -- tracked.txt'},
            'cwd': self._dirty,
            'hook_event_name': 'PreToolUse',
        })
        env = dict(os.environ)
        env.update(self._leaked)
        result = subprocess.run(
            [sys.executable, GUARD_PATH],
            input=payload, capture_output=True, text=True, env=env, timeout=10,
        )
        self.assertEqual(
            result.returncode, 2,
            'the deployed hook exited %s with a leaked GIT_DIR/GIT_WORK_TREE pointing at a '
            'clean repo; it must strip GIT_* and refuse on the dirty cwd. stderr: %s'
            % (result.returncode, result.stderr))


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
