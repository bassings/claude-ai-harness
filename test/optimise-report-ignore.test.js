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

// HARN-RUNNER-2 T3: the report and sidecar paths are made ignored by two runners
// at once. The read-modify-write (read the file, then rewrite all of it) let one
// writer's rewrite erase the other's line, or let a reader see the file half
// written, so a caller's own check-ignore failed. Every caller must come out
// with its own path ignored, and no line may be lost.
const { spawn } = require('node:child_process')

function ensureAsync(repo, relativePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MODULE_PATH, repo, relativePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

test('optimise-report-ignore: many callers at once on one repository each end with their own path ignored and no exclude line lost', async () => {
  // Three repositories at once, 32 callers each, so the contention is high and one run is enough to show the race.
  await Promise.all([0, 1, 2].map(async (round) => {
    const repo = makeTempRepo()
    const paths = Array.from({ length: 32 }, (_, i) => `.claude/stress-output-${i}.md`)
    const results = await Promise.all(paths.map((p) => ensureAsync(repo, p)))
    const failures = results.map((r, i) => ({ path: paths[i], r })).filter(({ r }) => r.code !== 0 || JSON.parse(r.out.trim()).ignored !== true)
    assert.deepEqual(failures.map((f) => f.path), [], `round ${round}: every caller must be told its path is ignored`)
    const lines = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').map((l) => l.trim())
    assert.deepEqual(paths.filter((p) => !lines.includes(p)), [], `round ${round}: no caller's line may be lost from the exclude file`)
    for (const p of paths) assert.equal(spawnSync('git', ['check-ignore', '-q', p], { cwd: repo }).status, 0, `${p} is ignored afterwards`)
  }))
})

test('optimise-report-ignore: many callers all asking for the same path leave it ignored and every one succeeds', async () => {
  const repo = makeTempRepo()
  const results = await Promise.all(Array.from({ length: 24 }, () => ensureAsync(repo, REPORT_REL)))
  for (const r of results) assert.equal(JSON.parse(r.out.trim()).ignored, true, r.out)
  assert.equal(spawnSync('git', ['check-ignore', '-q', REPORT_REL], { cwd: repo }).status, 0)
})
