// HARN-RUNNER-2 whole-branch review round 4: the result check must accept what the workflow honestly writes.
//   F2  the always-on-lens rule's second layer reads what the first reads: a proposal's statement and its target, never its measurements or
//       citations. Held behaviourally over real buildReport output, through the real workflow and the real check.
// Every fixture commit carries an explicit identity. The workflow's own result_mac is used, except where a test forges a well-shaped block
// and re-signs it, which is the case the second layer exists for (the attended session has a shell).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { cleanupTempRepos } = require('./helpers/temp-repo.js')
const SB = require('./helpers/weekly-sandbox.js')
const T2 = require('./helpers/t2-fixtures.js')
const { resign } = require('./helpers/result-mac.js')

const { F, ROOT, REPORT_REL, SIDECAR_REL, freshDir } = SB
const VERIFY = path.join(ROOT, 'workflows', 'lib', 'optimise-verify.mjs')
const IGNORE = path.join(ROOT, 'workflows', 'lib', 'optimise-report-ignore.mjs')
const AUTHOR = 'canary-author@example.invalid'
const ALWAYS_ON = 'report proposes removing an always-on lens'

test.after(cleanupTempRepos)

function ghStubs() {
  const stubs = F.makeStubs()
  const runs = [11, 12].map((id) => F.run(id))
  F.setGhRuns(stubs, runs, Object.fromEntries(runs.map((r) => [r.databaseId, { jobs: [F.job('build'), F.job('test')] }])))
  return stubs
}

let base = null
function collection() {
  if (!base) {
    const repo = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })
    const { outDir } = F.collect(ghStubs(), repo)
    base = { repo, outDir, digest: JSON.parse(fs.readFileSync(path.join(outDir, 'digest.json'), 'utf8')) }
  }
  return { ...base, digest: structuredClone(base.digest) }
}

const target = (fields = {}) => ({ kind: 'trigger_tune', component: 'review', concern: 'noise', lens: '', workflow: '', job: '', touches_always_on_lens: false, security_purposed: false, ...fields })
const draft = (citation, fields = {}) => ({ target: target(), statement: 'Narrow a trigger glob', motivating_measurement: '9 runs matched nothing', confirming_measurement: 'accuracy improves', n: 9, citations: [citation], reinstatement_evidence: null, ...fields })

async function workflowOn(c, proposals) {
  const { result } = await runWorkflow(T2.WORKFLOW, { args: { digest: c.digest, nonce: T2.NONCE }, agent: { 'synthesis:proposals': { proposals } } })
  assert.match(String(result.result_mac), /^[0-9a-f]{64}$/, `the workflow finished: ${String(result.report).slice(0, 200)}`)
  return result
}

function check(c, result) {
  const perRun = freshDir('round4-')
  fs.chmodSync(perRun, 0o700)
  fs.cpSync(c.outDir, perRun, { recursive: true })
  const resultFile = path.join(perRun, 'result.json')
  fs.writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 })
  for (const rel of [REPORT_REL, SIDECAR_REL]) fs.rmSync(path.join(c.repo, rel), { force: true })
  const prep = spawnSync(process.execPath, [IGNORE, 'prepare', c.repo, perRun], { encoding: 'utf8' })
  assert.equal(JSON.parse(prep.stdout).ok, true, `${prep.stdout}${prep.stderr}`)
  const res = spawnSync(process.execPath, [VERIFY, 'attended', perRun, resultFile, c.repo, c.repo], { encoding: 'utf8', timeout: 90000, cwd: freshDir('cwd-'), env: { ...process.env, HOME: freshDir('home-'), OPTIMISE_VERIFY_NONCE: T2.NONCE } })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  return { out, reasons: [...out.matchAll(/^REASON (.*)$/gm)].map((m) => m[1]) }
}

// ---- F2: a lens named only in a measurement or a citation is ordinary output ----

const MENTIONS = [
  ['the motivating measurement', { motivating_measurement: 'lens-qa findings per round fell after the trigger change' }],
  ['the confirming measurement', { confirming_measurement: 'lens-qa findings per round do not rise' }],
  ['a citation', (cite) => ({ citations: [cite, 'lens-security round 2 findings'] })],
  ['the reinstatement evidence', { reinstatement_evidence: 'reinstate if the security lens finds more' }],
]

for (const [where, fields] of MENTIONS) {
  test(`F2: a proposal naming an always-on lens only in ${where} is kept by the workflow and PASSes the real check`, async () => {
    const c = collection()
    const cite = c.digest.ledger.citationPool[0]
    const result = await workflowOn(c, [draft(cite, typeof fields === 'function' ? fields(cite) : fields)])
    assert.equal(result.proposals_ranked.length, 1, 'the workflow (first layer) keeps it')
    assert.match(result.report, /lens-qa|lens-security|security lens/, 'guard against vacuity: the lens name is in the rendered report')
    const res = check(c, result)
    assert.ok(!res.reasons.includes(ALWAYS_ON), `the second layer does not refuse it: ${res.reasons}`)
    assert.match(res.out, /^VERDICT PASS$/m, res.out)
  })
}

// ---- F2: a proposal that does remove an always-on lens is refused by BOTH layers ----

// The rendered heading and Target lines of an ordinary proposal, with the statement span or the target's lens span replaced: the shape the
// script writes, so the forgery is well formed and the second layer is the only thing that can stop it.
function forged(result, { statement = null, lens = null, sidecar = null } = {}) {
  const copy = structuredClone(result)
  const id = copy.proposals_ranked[0].proposal_id
  const lines = copy.report.split('\n')
  const heading = lines.findIndex((l) => l.startsWith(`### ${id}: Proposal statement (model text): \``))
  const targetLine = lines.findIndex((l, i) => i > heading && l.startsWith('Target: '))
  assert.ok(heading >= 0 && targetLine > heading, 'guard against vacuity: the block has its heading and Target line')
  if (statement !== null) lines[heading] = `### ${id}: Proposal statement (model text): \`${statement}\``
  if (lens !== null) lines[targetLine] = lines[targetLine].replace('lens=`(empty)`', `lens=\`${lens}\``)
  copy.report = lines.join('\n')
  if (sidecar !== null) copy.proposal_targets[id] = { ...copy.proposal_targets[id], ...sidecar }
  assert.notEqual(copy.report === result.report && sidecar === null, true, 'guard against vacuity: the forgery changed the report or the targets')
  return resign(copy, T2.NONCE)
}

const REMOVALS = [
  ['its statement', { statement: 'Retire lens-qa from the always-on roster' }, { statement: 'Retire lens-qa from the always-on roster' }],
  ['its statement, by phrase', { statement: 'Turn off the security lens for docs-only diffs' }, { statement: 'Turn off the security lens for docs-only diffs' }],
  ['its target lens', { target: target({ lens: 'lens-security' }) }, { lens: 'lens-security' }],
  ['its target flag', { target: target({ touches_always_on_lens: true }) }, { sidecar: { touches_always_on_lens: true } }],
]

for (const [where, drafted, forgery] of REMOVALS) {
  test(`F2: a proposal removing an always-on lens in ${where} is dropped by the workflow and refused by the real check`, async () => {
    const c = collection()
    const cite = c.digest.ledger.citationPool[0]
    const first = await workflowOn(c, [draft(cite, drafted)])
    assert.equal(first.proposals_ranked.length + first.proposals_insufficient_data.length, 0, 'the first layer drops it')
    const ordinary = await workflowOn(c, [draft(cite)])
    const res = check(c, forged(ordinary, forgery))
    assert.deepEqual(res.reasons, [ALWAYS_ON], `the second layer refuses it: ${res.out}`)
    assert.match(res.out, /^PLACE no$/m)
  })
}

// ---- F3: a line-shape FAIL names the line by number, and a row that is there but does not parse says so ----

const { pathToFileURL } = require('node:url')
const loadVerify = () => import(pathToFileURL(VERIFY).href)
const LANES_RAN = { ledger: { status: 'ran' }, git: { status: 'ran' }, ci: { status: 'ran' } }

// The collected files of the T2 'moderate' collection (every section has content) and the report the real workflow renders from it.
async function moderateReport() {
  const col = T2.collection('moderate')
  const { result } = await T2.runDigest(col.digest)
  return { col: { lane: { ledger: col.lanes.ledger, git: col.lanes.git, ci: col.lanes.ci }, digest: col.digest }, report: result.report }
}
const insertAt = (report, lineNumber, text) => {
  const lines = report.split('\n')
  lines.splice(lineNumber - 1, 0, text)
  return lines.join('\n')
}

test('F3: a line in a shape the script never writes is named by its 1-based line number, an integer and nothing else, beside the fixed reason', async () => {
  const { checkFigures, FIXED_REASONS } = await loadVerify()
  const { col, report } = await moderateReport()
  assert.deepEqual(checkFigures({ lanes: LANES_RAN }, report, col).reasons, [], 'control: the unaltered report passes')
  const altered = insertAt(insertAt(report, 4, 'An ordinary sentence the script never writes, holding a <secret>.'), 9, 'Another one.')
  const reasons = checkFigures({ lanes: LANES_RAN }, altered, col).reasons
  assert.ok(reasons.includes(FIXED_REASONS.UNKNOWN_LINE), `the fixed reason itself stays: ${reasons}`)
  assert.deepEqual(reasons.filter((r) => r.startsWith(`${FIXED_REASONS.UNKNOWN_LINE}: `)), [`${FIXED_REASONS.UNKNOWN_LINE}: 4`, `${FIXED_REASONS.UNKNOWN_LINE}: 9`])
  assert.ok(!reasons.some((r) => r.includes('secret') || r.includes('ordinary')), 'no line content is in any reason')
})

test('F3: a line with an odd number of backticks is named by its 1-based line number, beside the fixed reason', async () => {
  const { checkFigures, FIXED_REASONS } = await loadVerify()
  const { col, report } = await moderateReport()
  const lines = report.split('\n')
  const repos = lines.findIndex((l) => l.startsWith('Repos: ')) + 1
  assert.ok(repos > 0, 'guard against vacuity: the report has its Repos line')
  lines[repos - 1] += '`'
  const reasons = checkFigures({ lanes: LANES_RAN }, lines.join('\n'), col).reasons
  assert.ok(reasons.includes(FIXED_REASONS.ODD_BACKTICKS), `${reasons}`)
  assert.ok(reasons.includes(`${FIXED_REASONS.ODD_BACKTICKS}: ${repos}`), `${reasons}`)
})

test('F3: at most three numbered lines per kind, so a wholly foreign report cannot crowd out the other reasons', async () => {
  const { checkFigures, FIXED_REASONS } = await loadVerify()
  const { col, report } = await moderateReport()
  const reasons = checkFigures({ lanes: LANES_RAN }, `${report}\n${Array.from({ length: 50 }, (_, i) => `junk ${i}`).join('\n')}`, col).reasons
  assert.equal(reasons.filter((r) => r.startsWith(`${FIXED_REASONS.UNKNOWN_LINE}: `)).length, 3)
})

// A figure written with more decimal places than the pattern reads: the row is there, it just does not parse.
const ROWS_THAT_DO_NOT_PARSE = [
  ['a per-plan wall-clock row', 'wall-clock plan', (l) => l.startsWith('- `') && l.includes(': ci_wait='), (l) => l.replace(/agent_compute=(\d+)s/, 'agent_compute=$1.0000000000001s')],
  ['the wall-clock totals line', 'wall-clock totals', (l) => l.startsWith('Totals: '), (l) => l.replace(/human_wait=(\d+)s/, 'human_wait=$1.0000000000001s')],
  ['a per-job CI row', 'ci job', (l) => l.includes('::ci::test`: n='), (l) => l.replace(', failed=', ', failed=x')],
  ['the CI run line', 'ci', (l) => l.startsWith('CI runs: '), (l) => `${l} and more`],
]

for (const [what, name, find, damage] of ROWS_THAT_DO_NOT_PARSE) {
  test(`F3: ${what} that is there but does not parse is reported as a row that did not parse, not as the first figure missing`, async () => {
    const { checkFigures } = await loadVerify()
    const { col, report } = await moderateReport()
    const lines = report.split('\n')
    const at = lines.findIndex(find)
    assert.ok(at >= 0, `guard against vacuity: the report has ${what}`)
    const damaged = damage(lines[at])
    assert.notEqual(damaged, lines[at], 'guard against vacuity: the damage landed')
    lines[at] = damaged
    const reasons = checkFigures({ lanes: LANES_RAN }, lines.join('\n'), col).reasons
    assert.ok(reasons.includes(`figure mismatch ${name}: a row did not parse`), `${reasons}`)
    assert.ok(!reasons.some((r) => r.startsWith(`figure mismatch ${name}: `) && r.endsWith('reported none')), `no "reported none" naming the first figure: ${reasons}`)
    assert.ok(reasons.includes(`report has a line in a shape the check does not know: ${at + 1}`), `and the line is named: ${reasons}`)
  })
}

test('F3: a row that is simply absent is still reported as missing, naming its first figure', async () => {
  const { checkFigures } = await loadVerify()
  const { col, report } = await moderateReport()
  const without = report.split('\n').filter((l) => !l.startsWith('Totals: ')).join('\n')
  const reasons = checkFigures({ lanes: LANES_RAN }, without, col).reasons
  assert.ok(reasons.some((r) => r.startsWith('figure mismatch wall-clock totals: ci wait seconds collected ') && r.endsWith(', reported none')), `${reasons}`)
})

test('F3: a keyed row is said not to parse only when the unparsed line carries its own key: another row\'s damage leaves a missing row "reported none"', async () => {
  const { checkFigures } = await loadVerify()
  const { col, report } = await moderateReport()
  const lines = report.split('\n')
  const build = lines.findIndex((l) => l.includes('::ci::build-CANARY-job`: n='))
  const testRow = lines.findIndex((l) => l.includes('::ci::test`: n='))
  assert.ok(build >= 0 && testRow >= 0, 'guard against vacuity: both job rows are there')
  lines[build] = lines[build].replace(', failed=', ', failed=x')
  const reasons = checkFigures({ lanes: LANES_RAN }, lines.filter((_, i) => i !== testRow).join('\n'), col).reasons
  assert.ok(reasons.includes('figure mismatch ci job: a row did not parse'), `the damaged row: ${reasons}`)
  assert.ok(reasons.some((r) => r.startsWith('figure mismatch ci job: n collected ') && r.endsWith(', reported none')), `the removed row is still missing: ${reasons}`)
})

test('F3: a row whose shape starts with no literal text is never said not to parse: an unrelated foreign line leaves it "reported none"', async () => {
  const { checkFigures } = await loadVerify()
  const { col, report } = await moderateReport()
  const lines = report.split('\n')
  const skipped = lines.findIndex((l) => / ledger line\(s\) were skipped/.test(l))
  assert.ok(skipped >= 0, 'guard against vacuity: the report has the skipped-lines row, whose shape starts with a number')
  lines.splice(skipped, 1, 'A foreign line.')
  const reasons = checkFigures({ lanes: LANES_RAN }, lines.join('\n'), col).reasons
  assert.ok(reasons.some((r) => r.startsWith('figure mismatch ledger repository: skipped collected ') && r.endsWith(', reported none')), `${reasons}`)
  assert.ok(!reasons.includes('figure mismatch ledger repository: a row did not parse'), `${reasons}`)
})

test('F3: the attended check prints the line number on its REASON line, and the operator reads that line from the saved result before clean-up', async () => {
  const c = collection()
  const result = await workflowOn(c, [])
  const copy = structuredClone(result)
  copy.report = insertAt(copy.report, 3, 'A line the script never writes.')
  const res = check(c, resign(copy, T2.NONCE))
  assert.ok(res.reasons.includes('report has a line in a shape the check does not know: 3'), res.out)
  assert.ok(!res.out.includes('A line the script never writes.'), 'no report content in the check output')
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'optimise-cycle', 'SKILL.md'), 'utf8')
  assert.match(readme, /fails the same way every run/i, 'the runbook has a step for a failure that repeats every run')
  for (const text of [readme, skill]) assert.match(text, /result\.json/, 'which says where the numbered line is read from')
})

// ---- F4: the shared path pattern is NOT widened; ordinary text with slashes survives it ----
//
// A path that follows a letter directly ('x' + home + '/secret job') is not caught by the shared pattern, and widening it to catch one would
// also catch relative paths, fractions, dates and 'and/or' in everything the ledger writer records. F4 stays open (the collector, which knows
// the repository root and the home directory, would have to redact those literal roots before the digest is written); these tests hold the
// pattern to what it must keep leaving alone, so an unsafe widening fails here.

const redactPaths = async (value) => (await import(pathToFileURL(path.join(ROOT, 'workflows', 'lib', 'ledger-append.mjs')).href)).redactPaths(value)

const ORDINARY = ['https://github.com/acme/repo/pull/12', 'a 3/4 share of runs', 'merged on 2026/11/24', 'lint and/or test', 'see workflows/lib/ledger-append.mjs', 'CI/CD']
test('F4: the shared path pattern leaves URLs, fractions, dates, and/or and relative paths unredacted, and still redacts an absolute path after a space', async () => {
  for (const text of ORDINARY) assert.equal(await redactPaths(text), text, JSON.stringify(text))
  assert.equal(await redactPaths('cache at /var/tmp/x today'), 'cache at <redacted-path> today', 'control: an absolute path after a space is still redacted')
})

// ---- F5: a ledger that exists but cannot be read does not silently switch eviction protection off ----

const readerPromise = import(pathToFileURL(T2.READER).href)
const LEDGER = path.join('.claude', 'harness-ledger.jsonl')

// 500 decided-looking entries on disk, oldest first, each a valid target under its own id; the oldest one is the one the ledger records a
// decision for. With the run's own new entry that is 501, one past the carry maximum.
async function fullSidecar() {
  const reader = await readerPromise
  const entries = Array.from({ length: 500 }, (_, i) => target({ concern: `entry ${i}` }))
  return { sidecar: Object.fromEntries(entries.map((t) => [reader.stableProposalId(t), t])), oldest: reader.stableProposalId(entries[0]) }
}

async function placeOverFullSidecar(ledgerState) {
  const c = collection()
  const { sidecar, oldest } = await fullSidecar()
  const result = await workflowOn(c, [draft(c.digest.ledger.citationPool[0], { target: target({ concern: 'the new one' }) })])
  const ledgerFile = path.join(c.repo, LEDGER)
  const eventKey = `${oldest}:proposal_adopted:1`
  const decided = `${F.validLedger(5)}${F.ledgerLine(99, { kind: 'conduct_plan_event', event: 'proposal_adopted', event_key: eventKey })}\n`
  fs.rmSync(ledgerFile, { force: true })
  if (ledgerState === 'readable') fs.writeFileSync(ledgerFile, decided)
  if (ledgerState === 'symlink') {
    const elsewhere = path.join(freshDir('ledger-elsewhere-'), 'harness-ledger.jsonl')
    fs.writeFileSync(elsewhere, decided)
    fs.symlinkSync(elsewhere, ledgerFile)
  }
  if (ledgerState === 'oversized') {
    fs.writeFileSync(ledgerFile, decided)
    fs.truncateSync(ledgerFile, 64 * 1024 * 1024 + 1)
  }
  const perRun = freshDir('round4-f5-')
  fs.chmodSync(perRun, 0o700)
  fs.cpSync(c.outDir, perRun, { recursive: true })
  const resultFile = path.join(perRun, 'result.json')
  fs.writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 })
  fs.rmSync(path.join(c.repo, REPORT_REL), { force: true })
  fs.writeFileSync(path.join(c.repo, SIDECAR_REL), `${JSON.stringify(sidecar, null, 2)}\n`)
  assert.equal(JSON.parse(spawnSync(process.execPath, [IGNORE, 'prepare', c.repo, perRun], { encoding: 'utf8' }).stdout).ok, true)
  const res = spawnSync(process.execPath, [VERIFY, 'attended', perRun, resultFile, c.repo, c.repo], { encoding: 'utf8', timeout: 90000, cwd: freshDir('cwd-'), env: { ...process.env, HOME: freshDir('home-'), OPTIMISE_VERIFY_NONCE: T2.NONCE } })
  const placed = JSON.parse(fs.readFileSync(path.join(c.repo, SIDECAR_REL), 'utf8'))
  fs.rmSync(ledgerFile, { force: true })
  return { out: res.stdout || '', placed, oldest, newId: result.proposals_ranked[0].proposal_id }
}

test('F5 control: with a readable ledger, 500 entries plus one evicts an undecided entry, keeps the decided oldest one, and raises no notice', async () => {
  const { out, placed, oldest, newId } = await placeOverFullSidecar('readable')
  assert.match(out, /^PLACE yes$/m, out)
  assert.equal(Object.keys(placed).length, 500)
  assert.ok(Object.hasOwn(placed, oldest) && Object.hasOwn(placed, newId), 'the decided entry and the new one are kept')
  assert.doesNotMatch(out, /^NOTICE sidecar-eviction-unprotected$/m)
})

for (const state of ['symlink', 'oversized']) {
  test(`F5: with a ledger that exists but cannot be read (${state}), 500 entries plus one evicts nothing while under the byte cap and raises the fixed notice`, async () => {
    const { out, placed, oldest, newId } = await placeOverFullSidecar(state)
    assert.match(out, /^PLACE yes$/m, out)
    assert.equal(Object.keys(placed).length, 501, 'nothing is evicted in this run')
    assert.ok(Object.hasOwn(placed, oldest) && Object.hasOwn(placed, newId))
    assert.match(out, /^NOTICE sidecar-eviction-unprotected$/m, out)
  })
}

test('F5: an absent ledger is not "cannot read": eviction runs oldest first as before, with no notice', async () => {
  const { out, placed, newId } = await placeOverFullSidecar('absent')
  assert.match(out, /^PLACE yes$/m, out)
  assert.equal(Object.keys(placed).length, 500)
  assert.ok(Object.hasOwn(placed, newId))
  assert.doesNotMatch(out, /^NOTICE sidecar-eviction-unprotected$/m)
})
