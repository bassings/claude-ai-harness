// HARN-RUNNER-2 T4 (specs/harn-runner-2.md): the attended /optimise-cycle uses the collector, and its report and
// sidecar are written from the workflow's structured result by the SAME result check the weekly runner uses.
//
// What the tests pin where the criteria leave the wording open (the build follows them):
//   - the workflow takes a digest and a nonce on every call. A call with none returns the fixed refusal
//     `Refusing to proceed: ... digest ...` with outcome `aborted`, and dispatches no agent at all.
//   - the attended entry is one command-line mode of the existing result check module:
//       OPTIMISE_VERIFY_NONCE=<nonce> node optimise-verify.mjs attended <per-run dir> <result file> <repository root>
//     where <result file> is the object the Workflow tool returned, saved unchanged. It prints the same fixed lines as
//     the runner's form (TOKENS, DENIED, REASON, PLACE yes|no), and when it prints PLACE yes the report and the sidecar are
//     already in the repository, ignored, placed under the sidecar lock. There is no other writer (AC-DATA-2).
//   - the sidecar lock is a symlink named optimise-sidecar.lock in the main checkout's git directory (the runner's own form),
//     and its code exists in one source file only.
//   - README.md holds a runbook under a heading containing "Runbook", a table whose first cell is the reason text (or its
//     fixed leading words, ahead of any placeholder such as <lane>) in backticks; a cause or a failure mode has a row whose
//     first cell is `cause=<token>` or `failed:<mode>`.
// Every fixture commit carries an explicit identity. Figures a test expects come from its own fixtures.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { cleanupTempRepos } = require('./helpers/temp-repo.js')
const SB = require('./helpers/weekly-sandbox.js')
const T2 = require('./helpers/t2-fixtures.js')

const { F, ROOT, REPORT_REL, SIDECAR_REL, freshDir, runRunner } = SB
const VERIFY = path.join(ROOT, 'workflows', 'lib', 'optimise-verify.mjs')
const WORKFLOW = T2.WORKFLOW
const WORKFLOW_SOURCE = fs.readFileSync(WORKFLOW, 'utf8')
const SKILL = fs.readFileSync(path.join(ROOT, 'skills', 'optimise-cycle', 'SKILL.md'), 'utf8')
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const AUTHOR = 'canary-author@example.invalid'

test.after(cleanupTempRepos)

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const readerPromise = import(pathToFileURL(T2.READER).href)

// ---- fixtures ----

function ghStubs(runIds = [11, 12, 13]) {
  const stubs = F.makeStubs()
  const runs = runIds.map((id) => F.run(id))
  F.setGhRuns(stubs, runs, Object.fromEntries(runs.map((r) => [r.databaseId, { jobs: [F.job('build'), F.job('test')] }])))
  return stubs
}

// A repository with K ledger lines and F `fix:` commits, collected by the REAL collector into a private per-run directory, as
// the skill has the operator's session do. The workflow's returned object for that digest is saved unchanged beside it.
async function attendedRun({ ledger = 5, fix = 2, stubs = ghStubs(), alter } = {}) {
  const repo = F.makeRepo({ ledger: F.validLedger(ledger), fix, other: 1, author: AUTHOR })
  const { outDir } = F.collect(stubs, repo)
  const perRun = freshDir('attended-')
  fs.chmodSync(perRun, 0o700)
  fs.cpSync(outDir, perRun, { recursive: true })
  const digest = JSON.parse(fs.readFileSync(path.join(perRun, 'digest.json'), 'utf8'))
  const { result } = await runWorkflow(WORKFLOW, { args: { digest, nonce: T2.NONCE }, agent: { 'synthesis:proposals': { proposals: [] } } })
  if (alter) alter(result)
  const resultFile = path.join(perRun, 'result.json')
  fs.writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 })
  return { repo, perRun, resultFile, result, stubs }
}

function runAttended(run, { nonce = T2.NONCE, home = freshDir('home-') } = {}) {
  const res = spawnSync(process.execPath, [VERIFY, 'attended', run.perRun, run.resultFile, run.repo], {
    encoding: 'utf8',
    timeout: 60000,
    cwd: freshDir('cwd-'),
    env: { ...process.env, HOME: home, OPTIMISE_VERIFY_NONCE: nonce },
  })
  return { ...res, home, out: res.stdout || '' }
}

const isIgnored = (repo, rel) => spawnSync('git', ['-C', repo, 'check-ignore', '-q', rel]).status === 0
const lockPath = (repo) => path.join(repo, '.git', 'optimise-sidecar.lock')

// A last good report and sidecar of known bytes, so a run that rewrites either is seen.
function seedOutputs(repo, sidecarText = '{}\n') {
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  const report = path.join(repo, REPORT_REL)
  const sidecar = path.join(repo, SIDECAR_REL)
  fs.writeFileSync(report, '# Delivery optimiser report\n\nThe last good report.\n')
  fs.writeFileSync(sidecar, sidecarText)
  return { report, sidecar, reportSha: sha(report), sidecarSha: sha(sidecar) }
}

function assertKept(seed) {
  assert.equal(sha(seed.report), seed.reportSha, 'the last good report must be byte-identical')
  assert.equal(sha(seed.sidecar), seed.sidecarSha, 'the last good sidecar must be byte-identical')
}

// ---- AC-ARCH-2: one collection path; the workflow runs no scope agent and no lane agent ----

const COLLECTOR_REL = 'workflows/lib/optimise-collect.mjs'
function sourceFilesUnder(dir) {
  const out = []
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...sourceFilesUnder(rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}
const SOURCES = [...sourceFilesUnder('workflows'), ...sourceFilesUnder('bin')]

for (const needle of ['gh run list', 'gh run view', 'log --max-count']) {
  test(`AC-ARCH-2: across workflows/ and bin/ the string "${needle}" appears in the collector module and in no other source file`, () => {
    const holders = SOURCES.filter((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').includes(needle))
    assert.deepEqual(holders, [COLLECTOR_REL])
  })
}

test('AC-ARCH-2: the workflow source declares no scope agent, no lane agent and no argument naming repositories or a window', () => {
  for (const gone of ["label: 'scope:", "label: 'lane:", 'collectFromAgents', 'requestedRepos', 'requestedWindow', 'openssl rand', 'rev-parse']) {
    assert.ok(!WORKFLOW_SOURCE.includes(gone), `${gone} must be gone from workflows/optimise-cycle.js`)
  }
})

for (const [name, args] of [['no arguments', {}], ['the old attended arguments', { repos: ['.'], window: 90 }], ['a JSON string of them', '{"repos":["."]}'], ['a nonce and no digest', { nonce: T2.NONCE }]]) {
  test(`AC-ARCH-2: a call with no digest (${name}) is refused with a fixed reason and dispatches no agent`, async () => {
    const { result, calls } = await runWorkflow(WORKFLOW, { args, agent: { 'synthesis:proposals': { proposals: [] } } })
    assert.equal(calls.length, 0, `no agent may run without a collected digest: ${calls.map((c) => c.opts.label)}`)
    assert.equal(result.__outcome, 'aborted')
    assert.match(result.report, /^Refusing to proceed: .*digest/i)
  })
}

// ---- AC-DATA-2, AC-PROD-8, AC-DATA-1: the attended entry is the result check; it places what it trusts and nothing else ----

test('AC-DATA-2: the attended mode of the result check places the report and the sidecar in the repository, both ignored, and holds no lock afterwards', async () => {
  const run = await attendedRun()
  const res = runAttended(run)
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.out, /^PLACE yes$/m, res.out)
  assert.equal(fs.readFileSync(path.join(run.repo, REPORT_REL), 'utf8'), run.result.report, 'the placed report is the returned one')
  const sidecar = JSON.parse(fs.readFileSync(path.join(run.repo, SIDECAR_REL), 'utf8'))
  assert.deepEqual(sidecar, run.result.proposal_targets, 'with no prior decisions the sidecar is the returned one')
  assert.ok(isIgnored(run.repo, REPORT_REL), 'the report path is ignored')
  assert.ok(isIgnored(run.repo, SIDECAR_REL), 'the sidecar path is ignored')
  assert.equal(fs.existsSync(lockPath(run.repo)), false, 'the sidecar lock is released')
  assert.ok(!res.out.includes(run.repo) && !res.out.includes(run.perRun), 'the printed lines carry no path')
})

test('AC-QA-4/AC-SEC-14 (attended): a ledger figure that differs by one from the collected one fails, names the lane, and leaves the last good files byte-identical', async () => {
  const run = await attendedRun({ alter: (r) => { r.report = r.report.replace(/Ledger records in window: (\d+)/, (all, n) => `Ledger records in window: ${Number(n) + 1}`) } })
  assert.match(run.result.report, /Ledger records in window: 6/, 'guard against vacuity: the stub really raised the figure from 5 to 6')
  const seed = seedOutputs(run.repo)
  const res = runAttended(run)
  assert.match(res.out, /^PLACE no$/m, res.out)
  assert.match(res.out, /^REASON figure mismatch ledger/m, res.out)
  assertKept(seed)
})

test('AC-DATA-1 (attended): a returned sidecar entry whose key is not a proposal id is refused, nothing is placed and the last good files are untouched', async () => {
  const reader = await readerPromise
  const target = { kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: 'ci', job: 'stub-job', touches_always_on_lens: false, security_purposed: false }
  assert.equal(typeof reader.stableProposalId(target), 'string')
  const run = await attendedRun({ alter: (r) => { r.proposal_targets = { 'not-a-proposal-id': target } } })
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(run.resultFile, 'utf8')).proposal_targets), ['not-a-proposal-id'], 'guard against vacuity: the forged key is in the saved result')
  const seed = seedOutputs(run.repo)
  const res = runAttended(run)
  assert.match(res.out, /^PLACE no$/m, res.out)
  assert.match(res.out, /^REASON returned sidecar has a key that is not a proposal id$/m, res.out)
  assertKept(seed)
})

test('AC-PROD-8 (attended): a decided entry already in the sidecar is carried forward through the merge, with the report placed beside it', async () => {
  const reader = await readerPromise
  const target = { kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: 'ci', job: 'carried-job', touches_always_on_lens: false, security_purposed: false }
  const id = reader.stableProposalId(target)
  const run = await attendedRun()
  seedOutputs(run.repo, `${JSON.stringify({ [id]: target })}\n`)
  const res = runAttended(run)
  assert.match(res.out, /^PLACE yes$/m, res.out)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run.repo, SIDECAR_REL), 'utf8'))[id], target, 'the prior decided target is still there')
  assert.equal(fs.readFileSync(path.join(run.repo, REPORT_REL), 'utf8'), run.result.report)
})

test('AC-SEC-6 (attended): the returned nonce hash is checked against the nonce the operator generated, and a different one places nothing', async () => {
  const run = await attendedRun()
  const seed = seedOutputs(run.repo)
  const res = runAttended(run, { nonce: T2.OTHER_NONCE })
  assert.match(res.out, /^PLACE no$/m, res.out)
  assert.match(res.out, /^REASON .*nonce/m, res.out)
  assertKept(seed)
})

test('AC-DATA-2 (attended): a result file that is not the returned JSON object places nothing', async () => {
  const run = await attendedRun()
  fs.writeFileSync(run.resultFile, 'this is not json')
  const seed = seedOutputs(run.repo)
  const res = runAttended(run)
  assert.match(res.out, /^PLACE no$/m, res.out)
  assert.match(res.out, /^REASON session output: /m, res.out)
  assert.match(res.out, /^TOKENS ledger=5 /m, `the mode read the collected files in the per-run directory: ${res.out}`)
  assertKept(seed)
})

test('AC-QA-21 (attended): a stale sidecar lock left by a dead owner is taken over and the run places; the lock is gone afterwards, and also after a refused run', async () => {
  const dead = spawnSync(process.execPath, ['-e', '0'])
  const refused = await attendedRun({ alter: (r) => { delete r.proposal_targets } })
  fs.symlinkSync(`${dead.pid}:abc123`, lockPath(refused.repo))
  const refusedRes = runAttended(refused)
  assert.match(refusedRes.out, /^PLACE no$/m, refusedRes.out)
  assert.equal(fs.existsSync(lockPath(refused.repo)), false, 'the lock is released after a refused run')
  const run = await attendedRun()
  fs.symlinkSync(`${dead.pid}:abc123`, lockPath(run.repo))
  assert.ok(fs.lstatSync(lockPath(run.repo)).isSymbolicLink(), 'guard against vacuity: the stale lock is really there')
  const res = runAttended(run)
  assert.match(res.out, /^PLACE yes$/m, res.out)
  assert.equal(fs.existsSync(lockPath(run.repo)), false)
})

test('AC-DATA-2: the sidecar lock exists in one source file only, so the attended and unattended paths cannot hold two copies of it', () => {
  const holders = SOURCES.filter((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('optimise-sidecar.lock'))
  assert.equal(holders.length, 1, `the lock is named in: ${holders.join(', ')}`)
})

// ---- AC-PROD-5: same data, same text ----

const SECTIONS = ['Sample completeness', 'CI section', 'Escaped-defect counter-metric', 'Proposals (ranked)']
function sectionOf(report, name) {
  const lines = report.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(name))
  assert.ok(start >= 0, `the report has a "${name}" section`)
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start, end < 0 ? lines.length : end).join('\n')
}

test('AC-PROD-5: for the same repository, ledger and gh data, the attended flow and the weekly runner place identical text in the four named sections, CI run counts and omission notes included', async () => {
  const stubs = ghStubs([11, 12, 13])
  const run = await attendedRun({ stubs })
  const attended = runAttended(run)
  assert.match(attended.out, /^PLACE yes$/m, attended.out)
  const attendedReport = fs.readFileSync(path.join(run.repo, REPORT_REL), 'utf8')
  fs.rmSync(path.join(run.repo, REPORT_REL))
  fs.rmSync(path.join(run.repo, SIDECAR_REL))
  const weekly = runRunner([run.repo], { stubs })
  assert.equal(weekly.status, 0, weekly.logContents)
  const weeklyReport = fs.readFileSync(path.join(run.repo, REPORT_REL), 'utf8')
  assert.match(attendedReport, /^CI runs: 3 fetched/m, 'guard against vacuity: the attended report carries the CI run count')
  for (const name of SECTIONS) assert.equal(sectionOf(attendedReport, name), sectionOf(weeklyReport, name), name)
})

// ---- AC-SEC-6, AC-PROD-8, AC-SEC-18: the skill and the README say what is built ----

const REMOVED = [/report_path/, /proposal_targets_path/, /report:write/, /synthesis:ids/, /\bids step\b/, /rooted_rules|REPO_ALLOWED|IGNORE_HELPERS|edit_rule/, /Edit\(\/\//, /fans out to three/i, /\blane agents?\b/i, /\bscope agent\b/i]
for (const [name, text] of [['skills/optimise-cycle/SKILL.md', SKILL], ['README.md', README]]) {
  test(`AC-SEC-18/AC-PROD-8: ${name} describes none of the removed mechanisms (report-path arguments, the in-session ids step, the removed grants, the lane and scope agents)`, () => {
    for (const re of REMOVED) {
      const hit = re.exec(text)
      assert.equal(hit, null, `${name} still mentions ${re}: ${hit && text.slice(Math.max(0, hit.index - 60), hit.index + 100)}`)
    }
  })
}

test('AC-SEC-18: README.md and the skill state the unattended session\'s tool set exactly as the runner\'s invocation passes it', () => {
  const res = runRunner([F.makeRepo({ ledger: F.validLedger(3), fix: 1, other: 1, author: AUTHOR })], { stubs: ghStubs() })
  const argv = res.sessions()[0].argv
  const values = (flagName) => {
    const i = argv.indexOf(flagName)
    const out = []
    for (let j = i + 1; i >= 0 && j < argv.length && !argv[j].startsWith('--'); j += 1) out.push(argv[j])
    return out
  }
  const denied = values('--disallowedTools')
  assert.ok(denied.length >= 6, `guard against vacuity: the runner denies whole tools: ${denied}`)
  for (const [name, text] of [['README.md', README], ['SKILL.md', SKILL]]) {
    for (const flagName of ['--allowedTools', '--disallowedTools', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', '--setting-sources']) assert.ok(text.includes(flagName), `${name} names ${flagName}`)
    for (const tool of denied) assert.ok(text.includes(tool), `${name} names the denied tool ${tool}`)
    assert.match(text, /dontAsk/, name)
    assert.match(text, /--setting-sources user/, name)
    assert.match(text, /user-level allow rules[^.]*\bRead\b[^.]*\bSkill\b[^.]*\bAgent\b[^.]*\bWorkflow\b/s, `${name} states the residual risk for the tools that are not denied whole`)
  }
  assert.match(README, /2\.1\.322/, 'the measured facts carry their CLI version')
})

test('AC-PROD-8: README.md and the skill define PASS by content and say a run not scored PASS is not a dry cycle; the shape-only rule is gone', () => {
  for (const [name, text] of [['README.md', README], ['SKILL.md', SKILL]]) {
    assert.match(text, /every lane ran/i, `${name} defines PASS by every lane having run`)
    assert.match(text, /does not count as a dry cycle/i, name)
    assert.match(text, /the runner collects/i, `${name} says the runner collects`)
  }
  assert.ok(!/non-empty with at least a markdown heading/i.test(README), 'the shape-only PASS rule is gone from the README')
})

test('AC-DATA-2/AC-SEC-6: the skill drives the attended run step by step with exact commands, has the session write nothing itself, and states that it reads the digest unfenced', () => {
  const at = (re) => {
    const m = re.exec(SKILL)
    assert.ok(m, `the skill has ${re}`)
    return m.index
  }
  const order = [/mktemp -d/, /optimise-collect\.mjs/, /randomBytes\(16\)|openssl rand -hex 16/, /Read[^\n]*digest\.json/, /Workflow[^\n]*optimise-cycle/, /optimise-verify\.mjs attended/, /rm -rf/].map(at)
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the steps are in the order: directory, collect, nonce, read, workflow, check and place, clean up')
  assert.match(SKILL, /chmod 700|0700/, 'the per-run directory is private')
  assert.match(SKILL, /digest[^\n]{0,80}nonce/, 'the workflow is called with the digest and the nonce')
  assert.match(SKILL, /never writes the report or the sidecar by hand/i, 'no second writer')
  assert.match(SKILL, /unfenced/i, 'the operator session reads collected text outside the nonce fence')
  assert.match(SKILL, /nonce echo|SHA-256 of the nonce|nonce hash/i, 'the nonce echo check is kept')
  assert.ok(!SKILL.includes('$('), 'no command substitution')
})

// ---- AC-OPS-16: a runbook row for every fixed reason and cause the code can emit, and none for one it cannot ----

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const RUNNER = read('bin/optimise-cycle-weekly.sh')
const VERIFY_SRC = read('workflows/lib/optimise-verify.mjs')
const COLLECT_SRC = read('workflows/lib/optimise-collect.mjs')
const ALL_SOURCE = `${RUNNER}\n${VERIFY_SRC}\n${COLLECT_SRC}`

// The fixed words a reason starts with, ahead of any substituted value.
function lead(text) {
  return text.replace(/\$\{[^}]*:-([^}]*)\}/, '$1').split(/\$|\$\{/)[0].replace(/[\s:(,]+$/, '').trim()
}
const all = (re, text, group) => [...text.matchAll(re)].map((m) => m[group])
function functionText(src, name) {
  const m = new RegExp(`(?:export )?function ${name}\\b[\\s\\S]*?\\n\\}\\n`).exec(src)
  assert.ok(m, `${name} is in the source`)
  return m[0]
}

function emittedReasons() {
  const runner = [
    ...all(/reasons\+=\("([^"]+)"\)/g, RUNNER, 1),
    ...all(/reason="([^"]+)"/g, RUNNER, 1),
    ...all(/fail_repo "[^"]*" "([^"]+)"/g, RUNNER, 1),
    ...all(/collect_reason="([^"]+)"/g, RUNNER, 1),
  ]
  const verify = [
    ...all(/failure\((['`])((?:(?!\1).)*)\1/g, VERIFY_SRC, 2),
    ...all(/reasons\.push\((['`])((?:(?!\1).)*)\1/g, VERIFY_SRC, 2),
    ...all(/SIDECAR_UNREADABLE = '([^']*)'/g, VERIFY_SRC, 1),
    ...all(/'((?:result|returned)[^']*)'/g, functionText(VERIFY_SRC, 'nonceProblem'), 1),
    ...all(/'(returned[^']*)'/g, functionText(VERIFY_SRC, 'validateReturnedSidecar'), 1),
  ]
  const collect = [
    ...all(/new LaneFailure\('[a-z_]+', (['`])((?:(?!\1).)*)\1/g, COLLECT_SRC, 2),
    ...all(/\n  \[\/[^\n]*\/i?, '([^']+)'\],/g, COLLECT_SRC, 1),
    ...all(/_REASON = '([^']*)'/g, COLLECT_SRC, 1),
  ]
  return { runner, verify, collect }
}

function emittedTokens() {
  const causes = new Set([
    ...all(/(?:SESSION_CAUSE|VERIFY_CAUSE)="([a-z_]+)"/g, RUNNER, 1),
    ...all(/interrupted_cause=([a-z_]+)/g, RUNNER, 1),
    ...all(/cause: '([a-z_]+)'/g, VERIFY_SRC, 1),
    ...all(/, '([a-z_]+)'\)(?:\n| *$)/gm, VERIFY_SRC.split('\n').filter((l) => /failure\(/.test(l)).join('\n'), 1),
  ])
  const modes = new Set([
    ...all(/new LaneFailure\('([a-z_]+)'/g, COLLECT_SRC, 1),
    ...all(/failed:([a-z_]+)/g, RUNNER, 1).filter((m) => m !== 'other'),
    'absent_from_path', 'unauthenticated', 'rate_limited', 'timeout', 'could_not_read', 'other',
  ])
  return { causes: [...causes], modes: [...modes] }
}

function runbookRows() {
  const start = README.search(/^#{3,5} .*Runbook.*$/m)
  assert.ok(start >= 0, 'README.md has a heading containing "Runbook"')
  const body = README.slice(start).split('\n').slice(1)
  const rows = []
  for (const line of body) {
    if (/^#{1,5} /.test(line) && rows.length > 0) break
    const cells = line.split('|').map((c) => c.trim())
    const first = /^`([^`]+)`$/.exec(cells[1] || '')
    if (cells.length >= 5 && first) rows.push({ key: first[1].split('<')[0].trim(), cells: cells.slice(1, -1), raw: first[1] })
  }
  return rows
}

test('AC-OPS-16: the runbook has a row for every fixed FAIL reason the runner, the digest and the result check emit, each with what it means, what to check and what to do', () => {
  const { runner, verify, collect } = emittedReasons()
  assert.ok(runner.length >= 12 && verify.length >= 14 && collect.length >= 8, `guard against vacuity: the extraction found ${runner.length} runner, ${verify.length} result check and ${collect.length} collector reasons`)
  const rows = runbookRows()
  assert.ok(rows.length > 0, 'the runbook has rows')
  for (const row of rows) assert.ok(row.cells.length === 4 && row.cells.every((c) => c.length > 2), `row \`${row.raw}\` has four filled cells: ${row.cells}`)
  const missing = [...new Set([...runner, ...verify, ...collect].map(lead).filter((l) => l.length > 0))].filter((l) => !rows.some((r) => r.key !== '' && (l === r.key || l.startsWith(r.key))))
  assert.deepEqual(missing, [], 'every fixed reason has a runbook row whose first cell is its leading words in backticks')
})

test('AC-OPS-16: every cause token and every collector failure mode has a runbook row (`cause=<token>`, `failed:<mode>`)', () => {
  const { causes, modes } = emittedTokens()
  assert.ok(causes.length >= 6 && modes.length >= 6, `guard against vacuity: ${causes} / ${modes}`)
  const keys = new Set(runbookRows().map((r) => r.raw))
  assert.deepEqual(causes.filter((c) => !keys.has(`cause=${c}`)), [])
  assert.deepEqual(modes.filter((m) => !keys.has(`failed:${m}`)), [])
})

test('AC-OPS-16: no runbook row names a reason, cause or mode the code no longer emits', () => {
  const stale = runbookRows().filter((r) => {
    const key = r.key.replace(/^cause=|^failed:/, '')
    return key === '' || !ALL_SOURCE.includes(key)
  })
  assert.deepEqual(stale.map((r) => r.raw), [])
})
