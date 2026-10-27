// HARN-OPT-6 T1 (specs/harn-opt-6.md): review-cycle ledger payloads carry finding ids, never finding text.
// The id oracle below is a test-side copy of ledger-append.mjs findingId as of commit 06049e4, using node:crypto, so
// the in-script sha256 in review-cycle.js is held to the ids the ledger already holds (AC-QA-2, AC-QA-3, AC-DATA-9).
// The name of the new top-level payload key is not fixed by the spec; this file pins it as FINDINGS_KEY, a name the
// pre-change writer does not accept (AC-ARCH-4), and the implementation must use that name.
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')
const { makeTempRepo, runAppend, readLedgerLines, cleanupTempRepos } = require('./helpers/temp-repo.js')

const WF = path.join(__dirname, '..', 'workflows', 'review-cycle.js')
const WRITER = path.join(__dirname, '..', 'workflows', 'lib', 'ledger-append.mjs')
const FINDINGS_KEY = 'finding_entries'
const LEGACY_KEYS = ['spec_bugs', 'rejected_findings', 'open_findings', 'prior_findings', 'fixed_findings']

test.after(cleanupTempRepos)

function oracleId(lens, location, claim) {
  return createHash('sha256').update(String(lens || '')).update(' ').update(String(location || '').trim().toLowerCase()).update(' ').update(String(claim || '')).digest('hex').slice(0, 16)
}

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
const CLAIMS = ['missing auth check', 'x\uD800y /home/canary-user/secret.txt $(id)']
const LOCATIONS = ['foo.js:10', '  FOO.js:İ ']

function agentWithTwoFindings(overrides = {}) {
  const findings = CLAIMS.map((claim, i) => ({ severity: 'High', claim, location: LOCATIONS[i], evidence: 'EVIDENCE-CANARY', consequence: 'c', fix: 'f' }))
  const lenses = ['lens-design', 'lens-accessibility', 'lens-product', 'lens-architecture', 'lens-data', 'lens-operability', 'reviewer-verification']
  return {
    'scope:diff': SCOPE_OK,
    'lens-security': { verdict: 'FINDINGS', coverage: COVERAGE, findings, ...TIP },
    'lens-qa': CLEAN,
    ...Object.fromEntries(lenses.map((l) => [l, CLEAN])),
    synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: [] },
    'ledger:write': LEDGER_OK,
    ...overrides,
  }
}

function terminalPayload(calls) {
  const payloads = calls.filter((c) => c.opts.label === 'ledger:write').map((c) => extractLedgerPayload(c.prompt))
  return payloads.filter((p) => p.outcome !== 'started').pop()
}

function keysAtAnyDepth(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysAtAnyDepth(v, out))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysAtAnyDepth(v, out) }
  return out
}

test('AC-SEC-1/AC-QA-2: the terminal payload carries ids only, and each id equals the node:crypto id for the original descriptor (lone surrogate and non-ASCII location included)', async () => {
  const { calls } = await runWorkflow(WF, { args: {}, agent: agentWithTwoFindings() })
  const payload = terminalPayload(calls)
  const keys = keysAtAnyDepth(payload)
  for (const k of [...LEGACY_KEYS, 'claim', 'location', 'evidence']) assert.ok(!keys.has(k), `payload still carries a "${k}" key`)
  const text = JSON.stringify(payload)
  for (const canary of ['canary-user', 'EVIDENCE-CANARY', 'missing auth check', '$(id)']) assert.ok(!text.includes(canary), `payload carries finding text: ${canary}`)
  const entries = payload[FINDINGS_KEY]
  assert.ok(Array.isArray(entries), `expected an array under "${FINDINGS_KEY}", got ${JSON.stringify(entries)}`)
  const opens = entries.filter((e) => e.disposition === 'open')
  assert.deepEqual(opens.map((e) => e.id), CLAIMS.map((c, i) => oracleId('lens-security', LOCATIONS[i], c)))
  assert.equal(opens[0].id, 'e74fb146b7ddc6cb', 'the id pinned in the existing suite for this descriptor must survive the cut-over')
  assert.deepEqual(Object.keys(opens[0]).sort(), ['ac_id', 'disposition', 'id', 'lens', 'severity'])
})

test('AC-PROD-1/AC-ARCH-6: result.open_findings is an array carrying in-script ids even when no id comes back from the writer, and when the ledger write fails', async () => {
  const expected = CLAIMS.map((c, i) => oracleId('lens-security', LOCATIONS[i], c))
  const ok = await runWorkflow(WF, { args: {}, agent: agentWithTwoFindings() })
  assert.ok(Array.isArray(ok.result.open_findings), `expected an array, got ${JSON.stringify(ok.result.open_findings)}`)
  assert.deepEqual(ok.result.open_findings.map((f) => f.id), expected)
  const failed = await runWorkflow(WF, { args: {}, agent: agentWithTwoFindings({ 'ledger:write': [LEDGER_OK, { run_id: null, ts: null, write_ok: false, write_error: 'safety classifier stopped the write' }] }) })
  assert.equal(failed.result.ledger_write_failed, true)
  assert.ok(Array.isArray(failed.result.open_findings), 'open_findings must stay an array on a failed write')
  assert.deepEqual(failed.result.open_findings.map((f) => f.id), expected)
})

test('AC-OPS-4: a writer refusing the findings key ends write_ok false and never retries without it', async () => {
  // run_id and ts are strings so the scripted refusal passes the writeLedger response schema and reaches the refused-key retry; null here fails the schema first and the retry is never consulted.
  const refusal = { run_id: 'r1', ts: '2026-08-10T00:00:00.000Z', write_ok: false, write_error: `${FINDINGS_KEY}: not an allowed property` }
  const { result, calls, logs } = await runWorkflow(WF, { args: {}, agent: agentWithTwoFindings({ 'ledger:write': [LEDGER_OK, refusal, LEDGER_OK] }) })
  assert.ok(Object.hasOwn(terminalPayload(calls), FINDINGS_KEY), 'the terminal payload must carry the findings key for the refusal to be about it')
  assert.equal(calls.filter((c) => c.opts.label === 'ledger:write').length, 2, 'the refused-key retry must not run for the findings key')
  assert.equal(result.ledger_write_failed, true)
  assert.ok(logs.some((l) => l.includes('TELEMETRY NOT RECORDED')))
  // Round 5 L5: the line names the stale writer and the remedy, since the retry never strips this key.
  assert.ok(logs.some((l) => l.includes('TELEMETRY NOT RECORDED') && /predates HARN-OPT-6/.test(l) && /bin\/install\.sh/.test(l) && /restart the session/.test(l)), `no remedy on the failure line: ${JSON.stringify(logs)}`)
})

test('AC-DATA-9: ledger-append.mjs no longer defines findingId or imports createHash', () => {
  const src = fs.readFileSync(WRITER, 'utf8')
  assert.ok(!/export function findingId/.test(src), 'findingId is still exported')
  assert.ok(!/createHash/.test(src), 'createHash is still referenced')
  assert.ok(!/open_finding_ids/.test(src), 'the open_finding_ids round trip is still present')
})

test('AC-DATA-2/AC-DATA-5: the writer lands the script\'s ids verbatim and drops any id not matching ^[0-9a-f]{16}$ without losing the row', async () => {
  const { calls } = await runWorkflow(WF, { args: {}, agent: agentWithTwoFindings() })
  const good = terminalPayload(calls)
  const repo = makeTempRepo()
  const res = JSON.parse(runAppend(repo, good).stdout.trim().split('\n').pop())
  assert.equal(res.write_ok, true, res.write_error)
  assert.ok(!('open_finding_ids' in res), 'the CLI result must not emit open_finding_ids')
  const row = JSON.parse(readLedgerLines(repo)[0])
  assert.deepEqual(row.findings.filter((f) => f.disposition === 'open').map((f) => f.id), good[FINDINGS_KEY].filter((e) => e.disposition === 'open').map((e) => e.id))

  const badIds = ['E74FB146B7DDC6CB', 'e74fb146b7ddc6c', 'e74fb146b7ddc6cbb', 'e74fb146b7ddc6cz', '/home/canary-user/s', '<home>/canary-user/secret claim']
  const hostile = { ...good, [FINDINGS_KEY]: [...good[FINDINGS_KEY], ...badIds.map((id) => ({ id, lens: 'lens-security', severity: 'High', ac_id: null, disposition: 'open' }))] }
  const repo2 = makeTempRepo()
  const res2 = JSON.parse(runAppend(repo2, hostile).stdout.trim().split('\n').pop())
  assert.equal(res2.write_ok, true, `a bad id must be a counted drop, not a refused row: ${res2.write_error}`)
  const line2 = readLedgerLines(repo2)[0]
  assert.ok(!line2.includes('canary-user'))
  for (const f of JSON.parse(line2).findings) assert.match(f.id, /^[0-9a-f]{16}$/)
  assert.equal(JSON.parse(line2).findings.length, JSON.parse(readLedgerLines(repo)[0]).findings.length)
})

// Transition-only (AC-QA-14): delete once no installed review-cycle.js predates HARN-OPT-6.
// This is the ONE test that feeds the new writer raw descriptor keys (what a pre-HARN-OPT-6 review-cycle.js sends). It also
// holds the legacy_payload marker (fix round 2 item E, merged here in fix round 3 item G), so no other test needs them.
test('AC-DATA-6b (transition-only): a legacy descriptor payload is never hashed, the writer says the workflow script predates HARN-OPT-6, and the row carries legacy_payload true (findings-free included) where a new-path row never does', async () => {
  const { calls } = await runWorkflow(WF, { args: {}, agent: agentWithTwoFindings() })
  const newPath = terminalPayload(calls)
  const { [FINDINGS_KEY]: _ids, ...base } = newPath
  const land = (payload) => {
    const repo = makeTempRepo()
    const out = JSON.parse(runAppend(repo, payload).stdout.trim().split('\n').pop())
    const lines = readLedgerLines(repo)
    assert.equal(lines.length, 1, 'the row must still land')
    return { out, lines, row: JSON.parse(lines[0]) }
  }

  const legacy = { ...base, open_findings: [{ lens: 'lens-security', location: 'foo.js:10', claim: 'missing auth check', severity: 'High', ac_id: null }] }
  const { out, lines, row } = land(legacy)
  assert.equal(row.kind, 'review_cycle')
  assert.equal(row.outcome, 'done')
  assert.ok(!(row.findings || []).some((f) => f.id === oracleId('lens-security', 'foo.js:10', 'missing auth check')), 'a legacy descriptor must not be hashed')
  assert.match(`${out.write_error} ${JSON.stringify(out)} ${lines[0]}`, /predates HARN-OPT-6/)
  assert.equal(row.legacy_payload, true, 'a legacy payload with a finding must carry the marker')

  const freeOfFindings = land({ ...base, spec_bugs: null, rejected_findings: [], open_findings: [] })
  assert.equal(freeOfFindings.row.legacy_payload, true, 'a findings-free legacy payload must carry the marker')

  assert.notEqual(land(newPath).row.legacy_payload, true, 'a new-path row must not carry the marker')
  const clean = await runWorkflow(WF, { args: {}, agent: agentWithTwoFindings({ 'lens-security': CLEAN }) })
  assert.notEqual(land(terminalPayload(clean.calls)).row.legacy_payload, true, 'a genuinely clean new-path round must not carry the marker')
})
