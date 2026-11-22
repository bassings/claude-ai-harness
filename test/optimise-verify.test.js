// Direct tests of workflows/lib/optimise-verify.mjs, the weekly runner's result check (HARN-RUNNER-2 T3). The runner
// tests drive the whole runner; these hold each rule on its own, on the data a real collection produces.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { cleanupTempRepos } = require('./helpers/temp-repo.js')
const T = require('./helpers/t2-fixtures.js')

const MODULE = path.join(__dirname, '..', 'workflows', 'lib', 'optimise-verify.mjs')
const SOURCE = fs.readFileSync(MODULE, 'utf8')
const CODE = SOURCE.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
const load = () => import(pathToFileURL(MODULE).href)

test.after(cleanupTempRepos)

// The collected files of a real collection, and the report the real workflow renders from its digest.
async function real() {
  const col = T.collection('moderate')
  const { result } = await T.runDigest(col.digest)
  return { col: { lane: { ledger: col.lanes.ledger, git: col.lanes.git, ci: col.lanes.ci }, digest: col.digest }, report: result.report }
}

const bump = (report, re, delta = 1) => {
  assert.ok(re.test(report), `the fixture report has a line matching ${re}`)
  return report.replace(re, (n) => String(Number(n) + delta))
}

// ---- the rules of the module that are not rows ----

test('static: the module is spawn-free and reads only through the reader\'s guarded helper', () => {
  assert.ok(!/child_process|\bspawn|(?<![.\w])exec(File)?(Sync)?\(/.test(CODE), 'no child process of any kind')
  for (const banned of ['readFileSync', 'readdirSync', 'openSync', 'createReadStream', 'readSync']) assert.ok(!CODE.includes(banned), `no ${banned}: reads go through readRepoFile`)
  assert.match(SOURCE, /import \{[^}]*\breadRepoFile\b[^}]*\} from '\.\/optimise-read\.mjs'/)
})

test('parseSession: an empty permission_denials list is unknown, not a confident zero, and a list with entries is its length', async () => {
  const { parseSession } = await load()
  const inner = JSON.stringify({ lanes: {}, report: '# R' })
  const env = (extra) => JSON.stringify({ type: 'result', is_error: false, result: inner, ...extra })
  assert.equal(parseSession(env({ permission_denials: [] })).denied, 'unknown')
  assert.equal(parseSession(env({})).denied, 'unknown')
  assert.equal(parseSession(env({ permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Write' }] })).denied, '2')
})

test('holdsPath: the home directory and the per-run directory are held wherever they appear, and the repository path only as a whole path', async () => {
  const { holdsPath, pathNeedles } = await load()
  const os = require('node:os')
  const home = fs.realpathSync(os.tmpdir())
  const needles = pathNeedles([home])
  for (const suffix of ['/x', '.bak', '-old', '_x', 'abc', '', '.']) assert.equal(holdsPath(`see ${home}${suffix} here`, needles), true, `${home}${suffix}`)
  assert.equal(holdsPath('no path in here', needles), false)
})

test('holdsPath: a bounded needle (the analysed repository) is held only as a whole path, so a sibling that starts the same way is not a leak', async () => {
  const { holdsPath } = await load()
  const repo = '/work/repo'
  assert.equal(holdsPath(`in ${repo}/src and`, [], [repo]), true)
  for (const sibling of ['/work/repo-two', '/work/repo_two', '/work/repo2', '/work/repo.bak']) assert.equal(holdsPath(`in ${sibling} only`, [], [repo]), false, sibling)
  assert.equal(holdsPath(`${repo}`, [], [repo]), true, 'the bare path at the end of the text')
})

test('checkLedger: a ledger record count printed beside a ledger lane that did not run is refused, whatever the number', async () => {
  const { checkLedger } = await load()
  const failed = { lane: { ledger: { status: 'failed', mode: 'could_not_read' } }, digest: {} }
  assert.deepEqual(checkLedger('Ledger records in window: 0 (minimum for harness-side proposals: 5).', failed).reasons, ['figure mismatch ledger: collected none, reported 0'])
  assert.deepEqual(checkLedger('## Sample completeness\nNot measured: x\n', failed).reasons, [])
})

test('flattening parity: the module prints a key through the same redaction the workflow does, so a job whose name looks like a path still matches its row', async () => {
  const { ABSOLUTE_PATH_RE, REDACTED_PATH_MARKER } = await load()
  const workflow = fs.readFileSync(T.WORKFLOW, 'utf8')
  assert.ok(workflow.includes(`const ABSOLUTE_PATH_RE = ${ABSOLUTE_PATH_RE.toString()}`), 'the pattern is the workflow\'s own, character for character')
  assert.ok(workflow.includes(`const REDACTED_PATH_MARKER = '${REDACTED_PATH_MARKER}'`))
})

test('checkRows: a row written in a shape the check does not know is refused, so a row cannot escape its class by being written differently', async () => {
  const { checkRows } = await load()
  const { col, report } = await real()
  const plan = report.split('\n').find((l) => l.includes(': ci_wait=') && l.startsWith('- '))
  const reshaped = report.replace(plan, plan.replace('), human_wait=', ') human_wait='))
  assert.notEqual(reshaped, report)
  assert.ok(checkRows(reshaped, col).includes('figure mismatch wall-clock plan: a row in a shape the check does not know'))
  const job = report.split('\n').find((l) => l.includes('::ci::') && l.includes(': n='))
  const jobReshaped = report.replace(job, job.replace(': n=', ': runs=').replace(', failed=', ', failures='))
  assert.ok(checkRows(jobReshaped.replace('::ci::', '::ci::'), col).length >= 1, 'a job row with its figures renamed is not silently ignored')
})

test('checkRows: a hostile report of one enormous line of row-shaped text is judged in well under a second and refused, never a hang', async () => {
  const { checkRows } = await load()
  const { col, report } = await real()
  const hostile = '- ' + ': n=1, failed='.repeat(200000)
  const started = Date.now()
  const reasons = checkRows(`${report}\n${hostile}\n`, col)
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
  assert.ok(reasons.some((r) => r.startsWith('figure mismatch ci job:')), 'the over-long row is refused, not ignored')
})

// ---- the sidecar merge ----

test('mergeSidecar: every prior entry the returned sidecar lacks is kept, returned entries are added or replace the prior one, and the newest come last', async () => {
  const { mergeSidecar } = await load()
  const merged = mergeSidecar({ a: { v: 1 }, b: { v: 2 }, c: { v: 3 } }, { b: { v: 20 }, d: { v: 4 } })
  assert.deepEqual(merged, { a: { v: 1 }, c: { v: 3 }, b: { v: 20 }, d: { v: 4 } })
  assert.deepEqual(Object.keys(merged), ['a', 'c', 'b', 'd'], 'insertion order: a returned entry counts as the newest')
  assert.deepEqual(mergeSidecar({}, {}), {})
  assert.deepEqual(mergeSidecar({ a: 1 }, {}), { a: 1 }, 'a returned sidecar with nothing in it removes nothing')
})

test('mergeSidecar: past the carry maximum the oldest entries go first, never the newest, and never before the maximum is passed', async () => {
  const { mergeSidecar, SIDECAR_CARRY_MAX } = await load()
  assert.equal(SIDECAR_CARRY_MAX, 500, 'the same carry maximum the workflow\'s own sidecar uses')
  const workflow = fs.readFileSync(T.WORKFLOW, 'utf8')
  assert.match(workflow, /^const SIDECAR_CARRY_MAX = 500$/m, 'parity: the workflow\'s constant is the module\'s')
  const prior = Object.fromEntries(Array.from({ length: SIDECAR_CARRY_MAX }, (_, i) => [`k${i}`, { i }]))
  assert.equal(Object.keys(mergeSidecar(prior, {})).length, SIDECAR_CARRY_MAX, 'exactly at the maximum nothing goes')
  const merged = mergeSidecar(prior, { new1: { n: 1 }, new2: { n: 2 } })
  const keys = Object.keys(merged)
  assert.equal(keys.length, SIDECAR_CARRY_MAX)
  assert.ok(!keys.includes('k0') && !keys.includes('k1'), 'the two oldest were evicted')
  assert.deepEqual(keys.slice(-2), ['new1', 'new2'])
})

test('fitSidecar: a merged sidecar over the size cap loses its oldest entries until it fits, and one under the cap loses none', async () => {
  const { fitSidecar, SIDECAR_CAP } = await load()
  const big = (i) => ({ pad: `${i}`.padEnd(200000, 'x') })
  const merged = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`e${i}`, big(i)]))
  const fitted = fitSidecar(merged)
  assert.ok(Buffer.byteLength(JSON.stringify(fitted, null, 2) + '\n') <= SIDECAR_CAP)
  assert.ok(Object.keys(fitted).length < 8 && Object.keys(fitted).length > 0, 'some went, not all')
  assert.deepEqual(Object.keys(fitted), Object.keys(merged).slice(8 - Object.keys(fitted).length), 'the newest are the ones kept')
  assert.deepEqual(fitSidecar({ a: 1, b: 2 }), { a: 1, b: 2 })
})

// ---- the figure rows ----

// [class, what alters exactly one figure of that class by one, the reason it must give]
const ROW_ALTERATIONS = [
  ['a per-job CI count n', (r) => bump(r, /(?<=::ci::[^\n]*: n=)\d+/), /^figure mismatch ci job: n collected 3, reported 4$/],
  ['a per-job CI failed count', (r) => bump(r, /(?<=::ci::[^\n]*: n=\d+, failed=)\d+/), /^figure mismatch ci job: failed collected \d+, reported \d+$/],
  ['a per-job row whose key the data does not hold', (r) => r.replace('::ci::test:', '::ci::forged:'), /^figure mismatch ci job: a row the collected data does not hold/],
  ['a per-job row left out', (r) => r.split('\n').filter((l) => !l.includes('::ci::test:')).join('\n'), /^figure mismatch ci job: .*collected .*reported none/],
  ['the scoped count', (r) => bump(r, /(?<=Scoped to product source \(config: [^)]*\): )\d+(?= counted)/), /^figure mismatch git scoped: scoped counted collected 0, reported 1$/],
  ['the scoped excluded count', (r) => bump(r, /\d+(?= excluded as pipeline)/), /^figure mismatch git scoped: scoped excluded collected 3, reported 4$/],
  ['the scoped unavailable count', (r) => bump(r, /\d+(?= unavailable \(changed paths)/), /^figure mismatch git scoped: scoped unavailable collected 0, reported 1$/],
  ['a per-repository CI not-completed count', (r) => bump(r, /\d+(?= runs not completed)/), /^figure mismatch ci repository: not completed collected 0, reported 1$/],
  ['a per-repository CI fetch-failure count', (r) => bump(r, /(?<=rate_limited )\d+/), /^figure mismatch ci repository: rate limited collected 0, reported 1$/],
  ['a gh call count', (r) => bump(r, /\d+(?= gh calls)/), /^figure mismatch gh calls: calls collected 4, reported 5$/],
  ['a gh wall-clock figure', (r) => bump(r, /(?<=wall-clock )\d+(?=\.\d+s, \d+ gh calls)/), /^figure mismatch gh calls: wall-clock seconds collected/],
  ['a per-plan wait figure', (r) => bump(r, /(?<=: ci_wait=)\d+(?=s \(n=)/), /^figure mismatch wall-clock plan: ci wait seconds collected 0, reported 1$/],
  ['a per-plan run count', (r) => bump(r, /(?<=human_wait=\d+s \(n=)\d+/), /^figure mismatch wall-clock plan: human wait runs collected 0, reported 1$/],
  ['a per-plan unterminated-waits count', (r) => bump(r, /(?<=unterminated_waits: )\d+/), /^figure mismatch wall-clock plan: unterminated waits collected 1, reported 2$/],
  ['a wall-clock totals count', (r) => bump(r, /(?<=\(measured n=)\d+/), /^figure mismatch wall-clock totals: /],
  ['a never-failing row run count', (r) => bump(r, /(?<=AC-QA-1: n=)\d+/), /^figure mismatch never-failing: n collected 6, reported 7$/],
  ['a never-failing row disagreement count', (r) => bump(r, /(?<=AC-DIS-1: n=1 \(insufficient data\), verdict_disagreements=)\d+/), /^figure mismatch never-failing: verdict disagreements collected 1, reported 2$/],
  ['the criteria-rows-left-out count', (r) => bump(r, /\d+(?= criteria rows left out)/), /^figure mismatch never-failing: rows left out collected 16, reported 17$/],
  ['a per-repository ledger record count', (r) => bump(r, /(?<=^- demo-CANARY: )\d+(?= record\(s\) in window)/m), /^figure mismatch ledger repository: records collected 18, reported 19$/],
  ['the skipped-lines count', (r) => bump(r, /^\d+(?= ledger line\(s\) were skipped)/m), /^figure mismatch ledger repository: skipped collected 1, reported 2$/],
  ['a trigger-accuracy count', (r) => bump(r, /(?<=total=)\d+/), /^figure mismatch trigger accuracy: total collected 1, reported 2$/],
  ['a rework disposition count', (r) => bump(r, /(?<=open=)\d+/), /^figure mismatch rework: open collected 1, reported 2$/],
  ['an unattributable-runs count', (r) => bump(r, /(?<=unattributable runs=)\d+/), /^figure mismatch attribution counters: unattributable runs collected 0, reported 1$/],
  ['a dropped-values counter', (r) => bump(r, /(?<=invalid_fixed_ids_dropped \([^)\n]*\): )\d+/), /^figure mismatch dropped counters: dropped count collected 0, reported 1$/],
  ['an orphaned-runs count', (r) => bump(r, /(?<=terminal-only=)\d+/), /^figure mismatch orphaned runs: terminal-only collected 14, reported 15$/],
]

test('checkRows: the report the real workflow renders from the collected data passes every row check', async () => {
  const { checkRows } = await load()
  const { col, report } = await real()
  assert.deepEqual(checkRows(report, col), [])
})

for (const [name, alter, reasonRe] of ROW_ALTERATIONS) {
  test(`checkRows: ${name} altered by one is refused with a reason naming that figure`, async () => {
    const { checkRows } = await load()
    const { col, report } = await real()
    const reasons = checkRows(alter(report), col)
    assert.equal(reasons.length >= 1, true, 'the alteration is refused')
    assert.match(reasons[0], reasonRe, reasons.join(' | '))
  })
}

test('checkRows: a proposal\'s recorded adoption and rejection dates are held to the outcome the ledger holds for that id', async () => {
  const { checkRows } = await load()
  const { col, report } = await real()
  const outcome = col.digest.ledger.proposalOutcomes.propCANARY0
  const section = (id, line) => `${report}\n### ${id}: A proposal\n${line}\n`
  assert.deepEqual(checkRows(section('propCANARY0', `Already adopted on ${outcome.lastAdoptionTs}.`), col), [], 'control: the true date passes')
  assert.match(checkRows(section('propCANARY0', 'Already adopted on 2020-01-01T00:00:00.000Z.'), col)[0], /^figure mismatch proposal outcome: adoption date/)
  assert.match(checkRows(section('propCANARY0', '**Previously rejected on 2020-01-01T00:00:00.000Z.**'), col)[0], /^figure mismatch proposal outcome: rejection date/)
  assert.match(checkRows(section('0123456789abcdef', `Already adopted on ${outcome.lastAdoptionTs}.`), col)[0], /^figure mismatch proposal outcome: an outcome the collected data does not hold/)
})
