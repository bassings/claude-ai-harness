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

# Global options, and environment variables, that point git at a DIFFERENT
# repository from the one `cwd` names. This guard measures by running git
# itself in `cwd` with the GIT_* namespace stripped (sanitized_git_env), so
# neither reaches its measuring call: it would answer about the wrong
# repository, confidently. Skipping them and measuring anyway was M1 (K1
# review round 4) -- reproduced: with a clean cwd and a second repo holding
# an untracked file, `git --git-dir=O/.git --work-tree=O clean -fd` was
# ALLOWED and the real run deleted that file; the env-prefix spelling did
# the same. clean and stash drop/clear now fail CLOSED on either, which is
# the same posture they already take for an unresolvable `cd` target.
# checkout/restore/reset keep their documented fail-OPEN posture here, for
# the same reason they keep it everywhere else: snapshots cover the tracked
# work they can lose.
GIT_REPO_RETARGETING_OPTS = ('--git-dir', '--work-tree')
GIT_REPO_RETARGETING_ENV_VARS = ('GIT_DIR', 'GIT_WORK_TREE')

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
# tree-wide (two calls). clean_would_remove() makes at most two (reading
# clean.requireForce, then the dry run itself) and stash_list() exactly one,
# both below this ceiling, so checkout/restore/reset's shape sets the bound.
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

# `git stash`'s subcommands that do NOT create a stash entry. Everything
# else is a push, INCLUDING the bare `git stash` and every flag-led spelling
# (`git stash -u`, `--include-untracked`, `-m msg`, `-k`, `-a`, `-p`): git's
# own grammar is "the first argument is a subcommand, or else this is a push
# and the arguments are push's own options", and matching the literal
# spellings `push` and `save` instead was H3 (K1 review round 4) -- `git
# stash -u && git stash drop` was ALLOWED and the real run destroyed the
# untracked files it had just stashed, leaving the stash list empty.
#
# Known gap, recorded rather than silently widened: `git stash store
# <commit>` DOES add an entry to the list, so it belongs on the
# entry-creating side of this split on the merits. It is listed here as a
# non-push because the round-4 brief names it explicitly among the nine
# non-push subcommands. It is plumbing an agent effectively never emits.
STASH_NON_PUSH_SUBCOMMANDS = frozenset({
    'list', 'show', 'apply', 'pop', 'drop', 'clear', 'branch', 'create', 'store',
})

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

# What a `$(...)`/backtick command substitution is replaced by in the text
# handed to split_segments(), so the substitution stays attached to the
# SEGMENT it was written in. It used to be replaced by a single space, which
# discarded that association: every substitution was then evaluated before
# any segment, and so never saw a `cd` written earlier in the same command
# (round 4, M4). Word characters only, so shlex tokenises it as one ordinary
# word wherever it lands, quoted or not. A command whose own literal text
# contains this exact string, with an index a real substitution also used,
# would have it stripped -- accepted, for an accident guard, over a
# nondeterministic nonce that would make the same input parse differently
# from run to run.
SUBSTITUTION_PLACEHOLDER_FMT = '__harness_subst_%d__'
SUBSTITUTION_PLACEHOLDER_RE = re.compile(r'__harness_subst_(\d+)__')

# A stash ref that names an entry by INDEX, the only shape this guard can
# reduce to what `git stash list` prints (normalize_stash_ref). Anything
# else git accepts -- a reflog date such as `stash@{1.hour.ago}`, say --
# deliberately does NOT match, so it fails closed instead of missing the
# lookup and reading that miss as "nothing at risk" (round 4, H4).
STASH_INDEX_REF_RE = re.compile(r'stash@\{(\d+)\}')


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
    replaced by SUBSTITUTION_PLACEHOLDER_FMT %% its index in `masked_text`,
    so the remaining text still tokenises cleanly for split_segments() AND
    each body stays attached to the segment it was written in -- see
    SUBSTITUTION_PLACEHOLDER_FMT for why that matters."""
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
            out.append(SUBSTITUTION_PLACEHOLDER_FMT % len(bodies))
            bodies.append(text[i + 2:max(i + 2, j - 1)])
            i = j
            continue
        if ch == '`':
            j = text.find('`', i + 1)
            if j == -1:
                out.append(ch)
                i += 1
                continue
            out.append(SUBSTITUTION_PLACEHOLDER_FMT % len(bodies))
            bodies.append(text[i + 1:j])
            i = j + 1
            continue
        out.append(ch)
        i += 1
    return ''.join(out), bodies


def take_substitution_placeholders(tokens, substitution_count):
    """Split `tokens` into (tokens_without_placeholders, [indices]) -- the
    substitution indices written in this segment, in the order they appear.
    A placeholder may sit INSIDE a larger token (`git commit -m "built
    $(date)"` tokenises as one word), so it is removed by substring, and a
    token left empty by that removal is dropped entirely. An index past
    `substitution_count` is not one this evaluation produced, so that token
    is left exactly as written."""
    out = []
    indices = []
    for tok in tokens:
        matches = [m for m in SUBSTITUTION_PLACEHOLDER_RE.finditer(tok)
                   if int(m.group(1)) < substitution_count]
        if not matches:
            out.append(tok)
            continue
        indices.extend(int(m.group(1)) for m in matches)
        stripped = ''
        last = 0
        for m in matches:
            stripped += tok[last:m.start()]
            last = m.end()
        stripped += tok[last:]
        if stripped:
            out.append(stripped)
    return out, indices


def take_subshell_parens(tokens):
    """Split `tokens` into (tokens, opened, closed): the leading `(` and
    trailing `)` grouping tokens counted and removed. shlex makes each its
    own token (they are in PUNCTUATION_CHARS) but they never split a
    segment, so `(cd sub; git clean -fd)` arrives as two segments, the first
    starting with `(` and the second ending with `)`. Counting them is what
    lets evaluate_command_text() give the subshell its own directory (K1
    review round 5, H3). Unbalanced parens are simply counted as they come;
    this is normalisation, not a shell parser, and the caller never pops
    past its own root context."""
    opened = 0
    closed = 0
    while tokens and tokens[0] == '(':
        opened += 1
        tokens = tokens[1:]
    while tokens and tokens[-1] == ')':
        closed += 1
        tokens = tokens[:-1]
    return tokens, opened, closed


def child_context(state):
    """`state` as a CHILD PROCESS sees it: `cwd`/`cwd_known` COPIED, so a
    `cd` the child performs cannot move the shell that runs the segments
    after it, and the `shared` dict passed BY REFERENCE, so a repo-global
    fact the child establishes (a `git stash` push) is still visible
    outside. Threading one mutable dict through every context conflated the
    two, and a `cd` inside `bash -c` or `$(...)` leaked outward (round 4,
    M4)."""
    return {'cwd': state['cwd'], 'cwd_known': state['cwd_known'], 'shared': state['shared']}


def split_segments(command):
    """Tokenise `command`, splitting on unquoted shell control operators,
    INCLUDING a bare newline (see module docstring: a multi-line Bash call
    is the ordinary shape of agent tool use, and a destructive command on
    any line but the first must be caught exactly like one chained with
    `&&`). Returns a list of (tokens, is_pipeline_component) pairs, one per
    sub-command. A segment on either side of a `|` runs in its OWN subshell,
    so a `cd` in it cannot move the shell that runs the rest of the command
    (K1 review round 5, H3), and the caller needs to know which segments
    those are. Raises ValueError (via shlex) on unparseable input such as
    unbalanced quotes, which the caller treats as fail-open."""
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
    # separators[i] is the control operator that PRECEDES segments[i];
    # None for the first, which nothing precedes.
    separators = [None]
    for tok in tokens:
        if tok in CONTROL_OPERATORS:
            segments.append([])
            separators.append(tok)
        else:
            segments[-1].append(tok)
    out = []
    for index, segment in enumerate(segments):
        if not segment:
            continue  # e.g. a trailing `;`, or two operators in a row
        before = separators[index]
        after = separators[index + 1] if index + 1 < len(separators) else None
        out.append((segment, before == '|' or after == '|'))
    return out


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


def env_prefix_retargets_repo(tokens):
    """True if THIS segment carries a `GIT_DIR=`/`GIT_WORK_TREE=` env
    prefix. Read from the segment's own leading assignments, the same run
    strip_env_prefix() drops, rather than from the process environment: the
    process environment is already scrubbed by sanitized_git_env(), so the
    only way one of these can reach the command being judged is as a prefix
    written on the command itself (K1 review round 4, M1, and see
    GIT_REPO_RETARGETING_ENV_VARS)."""
    for assignment in leading_env_assignments(tokens):
        name, _, _value = assignment.partition('=')
        if name in GIT_REPO_RETARGETING_ENV_VARS:
            return True
    return False


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
    effective_cwd, git_config, retargeted) if `tokens[0]` is a git binary,
    else None.
    `effective_cwd` starts as `cwd` (which may itself be None, see
    join_cwd()) and is updated by any `-C <path>` global option
    encountered (chained, exactly like git itself). `git_config` is a dict
    of any `-c key=value` global options seen, lower-cased by key -- the
    only key this guard ever consults is `clean.requireforce`
    (classify_clean).
    `retargeted` is True if a GIT_REPO_RETARGETING_OPTS option was seen:
    the command names a repository this guard's own measurement (which
    runs in `effective_cwd` with GIT_* stripped) cannot reach, so a
    measured answer would be about the wrong repository."""
    if not tokens or not is_git_binary(tokens[0]):
        return None
    i = 1
    n = len(tokens)
    effective_cwd = cwd
    git_config = {}
    retargeted = False
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
            elif tok.startswith(opt + '='):
                i += 1
                matched = True
            if matched:
                if opt in GIT_REPO_RETARGETING_OPTS:
                    retargeted = True
                break
        if matched:
            continue
        if tok in GIT_GLOBAL_OPTS_NO_VALUE:
            i += 1
            continue
        break
    if i >= n:
        return None
    return tokens[i], tokens[i + 1:], effective_cwd, git_config, retargeted


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
    """Return ('clean', target) if `rest` (already normalize_rest()'d) is a
    `git clean` invocation that is not itself a dry run, else None.

    `target` is {'dry_run_args': [...], 'forced': bool}. `forced` is True
    when the command line ALREADY proves git will delete: `-f`/`--force`, or
    `clean.requireforce` set falsy via a `-c` global option. It is False
    when that still depends on the repository's own configuration, which
    only the measurement step can read (clean_requires_force(), K1 review
    round 4, M2). Deciding it HERE, as "no -f means git refuses, so nothing
    to guard", was wrong on any machine whose config sets
    clean.requireForce=false: reproduced, `git clean -d` was ALLOWED and
    deleted an untracked file.

    `dry_run_args` MIRRORS the real
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
    return ('clean', {'dry_run_args': clean_dry_run_args(rest), 'forced': forced})


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


def stash_is_push(rest_n):
    """True if a `git stash` invocation (`rest_n` = its arguments, already
    normalize_rest()'d) creates a stash entry. Read off git's grammar rather
    than a list of spellings: anything whose first argument is not one of
    the non-push subcommands is a push, so a flag-led `git stash -u` counts
    exactly like `git stash push -u` -- see
    STASH_NON_PUSH_SUBCOMMANDS."""
    return not rest_n or rest_n[0] not in STASH_NON_PUSH_SUBCOMMANDS


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
        # The FIRST non-flag argument, not rest[1]: `git stash drop -q
        # stash@{0}` used to read `-q` as "no ref given" and fall back to
        # stash@{0}, which only happened to be the right answer (round 4, H4).
        ref = next((t for t in rest[1:] if not t.startswith('-')), None)
        return ('stash', {'op': 'drop', 'ref': ref})
    if sub == 'clear':
        return ('stash', {'op': 'clear'})
    return None


def destructive_scope(subcmd, rest, cwd, git_config=None, unknown_trailing=False):
    """Return ('paths', [paths]), ('tree', None), ('clean', target) or
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
        if unknown_trailing:
            # Arguments arriving at run time could be any pathspec, so the
            # whole tree is at risk -- the same reading has_pathspec_from_file
            # already gets for paths that are not on the command line either.
            return ('tree', None)
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
            return None  # unstages only; the working tree is never touched, whatever the paths
        if unknown_trailing:
            return ('tree', None)
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
        target = classify_stash(rest)
        if target is not None and unknown_trailing and target[1]['op'] == 'drop':
            # The ref is among the arguments this guard cannot see, so ANY
            # entry could be the one dropped: read it as a clear.
            return ('stash', {'op': 'clear'})
        return target

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


def clean_requires_force(cwd):
    """True if this repository's effective `clean.requireForce` leaves git
    refusing an unforced `git clean` (its default, and the answer whenever
    the setting is absent). False when the setting is explicitly falsy, and
    also when the config itself could not be read at all -- the fail-CLOSED
    direction here, since answering False sends the caller on to the real
    dry run, which does its own fail-closed check (K1 review round 4, M2)."""
    try:
        result = subprocess.run(
            ['git', 'config', '--bool', 'clean.requireForce'],
            cwd=cwd, env=sanitized_git_env(),
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return False  # cannot read it; measure rather than assume git's default
    if result.returncode != 0:
        # Unset (git config exits 1 for a missing key), or a value `--bool`
        # cannot parse. Either way git falls back to requiring force, and an
        # unforced clean removes nothing.
        return True
    return result.stdout.strip().lower() != 'false'


def clean_would_remove(cwd, target):
    """True if a REAL `git clean -n <dry_run_args>` reports anything would
    be removed, OR if that check itself could not be trusted (fails CLOSED
    -- unlike has_uncommitted_change()'s fail-open: clean can destroy
    untracked and ignored work with no snapshot anywhere, so an
    unverifiable clean is treated as risky, never as safe -- AC-DATA-3).

    Returns False early for an unforced clean in a repository that still
    requires force: git itself removes nothing there, so refusing would be a
    false refusal (see classify_clean() for why this is decided here, where
    the repository can actually be read, rather than off the command line)."""
    if not target['forced'] and clean_requires_force(cwd):
        return False
    try:
        result = subprocess.run(
            ['git', 'clean', '-n'] + target['dry_run_args'],
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


def normalize_stash_ref(ref):
    """`ref` as the `stash@{N}` spelling `git stash list` prints, so a
    lookup against that list is comparing like with like. Accepts the three
    index spellings git itself does -- `stash@{N}`, the bare index `N`, and
    a `refs/`-qualified `refs/stash@{N}` -- and returns None for a ref this
    guard cannot reduce to an index, which the caller treats as
    unverifiable, not as "no match" (K1 review round 4, H4).

    None in means the ref was omitted, which git defaults to the most recent
    entry."""
    if ref is None:
        return 'stash@{0}'
    candidate = ref[len('refs/'):] if ref.startswith('refs/') else ref
    if candidate.isdigit():
        return 'stash@{%d}' % int(candidate)
    indexed = STASH_INDEX_REF_RE.fullmatch(candidate)
    if indexed:
        return 'stash@{%d}' % int(indexed.group(1))
    return None


def stash_would_lose_entries(cwd, target):
    """True if `target` (from classify_stash) would actually destroy a real
    stash entry, or if this could not be verified (fails CLOSED -- see
    clean_would_remove()'s docstring for why)."""
    entries = stash_list(cwd)
    if entries is None:
        return True  # cannot verify; fail CLOSED
    if not entries:
        return False  # nothing to lose, whatever the ref says
    if target['op'] == 'clear':
        return True  # at least one real entry exists, and clear destroys all of them
    ref = normalize_stash_ref(target['ref'])
    if ref is None:
        return True  # ref not reducible to an index while entries exist; fail CLOSED
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
    "resolved, the check itself failed or timed out, or the command selects "
    "another repository with --git-dir/--work-tree or GIT_DIR/GIT_WORK_TREE, "
    "which this guard cannot measure), and this rule "
    "fails CLOSED rather than guessing. Safe alternative: run `git clean "
    "-n` yourself first and inspect the list. If this cleanup is "
    "deliberate, opt in explicitly: re-run with {var}=1 set inline "
    "(`{var}=1 {cmd}`) or exported for the session."
)

REFUSAL_STASH = (
    "destructive-git-guard: refused `{cmd}` -- either the stash list is "
    "non-empty (or an earlier `git stash` in this same command would make "
    "it so), or that could not be verified (the directory could not be "
    "resolved, the check itself failed or timed out, the stash "
    "reference given is not one this guard can reduce to a `stash@{{N}}` "
    "index, or the command selects another repository with "
    "--git-dir/--work-tree or GIT_DIR/GIT_WORK_TREE, which this guard "
    "cannot measure), and this rule "
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
    """`xargs [-flags] <cmd...>` -> `<cmd...>`, VERBATIM. xargs appends
    items read from its OWN stdin as trailing arguments to the wrapped
    command by default -- content this guard cannot see statically (another
    process produces it at RUN time, never a literal token here), which is
    what strip_prefix_wrapper() reports to its caller as
    "unknown trailing arguments".

    This used to append a synthetic `.` pathspec instead. That reads as a
    tree-wide scope for checkout/restore, which was the intent, but it is
    nonsense for stash, where the trailing argument is a REF and `.` is not
    one (K1 review round 4, M3): `git stash list --format=%gd | xargs -n1
    git stash drop` measured `.` against the stash list, missed, and was
    ALLOWED. It also put a pathspec the agent never typed into the refusal
    text. Reporting the fact and letting each scope read it its own way
    keeps the wrapper's semantics out of the matching (AC-ARCH-4).

    Does not model a flag that takes a separate value token (e.g. `-I {}`,
    two tokens) -- not a shape this guard's corpus needs."""
    i = 1
    n = len(head)
    while i < n and head[i].startswith('-'):
        i += 1
    return head[i:] or None


def strip_prefix_wrapper(head):
    """If `head` begins with a recognised process wrapper (nohup, sudo,
    timeout, env, xargs, command, exec -- matched by binary basename),
    return (inner_tokens, unknown_trailing) with the wrapper stripped, to
    be fed back through evaluate_segment() at depth+1. `unknown_trailing`
    is True only for xargs, which supplies arguments this guard cannot see
    (strip_xargs_wrapper); every scope reads that fact for itself, so
    destructive_scope() still gains no wrapper-specific branch
    (AC-ARCH-4/5). Returns None if `head` does not start with one of
    these."""
    if not head:
        return None
    basename = os.path.basename(head[0])
    if basename in SIMPLE_PREFIX_WRAPPERS:
        inner = head[1:] or None
    elif basename == 'sudo':
        inner = strip_sudo_wrapper(head)
    elif basename == 'timeout':
        inner = strip_timeout_wrapper(head)
    elif basename == 'env':
        inner = strip_env_wrapper(head)
    elif basename == 'xargs':
        inner = strip_xargs_wrapper(head)
    else:
        return None
    if inner is None:
        return None
    return inner, basename == 'xargs'


def evaluate(command, cwd):
    """Return a refusal message, or None to allow `command`."""
    if os.environ.get(ESCAPE_VAR) == '1':
        return None
    state = {'cwd': cwd, 'cwd_known': True, 'shared': {'stash_created': False}}
    return evaluate_command_text(command, state, 0)


def evaluate_command_text(command, state, depth):
    """Evaluate one command STRING: the whole Bash payload at depth 0, or
    the inner body of a `bash -c`/`sh -c`/`bash -lc` wrapper, or a `$(...)`/
    backtick command substitution, at a greater depth. `state` holds the
    process-local context (`cwd`, `cwd_known`) plus a `shared` dict of
    repo-global facts (`stash_created`); child_context() says which of the
    two crosses a process boundary, and why.
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
    try:
        segments = split_segments(command)
    except ValueError:
        return None  # unparseable; fail open, see module docstring
    # A stack of process contexts. `( ... )` pushes one, so the segments
    # inside the subshell share a directory with each other but cannot move
    # the one outside it; the closing paren pops back. A pipeline component
    # gets a context of its own for that segment alone, for the same reason
    # (K1 review round 5, H3). Both reuse child_context(), so repo-global
    # facts still cross either boundary -- see its docstring.
    contexts = [state]
    for raw_tokens, is_pipeline_component in segments:
        tokens, opened, closed = take_subshell_parens(raw_tokens)
        for _ in range(opened):
            contexts.append(child_context(contexts[-1]))
        segment_state = contexts[-1]
        if is_pipeline_component:
            segment_state = child_context(segment_state)
        tokens, substitution_indices = take_substitution_placeholders(
            tokens, len(substitutions))
        # A substitution runs in its own child process at the point ITS
        # segment runs: after every segment before it, so it sees their
        # `cd`, and before the segment it sits in.
        for index in substitution_indices:
            reason = evaluate_command_text(
                substitutions[index], child_context(segment_state), depth + 1)
            if reason:
                return reason
        reason = evaluate_segment(tokens, segment_state, depth)
        if reason:
            return reason
        for _ in range(closed):
            if len(contexts) > 1:
                contexts.pop()  # popped AFTER the segment, which is inside it
    return None


def evaluate_segment(raw_tokens, state, depth, unknown_trailing=False):
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
        return evaluate_command_text(script, child_context(state), depth + 1)

    unwrapped = strip_prefix_wrapper(head)
    if unwrapped is not None:
        inner, wrapper_unknown_trailing = unwrapped
        if depth >= MAX_UNWRAP_DEPTH:
            return None  # bounded; fail open past the bound
        # Once unknown, always unknown: `xargs nohup git ...` must not lose
        # the fact on the way through the inner wrapper.
        return evaluate_segment(inner, state, depth + 1,
                                unknown_trailing or wrapper_unknown_trailing)

    if not state['cwd_known']:
        # AC-DATA-3: `clean`/`stash drop`/`stash clear` fail CLOSED when the
        # effective directory cannot be resolved -- checked here by SHAPE
        # only (cwd=None), never by calling destructive_scope() for
        # checkout/switch/restore/reset, which would call resolve_as_ref()
        # against an unknown directory and risk reading the wrong repo.
        parsed = parse_git_invocation(head, None)
        if parsed is not None:
            subcmd, rest, _unused_cwd, git_config, _unused_retargeted = parsed
            if subcmd in ('clean', 'stash'):
                scope = destructive_scope(subcmd, rest, None, git_config, unknown_trailing)
                if scope is not None:
                    display_cmd = ' '.join(head)
                    template = REFUSAL_CLEAN if scope[0] == 'clean' else REFUSAL_STASH
                    return template.format(cmd=display_cmd, var=ESCAPE_VAR)
        return None

    parsed = parse_git_invocation(head, state['cwd'])
    if parsed is None:
        return None
    subcmd, rest, segment_cwd, git_config, retargeted = parsed
    retargeted = retargeted or env_prefix_retargets_repo(tokens)

    if subcmd == 'stash':
        # Tracked regardless of whether THIS segment ends up refused: an
        # earlier `git stash` push in the SAME command makes a LATER `stash
        # drop`/`clear` non-empty even though it hasn't run yet at the
        # moment this hook evaluates the whole command (probe case 14,
        # AC-DATA-4).
        rest_n = normalize_rest(rest)
        if stash_is_push(rest_n):
            state['shared']['stash_created'] = True

    scope = destructive_scope(subcmd, rest, segment_cwd, git_config, unknown_trailing)
    if scope is None:
        return None

    display_cmd = ' '.join(head)
    kind = scope[0]
    if kind == 'clean':
        # `retargeted` short-circuits the measurement rather than colouring
        # it: there is nothing useful to measure, since the repository this
        # command acts on is not the one the measuring call can read.
        risky = retargeted or clean_would_remove(segment_cwd, scope[1])
        template = REFUSAL_CLEAN
    elif kind == 'stash':
        risky = (retargeted or state['shared']['stash_created']
                 or stash_would_lose_entries(segment_cwd, scope[1]))
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
