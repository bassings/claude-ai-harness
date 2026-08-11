// Integration tests for workflows/lib/optimise-report-ignore.mjs -- the
// real-Node helper the report:write agent step invokes (via Bash) before
// writing the optimiser's own report artefact, mirroring
// workflows/lib/ledger-append.mjs's ensureGitignored + check-ignore
// discipline (review round-1 M1: the report had no such protection, while
// both SKILL.md and optimise-cycle.js claimed "same convention as the
// ledger"). Tested the same way AC-SEC-1 tests the ledger's own ignore
// mechanism: against a real git repo, with real `git check-ignore`.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const { makeTempRepo, sh, cleanupTempRepos } = require('./helpers/temp-repo.js')

const MODULE_PATH = path.join(__dirname, '..', 'workflows', 'lib', 'optimise-report-ignore.mjs')
const REPORT_REL = '.claude/optimise-cycle-report.md'

test.after(cleanupTempRepos)

function runEnsureIgnored(repo, relativePath = REPORT_REL) {
  return spawnSync('node', [MODULE_PATH, repo, relativePath], { encoding: 'utf8' })
}

test('optimise-report-ignore: ensures a fresh repo\'s report path becomes gitignored via .git/info/exclude, and reports ignored:true', () => {
  const repo = makeTempRepo()
  const res = runEnsureIgnored(repo)
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.ignored, true)
  assert.equal(out.error, null)
  const checkIgnore = spawnSync('git', ['check-ignore', '-q', REPORT_REL], { cwd: repo })
  assert.equal(checkIgnore.status, 0, 'git check-ignore must exit 0 for the report path after ensure-ignored ran')
})

test('optimise-report-ignore: never stages, commits, or modifies any tracked file -- only .git/info/exclude changes', () => {
  const repo = makeTempRepo()
  const statusBefore = sh('git status --porcelain', repo)
  runEnsureIgnored(repo)
  const statusAfter = sh('git status --porcelain', repo)
  assert.equal(statusBefore, '', 'sanity: clean before')
  assert.equal(statusAfter, '', 'git status must show nothing after ensure-ignored -- .git/info/exclude is untracked and repo-local')
})

test('optimise-report-ignore: running twice is idempotent -- the exclude file gains no duplicate line', () => {
  const repo = makeTempRepo()
  runEnsureIgnored(repo)
  runEnsureIgnored(repo)
  const excludeContents = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
  const occurrences = excludeContents.split('\n').filter((l) => l.trim() === REPORT_REL).length
  assert.equal(occurrences, 1)
})

test('optimise-report-ignore: reports ignored:false and does NOT falsely claim success when a tracked .gitignore re-includes the path with a negation pattern (mirrors ledger-append.mjs\'s L1 check-ignore verification)', () => {
  const repo = makeTempRepo()
  fs.writeFileSync(path.join(repo, '.gitignore'), `!${REPORT_REL}\n`)
  sh('git add .gitignore && git commit -q -m gitignore', repo)
  const res = runEnsureIgnored(repo)
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.ignored, false, 'a negation pattern in a tracked .gitignore must be detected, not silently reported as success')
  assert.ok(out.error && out.error.length > 0)
})

test('optimise-report-ignore: works for a path other than the optimiser\'s own report (parameterised, not hardcoded)', () => {
  const repo = makeTempRepo()
  const res = runEnsureIgnored(repo, '.claude/some-other-file.txt')
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.ignored, true)
  const checkIgnore = spawnSync('git', ['check-ignore', '-q', '.claude/some-other-file.txt'], { cwd: repo })
  assert.equal(checkIgnore.status, 0)
})
