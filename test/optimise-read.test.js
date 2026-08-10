// Unit tests for workflows/lib/optimise-read.mjs: the real-Node script the
// optimiser's agent steps invoke (via Bash) to parse and aggregate ledger
// and gh data. Like workflows/lib/ledger-append.mjs, this is ordinary
// unsandboxed Node code (not a dynamic-workflow script), so its exports are
// tested directly here, the same pattern test/ledger-append.test.js already
// uses for validateEntry/findingId/truncateBytes.
//
// AC-QA-21 requires every number the optimiser reports to be computed in
// script code, with byte-identical aggregates across repeated runs against
// the same fixture: this file's "known fixture -> hand-computed counts"
// tests are the direct proof of that.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { makeTempRepo, runAppend, trackTempDir, cleanupTempRepos, SUITE_TMPDIR } = require('./helpers/temp-repo.js')
const fs = require('node:fs')

const MODULE_PATH = path.join(__dirname, '..', 'workflows', 'lib', 'optimise-read.mjs')
const MODULE_URL = pathToFileURL(MODULE_PATH).href

let mod
test.before(async () => {
  mod = await import(MODULE_URL)
})
test.after(cleanupTempRepos)

// ---- parseLedgerContent: hostile-ledger tolerance (AC-QA-16) ----

test('optimise-read: parseLedgerContent tolerates a truncated final line, blank lines, unknown extra fields, a missing required field, an unknown kind, older/newer schema_version, and a 30KB unicode field -- never throws, counts every skip with a reason, and never drops a record uncounted', () => {
  const validTdd = JSON.stringify({ schema_version: 1, run_id: 'r1', ts: '2026-08-01T00:00:00.000Z', repo: 'demo', kind: 'tdd_task', outcome: 'done', write_ok: true, write_error: null })
  const unknownExtra = JSON.stringify({ schema_version: 1, run_id: 'r2', ts: '2026-08-01T00:01:00.000Z', repo: 'demo', kind: 'tdd_task', outcome: 'done', write_ok: true, write_error: null, a_future_field: 'not declared today' })
  const missingKind = JSON.stringify({ schema_version: 1, run_id: 'r3', ts: '2026-08-01T00:02:00.000Z', repo: 'demo', write_ok: true, write_error: null })
  const unknownKind = JSON.stringify({ schema_version: 1, run_id: 'r4', ts: '2026-08-01T00:03:00.000Z', repo: 'demo', kind: 'some_future_kind', write_ok: true, write_error: null })
  const olderSchema = JSON.stringify({ schema_version: 0, run_id: 'r5', ts: '2026-08-01T00:04:00.000Z', repo: 'demo', kind: 'tdd_task', outcome: 'done', write_ok: true, write_error: null })
  const newerSchema = JSON.stringify({ schema_version: 2, run_id: 'r6', ts: '2026-08-01T00:05:00.000Z', repo: 'demo', kind: 'tdd_task', outcome: 'done', write_ok: true, write_error: null })
  const bigUnicode = 'う'.repeat(15000) + '🎉'.repeat(2000) // well over 30KB in UTF-8 bytes
  const unicodeLine = JSON.stringify({ schema_version: 1, run_id: 'r7', ts: '2026-08-01T00:06:00.000Z', repo: 'demo', kind: 'tdd_task', outcome: 'done', task: bigUnicode, write_ok: true, write_error: null })
  const truncatedFinal = '{"schema_version":1,"run_id":"trunc","ts":"2026-08-01T00:07:00' // deliberately cut mid-object, no closing, no trailing newline

  const raw = [validTdd, '', '   ', unknownExtra, missingKind, unknownKind, olderSchema, newerSchema, unicodeLine, truncatedFinal].join('\n')

  const { records, skipped, schemaVersionsSeen } = mod.parseLedgerContent(raw)

  // Valid + tolerated records: valid, unknownExtra, unknownKind, olderSchema,
  // newerSchema, unicodeLine == 6. missingKind and truncatedFinal are the
  // only two genuinely broken lines.
  assert.equal(records.length, 6, `expected 6 usable records, got ${records.length}`)
  assert.equal(skipped.length, 2, `expected 2 skipped lines, got ${JSON.stringify(skipped)}`)
  assert.ok(skipped.some((s) => s.reason.includes('required') && s.reason.includes('kind')), 'missing-kind line must be reported with a reason naming the missing field')
  assert.ok(skipped.some((s) => s.reason.includes('parse') || s.reason.includes('JSON')), 'the truncated final line must be reported as unparseable')

  // Every skip is counted with a reason -- never a silent drop.
  for (const s of skipped) {
    assert.ok(typeof s.reason === 'string' && s.reason.length > 0)
    assert.ok(typeof s.line === 'number' && s.line > 0)
  }

  // unknown-kind and off-version records are NOT skipped: "a new emitting
  // kind requires no optimiser change" means they parse as ordinary records.
  assert.ok(records.some((r) => r.kind === 'some_future_kind'))
  assert.ok(records.some((r) => r.schema_version === 0))
  assert.ok(records.some((r) => r.schema_version === 2))
  assert.deepEqual([...schemaVersionsSeen.entries()].sort(), [[0, 1], [1, 4], [2, 1]])

  // The oversized unicode field survived intact (not silently truncated or
  // dropped by the reader -- report-time truncation, if any, is a display
  // concern handled elsewhere, not a parsing concern).
  const unicodeRecord = records.find((r) => r.run_id === 'r7')
  assert.equal(unicodeRecord.task, bigUnicode)
})

test('optimise-read: parseLedgerContent never throws on empty input, and reports an empty result', () => {
  const { records, skipped } = mod.parseLedgerContent('')
  assert.deepEqual(records, [])
  assert.deepEqual(skipped, [])
})

test('optimise-read: parseLedgerContent counts a line missing run_id, ts or repo as skipped with a reason naming the field, but keeps a line with all envelope fields present regardless of extra unknown ones', () => {
  const missingRunId = JSON.stringify({ schema_version: 1, ts: 't', repo: 'demo', kind: 'tdd_task', write_ok: true, write_error: null })
  const missingTs = JSON.stringify({ schema_version: 1, run_id: 'x', repo: 'demo', kind: 'tdd_task', write_ok: true, write_error: null })
  const missingRepo = JSON.stringify({ schema_version: 1, run_id: 'x', ts: 't', kind: 'tdd_task', write_ok: true, write_error: null })
  const { records, skipped } = mod.parseLedgerContent([missingRunId, missingTs, missingRepo].join('\n'))
  assert.equal(records.length, 0)
  assert.equal(skipped.length, 3)
  assert.ok(skipped[0].reason.includes('run_id'))
  assert.ok(skipped[1].reason.includes('ts'))
  assert.ok(skipped[2].reason.includes('repo'))
})

// ---- windowRecords: bounded read (AC-ARCH-14) ----

test('optimise-read: windowRecords keeps only the most recent maxLines records and reports truncated:true with the dropped count, proven against a >=2000-line synthetic fixture', () => {
  const records = []
  for (let i = 0; i < 2500; i++) {
    records.push({ schema_version: 1, run_id: `r${i}`, ts: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, repo: 'demo', kind: 'tdd_task', outcome: 'done', __seq: i })
  }
  const { windowed, truncated, droppedCount } = mod.windowRecords(records, 2000)
  assert.equal(windowed.length, 2000)
  assert.equal(truncated, true)
  assert.equal(droppedCount, 500)
  // Keeps the LAST 2000 (most recent), not the first 2000.
  assert.equal(windowed[0].__seq, 500)
  assert.equal(windowed[windowed.length - 1].__seq, 2499)
})

test('optimise-read: windowRecords reports truncated:false and droppedCount:0 when the input is already within the window', () => {
  const records = [{ run_id: 'a' }, { run_id: 'b' }]
  const { windowed, truncated, droppedCount } = mod.windowRecords(records, 2000)
  assert.equal(windowed.length, 2)
  assert.equal(truncated, false)
  assert.equal(droppedCount, 0)
})

// ---- aggregateRework: known-fixture, hand-computed counts (AC-QA-21, AC-DATA-7) ----

test('optimise-read: aggregateRework produces byte-identical, hand-computable counts from a known fixture, keyed by (repo, spec, ac_id) not by AC id alone (AC-DATA-7)', () => {
  const records = [
    {
      kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', round_key: 'sha1', outcome: 'done',
      findings: [
        { id: 'f1', lens: 'lens-security', severity: 'High', ac_id: 'AC-SEC-1', disposition: 'rejected' },
        { id: 'f2', lens: 'lens-qa', severity: 'Low', ac_id: null, disposition: 'spec_bug' },
        { id: 'f3', lens: 'lens-security', severity: 'Medium', ac_id: 'AC-SEC-2', disposition: 'open' },
      ],
      ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'PASS' }, { ac_id: 'AC-SEC-1', verdict: 'FAIL' }],
    },
    {
      kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', round_key: 'sha2', outcome: 'done',
      findings: [{ id: 'f4', lens: 'lens-security', severity: 'Low', ac_id: 'AC-SEC-1', disposition: 'rejected' }],
      ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'PASS' }],
    },
    {
      // Same AC id, DIFFERENT spec -- must report as a separate criterion
      // (AC-DATA-7: two different specs each containing AC-QA-1 report as
      // two criteria), not merged with specs/a.md's AC-QA-1 above.
      kind: 'review_cycle', repo: 'demo', spec: 'specs/b.md', round_key: 'sha3', outcome: 'done',
      findings: [],
      ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'FAIL' }],
    },
  ]

  const result = mod.aggregateRework(records)
  assert.equal(result.n, 3)

  // Hand-computed: lens-security has 2 rejected + 1 open across the fixture;
  // lens-qa has 1 spec_bug.
  assert.deepEqual(result.lensDispositionCounts['lens-security'], { fixed: 0, rejected: 2, spec_bug: 0, open: 1 })
  assert.deepEqual(result.lensDispositionCounts['lens-qa'], { fixed: 0, rejected: 0, spec_bug: 1, open: 0 })

  // AC-QA-1 under specs/a.md: 2 PASS, 0 FAIL. AC-QA-1 under specs/b.md: 0
  // PASS, 1 FAIL. Distinct keys despite the identical AC id.
  const keyA = 'demo|specs/a.md|AC-QA-1'
  const keyB = 'demo|specs/b.md|AC-QA-1'
  assert.notEqual(keyA, keyB)
  assert.deepEqual(result.acVerdicts.get(keyA), { repo: 'demo', spec: 'specs/a.md', ac_id: 'AC-QA-1', pass: 2, fail: 0, unverifiable: 0, n: 2 })
  assert.deepEqual(result.acVerdicts.get(keyB), { repo: 'demo', spec: 'specs/b.md', ac_id: 'AC-QA-1', pass: 0, fail: 1, unverifiable: 0, n: 1 })
  assert.deepEqual(result.acVerdicts.get('demo|specs/a.md|AC-SEC-1'), { repo: 'demo', spec: 'specs/a.md', ac_id: 'AC-SEC-1', pass: 0, fail: 1, unverifiable: 0, n: 1 })
})

test('optimise-read: aggregateRework called twice on the identical fixture produces byte-identical JSON output (AC-QA-21)', () => {
  const records = [{ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', round_key: 's1', outcome: 'done', findings: [{ id: 'f1', lens: 'lens-qa', severity: 'Low', ac_id: null, disposition: 'open' }], ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'PASS' }] }]
  const a = mod.aggregateRework(records)
  const b = mod.aggregateRework(records)
  assert.equal(JSON.stringify(a, mapReplacer), JSON.stringify(b, mapReplacer))
})
function mapReplacer(key, value) {
  return value instanceof Map ? [...value.entries()].sort() : value
}

test('optimise-read: neverFailingAcs labels a below-minimum (spec,ac) pair insufficient_data and never proposes it as a removal candidate, and marks a genuinely all-PASS pair with enough runs as never_failed with its window stated (AC-DATA-8)', () => {
  const records = []
  for (let i = 0; i < 2; i++) {
    records.push({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', round_key: `s${i}`, outcome: 'done', findings: [], ac_verdicts: [{ ac_id: 'AC-LOW-1', verdict: 'PASS' }] })
  }
  for (let i = 0; i < 5; i++) {
    records.push({ kind: 'review_cycle', repo: 'demo', spec: 'specs/b.md', round_key: `t${i}`, outcome: 'done', findings: [], ac_verdicts: [{ ac_id: 'AC-HIGH-1', verdict: 'PASS' }] })
  }
  const rework = mod.aggregateRework(records)
  const result = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 5 })
  const low = result.find((r) => r.ac_id === 'AC-LOW-1')
  const high = result.find((r) => r.ac_id === 'AC-HIGH-1')
  assert.equal(low.insufficient_data, true)
  assert.equal(low.n, 2)
  assert.equal(high.insufficient_data, false)
  assert.equal(high.never_failed, true)
  assert.equal(high.n, 5)
})

test('optimise-read: neverFailingAcs does not mark never_failed for a pair with at least one FAIL, even with n well above the minimum', () => {
  const records = []
  for (let i = 0; i < 6; i++) {
    records.push({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', round_key: `s${i}`, outcome: 'done', findings: [], ac_verdicts: [{ ac_id: 'AC-X-1', verdict: i === 3 ? 'FAIL' : 'PASS' }] })
  }
  const rework = mod.aggregateRework(records)
  const result = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 5 })
  const x = result.find((r) => r.ac_id === 'AC-X-1')
  assert.equal(x.never_failed, false)
  assert.equal(x.insufficient_data, false)
})

// ---- aggregateWallClock: conduct_plan_event pairing (AC-ARCH-13, AC-OPS-12, AC-QA-10) ----

test('optimise-read: aggregateWallClock pairs ci_wait_started/ended by plan, sums real durations, sourced only from the ledger', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/a.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:05:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'human_wait_started', event_key: 'specs/a.md:T1:human_wait_started:1', ts: '2026-08-01T01:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'human_wait_ended', event_key: 'specs/a.md:T1:human_wait_ended:1', ts: '2026-08-01T02:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'run-start-1', ts: '2026-08-01T03:00:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  const plan = result.byPlan.get('specs/a.md')
  assert.equal(plan.ciWaitSeconds, 300)
  assert.equal(plan.ciWaitN, 1)
  assert.equal(plan.humanWaitSeconds, 3600)
  assert.equal(plan.humanWaitN, 1)
  assert.equal(result.source.ci_wait, 'ledger:conduct_plan_event')
  assert.equal(result.source.human_wait, 'ledger:conduct_plan_event')
  assert.equal(result.source.agent_compute, 'ledger:tdd_task|review_cycle|plan_cycle start/terminal pair')
})

test('optimise-read: aggregateWallClock reports an unmatched trailing start as unterminated_waits, never as a zero-length or open-to-now interval (AC-OPS-12)', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  const plan = result.byPlan.get('specs/a.md')
  assert.equal(plan.ciWaitN, 0)
  assert.equal(plan.unterminatedWaits, 1)
})

test('optimise-read: aggregateWallClock reports a negative/out-of-order interval as unusable with a reason, never averaged, defaulted to zero, or silently dropped (AC-QA-10)', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:1', ts: '2026-08-01T01:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/a.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:00:00.000Z' }, // ends BEFORE it starts
  ]
  const result = mod.aggregateWallClock(records)
  const plan = result.byPlan.get('specs/a.md')
  assert.equal(plan.ciWaitN, 0, 'a negative interval must not be counted toward the valid-duration total')
  assert.equal(plan.unusableIntervals.length, 1)
  assert.ok(plan.unusableIntervals[0].reason.includes('negative') || plan.unusableIntervals[0].reason.includes('order'))
})

// ---- aggregateTriggerAccuracy (spec item 4) ----

test('optimise-read: aggregateTriggerAccuracy distinguishes CLEAN-with-nothing-in-scope from CLEAN-after-looking, per lens', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', lenses_run: ['lens-operability'], trigger_counts: { 'lens-operability': 0 }, verdicts: { 'lens-operability': 'CLEAN' } },
    { kind: 'review_cycle', repo: 'demo', lenses_run: ['lens-operability'], trigger_counts: { 'lens-operability': 4 }, verdicts: { 'lens-operability': 'CLEAN' } },
    { kind: 'review_cycle', repo: 'demo', lenses_run: ['lens-operability'], trigger_counts: { 'lens-operability': 3 }, verdicts: { 'lens-operability': 'FINDINGS' } },
  ]
  const result = mod.aggregateTriggerAccuracy(records)
  const ops = result.byLens['lens-operability']
  assert.equal(ops.cleanWithZeroTrigger, 1)
  assert.equal(ops.cleanWithMatches, 1)
  assert.equal(ops.findingsWithMatches, 1)
  assert.equal(ops.total, 3)
})

// ---- aggregateCi (AC-DATA-8, AC-QA-19 shape) ----

test('optimise-read: aggregateCi marks a job never_failed only with a stated window (start, n, truncation flag) and only at/above the minimum run count', () => {
  const runs = []
  for (let i = 0; i < 6; i++) {
    runs.push({ workflow: 'ci.yml', job: 'test', conclusion: 'success', started_at: `2026-08-0${i + 1}T00:00:00Z`, duration_s: 100 })
  }
  const result = mod.aggregateCi(runs, { minRunsNeverFailed: 5, requestedLimit: 100 })
  const job = result.byJob.get('ci.yml::test')
  assert.equal(job.n, 6)
  assert.equal(job.neverFailed, true)
  assert.equal(job.windowStart, '2026-08-01T00:00:00Z')
  assert.equal(job.truncated, false) // 6 runs returned, requestedLimit 100 -- not truncated
})

test('optimise-read: aggregateCi labels a job below the minimum run count insufficient_data, with no never_failed claim emitted', () => {
  const runs = [{ workflow: 'ci.yml', job: 'lint', conclusion: 'success', started_at: '2026-08-01T00:00:00Z', duration_s: 10 }]
  const result = mod.aggregateCi(runs, { minRunsNeverFailed: 5, requestedLimit: 100 })
  const job = result.byJob.get('ci.yml::lint')
  assert.equal(job.insufficientData, true)
  assert.equal(job.neverFailed, null)
})

test('optimise-read: aggregateCi sets truncated:true when the returned run count equals the requested limit (the true window may extend further back than what was fetched)', () => {
  const runs = []
  for (let i = 0; i < 5; i++) runs.push({ workflow: 'ci.yml', job: 'test', conclusion: 'success', started_at: `2026-08-0${i + 1}T00:00:00Z`, duration_s: 10 })
  const result = mod.aggregateCi(runs, { minRunsNeverFailed: 5, requestedLimit: 5 })
  assert.equal(result.byJob.get('ci.yml::test').truncated, true)
})

// ---- citationPool (AC-QA-20, AC-ARCH-14) ----

test('optimise-read: citationPool is deduplicated, most-recent-first, capped at the stated size, and contains only real run_ids present in the window', () => {
  const records = []
  for (let i = 0; i < 60; i++) records.push({ run_id: `run-${i}` })
  records.push({ run_id: 'run-0' }) // a duplicate re-appended later must not appear twice, and its position counts as the most-recent occurrence
  const pool = mod.citationPool(records, 50)
  assert.equal(pool.length, 50)
  assert.equal(new Set(pool).size, 50, 'no duplicates')
  assert.equal(pool[0], 'run-0', 'the most recent occurrence of a run_id wins position, even if it also appeared earlier')
  for (const id of pool) assert.ok(records.some((r) => r.run_id === id), `${id} must be a real run_id present in the window`)
})

test('optimise-read: citationPool skips records with no run_id rather than emitting undefined citations', () => {
  const records = [{ run_id: 'a' }, {}, { run_id: null }, { run_id: 'b' }]
  const pool = mod.citationPool(records, 50)
  assert.deepEqual(pool.sort(), ['a', 'b'])
})

test('optimise-read CLI: the ledger command\'s output includes a citationPool of real run_ids from the window', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.citationPool.length, 1)
  assert.match(out.citationPool[0], /^[0-9a-f-]{36}$/, 'expected a real UUID run_id from the written ledger line')
})

// ---- stableProposalId (AC-DATA-10) ----

test('optimise-read: stableProposalId is derived from the target descriptor, not wording -- two calls describing the same target with different prose yield the same id, and a genuinely different target yields a different id', () => {
  const idA1 = mod.stableProposalId({ category: 'ci_demote', workflow_file: '.github/workflows/ci.yml', job_name: 'lint' })
  const idA2 = mod.stableProposalId({ category: 'ci_demote', workflow_file: '.github/workflows/ci.yml', job_name: 'lint' })
  const idB = mod.stableProposalId({ category: 'ci_demote', workflow_file: '.github/workflows/ci.yml', job_name: 'test' })
  assert.equal(idA1, idA2)
  assert.notEqual(idA1, idB)
  assert.match(idA1, /^[0-9a-f]{16}$/)
})

// ---- CLI integration: real fs, real repo, no mutation of anything but the read (AC-SEC-9 partial proof) ----

test('optimise-read CLI: `node optimise-read.mjs ledger <root>` reads a real ledger written by ledger-append.mjs and prints an aggregate JSON to stdout, without modifying the ledger file (byte-identical before/after, mtime unchanged)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const ledgerPath = path.join(repo, '.claude', 'harness-ledger.jsonl')
  const before = fs.readFileSync(ledgerPath)
  const statBefore = fs.statSync(ledgerPath)

  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.n, 2)

  const after = fs.readFileSync(ledgerPath)
  const statAfter = fs.statSync(ledgerPath)
  assert.ok(before.equals(after), 'the ledger file must be byte-identical after a read-only aggregation pass')
  assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, 'the ledger mtime must be unchanged (no write touched it)')
})

test('optimise-read CLI: `node optimise-read.mjs ledger <root>` on a repo with no ledger file reports n:0 and does not create one (AC-QA-17 fixture at n=0)', () => {
  const repo = makeTempRepo()
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.n, 0)
  assert.equal(fs.existsSync(path.join(repo, '.claude', 'harness-ledger.jsonl')), false, 'reading must never create the ledger file')
})
