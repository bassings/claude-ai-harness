#!/usr/bin/env python3
"""PreToolUse hook: refuse a Bash git command that would discard uncommitted
work, unless the working tree (or the named paths) turns out to be clean.

Motivation: docs/harn-opt-2-mutation-proofs.md already forbade this by name
("never `git checkout --`, which reverts to the last commit and can destroy
uncommitted work") and an agent still ran `git checkout -- <file>` on
uncommitted work three times in one session, destroying its own edits each
time. Prose did not prevent it. Standard 9 says the rule wants a mechanism.

Guarded shapes: `git checkout -- <path>`, a bare `git checkout <path>` (no
`--`, resolved as a pathspec because it does not resolve as a ref -- git's
own precedence, matched here rather than assumed), `git checkout HEAD
<path>` (leading ref, trailing paths, no `--`), `git checkout .`, `git
checkout -f`/`--force` and `git switch -f`/`--force`/`--discard-changes`
(tree-wide, like `git reset --hard`), `git checkout --pathspec-from-file=...`
and `git restore --pathspec-from-file=...` (tree-wide: the paths are not on
the command line to scope against), `git restore <path>` (unless it is
`--staged` alone, which only unstages), and `git reset --hard`. Nothing else
-- see README.md for the exact list this hook is scoped to and why it
deliberately does not intercept `git checkout -b` or a bare
`git checkout <branch>` that resolves as a ref.

Refuses ONLY when there is something to lose: a clean working tree, or named
paths with no uncommitted modification, are let through untouched. A guard
that blocks harmless commands gets disabled, and that is worse than no guard
(AGENT-HARNESS.md's exit condition makes the same point about noise).

Escape hatch: HARNESS_ALLOW_DESTRUCTIVE_GIT=1, set either as this hook
process's own environment (opts out every segment), or as a genuine
env-prefix assignment on the SAME segment as the destructive command
(`HARNESS_ALLOW_DESTRUCTIVE_GIT=1 git checkout -- file`, ordinary shell
env-prefix syntax). Deliberately NOT a substring search over the raw command
string: that would let a quoted mention, a code comment, or an assignment
scoped to an unrelated segment on the same line disarm a command it was
never meant to cover. See README.md.

Contract: PreToolUse, matcher "Bash" (see hooks/hooks.json). Per Claude
Code's documented hook contract, exit code 2 is the one exit code that
blocks a PreToolUse tool call, with stderr shown to the agent as the reason;
any other non-zero exit is silently ignored and the command proceeds -- so
this hook must exit with exactly 2 to refuse, never 1 or an uncaught
exception's implicit 1.

Normalisation layer, between the raw shell string and the matcher (the root
cause a round-2 review found: eight distinct bypasses were eight symptoms of
this one missing stage, not eight independent holes). Applied per segment,
in order:

  1. Segment on `&&`, `||`, `;`, `|`, `&` AND a bare newline -- a multi-line
     Bash call is the ordinary shape of agent tool use, and a destructive
     command on any line but the first must be caught exactly like one
     chained with `&&`.
  2. Drop shell redirection operators (`>`, `>>`, `<`, `<<`, `&>`, `&>>`,
     with an optional leading fd digit) and the token immediately after
     each -- a redirect target must never be read as a pathspec.
  3. Strip a leading run of `VAR=value` env-prefix assignments.
  4. Strip a leading run of shell keywords and grouping tokens (`if`,
     `then`, `else`, `elif`, `do`, `done`, `{`, `(`, `)`, `!`, `time`) so the
     real command head is found underneath a conditional or loop wrapper.
  5. Recognise `git` by basename (`/usr/bin/git`, not just a literal `git`
     token), and consume git's own global options between the binary and
     the subcommand (`-C <path>`, `--git-dir[=]`, `--work-tree[=]`,
     `-c <kv>`, `--no-pager`, `-p`/`--paginate`, `--exec-path[=]`) so a
     prefixed invocation still reaches the matcher. `-C <path>` also moves
     the effective directory the scope check runs against, chained across
     repeated `-C`s exactly like git itself.
  6. Expand a bundled short-flag cluster (`-fq` -> `-f`, `-q`) on the
     tokens preceding any `--` pathspec separator, never on pathspec tokens
     themselves (a file legitimately named `-abc` must not be shredded).
  7. Blank here-document BODIES (between a `<<[-]DELIM` marker and its
     closing delimiter line) before anything else runs, so a
     destructive-looking LINE inside one -- inert text to the shell, since
     nothing in a heredoc body executes -- is never read as its own segment
     (AC-PROD-6; a heredoc body mentioning a guarded command used to be
     refused although nothing executed).

A `cd <path>` segment updates the effective directory used by every later
segment in the same command, so `cd <dir> && git ...` is scoped against
`<dir>` rather than the payload `cwd` -- this closes both a bypass (the
target repo's dirt was invisible) and a false positive (an unrelated repo's
dirt caused a refusal for a command that never touched it). When the target
cannot be resolved statically (a variable, a glob, a bare `cd` with no
argument, `cd -`), later segments are simply ALLOWED rather than judged
against a directory that might be wrong: this hook no longer refuses on an
unresolvable `cd` (it used to; that traded a real but rare gap for a false
positive on every ordinary dynamic `cd`, and guessed wrong about as often as
it guessed right). specs/harn-fix-2.md's recovery mechanism
(hooks/git-snapshot.py) is what actually covers that gap now, and it does
not need to resolve the `cd` at all -- it snapshots the Bash payload's own
`cwd` unconditionally, before the command runs.

Parsing is a pragmatic shell tokenizer (shlex with punctuation_chars), not a
full shell grammar: it splits on unquoted `&&`, `||`, `;`, `|`, `&` and a
bare newline so a destructive command chained after something harmless (on
the same line or the next one) is still caught, and it never mistakes a
quoted string that merely CONTAINS destructive-looking text (e.g. `git
commit -m "git checkout -- foo"`) for a real invocation, because that text
stays inside its own token instead of becoming a second command. Shapes
shlex cannot represent (subshells, backticks, unbalanced quotes) fall
through ALLOWED: this hook only ever blocks a pattern it can positively
identify, never a command it merely failed to parse. It makes no
completeness claim -- see README.md's "Destructive git guard" section for
the measured-open bypass classes and why recovery, not detection, is the
mechanism this repo actually relies on.
"""
import json
import os
import re
import shlex
import subprocess
import sys

ESCAPE_VAR = 'HARNESS_ALLOW_DESTRUCTIVE_GIT'

CONTROL_OPERATORS = ('&&', '||', ';', '|', '&', '\n')

# '\n' added to the punctuation set (default is '();<>|&') so a bare newline
# becomes its own token instead of being swallowed as ordinary whitespace or
# glued onto an adjacent word -- see split_segments().
PUNCTUATION_CHARS = '();<>|&\n'

REDIRECT_OPERATORS = ('>', '>>', '<', '<<', '&>', '&>>')

ENV_ASSIGNMENT_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*=')

# Leading shell keywords/grouping tokens that can sit in front of the real
# command head. Not an attempt at a full shell grammar (see module
# docstring) -- just enough to find `git` underneath the common wrappers an
# agent actually emits (`if ... ; then git ...`, `for f in ...; do git ...`).
SHELL_KEYWORDS = {'if', 'then', 'else', 'elif', 'do', 'done', 'fi', '{', '(', ')', '!', 'time'}

# Git global options that can appear between the binary and the subcommand.
# Each entry: does it consume a separate following token as its value?
GIT_GLOBAL_OPTS_WITH_VALUE = ('-C', '--git-dir', '--work-tree', '-c', '--exec-path')
GIT_GLOBAL_OPTS_NO_VALUE = ('--no-pager', '-p', '--paginate')

# Same allowlist as test/helpers/git-env.js, deliberately duplicated rather
# than imported: this is a production hook, not test infrastructure, and
# must not depend on test/. GIT_DIR and friends can redirect git to a
# repository other than the one `cwd` names -- the exact class this repo
# hardened its own fixtures against (see PR #7/#8, "harden the fixtures
# against a leaked GIT_DIR"). Stripping the rest of the GIT_* namespace
# before the status check below means a leaked GIT_DIR cannot make this
# hook read, and therefore gate, the wrong repository.
GIT_ENV_ALLOWLIST = {
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
}

# A here-document body is inert TEXT to the shell that runs this command --
# nothing in it executes -- so a destructive-looking LINE inside one must
# never be treated as its own command segment (AC-PROD-6; round 3 refused
# exactly this). `split_segments()` has no concept of heredocs (it only
# knows shlex tokens and control operators), so the body is blanked out of
# the raw string BEFORE tokenising, leaving the marker and closing
# delimiter lines untouched.
HEREDOC_START_RE = re.compile(r'<<-?\s*([\'"]?)(\w+)\1')


def sanitized_git_env():
    env = dict(os.environ)
    for key in list(env):
        if key.startswith('GIT_') and key not in GIT_ENV_ALLOWLIST:
            del env[key]
    return env


def strip_heredoc_bodies(command):
    """Blank out here-document BODIES (between a `<<[-]DELIM` marker and its
    closing delimiter line) so a destructive-looking mention inside one is
    never seen as its own segment. Marker and closing-delimiter lines, and
    everything outside a heredoc, are untouched. Fails open (leaves text as
    -is) past a marker whose closing delimiter cannot be found."""
    out = []
    i, n = 0, len(command)
    while i < n:
        m = HEREDOC_START_RE.search(command, i)
        if not m:
            out.append(command[i:])
            break
        line_end = command.find('\n', m.end())
        if line_end == -1:
            out.append(command[i:])
            break
        out.append(command[i:line_end + 1])
        closing_re = re.compile(r'(?m)^[ \t]*' + re.escape(m.group(2)) + r'[ \t]*$')
        closing = closing_re.search(command, line_end + 1)
        if closing is None:
            out.append(command[line_end + 1:])
            break
        out.append(command[closing.start():closing.end()])
        i = closing.end()
    return ''.join(out)


def split_segments(command):
    """Tokenise `command`, splitting on unquoted shell control operators,
    INCLUDING a bare newline (see module docstring: a multi-line Bash call
    is the ordinary shape of agent tool use, and a destructive command on
    any line but the first must be caught exactly like one chained with
    `&&`). Returns a list of token lists, one per sub-command. Raises
    ValueError (via shlex) on unparseable input such as unbalanced quotes,
    which the caller treats as fail-open."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=PUNCTUATION_CHARS)
    lexer.whitespace_split = True
    # shlex's default `whitespace` includes '\n' and would silently consume
    # it during the whitespace-skip that runs BEFORE punctuation_chars is
    # ever consulted, so a newline never reaches the lexer as a token no
    # matter what punctuation_chars says. Removing it from `whitespace`
    # (leaving space/tab there) is what makes it surface as its own token
    # via PUNCTUATION_CHARS below, instead of being silently swallowed.
    lexer.whitespace = ' \t'
    tokens = list(lexer)
    segments = [[]]
    for tok in tokens:
        if tok in CONTROL_OPERATORS:
            segments.append([])
        else:
            segments[-1].append(tok)
    return [seg for seg in segments if seg]


def strip_redirects(tokens):
    """Drop a shell redirection operator and the token immediately after it
    (the redirect target), so `git checkout -- README.md > /dev/null` is
    scoped identically to the same command without the redirect. Handles an
    optional leading fd digit (`2> /dev/null`), which shlex tokenises as a
    separate token from the operator regardless of whether the original
    command had a space there."""
    out = []
    i = 0
    n = len(tokens)
    while i < n:
        tok = tokens[i]
        if re.fullmatch(r'\d+', tok) and i + 1 < n and tokens[i + 1] in REDIRECT_OPERATORS:
            i += 2  # fd digit + operator
            if i < n:
                i += 1  # redirect target
            continue
        if tok in REDIRECT_OPERATORS:
            i += 1  # operator
            if i < n:
                i += 1  # redirect target
            continue
        out.append(tok)
        i += 1
    return out


def strip_env_prefix(tokens):
    """Drop leading `VAR=value` assignments so tokens[0] is the command
    itself, matching ordinary shell env-prefix syntax."""
    i = 0
    while i < len(tokens) and ENV_ASSIGNMENT_RE.match(tokens[i]):
        i += 1
    return tokens[i:]


def leading_env_assignments(tokens):
    """The leading `VAR=value` tokens of `tokens`, unparsed -- the same
    leading run strip_env_prefix() consumes, returned instead of dropped, so
    the escape hatch can inspect exactly the assignments that apply to THIS
    segment's command (see escape_hatch_active_for_segment)."""
    i = 0
    out = []
    while i < len(tokens) and ENV_ASSIGNMENT_RE.match(tokens[i]):
        out.append(tokens[i])
        i += 1
    return out


def escape_hatch_active_for_segment(tokens):
    """True if HARNESS_ALLOW_DESTRUCTIVE_GIT=1 is a genuine env-prefix
    assignment on THIS segment (`HARNESS_ALLOW_DESTRUCTIVE_GIT=1 git
    checkout -- file`). Deliberately does not search the raw command text:
    a quoted mention, a code comment, or an assignment prefixed to a
    DIFFERENT segment on the same line must not disarm this one. The
    process-environment form (exported for the session) is checked once in
    evaluate(), not here, since it is not segment-scoped."""
    for assignment in leading_env_assignments(tokens):
        name, _, value = assignment.partition('=')
        if name == ESCAPE_VAR and value == '1':
            return True
    return False


def strip_shell_keywords(tokens):
    """Drop a leading run of shell keywords/grouping tokens so the real
    command head is found underneath a conditional or loop wrapper (`if
    true; then git checkout -- x; fi` segments to `['then', 'git', ...]`
    after control-operator splitting; this drops the `then`)."""
    i = 0
    while i < len(tokens) and tokens[i] in SHELL_KEYWORDS:
        i += 1
    return tokens[i:]


def is_git_binary(token):
    """True for `git`, `/usr/bin/git`, or any other path whose basename is
    exactly `git` -- an agent's own instructions in this harness prefer
    absolute paths, and the strict `tokens[0] != 'git'` check that used to
    live here made the more disciplined invocation the unguarded one."""
    return os.path.basename(token) == 'git'


def join_cwd(base, target):
    """Resolve `target` against `base`."""
    return os.path.normpath(os.path.join(base, target))


def parse_git_invocation(tokens, cwd):
    """Given a segment's tokens (already redirect-stripped, env-prefix-
    stripped and shell-keyword-stripped), return (subcmd, rest,
    effective_cwd) if `tokens[0]` is a git binary, else None.
    `effective_cwd` starts as `cwd` and is updated by any `-C <path>`
    global option encountered (chained, exactly like git itself)."""
    if not tokens or not is_git_binary(tokens[0]):
        return None
    i = 1
    n = len(tokens)
    effective_cwd = cwd
    while i < n:
        tok = tokens[i]
        if tok == '-C':
            if i + 1 >= n:
                return None  # malformed global option; nothing to guard
            effective_cwd = join_cwd(effective_cwd, tokens[i + 1])
            i += 2
            continue
        matched = False
        for opt in GIT_GLOBAL_OPTS_WITH_VALUE:
            if tok == opt:
                i += 2
                matched = True
                break
            if tok.startswith(opt + '='):
                i += 1
                matched = True
                break
        if matched:
            continue
        if tok in GIT_GLOBAL_OPTS_NO_VALUE:
            i += 1
            continue
        break
    if i >= n:
        return None
    return tokens[i], tokens[i + 1:], effective_cwd


def expand_bundled_short_flags(tokens):
    """`-fq` -> `-f`, `-q`. Applied only to tokens that are ENTIRELY a
    single dash followed by letters (so `--force` is untouched: the second
    character is `-`, not a letter). The caller is responsible for never
    applying this past a `--` pathspec separator (see normalize_rest)."""
    out = []
    for tok in tokens:
        if re.fullmatch(r'-[A-Za-z]+', tok):
            out.extend('-' + ch for ch in tok[1:])
        else:
            out.append(tok)
    return out


def normalize_rest(rest):
    """Expand bundled short flags in `rest`, WITHOUT touching anything past
    a `--` pathspec separator -- a file genuinely named `-abc` must survive
    untouched. Safe to call unconditionally: only dash-prefixed tokens
    before `--` are ever rewritten."""
    if '--' in rest:
        sep = rest.index('--')
        return expand_bundled_short_flags(rest[:sep]) + ['--'] + rest[sep + 1:]
    return expand_bundled_short_flags(rest)


def has_pathspec_from_file(rest):
    return any(t == '--pathspec-from-file' or t.startswith('--pathspec-from-file=') for t in rest)


def resolve_as_ref(cwd, arg):
    """True if `arg` resolves as a commit-ish in the repo at `cwd`, using the
    SAME cwd and sanitized_git_env() as has_uncommitted_change()'s status
    check (see module docstring on GIT_* stripping). Mirrors git's own
    checkout precedence: an argument that resolves as a ref is treated as a
    ref, even when a same-named file also exists (measured -- see
    docs/destructive-git-guard-mutation-proofs.md). On a subprocess failure
    this returns False (not a ref), the fail-open direction: it hands the
    argument to the pathspec path, where has_uncommitted_change() still only
    blocks if `git status` itself finds a real uncommitted change in scope."""
    try:
        result = subprocess.run(
            ['git', 'rev-parse', '--verify', '--quiet', '%s^{commit}' % arg],
            cwd=cwd, env=sanitized_git_env(),
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def destructive_scope(subcmd, rest, cwd):
    """Return ('paths', [paths]) or ('tree', None) if `subcmd`/`rest` (a
    git invocation already stripped of global options) is one of the
    guarded shapes, or None if it is not. `cwd` is needed to resolve an
    ambiguous checkout argument as a ref vs. a pathspec (see
    resolve_as_ref)."""
    rest = normalize_rest(rest)

    if subcmd == 'checkout':
        if has_pathspec_from_file(rest):
            # The paths are not on the command line at all, so there is
            # nothing to scope a per-path check against -- treat the whole
            # tree as at risk, same as a forced checkout.
            return ('tree', None)
        if '--' in rest:
            paths = rest[rest.index('--') + 1:]
            return ('paths', paths) if paths else None
        if rest == ['.']:
            return ('paths', ['.'])
        # `-f`/`--force` discards uncommitted changes tree-wide regardless of
        # what else is on the command line -- measured true for a bare
        # `checkout -f`, `checkout -f <branch>` and even `checkout -f -b
        # <branch>` (see mutation-proofs doc). Checked before the -b/-B/
        # --orphan carve-out below because force overrides it.
        if '-f' in rest or '--force' in rest:
            return ('tree', None)
        if '-b' in rest or '-B' in rest or '--orphan' in rest:
            return None  # branch creation, not a restore
        non_flags = [t for t in rest if not t.startswith('-')]
        if not non_flags:
            return None
        first, remainder = non_flags[0], non_flags[1:]
        if resolve_as_ref(cwd, first):
            # `<ref> <path>...`: git treats everything after a leading ref
            # as pathspecs, whether or not those path tokens also happen to
            # resolve as refs (measured: `git checkout HEAD README.md`).
            return ('paths', remainder) if remainder else None
        # No leading ref: every non-flag token is a bare pathspec, whether
        # there is one (`git checkout README.md`) or several
        # (`git checkout a.txt b.txt`, measured).
        return ('paths', non_flags)

    if subcmd == 'switch':
        if '-f' in rest or '--force' in rest or '--discard-changes' in rest:
            return ('tree', None)
        return None  # a plain switch git itself refuses if it would overwrite

    if subcmd == 'restore':
        if has_pathspec_from_file(rest):
            return ('tree', None)
        staged = '--staged' in rest or '-S' in rest
        worktree = '--worktree' in rest or '-W' in rest
        if staged and not worktree:
            return None  # unstages only; the working tree is never touched
        if '--' in rest:
            paths = rest[rest.index('--') + 1:]
        else:
            paths = [t for t in rest if not t.startswith('-')]
        return ('paths', paths) if paths else None

    if subcmd == 'reset':
        if '--hard' in rest:
            return ('tree', None)
        return None  # soft/mixed reset never touches the working tree

    return None


def has_uncommitted_change(cwd, scope):
    """True if `git status --porcelain`, scoped per `scope`, shows a TRACKED
    change (staged or unstaged). A purely untracked ('??') entry is not
    counted: none of the four guarded commands can lose an untracked file.

    When `scope` names paths and `git status` REJECTS one of them (e.g. a
    redirect target that survived segmentation and now names a path outside
    the repository), this does not conclude "clean": it retries scoped to
    the whole tree instead, so a pathspec git refuses can never become a
    licence to run the destructive command. The fail-open branch below (a
    non-zero exit from the TREE-WIDE retry) is reserved for the case it was
    actually designed for: `cwd` itself is not a usable git repository."""
    kind, arg = scope
    cmd = ['git', 'status', '--porcelain']
    if kind == 'paths':
        cmd += ['--'] + arg
    try:
        result = subprocess.run(
            cmd, cwd=cwd, env=sanitized_git_env(),
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False  # cannot confirm risk; fail open, see module docstring
    if result.returncode != 0:
        if kind == 'paths':
            return has_uncommitted_change(cwd, ('tree', None))
        return False  # cwd itself is not a usable repo; fail open
    for line in result.stdout.splitlines():
        if not line.startswith('??'):
            return True
    return False


REFUSAL = (
    "destructive-git-guard: refused `{cmd}` -- it would discard uncommitted "
    "work (`git status` shows a tracked, uncommitted change in scope). Safe "
    "alternatives: copy the file to a scratch path first, or `git stash` "
    "before retrying. If this revert is deliberate, opt in explicitly: "
    "re-run with {var}=1 set inline (`{var}=1 {cmd}`) or exported for the "
    "session. If work is already lost another way, hooks/git-snapshot.py "
    "may have a recoverable copy -- list them with: git for-each-ref "
    "--format='%(refname) %(creatordate:iso-strict) %(contents:subject)' "
    "refs/harness-snapshots/"
)


def classify_cd(tokens):
    """If `tokens` (already redirect/env/keyword-stripped) is a `cd`
    invocation, return ('static', path) when the target is a literal
    argument safe to resolve, or ('dynamic', None) when it is not (missing
    argument, `cd -`, or a token containing shell expansion this tokenizer
    does not evaluate: `$`, backticks). Returns None if this is not a `cd`
    segment at all."""
    if not tokens or tokens[0] != 'cd':
        return None
    args = tokens[1:]
    if len(args) != 1:
        return ('dynamic', None)  # bare `cd` (home dir) or extra args: not modelled
    target = args[0]
    if target == '-' or '$' in target or '`' in target:
        return ('dynamic', None)
    return ('static', target)


def evaluate(command, cwd):
    """Return a refusal message, or None to allow `command`."""
    if os.environ.get(ESCAPE_VAR) == '1':
        return None
    try:
        segments = split_segments(strip_heredoc_bodies(command))
    except ValueError:
        return None  # unparseable; fail open, see module docstring

    effective_cwd = cwd
    cwd_known = True
    for raw_tokens in segments:
        tokens = strip_redirects(raw_tokens)

        cd = classify_cd(strip_shell_keywords(strip_env_prefix(tokens)))
        if cd is not None:
            kind, target = cd
            if kind == 'dynamic':
                # Cannot resolve statically -- ALLOW rather than guess (see
                # README.md "Destructive git guard": this used to refuse,
                # which guessed wrong as often as right; the snapshot hook
                # is what actually covers this gap now, AC-SIMP-10).
                cwd_known = False
            else:
                effective_cwd = join_cwd(effective_cwd, target)
            continue

        if not cwd_known:
            continue

        if escape_hatch_active_for_segment(tokens):
            continue

        head = strip_shell_keywords(strip_env_prefix(tokens))
        parsed = parse_git_invocation(head, effective_cwd)
        if parsed is None:
            continue
        subcmd, rest, segment_cwd = parsed

        scope = destructive_scope(subcmd, rest, segment_cwd)
        if scope is None:
            continue

        display_cmd = ' '.join(head)
        if has_uncommitted_change(segment_cwd, scope):
            return REFUSAL.format(cmd=display_cmd, var=ESCAPE_VAR)
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unreadable payload; fail open
    if payload.get('tool_name') != 'Bash':
        sys.exit(0)
    tool_input = payload.get('tool_input') or {}
    command = tool_input.get('command')
    if not command or not command.strip():
        sys.exit(0)
    cwd = payload.get('cwd') or os.getcwd()
    reason = evaluate(command, cwd)
    if reason:
        print(reason, file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


if __name__ == '__main__':
    main()
