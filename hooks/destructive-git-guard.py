#!/usr/bin/env python3
"""PreToolUse hook: refuse a Bash git command that would discard uncommitted
work, unless the working tree (or the named paths) turns out to be clean.

Motivation: docs/harn-opt-2-mutation-proofs.md already forbade this by name
("never `git checkout --`, which reverts to the last commit and can destroy
uncommitted work") and an agent still ran `git checkout -- <file>` on
uncommitted work three times in one session, destroying its own edits each
time. Prose did not prevent it. Standard 9 says the rule wants a mechanism.

**This is an accident guard, not a security boundary against an adversary**
(AC-ARCH-6). It exists to stop an agent destroying its own uncommitted work
by running a command whose danger it did not notice -- the same class of
mistake a careful human operator makes under time pressure. It is not a
sandbox: an adversarial payload with a reason to defeat detection has many
ways to (see "Measured-open bypass classes" below), and the escape hatch
itself (HARNESS_ALLOW_DESTRUCTIVE_GIT=1) is deliberately easy to set
inline -- it exists to let a genuine, deliberate revert through, not to
resist someone trying to get past it.

Guarded shapes: `git checkout -- <path>`, a bare `git checkout <path>` (no
`--`, resolved as a pathspec because it does not resolve as a ref -- git's
own precedence, matched here rather than assumed), `git checkout HEAD
<path>` (leading ref, trailing paths, no `--`), `git checkout .`, `git
checkout -f`/`--force` and `git switch -f`/`--force`/`--discard-changes`
(tree-wide, like `git reset --hard`), `git checkout --pathspec-from-file=...`
and `git restore --pathspec-from-file=...` (tree-wide: the paths are not on
the command line to scope against), `git restore <path>` (unless it is
`--staged` alone, which only unstages), `git reset --hard`, non-dry-run
`git clean` when a real dry run of the same flags/pathspecs shows something
would actually be removed, and `git stash drop`/`git stash clear` when the
stash is non-empty (including a stash an earlier segment in the SAME
command would create). Nothing else -- see README.md for the exact list
this hook is scoped to and why it deliberately does not intercept
`git checkout -b` or a bare `git checkout <branch>` that resolves as a ref.

Refuses ONLY when there is something to lose: a clean working tree, or named
paths with no uncommitted modification, are let through untouched. A guard
that blocks harmless commands gets disabled, and that is worse than no guard
(AGENT-HARNESS.md's exit condition makes the same point about noise).

Fail direction differs by rule (AC-DATA-3, AC-OPS-12, settled in
specs/PLAN-harness-parity.md's "Decisions this section settles"):
`checkout`/`restore`/`reset` keep the ORIGINAL fail-OPEN posture -- when the
measuring `git status` call cannot run (cwd is not a repository, the call
fails or times out), the command is ALLOWED, because a git-tracked snapshot
(hooks/git-snapshot.py) already covers tracked work. `git clean` and
`git stash drop`/`clear` fail CLOSED on the same three conditions (cwd
cannot be resolved, the measuring call fails, or it times out), because
neither untracked/ignored files nor a stash entry has any snapshot anywhere
-- an unverifiable clean or stash-drop is refused, not guessed at. A
command over MAX_COMMAND_LENGTH_CHARS that contains the substring `git`
fails CLOSED regardless of which rule would otherwise have applied, and
regardless of whether it is actually destructive; one with NO `git`
substring anywhere is allowed without being parsed at all (K1 review round
3 -- see item 0 of the normalisation layer below).

Escape hatch: HARNESS_ALLOW_DESTRUCTIVE_GIT=1, set either as this hook
process's own environment (opts out every segment), or as a genuine
env-prefix assignment on the SAME segment as the destructive command
(`HARNESS_ALLOW_DESTRUCTIVE_GIT=1 git checkout -- file`, ordinary shell
env-prefix syntax). Deliberately NOT a substring search over the raw command
string: that would let a quoted mention, a code comment, or an assignment
scoped to an unrelated segment on the same line disarm a command it was
never meant to cover. Scoped to the segment it prefixes even underneath a
`bash -c` wrapper: the hatch set on the OUTER segment that invokes `bash -c`
does not disarm the command inside the wrapped script, and one set INSIDE
the wrapped script does not leak back out (AC-SEC-3). See README.md.

Contract: PreToolUse, matcher "Bash" (see hooks/hooks.json). Per Claude
Code's documented hook contract, exit code 2 is the one exit code that
blocks a PreToolUse tool call, with stderr shown to the agent as the reason;
any other non-zero exit is silently ignored and the command proceeds -- so
this hook must exit with exactly 2 to refuse, never 1 or an uncaught
exception's implicit 1. main() wraps the evaluate() call itself in a broad
except, on top of evaluate()'s own internal fail-open handling, so that
whatever pathological input reaches this hook, the process contract stays
exit 0 or 2 and stderr never carries a Python traceback (AC-SEC-4).

Normalisation layer, between the raw shell string and the matcher (the root
cause a round-2 review found: eight distinct bypasses were eight symptoms of
this one missing stage, not eight independent holes). Applied per segment,
in order:

  0. A command (or a `bash -c` body, or a `$(...)`/backtick substitution --
     this check runs at every recursion level) over MAX_COMMAND_LENGTH_CHARS
     is handled BEFORE any of the stages below ever run. CPython's shlex
     tokenises one character at a time, so a single very long token scales
     far worse than linearly: a 1 MiB command measured ~8s in
     split_segments() alone on this machine, which exceeded a 10s CI test
     budget under ordinary contention (K1 review round 2). If the raw text
     contains the substring `git` anywhere (a cheap linear scan, including
     inside a heredoc body or a quoted string), it is REFUSED UNSEEN --
     deliberately NOT the same "unparseable -> fail open" rule item 9 below
     documents for a shape shlex cannot tokenise at all: an over-cap command
     COULD still be parsed, just not within a safe wall-clock budget, and
     skipping the parse to answer "allowed" would let a real destructive git
     call hidden in the padding straight through. If the raw text contains
     NO `git` substring at all, it is ALLOWED without being parsed (K1
     review round 3: every rule this guard can ever fire needs a real git
     invocation, which needs the letters `git` somewhere in the command).
     See REFUSAL_OVERSIZE.
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
     repeated `-C`s exactly like git itself. `-c <key>=<value>` is also
     captured (not just skipped): `clean.requireforce` is the one key this
     guard ever consults, to tell whether an unforced `git clean` would
     actually run (see classify_clean()).
  6. Expand a bundled short-flag cluster (`-fq` -> `-f`, `-q`) on the
     tokens preceding any `--` pathspec separator, never on pathspec tokens
     themselves (a file legitimately named `-abc` must not be shredded).
  7. Blank here-document BODIES (between a `<<[-]DELIM` marker and its
     closing delimiter line) before anything else runs, so a
     destructive-looking LINE inside one -- inert text to the shell, since
     nothing in a heredoc body executes -- is never read as its own segment
     (AC-PROD-6; a heredoc body mentioning a guarded command used to be
     refused although nothing executed).
  8. Extract `$(...)` (nesting depth-counted) and backtick command
     substitutions from the raw text, EXCEPT one sitting inside single
     quotes (bash never expands either form there), and independently
     re-evaluate each extracted body through this SAME normalisation and
     matching pipeline -- a real `$(git reset --hard)` executes regardless
     of what surrounds it, and `echo '$(git reset --hard)'` must stay inert
     text (AC-QA-4). The masked-out span is replaced by a single space so
     the surrounding text still tokenises.
  9. Unwrap `bash -c`/`sh -c`/`bash -lc SCRIPT` (matched by binary
     basename) and the `nohup`, `sudo` (including `sudo -u <user>`),
     `timeout <n>`, `xargs`, `env` (including `env -i`, `env VAR=val`,
     `env -u NAME`), `command` and `exec` prefix wrappers, feeding the
     inner command back through the SAME per-segment evaluation --
     recursively, so a wrapper can stack on another wrapper -- bounded by
     MAX_UNWRAP_DEPTH so adversarial nesting (a `bash -c` nested a thousand
     deep) cannot exhaust Python's own recursion limit; past the bound the
     command simply fails open, exactly like any other shape this
     tokenizer cannot positively identify (AC-ARCH-4/5, AC-SEC-3, AC-SEC-4,
     AC-QA-4). `destructive_scope()` gains no wrapper-specific branch for
     any of this: a wrapper is resolved to an inner token list or an inner
     command string before matching ever sees it, except `xargs`, which
     appends one synthetic `.` pathspec token standing in for the
     arguments it would append from its stdin at run time (unknowable
     statically) -- see strip_xargs_wrapper()'s own comment.

A `cd <path>` segment updates the effective directory used by every later
segment in the same command, so `cd <dir> && git ...` is scoped against
`<dir>` rather than the payload `cwd` -- this closes both a bypass (the
target repo's dirt was invisible) and a false positive (an unrelated repo's
dirt caused a refusal for a command that never touched it). When the target
cannot be resolved statically (a variable, a glob, a bare `cd` with no
argument, `cd -`), later segments are ALLOWED for checkout/restore/reset
(this hook no longer refuses on an unresolvable `cd` for those three; it
used to, which traded a real but rare gap for a false positive on every
ordinary dynamic `cd` -- specs/harn-fix-2.md's recovery mechanism,
hooks/git-snapshot.py, is what actually covers that gap now) but REFUSED for
`git clean`/`git stash drop`/`git stash clear` specifically, per the
fail-closed posture above: an unresolvable directory means this rule cannot
verify anything, and it would rather refuse a possibly-harmless command than
silently allow a possibly-catastrophic one it never checked.

Parsing is a pragmatic shell tokenizer (shlex with punctuation_chars), not a
full shell grammar: it splits on unquoted `&&`, `||`, `;`, `|`, `&` and a
bare newline so a destructive command chained after something harmless (on
the same line or the next one) is still caught, and it never mistakes a
quoted string that merely CONTAINS destructive-looking text (e.g. `git
commit -m "git checkout -- foo"`) for a real invocation, because that text
stays inside its own token instead of becoming a second command. Shapes
shlex cannot represent (unbalanced quotes, and anything past
MAX_UNWRAP_DEPTH levels of wrapper nesting) fall through ALLOWED: this hook
only ever blocks a pattern it can positively identify, never a command it
merely failed to parse. The ONE exception is size, not shape: a command
over MAX_COMMAND_LENGTH_CHARS that contains the substring `git` is refused
rather than parsed at all, because skipping the parse to answer "allowed"
is not the same risk as failing to positively identify a shape -- it is
choosing not to look, and a real git invocation always contains those
three letters somewhere. An over-cap command with NO `git` substring is
allowed unparsed, since no rule this guard has could ever fire on it. It
makes no completeness claim -- see README.md's
"Destructive git guard" section for the measured-open bypass classes and why
recovery, not detection, is the mechanism this repo actually relies on.
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
# `-C` and `-c` are also listed here for documentation, but both are handled
# by dedicated branches in parse_git_invocation() (one needs to CHAIN a
# directory, the other needs to CAPTURE a key=value pair) rather than the
# generic skip-two-tokens loop below.
GIT_GLOBAL_OPTS_WITH_VALUE = ('-C', '--git-dir', '--work-tree', '-c', '--exec-path')
GIT_GLOBAL_OPTS_NO_VALUE = ('--no-pager', '-p', '--paginate')

# Bounds how many wrapper layers (bash -c/sh -c/bash -lc bodies, and the
# nohup/sudo/timeout/xargs/env/command/exec prefix wrappers) this guard will
# unwrap in one command, and how many levels of $(...) / backtick command
# substitution it will recurse into. Named so it can be reasoned about and
# tested at its own boundary (one corpus case nests exactly this many
# wrappers and is still caught) rather than left as a magic number -- and so
# adversarial nesting (a `bash -c` a thousand deep) cannot exhaust Python's
# own call-stack recursion limit: past this depth the command simply fails
# open, exactly like any other shape this tokenizer cannot positively
# identify (AC-ARCH-4, AC-SEC-4).
MAX_UNWRAP_DEPTH = 5

# Every subprocess call this guard makes (resolve_as_ref, has_uncommitted_change,
# clean_would_remove, stash_list) shares this one timeout ceiling. Named
# rather than left as a literal `10` at each call site so a test can compute
# the guard's worst-case wall-clock time from these constants instead of a
# hard-coded number (K1 review round 1) -- see WORST_CASE_SEGMENT_SECONDS.
SUBPROCESS_TIMEOUT_SECONDS = 10

# The most subprocess calls a SINGLE segment's measurement step can make
# before answering: resolve_as_ref() (checkout's ref-vs-pathspec resolution,
# at most one call) plus has_uncommitted_change()'s own worst case -- a
# path-scoped `git status` call that git itself rejects, retried once
# tree-wide (two calls). clean_would_remove() and stash_list() each make
# exactly one call, below this ceiling, so checkout/restore/reset's shape
# sets the bound.
MAX_SUBPROCESS_CALLS_PER_SEGMENT = 3

# The worst-case wall-clock time this guard can take deciding a SINGLE
# segment. hooks/hooks.json's registered timeout for this hook MUST be
# strictly greater than this: a Claude Code PreToolUse hook that times out
# does not block the tool call, it lets it PROCEED -- so a hook timeout at
# or below this figure turns a genuinely slow (not hung) git call into a
# silent allow of the exact command this guard exists to refuse. See
# hooks/test_hook_timeout_budget.py, which asserts this against the
# registered value, and README's note on chained segments summing past any
# fixed timeout regardless of this constant.
WORST_CASE_SEGMENT_SECONDS = MAX_SUBPROCESS_CALLS_PER_SEGMENT * SUBPROCESS_TIMEOUT_SECONDS

# K1 review round 2: shlex's tokeniser reads a token ONE CHARACTER AT A TIME
# (CPython's shlex.read_token loops on self.instream.read(1)), so a single
# very long token scales far worse than linearly -- measured on this
# machine: a 1 MiB command (`git reset --hard` plus ~1 MiB of padding as one
# trailing token) made split_segments() alone take ~8s, which exceeded a 10s
# CI test budget under ordinary contention (the incident this constant
# fixes: PR #3, CI red on both Node 22 and Node 26, and the same failure
# blocking a local pre-push). A single 65536-char token measured ~38ms
# uncontended -- comfortably bounded even under heavy contention.
#
# The decision on an over-cap command that MIGHT be a real git invocation
# is REFUSE, not allow, and this is deliberate, not the same "unparseable
# -> fail open" rule this guard uses for a shape shlex cannot tokenise at
# all (see module docstring). Skipping the expensive tokenising step and
# then answering "allowed" would let a real `git reset --hard` hidden
# inside enough padding straight through -- exactly the shape a hostile or
# merely enormous payload could exploit. An over-cap command that COULD be
# a git invocation is refused UNSEEN, before any of the normalisation
# stages below ever run, at every recursion level (the top-level command,
# and each `bash -c` body or `$(...)`/backtick substitution independently)
# -- see evaluate_command_text()'s first check.
#
# K1 review round 3: refusing EVERY over-cap command blocked ordinary work
# -- this hook runs on every Bash call, and an agent routinely writes a
# large file through one (a heredoc, generated test data). Every rule this
# guard can ever fire needs the literal substring `git` somewhere in the
# command text (no git binary path, no `git` subcommand, exists without
# it), so an over-cap command with NO `git` substring anywhere is allowed
# without being parsed at all -- a single cheap linear scan
# (`'git' in command`), checked on the raw text before any stripping, so a
# large, git-free heredoc or generated-data write is no longer refused
# just for being long.
MAX_COMMAND_LENGTH_CHARS = 65536

# `bash -c SCRIPT` / `sh -c SCRIPT` / `bash -lc SCRIPT`: matched by binary
# basename (wrapper_shell_c()) so `/bin/bash -c ...` is still recognised.
SHELL_C_BASENAMES = ('bash', 'sh')
SHELL_C_FLAGS = ('-c', '-lc')

# Prefix wrappers whose ENTIRE effect (for this guard's purposes) is "strip
# my own name and run what follows" -- no flags of their own worth modelling.
SIMPLE_PREFIX_WRAPPERS = ('nohup', 'command', 'exec')

# `git clean.requireforce` values git itself treats as boolean false. Only
# consulted for the exact corpus-asserted shape `-c clean.requireForce=false`
# (classify_clean()) -- not an attempt to reimplement git's full config
# boolean parser.
CLEAN_REQUIRE_FORCE_FALSY = ('false', 'no', 'off', '0')

# `git clean` flags that change WHAT THE DRY RUN REPORTS rather than what a
# real run would delete, so they must be dropped when mirroring the real
# invocation into `git clean -n ...` (K1 review round 4, H1):
#
#   -q/--quiet    suppresses the "Would remove ..." lines entirely, so the
#                 dry run prints nothing and clean_would_remove() reads that
#                 empty stdout as "nothing at risk" -- measured: `git clean
#                 -n -d` prints `Would remove u.txt` where `git clean -n -d
#                 -q` prints nothing at all, and `git clean -fdq` then
#                 deleted the file.
#   -i/--interactive  turns the measuring call into a PROMPT that reads this
#                 hook's own stdin, and reformats its output. A real
#                 interactive clean only ever removes a SUBSET of what the
#                 non-interactive dry run lists, so dropping it reports a
#                 superset: conservative, and never a hang.
#
# Every OTHER flag is passed through verbatim, `-f` COUNT included: `git
# clean -n -f -f -d` reports a nested repository that `git clean -n -d` does
# not (measured, git 2.54), and stripping the second `-f` was H2 -- a
# nested repository with unpushed commits deleted while the guard reported
# nothing at risk. `-n` itself still wins over any number of `-f`, measured
# on the same version: nothing is removed by the measuring call.
CLEAN_REPORTING_ONLY_FLAGS = ('-q', '--quiet', '-i', '--interactive')

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


def extract_command_substitutions(text):
    """Extract top-level `$(...)`/backtick command substitutions from
    `text`, skipping any that sit inside single quotes (bash never expands
    either form there -- `echo '$(git reset --hard)'` must stay inert,
    AC-QA-4). Nested `$(...)` is depth-counted; a `$(` with no matching `)`,
    or a backtick with no closing backtick, is left as literal text from
    that point on rather than raising -- this is normalisation, not a shell
    parser (see module docstring), and it must never crash on malformed
    input (AC-SEC-4).

    Returns (masked_text, [substitution_bodies]): each extracted span is
    replaced by a single space in `masked_text` so the remaining text still
    tokenises cleanly for split_segments(); each body is independently fed
    back through the full evaluation pipeline by the caller."""
    out = []
    bodies = []
    i, n = 0, len(text)
    in_single = False
    while i < n:
        ch = text[i]
        if in_single:
            out.append(ch)
            if ch == "'":
                in_single = False
            i += 1
            continue
        if ch == '\\' and i + 1 < n:
            out.append(ch)
            out.append(text[i + 1])
            i += 2
            continue
        if ch == "'":
            in_single = True
            out.append(ch)
            i += 1
            continue
        if text[i:i + 2] == '$(':
            depth = 1
            j = i + 2
            while j < n and depth > 0:
                if text[j] == '(':
                    depth += 1
                elif text[j] == ')':
                    depth -= 1
                j += 1
            bodies.append(text[i + 2:max(i + 2, j - 1)])
            out.append(' ')
            i = j
            continue
        if ch == '`':
            j = text.find('`', i + 1)
            if j == -1:
                out.append(ch)
                i += 1
                continue
            bodies.append(text[i + 1:j])
            out.append(' ')
            i = j + 1
            continue
        out.append(ch)
        i += 1
    return ''.join(out), bodies


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
    """Resolve `target` against `base`. `base` may be None: a caller probing
    an invocation's SHAPE while the real effective directory is
    unresolvable (see evaluate_segment()'s fail-closed branch) passes None
    rather than guessing -- an absolute `target` still resolves against it,
    a relative one stays unresolvable (None)."""
    if base is None:
        return os.path.normpath(target) if os.path.isabs(target) else None
    return os.path.normpath(os.path.join(base, target))


def parse_git_invocation(tokens, cwd):
    """Given a segment's tokens (already redirect-stripped, env-prefix-
    stripped and shell-keyword-stripped), return (subcmd, rest,
    effective_cwd, git_config) if `tokens[0]` is a git binary, else None.
    `effective_cwd` starts as `cwd` (which may itself be None, see
    join_cwd()) and is updated by any `-C <path>` global option
    encountered (chained, exactly like git itself). `git_config` is a dict
    of any `-c key=value` global options seen, lower-cased by key -- the
    only key this guard ever consults is `clean.requireforce`
    (classify_clean)."""
    if not tokens or not is_git_binary(tokens[0]):
        return None
    i = 1
    n = len(tokens)
    effective_cwd = cwd
    git_config = {}
    while i < n:
        tok = tokens[i]
        if tok == '-C':
            if i + 1 >= n:
                return None  # malformed global option; nothing to guard
            effective_cwd = join_cwd(effective_cwd, tokens[i + 1])
            i += 2
            continue
        if tok == '-c':
            if i + 1 >= n:
                return None  # malformed global option; nothing to guard
            key, _, value = tokens[i + 1].partition('=')
            git_config[key.strip().lower()] = value
            i += 2
            continue
        matched = False
        for opt in GIT_GLOBAL_OPTS_WITH_VALUE:
            if opt in ('-C', '-c'):
                continue  # handled above, each needs its own capture
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
    return tokens[i], tokens[i + 1:], effective_cwd, git_config


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
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def classify_clean(rest, git_config):
    """Return ('clean', dry_run_args) if `rest` (already normalize_rest()'d)
    is a `git clean` invocation that would ACTUALLY delete something -- not
    a dry run, and either `-f`/`--force` is present or `clean.requireforce`
    has been set falsy via `-c` (git itself silently does nothing for a
    plain `git clean -d` with neither, so that shape is not guarded at all:
    nothing destructive happens). `dry_run_args` MIRRORS the real
    invocation -- every flag and pathspec kept verbatim, the `-f` COUNT
    included, minus only the reporting-only flags
    (CLEAN_REPORTING_ONLY_FLAGS, whose comment says why each had to go) --
    ready to be run as `git clean -n <dry_run_args>`. AC-DATA-2: judged by
    what a REAL dry run of the same flags and pathspecs would remove, not by
    `git status`, since clean's whole purpose is untracked and ignored files
    status does not track as a change at all."""
    if '-n' in rest or '--dry-run' in rest:
        return None  # already a dry run; nothing will actually be removed
    forced = '-f' in rest or '--force' in rest
    if not forced:
        override = (git_config or {}).get('clean.requireforce', '').strip().lower()
        forced = override in CLEAN_REQUIRE_FORCE_FALSY
    if not forced:
        return None  # git itself refuses without -f; nothing destructive happens
    return ('clean', clean_dry_run_args(rest))


def clean_dry_run_args(rest):
    """`rest` with the reporting-only flags dropped, ready to follow `git
    clean -n`. Stops filtering at a `--` pathspec separator: a file
    genuinely named `-q` must still reach the dry run as a pathspec, exactly
    as it would reach the real invocation."""
    if '--' in rest:
        sep = rest.index('--')
        head, tail = rest[:sep], rest[sep:]
    else:
        head, tail = rest, []
    return [t for t in head if t not in CLEAN_REPORTING_ONLY_FLAGS] + tail


def classify_stash(rest):
    """Return ('stash', {'op': 'drop'|'clear', 'ref': str-or-None}) if
    `rest` is a `git stash drop`/`git stash clear` invocation, else None.
    `git stash` (push), `list`, `show`, `apply`, `pop`, `branch`, `create`
    and `store` are all left alone (AC-DATA-4): none of them PERMANENTLY
    destroys an existing entry the way drop/clear do."""
    if not rest:
        return None  # bare `git stash` == push; never refused
    sub = rest[0]
    if sub == 'drop':
        ref = rest[1] if len(rest) > 1 and not rest[1].startswith('-') else None
        return ('stash', {'op': 'drop', 'ref': ref})
    if sub == 'clear':
        return ('stash', {'op': 'clear'})
    return None


def destructive_scope(subcmd, rest, cwd, git_config=None):
    """Return ('paths', [paths]), ('tree', None), ('clean', dry_run_args) or
    ('stash', target) if `subcmd`/`rest` (a git invocation already stripped
    of global options) is one of the guarded shapes, or None if it is not.
    `cwd` is needed to resolve an ambiguous checkout argument as a ref vs. a
    pathspec (see resolve_as_ref) -- callers that cannot supply a real `cwd`
    (the effective directory is unresolvable) must not call this for
    `checkout`/`switch`/`restore`/`reset` at all; `clean` and `stash` never
    touch `cwd` here (their OWN measurement step does, separately, and only
    when `cwd` is known -- see evaluate_segment())."""
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

    if subcmd == 'clean':
        return classify_clean(rest, git_config)

    if subcmd == 'stash':
        return classify_stash(rest)

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
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_SECONDS,
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


def clean_would_remove(cwd, dry_run_args):
    """True if a REAL `git clean -n <dry_run_args>` reports anything would
    be removed, OR if that check itself could not be trusted (fails CLOSED
    -- unlike has_uncommitted_change()'s fail-open: clean can destroy
    untracked and ignored work with no snapshot anywhere, so an
    unverifiable clean is treated as risky, never as safe -- AC-DATA-3)."""
    try:
        result = subprocess.run(
            ['git', 'clean', '-n'] + dry_run_args,
            cwd=cwd, env=sanitized_git_env(),
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return True  # cannot verify; fail CLOSED
    if result.returncode != 0:
        return True  # cannot verify (e.g. cwd is not a git repository); fail CLOSED
    return bool(result.stdout.strip())


def stash_list(cwd):
    """The repo's stash entries as a list of `stash@{N}` refs (possibly
    empty), or None if the list itself could not be obtained -- kept
    distinct from an empty list so the caller can fail CLOSED on None
    rather than reading "could not check" as "nothing there"."""
    try:
        result = subprocess.run(
            ['git', 'stash', 'list'],
            cwd=cwd, env=sanitized_git_env(),
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return [line.split(':', 1)[0].strip() for line in result.stdout.splitlines() if line.strip()]


def stash_would_lose_entries(cwd, target):
    """True if `target` (from classify_stash) would actually destroy a real
    stash entry, or if this could not be verified (fails CLOSED -- see
    clean_would_remove()'s docstring for why)."""
    entries = stash_list(cwd)
    if entries is None:
        return True  # cannot verify; fail CLOSED
    if not entries:
        return False  # nothing to lose
    if target['op'] == 'clear':
        return True  # at least one real entry exists, and clear destroys all of them
    ref = target['ref'] or 'stash@{0}'
    return ref in entries


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

# AC-OPS-11: each new rule names its OWN reason -- never the "tracked,
# uncommitted change" wording above, which is specific to what
# has_uncommitted_change() checks. Both texts also cover the fail-CLOSED
# trigger (directory unresolvable, or the measuring call failed/timed out)
# alongside the "measured and found something at risk" trigger, since both
# reach the same refusal for the same underlying reason: this rule could not
# confirm the command is safe.
REFUSAL_CLEAN = (
    "destructive-git-guard: refused `{cmd}` -- either a real dry run of the "
    "same flags and pathspecs shows untracked or ignored files would be "
    "removed, or that could not be verified (the directory could not be "
    "resolved, or the check itself failed or timed out), and this rule "
    "fails CLOSED rather than guessing. Safe alternative: run `git clean "
    "-n` yourself first and inspect the list. If this cleanup is "
    "deliberate, opt in explicitly: re-run with {var}=1 set inline "
    "(`{var}=1 {cmd}`) or exported for the session."
)

REFUSAL_STASH = (
    "destructive-git-guard: refused `{cmd}` -- either the stash list is "
    "non-empty (or an earlier `git stash` in this same command would make "
    "it so), or that could not be verified (the directory could not be "
    "resolved, or the check itself failed or timed out), and this rule "
    "fails CLOSED rather than guessing. Safe alternative: `git stash list` "
    "to inspect the stash entries first. If this is deliberate, opt in "
    "explicitly: re-run with {var}=1 set inline (`{var}=1 {cmd}`) or "
    "exported for the session."
)

# K1 review round 2/3: no `{cmd}` slot -- this refusal fires BEFORE any
# tokenising, so there is no parsed `head` to display, and printing the
# full over-cap text back would itself be wasteful. Shows a bounded prefix
# instead. Only the process-environment escape hatch (exported for the
# session) can apply here: the inline, segment-scoped form needs the
# command tokenised to find it, which is exactly the step this refusal
# skips. Only ever raised for an over-cap command that DOES contain the
# substring `git` -- one that does not is allowed without reaching this
# formatting at all (round 3: refusing every over-cap command blocked
# ordinary large-file-writing Bash calls that never go near git).
REFUSAL_OVERSIZE = (
    "destructive-git-guard: refused a {length}-character command (starts "
    "`{prefix}...`) -- over this guard's {cap}-character parsing cap AND "
    "containing the substring `git`, which could be a real invocation this "
    "guard cannot safely check within a bounded wall-clock cost. "
    "Tokenising a command this size cannot be bounded to a safe wall-clock "
    "cost (a single very long token makes the tokeniser scale far worse "
    "than linearly -- measured, see the module docstring), and this guard "
    "refuses rather than skip parsing and risk silently allowing a "
    "destructive command hidden in the padding. If this command is "
    "genuinely this large and known safe, opt in explicitly: export "
    "{var}=1 for the session before retrying (the inline form cannot be "
    "recognised here, since this refusal happens before any parsing)."
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


def wrapper_shell_c(head):
    """If `head` is `bash -c SCRIPT`, `sh -c SCRIPT` or `bash -lc SCRIPT`
    (matched by binary basename, so `/bin/bash -c ...` also matches),
    return SCRIPT -- the inner shell script text, already unquoted by shlex
    during tokenising. The caller feeds this back through
    evaluate_command_text() as a brand-new command string with its own
    segments and its own escape-hatch scoping: an escape hatch set on the
    OUTER segment that invokes `bash -c` does not disarm the command
    inside, and one set INSIDE the wrapped script does not leak back out
    (AC-SEC-3). Returns None if `head` is not one of these shapes."""
    if len(head) < 3:
        return None
    if os.path.basename(head[0]) not in SHELL_C_BASENAMES:
        return None
    if head[1] not in SHELL_C_FLAGS:
        return None
    return head[2]


def strip_sudo_wrapper(head):
    """`sudo [-flags] [-u <user>] <cmd...>` -> `<cmd...>`. Skips any run of
    dash-prefixed sudo flags, consuming an extra token for `-u`'s value;
    stops at the first non-flag token, which is the wrapped command."""
    i = 1
    n = len(head)
    while i < n and head[i].startswith('-'):
        if head[i] == '-u':
            i += 2
        else:
            i += 1
    return head[i:] or None


def strip_timeout_wrapper(head):
    """`timeout [-flags] <duration> <cmd...>` -> `<cmd...>`. Does not model
    a timeout flag that itself takes a separate value token (e.g.
    `-k 10`) -- not a shape this guard's corpus needs, and worth noting as
    a limitation rather than silently mishandling it."""
    i = 1
    n = len(head)
    while i < n and head[i].startswith('-'):
        i += 1
    if i >= n:
        return None  # no duration argument at all; malformed, nothing to unwrap
    i += 1  # the duration argument itself
    return head[i:] or None


def strip_env_wrapper(head):
    """`env [-i] [-u NAME] [VAR=val ...] [--] <cmd...>` -> `<cmd...>`."""
    i = 1
    n = len(head)
    while i < n:
        tok = head[i]
        if tok in ('-i', '--ignore-environment'):
            i += 1
            continue
        if tok in ('-u', '--unset'):
            i += 2
            continue
        if tok == '--':
            i += 1
            break
        if ENV_ASSIGNMENT_RE.match(tok):
            i += 1
            continue
        break
    return head[i:] or None


def strip_xargs_wrapper(head):
    """`xargs [-flags] <cmd...>` -> `<cmd...>` PLUS one synthetic `.`
    pathspec token appended at the end. xargs appends items read from its
    OWN stdin as trailing arguments to the wrapped command by default --
    content this guard cannot see statically (it is produced by another
    process at RUN time, never a literal token here). Without the
    synthetic token, `xargs git checkout --` would unwrap to a bare
    `checkout --` with an EMPTY path list, which destructive_scope()
    already (correctly, for that shape alone) treats as nothing to scope --
    silently under-detecting the real risk. Appending `.` makes the scope
    tree-wide instead, entirely inside this wrapper-unwrap step:
    destructive_scope() itself gains no xargs-specific branch (AC-ARCH-4).
    Does not model a flag that takes a separate value token (e.g. `-I {}`,
    two tokens) -- not a shape this guard's corpus needs."""
    i = 1
    n = len(head)
    while i < n and head[i].startswith('-'):
        i += 1
    inner = head[i:]
    if not inner:
        return None
    return inner + ['.']


def strip_prefix_wrapper(head):
    """If `head` begins with a recognised process wrapper (nohup, sudo,
    timeout, env, xargs, command, exec -- matched by binary basename),
    return the inner command's tokens with the wrapper stripped, to be fed
    back through evaluate_segment() at depth+1. destructive_scope() gains
    no wrapper-specific branch for any of this (AC-ARCH-4/5), except
    xargs's synthetic trailing pathspec (see strip_xargs_wrapper). Returns
    None if `head` does not start with one of these."""
    if not head:
        return None
    basename = os.path.basename(head[0])
    if basename in SIMPLE_PREFIX_WRAPPERS:
        return head[1:] or None
    if basename == 'sudo':
        return strip_sudo_wrapper(head)
    if basename == 'timeout':
        return strip_timeout_wrapper(head)
    if basename == 'env':
        return strip_env_wrapper(head)
    if basename == 'xargs':
        return strip_xargs_wrapper(head)
    return None


def evaluate(command, cwd):
    """Return a refusal message, or None to allow `command`."""
    if os.environ.get(ESCAPE_VAR) == '1':
        return None
    state = {'cwd': cwd, 'cwd_known': True, 'stash_created': False}
    return evaluate_command_text(command, state, 0)


def evaluate_command_text(command, state, depth):
    """Evaluate one command STRING: the whole Bash payload at depth 0, or
    the inner body of a `bash -c`/`sh -c`/`bash -lc` wrapper, or a `$(...)`/
    backtick command substitution, at a greater depth. `state` (a dict of
    `cwd`, `cwd_known` and `stash_created`) is threaded through and mutated
    by reference, since a `cd` or `git stash` push inside a wrapper's body
    must still be visible to segments that follow it in the OUTER command.
    Bounded by MAX_UNWRAP_DEPTH so adversarial nesting cannot exhaust
    Python's own recursion limit (AC-SEC-4/AC-ARCH-4)."""
    if depth > MAX_UNWRAP_DEPTH:
        return None  # bounded; fail open past the bound, see module docstring
    if len(command) > MAX_COMMAND_LENGTH_CHARS:
        # K1 review round 3: refusing EVERY over-cap command blocked
        # ordinary work -- this hook runs on every Bash call, and agents
        # routinely write large files through one (`cat > file.json <<'EOF'
        # ... EOF`, generated test data). Every rule this guard can ever
        # fire needs a real git invocation to match, and a destructive one
        # needs the literal substring `git` somewhere in the command text --
        # a variable-expansion trick (`$G reset --hard`) is already outside
        # this guard's stated scope (an ACCIDENT guard, not a defence against
        # an adversary -- see the module docstring's own framing). So an
        # over-cap command with no `git` substring anywhere is ALLOWED
        # without being parsed at all: `'git' in command` is a single linear
        # scan, cheap even at MAX_COMMAND_LENGTH_CHARS, and it cannot miss a
        # real invocation (no git binary path, no `git` subcommand, exists
        # without the three letters `git` in it somewhere).
        #
        # Checked on the RAW text, before strip_heredoc_bodies runs --
        # deliberately: an over-cap heredoc BODY that merely mentions `git`
        # is refused too, even though that text is inert and would
        # ordinarily be stripped before matching. This is an accepted,
        # deliberate cost (confirming it really is inert needs the same
        # expensive parse this cap exists to avoid), pinned by
        # test_destructive_git_hostile.py so it stays a choice, not a
        # surprise.
        #
        # An over-cap command that DOES contain `git` is refused UNSEEN,
        # before strip_heredoc_bodies/extract_command_substitutions/
        # split_segments ever run on it -- those are exactly the stages
        # whose cost this cap exists to bound (K1 review round 2).
        # Deliberately the opposite of "unparseable -> fail open": this
        # command COULD still be parsed, just not within a safe wall-clock
        # budget, and skipping the parse to answer "allowed" would let a
        # real destructive git call hidden in the padding straight through.
        if 'git' not in command:
            return None
        return REFUSAL_OVERSIZE.format(
            length=len(command), prefix=command[:80], cap=MAX_COMMAND_LENGTH_CHARS, var=ESCAPE_VAR)
    command = strip_heredoc_bodies(command)
    command, substitutions = extract_command_substitutions(command)
    for sub_text in substitutions:
        reason = evaluate_command_text(sub_text, state, depth + 1)
        if reason:
            return reason
    try:
        segments = split_segments(command)
    except ValueError:
        return None  # unparseable; fail open, see module docstring
    for raw_tokens in segments:
        reason = evaluate_segment(raw_tokens, state, depth)
        if reason:
            return reason
    return None


def evaluate_segment(raw_tokens, state, depth):
    """Evaluate one already-segmented token list against `state`. Recurses
    (bounded by MAX_UNWRAP_DEPTH) into a `bash -c`/`sh -c`/`bash -lc` body
    or a prefix-wrapped inner command -- see module docstring, AC-ARCH-4/5."""
    tokens = strip_redirects(raw_tokens)

    cd = classify_cd(strip_shell_keywords(strip_env_prefix(tokens)))
    if cd is not None:
        kind, target = cd
        if kind == 'dynamic':
            # Cannot resolve statically -- checkout/restore/reset ALLOW
            # rather than guess (see module docstring); clean/stash
            # drop/clear fail CLOSED instead, handled below once we know
            # what kind of git invocation (if any) follows.
            state['cwd_known'] = False
        else:
            state['cwd'] = join_cwd(state['cwd'], target)
        return None

    if escape_hatch_active_for_segment(tokens):
        return None

    head = strip_shell_keywords(strip_env_prefix(tokens))

    script = wrapper_shell_c(head)
    if script is not None:
        if depth >= MAX_UNWRAP_DEPTH:
            return None  # bounded; fail open past the bound
        return evaluate_command_text(script, state, depth + 1)

    inner = strip_prefix_wrapper(head)
    if inner is not None:
        if depth >= MAX_UNWRAP_DEPTH:
            return None  # bounded; fail open past the bound
        return evaluate_segment(inner, state, depth + 1)

    if not state['cwd_known']:
        # AC-DATA-3: `clean`/`stash drop`/`stash clear` fail CLOSED when the
        # effective directory cannot be resolved -- checked here by SHAPE
        # only (cwd=None), never by calling destructive_scope() for
        # checkout/switch/restore/reset, which would call resolve_as_ref()
        # against an unknown directory and risk reading the wrong repo.
        parsed = parse_git_invocation(head, None)
        if parsed is not None:
            subcmd, rest, _unused_cwd, git_config = parsed
            if subcmd in ('clean', 'stash'):
                scope = destructive_scope(subcmd, rest, None, git_config)
                if scope is not None:
                    display_cmd = ' '.join(head)
                    template = REFUSAL_CLEAN if scope[0] == 'clean' else REFUSAL_STASH
                    return template.format(cmd=display_cmd, var=ESCAPE_VAR)
        return None

    parsed = parse_git_invocation(head, state['cwd'])
    if parsed is None:
        return None
    subcmd, rest, segment_cwd, git_config = parsed

    if subcmd == 'stash':
        # Tracked regardless of whether THIS segment ends up refused: an
        # earlier `git stash` push in the SAME command makes a LATER `stash
        # drop`/`clear` non-empty even though it hasn't run yet at the
        # moment this hook evaluates the whole command (probe case 14,
        # AC-DATA-4).
        rest_n = normalize_rest(rest)
        if not rest_n or rest_n[0] in ('push', 'save'):
            state['stash_created'] = True

    scope = destructive_scope(subcmd, rest, segment_cwd, git_config)
    if scope is None:
        return None

    display_cmd = ' '.join(head)
    kind = scope[0]
    if kind == 'clean':
        risky = clean_would_remove(segment_cwd, scope[1])
        template = REFUSAL_CLEAN
    elif kind == 'stash':
        risky = state['stash_created'] or stash_would_lose_entries(segment_cwd, scope[1])
        template = REFUSAL_STASH
    else:
        risky = has_uncommitted_change(segment_cwd, scope)
        template = REFUSAL
    if risky:
        return template.format(cmd=display_cmd, var=ESCAPE_VAR)
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unreadable payload; fail open
    if not isinstance(payload, dict):
        sys.exit(0)  # a well-formed but non-object payload (e.g. a JSON array); fail open
    if payload.get('tool_name') != 'Bash':
        sys.exit(0)
    tool_input = payload.get('tool_input') or {}
    command = tool_input.get('command')
    if not command or not command.strip():
        sys.exit(0)
    cwd = payload.get('cwd') or os.getcwd()
    try:
        reason = evaluate(command, cwd)
    except Exception:
        # AC-SEC-4: whatever pathological input reaches this point, the
        # hook contract stays exit 0 or 2, NEVER 1, and stderr never carries
        # a Python traceback. An exception here is a bug in this module's
        # own parsing, not evidence the command is unsafe -- but a crashed
        # hook is worse than a missed detection, since Claude Code treats
        # any exit code other than 2 as "proceed".
        sys.exit(0)
    if reason:
        print(reason, file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


if __name__ == '__main__':
    main()
