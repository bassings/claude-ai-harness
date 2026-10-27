// HARN-OPT-6 T1 simplify-and-finish pass after review round 4 (owner decision 2026-10-28; specs/harn-opt-6.md, the amendments
// to AC-OPS-6 and AC-ARCH-11). Items 1 to 4 of that pass live here; the two tests that pinned the old AC-OPS-6 line were
// replaced in test/harn-opt-6-gap.test.js.
//
// A run of review() with no spec and the default scope triggers ONLY lens-security and lens-qa, so no assertion below leans
// on a verdict or finding from any other lens.
//
// Names this file pins because the spec leaves them open:
//   field_drops, ac_id_drops   the two small non-negative integers review-cycle.js attaches to each verified 'prior'
//                              finding entry (labels it neutralised: lens or severity; ac_id), which the writer adds to
//                              invalid_finding_fields_dropped / invalid_ac_ids_dropped once per prior it records fixed
//   fixed_confirmations_sent   the name on the AC-OPS-6 log line for how many fixed confirmations the script sent
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

test.after(cleanupTempRepos)

const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').pop())
const newWriter = (repo) => (prompt) => lastJson(runAppend(repo, extractLedgerPayload(prompt)).stdout)

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


const ledgerFail = [LEDGER_OK, { run_id: LEDGER_OK.run_id, ts: LEDGER_OK.ts, write_ok: false, write_error: 'disk full' }]
const stripComments = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, '')).join('\n')

// =====================================================================================================================
// Item 1 (M2, AC-ARCH-8): the writer is the single owner of the fixed-claim rule.
// =====================================================================================================================
// A prior whose lens, severity and ac_id are all non-conforming: the id is computed from the original (unresolved) label.
const ODD = { lens: 'not a real lens', location: 'odd.js:1', claim: 'odd prior', severity: 'Catastrophic', ac_id: 'free text' }
const GOOD = { lens: 'lens-security', location: 'good.js:2', claim: 'good prior', severity: 'High', ac_id: 'AC-SEC-1' }

test('1: each verified prior entry carries the number of its labels the script neutralised (field_drops, ac_id_drops), and a confirmation of it no longer moves the payload counters', async () => {
  const { terminal } = await review({ round: 2, prior_findings: [withId(ODD), withId(GOOD)] }, {
    synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(ODD), confirm(GOOD)] },
  })
  const prior = (p) => terminal.finding_entries.find((e) => e.disposition === 'prior' && e.id === withId(p).id)
  assert.equal(prior(ODD).field_drops, 2, 'the unknown lens and the non-enum severity')
  assert.equal(prior(ODD).ac_id_drops, 1, 'the free-text ac_id')
  assert.equal(prior(GOOD).field_drops, 0)
  assert.equal(prior(GOOD).ac_id_drops, 0)
  assert.equal(terminal.invalid_finding_fields_dropped, 0, 'the script no longer decides which confirmations are valid, so it cannot add the matched priors\' drops itself')
  assert.equal(terminal.invalid_ac_ids_dropped, 0)
})

test('1: the writer adds a prior\'s field_drops and ac_id_drops once per prior it records fixed, and not for an unconfirmed, duplicated, unmatched or still-open one', async () => {
  const { terminal } = await review({})
  const id = (tag) => oracleId('lens-security', `w${tag}.js:1`, `prior ${tag}`)
  const prior = (tag, field_drops, ac_id_drops) => ({ id: id(tag), lens: 'lens-security', severity: null, ac_id: null, disposition: 'prior', field_drops, ac_id_drops })
  const claim = (tag) => ({ id: id(tag), lens: 'lens-security', severity: null, ac_id: null, disposition: 'fixed' })
  const finding_entries = [
    prior('a', 2, 1), prior('b', 5, 5), prior('c', 0, 3), prior('d', 7, 7),
    claim('a'), claim('a'), // confirmed, then repeated: counted once
    claim('c'),             // confirmed
    claim('d'), { id: id('d'), lens: 'lens-security', severity: 'High', ac_id: null, disposition: 'open' }, // also open this round: invalid, not counted
    claim('z'),             // matches no prior: not counted
    // 'b' is never confirmed: not counted
  ]
  const landed = (entries) => {
    const repo = makeTempRepo()
    const out = lastJson(runAppend(repo, { ...terminal, finding_entries: entries, fixed_findings_supplied: true, invalid_finding_fields_dropped: 4, invalid_ac_ids_dropped: 6 }).stdout)
    assert.equal(out.write_ok, true, out.write_error)
    return terminalRows(repo).pop()
  }
  const withCounts = landed(finding_entries)
  const withoutCounts = landed(finding_entries.map(({ field_drops, ac_id_drops, ...e }) => e))
  assert.deepEqual(withCounts.findings.filter((f) => f.disposition === 'fixed').map((f) => f.id), [id('a'), id('c')], 'reference: a and c are the recorded fixed entries')
  assert.equal(withoutCounts.invalid_finding_fields_dropped, 4, 'control: with no per-prior integers the script\'s own count stands')
  assert.equal(withCounts.invalid_finding_fields_dropped - withoutCounts.invalid_finding_fields_dropped, 2, 'prior a (2) only; c has none, b, d and z are not recorded fixed')
  assert.equal(withCounts.invalid_ac_ids_dropped - withoutCounts.invalid_ac_ids_dropped, 4, 'prior a (1) and prior c (3), each once')
  for (const f of withCounts.findings) assert.ok(!('field_drops' in f) && !('ac_id_drops' in f), 'the integers never reach the row')
})

test('1: the AC-OPS-6 line says how many fixed confirmations were sent and points at the row for the writer\'s reconciliation counts', async () => {
  const keep = withId({ lens: 'lens-qa', location: 'k.js:1', claim: 'confirmed once and repeated' })
  const stillOpen = withId({ lens: 'lens-security', location: 'o.js:2', claim: 'confirmed but open again' })
  const { logs } = await review({ spec: 'specs/example.md', round: 2, prior_findings: [keep, stillOpen] }, {
    ...withFindings([lensFinding(stillOpen.claim, stillOpen.location)]),
    synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(keep), confirm(keep), confirm(stillOpen), { lens: 'lens-qa', location: 'never.js:1', claim: 'never open' }] },
  })
  const lines = logs.filter((l) => /fixed_confirmations_sent=/.test(l))
  assert.equal(lines.length, 1, `expected exactly one line naming fixed_confirmations_sent, got ${JSON.stringify(logs)}`)
  assert.match(lines[0], /\bfixed_confirmations_sent=4\b/)
  assert.match(lines[0], /invalid_fixed_ids_dropped/, 'it names where the writer\'s counts are')
  assert.match(lines[0], /duplicate_fixed_ids_dropped/)
  assert.match(lines[0], /\bon the row\b/)
  assert.ok(!logs.some((l) => /\b(invalid|duplicate)_fixed_ids_dropped=\d/.test(l)), `the script no longer computes the writer's two counts: ${JSON.stringify(logs)}`)
})

test('1: no fixed_confirmations_sent text when fixed_findings was not supplied or was supplied empty', async () => {
  const prior = withId(GOOD)
  const none = await review({ round: 2, prior_findings: [prior] }, {})
  assert.ok(!none.logs.some((l) => /fixed_confirmations_sent/.test(l)), JSON.stringify(none.logs))
  const empty = await review({ round: 2, prior_findings: [prior] }, { synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [] } })
  assert.ok(!empty.logs.some((l) => /fixed_confirmations_sent/.test(l)), JSON.stringify(empty.logs))
})

test('1: review-cycle.js holds no second implementation of the fixed-claim rule: no reconcileFixed, and no membership, same-round exclusion or duplicate counting over the fixed entries', () => {
  const code = stripComments(fs.readFileSync(WF, 'utf8'))
  assert.ok(!/reconcileFixed/.test(code), 'reconcileFixed is still defined or called')
  assert.ok(!/otherDispositionIds|sameRoundOtherDisposition/.test(code), 'a same-round exclusion set is still built')
  // The AC-OPS-6 pointer to the row names both counters by design; it is exempted the same way as the assertion below.
  const offending = code.replace('see invalid_fixed_ids_dropped and duplicate_fixed_ids_dropped', '').split('\n').filter((l) => /fixed/i.test(l) && /\.has\(|\.get\(|new Set\(|new Map\(|\bseen\b|duplicate/i.test(l))
  assert.deepEqual(offending, [], 'a line over the fixed entries tests membership, builds a set or counts duplicates')
  assert.ok(!/invalid_fixed_ids_dropped|duplicate_fixed_ids_dropped/.test(code.replace('see invalid_fixed_ids_dropped and duplicate_fixed_ids_dropped', '')), 'the script still names a count it no longer computes, outside the pointer to the row')
})

// =====================================================================================================================
// Item 2 (M1, AC-ARCH-11 as amended): open_findings is null, never [], when the run's outcome is not done.
// =====================================================================================================================
const PRIOR_FOR_NULL = withId(GOOD)
const SYNTH_FINDINGS = { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: [] }
const NOT_DONE = {
  'every lens failed': { over: { 'lens-security': () => undefined, 'lens-qa': () => undefined }, outcome: 'aborted' },
  'synthesis failed': { over: { ...withFindings([lensFinding('c', 'a.js:1')]), synthesis: () => undefined }, outcome: 'aborted' },
  'a lens BLOCKED': { over: { 'lens-security': { ...CLEAN, verdict: 'BLOCKED' }, 'lens-qa': { verdict: 'FINDINGS', coverage: COVERAGE, findings: [lensFinding('q', 'q.js:1')], ...TIP }, synthesis: SYNTH_FINDINGS }, outcome: 'blocked' },
}
for (const [name, { over, outcome }] of Object.entries(NOT_DONE)) {
  for (const [writeName, ledger] of [['succeeds', LEDGER_OK], ['fails', ledgerFail]]) {
    test(`2: ${name} and the terminal write ${writeName}: result.open_findings is null, never []`, async () => {
      const { result, terminal } = await review({ round: 2, prior_findings: [PRIOR_FOR_NULL] }, { ...over, 'ledger:write': ledger })
      assert.equal(terminal.outcome, outcome, 'the fixture must reach the intended outcome or this test pins nothing')
      assert.equal(result.open_findings, null)
    })
  }
}
for (const [writeName, ledger] of [['succeeds', LEDGER_OK], ['fails', ledgerFail]]) {
  test(`2: a completed round with the terminal write ${writeName} still returns open_findings as an array (AC-PROD-1), empty when nothing is open`, async () => {
    const found = await review({}, { ...withFindings([lensFinding('c', 'a.js:1')]), synthesis: SYNTH_FINDINGS, 'ledger:write': ledger })
    assert.equal(found.terminal.outcome, 'done')
    assert.deepEqual(found.result.open_findings.map((f) => f.id), [oracleId('lens-security', 'a.js:1', 'c')])
    const clean = await review({}, { 'ledger:write': ledger })
    assert.deepEqual(clean.result.open_findings, [])
  })
}
test('2: a run that threw reaches the caller as the original error and returns no open_findings to overwrite the stored priors', async () => {
  await assert.rejects(
    () => runWorkflow(WF, { args: { round: 2, prior_findings: [PRIOR_FOR_NULL] }, agent: agents({ 'scope:diff': () => { throw new Error('boom') } }) }),
    (err) => { assert.match(err.message, /boom/); assert.ok(!err.result); return true },
  )
})

// =====================================================================================================================
// Item 3 (M3): the legacy_descriptor_note comment must not claim the operator can see a note a pre-change workflow drops.
// =====================================================================================================================
test('3: the comment above legacy_descriptor_note says a pre-change workflow drops the note, and does not claim the operator sees it; the note itself is unchanged', () => {
  const lines = fs.readFileSync(WRITER_FILE, 'utf8').split('\n')
  const assign = lines.findIndex((l) => /extra\.legacy_descriptor_keys_dropped = /.test(l))
  assert.ok(assign > 0, 'cannot find the legacy_descriptor_note block')
  const open = lines.lastIndexOf(lines.slice(0, assign).reverse().find((l) => /if \(legacyKeysPresent\.length\) \{/.test(l)), assign)
  let start = open
  while (/^\s*\/\//.test(lines[start - 1] || '')) start -= 1
  const comment = lines.slice(start, open).join('\n')
  assert.ok(comment.trim().length > 0, 'the block has no comment')
  assert.ok(!/where the operator/i.test(comment), `the comment still claims the operator can see the note: ${comment}`)
  assert.match(comment, /\bdrop(s|ped)?\b/i, 'the comment must say the note is dropped')
  assert.match(comment, /pre-?change|predates|older/i, 'the comment must say by what: a workflow that predates this change')
  assert.ok(lines.join('\n').includes('Run bin/install.sh and restart the session.'), 'the note text is unchanged')
})

// =====================================================================================================================
// Item 4 (Low L5): a failed terminal write names the base64 payload size in bytes (the AC-QA-13 live tally).
// =====================================================================================================================
test('4: when the terminal ledger write fails, a log line names the base64 payload size in bytes; a landed write logs none', async () => {
  const failed = await review({}, { ...withFindings([lensFinding('c', 'a.js:1')]), synthesis: SYNTH_FINDINGS, 'ledger:write': ledgerFail })
  const terminalCall = failed.calls.filter((c) => c.opts.label === 'ledger:write').pop()
  const size = extractEncodedPayload(terminalCall.prompt).length
  assert.ok(size > 1000, 'the fixture payload is non-trivial')
  assert.ok(failed.logs.some((l) => /Ledger write failed/.test(l)), 'reference: the existing failure line is still logged')
  const line = failed.logs.find((l) => new RegExp(`\\b${size}\\b`).test(l) && /bytes/i.test(l))
  assert.ok(line, `no log line names ${size} bytes: ${JSON.stringify(failed.logs)}`)
  const ok = await review({}, { ...withFindings([lensFinding('c', 'a.js:1')]), synthesis: SYNTH_FINDINGS })
  assert.ok(!ok.logs.some((l) => /\bbytes\b/i.test(l) && /payload/i.test(l)), `a landed write must not log a payload size: ${JSON.stringify(ok.logs)}`)
})
