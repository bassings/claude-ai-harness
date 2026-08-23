// PreToolUse hook (hooks/destructive-git-guard.py) refusing a Bash git
// command that would discard uncommitted work. The exact set of guarded
// shapes and the normalisation layer that finds them underneath shell
// noise (newlines, redirects, git global options, bundled short flags, a
// preceding `cd`) are documented ONCE, in the hook's own module docstring
// -- restating the list here drifted stale before (see L3 in the round-2
// review), so this file points at that copy instead of keeping its own.
// Built after an agent ran `git checkout -- <file>` on uncommitted work
// three times in one session and destroyed its own edits each time, despite
// docs/harn-opt-2-mutation-proofs.md forbidding it by name -- prose did not
// prevent it (standard 9: the rule wants a mechanism).
//
// Driven as a REAL subprocess against a REAL temp git repository, never by
// asserting on the hook's source text -- a guard that greps rather than
// executes is the exact failure this repo has hit repeatedly (see
// test/static-checks.test.js's own preamble on this).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { makeTempRepo, cleanupTempRepos, sh, sanitizedGitEnv } = require('./helpers/temp-repo.js')

test.after(cleanupTempRepos)

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'destructive-git-guard.py')
const ESCAPE_VAR = 'HARNESS_ALLOW_DESTRUCTIVE_GIT'

function runHook(payload, extraEnv = {}) {
  return spawnSync('python3', [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: sanitizedGitEnv(extraEnv),
    timeout: 10000,
  })
}

function bashPayload(command, cwd) {
  return { tool_name: 'Bash', tool_input: { command }, cwd, hook_event_name: 'PreToolUse' }
}

function makeDirtyFile(dir, rel = 'README.md') {
  const fs = require('node:fs')
  fs.writeFileSync(path.join(dir, rel), 'uncommitted change\n')
}

test('destructive-git-guard: git checkout -- <dirty file> is refused (exit 2, stderr names the danger)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -- README.md', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
  assert.match(res.stderr, /README\.md/)
  assert.match(res.stderr, /uncommitted/i)
})

test('destructive-git-guard: git checkout -- <clean file> is allowed (exit 0)', () => {
  const dir = makeTempRepo()
  const res = runHook(bashPayload('git checkout -- README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout . is refused when the tree is dirty', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout .', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout . is allowed on a clean tree', () => {
  const dir = makeTempRepo()
  const res = runHook(bashPayload('git checkout .', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout <existing-branch> (no --) is allowed on a clean tree', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  const res = runHook(bashPayload('git checkout other', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git restore <dirty file> is refused', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git restore README.md', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git restore <clean file> is allowed', () => {
  const dir = makeTempRepo()
  const res = runHook(bashPayload('git restore README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git restore --staged <path> is allowed even though the change is staged (it only unstages, never touches the worktree)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  sh('git add README.md', dir)
  const res = runHook(bashPayload('git restore --staged README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git restore --staged --worktree <path> IS refused (the --worktree flag means it also discards working-tree content)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  sh('git add README.md', dir)
  const res = runHook(bashPayload('git restore --staged --worktree README.md', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git reset --hard is refused when the tree is dirty', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git reset --hard', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git reset --hard is allowed on a clean tree', () => {
  const dir = makeTempRepo()
  const res = runHook(bashPayload('git reset --hard', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git reset --hard is allowed when only an UNTRACKED file exists (reset --hard cannot lose it)', () => {
  const dir = makeTempRepo()
  const fs = require('node:fs')
  fs.writeFileSync(path.join(dir, 'scratch-untracked.txt'), 'not tracked\n')
  const res = runHook(bashPayload('git reset --hard', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout -- <untracked file> is allowed (nothing git tracks would be lost)', () => {
  const dir = makeTempRepo()
  const fs = require('node:fs')
  fs.writeFileSync(path.join(dir, 'scratch-untracked.txt'), 'not tracked\n')
  const res = runHook(bashPayload('git checkout -- scratch-untracked.txt', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git log -- <path> is never intercepted (not checkout/restore/reset), even on a dirty tree', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git log -- README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: a destructive command chained after a harmless one is still caught (segment splitting)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('echo hi && git checkout -- README.md', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: destructive-looking text INSIDE A QUOTED ARGUMENT is not mistaken for a real invocation', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  sh('git add README.md', dir)
  const res = runHook(bashPayload('git commit -m "git checkout -- README.md"', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: the escape hatch, set INLINE in the command, allows a destructive command on a dirty tree', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload(`${ESCAPE_VAR}=1 git checkout -- README.md`, dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: the escape hatch, set as the hook PROCESS environment, allows a destructive command on a dirty tree', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -- README.md', dir), { [ESCAPE_VAR]: '1' })
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: a non-Bash tool call is never intercepted, even with a destructive-looking command field', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook({ tool_name: 'Read', tool_input: { file_path: 'git checkout -- README.md' }, cwd: dir })
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: the refusal message names a safe alternative (scratch copy or git stash) and the escape-hatch variable', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -- README.md', dir))
  assert.equal(res.status, 2)
  assert.match(res.stderr, /stash/i)
  assert.match(res.stderr, new RegExp(ESCAPE_VAR))
})

// --- Bare pathspec (no `--`): `git checkout <file>` is shorter than
// `git checkout -- <file>` and is the form an agent is more likely to type.
// Measured against a real repo (see docs/destructive-git-guard-mutation-proofs.md):
// git resolves a single checkout argument as a REF if one matches, and as a
// PATHSPEC only if no ref matches -- these tests pin that precedence.

test('destructive-git-guard: git checkout <dirty file>, bare pathspec with no --, is refused', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout README.md', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
  assert.match(res.stderr, /README\.md/)
})

test('destructive-git-guard: git checkout <clean file>, bare pathspec with no --, is allowed', () => {
  const dir = makeTempRepo()
  const res = runHook(bashPayload('git checkout README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout <dir>/, bare directory pathspec, is refused when a tracked file under it is dirty', () => {
  const dir = makeTempRepo()
  const fs = require('node:fs')
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'seed\n')
  sh('git add src/a.txt && git commit -q -m addsrc', dir)
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'dirty\n')
  const res = runHook(bashPayload('git checkout src/', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout HEAD <dirty file> (leading ref, trailing path, no --) is refused', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout HEAD README.md', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout HEAD <clean file> (leading ref, trailing path, no --) is allowed', () => {
  const dir = makeTempRepo()
  const res = runHook(bashPayload('git checkout HEAD README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: an argument that is BOTH a valid branch name and an existing dirty file is treated as a ref (git\'s own precedence), not a pathspec -- allowed', () => {
  const dir = makeTempRepo()
  sh('git branch README.md', dir)
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

// --- Forced checkout/switch: `-f`/`--force` (checkout) and
// `-f`/`--force`/`--discard-changes` (switch) discard uncommitted changes
// tree-wide, exactly like `git reset --hard`. Measured against a real repo.

test('destructive-git-guard: git checkout -f <branch> is refused on a dirty tree', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -f other', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout --force <branch> is refused on a dirty tree', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout --force other', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: bare git checkout -f (no branch, no path) is refused on a dirty tree', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -f', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git switch -f <branch> is refused on a dirty tree', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git switch -f other', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git switch --force <branch> is refused on a dirty tree', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git switch --force other', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git switch --discard-changes <branch> is refused on a dirty tree', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git switch --discard-changes other', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout -f <branch> is allowed on a clean tree', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  const res = runHook(bashPayload('git checkout -f other', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git switch -f <branch> is allowed on a clean tree', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  const res = runHook(bashPayload('git switch -f other', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

// --- False-positive floor: these must stay ALLOWED. A guard that blocks
// harmless commands gets disabled, which is worse than the hole it fixes.

test('destructive-git-guard: git checkout -b <branch> is still allowed on a dirty tree (floor, unaffected by the ref/pathspec fix)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -b another-new-branch', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout <existing-branch> is allowed on a dirty tree when the checkout is legal (no divergent content to lose)', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout other', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git switch <branch> (no force) is allowed on a dirty tree when the switch is legal', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git switch other', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout -b <name-that-collides-with-a-dirty-tracked-file> is still allowed (branch creation, not a restore, even when the new branch name collides with an existing dirty path)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -b README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git status is never intercepted, even on a dirty tree', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git status', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git diff is never intercepted, even on a dirty tree', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git diff', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

// --- Normalisation layer: a newline is a command separator, exactly like
// `&&`/`;` -- the round-2 review's H1. A multi-line Bash call is the
// ordinary shape of agent tool use, so a destructive command below the
// first line must be caught the same way a chained one already is.

test('destructive-git-guard: a destructive command on the SECOND LINE of a multi-line command is still caught (newline as a separator, H1)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('echo hi\ngit checkout -- README.md', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
  assert.match(res.stderr, /README\.md/)
})

test('destructive-git-guard: a harmless command on the second line of a multi-line command that starts with a refusal is still allowed once the tree is clean', () => {
  const dir = makeTempRepo()
  const res = runHook(bashPayload('git status\ngit reset --hard', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git reset --hard on the second line of a multi-line command is refused on a dirty tree (newline, second guarded shape)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git status\ngit reset --hard', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

// --- Normalisation layer: git global options between the binary and the
// subcommand must not hide the subcommand from the matcher (H2).

test('destructive-git-guard: git -C <path> checkout -- <dirty file> is refused (global option between binary and subcommand, H2)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git -C . checkout -- README.md', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git --no-pager checkout -- <dirty file> is refused (global option, H2)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git --no-pager checkout -- README.md', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git -c <k>=<v> checkout -- <dirty file> is refused (global option with its own value, H2)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git -c foo.bar=baz checkout -- README.md', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: an ABSOLUTE path to the git binary is still recognised by basename (H2)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const gitPath = sh('command -v git', dir).trim()
  const res = runHook(bashPayload(`${gitPath} checkout -- README.md`, dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git -C <other dirty repo> checkout -- <path>, run from a CLEAN cwd, is refused against the -C target, not the payload cwd (H2 + M1)', () => {
  const cleanDir = makeTempRepo()
  const otherDir = makeTempRepo()
  makeDirtyFile(otherDir)
  const res = runHook(bashPayload(`git -C ${otherDir} checkout -- README.md`, cleanDir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git -C <path> checkout -- <clean file> is allowed (global option does not over-block)', () => {
  const dir = makeTempRepo()
  const res = runHook(bashPayload('git -C . checkout -- README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

// --- Normalisation layer: bundled short flags (`-fq`) must still be
// recognised as force (H5).

test('destructive-git-guard: git checkout -fq <branch>, force bundled with an unrelated short flag, is refused on a dirty tree (H5)', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -fq other', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout -fb <new-branch>, force bundled with branch-creation, is refused on a dirty tree (H5, force overrides the -b carve-out even bundled)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -fb newbr', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git switch -fq <branch>, bundled force, is refused on a dirty tree (H5)', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git switch -fq other', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: a bundled short flag that does NOT include force (e.g. a hypothetical -q alone) does not falsely trigger tree-wide scoping on its own', () => {
  const dir = makeTempRepo()
  sh('git branch other', dir)
  const res = runHook(bashPayload('git checkout -q other', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: a pathspec after `--` that LOOKS like a bundled flag cluster (a file literally named -abc) is never shredded by bundle expansion', () => {
  const dir = makeTempRepo()
  const fs = require('node:fs')
  fs.writeFileSync(path.join(dir, '-abc'), 'seed\n')
  sh('git add -- -abc && git commit -q -m addit', dir)
  fs.writeFileSync(path.join(dir, '-abc'), 'dirty\n')
  const res = runHook(bashPayload('git checkout -- -abc', dir))
  assert.equal(res.status, 2, `expected exit 2 (the file itself is dirty and must still be scoped as a path, not treated as flags), got ${res.status}; stderr: ${res.stderr}`)
})

// --- Normalisation layer: a shell redirect must not smuggle its target
// into the pathspec list, and a pathspec git rejects must never become a
// licence for the destructive command (M2).

test('destructive-git-guard: git checkout -- <dirty file> > /dev/null is refused (redirect target dropped before scoping, M2)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -- README.md > /dev/null', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout -- <clean file> > /dev/null is allowed (redirect target dropped, no false block)', () => {
  const dir = makeTempRepo()
  const res = runHook(bashPayload('git checkout -- README.md > /dev/null', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: a pathspec git itself rejects (naming a path OUTSIDE the repository) does not fail the check open when the tree is genuinely dirty elsewhere (M2, narrowed fail-open)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -- /etc/hostname', dir))
  assert.equal(res.status, 2, `expected exit 2 (retried tree-wide once the named pathspec was rejected), got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: a pathspec git itself rejects is still allowed when the tree is ACTUALLY clean (the tree-wide retry does not itself over-block)', () => {
  const dir = makeTempRepo()
  const res = runHook(bashPayload('git checkout -- /etc/hostname', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

// --- Normalisation layer: `--pathspec-from-file` reaches the same revert
// with no non-flag token on the command line at all -- scoped tree-wide (L1).

test('destructive-git-guard: git checkout --pathspec-from-file=<file> is refused on a dirty tree (no non-flag token to scope against, L1)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const fs = require('node:fs')
  fs.writeFileSync(path.join(dir, 'paths.txt'), 'README.md\n')
  const res = runHook(bashPayload('git checkout --pathspec-from-file=paths.txt', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout --pathspec-from-file=<file> is allowed on a clean tree', () => {
  const dir = makeTempRepo()
  const fs = require('node:fs')
  fs.writeFileSync(path.join(dir, 'paths.txt'), 'README.md\n')
  const res = runHook(bashPayload('git checkout --pathspec-from-file=paths.txt', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git restore --pathspec-from-file=<file> is refused on a dirty tree (same hole, restore branch, L1)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const fs = require('node:fs')
  fs.writeFileSync(path.join(dir, 'paths.txt'), 'README.md\n')
  const res = runHook(bashPayload('git restore --pathspec-from-file=paths.txt', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

// --- Escape hatch, tightened (H4): a genuine env-prefix assignment on the
// SAME segment still opts out; a textual mention anywhere else in the
// command -- quoted, commented, or prefixed to a DIFFERENT segment -- must
// not disarm a refusal it was never meant to cover.

test('destructive-git-guard: the escape hatch as a genuine env-prefix on the SAME segment still allows the command (control, must not regress)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload(`${ESCAPE_VAR}=1 git checkout -- README.md`, dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: the escape hatch variable QUOTED inside an unrelated command does NOT disarm a later destructive segment (H4)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload(`echo "${ESCAPE_VAR}=1" && git checkout -- README.md`, dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: the escape hatch variable mentioned in a trailing shell COMMENT does NOT disarm the command it is appended to (H4)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload(`git checkout -- README.md   # ${ESCAPE_VAR}=1`, dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: the escape hatch, set as an env-prefix on a DIFFERENT segment, does NOT disarm a destructive command on a later segment (H4)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload(`${ESCAPE_VAR}=1 git status && git checkout -- README.md`, dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: the escape hatch variable named inside a grep\'s search text does NOT disarm a destructive command chained after it (H4)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload(`grep -rn "${ESCAPE_VAR}=1" . ; git checkout -- README.md`, dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

// --- `cd` in the same chain (M1): scope against the `cd` target, not the
// payload cwd. Closes both a bypass (target repo's dirt was invisible) and
// a false positive (an unrelated repo's dirt caused a refusal for a
// command that never touched it).

test('destructive-git-guard: cd <other dirty repo> && git checkout -- <path> is refused against the cd TARGET, even though the payload cwd is clean (M1 bypass direction)', () => {
  const cleanDir = makeTempRepo()
  const dirtyDir = makeTempRepo()
  makeDirtyFile(dirtyDir)
  const res = runHook(bashPayload(`cd ${dirtyDir} && git checkout -- README.md`, cleanDir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: cd /tmp && git checkout -- <path> is ALLOWED when the payload cwd is dirty but /tmp is not what the command touches (M1 false-positive direction)', () => {
  const dirtyDir = makeTempRepo()
  makeDirtyFile(dirtyDir)
  const res = runHook(bashPayload('cd /tmp && git checkout -- README.md', dirtyDir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: cd into a clean RELATIVE subdirectory then a destructive command is allowed (cd target resolved and genuinely clean)', () => {
  const dir = makeTempRepo()
  const fs = require('node:fs')
  fs.mkdirSync(path.join(dir, 'sub'))
  const res = runHook(bashPayload('cd sub && git status', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

// AC-SIMP-10: the hard refusal on an unresolvable `cd` target is DELETED,
// not extended -- irrecoverable data loss is now covered by the recovery
// mechanism (hooks/git-snapshot.py), which does not need to resolve the
// `cd` at all, so refusing here traded a real but rare gap for a false
// positive on every ordinary dynamic `cd`. These two cases now fail OPEN.

test('destructive-git-guard: cd "$SOME_VAR" && git checkout -- <path> is now ALLOWED -- the target cannot be resolved statically, so the guard fails open rather than refusing an unknown directory (AC-SIMP-10)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('cd "$SOME_VAR" && git checkout -- README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: cd - && git checkout -- <path> is now ALLOWED -- "the previous directory" is not statically resolvable either, and this no longer refuses (AC-SIMP-10)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('cd - && git checkout -- README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: an unresolvable cd followed by a HARMLESS git command is still allowed (the fail-closed direction only applies to guarded shapes)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('cd "$SOME_VAR" && git status', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

// --- Counterweight floor (must all stay ALLOWED): additional shapes named
// explicitly in the round-2 brief that had no dedicated test yet.

test('destructive-git-guard: git log --oneline is never intercepted, even on a dirty tree', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git log --oneline', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git add <file> is never intercepted, even on a dirty tree', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git add README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git stash is never intercepted, even on a dirty tree', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git stash', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: grep -r checkout . is never intercepted (not a git invocation at all)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('grep -r checkout .', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git checkout -B <branch> is allowed even on a dirty tree (branch creation/reset-to, not a restore)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -B another-branch', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git commit -m "git checkout README.md" is never intercepted (destructive-looking text stays inside its own quoted argument)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  sh('git add README.md', dir)
  const res = runHook(bashPayload('git commit -m "git checkout README.md"', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

// --- Restore's short-flag spellings (L2): implemented (they normalize
// through the same bundled-flag path as checkout/switch) but previously had
// no dedicated test of their own.

test('destructive-git-guard: git restore -S <staged dirty file> (short form of --staged) is allowed -- it only unstages', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  sh('git add README.md', dir)
  const res = runHook(bashPayload('git restore -S README.md', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard: git restore -W <dirty file> (short form of --worktree) IS refused -- it touches the working tree', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git restore -W README.md', dir))
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr: ${res.stderr}`)
})

// --- M3: the hook's own duplicated GIT_* allowlist must not silently
// drift from test/helpers/git-env.js's, and a leaked GIT_DIR/GIT_WORK_TREE
// must still be stripped before the status check that decides refusal.

test('destructive-git-guard: a leaked GIT_DIR/GIT_WORK_TREE pointed at a second, CLEAN repo does not fool the guard into reading that repo instead of the dirty cwd (M3)', () => {
  const dirtyDir = makeTempRepo()
  makeDirtyFile(dirtyDir)
  const cleanDir = makeTempRepo()
  const res = spawnSync('python3', [HOOK_PATH], {
    input: JSON.stringify(bashPayload('git checkout -- README.md', dirtyDir)),
    encoding: 'utf8',
    // Deliberately NOT sanitizedGitEnv() here: that helper strips GIT_* from
    // the env it builds, which would prevent this test from ever reaching
    // the hook's OWN stripping logic. This constructs the leaked-GIT_DIR
    // environment directly, exactly as a real leaked variable would arrive.
    env: { ...process.env, GIT_DIR: path.join(cleanDir, '.git'), GIT_WORK_TREE: cleanDir },
    timeout: 10000,
  })
  assert.equal(res.status, 2, `expected exit 2 (the hook must strip GIT_DIR/GIT_WORK_TREE before its own status check), got ${res.status}; stderr: ${res.stderr}`)
})

// AC-ARCH-3: enumerates hooks/*.py rather than naming a single file, so a
// SECOND git-invoking hook (hooks/git-snapshot.py) that ever drops its own
// scrub fails this test by name, not just the one this test used to know
// about. "Shells out to git" is detected structurally (calls subprocess AND
// mentions the string 'git'), not by a hand-maintained file list, which is
// exactly the blindness this test used to have (M3, drift guard on the
// deliberate duplication).
test('destructive-git-guard AC-ARCH-3: every hooks/*.py that shells out to git strips the GIT_* namespace to the SAME allowlist as test/helpers/git-env.js', () => {
  const { GIT_ENV_ALLOWLIST } = require('./helpers/git-env.js')
  const hooksDir = path.join(__dirname, '..', 'hooks')
  const pyFiles = fs.readdirSync(hooksDir).filter((f) => f.endsWith('.py'))
  assert.ok(pyFiles.length >= 2, `sanity: expected at least 2 hooks/*.py files, found ${pyFiles.length}`)

  const gitInvoking = pyFiles.filter((f) => {
    const src = fs.readFileSync(path.join(hooksDir, f), 'utf8')
    return /subprocess\.(run|Popen|check_output|call)/.test(src) && /['"]git['"]/.test(src)
  })
  assert.ok(gitInvoking.length >= 2, `sanity: expected at least 2 git-invoking hooks (destructive-git-guard.py, git-snapshot.py), found: ${gitInvoking}`)

  for (const f of gitInvoking) {
    const pyResult = spawnSync('python3', ['-c',
      'import importlib.util, json, sys\n' +
      'spec = importlib.util.spec_from_file_location("hook", sys.argv[1])\n' +
      'hook = importlib.util.module_from_spec(spec)\n' +
      'spec.loader.exec_module(hook)\n' +
      'print(json.dumps(sorted(getattr(hook, "GIT_ENV_ALLOWLIST", None) and hook.GIT_ENV_ALLOWLIST or [])))\n',
      path.join(hooksDir, f),
    ], { encoding: 'utf8' })
    assert.equal(pyResult.status, 0, `failed to introspect ${f}'s allowlist: ${pyResult.stderr}`)
    const pyAllowlist = JSON.parse(pyResult.stdout)
    assert.notDeepEqual(pyAllowlist, [], `${f} shells out to git but declares no GIT_ENV_ALLOWLIST at all -- a leaked GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE could redirect it to the wrong repository`)
    assert.deepEqual(pyAllowlist, [...GIT_ENV_ALLOWLIST].sort(), `${f}'s GIT_ENV_ALLOWLIST has drifted from test/helpers/git-env.js's -- both must name the same set deliberately`)
  }
})

// --- AC-PROD-3: the refusal message names the route to recovery. ---

test('destructive-git-guard AC-PROD-3: the refusal message names the exact recovery command README documents for hooks/git-snapshot.py', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -- README.md', dir))
  assert.equal(res.status, 2)
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  const m = readme.match(/^git for-each-ref --format='%\(refname\)[^\n]*refs\/harness-snapshots\/$/m)
  assert.ok(m, 'README must document the list-snapshots command as its own line')
  assert.ok(res.stderr.includes(m[0]), `refusal stderr must contain README's exact recovery command.\nstderr: ${res.stderr}\nREADME command: ${m[0]}`)
})

// --- AC-PROD-6: writing or quoting a guarded command as inert text is not
// refused (RED at HEAD before the heredoc-body-stripping fix: a here-doc
// body merely mentioning a guarded command was refused although nothing
// executes). ---

test('destructive-git-guard AC-PROD-6: a guarded command mentioned inside a here-document BODY is not refused (nothing there executes)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload("cat <<'DOC'\ngit checkout -- README.md\nDOC\necho done", dir))
  assert.equal(res.status, 0, `expected exit 0 (heredoc body is inert text), got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard AC-PROD-6: a guarded command mentioned inside a QUOTED string is not refused', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('echo "reminder: never run git checkout -- README.md on dirty work"', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard AC-PROD-6: a guarded command mentioned as a grep argument is not refused', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('grep -r "git checkout -- README.md" docs/ || true', dir))
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`)
})

test('destructive-git-guard AC-PROD-6: a here-document body cannot be used to SMUGGLE a real destructive command past the guard on the marker line itself', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  // The heredoc BODY is stripped, but the command on the marker's OWN line
  // (before the `<<`) must still be evaluated normally.
  const res = runHook(bashPayload("git checkout -- README.md <<'DOC'\nharmless text\nDOC", dir))
  assert.equal(res.status, 2, `a real destructive command on the heredoc's own marker line must still be refused, got ${res.status}`)
})
