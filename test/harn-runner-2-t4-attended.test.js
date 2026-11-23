// HARN-RUNNER-2 T4 (specs/harn-runner-2.md): what the attended entry of the result check does at its edges, and what the weekly
// runner shares with it. test/harn-runner-2-t4.test.js holds the main behaviour; this file pins the refusals around it (a linked
// worktree, a hostile main-checkout argument, a result file that is a link), the sidecar lock and its failure modes, the
// signal and leftover-file handling of the placement, and that the lock and the placement exist once, in the module.
// Every fixture commit carries an explicit identity. Figures a test expects come from its own fixtures.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { cleanupTempRepos, sanitizedGitEnv } = require('./helpers/temp-repo.js')
const SB = require('./helpers/weekly-sandbox.js')
const T2 = require('./helpers/t2-fixtures.js')
const { resign } = require('./helpers/result-mac.js')

const { F, ROOT, REPORT_REL, SIDECAR_REL, freshDir, marker } = SB
const VERIFY = path.join(ROOT, 'workflows', 'lib', 'optimise-verify.mjs')
const IGNORE_HELPER = path.join(ROOT, 'workflows', 'lib', 'optimise-report-ignore.mjs')
const AUTHOR = 'canary-author@example.invalid'
const load = () => import(pathToFileURL(VERIFY).href)
const readerPromise = import(pathToFileURL(T2.READER).href)

test.after(cleanupTempRepos)

function ghStubs() {
  const stubs = F.makeStubs()
  const runs = [11, 12].map((id) => F.run(id))
  F.setGhRuns(stubs, runs, Object.fromEntries(runs.map((r) => [r.databaseId, { jobs: [F.job('build'), F.job('test')] }])))
  return stubs
}

const newRepo = () => F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })

// One collection by the real collector, and any number of per-run directories made from it, each holding the workflow's returned
// object for its digest (altered by `alter`), saved unchanged as the skill has the operator's session save it.
async function collectedRun(repo, { stubs = ghStubs(), collectFrom = repo } = {}) {
  const { outDir } = F.collect(stubs, collectFrom)
  const digest = JSON.parse(fs.readFileSync(path.join(outDir, 'digest.json'), 'utf8'))
  const { result } = await runWorkflow(T2.WORKFLOW, { args: { digest, nonce: T2.NONCE }, agent: { 'synthesis:proposals': { proposals: [] } } })
  return {
    repo,
    outDir,
    result,
    make(alter) {
      const perRun = freshDir('attended-')
      fs.chmodSync(perRun, 0o700)
      fs.cpSync(outDir, perRun, { recursive: true })
      const copy = structuredClone(result)
      if (alter) alter(copy)
      resign(copy, T2.NONCE)
      const resultFile = path.join(perRun, 'result.json')
      fs.writeFileSync(resultFile, JSON.stringify(copy), { mode: 0o600 })
      return { repo, perRun, resultFile, result: copy }
    },
  }
}

async function attendedRun(repo = newRepo(), alter) {
  return (await collectedRun(repo)).make(alter)
}

function verifyCli(args, env = {}, cwd = freshDir('cwd-')) {
  const res = spawnSync(process.execPath, [VERIFY, ...args], { encoding: 'utf8', timeout: 90000, cwd, env: { ...process.env, HOME: freshDir('home-'), ...env } })
  return { ...res, out: res.stdout || '' }
}
// The attended entry as the skill runs it: the per-run directory, the saved result, the checkout the operator is in and the main
// checkout the skill resolved.
// The ignore step the skill runs first: the one command that decides the main checkout and the ignore rule and writes the proof the check needs.
function prove(run, repo = run.repo) {
  const res = spawnSync(process.execPath, [IGNORE_HELPER, 'prepare', repo, run.perRun], { encoding: 'utf8' })
  assert.equal(JSON.parse(res.stdout).ok, true, `the ignore step: ${res.stdout}${res.stderr}`)
}
const attendedCli = (run, { repo = run.repo, root = run.repo, cwd, skipProof = false } = {}) => {
  if (!skipProof) prove(run, repo)
  return verifyCli(['attended', run.perRun, run.resultFile, repo, root], { OPTIMISE_VERIFY_NONCE: T2.NONCE }, cwd)
}


const lockOf = (root) => path.join(root, '.git', 'optimise-sidecar.lock')
const gone = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) === undefined
const litter = (root) => fs.readdirSync(path.join(root, '.git')).filter((n) => n.startsWith('optimise-sidecar.lock'))
const stagedIn = (root) => (fs.existsSync(path.join(root, '.claude')) ? fs.readdirSync(path.join(root, '.claude')).filter((n) => n.startsWith('.optimise-output.')) : [])

function seed(repo, sidecar = '{}\n') {
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, REPORT_REL), '# Delivery optimiser report\n\nThe last good report.\n')
  fs.writeFileSync(path.join(repo, SIDECAR_REL), sidecar)
  return [fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8')]
}
const keptAs = (repo, before) => assert.deepEqual([fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8')], before, 'the last good report and sidecar are untouched')

async function uniqueEntry(label) {
  const reader = await readerPromise
  const target = { kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: 'ci', job: `entry-${label}`, touches_always_on_lens: false, security_purposed: false }
  const id = reader.stableProposalId(target)
  const alter = (r) => {
    r.report += `\n### ${id}: A proposal\n`
    r.proposal_targets = { ...r.proposal_targets, [id]: target }
  }
  return { id, target, alter }
}

const sidecarIds = (repo) => Object.keys(JSON.parse(fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8')))

// ---- the attended entry from a linked worktree (owner decision D3): the skill resolves the main checkout and passes it in ----

async function worktreeRun() {
  const repo = newRepo()
  const worktree = path.join(freshDir('wt-'), 'linked')
  const added = spawnSync(F.REAL_GIT, ['-C', repo, 'worktree', 'add', '-q', '--detach', worktree], { encoding: 'utf8', env: sanitizedGitEnv() })
  assert.equal(added.status, 0, `guard against vacuity: the worktree exists: ${added.stderr}`)
  assert.ok(fs.statSync(path.join(worktree, '.git')).isFile(), 'and its .git is a pointer file, so it is a linked worktree')
  const collected = await collectedRun(repo, { collectFrom: worktree })
  const run = collected.make()
  return { repo, worktree, run }
}

test('D3: an attended run from a linked worktree PASSes, places both outputs in the main checkout, leaves the worktree clean and holds the lock in the main checkout\'s git directory', async () => {
  const { repo, worktree, run } = await worktreeRun()
  prove({ perRun: run.perRun, repo }, worktree)
  for (const rel of [REPORT_REL, SIDECAR_REL]) assert.equal(spawnSync(F.REAL_GIT, ['-C', repo, 'check-ignore', '-q', '--', rel], { env: sanitizedGitEnv() }).status, 0, `${rel} is ignored in the main checkout`)
  const res = attendedCli(run, { repo: worktree, root: repo })
  assert.match(res.out, /^VERDICT PASS$/m, `${res.out}${res.stderr}`)
  assert.match(res.out, /^PLACE yes$/m, res.out)
  assert.equal(fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), run.result.report, 'the report is in the main checkout')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8')), run.result.proposal_targets, 'and so is the sidecar')
  assert.equal(fs.existsSync(path.join(worktree, '.claude', 'optimise-cycle-report.md')), false, 'nothing was written in the worktree')
  const status = spawnSync(F.REAL_GIT, ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8', env: sanitizedGitEnv() })
  assert.equal(status.stdout, '', 'the worktree is clean')
  assert.deepEqual(litter(repo), [], 'the lock is released and nothing is left beside it')
})

test('D3: the lock a worktree run takes is the main checkout\'s own, held while the sidecar is renamed, and not one in the worktree\'s git directory', async () => {
  const { attendedRun: attendedInProcess } = await load()
  const { repo, worktree, run } = await worktreeRun()
  prove(run, worktree)
  const seen = []
  const ops = { ...fs, renameSync: (from, to) => { seen.push([String(to).endsWith('optimise-proposal-targets.json'), fs.lstatSync(lockOf(repo), { throwIfNoEntry: false })?.isSymbolicLink() === true]); return fs.renameSync(from, to) } }
  prove(run, worktree)
  const v = await attendedInProcess({ dir: run.perRun, resultFile: run.resultFile, repo: worktree, root: repo, home: freshDir('home-'), nonce: T2.NONCE, wait: () => {} }, ops)
  assert.deepEqual(v.reasons, [])
  assert.deepEqual(seen.filter(([isSidecar]) => isSidecar), [[true, true]], 'the main checkout\'s lock exists at the moment the sidecar is renamed')
  assert.equal(gone(lockOf(repo)), true, 'and is gone afterwards')
})

// A main-checkout argument that is not this repository's own is refused with a fixed reason, and nothing is written or locked.
const HOSTILE_ROOTS = [
  ['another repository', (ctx) => ctx.other],
  ['a symlink to the real main checkout', (ctx) => ctx.link],
  ['a directory outside any repository', (ctx) => ctx.outside],
  ['a path that does not exist', (ctx) => path.join(ctx.outside, 'no-such-directory')],
  ['a relative path that names the real main checkout from the working directory', (ctx) => ({ root: path.basename(ctx.repo), cwd: path.dirname(ctx.repo) })],
  ['an empty argument', () => ''],
]
for (const [name, pick] of HOSTILE_ROOTS) {
  test(`D3: a main-checkout argument that is ${name} is refused with the fixed reason, VERDICT FAIL, nothing placed and no lock left`, async () => {
    const { repo, worktree, run } = await worktreeRun()
    const link = path.join(freshDir('links-'), 'main-link')
    fs.symlinkSync(repo, link)
    const ctx = { repo, other: newRepo(), link, outside: freshDir('outside-') }
    const picked = pick(ctx)
    const { root: given, cwd } = typeof picked === 'string' ? { root: picked, cwd: undefined } : picked
    assert.ok(given === '' || cwd !== undefined || fs.existsSync(given) === (name !== 'a path that does not exist'), 'guard against vacuity: the hostile path is what the case says')
    if (cwd !== undefined) assert.ok(fs.existsSync(path.resolve(cwd, given)), 'guard against vacuity: the relative path really names the main checkout from that directory')
    const before = seed(repo)
    const res = attendedCli(run, { repo: worktree, root: given, cwd })
    assert.match(res.out, /^VERDICT FAIL$/m, `${res.out}${res.stderr}`)
    assert.match(res.out, /^REASON main checkout does not match the repository$/m, res.out)
    assert.match(res.out, /^PLACE no$/m, res.out)
    keptAs(repo, before)
    assert.deepEqual(litter(repo), [], 'no lock was taken or left in the real main checkout')
    assert.deepEqual(litter(ctx.other), [], 'nor in the other repository')
    assert.equal(fs.existsSync(path.join(ctx.other, REPORT_REL)), false, 'and nothing was written in the other repository')
  })
}

test('D3: the main checkout itself, given as its own root, is accepted', async () => {
  const run = await attendedRun()
  const res = attendedCli(run)
  assert.match(res.out, /^VERDICT PASS$/m, `${res.out}${res.stderr}`)
})

test('D3: a checkout whose .git pointer names another repository\'s worktree directory is not accepted as that repository\'s, because that directory does not point back at it', async () => {
  const { repo, worktree, run } = await worktreeRun()
  const victim = newRepo()
  const victimWorktree = path.join(freshDir('wt-'), 'victim-linked')
  assert.equal(spawnSync(F.REAL_GIT, ['-C', victim, 'worktree', 'add', '-q', '--detach', victimWorktree], { encoding: 'utf8', env: sanitizedGitEnv() }).status, 0)
  const entry = path.join(victim, '.git', 'worktrees', 'victim-linked')
  assert.ok(fs.existsSync(path.join(entry, 'commondir')), 'guard against vacuity: the victim\'s worktree entry is there')
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${entry}\n`)
  assert.equal(fs.readFileSync(path.join(worktree, '.git'), 'utf8'), `gitdir: ${entry}\n`, 'guard against vacuity: the pointer was really rewritten')
  const before = seed(victim)
  const res = attendedCli(run, { repo: worktree, root: victim })
  assert.match(res.out, /^REASON main checkout does not match the repository$/m, `${res.out}${res.stderr}`)
  assert.match(res.out, /^PLACE no$/m)
  keptAs(victim, before)
  assert.equal(fs.existsSync(path.join(repo, REPORT_REL)), false)
})

test('D3: the ignore step stops a run whose report path a tracked .gitignore re-includes, and the attended form then places nothing', async () => {
  const run = await attendedRun()
  fs.writeFileSync(path.join(run.repo, '.gitignore'), '!.claude/optimise-cycle-report.md\n!.claude/optimise-proposal-targets.json\n')
  const step = spawnSync(process.execPath, [IGNORE_HELPER, 'prepare', run.repo, run.perRun], { encoding: 'utf8' })
  assert.equal(JSON.parse(step.stdout).ok, false, 'git still shows the report path, so the step fails and the skill stops')
  const before = seed(run.repo)
  const res = attendedCli(run, { skipProof: true })
  assert.match(res.out, /^REASON the output paths were not confirmed ignored for this checkout$/m, res.out)
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

// ---- M4: one verdict the operator reads, and a lane that could not run is a FAIL with a report ----

test('M4: a clean run prints VERDICT PASS first and then PLACE yes; a refused run prints VERDICT FAIL and PLACE no', async () => {
  const placed = await attendedRun()
  const refused = await attendedRun()
  fs.writeFileSync(refused.resultFile, 'this is not json')
  const a = attendedCli(placed)
  assert.equal(a.out.split('\n')[0], 'VERDICT PASS', a.out)
  assert.match(a.out, /^PLACE yes$/m)
  assert.doesNotMatch(a.out, /^REASON /m, 'a PASS carries no reason')
  assert.match(a.out, /^PLACED yes$/m, 'the placement is confirmed by its own line, which the runner requires')
  const b = attendedCli(refused)
  assert.equal(b.out.split('\n')[0], 'VERDICT FAIL', b.out)
  assert.match(b.out, /^PLACE no$/m)
  assert.doesNotMatch(b.out, /^PLACED/m)
})

test('M4/AC-PROD-3: a lane that could not run is VERDICT FAIL with the report placed (PLACE yes), the reason named, and the sidecar only merged into', async () => {
  const reader = await readerPromise
  const target = { kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: 'ci', job: 'carried-job', touches_always_on_lens: false, security_purposed: false }
  const id = reader.stableProposalId(target)
  const stubs = ghStubs()
  F.setGhMode(stubs, 'unauth')
  const repo = newRepo()
  const run = (await collectedRun(repo, { stubs })).make()
  assert.match(run.result.report, /CI|ci/, 'guard against vacuity: a report exists')
  assert.equal(run.result.lanes.ci.status, 'failed', 'guard against vacuity: the ci lane did not run')
  seed(repo, `${JSON.stringify({ [id]: target })}\n`)
  const res = attendedCli(run)
  assert.equal(res.out.split('\n')[0], 'VERDICT FAIL', `a lane that could not run is not a clean cycle: ${res.out}`)
  assert.match(res.out, /^REASON ci lane could not run: unauthenticated$/m, res.out)
  assert.match(res.out, /^PLACE yes$/m, 'the report is still placed')
  assert.equal(fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), run.result.report)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8'))[id], target, 'and the sidecar was merged into, not replaced')
})

// ---- M3: the sidecar is read, validated, merged and placed only while the lock is held ----

test('M3: an entry a second writer adds while this run waits for the lock is in the final sidecar, so nothing is read before the lock is held', async () => {
  const { attendedRun: attendedInProcess, tryLock, unlock } = await load()
  const a = await uniqueEntry('first')
  const b = await uniqueEntry('second')
  const run = await attendedRun(newRepo(), a.alter)
  const held = tryLock(run.repo, process.pid)
  assert.equal(held.status, 'held', 'guard against vacuity: another writer holds the lock')
  let waits = 0
  const wait = () => {
    waits += 1
    fs.mkdirSync(path.join(run.repo, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(run.repo, SIDECAR_REL), `${JSON.stringify({ [b.id]: b.target })}\n`)
    assert.equal(unlock(run.repo, held.token), true)
  }
  prove(run, run.repo)
  const v = await attendedInProcess({ dir: run.perRun, resultFile: run.resultFile, repo: run.repo, root: run.repo, home: freshDir('home-'), nonce: T2.NONCE, wait })
  assert.equal(waits, 1, 'guard against vacuity: the run really waited once')
  assert.deepEqual(v.reasons, [])
  assert.deepEqual(sidecarIds(run.repo).sort((x, y) => x.localeCompare(y)), [a.id, b.id].sort((x, y) => x.localeCompare(y)), 'both writers\' entries survive')
})

test('M3: a lock held by a live run past the wait is a refusal with its own fixed reason, nothing is placed, and the holder\'s lock is untouched', async () => {
  const { attendedRun: attendedInProcess, tryLock } = await load()
  const run = await attendedRun()
  const before = seed(run.repo)
  const held = tryLock(run.repo, process.pid)
  assert.equal(held.status, 'held')
  prove(run, run.repo)
  const v = await attendedInProcess({ dir: run.perRun, resultFile: run.resultFile, repo: run.repo, root: run.repo, home: freshDir('home-'), nonce: T2.NONCE, wait: () => {}, tries: 2 })
  assert.deepEqual(v.reasons, ['could not take the sidecar lock'])
  assert.equal(v.place, 'no')
  keptAs(run.repo, before)
  assert.equal(fs.readlinkSync(lockOf(run.repo)), held.token, 'the holder\'s lock is still there and still theirs')
})

test('M3: a main checkout with no git directory to hold a lock, or a lock that cannot be made, is refused with its own fixed reason and nothing is placed', async () => {
  const { attendedRun: attendedInProcess } = await load()
  const run = await attendedRun()
  const before = seed(run.repo)
  const noSymlinks = { ...fs, symlinkSync: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }) } }
  prove(run, run.repo)
  const v = await attendedInProcess({ dir: run.perRun, resultFile: run.resultFile, repo: run.repo, root: run.repo, home: freshDir('home-'), nonce: T2.NONCE, wait: () => {} }, noSymlinks)
  assert.deepEqual(v.reasons, ['the sidecar lock path is not usable'])
  assert.equal(v.place, 'no')
  keptAs(run.repo, before)
})

test('M3: a lock step that throws is refused with its own fixed reason, nothing is placed and no lock is left', async () => {
  const { attendedRun: attendedInProcess, tryLock } = await load()
  const run = await attendedRun()
  const before = seed(run.repo)
  const held = tryLock(run.repo, process.pid)
  prove(run, run.repo)
  const v = await attendedInProcess({ dir: run.perRun, resultFile: run.resultFile, repo: run.repo, root: run.repo, home: freshDir('home-'), nonce: T2.NONCE, wait: () => { throw new Error('the waiter failed') }, tries: 3 })
  assert.deepEqual(v.reasons, ['the sidecar lock helper failed'])
  keptAs(run.repo, before)
  assert.equal(fs.readlinkSync(lockOf(run.repo)), held.token)
})

test('M3: an attended run and weekly runners started together on one repository each add their entry, and none is lost', async () => {
  const repo = newRepo()
  marker(repo, 'heading-unique')
  const collected = await collectedRun(repo)
  const entries = await Promise.all(['a', 'b', 'c', 'd'].map((label) => uniqueEntry(label)))
  const runs = entries.map((e) => collected.make(e.alter))
  const stubs = ghStubs()
  const tmpdir = freshDir('shared-tmp-')
  const runners = [0, 1].map(() => SB.startRunner([repo], { stubs, tmpdir }))
  runs.forEach((run) => prove(run))
  const attended = runs.map((run) => new Promise((resolve) => {
    const child = spawn(process.execPath, [VERIFY, 'attended', run.perRun, run.resultFile, repo, repo], { env: { ...process.env, HOME: freshDir('home-'), OPTIMISE_VERIFY_NONCE: T2.NONCE }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('exit', () => resolve(out))
  }))
  const outs = await Promise.all(attended)
  await Promise.all(runners.map((r) => r.done))
  for (const out of outs) assert.match(out, /^VERDICT PASS$/m, out)
  for (const r of runners) assert.match(fs.readFileSync(r.log, 'utf8'), /^RESULT PASS /m, fs.readFileSync(r.log, 'utf8'))
  const placed = sidecarIds(repo)
  assert.deepEqual(entries.map((e) => e.id).filter((id) => !placed.includes(id)), [], 'every attended run\'s entry is in the sidecar')
  const runnerIds = runners.flatMap((r) => {
    const replies = fs.readdirSync(r.witness).filter((n) => n.startsWith('reply-'))
    return replies.map((n) => Object.keys(JSON.parse(JSON.parse(fs.readFileSync(path.join(r.witness, n), 'utf8')).result).proposal_targets)[0])
  })
  assert.equal(runnerIds.length, 2, 'guard against vacuity: both runners returned an entry')
  assert.deepEqual(runnerIds.filter((id) => !placed.includes(id)), [], 'and so is every runner\'s')
  assert.deepEqual(litter(repo), [], 'no lock is left')
})

// ---- the lock, one attempt at a time ----

test('tryLock and unlock: one attempt either holds the lock, finds it busy or cannot make one; only the holder\'s token releases it', async () => {
  const { tryLock, unlock } = await load()
  const repo = newRepo()
  const first = tryLock(repo, process.pid)
  assert.equal(first.status, 'held')
  assert.match(first.token, /^\d+:[0-9a-f]{12}$/)
  assert.equal(fs.readlinkSync(lockOf(repo)), first.token, 'the lock records its owner token')
  assert.equal(tryLock(repo, process.pid).status, 'busy', 'a live fresh lock is busy')
  assert.equal(unlock(repo, '4242:aaaaaaaaaaaa'), true, 'a forged token runs')
  assert.equal(fs.readlinkSync(lockOf(repo)), first.token, 'but the lock is still its holder\'s')
  assert.equal(unlock(repo, first.token), true)
  assert.equal(gone(lockOf(repo)), true, 'the holder\'s token released it (checked with lstat: the lock is a link to a name that does not exist, so existsSync would say it is gone either way)')
  assert.equal(unlock(repo, '../../escape'), false, 'a token that is not the fixed shape is never used to build a path')
  assert.equal(tryLock(freshDir('not-a-repo-'), process.pid).status, 'none', 'a directory with no git directory cannot hold one')
})

test('acquireLock waits LOCK_TRIES times for a busy lock and then reports busy', async () => {
  const { acquireLock, LOCK_TRIES, LOCK_WAIT_MS, tryLock } = await load()
  const repo = newRepo()
  assert.equal(tryLock(repo, process.pid).status, 'held')
  const waits = []
  assert.equal(acquireLock(repo, process.pid, { tries: 3, wait: (ms) => waits.push(ms) }).status, 'busy')
  assert.deepEqual(waits, [LOCK_WAIT_MS, LOCK_WAIT_MS, LOCK_WAIT_MS, LOCK_WAIT_MS], 'one wait after each busy attempt: four attempts for three tries')
  assert.equal(LOCK_TRIES, 150, 'a held lock is waited for 150 tries of 200 ms, about 30 seconds, as the runbook says')
})

test('a lock path that is a directory left by an earlier mkdir-style lock does not wedge the repository: it is set aside and removed, and two runs in a row both PASS with nothing left behind', async () => {
  const repo = newRepo()
  const collected = await collectedRun(repo)
  fs.mkdirSync(lockOf(repo))
  fs.writeFileSync(path.join(lockOf(repo), 'pid'), `${process.pid}\n`)
  fs.mkdirSync(path.join(lockOf(repo), 'nested'))
  fs.writeFileSync(path.join(lockOf(repo), 'nested', 'file'), 'x')
  for (const round of [1, 2]) {
    const res = attendedCli(collected.make())
    assert.match(res.out, /^VERDICT PASS$/m, `round ${round}: ${res.out}${res.stderr}`)
  }
  assert.deepEqual(litter(repo), [], 'no lock, no renamed copy of the old directory')
})

test('a lock path that is a regular file is set aside the same way, and the run places', async () => {
  const repo = newRepo()
  fs.writeFileSync(lockOf(repo), 'not a lock')
  const res = attendedCli(await attendedRun(repo))
  assert.match(res.out, /^VERDICT PASS$/m, `${res.out}${res.stderr}`)
  assert.deepEqual(litter(repo), [])
})

test('a lock symlink whose target is an existing directory is never followed: nothing is written inside the directory, a fresh one is busy, and a stale one is removed without touching the directory', async () => {
  const { tryLock } = await load()
  const repo = newRepo()
  const target = freshDir('lock-target-')
  fs.writeFileSync(path.join(target, 'keep'), 'keep')
  fs.symlinkSync(target, lockOf(repo))
  assert.equal(tryLock(repo, process.pid).status, 'busy', 'a fresh link is somebody\'s lock, whatever it points at')
  assert.deepEqual(fs.readdirSync(target), ['keep'], 'nothing was created inside the directory it points at')
  const old = new Date(Date.now() - 3 * 3600 * 1000)
  fs.lutimesSync(lockOf(repo), old, old)
  const got = tryLock(repo, process.pid)
  assert.equal(got.status, 'held', 'a link older than the stale limit is taken over')
  assert.deepEqual(fs.readdirSync(target), ['keep'], 'and the directory it pointed at is untouched')
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'keep')
})

test('the age rule applies when the owner token is malformed: an old lock whose owner is not a pid is taken over, and a fresh one is left alone', async () => {
  const { tryLock } = await load()
  const repo = newRepo()
  for (const owner of ['not-a-token', 'x', ':::', '99999999999999999999:zz']) {
    fs.symlinkSync(owner, lockOf(repo))
    assert.equal(tryLock(repo, process.pid).status, 'busy', `a fresh lock owned by ${owner} is busy`)
    const old = new Date(Date.now() - 3 * 3600 * 1000)
    fs.lutimesSync(lockOf(repo), old, old)
    const got = tryLock(repo, process.pid)
    assert.equal(got.status, 'held', `an old lock owned by ${owner} is stale`)
    fs.rmSync(lockOf(repo), { force: true })
  }
})

test('a fresh lock that was taken away by mistake and cannot be put back is reported with a fixed notice, not silently', async () => {
  const { breakStale, drainNotices } = await load()
  const repo = newRepo()
  drainNotices()
  fs.symlinkSync(`${process.pid}:abcdefabcdef`, lockOf(repo))
  const refusePutBack = { ...fs, symlinkSync: () => { throw Object.assign(new Error('refused'), { code: 'EACCES' }) } }
  breakStale(lockOf(repo), '1:judged-stale', 'abcdefabcdef', refusePutBack)
  assert.deepEqual(drainNotices(), ['lock-restore-failed'])
  assert.deepEqual(drainNotices(), [], 'draining empties it')
})

// ---- L2 (whole-branch review): a stale-lock takeover must never leave two runs believing they hold the lock ----

test('L2: the review\'s three-party interleaving (a taker renames a lock aside that another taker has just made fresh, and a third takes the empty path before the put-back) ends with one owner on the path and the displaced run no longer holding it', async () => {
  const { tryLock, drainNotices, holdsLock } = await load()
  const repo = newRepo()
  const dead = spawnSync(process.execPath, ['-e', '0']).pid
  const [tokenC, tokenB] = [`${process.pid}:cccccccccccc`, `${process.pid}:bbbbbbbbbbbb`] // live owners, so neither lock looks stale
  fs.symlinkSync(`${dead}:aaaaaaaaaaaa`, lockOf(repo))
  let step = 0
  const opsD = {
    ...fs,
    renameSync: (from, to) => {
      if (step === 0 && String(to).includes('.stale.')) {
        step = 1
        fs.rmSync(lockOf(repo))
        fs.symlinkSync(tokenC, lockOf(repo)) // C has taken the stale lock over and is the holder, just before D renames it aside
      }
      return fs.renameSync(from, to)
    },
    symlinkSync: (target, p) => {
      if (step === 1 && target === tokenC) {
        step = 2
        fs.symlinkSync(tokenB, p) // B takes the path D has just emptied, before D can put C's lock back
      }
      return fs.symlinkSync(target, p)
    },
  }
  drainNotices()
  tryLock(repo, process.pid, opsD)
  assert.equal(step, 2, 'guard against vacuity: the whole interleaving really happened')
  assert.equal(fs.readlinkSync(lockOf(repo)), tokenB, 'B owns the path')
  assert.deepEqual(drainNotices(), ['lock-restore-failed'], 'and the failed put-back was noticed')
  assert.equal(holdsLock(repo, tokenB), true)
  assert.equal(holdsLock(repo, tokenC), false, 'C, whose lock was taken, no longer holds it')
})

test('L2: a run whose lock is taken from it while it stages its outputs does not place, fails with the lock reason, and leaves the last good files and nothing staged', async () => {
  const { attendedRun: attendedInProcess } = await load()
  const run = await attendedRun()
  const before = seed(run.repo)
  prove(run)
  let stolen = false
  const ops = {
    ...fs,
    writeFileSync: (file, ...rest) => {
      if (!stolen && String(file).includes('.optimise-output.') && String(rest[0] ?? '').includes('{')) {
        stolen = true
        fs.rmSync(lockOf(run.repo), { force: true })
        fs.symlinkSync(`${process.pid}:dddddddddddd`, lockOf(run.repo)) // another run (a live one) now owns the lock
      }
      return fs.writeFileSync(file, ...rest)
    },
  }
  const v = await attendedInProcess({ dir: run.perRun, resultFile: run.resultFile, repo: run.repo, root: run.repo, home: freshDir('home-'), nonce: T2.NONCE, wait: () => {} }, ops)
  assert.equal(stolen, true, 'guard against vacuity: the lock really was taken while the sidecar was staged')
  assert.deepEqual(v.reasons, ['the sidecar lock path is not usable'])
  assert.equal(v.place, 'no')
  keptAs(run.repo, before)
  assert.deepEqual(stagedIn(run.repo), [], 'no staged file is left')
  assert.equal(fs.readlinkSync(lockOf(run.repo)), `${process.pid}:dddddddddddd`, 'and the other run\'s lock is left alone')
})

// ---- the placement: signals, leftover staged files ----

function childScript(body) {
  const file = path.join(freshDir('child-'), 'run.mjs')
  fs.writeFileSync(file, `import fs from 'node:fs'\nimport { settleRun } from ${JSON.stringify(pathToFileURL(VERIFY).href)}\n${body}\n`)
  return file
}

test('L4: a SIGTERM that arrives between staging the outputs and renaming them leaves nothing staged, the lock released and both outputs placed or both left as they were', async () => {
  const run = await attendedRun()
  const before = seed(run.repo)
  prove(run)
  const script = childScript(`
const ops = { ...fs, renameSync: (from, to) => { if (String(to).endsWith('optimise-proposal-targets.json')) process.kill(process.pid, 'SIGTERM'); return fs.renameSync(from, to) } }
await settleRun({ dir: ${JSON.stringify(run.perRun)}, sessionPath: ${JSON.stringify(run.resultFile)}, digestToken: 'ran', repo: ${JSON.stringify(run.repo)}, runTmp: ${JSON.stringify(run.perRun)}, home: ${JSON.stringify(freshDir('home-'))}, sidecarRoot: ${JSON.stringify(run.repo)}, nonce: ${JSON.stringify(T2.NONCE)}, attended: true, place: 'place', analysedRepo: ${JSON.stringify(run.repo)} }, ops)
await new Promise((resolve) => setTimeout(resolve, 3000))
process.stdout.write('SURVIVED\\n')
`)
  const res = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60000 })
  assert.equal(res.stdout.includes('SURVIVED'), false, `guard against vacuity: the signal really stopped the process: ${res.stdout}${res.stderr}`)
  assert.ok(res.status === 143 || res.signal === 'SIGTERM', `the process ended on the signal: status ${res.status} signal ${res.signal}`)
  assert.deepEqual(stagedIn(run.repo), [], 'no staged temp file is left behind')
  assert.equal(gone(lockOf(run.repo)), true, 'the lock is released')
  const after = [fs.readFileSync(path.join(run.repo, REPORT_REL), 'utf8'), fs.readFileSync(path.join(run.repo, SIDECAR_REL), 'utf8')]
  const old = JSON.stringify(before)
  const fresh = JSON.stringify([run.result.report, JSON.stringify(run.result.proposal_targets, null, 2) + '\n'])
  assert.ok(JSON.stringify(after) === old || JSON.stringify(after) === fresh, 'never one new and one old')
})

test('L4: a staged temp file left by a killed run is swept at the next run: only files of the module\'s own name pattern, only regular files, never a link and never another file', async () => {
  const run = await attendedRun()
  fs.mkdirSync(path.join(run.repo, '.claude'), { recursive: true })
  const outside = path.join(freshDir('outside-'), 'precious.txt')
  fs.writeFileSync(outside, 'precious')
  const claude = path.join(run.repo, '.claude')
  const stale = ['.optimise-output.0123456789ab', '.optimise-output.fedcba987654']
  for (const name of stale) fs.writeFileSync(path.join(claude, name), 'a killed run left this')
  fs.symlinkSync(outside, path.join(claude, '.optimise-output.aaaaaaaaaaaa'))
  const others = ['.optimise-output.short', '.optimise-output.0123456789abc', 'optimise-output.0123456789ab', 'keep.txt']
  for (const name of others) fs.writeFileSync(path.join(claude, name), 'not ours')
  const res = attendedCli(run)
  assert.match(res.out, /^VERDICT PASS$/m, `${res.out}${res.stderr}`)
  const left = fs.readdirSync(claude).sort((a, b) => a.localeCompare(b))
  for (const name of stale) assert.equal(left.includes(name), false, `${name} was swept`)
  assert.equal(left.includes('.optimise-output.aaaaaaaaaaaa'), true, 'a link of that name is left alone')
  assert.equal(fs.readFileSync(outside, 'utf8'), 'precious', 'and what it points at is untouched')
  for (const name of others) assert.equal(left.includes(name), true, `${name} is not the module's and stays`)
})

// ---- the sidecar's size ----

test('M3/AC-DATA-1: a sidecar on disk with more than the carry maximum of entries is trimmed oldest first and the run PASSes, never refused as oversized', async () => {
  const { SIDECAR_CARRY_MAX } = await load()
  const repo = newRepo()
  const entry = await uniqueEntry('newest')
  const existing = {}
  for (let i = 0; i < SIDECAR_CARRY_MAX + 100; i += 1) existing[i.toString(16).padStart(16, '0')] = { kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: 'ci', job: `old-${i}`, touches_always_on_lens: false, security_purposed: false }
  seed(repo, `${JSON.stringify(existing, null, 2)}\n`)
  const res = attendedCli(await attendedRun(repo, entry.alter))
  assert.match(res.out, /^VERDICT PASS$/m, `${res.out}${res.stderr}`)
  const ids = sidecarIds(repo)
  assert.equal(ids.length, SIDECAR_CARRY_MAX, 'trimmed to the carry maximum')
  assert.equal(ids.at(-1), entry.id, 'the new entry is the newest')
  assert.equal(ids.includes('0000000000000000'), false, 'and the oldest went first')
  assert.equal(ids.includes((SIDECAR_CARRY_MAX + 99).toString(16).padStart(16, '0')), true, 'the newest of the old ones stayed')
})

// ---- the forms the runner shares with it ----

test('placeOutputs puts both result files in place; a result that is a link, empty, or over its cap, or a destination that is a directory, is refused with the fixed reason and nothing is written', async () => {
  const { placeOutputs } = await load()
  const repo = newRepo()
  const dir = freshDir('place-')
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text)
  const place = () => placeOutputs({ dir, repo, sidecarRoot: repo })
  write('result-report.md', '# A new report\n')
  write('result-sidecar.json', '{}\n')
  assert.equal(place().problem, null)
  assert.equal(fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), '# A new report\n')
  const before = seed(repo)
  const refused = (reason) => {
    assert.equal(place().problem, reason)
    keptAs(repo, before)
    assert.deepEqual(stagedIn(repo), [], 'no staged temp file is left behind')
  }
  write('result-report.md', '')
  refused('report rejected: the result file is empty')
  write('result-report.md', '#'.repeat(5242881))
  refused('report rejected: the result file is larger than 5242880 bytes')
  fs.rmSync(path.join(dir, 'result-report.md'))
  fs.symlinkSync(path.join(dir, 'result-sidecar.json'), path.join(dir, 'result-report.md'))
  refused('report rejected: the result file is a symlink')
  fs.rmSync(path.join(dir, 'result-report.md'))
  write('result-report.md', '# A new report\n')
  fs.rmSync(path.join(repo, REPORT_REL))
  fs.mkdirSync(path.join(repo, REPORT_REL))
  assert.equal(place().problem, 'report rejected: the destination is a symlinked directory or a directory')
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

const runnerCode = () => fs.readFileSync(SB.SCRIPT_PATH, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

test('L8: the runner settles the sidecar through one module command and holds no lock loop, no lock state and no placement sequence of its own', () => {
  const code = runnerCode()
  assert.match(code, /node "\$VERIFY_SCRIPT" settle /, 'the runner settles through the module')
  for (const gone of ['lock_sidecar', 'unlock_sidecar', 'SIDECAR_LOCK', 'SIDECAR_TOKEN', 'LOCK_TRIES', 'sleep 0.2', 'lock-try', ' unlock ', ' place ', 'stage_output', 'lock_looks_stale', 'mktemp "$destdir', 'ln -s', 'LOCK_STALE_MIN', 'STAGED_REPORT_TMP', 'STAGED_SIDECAR_TMP', 'mv -f']) assert.ok(!code.includes(gone), `${gone} is the module's, not the runner's`)
})

test('L8: the module has the one critical section both entries call, and its command line has no separate lock or placement form', () => {
  const source = fs.readFileSync(VERIFY, 'utf8')
  assert.match(source, /export async function settleRun\(/)
  const commands = /const COMMANDS = \{([^}]*)\}/.exec(source)?.[1] ?? ''
  assert.match(commands, /settle/)
  assert.match(commands, /attended/)
  for (const gone of ['place:', "'lock-try'", 'unlock:']) assert.ok(!commands.includes(gone), `${gone} is no longer a command`)
})

test('the weekly runner reports the module\'s fixed reason when the placement is refused, and leaves what was there', () => {
  const repo = newRepo()
  fs.mkdirSync(path.join(repo, REPORT_REL), { recursive: true })
  fs.writeFileSync(path.join(repo, SIDECAR_REL), '{}\n')
  const res = SB.runRunner([repo], { stubs: ghStubs() })
  assert.notEqual(res.status, 0, res.logContents)
  assert.match(res.logContents, /^RESULT FAIL \S+ .*reason="report rejected: the destination is a symlinked directory or a directory"$/m, res.logContents)
  assert.equal(fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8'), '{}\n', 'the sidecar was not replaced either')
  assert.equal(fs.statSync(path.join(repo, REPORT_REL)).isDirectory(), true)
})

// What the runner does with the lines the module prints, through a module that prints chosen ones in place of the real one.
function runnerWith(source) {
  const claudeHome = SB.provisionInstall(freshDir('claudehome-'))
  fs.writeFileSync(path.join(claudeHome, 'workflows', 'lib', 'optimise-verify.mjs'), source)
  const repo = newRepo()
  return { repo, res: SB.runRunner([repo], { claudeHome, stubs: ghStubs() }) }
}
const VERDICT_BODY = "TOKENS ledger=5/5 ci=2 git=2 digest=ran omitted=0 trimmed=no\\nDENIED unknown\\n"

test('L2: a notice the result check raises is logged as one fixed NOTICE line for the repository, and a token that is not shaped like one is dropped', () => {
  const good = runnerWith(`process.stdout.write('${VERDICT_BODY}NOTICE lock-restore-failed\\nREASON could not take the sidecar lock\\nPLACE no\\n')\n`)
  assert.match(good.res.logContents, new RegExp(`^NOTICE ${path.basename(good.repo)} lock-restore-failed$`, 'm'), good.res.logContents)
  const bad = runnerWith(`process.stdout.write('${VERDICT_BODY}NOTICE /Users/someone/secret Path\\nREASON could not take the sidecar lock\\nPLACE no\\n')\n`)
  assert.doesNotMatch(bad.res.logContents, /^NOTICE /m, 'a token with a path or capitals in it never reaches the log')
  assert.match(bad.res.logContents, /^RESULT FAIL .*reason="could not take the sidecar lock"$/m, 'and the run is still read as the FAIL it printed')
})

test('the collector carries the gh wall-clock in ghStats to the whole second, so the same collected data gives the same CI section whenever it is collected', () => {
  const repo = F.makeRepo({ ledger: F.validLedger(3), fix: 1, other: 1, author: AUTHOR })
  const { outDir } = F.collect(ghStubs(), repo)
  const ci = JSON.parse(fs.readFileSync(path.join(outDir, 'ci.json'), 'utf8'))
  const [stats] = ci.result.ghStats
  assert.equal(stats.gh_calls, 3, 'guard against vacuity: the stub gh was called for the list and for each of the two runs')
  assert.ok(Number.isInteger(stats.wall_clock_s), `ghStats wall_clock_s is whole seconds: ${stats.wall_clock_s}`)
})

test('attended: the sidecar lock is released after a placed run and after a refused one (checked with lstat: the lock is a link to a name that does not exist, so existsSync would say it is gone either way)', async () => {
  const placed = await attendedRun()
  const refused = await attendedRun()
  fs.writeFileSync(refused.resultFile, 'this is not json')
  for (const [run, place] of [[placed, 'yes'], [refused, 'no']]) {
    const res = attendedCli(run)
    assert.match(res.out, new RegExp(`^PLACE ${place}$`, 'm'), res.out)
    assert.equal(gone(lockOf(run.repo)), true, `no lock is left after the run that placed ${place}`)
  }
})
