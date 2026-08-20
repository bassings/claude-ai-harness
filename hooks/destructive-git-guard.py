#!/usr/bin/env python3
"""PreToolUse hook: refuse a Bash git command that would discard uncommitted
work, unless the working tree (or the named paths) turns out to be clean.

Motivation: docs/harn-opt-2-mutation-proofs.md already forbade this by name
("never `git checkout --`, which reverts to the last commit and can destroy
uncommitted work") and an agent still ran `git checkout -- <file>` on
uncommitted work three times in one session, destroying its own edits each
time. Prose did not prevent it. Standard 9 says the rule wants a mechanism.

Guarded shapes: `git checkout -- <path>`, `git checkout .`, `git restore
<path>` (unless it is `--staged` alone, which only unstages), and `git reset
--hard`. Nothing else -- see README.md for the exact list this hook is
scoped to and why it deliberately does not intercept `git checkout -b` or a
bare `git checkout <branch>`.

Refuses ONLY when there is something to lose: a clean working tree, or named
paths with no uncommitted modification, are let through untouched. A guard
that blocks harmless commands gets disabled, and that is worse than no guard
(AGENT-HARNESS.md's exit condition makes the same point about noise).

Escape hatch: HARNESS_ALLOW_DESTRUCTIVE_GIT=1, set either as this hook
process's own environment, or inline in the command using ordinary shell
env-prefix syntax (`HARNESS_ALLOW_DESTRUCTIVE_GIT=1 git checkout -- file`),
for a revert that is genuinely deliberate. See README.md.

Contract: PreToolUse, matcher "Bash" (see hooks/hooks.json). Per Claude
Code's documented hook contract, exit code 2 is the one exit code that
blocks a PreToolUse tool call, with stderr shown to the agent as the reason;
any other non-zero exit is silently ignored and the command proceeds -- so
this hook must exit with exactly 2 to refuse, never 1 or an uncaught
exception's implicit 1.

Parsing is a pragmatic shell tokenizer (shlex with punctuation_chars), not a
full shell grammar: it splits on unquoted &&, ||, ; and | so a destructive
command chained after something harmless is still caught, and it never
mistakes a quoted string that merely CONTAINS destructive-looking text (e.g.
`git commit -m "git checkout -- foo"`) for a real invocation, because that
text stays inside its own token instead of becoming a second command. Shapes
shlex cannot represent (subshells, backticks, here-docs, unbalanced quotes)
fall through ALLOWED: this hook only ever blocks a pattern it can positively
identify, never a command it merely failed to parse.
"""
import json
import os
import re
import shlex
import subprocess
import sys

ESCAPE_VAR = 'HARNESS_ALLOW_DESTRUCTIVE_GIT'
ESCAPE_INLINE_RE = re.compile(r'(?<![\w])' + re.escape(ESCAPE_VAR) + r'=1(?![\w])')

CONTROL_OPERATORS = ('&&', '||', ';', '|', '&')

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


def sanitized_git_env():
    env = dict(os.environ)
    for key in list(env):
        if key.startswith('GIT_') and key not in GIT_ENV_ALLOWLIST:
            del env[key]
    return env


def escape_hatch_active(command):
    if os.environ.get(ESCAPE_VAR) == '1':
        return True
    return bool(ESCAPE_INLINE_RE.search(command))


def split_segments(command):
    """Tokenise `command`, splitting on unquoted shell control operators.
    Returns a list of token lists, one per sub-command. Raises ValueError
    (via shlex) on unparseable input such as unbalanced quotes, which the
    caller treats as fail-open."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    tokens = list(lexer)
    segments = [[]]
    for tok in tokens:
        if tok in CONTROL_OPERATORS:
            segments.append([])
        else:
            segments[-1].append(tok)
    return [seg for seg in segments if seg]


def strip_env_prefix(tokens):
    """Drop leading `VAR=value` assignments so tokens[0] is the command
    itself, matching ordinary shell env-prefix syntax."""
    i = 0
    while i < len(tokens) and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', tokens[i]):
        i += 1
    return tokens[i:]


def destructive_scope(tokens):
    """Return ('paths', [paths]) or ('tree', None) if `tokens` (one already
    env-stripped sub-command) is one of the four guarded shapes, or None if
    it is not."""
    if not tokens or tokens[0] != 'git' or len(tokens) < 2:
        return None
    subcmd, rest = tokens[1], tokens[2:]

    if subcmd == 'checkout':
        if '--' in rest:
            paths = rest[rest.index('--') + 1:]
            return ('paths', paths) if paths else None
        if rest == ['.']:
            return ('paths', ['.'])
        return None  # e.g. `-b <branch>` or a bare `<branch>`: not a restore

    if subcmd == 'restore':
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
    counted: none of the four guarded commands can lose an untracked file."""
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
        return False
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
    "session."
)


def evaluate(command, cwd):
    """Return a refusal message, or None to allow `command`."""
    if escape_hatch_active(command):
        return None
    try:
        segments = split_segments(command)
    except ValueError:
        return None  # unparseable; fail open, see module docstring
    for tokens in segments:
        scope = destructive_scope(strip_env_prefix(tokens))
        if scope is None:
            continue
        if has_uncommitted_change(cwd, scope):
            return REFUSAL.format(cmd=' '.join(tokens), var=ESCAPE_VAR)
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
