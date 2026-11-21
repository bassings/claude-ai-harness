// HARN-RUNNER-2 T1b: the collector's hand-off (AC-QA-1, AC-QA-19, AC-ARCH-1,
// AC-SEC-6, AC-SEC-11, AC-SEC-12).
//
// The collector writes, beside ledger.json, git.json and ci.json, ONE bounded
// digest.json per repository that a workflow script can be handed whole. The
// contract these tests pin (task T2 builds against it):
//
//   collectRepo({ root, outDir, timeoutMs, window })
//     window: positive integer, default 90, anything else refused with a
//     TypeError before any command runs or any file is written. The command
//     line takes it as an optional third positional argument, validated alike.
//
//   <outDir>/digest.json (pretty printed, mode 0600, at most DIGEST_MAX_BYTES,
//   no line over DIGEST_MAX_LINE_CHARS):
//     lanes:  { ledger, git, ci }, each { status, mode, reason } (mode and
//             reason are null when the lane record carries none); ci also
//             carries runCount, fetchFailedCount, timeoutCount
//     ledger: null when the ledger lane failed, else { n, windowTruncated,
//             windowDroppedCount, perRepo, skippedCount (the length of
//             skipped), rework (without acVerdicts), blockedUnresolved (every
//             string cut to BLOCKED_STRING_MAX_CHARS, without byModel),
//             wallClock { totals, byPlan, source }, triggerAccuracy,
//             proposalOutcomes, citationPool, neverFailingAcs (only the rows
//             that do not render as plain insufficient data, each with the
//             render's keys), neverFailingInsufficientCount }
//     git:    null when the git lane failed, else the whole git result
//     ci:     null when the ci lane failed, else the whole ci result
//     plan_labels: [{ task_id, title }], plan_labels_note: null or fixed text
//     dropped: { wallClockByPlan, proposalOutcomes, planLabels } counts of
//             entries left out by the entry-count caps
//     freeTextPaths: every location in the digest that holds text which
//             originated in a repository, so task T2 can fence exactly those
//             (AC-SEC-6). Path grammar: dot separated segments; `name` a
//             member, `name[*]` every element of the array at that member,
//             `*` every member value of an object, `*^` every member KEY of
//             an object (the key string itself). A path denotes the strings
//             at its end.
//
//   When the caps cannot bring the digest under the byte bound it is NOT
//   written; the returned lanes.digest says { lane: 'digest', status: 'failed',
//   mode, reason } with fixed text and the COLLECT line ends with
//   ` digest=failed:<mode>`. On success lanes.digest is { lane: 'digest',
//   status: 'ran' } and the COLLECT line is unchanged.
//
// The new tests use stub gh and git first on PATH and temporary repositories (the
// shared fixtures in test/helpers/collector-fixtures.js), every fixture commit
// has an explicit identity, and nothing contacts a network.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { cleanupTempRepos, SUITE_TMPDIR, sanitizedGitEnv } = require('./helpers/temp-repo.js')
const F = require('./helpers/collector-fixtures.js')
const { COLLECTOR, REAL_GIT, makeStubs, makeRepo, ledgerLine, validLedger, scratchDir, childEnv, lane, setGhRuns, recorded, job, run } = F

const READER = path.join(__dirname, '..', 'workflows', 'lib', 'optimise-read.mjs')
const DIGEST_FILES = ['ci.json', 'digest.json', 'git.json', 'ledger.json']
const byName = (a, b) => a.localeCompare(b)

test.after(cleanupTempRepos)

const loadCollector = () => import(pathToFileURL(COLLECTOR).href)
const loadReader = () => import(pathToFileURL(READER).href)
const digestOf = (outDir) => JSON.parse(fs.readFileSync(path.join(outDir, 'digest.json'), 'utf8'))

// ---- driving the collector with an option set and reading back what it returned ----

const JSON_DRIVER = `import(process.argv[1]).then(async (m) => { const r = await m.collectRepo(JSON.parse(process.argv[2])); const lanes = {}; for (const [k, v] of Object.entries(r.lanes)) lanes[k] = { lane: v.lane, status: v.status, mode: v.mode ?? null, reason: v.reason ?? null }; process.stdout.write(JSON.stringify({ line: r.line, lanes })) }).catch((e) => { console.error(String(e?.stack)); process.exit(3) })`

function drive(stubs, opts, extraEnv = {}) {
  const res = spawnSync(process.execPath, ['-e', JSON_DRIVER, pathToFileURL(COLLECTOR).href, JSON.stringify(opts)], { cwd: scratchDir(), env: childEnv(stubs, extraEnv), encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(res.status, 0, `collectRepo must resolve, status ${res.status}, stderr: ${res.stderr}`)
  return { ...JSON.parse(res.stdout), res }
}

function runCliArgs(stubs, args, extraEnv = {}) {
  return spawnSync(process.execPath, [COLLECTOR, ...args], { cwd: scratchDir(), env: childEnv(stubs, extraEnv), encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
}

// A stub gh with a few runs and jobs, so the ci lane measures something.
function stubsWithRuns(jobNames = ['build', 'test']) {
  const stubs = makeStubs()
  const runs = [run(11), run(12), run(13)]
  const views = Object.fromEntries(runs.map((r) => [r.databaseId, { jobs: jobNames.map((n) => job(n)) }]))
  setGhRuns(stubs, runs, views)
  return stubs
}

// Extra commits with an explicit identity, written with fast-import so a 500-commit
// history costs one process, not five hundred.
function addCommits(root, count) {
  const stream = Array.from({ length: count }, (_, i) => {
    const msg = `chore: bulk ${i}`
    const parent = i === 0 ? 'from refs/heads/main^0\n' : ''
    return `commit refs/heads/main\ncommitter T1b Fixture <fixture@example.com> ${1_700_000_000 + i} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}\n${parent}`
  }).join('\n')
  const res = spawnSync(REAL_GIT, ['-C', root, 'fast-import', '--quiet'], { input: stream, encoding: 'utf8', env: sanitizedGitEnv() })
  assert.equal(res.status, 0, `fast-import failed: ${res.stderr}`)
}

// ---- 1. the window ----

test('T1b window: with no window given the reader is called with 90 records, the weekly runner\'s own figure', () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(120), fix: 1 })
  const outDir = scratchDir()
  drive(stubs, { root, outDir })
  const result = lane(outDir, 'ledger').result
  assert.equal(result.n, 90, 'the default window is 90 records, not the reader\'s 2,000')
  assert.equal(result.windowTruncated, true)
  assert.equal(result.windowDroppedCount, 30)
})

test('T1b window: a window given to collectRepo is the window the reader is called with', () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(120), fix: 1 })
  const outDir = scratchDir()
  drive(stubs, { root, outDir, window: 7 })
  const result = lane(outDir, 'ledger').result
  assert.equal(result.n, 7)
  assert.equal(result.windowTruncated, true)
  assert.equal(result.windowDroppedCount, 113)
})

test('T1b window: a window larger than the ledger reads every record and is not truncated', () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(120), fix: 1 })
  const outDir = scratchDir()
  drive(stubs, { root, outDir, window: 5000 })
  const result = lane(outDir, 'ledger').result
  assert.equal(result.n, 120)
  assert.equal(result.windowTruncated, false)
})

test('T1b window: anything but a positive integer is refused with a TypeError before any file is written', async () => {
  const { collectRepo } = await loadCollector()
  const root = makeRepo({ ledger: validLedger(3) })
  // In process, so were a bad window accepted the collector would run: give it the stub gh and git, never the real ones.
  const realPath = process.env.PATH
  process.env.PATH = makeStubs().bin
  const bads = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '90', '7', null, true, [7], {}]
  await Promise.all(bads.map(async (bad) => {
    const outDir = path.join(scratchDir(), 'out')
    await assert.rejects(collectRepo({ root, outDir, window: bad }), TypeError, `window ${String(bad)} must be refused`)
    assert.equal(fs.existsSync(outDir), false, `window ${String(bad)}: nothing may be written`)
  })).finally(() => {
    process.env.PATH = realPath
  })
})

test('T1b window: the command line takes the window as an optional third argument', () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(120), fix: 1 })
  const outDir = scratchDir()
  const res = runCliArgs(stubs, [root, outDir, '7'])
  assert.equal(res.status, 0, res.stderr)
  assert.equal(lane(outDir, 'ledger').result.n, 7)
  const dflt = scratchDir()
  assert.equal(runCliArgs(stubs, [root, dflt]).status, 0)
  assert.equal(lane(dflt, 'ledger').result.n, 90)
})

test('T1b window: a third argument that is not a positive integer, or a fourth argument, exits non-zero with a usage message and runs nothing', () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(3) })
  for (const args of [['0'], ['-3'], ['2.5'], ['abc'], ['1e3'], [''], ['Infinity'], ['7', 'extra']]) {
    const outDir = scratchDir()
    const res = runCliArgs(stubs, [root, outDir, ...args])
    assert.notEqual(res.status, 0, `arguments ${JSON.stringify(args)} must be refused`)
    assert.match(res.stderr, /usage|window/i, `stderr: ${res.stderr}`)
    assert.deepEqual(fs.readdirSync(outDir), [], 'nothing may be written')
    assert.equal(recorded(stubs, 'GIT').length + recorded(stubs, 'GH').length, 0, 'no git or gh command may run before the arguments are validated')
  }
})

// ---- 2. the digest: its shape, its figures, its bounds ----

const BIG = { specs: 30, acsPerSpec: 30, waitPlans: 120, proposals: 120 }

// A ledger whose un-digested result is far over 200,000 characters: 900 criteria rows that
// are plain insufficient data (one verdict each), two criteria with enough runs to carry a
// verdict, one criterion whose own verdicts disagree inside one run, 120 plans and 120
// proposals (past any entry cap), and a blocked task whose text is 5,000 characters.
function bigLedger() {
  const lines = []
  let i = 0
  const rec = (extra) => ledgerLine(i++, { repo: 'demo-CANARY', ...extra })
  for (let s = 0; s < BIG.specs; s++) {
    const verdicts = Array.from({ length: BIG.acsPerSpec }, (_, a) => ({ ac_id: `AC-S${s}-${a + 1}`, verdict: 'PASS' }))
    lines.push(rec({ kind: 'review_cycle', spec: `specs/plan-${s}-CANARY.md`, round_key: `k${s}`, findings: [], ac_verdicts: verdicts }))
  }
  for (let r = 0; r < 6; r++) {
    const verdicts = [{ ac_id: 'AC-QA-1', verdict: 'PASS' }, { ac_id: 'AC-QA-2', verdict: r === 3 ? 'FAIL' : 'PASS' }]
    lines.push(rec({ kind: 'review_cycle', spec: 'specs/main-CANARY.md', round_key: `m${r}`, findings: [], ac_verdicts: verdicts }))
  }
  lines.push(rec({ kind: 'review_cycle', spec: 'specs/dis-CANARY.md', round_key: 'd1', findings: [], ac_verdicts: [{ ac_id: 'AC-DIS-1', verdict: 'PASS' }, { ac_id: 'AC-DIS-1', verdict: 'FAIL' }] }))
  for (let p = 0; p < BIG.waitPlans; p++) lines.push(rec({ kind: 'conduct_plan_event', event: 'ci_wait_started', event_key: `specs/wp-${p}-CANARY.md:T1:ci_wait_started:1` }))
  for (let p = 0; p < BIG.proposals; p++) lines.push(rec({ kind: 'conduct_plan_event', event: 'proposal_adopted', event_key: `propCANARY${p}:proposal_adopted:1` }))
  lines.push(rec({ kind: 'tdd_task', outcome: 'blocked', spec: 'specs/main-CANARY.md', task: `CANARY-task ${'T'.repeat(5000)}` }))
  return lines.join('\n') + '\n'
}

const SPEC_A = [
  '# Plan A', '', '## Tasks', '',
  '- [x] T1: first CANARY-title thing -- state: merged',
  '- [ ] T2: second thing', '',
  '## Conductor log', '',
  '- [ ] T9: this line is outside the Tasks section',
  '',
].join('\n')

function writeSpec(root, name, text) {
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'specs', name), text)
}

// One repository that exercises every free-text origin, a window wide enough for all of it.
function richCollection() {
  const stubs = stubsWithRuns(['build-CANARY-job', 'test'])
  const root = makeRepo({ ledger: bigLedger(), fix: 2, other: 1, subjects: ['fix: CANARY-subject thing'] })
  writeSpec(root, 'a.md', SPEC_A)
  fs.writeFileSync(path.join(root, '.claude', 'harness-triggers.json'), JSON.stringify({ escapedDefectExcludePaths: ['CANARY-docs/**'] }))
  const outDir = scratchDir()
  const out = drive(stubs, { root, outDir, window: 5000 })
  return { stubs, root, outDir, out }
}

const rich = (() => {
  let cached = null
  return () => (cached ??= richCollection())
})()

const sizeOf = (file) => fs.statSync(file).size

test('T1b digest: the ledger result for the large ledger is over 200,000 characters, so the digest is a real reduction', () => {
  const { outDir } = rich()
  assert.ok(JSON.stringify(lane(outDir, 'ledger').result).length > 200000, 'the fixture must exceed 200,000 characters un-digested')
})

test('T1b digest: digest.json is written beside the three lane files, parses, is under the byte bound and has no long line', async () => {
  const { outDir } = rich()
  const mod = await loadCollector()
  assert.equal(mod.DIGEST_MAX_BYTES, 32768)
  assert.equal(mod.DIGEST_MAX_LINE_CHARS, 2000)
  assert.deepEqual(fs.readdirSync(outDir).sort(byName), DIGEST_FILES, 'exactly the four files, no temporary file left behind')
  const file = path.join(outDir, 'digest.json')
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(sizeOf(file) <= mod.DIGEST_MAX_BYTES, `digest is ${sizeOf(file)} bytes`)
  assert.doesNotThrow(() => JSON.parse(text))
  const longest = Math.max(...text.split('\n').map((l) => l.length))
  assert.ok(longest <= mod.DIGEST_MAX_LINE_CHARS, `the longest line is ${longest} characters`)
  assert.ok(text.split('\n').length > 20, 'the document is pretty printed, one value per line')
})

test('T1b digest: the file is mode 0600 even when a looser digest.json already exists in the output directory', () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(3), fix: 1 })
  const outDir = scratchDir()
  fs.writeFileSync(path.join(outDir, 'digest.json'), 'old', { mode: 0o644 })
  fs.chmodSync(path.join(outDir, 'digest.json'), 0o644)
  drive(stubs, { root, outDir })
  assert.equal(fs.statSync(path.join(outDir, 'digest.json')).mode & 0o777, 0o600)
  assert.doesNotThrow(() => digestOf(outDir), 'the old content is replaced')
})

test('T1b digest: every figure in it equals the same figure in ledger.json, git.json and ci.json', () => {
  const { outDir } = rich()
  const d = digestOf(outDir)
  const L = lane(outDir, 'ledger').result
  assert.equal(d.ledger.n, L.n)
  assert.equal(d.ledger.windowTruncated, L.windowTruncated)
  assert.equal(d.ledger.windowDroppedCount, L.windowDroppedCount)
  assert.deepEqual(d.ledger.perRepo, L.perRepo)
  assert.equal(d.ledger.skippedCount, L.skipped.length)
  assert.ok(!('skipped' in d.ledger), 'the skipped list itself is not carried')
  const { acVerdicts, ...reworkWithout } = L.rework
  assert.ok(Array.isArray(acVerdicts) && acVerdicts.length > 0, 'the fixture has acVerdicts to leave out')
  assert.deepEqual(d.ledger.rework, reworkWithout)
  assert.ok(!('acVerdicts' in d.ledger.rework))
  assert.deepEqual(d.ledger.wallClock.totals, L.wallClock.totals)
  assert.deepEqual(d.ledger.wallClock.source, L.wallClock.source)
  assert.deepEqual(d.ledger.triggerAccuracy, L.triggerAccuracy)
  assert.deepEqual(d.ledger.citationPool, L.citationPool)
  assert.deepEqual(d.git, lane(outDir, 'git').result)
  assert.deepEqual(d.ci, lane(outDir, 'ci').result)
  for (const key of ['byJob', 'citationPool', 'failures', 'repoStats', 'ghStats']) assert.ok(key in d.ci, `ci.${key}`)
})

test('T1b digest: lane statuses, modes, fixed reasons and the CI envelope counts are carried', () => {
  const { outDir } = rich()
  const d = digestOf(outDir)
  for (const name of ['ledger', 'git', 'ci']) {
    const record = lane(outDir, name)
    assert.equal(d.lanes[name].status, record.status, name)
    assert.equal(d.lanes[name].mode ?? null, record.mode ?? null, name)
    assert.equal(d.lanes[name].reason ?? null, record.reason ?? null, name)
  }
  const ci = lane(outDir, 'ci')
  assert.equal(ci.runCount, 3, 'the fixture lists three runs')
  assert.equal(d.lanes.ci.runCount, 3)
  assert.equal(d.lanes.ci.fetchFailedCount, 0)
  assert.equal(d.lanes.ci.timeoutCount, 0)
})

test('T1b digest: a failed lane is null in the digest with its status, mode, fixed reason and null counts', () => {
  const stubs = makeStubs({ gh: false })
  const root = makeRepo({ ledger: validLedger(3), fix: 1 })
  const outDir = scratchDir()
  drive(stubs, { root, outDir })
  const d = digestOf(outDir)
  assert.equal(d.ci, null)
  assert.deepEqual(d.lanes.ci, { status: 'failed', mode: 'absent_from_path', reason: 'gh was not found on PATH', runCount: null, fetchFailedCount: null, timeoutCount: null })
  assert.equal(d.lanes.ledger.status, 'ran')
  assert.equal(d.ledger.n, 3)
  assert.equal(d.git.count, 1)
})

test('T1b digest: a failed ledger lane leaves the git figure in place (the git figure is not discarded)', () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(3), fix: 2 })
  fs.rmSync(path.join(root, '.claude', 'harness-ledger.jsonl'))
  fs.symlinkSync('/dev/null', path.join(root, '.claude', 'harness-ledger.jsonl'))
  const outDir = scratchDir()
  drive(stubs, { root, outDir })
  const d = digestOf(outDir)
  assert.equal(d.ledger, null)
  assert.equal(d.lanes.ledger.status, 'failed')
  assert.equal(d.lanes.ledger.mode, 'could_not_read')
  assert.equal(d.git.count, 2)
  assert.equal(d.lanes.git.status, 'ran')
})

test('T1b digest: the blocked section keeps count, byReason and reasonNotRecorded, drops byModel and cuts every string to the named limit', async () => {
  const { outDir } = rich()
  const { BLOCKED_STRING_MAX_CHARS } = await loadCollector()
  assert.equal(BLOCKED_STRING_MAX_CHARS, 120)
  const source = lane(outDir, 'ledger').result.blockedUnresolved
  assert.ok(source.unresolved.some((u) => u.task.length > 5000), 'the fixture has a task over 5,000 characters')
  const got = digestOf(outDir).ledger.blockedUnresolved
  assert.ok(!('byModel' in got))
  assert.equal(got.count, source.count)
  assert.deepEqual(got.byReason, source.byReason)
  assert.equal(got.reasonNotRecorded, source.reasonNotRecorded)
  const cut = (v) => (typeof v === 'string' ? v.slice(0, BLOCKED_STRING_MAX_CHARS) : v)
  assert.deepEqual(got.unresolved, source.unresolved.map((u) => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, cut(v)]))))
})

test('T1b digest: the never-failing section keeps exactly the rows the render would not show as plain insufficient data, with the render\'s keys, and counts the rest', () => {
  const { outDir } = rich()
  const rows = lane(outDir, 'ledger').result.neverFailingAcs
  assert.ok(rows.length >= 900, `the fixture has ${rows.length} rows`)
  // The render (workflows/optimise-cycle.js, "Never-failing acceptance criteria") shows the verdict or
  // the taint reason of a row that has enough runs, and appends the disagreement count to every row.
  // A plain row is insufficient data whose disagreement count is zero or absent.
  const plain = (r) => Boolean(r.insufficient_data) && (r.verdict_disagreements === 0 || r.verdict_disagreements === undefined)
  const keys = ['repo', 'spec', 'ac_id', 'n', 'insufficient_data', 'unattributed_fail_in_window', 'unattributed_verdict_in_entry', 'truncated_in_window', 'never_failed', 'verdict_disagreements']
  const expected = rows.filter((r) => !plain(r)).map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])))
  const d = digestOf(outDir).ledger
  assert.ok(expected.length >= 3, 'the fixture has two criteria with verdicts and one with a disagreement')
  assert.deepEqual(d.neverFailingAcs, expected)
  assert.equal(d.neverFailingInsufficientCount, rows.length - expected.length)
  assert.ok(d.neverFailingAcs.some((r) => r.ac_id === 'AC-QA-2' && r.never_failed === false))
  assert.ok(d.neverFailingAcs.some((r) => r.ac_id === 'AC-DIS-1' && r.insufficient_data === true && r.verdict_disagreements > 0))
})

test('T1b digest: the shared pure function says which never-failing rows are plain insufficient data, by the render\'s own rule', async () => {
  const { isPlainInsufficientRow } = await loadReader()
  assert.equal(typeof isPlainInsufficientRow, 'function')
  const base = { repo: 'r', spec: 's', ac_id: 'AC-X-1', n: 2, insufficient_data: true, unattributed_fail_in_window: false, unattributed_verdict_in_entry: false, truncated_in_window: false, never_failed: null, verdict_disagreements: 0 }
  const table = [
    ['insufficient, no disagreements', base, true],
    ['insufficient, disagreement count absent', { ...base, verdict_disagreements: undefined }, true],
    ['insufficient, a disagreement', { ...base, verdict_disagreements: 2 }, false],
    ['insufficient, disagreements not measured', { ...base, verdict_disagreements: null }, false],
    ['insufficient with a window-wide taint: the render shows insufficient first', { ...base, unattributed_fail_in_window: true }, true],
    ['enough runs, never failed', { ...base, n: 7, insufficient_data: false, never_failed: true }, false],
    ['enough runs, failed', { ...base, n: 7, insufficient_data: false, never_failed: false }, false],
    ['enough runs, tainted by an unattributed failure', { ...base, n: 7, insufficient_data: false, unattributed_fail_in_window: true }, false],
    ['enough runs, tainted by an unattributed verdict', { ...base, n: 7, insufficient_data: false, unattributed_verdict_in_entry: true }, false],
    ['enough runs, tainted by a truncated window', { ...base, n: 7, insufficient_data: false, truncated_in_window: true, verdict_disagreements: null }, false],
  ]
  for (const [name, row, want] of table) assert.equal(isPlainInsufficientRow(row), want, name)
})

test('T1b digest: wallClock.byPlan and proposalOutcomes are capped by entry count and the number dropped is recorded', async () => {
  const { outDir } = rich()
  const mod = await loadCollector()
  const L = lane(outDir, 'ledger').result
  const d = digestOf(outDir)
  const plans = Object.keys(L.wallClock.byPlan)
  const outcomes = Object.keys(L.proposalOutcomes)
  assert.ok(plans.length > mod.DIGEST_MAX_BYPLAN_ENTRIES, `fixture has ${plans.length} plans, cap ${mod.DIGEST_MAX_BYPLAN_ENTRIES}`)
  assert.ok(outcomes.length > mod.DIGEST_MAX_PROPOSAL_OUTCOMES, `fixture has ${outcomes.length} outcomes, cap ${mod.DIGEST_MAX_PROPOSAL_OUTCOMES}`)
  const keptPlans = Object.keys(d.ledger.wallClock.byPlan)
  const keptOutcomes = Object.keys(d.ledger.proposalOutcomes)
  assert.equal(keptPlans.length, mod.DIGEST_MAX_BYPLAN_ENTRIES)
  assert.equal(keptOutcomes.length, mod.DIGEST_MAX_PROPOSAL_OUTCOMES)
  assert.equal(d.dropped.wallClockByPlan, plans.length - keptPlans.length)
  assert.equal(d.dropped.proposalOutcomes, outcomes.length - keptOutcomes.length)
  for (const k of keptPlans) assert.deepEqual(d.ledger.wallClock.byPlan[k], L.wallClock.byPlan[k], `plan ${k}`)
  for (const k of keptOutcomes) assert.deepEqual(d.ledger.proposalOutcomes[k], L.proposalOutcomes[k], `outcome ${k}`)
})

test('T1b digest: when nothing needs dropping the dropped counts are zero', () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(3), fix: 1 })
  const outDir = scratchDir()
  drive(stubs, { root, outDir })
  assert.deepEqual(digestOf(outDir).dropped, { wallClockByPlan: 0, proposalOutcomes: 0, planLabels: 0 })
})

test('T1b digest: a digest the caps cannot bring under the byte bound is not written, and the lane status says so with a fixed reason', () => {
  // The whole ci result is carried, so CI data with thousands of distinct job names cannot be capped away.
  const stubs = makeStubs()
  const runs = [run(21), run(22), run(23)]
  const jobsFor = (r) => ({ jobs: Array.from({ length: 700 }, (_, j) => job(`job-${r.databaseId}-${j}-${'x'.repeat(40)}`)) })
  setGhRuns(stubs, runs, Object.fromEntries(runs.map((r) => [r.databaseId, jobsFor(r)])))
  const root = makeRepo({ ledger: validLedger(3), fix: 1 })
  const outDir = scratchDir()
  const out = drive(stubs, { root, outDir })
  assert.ok(sizeOf(path.join(outDir, 'ci.json')) > 32768, 'the fixture\'s ci result alone is over the bound')
  assert.equal(fs.existsSync(path.join(outDir, 'digest.json')), false, 'no digest, and in particular no truncated one')
  assert.equal(out.lanes.digest.lane, 'digest')
  assert.equal(out.lanes.digest.status, 'failed')
  assert.match(out.lanes.digest.mode, /^[a-z_]+$/)
  assert.match(out.lanes.digest.reason, /32768|size|bound|limit/i)
  assert.ok(!/job-2\d-/.test(out.lanes.digest.reason), 'the reason is fixed text, never collected data')
  assert.ok(out.line.endsWith(` digest=failed:${out.lanes.digest.mode}`), `the log line: ${out.line}`)
  assert.deepEqual(fs.readdirSync(outDir).sort(byName), ['ci.json', 'git.json', 'ledger.json'], 'the lane files are still there')
})

test('T1b digest: a hostile free-text value 5,000 characters long never produces a long line or an over-size file', async () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(4, { repo: `CANARY-${'r'.repeat(5000)}` }), fix: 1 })
  const outDir = scratchDir()
  const out = drive(stubs, { root, outDir })
  const mod = await loadCollector()
  const file = path.join(outDir, 'digest.json')
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(Math.max(...text.split('\n').map((l) => l.length)) <= mod.DIGEST_MAX_LINE_CHARS)
    assert.ok(sizeOf(file) <= mod.DIGEST_MAX_BYTES)
  } else {
    assert.equal(out.lanes.digest.status, 'failed', 'either the digest holds short lines or the lane says it was not written')
  }
})

test('T1b digest: a successful collection leaves the COLLECT line exactly as before and reports the digest lane as ran', () => {
  const { out } = rich()
  assert.equal(out.lanes.digest.status, 'ran')
  assert.match(out.line, /^COLLECT ledger=ran git=ran ci=ran calls=ledger:\d+,git:\d+,ci:\d+ wall_clock_s=ledger:[\d.]+,git:[\d.]+,ci:[\d.]+ ci_runs=fetched:3,not_fetched:0,timeout:0$/)
})

// ---- the free-text paths (AC-SEC-6) ----

const KEY = '\u0001key'

// The locations a freeTextPaths pattern denotes: strings only, keys marked.
function memberKids(node, name) {
  if (name === '*') return Object.entries(node)
  return Object.hasOwn(node, name) ? [[name, node[name]]] : []
}

function expand(value, loc, each) {
  if (!each) return [{ node: value, loc }]
  return Array.isArray(value) ? value.map((el, idx) => ({ node: el, loc: [...loc, String(idx)] })) : []
}

function stepPart(frontier, part) {
  const each = part.endsWith('[*]')
  const name = each ? part.slice(0, -3) : part
  const next = []
  for (const { node, loc } of frontier) {
    if (node === null || typeof node !== 'object') continue
    if (name === '*^') next.push(...Object.keys(node).map((k) => ({ node: k, loc: [...loc, k + KEY] })))
    else for (const [k, v] of memberKids(node, name)) next.push(...expand(v, [...loc, k], each))
  }
  return next
}

function denote(root, pattern) {
  const frontier = pattern.split('.').reduce(stepPart, [{ node: root, loc: [] }])
  return frontier.filter(({ node }) => typeof node === 'string').map(({ loc }) => loc.join('\u0000'))
}

// Every location in the document whose string (value or key) holds the marker.
function locationsHolding(node, marker, loc = [], out = []) {
  if (typeof node === 'string') {
    if (node.includes(marker)) out.push(loc.join('\u0000'))
  } else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (!Array.isArray(node) && k.includes(marker)) out.push([...loc, k + KEY].join('\u0000'))
      locationsHolding(v, marker, [...loc, k], out)
    }
  }
  return out
}

test('AC-SEC-6: every string in the digest that carries a repository-originated canary is at a location freeTextPaths lists', () => {
  const { outDir } = rich()
  const d = digestOf(outDir)
  assert.ok(Array.isArray(d.freeTextPaths) && d.freeTextPaths.length > 0)
  for (const p of d.freeTextPaths) assert.match(p, /^[\w.*^[\]]+$/, `path grammar: ${p}`)
  const listed = new Set(d.freeTextPaths.flatMap((p) => denote(d, p)))
  const holding = locationsHolding(d, 'CANARY')
  const unlisted = holding.filter((l) => !listed.has(l)).map((l) => l.split('\u0000').join('.'))
  assert.deepEqual(unlisted, [], 'a free-text location is missing from freeTextPaths')
  // The fixture reaches each origin the digest carries, so the check above is not vacuous.
  const where = (needle) => holding.some((l) => l.includes(needle))
  assert.ok(where('perRepo'), 'ledger repo label')
  assert.ok(where('byPlan'), 'plan label')
  assert.ok(where('neverFailingAcs'), 'spec path and criterion id')
  assert.ok(where('blockedUnresolved'), 'blocked task text')
  assert.ok(where('proposalOutcomes'), 'proposal id')
  assert.ok(where('byJob'), 'CI job name')
  assert.ok(where('plan_labels'), 'plan label from a spec')
})

test('AC-SEC-6: a lane reason is fixed text and is never listed as free text', () => {
  const { outDir } = rich()
  const d = digestOf(outDir)
  const listed = new Set(d.freeTextPaths.flatMap((p) => denote(d, p)))
  for (const name of ['ledger', 'git', 'ci']) assert.equal(listed.has(['lanes', name, 'reason'].join('\u0000')), false, `lanes.${name}.reason is fixed text`)
})

// ---- 3. the git result's two fields ----

test('T1b git: the result carries root_index 0 and a null window_note when the log was not cut short', () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(3), fix: 2, other: 1 })
  const outDir = scratchDir()
  drive(stubs, { root, outDir })
  const git = lane(outDir, 'git').result
  assert.equal(git.root_index, 0)
  assert.equal(git.window_note, null)
  assert.equal(digestOf(outDir).git.root_index, 0)
})

test('T1b git: a history longer than the commit cap gets fixed window_note text naming the cap, and 499 commits do not', () => {
  const stubs = stubsWithRuns()
  const long = makeRepo({ ledger: validLedger(3) })
  addCommits(long, 520)
  const outLong = scratchDir()
  drive(stubs, { root: long, outDir: outLong })
  const gitLong = lane(outLong, 'git').result
  assert.equal(gitLong.n_commits_examined, 500, 'the log is cut at 500 commits')
  assert.equal(typeof gitLong.window_note, 'string')
  assert.match(gitLong.window_note, /\b500\b/)
  assert.ok(gitLong.window_note.length < 200, 'fixed text, not data')
  const short = makeRepo({ ledger: validLedger(3) })
  addCommits(short, 498)
  const outShort = scratchDir()
  drive(stubs, { root: short, outDir: outShort })
  const gitShort = lane(outShort, 'git').result
  assert.equal(gitShort.n_commits_examined, 499)
  assert.equal(gitShort.window_note, null)
})

// ---- 4. the plan labels ----

test('T1b plan labels: the task id and title of each line of a spec\'s Tasks section are collected without a model', () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(3), fix: 1 })
  writeSpec(root, 'b.md', ['# B', '## Tasks', '- [ ] T1b: the hand-off, before T2', '## Next', 'text', ''].join('\n'))
  writeSpec(root, 'a.md', SPEC_A)
  writeSpec(root, 'notes.txt', '## Tasks\n- [ ] T5: not a markdown spec\n')
  const outDir = scratchDir()
  drive(stubs, { root, outDir })
  const d = digestOf(outDir)
  assert.deepEqual(d.plan_labels, [
    { task_id: 'T1', title: 'first CANARY-title thing -- state: merged' },
    { task_id: 'T2', title: 'second thing' },
    { task_id: 'T1b', title: 'the hand-off, before T2' },
  ], 'specs in name order, tasks in document order, only inside the Tasks section')
  assert.equal(d.plan_labels_note, null)
})

test('T1b plan labels: no specs directory is an empty list with no note; a title is cut to the named limit; the list is capped with the drop counted', async () => {
  const mod = await loadCollector()
  const stubs = stubsWithRuns()
  const none = makeRepo({ ledger: validLedger(3), fix: 1 })
  const outNone = scratchDir()
  drive(stubs, { root: none, outDir: outNone })
  assert.deepEqual(digestOf(outNone).plan_labels, [])
  assert.equal(digestOf(outNone).plan_labels_note, null)

  const root = makeRepo({ ledger: validLedger(3), fix: 1 })
  const long = 'L'.repeat(400)
  writeSpec(root, 'long.md', `## Tasks\n- [ ] T1: ${long}\n`)
  const many = Array.from({ length: 30 }, (_, t) => `- [ ] T${t}: task ${t}`)
  for (const name of ['m1.md', 'm2.md', 'm3.md']) writeSpec(root, name, ['## Tasks', ...many, ''].join('\n'))
  const out = scratchDir()
  drive(stubs, { root, outDir: out })
  const d = digestOf(out)
  assert.ok(Number.isInteger(mod.PLAN_LABEL_TITLE_MAX_CHARS) && Number.isInteger(mod.PLAN_LABELS_MAX))
  assert.ok(91 > mod.PLAN_LABELS_MAX, 'the fixture has 91 labels, past the cap')
  assert.equal(d.plan_labels.length, mod.PLAN_LABELS_MAX)
  assert.equal(d.dropped.planLabels, 91 - mod.PLAN_LABELS_MAX)
  assert.deepEqual(d.plan_labels[0], { task_id: 'T1', title: long.slice(0, mod.PLAN_LABEL_TITLE_MAX_CHARS) })
})

test('AC-SEC-11: a specs directory that is a symlink, and a spec file that is a symlink, are not read; the canary appears in no collected file', () => {
  const stubs = stubsWithRuns()
  const outside = scratchDir()
  fs.writeFileSync(path.join(outside, 'evil.md'), '## Tasks\n- [ ] T1: OUTSIDE-CANARY-TOKEN\n')

  const linkedDir = makeRepo({ ledger: validLedger(3), fix: 1 })
  fs.symlinkSync(outside, path.join(linkedDir, 'specs'))
  const outA = scratchDir()
  drive(stubs, { root: linkedDir, outDir: outA })
  const a = digestOf(outA)
  assert.deepEqual(a.plan_labels, [])
  assert.equal(typeof a.plan_labels_note, 'string', 'a refused specs directory is said, not silent')
  assert.ok(a.plan_labels_note.length > 0 && !a.plan_labels_note.includes(outside))

  const linkedFile = makeRepo({ ledger: validLedger(3), fix: 1 })
  writeSpec(linkedFile, 'ok.md', '## Tasks\n- [ ] T1: real one\n')
  fs.symlinkSync(path.join(outside, 'evil.md'), path.join(linkedFile, 'specs', 'evil.md'))
  const outB = scratchDir()
  drive(stubs, { root: linkedFile, outDir: outB })
  assert.deepEqual(digestOf(outB).plan_labels, [{ task_id: 'T1', title: 'real one' }])

  for (const dir of [outA, outB]) for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('OUTSIDE-CANARY-TOKEN'), `${f} must not hold the canary`)
})

test('AC-SEC-11: an oversize spec file is not read', () => {
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(3), fix: 1 })
  writeSpec(root, 'big.md', `## Tasks\n- [ ] T1: HUGE-CANARY\n${'x'.repeat(8 * 1024 * 1024)}\n`)
  writeSpec(root, 'small.md', '## Tasks\n- [ ] T2: small one\n')
  const outDir = scratchDir()
  drive(stubs, { root, outDir })
  assert.deepEqual(digestOf(outDir).plan_labels, [{ task_id: 'T2', title: 'small one' }])
})

// ---- 5. the six sites the clean-up found with no failing test ----

// The descriptor-level errors that a race between the status check and the open can
// produce cannot be made to happen on demand with files, so the call is made to fail the
// way the kernel would, and put back.
function withFailingFs(method, makeError, fn) {
  const real = fs[method]
  fs[method] = function patched() {
    throw makeError()
  }
  try {
    return fn()
  } finally {
    fs[method] = real
  }
}

const errnoError = (code) => Object.assign(new Error(`${code}: /secret/path/CANARY`), { code })

async function guardedRead(content = 'hello\n') {
  const { readRepoFile } = await loadReader()
  const root = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'guard-'))
  fs.writeFileSync(path.join(root, 'file.txt'), content)
  return () => readRepoFile(root, 'file.txt', 1024)
}

test('T1b guarded read: a file that is there at the status check and gone at the open is absent', async () => {
  const read = await guardedRead()
  assert.deepEqual(read(), { status: 'ok', text: 'hello\n' }, 'unpatched, the file reads')
  withFailingFs('openSync', () => errnoError('ENOENT'), () => assert.deepEqual(read(), { status: 'absent' }))
})

test('T1b guarded read: a path that has become a symlink at the open (ELOOP under O_NOFOLLOW) is not_regular', async () => {
  const read = await guardedRead()
  withFailingFs('openSync', () => errnoError('ELOOP'), () => assert.deepEqual(read(), { status: 'not_regular' }))
})

test('T1b guarded read: any other failure to open is unreadable, and the error text is never returned', async () => {
  const read = await guardedRead()
  withFailingFs('openSync', () => errnoError('EACCES'), () => {
    const got = read()
    assert.deepEqual(got, { status: 'unreadable' })
    assert.ok(!JSON.stringify(got).includes('secret'))
  })
})

test('T1b guarded read: a failure while reading the open descriptor is unreadable, the error text is dropped and the descriptor is still closed', async () => {
  const read = await guardedRead('some content\n')
  const realClose = fs.closeSync
  let closed = 0
  fs.closeSync = (fd) => {
    closed += 1
    return realClose(fd)
  }
  try {
    withFailingFs('readSync', () => errnoError('EIO'), () => {
      const got = read()
      assert.deepEqual(got, { status: 'unreadable' })
      assert.ok(!JSON.stringify(got).includes('secret'))
    })
  } finally {
    fs.closeSync = realClose
  }
  assert.equal(closed, 1, 'the descriptor opened for the read is closed on the failure path')
})

test('T1b sidecar: a malformed proposal-targets sidecar gives the fixed unreadable-or-not-valid-JSON reason and echoes none of its content', () => {
  const stubs = stubsWithRuns()
  const events = ledgerLine(0, { kind: 'conduct_plan_event', event: 'proposal_adopted', event_key: 'abc123:proposal_adopted:1' }) + '\n'
  const root = makeRepo({ ledger: events, fix: 1 })
  fs.writeFileSync(path.join(root, '.claude', 'optimise-proposal-targets.json'), '{ "abc123": SIDECAR-CANARY not json')
  const outDir = scratchDir()
  drive(stubs, { root, outDir })
  const outcome = lane(outDir, 'ledger').result.proposalOutcomes.abc123
  assert.ok(outcome, 'the fixture has an adopted proposal')
  assert.equal(outcome.targetUnavailableReason, 'proposal-target sidecar unreadable or not valid JSON')
  assert.equal(outcome.target, undefined)
  assert.ok(!fs.readFileSync(path.join(outDir, 'ledger.json'), 'utf8').includes('SIDECAR-CANARY'))
})

test('T1b log token: a ran lane that carries a mode shows as ran:<mode> on the COLLECT line (gh listing no runs is ci=ran:no_history)', () => {
  const stubs = makeStubs()
  setGhRuns(stubs, [])
  const root = makeRepo({ ledger: validLedger(3), fix: 1 })
  const out = drive(stubs, { root, outDir: scratchDir() })
  assert.match(out.line, /^COLLECT ledger=ran git=ran ci=ran:no_history calls=/, out.line)
})

test('T1b reader detail: a reader whose output passes the size limit fails the lane with the fixed over-size text', () => {
  // A preload that makes the reader (and only the reader's `ledger` command) write 70 MB, over the
  // 64 MiB cap: the reader cannot otherwise be made to do that with a ledger within its own caps.
  const dir = scratchDir()
  const preload = path.join(dir, 'flood.cjs')
  fs.writeFileSync(preload, `if (/optimise-read\\.mjs$/.test(process.argv[1] || '') && process.argv[2] === 'ledger') { process.stdout.on('error', () => process.exit(0)); process.stdout.write(Buffer.alloc(70 * 1024 * 1024, 97), () => process.exit(0)) }\n`)
  const stubs = stubsWithRuns()
  const root = makeRepo({ ledger: validLedger(3), fix: 1 })
  const outDir = scratchDir()
  const res = runCliArgs(stubs, [root, outDir], { NODE_OPTIONS: `--require=${preload}` })
  assert.equal(res.status, 0, res.stderr)
  const ledger = lane(outDir, 'ledger')
  assert.equal(ledger.status, 'failed')
  assert.equal(ledger.mode, 'other')
  assert.equal(ledger.reason, 'the reader failed for ledger (output over the size limit)')
  assert.equal(lane(outDir, 'git').status, 'ran', 'the other lanes are unaffected')
})
