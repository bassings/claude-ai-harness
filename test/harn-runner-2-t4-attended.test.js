// HARN-RUNNER-2 T4 (specs/harn-runner-2.md): what the attended entry of the result check does at its edges, and the command-line
// forms the weekly runner shares with it (lock-try, unlock, place). test/harn-runner-2-t4.test.js holds the main behaviour; this
// file pins the refusals around it (a linked worktree, an ignore rule that does not hold, a result file that is a link) and the
// shared forms, so a second copy of the lock or the placement cannot creep back in unseen.
// Every fixture commit carries an explicit identity. Figures a test expects come from its own fixtures.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { cleanupTempRepos, sanitizedGitEnv } = require('./helpers/temp-repo.js')
const SB = require('./helpers/weekly-sandbox.js')
const T2 = require('./helpers/t2-fixtures.js')

const { F, ROOT, REPORT_REL, SIDECAR_REL, freshDir } = SB
const VERIFY = path.join(ROOT, 'workflows', 'lib', 'optimise-verify.mjs')
const AUTHOR = 'canary-author@example.invalid'
const load = () => import(pathToFileURL(VERIFY).href)

test.after(cleanupTempRepos)

function ghStubs() {
  const stubs = F.makeStubs()
  const runs = [11, 12].map((id) => F.run(id))
  F.setGhRuns(stubs, runs, Object.fromEntries(runs.map((r) => [r.databaseId, { jobs: [F.job('build'), F.job('test')] }])))
  return stubs
}

// A collected repository and the workflow's returned object for its digest, saved unchanged in a private per-run directory.
async function attendedRun(repo = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })) {
  const { outDir } = F.collect(ghStubs(), repo)
  const perRun = freshDir('attended-')
  fs.chmodSync(perRun, 0o700)
  fs.cpSync(outDir, perRun, { recursive: true })
  const digest = JSON.parse(fs.readFileSync(path.join(perRun, 'digest.json'), 'utf8'))
  const { result } = await runWorkflow(T2.WORKFLOW, { args: { digest, nonce: T2.NONCE }, agent: { 'synthesis:proposals': { proposals: [] } } })
  const resultFile = path.join(perRun, 'result.json')
  fs.writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 })
  return { repo, perRun, resultFile, result }
}

function verifyCli(args, env = {}) {
  const res = spawnSync(process.execPath, [VERIFY, ...args], { encoding: 'utf8', timeout: 60000, cwd: freshDir('cwd-'), env: { ...process.env, HOME: freshDir('home-'), ...env } })
  return { ...res, out: res.stdout || '' }
}
const attendedCli = (run, repo = run.repo) => verifyCli(['attended', run.perRun, run.resultFile, repo], { OPTIMISE_VERIFY_NONCE: T2.NONCE })

function seed(repo) {
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, REPORT_REL), '# Delivery optimiser report\n\nThe last good report.\n')
  fs.writeFileSync(path.join(repo, SIDECAR_REL), '{}\n')
  return [fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8')]
}
const keptAs = (repo, before) => assert.deepEqual([fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8')], before, 'the last good report and sidecar are untouched')

// ---- the attended entry's refusals ----

test('attended: a linked worktree is refused, because the ignore rule is confirmed for the main checkout only, and nothing is placed', async () => {
  const run = await attendedRun()
  const worktree = path.join(freshDir('wt-'), 'linked')
  const added = spawnSync(F.REAL_GIT, ['-C', run.repo, 'worktree', 'add', '-q', '--detach', worktree], { encoding: 'utf8', env: sanitizedGitEnv() })
  assert.equal(added.status, 0, `guard against vacuity: the worktree exists: ${added.stderr}`)
  assert.ok(fs.statSync(path.join(worktree, '.git')).isFile(), 'and its .git is a pointer file')
  const res = attendedCli(run, worktree)
  assert.match(res.out, /^REASON repository is not a main checkout$/m, res.out)
  assert.match(res.out, /^PLACE no$/m, res.out)
  assert.equal(fs.existsSync(path.join(worktree, REPORT_REL)), false, 'nothing was written in the worktree')
  assert.equal(fs.existsSync(path.join(run.repo, REPORT_REL)), false, 'nor in the main checkout')
})

test('attended: a tracked .gitignore that re-includes the report path stops the run before anything is written', async () => {
  const run = await attendedRun()
  const before = seed(run.repo)
  fs.writeFileSync(path.join(run.repo, '.gitignore'), '!.claude/optimise-cycle-report.md\n!.claude/optimise-proposal-targets.json\n')
  fs.appendFileSync(path.join(run.repo, '.git', 'info', 'exclude'), `${REPORT_REL}\n`)
  const stillShown = spawnSync(F.REAL_GIT, ['-C', run.repo, 'check-ignore', '-q', REPORT_REL], { env: sanitizedGitEnv() })
  assert.notEqual(stillShown.status, 0, 'guard against vacuity: the exclude line is there and the negation still beats it, so the path is not ignored')
  const res = attendedCli(run)
  assert.match(res.out, /^REASON report path is not gitignored$/m, res.out)
  assert.match(res.out, /^PLACE no$/m, res.out)
  keptAs(run.repo, before)
})

test('attended: a result file that is a symlink is not read, and nothing is placed', async () => {
  const run = await attendedRun()
  const before = seed(run.repo)
  const real = path.join(run.perRun, 'real-result.json')
  fs.renameSync(run.resultFile, real)
  fs.symlinkSync(real, run.resultFile)
  const res = attendedCli(run)
  assert.match(res.out, /^REASON session output: /m, res.out)
  assert.match(res.out, /^PLACE no$/m, res.out)
  keptAs(run.repo, before)
})

// ---- the forms the runner shares with it ----

test('lock-try and unlock: one attempt either holds the lock, finds it busy or cannot make one; only the holder\'s token releases it', async () => {
  const repo = F.makeRepo({ ledger: F.validLedger(2), fix: 1, other: 1, author: AUTHOR })
  const lock = path.join(repo, '.git', 'optimise-sidecar.lock')
  const first = verifyCli(['lock-try', repo, String(process.pid)])
  const token = /^LOCK held (\d+:[0-9a-f]{12})$/m.exec(first.out)?.[1]
  assert.ok(token, first.out)
  assert.equal(fs.readlinkSync(lock), token, 'the lock records its owner token')
  assert.match(verifyCli(['lock-try', repo, String(process.pid)]).out, /^LOCK busy$/m, 'a live fresh lock is busy')
  assert.match(verifyCli(['unlock', repo, '4242:aaaaaaaaaaaa']).out, /^UNLOCKED yes$/m, 'a forged token runs')
  assert.equal(fs.readlinkSync(lock), token, 'but the lock is still its holder\'s')
  assert.match(verifyCli(['unlock', repo, token]).out, /^UNLOCKED yes$/m)
  assert.equal(fs.existsSync(lock), false, 'the holder\'s token released it')
  assert.match(verifyCli(['lock-try', repo, 'not-a-pid']).out, /^LOCK none$/m, 'an owner that is not a pid is refused')
  assert.match(verifyCli(['unlock', repo, '../../escape']).out, /^UNLOCKED no$/m, 'a token that is not the fixed shape is never used to build a path')
  const bare = freshDir('not-a-repo-')
  assert.match(verifyCli(['lock-try', bare, String(process.pid)]).out, /^LOCK none$/m, 'a directory with no git directory cannot hold one')
})

test('acquireLock waits LOCK_TRIES times for a busy lock and then reports busy, and the runner waits for the same number', async () => {
  const { acquireLock, LOCK_TRIES, LOCK_WAIT_MS, tryLock } = await load()
  const repo = F.makeRepo({ ledger: F.validLedger(2), fix: 1, other: 1, author: AUTHOR })
  assert.equal(tryLock(repo, process.pid).status, 'held')
  const waits = []
  assert.equal(acquireLock(repo, process.pid, { tries: 3, wait: (ms) => waits.push(ms) }).status, 'busy')
  assert.deepEqual(waits, [LOCK_WAIT_MS, LOCK_WAIT_MS, LOCK_WAIT_MS, LOCK_WAIT_MS], 'one wait after each busy attempt: four attempts for three tries')
  const runner = fs.readFileSync(SB.SCRIPT_PATH, 'utf8')
  assert.equal(Number(/^LOCK_TRIES=(\d+)\b/m.exec(runner)?.[1]), LOCK_TRIES, 'the runner\'s count is the module\'s')
  assert.ok(/sleep 0\.2$/m.test(runner) && LOCK_WAIT_MS === 200, 'and so is its wait between tries')
})

test('place: puts both result files in place and prints PLACED yes; a result that is a link, empty, or over its cap, or a destination that is a directory, is refused with the fixed reason and nothing is written', async () => {
  const repo = F.makeRepo({ ledger: F.validLedger(2), fix: 1, other: 1, author: AUTHOR })
  const dir = freshDir('place-')
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text)
  write('result-report.md', '# A new report\n')
  write('result-sidecar.json', '{}\n')
  assert.match(verifyCli(['place', dir, repo, repo]).out, /^PLACED yes$/m)
  assert.equal(fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), '# A new report\n')
  const before = seed(repo)
  const refused = (re) => {
    const out = verifyCli(['place', dir, repo, repo]).out
    assert.match(out, re, out)
    assert.match(out, /^PLACED no$/m, out)
    keptAs(repo, before)
    assert.deepEqual(fs.readdirSync(path.join(repo, '.claude')).filter((n) => n.startsWith('.optimise-output.')), [], 'no staged temp file is left behind')
  }
  write('result-report.md', '')
  refused(/^REASON report rejected: the result file is empty$/m)
  write('result-report.md', '#'.repeat(5242881))
  refused(/^REASON report rejected: the result file is larger than 5242880 bytes$/m)
  fs.rmSync(path.join(dir, 'result-report.md'))
  fs.symlinkSync(path.join(dir, 'result-sidecar.json'), path.join(dir, 'result-report.md'))
  refused(/^REASON report rejected: the result file is a symlink$/m)
  fs.rmSync(path.join(dir, 'result-report.md'))
  write('result-report.md', '# A new report\n')
  fs.rmSync(path.join(repo, REPORT_REL))
  fs.mkdirSync(path.join(repo, REPORT_REL))
  const out = verifyCli(['place', dir, repo, repo]).out
  assert.match(out, /^REASON report rejected: the destination is a symlinked directory or a directory$/m, out)
})

test('the attended mode prints the collected ledger count alone, and the runner\'s form still prints collected over reported', async () => {
  const { tokensFor, parseResultObject } = await load()
  const col = { lane: { ledger: { status: 'ran', result: { n: 5 } }, git: { status: 'ran', result: { count: 2 } }, ci: { status: 'ran', runCount: 2 } }, digest: { dropped: { trimmedForSize: false } } }
  assert.match(tokensFor(col, 'ran', undefined), /^ledger=5 ci=2 git=2 /)
  assert.match(tokensFor(col, 'ran', 5), /^ledger=5\/5 /)
  assert.match(tokensFor(col, 'ran', null), /^ledger=5\/- /)
  assert.deepEqual([parseResultObject('').cause, parseResultObject('[]').cause, parseResultObject('{').cause, parseResultObject('7').cause], ['empty', 'malformed', 'malformed', 'malformed'])
  assert.deepEqual(parseResultObject('{"report":"# x"}').result, { report: '# x' })
})

test('the runner places and locks through the result check module and holds no copy of either', () => {
  const runner = fs.readFileSync(SB.SCRIPT_PATH, 'utf8')
  const code = runner.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.match(code, /node "\$VERIFY_SCRIPT" place /, 'the runner places through the module')
  assert.match(code, /node "\$VERIFY_SCRIPT" lock-try /)
  assert.match(code, /node "\$VERIFY_SCRIPT" unlock /)
  for (const gone of ['stage_output', 'lock_looks_stale', 'mktemp "$destdir', 'ln -s', 'LOCK_STALE_MIN', 'STAGED_REPORT_TMP', 'STAGED_SIDECAR_TMP', 'mv -f']) assert.ok(!code.includes(gone), `${gone} is the module's, not the runner's`)
})

test('the weekly runner reports the module\'s fixed reason when the placement is refused, and leaves what was there', () => {
  const repo = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })
  fs.mkdirSync(path.join(repo, REPORT_REL), { recursive: true })
  fs.writeFileSync(path.join(repo, SIDECAR_REL), '{}\n')
  const res = SB.runRunner([repo], { stubs: ghStubs() })
  assert.notEqual(res.status, 0, res.logContents)
  assert.match(res.logContents, /^RESULT FAIL \S+ .*reason="report rejected: the destination is a symlinked directory or a directory"$/m, res.logContents)
  assert.equal(fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8'), '{}\n', 'the sidecar was not replaced either')
  assert.equal(fs.statSync(path.join(repo, REPORT_REL)).isDirectory(), true)
})

test('the collector carries the gh wall-clock in ghStats to the whole second, so the same collected data gives the same CI section whenever it is collected', () => {
  const repo = F.makeRepo({ ledger: F.validLedger(3), fix: 1, other: 1, author: AUTHOR })
  const { outDir } = F.collect(ghStubs(), repo)
  const ci = JSON.parse(fs.readFileSync(path.join(outDir, 'ci.json'), 'utf8'))
  const [stats] = ci.result.ghStats
  assert.equal(stats.gh_calls, 3, 'guard against vacuity: the stub gh was called for the list and for each of the two runs')
  assert.ok(Number.isInteger(stats.wall_clock_s), `ghStats wall_clock_s is whole seconds: ${stats.wall_clock_s}`)
})

test('a call that carries the removed repos or window arguments is told they no longer exist, and a call with neither is not', async () => {
  const refuse = async (args) => (await runWorkflow(T2.WORKFLOW, { args, agent: {} })).result.report
  assert.match(await refuse({ repos: ['.'], window: 90 }), /^Refusing to proceed: no collected digest was given\..*The repos and window arguments no longer exist/)
  assert.doesNotMatch(await refuse({}), /no longer exist/)
})

test('attended: the sidecar lock is released after a placed run and after a refused one (checked with lstat: the lock is a link to a name that does not exist, so existsSync would say it is gone either way)', async () => {
  const placed = await attendedRun()
  const refused = await attendedRun()
  fs.writeFileSync(refused.resultFile, 'this is not json')
  for (const [run, place] of [[placed, 'yes'], [refused, 'no']]) {
    const res = attendedCli(run)
    assert.match(res.out, new RegExp(`^PLACE ${place}$`, 'm'), res.out)
    assert.equal(fs.lstatSync(path.join(run.repo, '.git', 'optimise-sidecar.lock'), { throwIfNoEntry: false }), undefined, `no lock is left after the run that placed ${place}`)
  }
})
