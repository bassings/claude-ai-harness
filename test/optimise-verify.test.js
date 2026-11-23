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

// How long an input of `size` takes, as the best of three runs. The tests below assert how the time GROWS between a size and four times that
// (linear work is about four times as long, quadratic about sixteen), never an absolute number of milliseconds, so a busy machine, which slows
// both sizes alike, cannot fail them and a super-linear blow-up still does (whole-branch review M5).
function timeOf(run) {
  let best = Infinity
  for (let i = 0; i < 3; i += 1) {
    const started = process.hrtime.bigint()
    run()
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6)
  }
  return best
}
const SCALING_LIMIT = 10
function assertScalesLinearly(label, small, large) {
  const [a, b] = [timeOf(small), timeOf(large)]
  assert.ok(b <= SCALING_LIMIT * Math.max(a, 20), `${label}: four times the input took ${b.toFixed(1)} ms against ${a.toFixed(1)} ms, which is more than linear work`)
}

test('static: the module is spawn-free and reads only through the reader\'s guarded helper', () => {
  assert.ok(!/child_process|\bspawn|(?<![.\w])exec(File)?(Sync)?\(/.test(CODE), 'no child process of any kind')
  for (const banned of ['readFileSync', 'openSync', 'createReadStream', 'readSync']) assert.ok(!CODE.includes(banned), `no ${banned}: reads go through readRepoFile`)
  // One directory listing is allowed (T4 round 1, L4): the sweep of staged temp files names the entries of a directory it has
  // already found to be a real directory, and reads no file's content. Anywhere else a listing is still a read the helper must make.
  assert.equal(CODE.split('readdirSync').length - 1, 1, 'readdirSync appears once')
  assert.match(CODE, /function sweepStaged[\s\S]*?readdirSync[\s\S]*?\n\}/, 'and it is in sweepStaged')
  assert.match(SOURCE, /import \{[^}]*\breadRepoFile\b[^}]*\} from '\.\/optimise-read\.mjs'/)
})

test('parseSession: an array of permission_denials is a count (zero included) with its tool names from a known set, anything else is unknown, and tool_input is never carried', async () => {
  const { parseSession } = await load()
  const inner = JSON.stringify({ lanes: {}, report: '# R' })
  const env = (extra) => JSON.stringify({ type: 'result', is_error: false, result: inner, ...extra })
  const none = parseSession(env({ permission_denials: [] }))
  assert.deepEqual([none.denied, none.tools], ['0', 'none'], 'measured 2026-11-22: the list is filled for refused Reads, so an empty list is a real zero')
  for (const extra of [{}, { permission_denials: null }, { permission_denials: 'two' }, { permission_denials: { length: 2 } }]) assert.equal(parseSession(env(extra)).denied, 'unknown', JSON.stringify(extra))
  const two = parseSession(env({ permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/secret/place' } }, { tool_name: 'Bash' }, { tool_name: 'Write' }] }))
  assert.deepEqual([two.denied, two.tools], ['3', 'Bash,Write'], 'sorted and de-duplicated, the count still counts every refusal')
  const odd = parseSession(env({ permission_denials: [{ tool_name: 'Mystery/../x' }, { tool_name: 'Read' }, { nope: 1 }, 7] }))
  assert.deepEqual([odd.denied, odd.tools], ['4', 'other,Read'], 'a name outside the known set, or none, is `other`')
  assert.ok(!JSON.stringify(odd).includes('/secret') && !JSON.stringify(two).includes('/secret'), 'tool_input never reaches the result')
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

test('checkRows: a hostile report of one enormous line of row-shaped text is refused, never a hang, and its cost grows no faster than its size', async () => {
  const { checkRows } = await load()
  const { col, report } = await real()
  const hostileOf = (n) => '- ' + ': n=1, failed='.repeat(n)
  const reasons = checkRows(`${report}\n${hostileOf(50000)}\n`, col)
  assert.ok(reasons.some((r) => r.startsWith('figure mismatch ci job:')), 'the over-long row is refused, not ignored')
  assertScalesLinearly('one enormous row-shaped line', () => checkRows(`${report}\n${hostileOf(50000)}\n`, col), () => checkRows(`${report}\n${hostileOf(200000)}\n`, col))
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
  assert.equal(SIDECAR_CARRY_MAX, 500, 'the carry maximum, owned here')
  const workflow = fs.readFileSync(T.WORKFLOW, 'utf8')
  assert.ok(!/SIDECAR_CARRY_MAX|\.slice\(0, 500\)/.test(workflow), 'the workflow decides no retention of its own (L12): it carries every outcome the digest holds and the merge here owns what is kept')
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

// ---- H1: the returned sidecar is validated before it touches the only copy of the decided map ----

const WELL_FORMED = { kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: 'ci', job: 'a-job', touches_always_on_lens: false, security_purposed: false }
const ID_A = '0123456789abcdef'

test('validateReturnedSidecar: only a hex id whose target is the reader\'s fixed shape, hashes to that id and is named by this run is accepted', async () => {
  const { validateReturnedSidecar, namedProposalIds } = await load()
  const { stableProposalId } = await import(pathToFileURL(path.join(__dirname, '..', 'workflows', 'lib', 'optimise-read.mjs')).href)
  const id = stableProposalId(WELL_FORMED)
  const named = new Set([id])
  assert.equal(validateReturnedSidecar({ [id]: WELL_FORMED }, named), null, 'control: a good entry is accepted')
  assert.equal(validateReturnedSidecar({}, named), null, 'an empty sidecar is accepted')
  assert.equal(validateReturnedSidecar({ 'not-hex': WELL_FORMED }, named), 'returned sidecar has a key that is not a proposal id')
  assert.equal(validateReturnedSidecar(JSON.parse('{"__proto__": 1}'), named), 'returned sidecar has a key that is not a proposal id')
  assert.equal(validateReturnedSidecar({ [id]: 'garbage' }, named), 'returned sidecar has a target that is not the fixed shape')
  assert.equal(validateReturnedSidecar({ [id]: { ...WELL_FORMED, extra: 1 } }, named), 'returned sidecar has a target that is not the fixed shape')
  assert.equal(validateReturnedSidecar({ [ID_A]: WELL_FORMED }, new Set([ID_A])), 'returned sidecar has a target that does not hash to its id')
  assert.equal(validateReturnedSidecar({ [id]: WELL_FORMED }, new Set()), 'returned sidecar has an id this run does not name')
  const report = `# R\n\n### ${id}: a proposal\n- ${ID_A}: an insufficient one (n=2)\n`
  assert.deepEqual([...namedProposalIds(report, { digest: { ledger: { proposalOutcomes: { propX: {} } } } })].sort((a, b) => a.localeCompare(b)), [ID_A, id, 'propX'].sort((a, b) => a.localeCompare(b)), 'headings, bullets and the ledger\'s decided outcomes are named')
})

test('mergeSidecar: a returned entry evicts an on-disk one only when the file is full, and never more of them than it adds', async () => {
  const { mergeSidecar, SIDECAR_CARRY_MAX } = await load()
  const disk = Object.fromEntries(Array.from({ length: SIDECAR_CARRY_MAX }, (_, i) => [`d${String(i).padStart(15, '0')}`, { i }]))
  const merged = mergeSidecar(disk, { aaaaaaaaaaaaaaaa: { n: 1 } })
  const lost = Object.keys(disk).filter((k) => !(k in merged))
  assert.deepEqual(lost, ['d000000000000000'], 'one new entry evicts exactly the one oldest on-disk entry')
  assert.equal(Object.keys(mergeSidecar({ x: 1 }, { y: 2 })).length, 2, 'below the maximum nothing is evicted')
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
  ['a gh wall-clock figure', (r) => bump(r, /(?<=wall-clock )\d+(?=(?:\.\d+)?s, \d+ gh calls)/), /^figure mismatch gh calls: wall-clock seconds collected/],
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
  ['the total unterminated-waits count', (r) => bump(r, /(?<=^unterminated_waits: )\d+/m), /^figure mismatch wall-clock unterminated: unterminated waits collected 2, reported 3$/],
  ['the findings-dropped count', (r) => bump(r, /(?<=findings_truncated=)\d+(?= \(findings the writer)/), /^figure mismatch rework counters: findings truncated differs from the collected one$/],
  ['the no-spec review runs count', (r) => bump(r, /(?<=No-spec review runs in window: )\d+/), /^figure mismatch rework counters: no-spec review runs differs from the collected one$/],
  ['the schema-v4 older-rows count', (r) => bump(r, /\d+(?= older rows excluded)/), /^figure mismatch rework counters: schema v4 older rows collected 12, reported 13$/],
  ['the blocked-TDD unresolved count', (r) => bump(r, /(?<=resolution row\): )\d+/), /^figure mismatch blocked tdd: unresolved collected 1, reported 2$/],
  ['the blocked-TDD reason-not-recorded count', (r) => bump(r, /(?<=not recorded \(pre-T5\): )\d+/), /^figure mismatch blocked tdd: not recorded collected 1, reported 2$/],
  ['a suppression-share count', (r) => bump(r, /(?<=^ci_wait: )\d+(?=\/)/m), /^figure mismatch filtering: unmeasured collected 2, reported 3$/],
  ['a suppression-share total', (r) => bump(r, /(?<=^agent_compute: \d+\/)\d+/m), /^figure mismatch filtering: total collected 14, reported 15$/],
  ['the sources line', (r) => r.replace('ci_wait=ledger:conduct_plan_event', 'ci_wait=ledger:forged'), /^figure mismatch wall-clock sources: ci wait source differs from the collected one$/],
  ['the by-kind breakdown on the orphaned line', (r) => r.replace('tdd_task: 2', 'tdd_task: 3'), /^figure mismatch orphaned runs: terminal-only by kind differs from the collected one$/],
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

test('checkRows: the plan-label note is held to the digest\'s, a note the digest does not hold is no excuse for a different line, and a missing one is refused', async () => {
  const { checkRows } = await load()
  const col = T.collection('moderate')
  col.digest.plan_labels_note = 'Plan labels: 3 of 5 plan titles were listed; the rest were left out.'
  const { result } = await T.runDigest(col.digest)
  const c = { lane: { ledger: col.lanes.ledger, git: col.lanes.git, ci: col.lanes.ci }, digest: col.digest }
  assert.ok(result.report.includes(col.digest.plan_labels_note), 'guard against vacuity: the workflow printed the note')
  assert.deepEqual(checkRows(result.report, c), [], 'control')
  assert.deepEqual(checkRows(result.report.replace('3 of 5', '4 of 5'), c), ['figure mismatch plan labels: note differs from the collected one'])
  assert.deepEqual(checkRows(result.report.replace(col.digest.plan_labels_note, ''), c), ['figure mismatch plan labels: note differs from the collected one'])
})

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

// ---- M4: nothing forces a new figure line to be checked, so a test does ----

// Line shapes with a digit that are deliberately NOT held to the collected data, each with the reason. Narrow on purpose: a
// broad pattern here would hide a new figure line, which is the thing this test exists to catch.
const UNCHECKED_SHAPES = [
  [/^Instrumented invocation routes: /, 'fixed prose that cites an acceptance criterion id'],
  [/^Blocked TDD runs unresolved in window may include a task re-briefed/, 'fixed prose that cites a review round'],
  [/^- \S+ specs\/\S+ .+: (?:not recorded|test_attempt_cap|implement_attempt_cap|tests_modified|test_defect)/, 'one blocked run: ledger free text (repository, spec, task, date) flattened, not a collected figure'],
  [/^Repo \d{1,3} \(/, 'the roster position heading of the escaped-defect block'],
  [/^Drafted: \d+\. Dropped \(/, 'bookkeeping of the session\'s own proposal drafting, not collected data'],
  [/^Proposals rejected: malformed target: \d+/, 'bookkeeping of the session\'s own proposal drafting, not collected data'],
  [/^### [0-9a-f]{16}: /, 'a proposal heading: session-drafted text'],
  [/^n=\d+\. Motivating: /, 'a proposal\'s measurements as the session cites them: session-drafted text'],
  [/^Target: /, 'a proposal\'s target words: session-drafted, held by the sidecar rules instead'],
  [/^- [0-9a-f]{16}: .* \(n=\d+\)$/, 'an insufficient-data proposal: session-drafted text'],
  [/^Reinstatement evidence: /, 'session-drafted proposal text'],
]

// A proposal the workflow ranks (its citations resolve), so the proposal sections are rendered and their lines exercised.
const draftedProposal = () => ({ __bypassSchemaValidation: true, proposals: [{ target: { kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: 'ci', job: 'build-CANARY-job', touches_always_on_lens: false, security_purposed: false }, statement: 'Narrow a trigger glob', motivating_measurement: '3 of 5 runs were CLEAN (run-1..run-3)', confirming_measurement: 'accuracy improves', n: 6, citations: ['13', 'r16'], reinstatement_evidence: null }] })

// Every (fixture, drafting) pair rendered at once; the report lines of each, with the collected data they must be held to.
async function renderedReports() {
  const pairs = ['moderate', 'rich'].flatMap((kind) => [{ proposals: [] }, draftedProposal()].map((drafted) => ({ kind, drafted })))
  return Promise.all(pairs.map(async ({ kind, drafted }) => {
    const col = T.collection(kind)
    const { result } = await T.runDigest(col.digest, { agent: { 'synthesis:proposals': drafted } })
    return { kind, lines: result.report.split('\n').filter((l) => /\d/.test(l)), col: { lane: { ledger: col.lanes.ledger, git: col.lanes.git, ci: col.lanes.ci }, digest: col.digest } }
  }))
}

test('coverage: every line of the real report that carries a digit is checked by this module or on the explicit list of unchecked shapes', async () => {
  const { isCheckedLine } = await load()
  const unlisted = (await renderedReports()).flatMap(({ kind, lines, col }) => lines.filter((line) => !isCheckedLine(line, col) && !UNCHECKED_SHAPES.some(([shape]) => shape.test(line))).map((line) => `${kind}: ${line.slice(0, 140)}`))
  assert.deepEqual([...new Set(unlisted)], [], 'a numeric line no check looks at and no list entry explains: check it in workflows/lib/optimise-verify.mjs or list it with a reason')
})

test('coverage: every entry of the unchecked list is shown to be needed, so the list cannot quietly become a place to hide a figure', async () => {
  const { isCheckedLine } = await load()
  const used = new Set()
  for (const { lines, col } of await renderedReports()) {
    for (const line of lines.filter((l) => !isCheckedLine(l, col))) UNCHECKED_SHAPES.forEach(([shape], i) => { if (shape.test(line)) used.add(i) })
  }
  const unused = UNCHECKED_SHAPES.filter((_, i) => !used.has(i)).map(([shape]) => String(shape))
  const needOtherFixtures = [/^Target: /, /^- [0-9a-f]{16}: .* \(n=\d+\)$/, /^Reinstatement evidence: /].map(String)
  assert.deepEqual(unused, needOtherFixtures, 'every listed shape is rendered by these fixtures except those that need a digit in a target, an insufficient-data proposal or a removal proposal')
})

// ---- M2: a report that drops a figure line altogether is refused, naming the figure ----

const withoutLine = (report, re) => {
  const kept = report.split('\n').filter((l) => !re.test(l))
  assert.ok(kept.length < report.split('\n').length, `the fixture report has a line matching ${re}`)
  return kept.join('\n')
}

test('checkFigures: a report with a figure line left out is refused with the exact "reported none" reason, one line at a time', async () => {
  const { checkFigures, checkDigest } = await load()
  const { col, report } = await real()
  const lanes = { ledger: { status: 'ran' }, git: { status: 'ran' }, ci: { status: 'ran' } }
  const reasonsFor = (text) => checkFigures({ lanes }, text, col).reasons
  assert.deepEqual(reasonsFor(report), [], 'control')
  assert.ok(reasonsFor(withoutLine(report, /^Ledger records in window: /)).includes('figure mismatch ledger: collected 18, reported none'))
  assert.ok(reasonsFor(withoutLine(report, /^CI runs: /)).includes('figure mismatch ci: runs collected 3, reported none'))
  assert.ok(reasonsFor(withoutLine(report, /^Raw \(unscoped\): /)).includes('figure mismatch git: count collected 3, reported none'))
  assert.ok(reasonsFor(withoutLine(report, /^Scoped to product source /)).includes('figure mismatch git scoped: scoped counted collected 0, reported none'))
  // the digest's own omission lines and trimmed flag
  const dropped = { ...col.digest.dropped, ciByJob: 4, trimmedForSize: true }
  const colDropped = { ...col, digest: { ...col.digest, dropped } }
  assert.deepEqual(checkDigest(report, colDropped), ['figure mismatch digest: omitted ciByJob collected 4, reported none'])
  const colTrimmed = { ...col, digest: { ...col.digest, dropped: { ...col.digest.dropped, trimmedForSize: true } } }
  assert.deepEqual(checkDigest(report, colTrimmed), ['figure mismatch digest: trimmed flag'], 'the data says trimmed and the report does not')
  assert.deepEqual(checkDigest(`${report}\nDigest trimmed for size: yes\n`, col), ['figure mismatch digest: trimmed flag'], 'the report says trimmed and the data does not')
})

// ---- M5: the returned report controls how many reasons there are, so how many are printed is bounded here ----

test('formatVerdict: reasons are de-duplicated, only the first few are printed, the rest are counted as more_reasons:<n>, and each line is bounded', async () => {
  const { formatVerdict, MAX_REASONS, MAX_REASON_CHARS } = await load()
  assert.equal(MAX_REASONS, 8)
  const manyOf = (n) => Array.from({ length: n }, (_, i) => `figure mismatch ci job: n collected 3, reported ${i}`)
  const many = manyOf(100000)
  const out = formatVerdict({ tokens: 'ledger=1/1', denied: 'unknown', reasons: [...many, ...many], place: 'no' })
  assertScalesLinearly('reasons', () => formatVerdict({ tokens: 't', denied: 'unknown', reasons: manyOf(20000), place: 'no' }), () => formatVerdict({ tokens: 't', denied: 'unknown', reasons: manyOf(80000), place: 'no' }))
  const reasonLines = out.split('\n').filter((l) => l.startsWith('REASON '))
  assert.equal(reasonLines.length, MAX_REASONS + 1)
  assert.equal(reasonLines.at(-1), 'REASON more_reasons:99992', 'the 100000 distinct reasons, less the 8 shown')
  assert.ok(out.length < 2000, `${out.length} bytes`)
  const long = formatVerdict({ tokens: 't', denied: 'unknown', reasons: ['x'.repeat(10 * MAX_REASON_CHARS)], place: 'no' })
  assert.ok(long.split('\n').find((l) => l.startsWith('REASON ')).length <= 'REASON '.length + MAX_REASON_CHARS)
  assert.equal(formatVerdict({ tokens: 't', denied: 'unknown', reasons: ['a', 'a', 'b'], place: 'no' }), 'TOKENS t\nDENIED unknown\nREASON a\nREASON b\nPLACE no\n', 'duplicates collapse and nothing is added below the cap')
})

test('checkRows: a 5 MB report of well-formed rows that all disagree with the data grows no faster than its size', async () => {
  const { checkRows } = await load()
  const { col, report } = await real()
  const key = report.split('\n').find((l) => l.includes('::ci::test: n=')).split(': n=')[0].slice(2)
  const rowsOf = (n) => Array.from({ length: n }, (_, i) => `- ${key}: n=${i + 100}, failed=0, mean 60s`).join('\n')
  const reasons = checkRows(`${report}\n${rowsOf(100000)}\n`, col)
  assert.ok(reasons.length >= 100000, 'the hostile report really does produce a reason per row')
  assertScalesLinearly('well-formed rows that all disagree', () => checkRows(`${report}\n${rowsOf(20000)}\n`, col), () => checkRows(`${report}\n${rowsOf(80000)}\n`, col))
})

// ---- H2: the nonce the session passed on ----

test('nonceProblem: the result must carry the SHA-256 of this run\'s nonce; another nonce\'s hash, a missing hash, a hash of the empty string and a missing nonce are all refused', async () => {
  const { nonceProblem } = await load()
  const { createHash } = require('node:crypto')
  const hash = (t) => createHash('sha256').update(t).digest('hex')
  const nonce = '0123456789abcdef0123456789abcdef'
  assert.equal(nonceProblem({ nonce_sha256: hash(nonce) }, nonce), null, 'control')
  assert.equal(nonceProblem({ nonce_sha256: hash('f'.repeat(32)) }, nonce), 'result nonce hash does not match this run')
  assert.equal(nonceProblem({}, nonce), 'result carries no nonce hash')
  assert.equal(nonceProblem({ nonce_sha256: 42 }, nonce), 'result carries no nonce hash')
  assert.equal(nonceProblem({ nonce_sha256: hash('') }, ''), 'result nonce hash does not match this run', 'a run given no nonce accepts nothing, not even the hash of nothing')
  assert.equal(nonceProblem({ nonce_sha256: hash(nonce) }, undefined), 'result nonce hash does not match this run')
})

// ---- L5: every line of a figure shape must match, not just the first ----

test('every line of each figure shape is held to the data: a later line with a different figure is refused, for the ledger, CI, git and scoped lines and the digest omissions', async () => {
  const { checkFigures, checkDigest } = await load()
  const { col, report } = await real()
  const lanes = { ledger: { status: 'ran' }, git: { status: 'ran' }, ci: { status: 'ran' } }
  const reasonsFor = (text) => checkFigures({ lanes }, text, col).reasons
  const second = (re, bumped) => `${report}\n${report.split('\n').find((l) => re.test(l)).replace(...bumped)}\n`
  assert.ok(reasonsFor(second(/^Ledger records in window: /, [/\d+/, '19'])).includes('figure mismatch ledger: collected 18, reported 19'))
  assert.ok(reasonsFor(second(/^CI runs: /, [/\d+/, '4'])).includes('figure mismatch ci: runs collected 3, reported 4'))
  assert.ok(reasonsFor(second(/^Raw \(unscoped\): /, [/\d+/, '4'])).includes('figure mismatch git: count collected 3, reported 4'))
  assert.ok(reasonsFor(second(/^Scoped to product source /, [/: \d+ counted/, ': 1 counted'])).includes('figure mismatch git scoped: scoped counted collected 0, reported 1'))
  const colDropped = { ...col, digest: { ...col.digest, dropped: { ...col.digest.dropped, ciByJob: 4 } } }
  assert.deepEqual(checkDigest('Digest omitted ciByJob: 4\nDigest omitted ciByJob: 5\n', colDropped), ['figure mismatch digest: omitted ciByJob collected 4, reported 5'])
})

// ---- L6: an envelope that says it is an error is refused even when it carries a result that would parse ----

test('parseSession: an envelope with is_error true is refused as having no result, even though its result string is a valid result', async () => {
  const { parseSession } = await load()
  const valid = JSON.stringify({ lanes: {}, report: '# R' })
  assert.equal(parseSession(JSON.stringify({ type: 'result', is_error: true, result: valid })).reason, 'session output: envelope has no result')
  assert.ok(parseSession(JSON.stringify({ type: 'result', is_error: false, result: valid })).result, 'control: the same result without the error flag parses')
})

// ---- L8: fail-closed guards that no test used to remove ----

test('checkResult: a report that is not valid UTF-8 (a lone surrogate) is refused, so what is placed is exactly what was judged', async () => {
  const { checkResult } = await load()
  assert.equal(checkResult({ lanes: {}, report: '# R\n\ud800\n', proposal_targets: {} }, [], []).reason, 'report is not valid UTF-8')
  assert.ok(checkResult({ lanes: {}, report: '# R\nplain\n', proposal_targets: {} }, [], []).report, 'control')
})

test('checkLanes and checkDigest: collected data that cannot be read is named, never treated as a lane that ran', async () => {
  const { checkLanes, checkDigest } = await load()
  const { col } = await real()
  const broken = { lane: { ...col.lane, ledger: null }, digest: col.digest }
  assert.ok(checkLanes({ ledger: { status: 'ran' }, git: { status: 'ran' }, ci: { status: 'ran' } }, broken).includes('collected data unreadable: ledger'))
  assert.deepEqual(checkDigest('# R', { lane: col.lane, digest: null }), ['collected data unreadable: digest'])
})
