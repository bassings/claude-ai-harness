// PreToolUse hook (hooks/destructive-git-guard.py) refusing a Bash git
// command that would discard uncommitted work: `git checkout -- <path>`,
// `git checkout .`, `git restore <path>` (without `--staged` alone), and
// `git reset --hard`. Built after an agent ran `git checkout -- <file>` on
// uncommitted work three times in one session and destroyed its own edits
// each time, despite docs/harn-opt-2-mutation-proofs.md forbidding it by
// name -- prose did not prevent it (standard 9: the rule wants a mechanism).
//
// Driven as a REAL subprocess against a REAL temp git repository, never by
// asserting on the hook's source text -- a guard that greps rather than
// executes is the exact failure this repo has hit repeatedly (see
// test/static-checks.test.js's own preamble on this).
const test = require('node:test')
const assert = require('node:assert/strict')
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

test('destructive-git-guard: git checkout -b <branch> is allowed even on a dirty tree (branch creation, not a restore)', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  const res = runHook(bashPayload('git checkout -b some-new-branch', dir))
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

test('destructive-git-guard: git restore --staged (no other flag) alone is allowed regardless of dirt, matching the "without --staged alone" carve-out precisely', () => {
  const dir = makeTempRepo()
  makeDirtyFile(dir)
  sh('git add README.md', dir)
  const res = runHook(bashPayload('git restore --staged README.md', dir))
  assert.equal(res.status, 0)
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
