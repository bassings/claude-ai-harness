// HARN-OPT-4 T3 (reader-only): verdict dedup with worst-of precedence, a
// separate disagreement counter, and the schema_version >= 4 completeness
// split. Written RED first. Pins AC-QA-10, AC-QA-11, AC-QA-30, AC-DATA-7,
// AC-DATA-8, AC-PROD-3, AC-PROD-10.
//
// Names this file pins on the reader's return values (the contract T3 must
// deliver, since the spec fixes behaviour but not field names):
//   aggregateRework(...).verdictDisagreements : Map keyed like acVerdicts
//     (repo|spec|canonical ac_id) -> number of runs whose usable verdicts
//     for that ac_id differed.
//   neverFailingAcs(acVerdicts, { verdictDisagreements }) rows carry
//     `verdict_disagreements`.
//   aggregateRework(...).schemaV4 : { rows, excludedRows, findingsTruncated,
//     unattributedFindings, duplicateVerdictPairs, noSpecReviewRuns }, every
//     figure null when rows is 0 (never a measured 0 for rows that cannot
//     have recorded it).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { makeTempRepo, cleanupTempRepos, LEDGER_REL } = require('./helpers/temp-repo.js')

const MODULE_PATH = path.join(__dirname, '..', 'workflows', 'lib', 'optimise-read.mjs')

let mod
test.before(async () => {
  mod = await import(pathToFileURL(MODULE_PATH).href)
})
test.after(cleanupTempRepos)

function review(runId, verdicts, extra = {}) {
  return { schema_version: 4, run_id: runId, ts: '2026-10-11T00:00:00.000Z', repo: 'demo', kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md', findings: [], ac_verdicts: verdicts, ...extra }
}
const V = (ac_id, verdict) => ({ ac_id, verdict })
const KEY = 'demo|specs/a.md|AC-QA-15'

// ---- (1) dedup with worst-of precedence (AC-QA-10, AC-DATA-7) ----

test('T3 dedup: the 6502bc72 replay, AC-QA-15 PASS and FAIL in one record, counts n=1 fail=1 and is not never-failed, in both input orders', () => {
  for (const order of [[V('AC-QA-15', 'PASS'), V('AC-QA-15', 'FAIL')], [V('AC-QA-15', 'FAIL'), V('AC-QA-15', 'PASS')]]) {
    const rework = mod.aggregateRework([review('6502bc72', order, { schema_version: 3 })])
    const e = rework.acVerdicts.get(KEY)
    assert.equal(e.n, 1, `order ${JSON.stringify(order)}`)
    assert.equal(e.fail, 1)
    assert.equal(e.pass, 0)
    const [row] = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 1, verdictDisagreements: rework.verdictDisagreements })
    assert.equal(row.never_failed, false)
  }
})

test('T3 dedup: worst-of is FAIL over UNVERIFIABLE over PASS, whatever the order', () => {
  const cases = [
    [['PASS', 'UNVERIFIABLE'], 'unverifiable'],
    [['UNVERIFIABLE', 'PASS'], 'unverifiable'],
    [['UNVERIFIABLE', 'FAIL'], 'fail'],
    [['FAIL', 'UNVERIFIABLE'], 'fail'],
  ]
  for (const [verdicts, winner] of cases) {
    const e = mod.aggregateRework([review('r1', verdicts.map((v) => V('AC-QA-15', v)))]).acVerdicts.get(KEY)
    assert.equal(e.n, 1, verdicts.join('+'))
    for (const k of ['pass', 'fail', 'unverifiable']) assert.equal(e[k], k === winner ? 1 : 0, `${verdicts.join('+')} ${k}`)
  }
})

test('T3 dedup: three runs that each carry a duplicated verdict give n=3, not 6; the same AC in two runs gives n=2', () => {
  const dup = (id) => review(id, [V('AC-QA-15', 'PASS'), V('AC-QA-15', 'PASS')])
  const e = mod.aggregateRework([dup('r1'), dup('r2'), dup('r3')]).acVerdicts.get(KEY)
  assert.equal(e.n, 3)
  assert.equal(e.pass, 3)
  const two = mod.aggregateRework([review('r1', [V('AC-QA-15', 'PASS')]), review('r2', [V('AC-QA-15', 'PASS')])]).acVerdicts.get(KEY)
  assert.equal(two.n, 2)
})

test('T3 dedup: the same run_id in a different repo is a different run', () => {
  const a = review('same', [V('AC-QA-15', 'PASS')])
  const b = review('same', [V('AC-QA-15', 'PASS')], { repo: 'other' })
  const rework = mod.aggregateRework([a, b])
  assert.equal(rework.acVerdicts.get(KEY).n, 1)
  assert.equal(rework.acVerdicts.get('other|specs/a.md|AC-QA-15').n, 1)
})

// ---- (2) disagreement counter (AC-PROD-3) ----

test('T3 disagreements: +1 per run in which usable verdicts for one ac_id differ; agreement and single verdicts add none', () => {
  const rework = mod.aggregateRework([
    review('r1', [V('AC-QA-15', 'PASS'), V('AC-QA-15', 'FAIL')]),
    review('r2', [V('AC-QA-15', 'FAIL'), V('AC-QA-15', 'PASS')]),
    review('r3', [V('AC-QA-15', 'PASS'), V('AC-QA-15', 'PASS')]),
    review('r4', [V('AC-QA-15', 'PASS')]),
  ])
  assert.equal(rework.verdictDisagreements.get(KEY), 2)
  const [row] = mod.neverFailingAcs(rework.acVerdicts, { verdictDisagreements: rework.verdictDisagreements })
  assert.equal(row.verdict_disagreements, 2)
})

test('T3 disagreements: a null verdict is not a usable verdict, so it never counts as a disagreement and never wins worst-of', () => {
  const rework = mod.aggregateRework([review('r1', [V('AC-QA-15', null), V('AC-QA-15', 'PASS')])])
  const e = rework.acVerdicts.get(KEY)
  assert.equal(e.n, 1)
  assert.equal(e.pass, 1)
  assert.equal(e.fail, 0)
  assert.equal(e.unattributedVerdicts, 1)
  assert.ok(!rework.verdictDisagreements.get(KEY))
  const f = mod.aggregateRework([review('r1', [V('AC-QA-15', 'bogus'), V('AC-QA-15', 'FAIL')])]).acVerdicts.get(KEY)
  assert.equal(f.fail, 1)
  assert.equal(f.n, 1)
  assert.equal(f.unattributedVerdicts, 1)
})

// ---- (3) taints preserved (AC-QA-11, AC-DATA-7) ----

test('T3 taints: own-spec prefix collapses with the bare id, a foreign prefix keeps its own bucket, a null-ac_id FAIL still taints, and a pre-change row dedups by the same rule', () => {
  const rec = review('r1', [V('FEAT-1 AC-QA-1', 'PASS'), V('AC-QA-1', 'FAIL'), V('OTHER-002 AC-QA-1', 'PASS'), V(null, 'FAIL')], { spec: 'specs/FEAT-1.md', schema_version: 3 })
  const rework = mod.aggregateRework([rec])
  const own = rework.acVerdicts.get('demo|specs/FEAT-1.md|AC-QA-1')
  assert.equal(own.n, 1)
  assert.equal(own.fail, 1)
  assert.equal(rework.verdictDisagreements.get('demo|specs/FEAT-1.md|AC-QA-1'), 1)
  const foreign = rework.acVerdicts.get('demo|specs/FEAT-1.md|OTHER-002 AC-QA-1')
  assert.equal(foreign.n, 1)
  assert.equal(foreign.pass, 1)
  assert.ok(rework.unattributedFailBuckets.has('demo|specs/FEAT-1.md'))
  const rows = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 1, unattributedFailBuckets: rework.unattributedFailBuckets })
  assert.ok(rows.every((r) => r.unattributed_fail_in_window && r.never_failed === null))
})

// ---- (4) truncated arrays are never trusted (AC-DATA-8) ----

test('T3 truncation: a truncated verdict array taints its bucket and no never-failed result is reported, even with a clean-looking deduped PASS', () => {
  const rework = mod.aggregateRework([
    review('r1', [V('AC-QA-15', 'PASS'), V('AC-QA-15', 'PASS')], { ac_verdicts_truncated: 3 }),
    review('r2', [V('AC-QA-15', 'PASS')]),
  ])
  assert.ok(rework.truncatedBuckets.has('demo|specs/a.md'))
  const [row] = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 1, truncatedBuckets: rework.truncatedBuckets })
  assert.equal(row.truncated_in_window, true)
  assert.equal(row.never_failed, null)
})

// ---- (5) per-schema-version split (AC-PROD-10) ----

test('T3 split: figures are computed for schema_version >= 4 rows alone, with older rows reported as excluded by count', () => {
  const v3 = review('a', [V('AC-QA-1', 'PASS'), V('AC-QA-1', 'FAIL')], { schema_version: 3, findings_truncated: 5, findings: [{ id: 'x', lens: 'lens-qa+lens-security', disposition: 'open' }] })
  const v4 = review('b', [V('AC-QA-1', 'PASS'), V('AC-QA-1', 'PASS'), V('AC-QA-2', 'PASS'), V('AC-QA-2', 'FAIL')], { findings_truncated: 2, findings: [{ id: 'y', lens: 'lens-qa+lens-security', disposition: 'open' }] })
  const v4NoSpec = review('c', [], { spec: null })
  const rework = mod.aggregateRework([v3, v4, v4NoSpec])
  assert.deepEqual(rework.schemaV4, { rows: 2, excludedRows: 1, findingsTruncated: 2, unattributedFindings: 1, duplicateVerdictPairs: 2, noSpecReviewRuns: 1 })
  // The window-wide figure is untouched: it still includes the v3 row.
  assert.equal(rework.findingsTruncated, 7)
})

test('T3 split: with no schema_version >= 4 rows every figure is null and the older rows are counted as excluded, never a measured 0', () => {
  const rework = mod.aggregateRework([review('a', [V('AC-QA-1', 'PASS')], { schema_version: 3 }), review('b', [V('AC-QA-1', 'PASS')], { schema_version: 1 })])
  assert.deepEqual(rework.schemaV4, { rows: 0, excludedRows: 2, findingsTruncated: null, unattributedFindings: null, duplicateVerdictPairs: null, noSpecReviewRuns: null })
})

// ---- (6) old rows through the real CLI (AC-QA-30) ----

test('T3 old rows: a ledger of pre-change rows, one per kind, aggregates without throwing and the new v4 figures are null', () => {
  const repo = makeTempRepo()
  const base = (n, kind, extra) => JSON.stringify({ schema_version: 3, run_id: `old-${n}`, ts: `2026-08-0${n}T00:00:00.000Z`, repo: 'demo', kind, ...extra })
  const lines = [
    base(1, 'tdd_task', { outcome: 'done', write_ok: true, write_error: null }),
    base(2, 'review_cycle', { outcome: 'done', spec: 'specs/a.md', findings: [], ac_verdicts: [V('AC-QA-1', 'PASS')] }),
    base(3, 'plan_cycle', { outcome: 'done', spec: 'specs/a.md' }),
    base(4, 'conduct_plan_event', { event: 'ci_wait_started', event_scope: 'p:t:ci_wait_started:1' }),
  ]
  fs.mkdirSync(path.dirname(path.join(repo, LEDGER_REL)), { recursive: true })
  fs.writeFileSync(path.join(repo, LEDGER_REL), lines.join('\n') + '\n')
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.ok(!out.error, JSON.stringify(out.error))
  assert.deepEqual(out.rework.schemaV4, { rows: 0, excludedRows: 1, findingsTruncated: null, unattributedFindings: null, duplicateVerdictPairs: null, noSpecReviewRuns: null })
})

test('T3 CLI: the ledger command carries the v4 split and per-AC verdict_disagreements across its output whitelist', () => {
  const repo = makeTempRepo()
  const row = (o) => JSON.stringify({ ts: '2026-10-11T00:00:00.000Z', repo: 'demo', kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md', findings: [], ...o })
  const lines = [
    row({ schema_version: 3, run_id: 'old', ac_verdicts: [V('AC-QA-15', 'PASS')] }),
    row({ schema_version: 4, run_id: 'new', ac_verdicts: [V('AC-QA-15', 'PASS'), V('AC-QA-15', 'FAIL')] }),
  ]
  fs.mkdirSync(path.dirname(path.join(repo, LEDGER_REL)), { recursive: true })
  fs.writeFileSync(path.join(repo, LEDGER_REL), lines.join('\n') + '\n')
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.rework.schemaV4.rows, 1)
  assert.equal(out.rework.schemaV4.excludedRows, 1)
  assert.equal(out.rework.schemaV4.duplicateVerdictPairs, 1)
  const ac = out.neverFailingAcs.find((a) => a.ac_id === 'AC-QA-15')
  assert.equal(ac.n, 2)
  assert.equal(ac.verdict_disagreements, 1)
})

// ---- round 1 fix: terminal rows only, truncation, group wording ----

test('T3 round 1 M2: a started row plus its done row for one run_id counts once in every v4 figure and in the window-wide no-spec count (AC-QA-30, AC-PROD-10)', () => {
  const started = review('run-1', [], { spec: null, outcome: 'started', findings_truncated: 9 })
  const done = review('run-1', [], { spec: null, findings_truncated: 2 })
  const olderDone = review('old', [V('AC-QA-1', 'PASS')], { schema_version: 3 })
  const rework = mod.aggregateRework([started, done, olderDone])
  assert.equal(rework.schemaV4.rows, 1)
  assert.equal(rework.schemaV4.noSpecReviewRuns, 1)
  assert.equal(rework.schemaV4.findingsTruncated, 2)
  assert.equal(rework.schemaV4.excludedRows, 1)
  // Before the fix this was 2: the started row was counted as a no-spec run.
  assert.equal(rework.noSpecReviewRuns, 1)
})

test('T3 round 1 M2: window-wide noSpecReviewRuns, before and after: three done rows plus their three started rows is 3, not 6', () => {
  const rows = []
  for (const id of ['a', 'b', 'c']) {
    rows.push(review(id, [], { spec: null, schema_version: 3, outcome: 'started' }))
    rows.push(review(id, [], { spec: null, schema_version: 3 }))
  }
  assert.equal(mod.aggregateRework(rows).noSpecReviewRuns, 3)
})

test('T3 round 1 L1: verdict_disagreements is null, not 0, for a criterion in a bucket whose verdict array was truncated (AC-DATA-8)', () => {
  const rework = mod.aggregateRework([
    review('r1', [V('AC-QA-15', 'PASS')], { ac_verdicts_truncated: 40 }),
    review('r2', [V('AC-QA-15', 'PASS')]),
  ])
  const [row] = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 1, truncatedBuckets: rework.truncatedBuckets, verdictDisagreements: rework.verdictDisagreements })
  assert.equal(row.truncated_in_window, true)
  assert.equal(row.verdict_disagreements, null)
  const clean = mod.aggregateRework([review('r3', [V('AC-QA-15', 'PASS')])])
  const [cleanRow] = mod.neverFailingAcs(clean.acVerdicts, { minRuns: 1, truncatedBuckets: clean.truncatedBuckets, verdictDisagreements: clean.verdictDisagreements })
  assert.equal(cleanRow.verdict_disagreements, 0)
})

test('T3 round 1 L2: three identical verdicts for one (run, ac_id) are one duplicate group, and the report label says groups', () => {
  const rework = mod.aggregateRework([review('r1', [V('AC-QA-15', 'PASS'), V('AC-QA-15', 'PASS'), V('AC-QA-15', 'PASS')])])
  assert.equal(rework.schemaV4.duplicateVerdictPairs, 1)
  const src = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'optimise-cycle.js'), 'utf8')
  assert.ok(src.includes('duplicate verdict groups collapsed='))
  assert.ok(!src.includes('duplicate verdict pairs collapsed'))
})
