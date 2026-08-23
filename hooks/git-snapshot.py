#!/usr/bin/env python3
"""PreToolUse hook: before a Bash call, snapshot uncommitted TRACKED changes
in the repository at the payload's `cwd`, so work destroyed by any command is
recoverable regardless of how that command was spelled. Recovery mechanism
for specs/harn-fix-2.md, replacing "recognise the destructive command" (which
failed to converge across three rounds, see hooks/destructive-git-guard.py)
with "survive it": snapshot first, let the command run either way. Never
reads the command text (AC-ARCH-1/4, AC-DATA-16): only `cwd` is used, so no
spelling evades it and a `cd`/`git -C` elsewhere is a documented gap, not a
defeat.

Mechanism (specs/harn-fix-2.md "Settled at planning"): `git stash create`
against a PRIVATE COPY of `.git/index` (via GIT_INDEX_FILE), never the real
one -- measured to succeed while `.git/index.lock` is held and to leave the
real index byte-identical. Untracked/ignored files are out of scope (`git
stash create` already excludes both). The commit is anchored by one immutable
ref per snapshot under REF_PREFIX, keyed per checkout (linked worktrees share
a ref store) before this hook returns; refs beyond KEEP_PER_CHECKOUT are
pruned inline, no separate job. Fails open always: exit 0 in every case, with
a bounded, deduplicated trace for the states nothing could be snapshotted in.
"""
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

ESCAPE_VAR = 'HARNESS_DISABLE_SNAPSHOT'
REF_PREFIX = 'refs/harness-snapshots/'
KEEP_PER_CHECKOUT = 20
FAILURE_LOG_NAME = 'harness-snapshot-failures.log'
FAILURE_LOG_MAX_LINES = 200
DEADLINE_SECONDS = 6  # must stay strictly below hooks.json's registered timeout
MAX_GIT_INVOCATIONS = 6  # rev-parse, stash create, update-ref, for-each-ref, prune, gc --auto

# Duplicated from hooks/destructive-git-guard.py, not imported -- no runtime
# dependency between the two hooks (AC-ARCH-2); parity enforced by a test
# enumerating hooks/*.py (AC-ARCH-3).
GIT_ENV_ALLOWLIST = {
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
}

SHA_RE = re.compile(r'[0-9a-fA-F]{40}|[0-9a-fA-F]{64}')

def sanitized_git_env():
    env = dict(os.environ)
    for key in list(env):
        if key.startswith('GIT_') and key not in GIT_ENV_ALLOWLIST:
            del env[key]
    return env


def run_git(args, cwd, env=None, input_text=None):
    try:
        return subprocess.run(
            ['git', '-c', 'core.fsmonitor='] + args, cwd=cwd,
            env=env if env is not None else sanitized_git_env(),
            input=input_text, capture_output=True, text=True, timeout=DEADLINE_SECONDS,
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def repo_info(cwd):
    """(git_dir, toplevel), or None if `cwd` is not a usable work tree."""
    r = run_git(['rev-parse', '--is-inside-work-tree', '--absolute-git-dir', '--show-toplevel'], cwd)
    if r is None or r.returncode != 0:
        return None
    lines = r.stdout.splitlines()
    if len(lines) != 3 or lines[0] != 'true':
        return None
    return lines[1], lines[2]


def checkout_key(git_dir):
    """Per-checkout key (AC-DATA-6): a linked worktree's --absolute-git-dir
    differs from the main checkout's even though they share one ref store."""
    return hashlib.sha1(git_dir.encode()).hexdigest()[:12]


def snapshot_ref_name(key):
    return '%s%s/%d-%d-%s' % (REF_PREFIX, key, time.time_ns(), os.getpid(), secrets.token_hex(3))


def classify_failure(git_dir, cwd):
    """Label a snapshot failure (AC-OPS-3); only reached off the common path."""
    if os.path.exists(os.path.join(git_dir, 'MERGE_HEAD')) or \
            os.path.exists(os.path.join(git_dir, 'rebase-merge')) or \
            os.path.exists(os.path.join(git_dir, 'rebase-apply')):
        return 'unresolved merge or rebase in progress'
    if os.path.exists(os.path.join(git_dir, 'index.lock')):
        return 'index-lock contention'
    verify = run_git(['rev-parse', '-q', '--verify', 'HEAD'], cwd)
    if verify is None or verify.returncode != 0:
        return 'unborn HEAD (no commit yet)'
    return 'other'


def log_failure(git_dir, cwd, state, stderr_text):
    """Durable, bounded, deduplicated trace (AC-OPS-5), inside .git/ so it
    never shows up in `git status`."""
    path = os.path.join(git_dir, FAILURE_LOG_NAME)
    entry = {
        'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'cwd': cwd, 'state': state, 'stderr': (stderr_text or '').strip(),
    }
    try:
        lines = []
        if os.path.exists(path):
            with open(path, 'r') as f:
                lines = [l for l in f.read().splitlines() if l]
        if lines:
            try:
                last = json.loads(lines[-1])
            except ValueError:
                last = None
            if last and last.get('state') == entry['state'] and \
                    last.get('stderr') == entry['stderr'] and last.get('cwd') == entry['cwd']:
                return  # identical to the immediately preceding failure; rate-limited
        lines.append(json.dumps(entry))
        lines = lines[-FAILURE_LOG_MAX_LINES:]
        with open(path, 'w') as f:
            f.write('\n'.join(lines) + '\n')
    except OSError:
        pass  # logging a failure must never itself become one


def prune(cwd, key):
    """Keep the newest KEEP_PER_CHECKOUT refs for this checkout only (AC-DATA-8, AC-ARCH-7)."""
    prefix = REF_PREFIX + key + '/'
    listing = run_git(['for-each-ref', '--sort=creatordate', '--format=%(refname)', prefix], cwd)
    if listing is None or listing.returncode != 0:
        return
    refs = [l for l in listing.stdout.splitlines() if l]
    excess = refs[:-KEEP_PER_CHECKOUT] if len(refs) > KEEP_PER_CHECKOUT else []
    if not excess:
        return
    run_git(['update-ref', '--stdin'], cwd, input_text=''.join('delete %s\n' % r for r in excess))
    run_git(['gc', '--auto', '--quiet'], cwd)


def snapshot(cwd):
    if os.environ.get(ESCAPE_VAR) == '1':
        return
    info = repo_info(cwd)
    if info is None:
        return  # not a usable work tree: not a repo, bare, or unreachable
    git_dir, toplevel = info
    key = checkout_key(git_dir)
    tmp_dir = tempfile.mkdtemp(prefix='harness-snapshot-')
    try:
        private_index = os.path.join(tmp_dir, 'index')
        try:
            shutil.copy2(os.path.join(git_dir, 'index'), private_index)
        except OSError:
            return  # no index yet (unborn checkout, nothing ever added); nothing to snapshot
        env = sanitized_git_env()
        env['GIT_INDEX_FILE'] = private_index
        result = run_git(['stash', 'create', 'harness-snapshot worktree=%s' % toplevel], cwd, env=env)
        if result is None:
            log_failure(git_dir, cwd, 'other', 'git stash create could not be run')
            return
        sha = result.stdout.strip()
        if result.returncode == 0 and sha == '':
            return  # clean tree: nothing to snapshot, not a failure
        if result.returncode != 0 or not SHA_RE.fullmatch(sha):
            log_failure(git_dir, cwd, classify_failure(git_dir, cwd), result.stderr)
            return
        ref_created = run_git(['update-ref', snapshot_ref_name(key), sha, ''], cwd)
        if ref_created is None or ref_created.returncode != 0:
            log_failure(git_dir, cwd, 'other', 'ref creation failed for snapshot %s' % sha)
            return
        prune(cwd, key)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unreadable payload; fail open
    if payload.get('tool_name') != 'Bash':
        sys.exit(0)
    cwd = payload.get('cwd') or os.getcwd()
    try:
        snapshot(cwd)
    except Exception:
        pass  # this hook must never block or fail a tool call (AC-SIMP-4, AC-OPS-1)
    sys.exit(0)


if __name__ == '__main__':
    main()
