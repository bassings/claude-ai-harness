// HARN-OPT-4 T4 (specs/harn-opt-4.md): review-cycle gains a `round` argument,
// states the no-spec consequence in its report, and the reader separates
// conducted no-spec reviews (a round recorded) from direct ones. Written RED
// first. Pins AC-QA-12, AC-QA-13, AC-QA-29, AC-QA-30, AC-SEC-5, AC-SIMP-4,
// AC-SIMP-9, AC-SIMP-11, AC-OPS-4.
//
// Names this file pins (the spec fixes behaviour, not field names):
//   aggregateRework(...).noSpecReviewRunsConducted / .noSpecReviewRunsDirect,
//   and the same two keys inside .schemaV4 (null when no v4 row exists).
// The SKILL.md test lives in static-checks.test.js and the report-line test in
// optimise-cycle.test.js, their natural homes.
// Never point these at the real ledger: every write goes to a makeTempRepo().
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')
const { assertAppendPreservesPrefix } = require('./helpers/ledger-prefix.js')
const { makeTempRepo, runAppend, readLedgerLines, cleanupTempRepos, APPEND_SCRIPT, LEDGER_REL } = require('./helpers/temp-repo.js')

const WF = path.join(__dirname, '..', 'workflows', 'review-cycle.js')
const MODULE_PATH = path.join(__dirname, '..', 'workflows', 'lib', 'optimise-read.mjs')
const SENTENCE = 'No spec was supplied, so findings are not anchored to any acceptance criterion.'

test.after(cleanupTempRepos)

let reader
test.before(async () => {
  reader = await import(pathToFileURL(MODULE_PATH).href)
})

// ---- fake-runtime fixtures (same shapes as test/review-cycle.test.js) ----

const LEDGER_OK = { run_id: 'r1', ts: '2026-10-11T00:00:00.000Z', write_ok: true, write_error: null }
const SHA = 'abcdef1234567890'
const TREE = '1111111111111111111111111111111111111111'
const SCOPE_OK = {
  base: 'main', head_sha: SHA, head_tree: TREE,
  files: [{ path: 'src/foo.js', status: 'M' }],
  new_dependency_entries: false, new_modules: false, custom_rules: null, harness_triggers_file_exists: false,
  consistency: {
    ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9,
    doc_fields: ['recurrence'], agent_fields: ['recurrence'],
    missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null,
  },
}
const CLEAN = { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [], head_sha_measured: SHA, head_tree_measured: TREE }
function agents(overrides = {}) {
  return {
    'scope:diff': SCOPE_OK,
    // Every lens gets a clean default: a spec argument triggers more lenses
    // (lens-product among them) and an unscripted one aborts the run.
    'lens-security': CLEAN, 'lens-qa': CLEAN, 'lens-design': CLEAN, 'lens-accessibility': CLEAN, 'lens-product': CLEAN,
    'lens-architecture': CLEAN, 'lens-data': CLEAN, 'lens-operability': CLEAN, 'reviewer-verification': CLEAN,
    synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [] },
    'ledger:write': LEDGER_OK,
    ...overrides,
  }
}
async function review(args, agentOverrides) {
  const { result, calls } = await runWorkflow(WF, { args, agent: agents(agentOverrides) })
  const writes = calls.filter((c) => c.opts.label === 'ledger:write').map((c) => extractLedgerPayload(c.prompt))
  return { result, calls, started: writes[0], terminal: writes[writes.length - 1], writes }
}

// ---- (1) round: the workflow passes the raw value through (AC-QA-13) ----

test('T4 round: round 2 is written on BOTH the started and the terminal row', async () => {
  const { started, terminal, writes } = await review({ round: 2 })
  assert.equal(writes.length, 2)
  assert.equal(started.outcome, 'started')
  assert.equal(started.round, 2)
  assert.equal(terminal.round, 2)
})

// Round 2 L1 (AC-QA-13, spec bug S5): the payload carries `round` ONLY when one
// was supplied, so a stale installed writer that predates the field (and
// rejects unknown keys structurally) still accepts the row. The null-on-the-line
// guarantee belongs to the WRITTEN line, asserted below through the real writer.
test('T4 round: with no round supplied neither payload carries a round key (round 2 L1)', async () => {
  const { started, terminal } = await review({})
  for (const p of [started, terminal]) assert.ok(!('round' in p), `payload must omit round, got ${JSON.stringify(p)}`)
})

test('T4 round: absent writes null on the WRITTEN line for both rows, never 0 and never omitted (AC-QA-13, relocated from the payload by round 2 L1)', async () => {
  const { started, terminal } = await review({})
  for (const p of [started, terminal]) {
    const repo = makeTempRepo()
    const res = runAppend(repo, p)
    assert.equal(JSON.parse(res.stdout.trim().split('\n').pop()).write_ok, true, res.stderr)
    const entry = JSON.parse(readLedgerLines(repo)[0])
    assert.ok('round' in entry, 'the key must be present on the line')
    assert.strictEqual(entry.round, null)
  }
})

test('T4 round: the workflow does not validate; hostile values reach the writer verbatim for the schema to neutralise', async () => {
  for (const bad of ['2; rm -rf', -1, 1.5, '2', 0]) {
    const { terminal } = await review({ round: bad })
    assert.deepStrictEqual(terminal.round, bad, `value ${JSON.stringify(bad)}`)
  }
})

// ---- (2) round: the real writer neutralises and counts (AC-QA-13, AC-QA-29) ----

function writeRow(extra) {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 4, kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md', lenses_run: ['lens-qa'], ...extra })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, `stderr: ${res.stderr}`)
  return { out, entry: JSON.parse(lines[0]), raw: lines[0] }
}

test('T4 schema: positive integers survive on a review_cycle row and nothing is counted', () => {
  for (const good of [1, 2, 17]) {
    const { out, entry } = writeRow({ round: good })
    assert.equal(out.write_ok, true, out.write_error)
    assert.strictEqual(entry.round, good)
    assert.ok(!entry.invalid_record_values_dropped, `value ${good}`)
  }
})

test('T4 schema: "2; rm -rf", -1, 1.5, "2" and 0 each write null and are counted, with write_ok true and the rest of the record intact', () => {
  for (const bad of ['2; rm -rf', -1, 1.5, '2', 0]) {
    const { out, entry, raw } = writeRow({ round: bad })
    const label = JSON.stringify(bad)
    assert.equal(out.write_ok, true, `${label}: ${out.write_error}`)
    assert.strictEqual(entry.round, null, label)
    assert.equal(entry.invalid_record_values_dropped, 1, label)
    assert.equal(out.invalid_record_values_dropped, 1, label)
    assert.equal(entry.kind, 'review_cycle')
    assert.equal(entry.outcome, 'done')
    assert.equal(entry.spec, 'specs/a.md')
    assert.deepEqual(entry.lenses_run, ['lens-qa'])
    if (typeof bad === 'string') assert.ok(!raw.includes('rm -rf'), 'the hostile string must not survive onto the line')
  }
})

test('T4 schema: an absent round is null on the line and is not counted as dropped', () => {
  const { entry } = writeRow({})
  // Round 1 L1 (AC-QA-13): the old "null or absent" form passed with the writer's
  // normalisation deleted. Require the key present and null.
  assert.ok('round' in entry, 'the round key must be present on the line')
  assert.strictEqual(entry.round, null)
  assert.ok(!entry.invalid_record_values_dropped)
})

test('T4 schema: round is declared integer-or-null in LEDGER_ENTRY_SCHEMA and exported as the ONLY new field in ledger-schema-fields.json (AC-QA-29, AC-SIMP-9)', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(pathToFileURL(APPEND_SCRIPT).href)
  assert.deepEqual(LEDGER_ENTRY_SCHEMA.properties.round && LEDGER_ENTRY_SCHEMA.properties.round.type, ['integer', 'null'])
  const fields = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'lib', 'ledger-schema-fields.json'), 'utf8'))
  assert.deepEqual(fields.round, ['integer', 'null'])
  // T5 (AC-SIMP-9) owns blocked_reason; test/harn-opt-4-t5.test.js now pins it.
  assert.ok(!('spec_absent' in fields), 'AC-SIMP-4')
})

// ---- (3) no spec: the consequence sentence and spec: null (AC-QA-12, AC-OPS-4, AC-SIMP-4) ----

test('T4 no-spec: the run completes, the terminal row has spec null, and the returned report carries the consequence sentence', async () => {
  const { result, terminal, started } = await review({})
  assert.notEqual(result.telemetry.outcome, 'aborted')
  assert.strictEqual(terminal.spec, null)
  assert.strictEqual(started.spec, null)
  assert.ok(result.report.includes(SENTENCE), `report was: ${result.report}`)
})

test('T4 no-spec: the sentence is appended in script code, so it appears even when synthesis never mentions it', async () => {
  const { result } = await review({}, { synthesis: { report: 'Findings: none.', spec_bugs: [], rejected_findings: [] } })
  assert.ok(result.report.startsWith('Findings: none.'), 'the synthesised report must be preserved, not replaced')
  assert.ok(result.report.includes(SENTENCE))
})

test('T4 no-spec: when synthesis already wrote the sentence, the code does not append it again: exactly one occurrence (round 1 L2, AC-QA-12)', async () => {
  const { result } = await review({}, { synthesis: { report: `Findings: none.\n\n${SENTENCE}`, spec_bugs: [], rejected_findings: [] } })
  assert.equal(result.report.split(SENTENCE).length - 1, 1, `report was: ${result.report}`)
})

test('T4 no-spec: the synthesis prompt for a no-spec run carries the sentence too', async () => {
  const { calls } = await review({})
  const synthesis = calls.find((c) => c.opts.label === 'synthesis')
  assert.ok(synthesis.prompt.includes(SENTENCE))
})

test('T4 no-spec: a run WITH a spec does not carry the sentence, in the report or the synthesis prompt', async () => {
  const { result, calls } = await review({ spec: 'specs/example.md' })
  assert.ok(!result.report.includes(SENTENCE))
  assert.ok(!calls.find((c) => c.opts.label === 'synthesis').prompt.includes(SENTENCE))
})

test('T4 no-spec: a run with no spec argument whose lens located a spec and verified criteria is NOT a no-spec run, so no sentence', async () => {
  const { result } = await review({}, { 'lens-qa': { ...CLEAN, ac_verdicts: [{ id: 'AC-QA-1', verdict: 'PASS', evidence: 'ran the suite' }] } })
  assert.ok(!result.report.includes(SENTENCE))
})

test('T4 no-spec: no spec_absent field exists anywhere in the payloads or in workflows/ (AC-SIMP-4)', async () => {
  const { writes } = await review({})
  for (const w of writes) assert.ok(!JSON.stringify(w).includes('spec_absent'))
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  for (const f of walk(path.join(__dirname, '..', 'workflows'))) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('spec_absent'), f)
  }
})

test('T4 argument surface: round is the only new name in review-cycle whenToUse (AC-SIMP-11)', () => {
  const src = fs.readFileSync(WF, 'utf8')
  const whenToUse = src.split('\n').find((l) => l.trim().startsWith('whenToUse:'))
  assert.match(whenToUse, /round\?: /)
})

// ---- (4) AC-SEC-5: an absolute spec path never reaches the line ----

test('T4 AC-SEC-5: with round passed, an absolute spec under the repo root is written repo-relative in spec and spec_raw, through the real writer', async () => {
  const repo = makeTempRepo()
  const abs = path.join(fs.realpathSync(repo), 'specs', 'harn-opt-4.md')
  const { terminal } = await review({ spec: abs, round: 2 })
  assert.strictEqual(terminal.round, 2, 'precondition: round travelled with the spec')
  const res = runAppend(repo, terminal)
  assert.equal(JSON.parse(res.stdout.trim().split('\n').pop()).write_ok, true)
  const [raw] = readLedgerLines(repo)
  const entry = JSON.parse(raw)
  assert.strictEqual(entry.round, 2, 'round must survive the writer')
  assert.equal(entry.spec, 'specs/harn-opt-4.md')
  assert.ok(!raw.includes(fs.realpathSync(repo)), `the line must not carry the absolute prefix: ${raw}`)
  assert.ok(!raw.includes(repo), `the line must not carry the absolute prefix: ${raw}`)
})

// ---- (5) reader: conducted versus direct (AC-QA-30, AC-OPS-4) ----

const row = (runId, extra = {}) => ({ schema_version: 4, run_id: runId, ts: '2026-10-11T00:00:00.000Z', repo: 'demo', kind: 'review_cycle', outcome: 'done', spec: null, findings: [], ac_verdicts: [], ...extra })
// Window: 3 conducted (v4, rounds 1..3), direct = 3 old rows with no round key
// plus 1 v4 row with round null = 4. A spec-bearing row with a round and the
// started rows are counted by neither.
function mixedRows() {
  return [
    row('c1', { round: 1 }), row('c2', { round: 2 }), row('c3', { round: 3 }),
    row('d4', { round: null }),
    row('o1', { schema_version: 3 }), row('o2', { schema_version: 3 }), row('o3', { schema_version: 3 }),
    row('s1', { spec: 'specs/a.md', ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'PASS' }], round: 4 }),
    row('c1', { round: 1, outcome: 'started' }), row('d4', { round: null, outcome: 'started' }),
  ]
}

test('T4 reader: window-wide conducted=3, direct=1, round-not-recorded=3; rows with no round key at all are neither conducted nor direct (round 1 M1); started rows and spec-bearing rows count as none', () => {
  const rework = reader.aggregateRework(mixedRows())
  assert.strictEqual(rework.noSpecReviewRunsConducted, 3)
  assert.strictEqual(rework.noSpecReviewRunsDirect, 1)
  assert.strictEqual(rework.noSpecReviewRunsRoundNotRecorded, 3)
})

test('T4 reader: the schemaV4 block counts only v4 rows (conducted=3, direct=1)', () => {
  const v4 = reader.aggregateRework(mixedRows()).schemaV4
  assert.strictEqual(v4.noSpecReviewRunsConducted, 3)
  assert.strictEqual(v4.noSpecReviewRunsDirect, 1)
  assert.strictEqual(v4.noSpecReviewRunsRoundNotRecorded, 0)
})

test('T4 reader: schema_version 4 no-spec rows WITHOUT a round key count as round-not-recorded, never direct (round 1 M1, AC-QA-30)', () => {
  const rows = [row('n1'), row('n2'), row('n3'), row('d1', { round: null }), row('c1', { round: 2 })]
  for (const r of rows.slice(0, 3)) assert.ok(!('round' in r), 'fixture must lack the key')
  const rework = reader.aggregateRework(rows)
  assert.strictEqual(rework.noSpecReviewRunsRoundNotRecorded, 3)
  assert.strictEqual(rework.noSpecReviewRunsDirect, 1)
  assert.strictEqual(rework.noSpecReviewRunsConducted, 1)
  assert.strictEqual(rework.schemaV4.noSpecReviewRunsRoundNotRecorded, 3)
  assert.strictEqual(rework.schemaV4.noSpecReviewRunsDirect, 1)
  assert.strictEqual(rework.schemaV4.noSpecReviewRunsConducted, 1)
})

test('T4 reader: when every no-spec terminal row lacks the round key, conducted and direct are null, not a measured 0, in both blocks (round 1 M1, AC-QA-30)', () => {
  const rework = reader.aggregateRework([row('n1'), row('n2')])
  assert.strictEqual(rework.noSpecReviewRunsConducted, null)
  assert.strictEqual(rework.noSpecReviewRunsDirect, null)
  assert.strictEqual(rework.noSpecReviewRunsRoundNotRecorded, 2)
  assert.strictEqual(rework.schemaV4.noSpecReviewRunsConducted, null)
  assert.strictEqual(rework.schemaV4.noSpecReviewRunsDirect, null)
  assert.strictEqual(rework.schemaV4.noSpecReviewRunsRoundNotRecorded, 2)
})

test('T4 reader: with no v4 row the schemaV4 figures are null, never a measured 0, while the window-wide direct count still includes the old rows', () => {
  const rework = reader.aggregateRework([row('o1', { schema_version: 3 }), row('o2', { schema_version: 3 })])
  assert.strictEqual(rework.schemaV4.noSpecReviewRunsConducted, null)
  assert.strictEqual(rework.schemaV4.noSpecReviewRunsDirect, null)
  // Round 1 M1: old rows carry no round key, so nothing was measured; null,
  // not 0, and the rows are counted in the third bucket.
  assert.strictEqual(rework.noSpecReviewRunsConducted, null)
  assert.strictEqual(rework.noSpecReviewRunsDirect, null)
  assert.strictEqual(rework.noSpecReviewRunsRoundNotRecorded, 2)
})

test('T4 reader: both figures survive the CLI output whitelist', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.dirname(path.join(repo, LEDGER_REL)), { recursive: true })
  fs.writeFileSync(path.join(repo, LEDGER_REL), mixedRows().map((r) => JSON.stringify(r)).join('\n') + '\n')
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.strictEqual(out.rework.noSpecReviewRunsConducted, 3)
  assert.strictEqual(out.rework.noSpecReviewRunsDirect, 1)
  assert.strictEqual(out.rework.noSpecReviewRunsRoundNotRecorded, 3)
  assert.strictEqual(out.rework.schemaV4.noSpecReviewRunsRoundNotRecorded, 0)
  assert.strictEqual(out.rework.schemaV4.noSpecReviewRunsConducted, 3)
  assert.strictEqual(out.rework.schemaV4.noSpecReviewRunsDirect, 1)
})

// ---- (6) round 2 additions ----

// Round 2 L2 (AC-DATA-19): the byte-prefix property, executed through the real
// writer against a ledger whose last line was truncated by a crash.
test('T4 schema: a write with round 2 or a hostile round leaves the original ledger bytes as a prefix and adds exactly one line (round 2 L2, AC-DATA-19)', () => {
  const base = { schema_version: 4, kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md', lenses_run: ['lens-qa'] }
  for (const round of [2, '2; rm -rf']) {
    const { added } = assertAppendPreservesPrefix(makeTempRepo(), { ...base, round })
    const entry = JSON.parse(added)
    assert.strictEqual(entry.round, round === 2 ? 2 : null)
  }
})

test('T4 round: a supplied round of 2 is on BOTH the started and terminal payloads (round 2 L1)', async () => {
  const { started, terminal } = await review({ round: 2 })
  assert.ok('round' in started && 'round' in terminal)
  assert.strictEqual(started.round, 2)
  assert.strictEqual(terminal.round, 2)
})

// Round 2 M1 (AC-PROD-4): terminal rows with a positive-integer round,
// regardless of spec. mixedRows(): c1, c2, c3 (no spec) and s1 (spec, round 4)
// = 4, which collides with none of the 3/1/3 figures above. Started rows and
// the round null row are excluded; old rows carry no key.
test('T4 reader: reviewRunsWithRound counts terminal rows with a round >= 1 regardless of spec, window-wide and in schemaV4 (round 2 M1)', () => {
  const rework = reader.aggregateRework(mixedRows())
  assert.strictEqual(rework.reviewRunsWithRound, 4)
  assert.strictEqual(rework.schemaV4.reviewRunsWithRound, 4)
})

test('T4 reader: reviewRunsWithRound ignores non-positive and non-integer rounds and started rows (round 2 M1)', () => {
  const rows = [row('a', { round: 0 }), row('b', { round: -1 }), row('c', { round: 1.5 }), row('d', { round: '2' }), row('e', { round: 5 }), row('e', { round: 5, outcome: 'started' })]
  assert.strictEqual(reader.aggregateRework(rows).reviewRunsWithRound, 1)
})

test('T4 reader: reviewRunsWithRound is null, not 0, when no terminal row carries the round key at all (round 2 M1)', () => {
  const rework = reader.aggregateRework([row('o1', { schema_version: 3 }), row('o2', { schema_version: 3, spec: 'specs/a.md' }), row('n1')])
  assert.strictEqual(rework.reviewRunsWithRound, null)
  assert.strictEqual(rework.schemaV4.reviewRunsWithRound, null)
})

test('T4 reader: reviewRunsWithRound survives the CLI output whitelist (round 2 M1)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.dirname(path.join(repo, LEDGER_REL)), { recursive: true })
  fs.writeFileSync(path.join(repo, LEDGER_REL), mixedRows().map((r) => JSON.stringify(r)).join('\n') + '\n')
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.strictEqual(out.rework.reviewRunsWithRound, 4)
  assert.strictEqual(out.rework.schemaV4.reviewRunsWithRound, 4)
})
