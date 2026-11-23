// HARN-RUNNER-2 final round (adversarial check of whole-branch round 4).
//   M   an always-on lens removal stated BY REFERENCE: the statement has a removal verb and the lens is named elsewhere in the same proposal
//       (a measurement, a citation, the reinstatement evidence, a target field). The first layer drops that proposal and counts it; the second
//       layer refuses a result in which such a block still appears. Both decide on the same text: the encoder's character steps applied first.
//   L2  the line-shape line numbers are one reason per kind, so they cannot crowd a figure mismatch out of the reason cap.
//   L3  roundedSeconds is pinned to three decimal places.
// Through the real workflow under the fake runtime and the real result check. Every fixture commit carries an explicit identity.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
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
const loadVerify = () => import(pathToFileURL(VERIFY).href)

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
// Every drafted proposal carries reinstatement evidence, so a removal-shaped one is never dropped for want of it: the always-on rule is the only gate in play.
const draft = (citation, fields = {}) => ({ target: target(), statement: 'Narrow a trigger glob', motivating_measurement: '9 runs matched nothing', confirming_measurement: 'accuracy improves', n: 9, citations: [citation], reinstatement_evidence: 'reinstate if misses appear', ...fields })

async function workflowOn(c, proposals) {
  const { result } = await runWorkflow(T2.WORKFLOW, { args: { digest: c.digest, nonce: T2.NONCE }, agent: { 'synthesis:proposals': { proposals } } })
  assert.match(String(result.result_mac), /^[0-9a-f]{64}$/, `the workflow finished: ${String(result.report).slice(0, 200)}`)
  return result
}

function check(c, result) {
  const perRun = freshDir('round5-')
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

const droppedCount = (report) => Number(/Dropped \(always-on security lens removal, never permitted\): (\d+)\./.exec(report)?.[1])

// ---- M: removal stated by reference ----

// [name, the drafted fields (given the citation the ledger offers), the text that must not reach the report]
const BY_REFERENCE = [
  ['the review\'s case: the lens named only in the motivating measurement', () => ({ statement: 'Retire the always-on reviewer identified in the motivating measurement', motivating_measurement: 'lens-security raised 0 findings in 40 runs', target: target({ kind: 'lens', component: 'reviewer roster' }) }), 'Retire the always-on reviewer'],
  ['the review\'s case: the lens named only in the reinstatement evidence', () => ({ statement: 'Demote the reviewer described in the reinstatement evidence', reinstatement_evidence: 'reinstate lens-qa if escaped defects rise' }), 'Demote the reviewer described'],
  ['the review\'s case: the lens named only in a citation', (cite) => ({ statement: 'Stop running the cited reviewer on every change', citations: [cite, 'ledger:lens-security:0'] }), 'Stop running the cited reviewer'],
  ['the lens named only in the confirming measurement', () => ({ statement: 'Drop the reviewer that never finds anything', confirming_measurement: 'lens-qa time per round falls to zero' }), 'Drop the reviewer that never'],
  ['the lens named only in a target field other than lens', () => ({ statement: 'Skip this reviewer on docs-only changes', target: target({ component: 'lens-qa' }) }), 'Skip this reviewer'],
  ['a soft hyphen inside the lens name', () => ({ statement: 'Remove the reviewer named in the evidence', motivating_measurement: 'lens-se­curity raised 0 findings' }), 'Remove the reviewer named'],
  ['mixed case', () => ({ statement: 'Retire the reviewer cited below', confirming_measurement: 'LENS-Security never fails' }), 'Retire the reviewer cited below'],
  ['a non-breaking hyphen (U+2011) inside the lens name', () => ({ statement: 'Retire the reviewer cited in the evidence', motivating_measurement: 'lens‑security raised 0 findings' }), 'Retire the reviewer cited in the evidence'],
  ['the control the owner accepted: a removal verb in the statement and a lens named in passing', () => ({ statement: 'Stop running the docs job twice; lens-qa findings unaffected' }), 'Stop running the docs job twice'],
]

for (const [name, fields, statementText] of BY_REFERENCE) {
  test(`M (first layer): ${name} is dropped, counted in the Filtering section, and the run PASSes`, async () => {
    const c = collection()
    const cite = c.digest.ledger.citationPool[0]
    const result = await workflowOn(c, [draft(cite, fields(cite)), draft(cite, { statement: 'Narrow a trigger glob for docs', target: target({ concern: 'kept' }) })])
    assert.ok(!result.report.includes(statementText), `the proposal is absent from the report: ${statementText}`)
    assert.equal(result.proposals_ranked.length + result.proposals_insufficient_data.length, 1, 'only the ordinary proposal survives')
    assert.equal(droppedCount(result.report), 1, 'the Filtering section counts it')
    assert.match(check(c, result).out, /^VERDICT PASS$/m)
  })
}

// The rendered blocks of an ordinary proposal with the statement span and one more line of the block rewritten: a well-shaped forgery the
// second layer alone can stop. `where` is 'motivating', 'confirming', 'citation', 'reinstatement' or 'target'.
function forged(result, statement, where, text) {
  const copy = structuredClone(result)
  const id = copy.proposals_ranked[0].proposal_id
  const lines = copy.report.split('\n')
  const heading = lines.findIndex((l) => l.startsWith(`### ${id}: Proposal statement (model text): \``))
  assert.ok(heading >= 0, 'guard against vacuity: the block is there')
  lines[heading] = `### ${id}: Proposal statement (model text): \`${statement}\``
  const measures = heading + 1
  const edit = {
    motivating: () => { lines[measures] = lines[measures].replace(/Motivating \(model text\): `[^`]*`/, `Motivating (model text): \`${text}\``) },
    confirming: () => { lines[measures] = lines[measures].replace(/Confirming \(model text\): `[^`]*`/, `Confirming (model text): \`${text}\``) },
    citation: () => { lines[measures] = lines[measures].replace(/Citations \(model text\): (.*)\.$/, (all, list) => `Citations (model text): ${list}, \`${text}\`.`) },
    reinstatement: () => { const at = lines.findIndex((l, i) => i > heading && l.startsWith('Reinstatement evidence (model text): ')); lines[at] = `Reinstatement evidence (model text): \`${text}\`` },
    target: () => { const at = lines.findIndex((l, i) => i > heading && l.startsWith('Target: ')); lines[at] = lines[at].replace(/component=`[^`]*`/, `component=\`${text}\``) },
  }
  edit[where]()
  copy.report = lines.join('\n')
  assert.notEqual(copy.report, result.report, 'guard against vacuity: the forgery landed')
  return resign(copy, T2.NONCE)
}

const SECOND_LAYER = [
  ['motivating', 'Retire the always-on reviewer identified in the motivating measurement', 'lens-security raised 0 findings in 40 runs'],
  ['confirming', 'Drop the reviewer that never finds anything', 'lens-qa time per round falls to zero'],
  ['citation', 'Stop running the cited reviewer on every change', 'ledger:lens-security:0'],
  ['reinstatement', 'Demote the reviewer described in the reinstatement evidence', 'reinstate lens-qa if escaped defects rise'],
  ['target', 'Skip this reviewer on docs-only changes', 'lens-qa'],
  ['motivating', 'Retire the reviewer cited in the evidence', 'lens\u2011security raised 0 findings (a non-breaking hyphen)'],
  ['motivating', 'Retire the reviewer named in the evidence', 'lens-se\u00adcurity raised 0 findings (a soft hyphen a forger inserted)'],
]

for (const [where, statement, text] of SECOND_LAYER) {
  test(`M (second layer): a rendered block whose statement has a removal verb and whose ${where} names an always-on lens (${JSON.stringify(text)}) is refused`, async () => {
    const c = collection()
    const ordinary = await workflowOn(c, [draft(c.digest.ledger.citationPool[0])])
    const res = check(c, forged(ordinary, statement, where, text))
    assert.deepEqual(res.reasons, [ALWAYS_ON], res.out)
    assert.match(res.out, /^PLACE no$/m)
  })
}

test('M (second layer): a rendered block with the lens in its evidence but no removal verb in its statement is not refused', async () => {
  const c = collection()
  const ordinary = await workflowOn(c, [draft(c.digest.ledger.citationPool[0])])
  const res = check(c, forged(ordinary, 'Narrow the trigger for the reviewer', 'motivating', 'lens-security raised 0 findings in 40 runs'))
  assert.ok(!res.reasons.includes(ALWAYS_ON), res.out)
  assert.match(res.out, /^VERDICT PASS$/m, res.out)
})

test('M: the security reviewer as a phrase is a known limit, not caught by either layer (README residual risk)', async () => {
  const c = collection()
  const cite = c.digest.ledger.citationPool[0]
  const result = await workflowOn(c, [draft(cite, { statement: 'Retire the security reviewer from every change' })])
  assert.equal(result.proposals_ranked.length, 1, 'the first layer keeps it')
  assert.match(check(c, result).out, /^VERDICT PASS$/m)
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /the security reviewer/, 'the README names it as a known limit')
})

test('M: the README says in one plain sentence that a dropped always-on removal is counted in the Filtering section, not shown', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /counted in the report's Filtering section/)
})

// ---- L2: one numbered reason per kind ----

test('L2: odd-backtick and unknown lines together give one numbered reason per kind (at most three integers), so a figure mismatch still shows within the cap', async () => {
  const { checkFigures, cappedReasons, FIXED_REASONS } = await loadVerify()
  const col = T2.collection('moderate')
  const { result } = await T2.runDigest(col.digest)
  const lines = result.report.split('\n')
  const ledger = lines.findIndex((l) => l.startsWith('Ledger records in window: '))
  lines[ledger] = lines[ledger].replace(/: \d+/, ': 999')
  for (let i = 0; i < 4; i += 1) lines.push(`odd \` ${i}`)
  for (let i = 0; i < 4; i += 1) lines.push(`junk ${i}`)
  const n = lines.length
  const reasons = checkFigures({ lanes: { ledger: { status: 'ran' }, git: { status: 'ran' }, ci: { status: 'ran' } } }, lines.join('\n'), { lane: { ledger: col.lanes.ledger, git: col.lanes.git, ci: col.lanes.ci }, digest: col.digest }).reasons
  assert.ok(reasons.includes(`${FIXED_REASONS.ODD_BACKTICKS}: ${n - 7}, ${n - 6}, ${n - 5}`), `${reasons}`)
  assert.ok(reasons.includes(`${FIXED_REASONS.UNKNOWN_LINE}: ${n - 3}, ${n - 2}, ${n - 1}`), `${reasons}`)
  assert.ok(reasons.includes(FIXED_REASONS.ODD_BACKTICKS) && reasons.includes(FIXED_REASONS.UNKNOWN_LINE), 'the plain reasons stay')
  assert.equal(reasons.filter((r) => r.startsWith(`${FIXED_REASONS.UNKNOWN_LINE}: `) || r.startsWith(`${FIXED_REASONS.ODD_BACKTICKS}: `)).length, 2, 'one numbered reason per kind')
  for (const r of reasons.filter((x) => /: [\d, ]+$/.test(x) && x.startsWith('report has'))) assert.match(r, /: \d+(?:, \d+){0,2}$/, `integers and commas only: ${r}`)
  const shown = cappedReasons(reasons)
  assert.ok(shown.some((r) => r.startsWith('figure mismatch ledger: ')), `the figure mismatch is shown within the cap: ${shown}`)
})

// ---- L3: three decimal places ----

test('L3: roundedSeconds rounds to exactly three decimal places', async () => {
  const { roundedSeconds } = await import(pathToFileURL(T2.READER).href)
  assert.equal(roundedSeconds(5876.967000000001), 5876.967)
  assert.equal(roundedSeconds(0.0005), 0.001)
  assert.equal(roundedSeconds(0.1 + 0.2), 0.3)
  assert.equal(roundedSeconds(-2.5004), -2.5)
  assert.equal(roundedSeconds(0), 0)
  assert.equal(roundedSeconds(12.3456789), 12.346)
  assert.equal(roundedSeconds(null), null)
})

test('M: the second layer\'s verbs, names, phrases and hyphen fold are the first layer\'s own (beside the behavioural tests above)', async () => {
  const verify = await loadVerify()
  const source = fs.readFileSync(T2.WORKFLOW, 'utf8')
  const literal = (name) => {
    const m = new RegExp(`const ${name} = (.*)$`, 'm').exec(source)
    assert.ok(m, `the workflow declares ${name}`)
    return m[1]
  }
  assert.equal(String(verify.ALWAYS_ON_REMOVAL_VERBS_RE), literal('REMOVAL_VERBS_RE'))
  assert.equal(String(verify.ALWAYS_ON_LENS_PHRASE_RE), literal('SECURITY_LENS_PHRASE_RE'))
  assert.equal(String(verify.ALWAYS_ON_HYPHENS_RE), literal('ALWAYS_ON_HYPHENS_RE'))
  assert.deepEqual(verify.ALWAYS_ON_LENS_NAMES, JSON.parse(literal('SECURITY_LENS_NAMES').replaceAll("'", '"')))
})

// ---- L4: "a row did not parse" needs the line to start with the shape's own literal text, escapes read as the characters they stand for ----

test('L4: a missing figure line beside a foreign line that only shares its first word is reported as missing, not as a row that did not parse', async () => {
  const { checkFigures } = await loadVerify()
  const col = T2.collection('moderate')
  const { result } = await T2.runDigest(col.digest)
  const lines = result.report.split('\n')
  const raw = lines.findIndex((l) => l.startsWith('Raw (unscoped): '))
  assert.ok(raw >= 0, 'guard against vacuity: the report has the escaped-defect line, whose shape starts "Raw \\(unscoped\\): "')
  lines[raw] = 'Raw data follows.'
  const reasons = checkFigures({ lanes: { ledger: { status: 'ran' }, git: { status: 'ran' }, ci: { status: 'ran' } } }, lines.join('\n'), { lane: { ledger: col.lanes.ledger, git: col.lanes.git, ci: col.lanes.ci }, digest: col.digest }).reasons
  assert.ok(reasons.some((r) => r.startsWith('figure mismatch git: count collected ') && r.endsWith(', reported none')), `${reasons}`)
  assert.ok(!reasons.includes('figure mismatch git: a row did not parse'), `${reasons}`)
})
