// Executes the REAL .githooks/pre-commit hook against real, throwaway git
// repos (specs/harn-fix-3.md AC-ARCH-1, AC-ARCH-3). A hook is a shell
// script that only matters once it actually runs -- see this repo's own
// pre-push hook tests for the identical rationale (H2 from review round 2:
// asserting on the hook's TEXT proved nothing about its behaviour, and two
// one-line mutations that changed behaviour left every text assertion
// green).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { sh, makeTempRepo, sanitizedGitEnv, cleanupTempRepos, trackTempDir, SUITE_TMPDIR } = require('./helpers/temp-repo.js')

test.after(cleanupTempRepos)

const HOOK_SRC = path.join(__dirname, '..', '.githooks', 'pre-commit')

const AGENT_HARNESS_STUB = '# Multi-lens agent harness\n\n<!-- SOURCE_COMMIT: 0000000000000000000000000000000000000000 -->\n\nprose\n'
const PLAN_STUB = "export const meta = { name: 'plan-cycle' }\n\nconst SOURCE_COMMIT = '0000000000000000000000000000000000000000'\n"
const REVIEW_STUB = "export const meta = { name: 'review-cycle' }\n\nconst SOURCE_COMMIT = '0000000000000000000000000000000000000000'\n"

function installHook(repoDir) {
  const dest = path.join(repoDir, '.git', 'hooks', 'pre-commit')
  fs.copyFileSync(HOOK_SRC, dest)
  fs.chmodSync(dest, 0o755)
}

function readStampFromMd(text) {
  const m = /<!-- SOURCE_COMMIT: ([0-9a-f]{40}) -->/.exec(text)
  return m ? m[1] : null
}
function readStampFromJs(text) {
  const m = /const SOURCE_COMMIT = '([0-9a-f]{40})'/.exec(text)
  return m ? m[1] : null
}

function writeStampTargets(repoDir) {
  fs.writeFileSync(path.join(repoDir, 'AGENT-HARNESS.md'), AGENT_HARNESS_STUB)
  fs.mkdirSync(path.join(repoDir, 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'workflows', 'plan-cycle.js'), PLAN_STUB)
  fs.writeFileSync(path.join(repoDir, 'workflows', 'review-cycle.js'), REVIEW_STUB)
}

function readAllStamped(repoDir) {
  return {
    md: fs.readFileSync(path.join(repoDir, 'AGENT-HARNESS.md'), 'utf8'),
    plan: fs.readFileSync(path.join(repoDir, 'workflows', 'plan-cycle.js'), 'utf8'),
    review: fs.readFileSync(path.join(repoDir, 'workflows', 'review-cycle.js'), 'utf8'),
  }
}

test('pre-commit: stamps all three files with the value `git rev-parse HEAD` reported IMMEDIATELY BEFORE the commit was formed -- AC-ARCH-1\'s own test, run by executing the real hook, not by reading its source', () => {
  const repo = makeTempRepo() // seed commit (README.md) already exists
  const parentSha = sh('git rev-parse HEAD', repo).trim()
  installHook(repo)
  writeStampTargets(repo)
  sh('git add AGENT-HARNESS.md workflows/plan-cycle.js workflows/review-cycle.js', repo)
  sh('git commit -q -m "add harness files"', repo)

  const { md, plan, review } = readAllStamped(repo)
  assert.equal(readStampFromMd(md), parentSha, 'AGENT-HARNESS.md must carry the HEAD value observed before this commit')
  assert.equal(readStampFromJs(plan), parentSha, 'plan-cycle.js must carry the same value')
  assert.equal(readStampFromJs(review), parentSha, 'review-cycle.js must carry the same value')
})

test('pre-commit: the stamp is a commit identity, not an age -- 40 lowercase hex characters, never a date/timestamp shape (AC-ARCH-3)', () => {
  const repo = makeTempRepo()
  installHook(repo)
  writeStampTargets(repo)
  sh('git add AGENT-HARNESS.md workflows/plan-cycle.js workflows/review-cycle.js', repo)
  sh('git commit -q -m "add harness files"', repo)

  const { md } = readAllStamped(repo)
  const stamp = readStampFromMd(md)
  assert.match(stamp, /^[0-9a-f]{40}$/, 'the stamp must be a full 40-character hex commit sha')
  assert.doesNotMatch(stamp, /\d{4}-\d{2}-\d{2}/, 'the stamp must never look like a date')
})

test('pre-commit: the stamp is the PARENT commit\'s hash, documented and provable to differ from the containing commit\'s own hash (a commit cannot embed its own hash)', () => {
  const repo = makeTempRepo()
  const parentSha = sh('git rev-parse HEAD', repo).trim()
  installHook(repo)
  writeStampTargets(repo)
  sh('git add AGENT-HARNESS.md workflows/plan-cycle.js workflows/review-cycle.js', repo)
  sh('git commit -q -m "add harness files"', repo)
  const containingCommitSha = sh('git rev-parse HEAD', repo).trim()

  assert.notEqual(containingCommitSha, parentSha, 'sanity: the commit that carries the stamp must be a NEW commit, distinct from its parent')
  const { md } = readAllStamped(repo)
  assert.equal(readStampFromMd(md), parentSha, 'the stamp names the parent, never the commit it ships inside')
})

test('pre-commit: runs UNCONDITIONALLY -- a commit that only touches an unrelated file still re-stamps all three files to the NEW parent, and includes that re-stamp in the SAME commit even though only the unrelated file was staged by hand', () => {
  const repo = makeTempRepo()
  installHook(repo)
  writeStampTargets(repo)
  sh('git add AGENT-HARNESS.md workflows/plan-cycle.js workflows/review-cycle.js', repo)
  sh('git commit -q -m "add harness files"', repo)
  const firstStampedCommitSha = sh('git rev-parse HEAD', repo).trim()

  // Only README.md is staged by hand -- the hook must still re-stamp and
  // `git add` the three files itself.
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\nchanged\n')
  sh('git add README.md', repo)
  sh('git commit -q -m "unrelated change"', repo)

  const changedFiles = sh('git show --name-only --format= HEAD', repo).trim().split('\n').filter(Boolean).sort()
  assert.deepEqual(
    changedFiles,
    ['AGENT-HARNESS.md', 'README.md', 'workflows/plan-cycle.js', 'workflows/review-cycle.js'],
    'the unconditional hook must fold the re-stamp into the SAME commit as the unrelated change, even though only README.md was staged by hand'
  )
  const { md, plan, review } = readAllStamped(repo)
  assert.equal(readStampFromMd(md), firstStampedCommitSha)
  assert.equal(readStampFromJs(plan), firstStampedCommitSha)
  assert.equal(readStampFromJs(review), firstStampedCommitSha)
})

test('pre-commit: a file with no marker line at all is left byte-for-byte untouched (no crash, no corruption) -- e.g. a repo mid-rollout before the marker exists', () => {
  const repo = makeTempRepo()
  installHook(repo)
  const unmarked = '# Multi-lens agent harness\n\nno marker here at all\n'
  fs.writeFileSync(path.join(repo, 'AGENT-HARNESS.md'), unmarked)
  sh('git add AGENT-HARNESS.md', repo)
  sh('git commit -q -m "add harness doc with no marker yet"', repo)
  const after = fs.readFileSync(path.join(repo, 'AGENT-HARNESS.md'), 'utf8')
  assert.equal(after, unmarked)
})

test('pre-commit: a repo with none of the three target files present does not fail the commit', () => {
  const repo = makeTempRepo()
  installHook(repo)
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'hello\n')
  sh('git add unrelated.txt', repo)
  // sh() throws (execFileSync) on non-zero exit, so a hook failure here would surface as a thrown error, not a silent skip.
  assert.doesNotThrow(() => sh('git commit -q -m "unrelated only"', repo))
})

test('pre-commit: leaves no .stamptmp scratch files behind after a run', () => {
  const repo = makeTempRepo()
  installHook(repo)
  writeStampTargets(repo)
  sh('git add AGENT-HARNESS.md workflows/plan-cycle.js workflows/review-cycle.js', repo)
  sh('git commit -q -m "add harness files"', repo)
  const leftovers = sh('find . -name "*.stamptmp"', repo).trim()
  assert.equal(leftovers, '', `expected no leftover .stamptmp files, found: ${leftovers}`)
})

test('pre-commit: the very FIRST commit in a repo (no parent at all) falls back to the documented all-zero sha, rather than failing the commit', () => {
  // Deliberately NOT makeTempRepo() (which seeds a commit before returning):
  // this needs a repo with genuinely no HEAD yet.
  const dir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'repo-nofirstcommit-'))
  trackTempDir(dir)
  sh('git init -q -b main', dir)
  sh('git config user.email test@example.com', dir)
  sh('git config user.name Test', dir)
  installHook(dir)
  writeStampTargets(dir)
  sh('git add AGENT-HARNESS.md workflows/plan-cycle.js workflows/review-cycle.js', dir)
  assert.doesNotThrow(() => sh('git commit -q -m "first commit ever"', dir))
  const { md, plan, review } = readAllStamped(dir)
  const NULL_SHA = '0000000000000000000000000000000000000000'
  assert.equal(readStampFromMd(md), NULL_SHA)
  assert.equal(readStampFromJs(plan), NULL_SHA)
  assert.equal(readStampFromJs(review), NULL_SHA)
})
