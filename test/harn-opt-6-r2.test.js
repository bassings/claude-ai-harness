// HARN-OPT-6 T1 fix round 2 (specs/harn-opt-6.md, review round 2, owner decision of 2026-10-28 on AC-QA-9 and
// AC-ARCH-9). Items A to G, J and K live here; H is in test/review-cycle-finding-ids.test.js and I in
// test/harn-opt-6-r2-env.test.js.
//
// A run of review() with no spec and the default scope triggers ONLY lens-security and lens-qa, so no assertion
// below leans on a verdict, drift value or finding from any other lens unless the run passes `lenses` or a spec.
//
// Names this file pins because the spec leaves them open (the t1 test file did the same for FINDINGS_KEY):
//   legacy_payload          the optional boolean the writer sets true on a row built from a legacy descriptor payload (item E)
//   fixed_findings_supplied the explicit boolean a review_cycle payload carries when fixed_findings was supplied (item J)
// The 06049e4 writer and workflow are read from git into a temp directory, never from the working tree.
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload, extractEncodedPayload } = require('./helpers/extract-ledger-payload.js')
const { findingId: oracleId } = require('./helpers/finding-entries.js')
const { sanitizedGitEnv } = require('./helpers/git-env.js')
const { makeTempRepo, runAppend, readLedgerLines, cleanupTempRepos, SUITE_TMPDIR } = require('./helpers/temp-repo.js')

const ROOT = path.join(__dirname, '..')
const WF = path.join(ROOT, 'workflows', 'review-cycle.js')
const WRITER_FILE = path.join(ROOT, 'workflows', 'lib', 'ledger-append.mjs')
const WRITER_URL = pathToFileURL(WRITER_FILE).href
const SPEC = path.join(ROOT, 'specs', 'harn-opt-6.md')
const OLD = '06049e4'

test.after(cleanupTempRepos)

function gitShow(rel) {
  return execFileSync('git', ['show', `${OLD}:${rel}`], { cwd: ROOT, encoding: 'utf8', env: sanitizedGitEnv(), maxBuffer: 64 * 1024 * 1024 })
}
const OLD_DIR = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'old-r2-'))
fs.mkdirSync(path.join(OLD_DIR, 'lib'))
fs.writeFileSync(path.join(OLD_DIR, 'lib', 'ledger-append.mjs'), gitShow('workflows/lib/ledger-append.mjs'))
fs.writeFileSync(path.join(OLD_DIR, 'review-cycle.js'), gitShow('workflows/review-cycle.js'))
const OLD_WRITER = path.join(OLD_DIR, 'lib', 'ledger-append.mjs')
const OLD_WF = path.join(OLD_DIR, 'review-cycle.js')
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').pop())
const runOldWriter = (repo, payload) => lastJson(spawnSync('node', [OLD_WRITER], { cwd: repo, input: JSON.stringify(payload), encoding: 'utf8', env: sanitizedGitEnv() }).stdout)
const newWriter = (repo) => (prompt) => lastJson(runAppend(repo, extractLedgerPayload(prompt)).stdout)
const oldWriterAgent = (repo) => (prompt) => runOldWriter(repo, extractLedgerPayload(prompt))

// ---- fixtures (same shapes as test/harn-opt-6-gap.test.js) ----
const LEDGER_OK = { run_id: '3c9d1e62-5a7b-4f08-8e21-9b4d6c0a7f13', ts: '2026-08-10T00:00:00.000Z', write_ok: true, write_error: null }
const TIP = { head_sha_measured: 'abcdef1234567890', head_tree_measured: '1111111111111111111111111111111111111111' }
const COVERAGE = { examined: 'x', verified_by: 'y', could_not_check: 'z' }
const CLEAN = { verdict: 'CLEAN', coverage: COVERAGE, findings: [], ...TIP }
const SCOPE_OK = {
  base: 'main', head_sha: 'abcdef1234567890', head_tree: '1111111111111111111111111111111111111111',
  files: [{ path: 'src/foo.js', status: 'M' }], new_dependency_entries: false, new_modules: false, custom_rules: null,
  harness_triggers_file_exists: false,
  consistency: { ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9, doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null },
}
const ALL_LENSES = ['lens-security', 'lens-qa', 'lens-design', 'lens-accessibility', 'lens-product', 'lens-architecture', 'lens-data', 'lens-operability', 'reviewer-verification']
function agents(overrides = {}) {
  return {
    'scope:diff': SCOPE_OK,
    ...Object.fromEntries(ALL_LENSES.map((l) => [l, CLEAN])),
    synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [] },
    'ledger:write': LEDGER_OK,
    ...overrides,
  }
}
async function review(args, overrides, wf = WF) {
  const out = await runWorkflow(wf, { args, agent: agents(overrides) })
  const payloads = out.calls.filter((c) => c.opts.label === 'ledger:write').map((c) => extractLedgerPayload(c.prompt))
  return { ...out, payloads, terminal: payloads.filter((p) => p.outcome !== 'started').pop() }
}
const lensFinding = (claim, location, extra = {}) => ({ severity: 'High', claim, location, evidence: 'e', consequence: 'c', fix: 'f', ...extra })
const withFindings = (findings) => ({ 'lens-security': { verdict: 'FINDINGS', coverage: COVERAGE, findings, ...TIP } })
const confirm = (p) => ({ lens: p.lens, location: p.location, claim: p.claim })
const withId = (p) => ({ ...p, id: oracleId(p.lens, p.location, p.claim) })
const rowsOf = (repo) => readLedgerLines(repo).map((l) => JSON.parse(l))
const terminalRows = (repo) => rowsOf(repo).filter((r) => r.outcome !== 'started')

// A row as the writer landed it, minus what legitimately differs between two writes: run_id, ts, repo and the *_raw siblings
// AC-SEC-4 removed (on findings and on ac_verdicts).
function normalise(row, ignore = []) {
  const copy = JSON.parse(JSON.stringify(row))
  for (const k of ignore) delete copy[k]
  for (const k of ['run_id', 'ts', 'repo']) delete copy[k]
  for (const list of [copy.findings || [], copy.ac_verdicts || []]) for (const f of list) for (const k of Object.keys(f)) if (k.endsWith('_raw')) delete f[k]
  return copy
}
// The payload the 06049e4 workflow would have sent for the same round: the new terminal payload's telemetry with the
// finding entries and the script-side counters removed, and the raw descriptors put back.
function legacyPayload(terminal, descriptors) {
  const { finding_entries, fixed_findings_supplied, invalid_ac_ids_dropped, invalid_finding_fields_dropped, invalid_record_values_dropped, invalid_fixed_ids_dropped, duplicate_fixed_ids_dropped, invalid_prior_ids_dropped, findings_truncated, ...telemetry } = terminal
  return { ...telemetry, ...descriptors }
}
async function goldenAgainstOld({ args, over, descriptors, ignore }) {
  const { terminal, logs } = await review(args, over)
  const oldRepo = makeTempRepo()
  const newRepo = makeTempRepo()
  const oldOut = runOldWriter(oldRepo, legacyPayload(terminal, descriptors))
  assert.equal(oldOut.write_ok, true, oldOut.write_error)
  const newOut = lastJson(runAppend(newRepo, terminal).stdout)
  assert.equal(newOut.write_ok, true, newOut.write_error)
  return { terminal, logs, newRow: terminalRows(newRepo).pop(), oldRow: terminalRows(oldRepo).pop(), ignore }
}
const sameRow = ({ newRow, oldRow, ignore }) => assert.deepEqual(normalise(newRow, ignore), normalise(oldRow, ignore))

// =====================================================================================================================
// Item A: verified prior ids are never capped; fixed confirmations are never cut before the writer's reconciliation;
// only the written dispositions (open, rejected, spec_bug) are capped at MAX_FINDINGS in the script.
// =====================================================================================================================
const seventyFindings = () => Array.from({ length: 70 }, (_, i) => lensFinding(`claim ${i}`, `f${i}.js:${i + 1}`))

test('A: round 1 with 70 open findings, round 2 passing all 70 back and confirming #5 and #65 through the real writer records both fixed with no invalid_fixed_ids_dropped, the same row as the 06049e4 writer', async () => {
  const newRepo = makeTempRepo()
  const r1 = await review({}, { ...withFindings(seventyFindings()), 'ledger:write': newWriter(newRepo) })
  const prior = r1.result.open_findings
  assert.equal(prior.length, 70, 'round 1 must return all 70 open findings')
  const confirmed = [prior[4], prior[64]]
  const synthesis = { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: confirmed.map(confirm) }

  await review({ round: 2, prior_findings: prior }, { synthesis, 'ledger:write': newWriter(newRepo) })
  const row = terminalRows(newRepo).pop()
  const expectedIds = confirmed.map((p) => oracleId(p.lens, p.location, p.claim))
  assert.deepEqual(row.findings.filter((f) => f.disposition === 'fixed').map((f) => f.id), expectedIds, 'both #5 and #65 must be recorded fixed')
  assert.equal(row.invalid_fixed_ids_dropped, 0, 'a confirmation of a prior beyond the first 60 is valid, not invalid')
  assert.equal(row.invalid_prior_ids_dropped, 0)

  const oldRepo = makeTempRepo()
  await review({ round: 2, prior_findings: prior }, { synthesis, 'ledger:write': oldWriterAgent(oldRepo) }, OLD_WF)
  assert.deepEqual(normalise(row), normalise(terminalRows(oldRepo).pop()), 'the row must equal the 06049e4 writer\'s on the same input')
})

test('A: the payload carries every verified prior id (70 of 70), and the fixed entries for #5 and #65', async () => {
  const findings = seventyFindings()
  const priors = findings.map((f) => withId({ lens: 'lens-security', location: f.location, claim: f.claim, severity: 'High', ac_id: null }))
  const { terminal } = await review({ round: 2, prior_findings: priors }, {
    synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(priors[4]), confirm(priors[64])] },
  })
  const by = (d) => terminal.finding_entries.filter((e) => e.disposition === d)
  assert.equal(by('prior').length, 70, 'verified prior ids must never be capped')
  assert.deepEqual(by('fixed').map((e) => e.id), [priors[4].id, priors[64].id])
})

// Everything above the cap at once: 75 prior ids, 75 open, 75 spec bugs, 75 rejected, and 110 fixed claims (75 valid,
// 30 repeats of valid ones, 5 that match no prior). The row must be the one the 06049e4 writer lands for the same round.
const OVER = 75
const overCap = (() => {
  const mk = (tag, i, lens = 'lens-qa') => ({ lens, location: `${tag}${i}.js:${i + 1}`, claim: `${tag} claim ${i}`, severity: 'Medium', ac_id: null })
  const priors = Array.from({ length: OVER }, (_, i) => withId(mk('p', i)))
  const open = Array.from({ length: OVER }, (_, i) => lensFinding(`open ${i}`, `o${i}.js:${i + 1}`))
  const specBugs = Array.from({ length: OVER }, (_, i) => mk('s', i))
  const rejected = Array.from({ length: OVER }, (_, i) => mk('r', i))
  const fixed = [...priors.map(confirm), ...priors.slice(0, 30).map(confirm), ...Array.from({ length: 5 }, (_, i) => confirm(mk('never', i)))]
  const synthesis = { report: '### VERDICT\nFINDINGS', spec_bugs: specBugs, rejected_findings: rejected, fixed_findings: fixed }
  return {
    args: { spec: 'specs/example.md', round: 2, prior_findings: priors },
    over: { ...withFindings(open), synthesis },
    descriptors: {
      spec_bugs: specBugs, rejected_findings: rejected, prior_findings: priors, fixed_findings: fixed,
      open_findings: open.map((f) => ({ lens: 'lens-security', location: f.location, claim: f.claim, severity: 'High', ac_id: null, recurrence: null })),
    },
  }
})()

// Fix round 3, item A (owner decision 2026-10-28, review round 3 finding 2): the script cuts nothing. Truncation happens
// only in the writer, after its same-round exclusion, so a still-open finding past the 60th can never be recorded fixed.
test('A (round 3): with every disposition above MAX_FINDINGS the script cuts none of them and sends no findings_truncated; the writer alone truncates', async () => {
  const { terminal } = await review(overCap.args, overCap.over)
  const by = (d) => terminal.finding_entries.filter((e) => e.disposition === d)
  for (const d of ['open', 'rejected', 'spec_bug']) assert.equal(by(d).length, OVER, `${d}: the script must send all ${OVER}, not a capped count`)
  assert.equal(by('prior').length, OVER, 'verified prior ids must not be capped')
  const priorIds = new Set(by('prior').map((e) => e.id))
  const validFixed = new Set(by('fixed').map((e) => e.id).filter((id) => priorIds.has(id)))
  assert.equal(validFixed.size, OVER, 'every valid confirmation (all 75 distinct prior ids) must reach the writer')
  assert.ok(!('findings_truncated' in terminal), 'the script must not hand the writer a findings_truncated count: the writer computes it')
})

test('A (round 3): review-cycle.js holds no script-side per-disposition cap (PAYLOAD_MAX_FINDINGS, cappedFindingCount) and slices no pair list', () => {
  const src = fs.readFileSync(WF, 'utf8')
  assert.ok(!/PAYLOAD_MAX_FINDINGS/.test(src), 'PAYLOAD_MAX_FINDINGS is still in review-cycle.js')
  assert.ok(!/cappedFindingCount/.test(src), 'cappedFindingCount is still in review-cycle.js')
  assert.ok(!/Pairs\.slice\(|pairs\.slice\(/.test(src), 'a finding pair list is still sliced in review-cycle.js')
})

// A claim fixed against the 61st finding of a disposition: the writer excludes it (the same round gives that id another
// disposition) BEFORE it truncates, so no fixed entry, one invalid_fixed_ids_dropped, and the same findings_truncated as
// the 06049e4 writer records for the same round.
function overlapCase(disposition) {
  const n = 61
  const mk = (tag, i) => ({ lens: 'lens-qa', location: `${tag}${i}.js:${i + 1}`, claim: `${tag} claim ${i}`, severity: 'Medium', ac_id: null })
  let over = {}
  let open = []
  let rejected = []
  let specBugs = []
  if (disposition === 'open') {
    const findings = Array.from({ length: n }, (_, i) => lensFinding(`open claim ${i}`, `o${i}.js:${i + 1}`))
    open = findings.map((f) => ({ lens: 'lens-security', location: f.location, claim: f.claim, severity: 'High', ac_id: null, recurrence: null }))
    over = withFindings(findings)
  } else {
    const list = Array.from({ length: n }, (_, i) => mk(disposition, i))
    if (disposition === 'rejected') rejected = list
    else specBugs = list
    over = { synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: specBugs, rejected_findings: rejected, fixed_findings: [] } }
  }
  const target = { open, rejected, spec_bug: specBugs }[disposition][n - 1]
  const prior = withId({ lens: target.lens, location: target.location, claim: target.claim, severity: target.severity, ac_id: null })
  const fixed = [confirm(prior)]
  const synthesis = { report: '### VERDICT\nFINDINGS', spec_bugs: specBugs, rejected_findings: rejected, fixed_findings: fixed }
  return {
    prior,
    args: { spec: 'specs/example.md', round: 2, prior_findings: [prior] },
    over: { ...over, synthesis },
    descriptors: { spec_bugs: specBugs, rejected_findings: rejected, open_findings: open, prior_findings: [prior], fixed_findings: fixed },
  }
}
for (const disposition of ['open', 'rejected', 'spec_bug']) {
  test(`A (round 3): a fixed claim overlapping the 61st ${disposition} finding records no fixed entry, counts one invalid_fixed_ids_dropped and the same findings_truncated as the 06049e4 writer`, async () => {
    const c = overlapCase(disposition)
    const g = await goldenAgainstOld(c)
    assert.ok(!g.newRow.findings.some((f) => f.disposition === 'fixed'), 'the still-open finding was recorded fixed')
    assert.equal(g.newRow.invalid_fixed_ids_dropped, 1)
    assert.equal(g.oldRow.invalid_fixed_ids_dropped, 1, 'reference: the 06049e4 writer drops the claim')
    assert.ok(g.newRow.findings_truncated > 0, 'a 61-entry disposition must be truncated by the writer')
    assert.equal(g.newRow.findings_truncated, g.oldRow.findings_truncated)
    sameRow(g)
  })
}

test('A: golden row against the 06049e4 writer with every disposition above MAX_FINDINGS, duplicate and unmatched fixed claims included', async () => {
  const g = await goldenAgainstOld(overCap)
  sameRow(g)
  assert.equal(g.newRow.duplicate_fixed_ids_dropped, 30)
  assert.equal(g.newRow.invalid_fixed_ids_dropped, 5)
})

test('A (round 3): the spec\'s Problem-section payload paragraph scopes the ceiling to rounds with at most MAX_FINDINGS entries per disposition and says larger rounds are unbounded by owner decision', () => {
  const spec = fs.readFileSync(SPEC, 'utf8')
  const start = spec.indexOf('\n## Problem')
  const problem = spec.slice(start, spec.indexOf('\n## ', start + 1))
  const para = /\bPayload size\b[\s\S]*/.exec(problem)
  assert.ok(para, 'no "Payload size" paragraph in Problem')
  const text = para[0].replace(/\s+/g, ' ')
  assert.doesNotMatch(text, /five dispositions/i, 'the paragraph still describes all five dispositions as capped')
  assert.doesNotMatch(text, /script caps/i, 'the paragraph still says the script caps the written dispositions')
  assert.match(text, /at most MAX_FINDINGS entries (in|per) (each|every)/i, 'the paragraph must scope the ceiling to rounds with at most MAX_FINDINGS entries per disposition')
  assert.match(text, /unbounded/i, 'the paragraph must say plainly that larger rounds are unbounded')
  assert.match(text, /owner/i, 'the paragraph must attribute the unbounded case to the owner decision')
})

// =====================================================================================================================
// Item B: the payload size ceiling comes from the largest payload of CONFORMING values, and the spec records the numbers.
// =====================================================================================================================
const LONGEST_LENS = 'reviewer-verification' // the longest name in the review roster
// PAYLOAD_AC_ID_RE / AC_ID_PATTERN_STR: a prefix of up to 40 characters, one separator, AC-, up to 16 upper-case or digit characters, '-', six digits.
const LONGEST_AC = `${'p'.repeat(40)} AC-${'A'.repeat(16)}-999999`
// The scope and lens schemas accept 7 to 40 hexadecimal characters for a commit, so 40 is the longest a real run can carry.
const SHA40 = 'f'.repeat(40)
const SCOPE_SHA40 = 'a'.repeat(40)
const LONG_SPEC = `specs/${'x'.repeat(480)}.md` // under the writer's 500-byte bound on spec

function bytesOf(calls) {
  return Buffer.byteLength(extractEncodedPayload(calls.filter((c) => c.opts.label === 'ledger:write').pop().prompt))
}
async function largestPayload() {
  const { MAX_FINDINGS, MAX_AC_VERDICTS } = await import(WRITER_URL)
  const descriptor = (tag, i) => ({ lens: LONGEST_LENS, location: `${tag}${i}.js:${i + 1}`, claim: `${tag} claim ${i}`, severity: 'Critical', ac_id: LONGEST_AC })
  const priors = Array.from({ length: MAX_FINDINGS }, (_, i) => withId(descriptor('p', i)))
  // 60 open findings spread over all nine lenses, 52 of them from the lens with the longest name; every lens says FINDINGS.
  const perLens = Object.fromEntries(ALL_LENSES.map((l) => [l, []]))
  for (let i = 0; i < MAX_FINDINGS; i++) perLens[i < 8 ? ALL_LENSES[i] : LONGEST_LENS].push(lensFinding(`open claim ${i}`, `o${i}.js:${i + 1}`, { severity: 'Critical', ac_id: LONGEST_AC }))
  const acVerdicts = Array.from({ length: MAX_AC_VERDICTS }, (_, i) => ({ id: LONGEST_AC, verdict: 'UNVERIFIABLE', evidence: `e${i}` }))
  const lensResponses = Object.fromEntries(ALL_LENSES.map((l, n) => [l, {
    __bypassSchemaValidation: true, verdict: 'FINDINGS', coverage: COVERAGE, findings: perLens[l],
    head_sha_measured: SHA40, head_tree_measured: SCOPE_OK.head_tree,
    ac_verdicts: acVerdicts.filter((_, i) => i % ALL_LENSES.length === n),
  }]))
  const out = await review({ spec: LONG_SPEC, round: 9999, lenses: ALL_LENSES, prior_findings: priors }, {
    'scope:diff': { ...SCOPE_OK, head_sha: SCOPE_SHA40 },
    ...lensResponses,
    synthesis: {
      report: '### VERDICT\nFINDINGS',
      spec_bugs: Array.from({ length: MAX_FINDINGS }, (_, i) => descriptor('s', i)),
      rejected_findings: Array.from({ length: MAX_FINDINGS }, (_, i) => descriptor('r', i)),
      fixed_findings: priors.map(confirm),
    },
  })
  return { ...out, MAX_FINDINGS, MAX_AC_VERDICTS, bytes: bytesOf(out.calls) }
}
async function typicalPayload() {
  const { calls } = await review({ spec: 'specs/example.md' }, withFindings([
    lensFinding('Missing authorisation check on the export route', 'src/export.js:42', { ac_id: 'AC-SEC-1' }),
    lensFinding('Unbounded read of the request body', 'src/upload.js:17'),
    lensFinding('Error message names the database host', 'src/db.js:9', { severity: 'Medium' }),
  ]))
  return bytesOf(calls)
}
const paragraphHasBytes = (text, n) => new RegExp(`(?<![0-9,])${n.toLocaleString('en-US')}\\s*bytes`).test(text)
const payloadParagraph = () => {
  const spec = fs.readFileSync(SPEC, 'utf8')
  const start = spec.indexOf('\n## Problem')
  return /\bPayload size\b[\s\S]*/.exec(spec.slice(start, spec.indexOf('\n## ', start + 1)))[0]
}

test('B: the largest-payload fixture is a payload of conforming values at every bound, and it reaches the writer\'s own limits', async () => {
  const big = await largestPayload()
  assert.ok(big.result && big.terminal, 'the fixture run must reach a terminal write')
  const by = (d) => big.terminal.finding_entries.filter((e) => e.disposition === d)
  for (const d of ['open', 'rejected', 'spec_bug', 'prior', 'fixed']) assert.equal(by(d).length, big.MAX_FINDINGS, `${d}: expected MAX_FINDINGS entries, got ${by(d).length}`)
  assert.equal(big.terminal.ac_verdicts.length, big.MAX_AC_VERDICTS)
  assert.deepEqual(Object.keys(big.terminal.verdicts).sort(), [...ALL_LENSES].sort(), 'the verdict map must carry every roster lens (lenses_run: ' + JSON.stringify(big.terminal.lenses_run) + ')')
  assert.ok(Object.values(big.terminal.verdicts).every((v) => v === 'FINDINGS'))
  assert.ok(by('spec_bug').every((e) => e.lens === LONGEST_LENS && e.ac_id === LONGEST_AC && e.severity === 'Critical'), 'written entries must use the longest accepted values')
  assert.match(big.terminal.round_key, /^[0-9a-f]{40}$/)
  assert.ok(Object.values(big.terminal.lens_checkout_drift).length === ALL_LENSES.length && Object.values(big.terminal.lens_checkout_drift).every((v) => /^[0-9a-f]{40}$/.test(v)), `drift: ${JSON.stringify(big.terminal.lens_checkout_drift)}`)
  const { AC_ID_PATTERN_STR, LENS_PATTERN_STR } = await import(WRITER_URL)
  assert.match(LONGEST_AC, new RegExp(AC_ID_PATTERN_STR), 'the fixture\'s AC id must be one the writer accepts')
  assert.match(LONGEST_LENS, new RegExp(LENS_PATTERN_STR))
})

test('B: for a round with at most MAX_FINDINGS entries per disposition, the largest conforming payload stays under the ceiling recorded in the spec, the ceiling is derived from it (not more than 30% above), and the paragraph records the measured sizes', async () => {
  const big = await largestPayload()
  const typical = await typicalPayload()
  const para = payloadParagraph()
  const m = /ceiling[^0-9\n]*([0-9][0-9,]*)\s*bytes/i.exec(para)
  assert.ok(m, 'no ceiling recorded in the spec')
  const ceiling = Number(m[1].replace(/,/g, ''))
  assert.ok(big.bytes < ceiling, `the largest conforming payload is ${big.bytes} base64 bytes, over the spec's ceiling of ${ceiling}`)
  assert.ok(ceiling <= big.bytes * 1.3, `the ceiling ${ceiling} is more than 30% above the measured largest payload (${big.bytes} bytes), so it is not derived from it`)
  assert.ok(paragraphHasBytes(para, big.bytes), `the Payload size paragraph does not record the measured largest payload: ${big.bytes.toLocaleString('en-US')} bytes (fixture: test/harn-opt-6-r2.test.js largestPayload)`)
  assert.ok(paragraphHasBytes(para, typical), `the Payload size paragraph does not record the measured typical payload: ${typical.toLocaleString('en-US')} bytes (fixture: test/harn-opt-6-r2.test.js typicalPayload)`)
})

test('B: no comment in review-cycle.js still quotes the old 40,000-byte ceiling', () => {
  const src = fs.readFileSync(WF, 'utf8')
  assert.ok(!/40,000/.test(src), 'a comment still says 40,000')
  assert.ok(!/40000/.test(src))
})

// =====================================================================================================================
// Item C: one counting site for a neutralised ac_verdict.
// =====================================================================================================================
test('C: a MAYBE verdict and a null ac_id are counted once: the row, the AC-OPS-6 log line and the 06049e4 writer agree', async () => {
  const g = await goldenAgainstOld({
    args: { spec: 'specs/example.md' },
    over: { 'lens-qa': { ...CLEAN, __bypassSchemaValidation: true, ac_verdicts: [{ id: 'AC-QA-1', verdict: 'MAYBE', evidence: 'e' }, { id: null, verdict: 'PASS', evidence: 'e' }, { id: 'AC-QA-2', verdict: 'PASS', evidence: 'e' }] } },
    descriptors: {
      spec_bugs: [], rejected_findings: [], open_findings: [],
      ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'MAYBE' }, { ac_id: null, verdict: 'PASS' }, { ac_id: 'AC-QA-2', verdict: 'PASS' }],
    },
  })
  const line = g.logs.find((l) => /_dropped=/.test(l))
  assert.ok(line, 'the AC-OPS-6 line must be logged')
  const logged = (name) => Number((new RegExp(`${name}=([0-9]+)`).exec(line) || [])[1] || 0)
  assert.equal(g.oldRow.invalid_record_values_dropped, 1, 'reference: the 06049e4 writer counts the MAYBE once')
  assert.equal(g.oldRow.invalid_ac_ids_dropped, 1, 'reference: the 06049e4 writer counts the null ac_id once')
  assert.equal(g.newRow.invalid_record_values_dropped, g.oldRow.invalid_record_values_dropped, 'invalid_record_values_dropped on the row')
  assert.equal(g.newRow.invalid_ac_ids_dropped, g.oldRow.invalid_ac_ids_dropped, 'invalid_ac_ids_dropped on the row')
  assert.equal(logged('invalid_record_values_dropped'), g.newRow.invalid_record_values_dropped, 'the log line and the row must report the same record-value count')
  assert.equal(logged('invalid_ac_ids_dropped'), g.newRow.invalid_ac_ids_dropped, 'the log line and the row must report the same ac_id count')
  sameRow(g)
})

// =====================================================================================================================
// Item D: the script's closed value shapes are tied to the writer's. The check must fail when either side changes alone.
// =====================================================================================================================
const SHAPES_FILE = path.join(fs.mkdtempSync(path.join(SUITE_TMPDIR, 'shapes-')), 'shapes.js')
async function shapesOf(source) {
  const start = source.indexOf('const PAYLOAD_LENS_RE')
  const end = source.indexOf('const PAYLOAD_RUN_ID_RE')
  assert.ok(start >= 0 && end > start, 'could not locate the PAYLOAD_* shapes in review-cycle.js')
  fs.writeFileSync(SHAPES_FILE, `${source.slice(start, end)}\nreturn { lensRe: PAYLOAD_LENS_RE.source, acRe: PAYLOAD_AC_ID_RE.source, roster: PAYLOAD_ROSTER_LENSES, severities: PAYLOAD_SEVERITIES, verdicts: PAYLOAD_VERDICTS, lensVerdicts: PAYLOAD_LENS_VERDICTS }\n`)
  return (await runWorkflow(SHAPES_FILE, { args: {}, agent: {} })).result
}
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
// The roster is held by the script alone now (the writer no longer resolves compound labels), so its reference is the set
// the writer exported at 06049e4, which mirrored the files in agents/.
function tieProblems(shapes, writer, rosterReference) {
  const props = writer.LEDGER_ENTRY_SCHEMA.properties
  const problems = []
  if (shapes.lensRe !== writer.LENS_PATTERN_STR) problems.push('PAYLOAD_LENS_RE differs from LENS_PATTERN_STR')
  if (shapes.acRe !== writer.AC_ID_PATTERN_STR) problems.push('PAYLOAD_AC_ID_RE differs from AC_ID_PATTERN_STR')
  if (!sameSet(shapes.severities, props.findings.items.properties.severity.enum)) problems.push('PAYLOAD_SEVERITIES differs from the findings severity enum')
  if (!sameSet(shapes.verdicts, props.ac_verdicts.items.properties.verdict.enum)) problems.push('PAYLOAD_VERDICTS differs from the ac_verdicts verdict enum')
  if (!sameSet(shapes.lensVerdicts, props.verdicts.additionalProperties.enum)) problems.push('PAYLOAD_LENS_VERDICTS differs from the verdicts enum')
  if (!sameSet(shapes.roster, rosterReference)) problems.push('PAYLOAD_ROSTER_LENSES differs from the roster')
  return problems
}
const SCRIPT_SOURCE = fs.readFileSync(WF, 'utf8')
async function realTie() {
  const writer = await import(WRITER_URL)
  const oldWriter = await import(pathToFileURL(OLD_WRITER).href)
  return { writer, oldWriter, shapes: await shapesOf(SCRIPT_SOURCE) }
}

test('D: the script\'s PAYLOAD_* shapes equal the writer\'s patterns and enums, and the roster equals the one the writer held at 06049e4', async () => {
  const { writer, oldWriter, shapes } = await realTie()
  assert.deepEqual(tieProblems(shapes, writer, oldWriter.ROSTER_LENSES), [])
})

for (const [name, from, to] of [
  ['the lens pattern', '/^(lens|reviewer)-[a-z]+$/', '/^(lens|reviewer)-[a-z0-9]+$/'],
  ['the AC id pattern', '{1,6})$/', '{1,7})$/'],
  ['the severities', "const PAYLOAD_SEVERITIES = ['Critical', 'High', 'Medium', 'Low']", "const PAYLOAD_SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Urgent']"],
  ['the ac_verdict verdicts', "const PAYLOAD_VERDICTS = ['PASS', 'FAIL', 'UNVERIFIABLE']", "const PAYLOAD_VERDICTS = ['PASS', 'FAIL']"],
  ['the lens verdicts', "const PAYLOAD_LENS_VERDICTS = ['CLEAN', 'FINDINGS', 'BLOCKED']", "const PAYLOAD_LENS_VERDICTS = ['CLEAN', 'FINDINGS']"],
  ['the roster', "'reviewer-verification', 'reviewer-experience',", "'reviewer-verification',"],
]) {
  test(`D: changing ${name} in the script alone is caught`, async () => {
    assert.ok(SCRIPT_SOURCE.includes(from), `the mutation target for ${name} is not in review-cycle.js, so this proof would be vacuous`)
    const { writer, oldWriter, shapes } = await realTie()
    const mutated = await shapesOf(SCRIPT_SOURCE.replace(from, to))
    assert.notDeepEqual(mutated, shapes, `the mutation of ${name} did not change the shapes the script defines (it landed somewhere else)`)
    assert.notDeepEqual(tieProblems(mutated, writer, oldWriter.ROSTER_LENSES), [], `a change to ${name} on the script side went unnoticed`)
  })
}

test('D: changing the writer\'s patterns or enums alone is caught', async () => {
  const { writer, oldWriter, shapes } = await realTie()
  const problems = (patch) => {
    const schema = structuredClone(writer.LEDGER_ENTRY_SCHEMA)
    const patched = { ...writer, LEDGER_ENTRY_SCHEMA: schema, ...patch(schema) }
    return tieProblems(shapes, patched, oldWriter.ROSTER_LENSES)
  }
  assert.notDeepEqual(problems(() => ({ LENS_PATTERN_STR: '^(lens|reviewer)-[a-z0-9]+$' })), [])
  assert.notDeepEqual(problems(() => ({ AC_ID_PATTERN_STR: writer.AC_ID_PATTERN_STR.replace('{1,6}', '{1,7}') })), [])
  assert.notDeepEqual(problems((s) => { s.properties.findings.items.properties.severity.enum.push('Urgent'); return {} }), [])
  assert.notDeepEqual(problems((s) => { s.properties.ac_verdicts.items.properties.verdict.enum.push('SKIPPED'); return {} }), [])
  assert.notDeepEqual(problems((s) => { s.properties.verdicts.additionalProperties.enum.push('ABORTED'); return {} }), [])
})

// =====================================================================================================================
// Item E: a legacy descriptor payload leaves a marker on the row.
// =====================================================================================================================
// The legacy_payload behaviour test lives in the single transition-only test in test/harn-opt-6-t1.test.js (fix round 3, item G).
test('E: legacy_payload is an optional boolean in the writer schema', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(WRITER_URL)
  const prop = LEDGER_ENTRY_SCHEMA.properties.legacy_payload
  assert.ok(prop, 'legacy_payload is not in LEDGER_ENTRY_SCHEMA.properties')
  assert.ok([].concat(prop.type).includes('boolean'), `legacy_payload must be a boolean, got ${JSON.stringify(prop.type)}`)
  assert.ok(!(LEDGER_ENTRY_SCHEMA.required || []).includes('legacy_payload'), 'legacy_payload must be optional')
  const src = fs.readFileSync(WRITER_FILE, 'utf8')
  const at = src.indexOf('legacy_payload:')
  assert.ok(at > 0 && /\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*legacy_payload:/.test(src.slice(Math.max(0, at - 1200), at + 20)), 'legacy_payload must carry a comment in the schema')
})

// =====================================================================================================================
// Item F: the roster check and the 256-character bound apply to labels that already match ^(lens|reviewer)-[a-z]+$.
// =====================================================================================================================
test('F: a label shaped like a lens but not on the roster, or enormous, reaches the payload as null and is counted; roster labels pass; priors resolve the same way, uncounted', async () => {
  const huge = `lens-${'a'.repeat(5000)}`
  const rejected = [
    { lens: 'lens-madeup', location: 'a.js:1', claim: 'c1', severity: 'High' },
    { lens: huge, location: 'a.js:2', claim: 'c2', severity: 'High' },
    { lens: 'reviewer-verification', location: 'a.js:3', claim: 'c3', severity: 'High' },
  ]
  const oddPrior = withId({ lens: 'lens-madeup', location: 'p.js:1', claim: 'prior', severity: 'High', ac_id: null })
  const { terminal, payloads } = await review({ spec: 'specs/example.md', round: 2, prior_findings: [oddPrior] }, {
    synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: rejected },
  })
  const text = JSON.stringify(payloads)
  assert.ok(!text.includes('madeup') && !text.includes('aaaaaaaaaaaaaaaa'), 'an off-roster lens label reached a payload')
  const byId = new Map(terminal.finding_entries.map((e) => [e.id, e]))
  assert.equal(byId.get(oracleId(rejected[0].lens, 'a.js:1', 'c1')).lens, null)
  assert.equal(byId.get(oracleId(huge, 'a.js:2', 'c2')).lens, null, 'the id still comes from the original label')
  assert.equal(byId.get(oracleId('reviewer-verification', 'a.js:3', 'c3')).lens, 'reviewer-verification')
  assert.equal(byId.get(oddPrior.id).lens, null)
  assert.equal(terminal.invalid_finding_fields_dropped, 2, 'the two rejected findings with unusable labels are counted; the prior is not')
})

// =====================================================================================================================
// Item G: round reaches both payloads only as a positive integer.
// =====================================================================================================================
test('G: a round that is not a positive integer is dropped from both payloads and counted once; a valid round is kept and not counted', async () => {
  for (const bad of [0, -1, 1.5, '2', NaN, Infinity, true, {}, [], 'x $(id) `y`']) {
    const { payloads, terminal } = await review({ round: bad }, {})
    for (const p of payloads) assert.ok(!('round' in p), `round ${String(bad)} reached a ${p.outcome} payload as ${JSON.stringify(p.round)}`)
    assert.equal(terminal.invalid_record_values_dropped, 1, `round ${String(bad)} must be counted once`)
  }
  for (const good of [1, 2, 37]) {
    const { payloads, terminal } = await review({ round: good }, {})
    for (const p of payloads) assert.equal(p.round, good)
    assert.equal(terminal.invalid_record_values_dropped, 0)
  }
  const { payloads, terminal } = await review({}, {})
  assert.ok(payloads.every((p) => !('round' in p)), 'an absent round stays absent')
  assert.equal(terminal.invalid_record_values_dropped, 0)
})

test('G: through the real writer a bad round lands as null with the count of one, as it does at 06049e4', async () => {
  const newRepo = makeTempRepo()
  await review({ round: 0 }, { 'ledger:write': newWriter(newRepo) })
  const oldRepo = makeTempRepo()
  await review({ round: 0 }, { 'ledger:write': oldWriterAgent(oldRepo) }, OLD_WF)
  const row = terminalRows(newRepo).pop()
  assert.equal(row.round, null)
  assert.equal(row.invalid_record_values_dropped, 1)
  assert.deepEqual(normalise(row), normalise(terminalRows(oldRepo).pop()))
})

// =====================================================================================================================
// Item J: "fixed_findings was supplied" is an explicit boolean, not a counter baseline.
// =====================================================================================================================
test('J: the payload says fixed_findings was supplied with an explicit boolean and carries no fixed-reconciliation counter baselines', async () => {
  const prior = withId({ lens: 'lens-qa', location: 'x.js:1', claim: 'was open', severity: 'High', ac_id: null })
  const supplied = await review({ round: 2, prior_findings: [prior] }, { synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [] } })
  assert.equal(supplied.terminal.fixed_findings_supplied, true)
  const absent = await review({ round: 2, prior_findings: [prior] }, {})
  assert.notEqual(absent.terminal.fixed_findings_supplied, true)
  for (const t of [supplied.terminal, absent.terminal]) {
    assert.ok(!('invalid_fixed_ids_dropped' in t), 'a counter baseline is still being used as the supplied signal')
    assert.ok(!('duplicate_fixed_ids_dropped' in t), 'a counter baseline is still being used as the supplied signal')
  }
})

test('J: the writer reports 0 and 0 for fixed reconciliation only when the flag is set, and the flag never reaches the row', async () => {
  const prior = withId({ lens: 'lens-qa', location: 'x.js:1', claim: 'was open', severity: 'High', ac_id: null })
  const { terminal } = await review({ round: 2, prior_findings: [prior] }, { synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [] } })
  const land = (payload) => { const repo = makeTempRepo(); const out = lastJson(runAppend(repo, payload).stdout); assert.equal(out.write_ok, true, out.write_error); return terminalRows(repo).pop() }
  const withFlag = land(terminal)
  assert.equal(withFlag.invalid_fixed_ids_dropped, 0)
  assert.equal(withFlag.duplicate_fixed_ids_dropped, 0)
  assert.ok(!('fixed_findings_supplied' in withFlag), 'the flag is a payload signal, not a row field')
  const { fixed_findings_supplied, ...without } = terminal
  const noFlag = land(without)
  assert.ok(noFlag.invalid_fixed_ids_dropped == null && noFlag.duplicate_fixed_ids_dropped == null, `without the flag the counts must be null, got ${noFlag.invalid_fixed_ids_dropped}/${noFlag.duplicate_fixed_ids_dropped}`)
})

test('J: golden rows against the 06049e4 writer for fixed_findings supplied empty and not supplied', async () => {
  const prior = withId({ lens: 'lens-qa', location: 'x.js:1', claim: 'was open', severity: 'High', ac_id: null })
  const empty = await goldenAgainstOld({
    args: { round: 2, prior_findings: [prior] },
    over: { synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [] } },
    descriptors: { spec_bugs: null, rejected_findings: [], open_findings: [], prior_findings: [prior], fixed_findings: [] },
  })
  sameRow(empty)
  const none = await goldenAgainstOld({
    args: { round: 2, prior_findings: [prior] }, over: {},
    descriptors: { spec_bugs: null, rejected_findings: [], open_findings: [], prior_findings: [prior] },
  })
  sameRow(none)
})

// =====================================================================================================================
// Item K: no schema comment in the writer still describes hashing or prior-id recomputation as happening there.
// =====================================================================================================================
test('K: ledger-append.mjs names no findingId function and its schema comments describe no hashing or recomputation', () => {
  const src = fs.readFileSync(WRITER_FILE, 'utf8')
  const stale = src.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /findingId/.test(line))
  assert.deepEqual(stale, [], 'comments still name findingId, which the writer no longer defines')
  const from = src.indexOf('export const LEDGER_ENTRY_SCHEMA')
  const to = src.indexOf('\n}\n', from)
  assert.ok(from > 0 && to > from, 'could not locate LEDGER_ENTRY_SCHEMA')
  const schemaBlock = src.slice(from, to).split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /\/\//.test(line) && /\bhash|recomput/i.test(line))
  assert.deepEqual(schemaBlock, [], 'a schema comment still describes hashing or recomputation in the writer')
})

// =====================================================================================================================
// Fix round 3 (review round 3, wf_a4f9657b-eb9). Items A (above), B (test/harn-opt-6-gap.test.js), C (gap), E
// (test/review-cycle-finding-ids.test.js), G (test/harn-opt-6-t1.test.js and test/static-checks.test.js) and H
// (test/harn-opt-6-r2-env.test.js) live elsewhere. As above, no assertion leans on a lens the default scope does not run
// unless the run passes `lenses` or a spec.
// =====================================================================================================================

// ---- Item D: lenses_run, lenses_skipped and verdicts keys pass the same closed-set lens check as finding lenses ----
test('D (round 3): a lens name outside the roster never reaches lenses_run, lenses_skipped or the verdicts keys; it is dropped and counted; roster lenses are kept', async () => {
  const hostile = '/home/canary-user/secret $(id) `x`'
  const plainRun = await review({}, {})
  const { payloads, terminal, logs } = await review({ lenses: [hostile, 'lens-madeup', 'reviewer-verification'] }, { [hostile]: CLEAN, 'lens-madeup': CLEAN })
  const text = JSON.stringify(payloads)
  assert.ok(!text.includes('canary-user') && !text.includes('madeup'), 'a non-roster lens name reached a payload')
  assert.deepEqual(terminal.lenses_run, ['lens-security', 'lens-qa', 'reviewer-verification'], 'roster lenses stay, in order; non-members are dropped')
  assert.deepEqual(Object.keys(terminal.verdicts), ['lens-security', 'lens-qa', 'reviewer-verification'])
  assert.ok(terminal.lenses_skipped.every((l) => ALL_LENSES.includes(l)), `lenses_skipped carries a non-roster name: ${JSON.stringify(terminal.lenses_skipped)}`)
  const dropped = (t) => t.invalid_finding_fields_dropped + t.invalid_record_values_dropped
  assert.ok(dropped(terminal) - dropped(plainRun.terminal) >= 2, `the two non-members must be counted (counters ${dropped(terminal)} against ${dropped(plainRun.terminal)} for a plain run)`)
  assert.ok(logs.some((l) => /_dropped=/.test(l)), 'the drop must be named on the AC-OPS-6 line')
})

test('D (round 3): through the real writer a row built from a run with a non-roster lens carries no trace of it', async () => {
  const hostile = '/home/canary-user/secret'
  const repo = makeTempRepo()
  await review({ lenses: [hostile] }, { [hostile]: CLEAN, 'ledger:write': newWriter(repo) })
  const row = terminalRows(repo).pop()
  assert.ok(row, 'the terminal row must land')
  assert.ok(!JSON.stringify(row).includes('canary-user'))
  assert.deepEqual(row.lenses_run, ['lens-security', 'lens-qa'])
})

// ---- Item F: the review-cycle log names a legacy_payload result when the writer reports one; the pinned response schema cannot carry it ----
test('F (round 3): review-cycle.js records in a code comment that the pinned writeLedger response schema cannot carry legacy_payload, so the script cannot log it', () => {
  const lines = fs.readFileSync(WF, 'utf8').split('\n')
  const hits = lines.map((l, i) => [i, l]).filter(([, l]) => /^\s*\/\/.*legacy_payload/.test(l))
  assert.ok(hits.length > 0, 'no code comment in review-cycle.js names legacy_payload')
  const blocks = hits.map(([i]) => {
    let a = i
    let b = i
    while (a > 0 && /^\s*\/\//.test(lines[a - 1])) a -= 1
    while (b < lines.length - 1 && /^\s*\/\//.test(lines[b + 1])) b += 1
    return lines.slice(a, b + 1).join(' ')
  })
  assert.ok(blocks.some((b) => /writeLedger/.test(b) && /pinned|byte-identical/i.test(b) && /cannot|can't|does not carry/i.test(b)), `no comment says the pinned writeLedger response cannot carry it: ${JSON.stringify(blocks)}`)
})

// ---- Item I: AC-DATA-3's two-round join, two priors one character apart ----
test('I (round 3): two priors one character apart, only the first confirmed in round two, record exactly the first id fixed, and the reader joins it under one lens', async () => {
  const repo = makeTempRepo()
  const claimA = 'unbounded read of the request body A'
  const claimB = 'unbounded read of the request body B'
  const r1 = await review({ spec: 'specs/example.md', round: 1 }, { ...withFindings([lensFinding(claimA, 'u.js:1'), lensFinding(claimB, 'u.js:1')]), 'ledger:write': newWriter(repo) })
  const prior = r1.result.open_findings
  assert.equal(prior.length, 2)
  assert.notEqual(prior[0].id, prior[1].id, 'one character apart must give two ids')
  const firstId = oracleId('lens-security', 'u.js:1', claimA)
  assert.equal(prior[0].id, firstId)
  await review({ spec: 'specs/example.md', round: 2, prior_findings: prior }, {
    ...withFindings([lensFinding(claimB, 'u.js:1')]),
    synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(prior[0])] },
    'ledger:write': newWriter(repo),
  })
  const rows = terminalRows(repo)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[1].findings.filter((f) => f.disposition === 'fixed').map((f) => f.id), [firstId])
  assert.equal(rows[1].invalid_fixed_ids_dropped, 0)
  const mod = await import(pathToFileURL(path.join(ROOT, 'workflows', 'lib', 'optimise-read.mjs')).href)
  const rework = mod.aggregateRework(rows.map((r) => ({ ...r, repo: 'demo' })))
  assert.equal(rework.lensDispositionCounts['lens-security']?.fixed, 1, 'exactly one fixed, for the first id only')
})

// ---- Item J: a start run_id that fails PAYLOAD_RUN_ID_RE is counted and logged ----
const START_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
test('J (round 3): a start run_id that is not UUID-shaped is counted once under invalid_record_values_dropped and logged as one that will not pair with its start row; a UUID-shaped one is neither', async () => {
  for (const odd of ['r1', 'not-a-uuid', START_UUID.toUpperCase().slice(0, -1), `${START_UUID}-x`]) {
    const { terminal, logs } = await review({}, { 'ledger:write': [{ ...LEDGER_OK, run_id: odd }, LEDGER_OK] })
    assert.ok(!('run_id' in terminal), `${odd} must not be reused`)
    assert.equal(terminal.invalid_record_values_dropped, 1, `${odd} must be counted once`)
    const dropLines = logs.filter((l) => /_dropped=/.test(l))
    assert.equal(dropLines.length, 1, `exactly one drop line expected, got ${JSON.stringify(dropLines)}`)
    assert.match(dropLines[0], /invalid_record_values_dropped=1/)
    assert.ok(logs.some((l) => /run_id/.test(l) && /will not pair/i.test(l)), `no log says the terminal row will not pair with its start row for ${odd}: ${JSON.stringify(logs)}`)
  }
  const good = await review({}, { 'ledger:write': [{ ...LEDGER_OK, run_id: START_UUID }, LEDGER_OK] })
  assert.equal(good.terminal.run_id, START_UUID)
  assert.equal(good.terminal.invalid_record_values_dropped, 0)
  assert.ok(!good.logs.some((l) => /will not pair/i.test(l)))
})

test('J (round 3): a failed start write (no run_id at all) is not counted as a malformed one', async () => {
  const failedStart = { run_id: null, ts: null, write_ok: false, write_error: 'safety classifier stopped the write' }
  const { terminal, logs } = await review({}, { 'ledger:write': [failedStart, LEDGER_OK] })
  assert.equal(terminal.invalid_record_values_dropped, 0)
  assert.ok(!logs.some((l) => /will not pair/i.test(l)))
})
