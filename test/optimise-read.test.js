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
// Bucket keys are `${repo}|${plan}` (AC-DATA-7, review round-1 M5): the
// same plan/spec path in two different repos must never merge.

test('optimise-read: aggregateWallClock pairs ci_wait_started/ended by (repo, plan), sums real durations, sourced only from the ledger', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/a.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:05:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'human_wait_started', event_key: 'specs/a.md:T1:human_wait_started:1', ts: '2026-08-01T01:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'human_wait_ended', event_key: 'specs/a.md:T1:human_wait_ended:1', ts: '2026-08-01T02:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'run-start-1', ts: '2026-08-01T03:00:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  const plan = result.byPlan.get('demo|specs/a.md')
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
  const plan = result.byPlan.get('demo|specs/a.md')
  assert.equal(plan.ciWaitN, 0)
  assert.equal(plan.unterminatedWaits, 1)
})

test('optimise-read: aggregateWallClock reports a negative/out-of-order interval as unusable with a reason, never averaged, defaulted to zero, or silently dropped (AC-QA-10)', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:1', ts: '2026-08-01T01:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/a.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:00:00.000Z' }, // ends BEFORE it starts
  ]
  const result = mod.aggregateWallClock(records)
  const plan = result.byPlan.get('demo|specs/a.md')
  assert.equal(plan.ciWaitN, 0, 'a negative interval must not be counted toward the valid-duration total')
  assert.equal(plan.unusableIntervals.length, 1)
  assert.ok(plan.unusableIntervals[0].reason.includes('negative') || plan.unusableIntervals[0].reason.includes('order'))
})

// ---- Review round-1 M3 (AC-QA-10 / AC-QA-16): an unparseable timestamp must never produce a fabricated duration ----

test('optimise-read: aggregateWallClock treats an unparseable ts on the STARTED event as unusable, not a ~56-year garbage duration (AC-QA-10, M3)', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:1', ts: 'not-a-real-timestamp' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/a.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:05:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  const plan = result.byPlan.get('demo|specs/a.md')
  assert.equal(plan.ciWaitN, 0, 'must not count a pair with an unparseable timestamp as a valid duration')
  assert.equal(plan.ciWaitSeconds, 0)
  assert.equal(plan.unusableIntervals.length, 1)
  assert.match(plan.unusableIntervals[0].reason, /unparseable|invalid|timestamp/i)
})

test('optimise-read: aggregateWallClock treats an unparseable ts on the ENDED event the same way (both sides guarded, not just started) (AC-QA-10, M3)', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'human_wait_started', event_key: 'specs/a.md:T1:human_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'human_wait_ended', event_key: 'specs/a.md:T1:human_wait_ended:1', ts: 'garbage' },
  ]
  const result = mod.aggregateWallClock(records)
  const plan = result.byPlan.get('demo|specs/a.md')
  assert.equal(plan.humanWaitN, 0)
  assert.equal(plan.humanWaitSeconds, 0)
  assert.equal(plan.unusableIntervals.length, 1)
  // Round-3 F6 (§11 incidentally-passing guard): without this assertion,
  // deleting the `|| e.ms === null` half of the null-guard (M8) still
  // passed every assertion above -- a null e.ms coerces to 0 in
  // `e.ms - s.ms`, producing a NEGATIVE duration that the pre-existing
  // "negative or out of order" fallback also excludes, so ciWaitN/Seconds
  // and the unusableIntervals COUNT all still came out identical. Only the
  // REASON text differs between the two code paths, and only pinning it
  // here (as the STARTED test above already does) proves the end-side
  // null guard specifically, not its negative-duration neighbour.
  assert.match(plan.unusableIntervals[0].reason, /unparseable|invalid|timestamp/i, 'the reason must name an unparseable timestamp, not merely "negative or out of order" (which a null e.ms would ALSO incidentally satisfy)')
})

// ---- Review round-1 M4 (AC-OPS-3): null-vs-zero for wall-clock segments ----

test('optimise-read: aggregateWallClock tracks a per-segment unmeasured-run count, and totals report a segment as null (not 0) when it has zero measured runs but at least one unmeasured attempt (AC-OPS-3, M4)', () => {
  // A ci_wait pair with an unparseable timestamp: one unmeasured attempt,
  // zero measured ci_wait runs anywhere in this fixture.
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:1', ts: 'bad-ts' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/a.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:05:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.ciWaitMeasuredRuns, 0)
  assert.equal(result.totals.ciWaitUnmeasuredRuns, 1)
  assert.equal(result.totals.ciWaitSeconds, null, 'zero measured + >=1 unmeasured must report null, distinguishable from a genuine zero')
})

test('optimise-read: aggregateWallClock totals report a genuine 0 (not null) when a segment has zero measured AND zero unmeasured runs -- nothing of that kind happened at all', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'human_wait_started', event_key: 'specs/a.md:T1:human_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'human_wait_ended', event_key: 'specs/a.md:T1:human_wait_ended:1', ts: '2026-08-01T00:10:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  // ci_wait never appears anywhere in this fixture: genuinely nothing happened -- 0, not null.
  assert.equal(result.totals.ciWaitMeasuredRuns, 0)
  assert.equal(result.totals.ciWaitUnmeasuredRuns, 0)
  assert.equal(result.totals.ciWaitSeconds, 0)
})

test('optimise-read: aggregateWallClock totals keep the real measured sum even when the SAME segment also has unmeasured runs elsewhere (partial measurement is reported, not nulled out entirely)', () => {
  const records = [
    // Plan A: a genuinely measured 100s ci_wait.
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/a.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:01:40.000Z' },
    // Plan B: an unmeasured (bad timestamp) ci_wait attempt.
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/b.md:T1:ci_wait_started:1', ts: 'bad-ts' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/b.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:05:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.ciWaitMeasuredRuns, 1)
  assert.equal(result.totals.ciWaitUnmeasuredRuns, 1)
  assert.equal(result.totals.ciWaitSeconds, 100, 'a real measured value must survive, not be nulled just because another plan had an unmeasured attempt')
})

test('optimise-read: aggregateWallClock counts an orphan start (no terminal pair at all) toward agentComputeUnmeasuredRuns and reports the segment as null, not a silent zero (M4)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'orphan-1', ts: '2026-08-01T00:00:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeMeasuredRuns, 0)
  assert.equal(result.totals.agentComputeUnmeasuredRuns, 1, 'the orphan start must count as an unmeasured attempt, not be silently skipped uncounted')
  assert.equal(result.totals.agentComputeSeconds, null)
})

test('optimise-read: aggregateWallClock counts a pair with an unparseable timestamp on either side toward agentComputeUnmeasuredRuns (not just the wait-event pairing)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'bad-ts-1', ts: 'not-a-timestamp' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'bad-ts-1', ts: '2026-08-01T00:05:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeMeasuredRuns, 0)
  assert.equal(result.totals.agentComputeUnmeasuredRuns, 1)
  assert.equal(result.totals.agentComputeSeconds, null)
})

// ---- Review round-1 M5 (AC-DATA-7): wall-clock must key by (repo, plan), never plan alone ----

test('optimise-read: aggregateWallClock keeps two repos with the IDENTICAL spec path in separate buckets, never merged (AC-DATA-7, M5)', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'repoA', event: 'ci_wait_started', event_key: 'specs/x.md:T1:ci_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'repoA', event: 'ci_wait_ended', event_key: 'specs/x.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:01:00.000Z' }, // 60s
    { kind: 'conduct_plan_event', repo: 'repoB', event: 'ci_wait_started', event_key: 'specs/x.md:T1:ci_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'repoB', event: 'ci_wait_ended', event_key: 'specs/x.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:10:00.000Z' }, // 600s
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.byPlan.size, 2, 'must produce TWO buckets, not one merged bucket')
  const a = result.byPlan.get('repoA|specs/x.md')
  const b = result.byPlan.get('repoB|specs/x.md')
  assert.ok(a && b, 'both repo-scoped keys must exist')
  assert.equal(a.ciWaitSeconds, 60)
  assert.equal(b.ciWaitSeconds, 600)
  assert.equal(a.repo, 'repoA')
  assert.equal(b.repo, 'repoB')
  assert.equal(a.plan, 'specs/x.md')
  assert.equal(b.plan, 'specs/x.md')
})

// ---- Review round-2 M1 (reframe, no AC -- spec bug): pairing by sorted-timestamp INDEX is unrepresentable ----
//
// Round 1 fixed two symptoms of the same underlying defect (a null
// timestamp fabricating a duration; a plan/repo merge); round 2 found a
// THIRD: pairing started/ended by SORTED INDEX WITHIN A BUCKET, rather than
// by the occurrence discriminator already present in event_key, mispairs
// an orphan ended event with an unrelated started event and silently drops
// the real ended event it belonged with. The fix pairs by the full
// event_key occurrence key (plan:task:occurrence, event-name-independent)
// so an orphan on EITHER side can never be mispaired with an unrelated
// event on the other side -- making the whole class of bug unrepresentable
// rather than patching this one instance.

test('optimise-read: aggregateWallClock pairs started/ended by event_key OCCURRENCE, not sorted-timestamp index -- an orphan ci_wait_ended (occurrence :1, no matching started) does not mispair with a later real pair (occurrence :2), and the real pair is measured correctly (review round-2 M1, reproduces the reviewer\'s exact fixture)', () => {
  const records = [
    // Orphan ended at occurrence 1 -- its own started event was lost (e.g. a crash/resume or a torn ledger line).
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/a.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:00:10.000Z' },
    // A genuine, complete pair at occurrence 2: a real 20s wait.
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:2', ts: '2026-08-01T01:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/a.md:T1:ci_wait_ended:2', ts: '2026-08-01T01:00:20.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  const plan = result.byPlan.get('demo|specs/a.md')
  // The real pair (occurrence :2) must be measured as exactly 20s, not
  // mispaired with the orphan (which would produce a wrong duration).
  assert.equal(plan.ciWaitN, 1, 'exactly one valid measured pair')
  assert.equal(plan.ciWaitSeconds, 20, 'the real pair\'s true 20s duration, not a value computed from the orphan')
  // The orphan ended event must be counted, with a reason, never silently
  // dropped and never treated as a second valid measurement.
  assert.equal(plan.ciWaitUnmeasuredN, 1, 'the orphan ended event counts as one unmeasured attempt')
  const orphanEntries = plan.unusableIntervals.filter((u) => /no matching started|orphan/i.test(u.reason))
  assert.equal(orphanEntries.length, 1, 'the orphan must be recorded with a reason, not silently dropped')
})

test('optimise-read: aggregateWallClock -- an orphan ended event is never paired with an UNRELATED started event even when there is exactly one of each (the mispairing shape the old sorted-index code produced)', () => {
  const records = [
    // Occurrence :1 ended only (orphan); occurrence :2 started only
    // (unterminated) -- with the OLD sorted-index pairing, these two single-
    // element arrays would pair as one "valid" 10-minute interval. They
    // must NOT: they belong to different occurrences and must both be
    // reported as their own distinct unmeasured/unterminated attempt.
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/a.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:10:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:2', ts: '2026-08-01T00:00:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  const plan = result.byPlan.get('demo|specs/a.md')
  assert.equal(plan.ciWaitN, 0, 'must not fabricate a measured pair from two unrelated orphans')
  assert.equal(plan.ciWaitSeconds, 0)
  assert.equal(plan.unterminatedWaits, 1, 'the lone started (occurrence :2) is unterminated')
  assert.equal(plan.ciWaitUnmeasuredN, 2, 'both orphans count toward unmeasured -- the started AND the ended')
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

// Review round-1 L1 (AC-OPS-3): a null (unmeasured) trigger_count on a
// CLEAN run must not be folded into cleanWithMatches -- it is neither
// "looked and found nothing" nor "nothing in scope", it is unmeasured.
test('optimise-read: aggregateTriggerAccuracy buckets a CLEAN run with a null trigger_count separately as cleanTriggerUnmeasured, not folded into cleanWithMatches (AC-OPS-3, L1)', () => {
  const records = [
    // lens-operability ran and is CLEAN but never reported a trigger_count at all (absent from trigger_counts).
    { kind: 'review_cycle', repo: 'demo', lenses_run: ['lens-operability'], trigger_counts: {}, verdicts: { 'lens-operability': 'CLEAN' } },
    // A genuinely-measured CLEAN-with-matches run, for contrast -- must still land in cleanWithMatches.
    { kind: 'review_cycle', repo: 'demo', lenses_run: ['lens-operability'], trigger_counts: { 'lens-operability': 4 }, verdicts: { 'lens-operability': 'CLEAN' } },
  ]
  const result = mod.aggregateTriggerAccuracy(records)
  const ops = result.byLens['lens-operability']
  assert.equal(ops.cleanTriggerUnmeasured, 1)
  assert.equal(ops.cleanWithMatches, 1, 'the unmeasured run must not inflate cleanWithMatches')
  assert.equal(ops.cleanWithZeroTrigger, 0)
  assert.equal(ops.total, 2)
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

// ---- Review round-1 M6 (AC-DATA-8): a truncated window or a suspected rename must never back a "never failed" claim ----

test('optimise-read: aggregateCi reports neverFailed:null (not true) when the window is truncated, even though every fetched run succeeded -- PROBE2 from the review, reproduced as a fixture', () => {
  const runs = []
  for (let i = 0; i < 100; i++) runs.push({ workflow: 'ci.yml', job: 'test', conclusion: 'success', started_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`, duration_s: 10 })
  const result = mod.aggregateCi(runs, { minRunsNeverFailed: 5, requestedLimit: 100 })
  const job = result.byJob.get('ci.yml::test')
  assert.equal(job.truncated, true, 'sanity: 100 runs at requestedLimit=100 must be flagged truncated')
  assert.equal(job.insufficientData, false, 'sanity: n=100 is well above the minimum, so this is NOT the insufficient-data path')
  assert.equal(job.neverFailed, null, 'a truncated window must never back a never-failed claim, regardless of sample size')
})

test('optimise-read: aggregateCi flags a job whose first observed run starts AFTER the window\'s true earliest run as renameSuspect, and does not emit a never-failed claim for it -- PROBE3 from the review, reproduced as a fixture', () => {
  const runs = []
  // "unit" ran across the whole window (the true earliest history).
  for (let i = 0; i < 8; i++) runs.push({ workflow: 'ci.yml', job: 'unit', conclusion: 'success', started_at: `2026-01-0${i + 1}T00:00:00Z`, duration_s: 10 })
  // "unit-tests" is the renamed job: its own history starts well AFTER "unit"'s earliest run.
  for (let i = 0; i < 8; i++) runs.push({ workflow: 'ci.yml', job: 'unit-tests', conclusion: 'success', started_at: `2026-02-0${i + 1}T00:00:00Z`, duration_s: 10 })
  const result = mod.aggregateCi(runs, { minRunsNeverFailed: 5, requestedLimit: 100 })
  const renamed = result.byJob.get('ci.yml::unit-tests')
  const original = result.byJob.get('ci.yml::unit')
  assert.equal(renamed.renameSuspect, true)
  assert.equal(renamed.neverFailed, null, 'a rename-suspect job must not carry a never-failed claim, even with a clean run history under its own name')
  assert.equal(original.renameSuspect, false, 'the job whose history reaches back to the window\'s true earliest run is not itself a rename suspect')
})

test('optimise-read: aggregateCi does NOT flag renameSuspect for the only job in the dataset (nothing to compare its start against)', () => {
  const runs = []
  for (let i = 0; i < 6; i++) runs.push({ workflow: 'ci.yml', job: 'solo', conclusion: 'success', started_at: `2026-01-0${i + 1}T00:00:00Z`, duration_s: 10 })
  const result = mod.aggregateCi(runs, { minRunsNeverFailed: 5, requestedLimit: 100 })
  assert.equal(result.byJob.get('ci.yml::solo').renameSuspect, false)
})

// ---- citationPool (AC-QA-20, AC-ARCH-14) ----

test('optimise-read: citationPool is deduplicated, most-recent-first, capped at the stated size, and contains only real run_ids present in the window', () => {
  const records = []
  for (let i = 0; i < 60; i++) records.push({ run_id: `run-${i}` })
  // 20 MORE duplicate occurrences of 'run-59' appended after the original
  // 60, landing well inside the scan window (size 50): without dedup, these
  // alone would fill 20+ of the 50 pool slots with the same id, so the
  // "no duplicates" assertion below is genuinely discriminating -- a single
  // trailing duplicate (the original version of this fixture) coincidentally
  // never got revisited within the scan window and let a broken dedup check
  // pass silently (a real, self-caught vacuous mutant; see
  // docs/pr2-mutation-proofs.md).
  for (let i = 0; i < 20; i++) records.push({ run_id: 'run-59' })
  const pool = mod.citationPool(records, 50)
  assert.equal(pool.length, 50)
  assert.equal(new Set(pool).size, 50, 'no duplicates')
  assert.equal(pool[0], 'run-59', 'the most recent occurrence of a run_id wins position, even if it also appeared earlier')
  for (const id of pool) assert.ok(records.some((r) => r.run_id === id), `${id} must be a real run_id present in the window`)
})

test('optimise-read: citationPool skips records with no run_id rather than emitting undefined citations', () => {
  const records = [{ run_id: 'a' }, {}, { run_id: null }, { run_id: 'b' }]
  const pool = mod.citationPool(records, 50)
  assert.deepEqual(pool.sort(), ['a', 'b'])
})

test('optimise-read CLI: the ledger command\'s output includes proposalOutcomes, computed for a real proposal_rejected line (AC-DATA-10, M7)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', event: 'proposal_rejected', event_scope: 'abc123:proposal_rejected' })
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.proposalOutcomes['abc123'].rejectedCount, 1)
})

test('optimise-read CLI: the ledger command\'s output includes a citationPool of real run_ids from the window', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.citationPool.length, 1)
  assert.match(out.citationPool[0], /^[0-9a-f-]{36}$/, 'expected a real UUID run_id from the written ledger line')
})

// ---- escaped-defect counter-metric (AC-PROD-7): a stated, script-computed heuristic ----

test('optimise-read: countEscapedDefectCandidates counts commit subjects matching the conventional "fix:" type deterministically, ignoring case and an optional scope, and states its own method/limitation', () => {
  const commits = [
    { sha: 'a1', subject: 'fix: repair the torn-line heal' },
    { sha: 'a2', subject: 'Fix(ledger): handle a short write' },
    { sha: 'a3', subject: 'feat: add the optimiser' },
    { sha: 'a4', subject: 'fixture: not a fix, must not match on substring alone' },
    { sha: 'a5', subject: 'docs: mention fix: in prose, must not match mid-string' },
  ]
  const result = mod.countEscapedDefectCandidates(commits)
  assert.equal(result.count, 2)
  assert.equal(result.n_commits_examined, 5)
  assert.ok(/heuristic|proxy/i.test(result.method), 'must state this is a heuristic proxy, not a causal per-PR attribution')
})

test('optimise-read: countEscapedDefectCandidates on an empty commit list reports count:0 and n_commits_examined:0, never throwing', () => {
  const result = mod.countEscapedDefectCandidates([])
  assert.equal(result.count, 0)
  assert.equal(result.n_commits_examined, 0)
})

// ---- Review round-1 M7 (AC-DATA-10): reading proposal_adopted/rejected/reverted events, keyed by proposal_id ----

test('optimise-read: aggregateProposalOutcomes keys conduct_plan_event proposal_* lines by proposal_id (the first segment of event_key), counting each outcome kind separately', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'proposal_rejected', event_key: 'abc123:proposal_rejected:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'proposal_adopted', event_key: 'def456:proposal_adopted:1', ts: '2026-08-02T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'proposal_reverted', event_key: 'def456:proposal_reverted:1', ts: '2026-08-03T00:00:00.000Z' },
  ]
  const result = mod.aggregateProposalOutcomes(records)
  assert.equal(result.get('abc123').rejectedCount, 1)
  assert.equal(result.get('abc123').adoptedCount, 0)
  assert.equal(result.get('def456').adoptedCount, 1)
  assert.equal(result.get('def456').revertedCount, 1)
})

test('optimise-read: aggregateProposalOutcomes reports the most recent rejection timestamp, and flags revertedTwiceOrMore only at >=2 reverts (AC-DATA-10)', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'proposal_rejected', event_key: 'abc123:proposal_rejected:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'proposal_rejected', event_key: 'abc123:proposal_rejected:2', ts: '2026-09-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'proposal_reverted', event_key: 'def456:proposal_reverted:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'proposal_reverted', event_key: 'def456:proposal_reverted:2', ts: '2026-09-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'proposal_reverted', event_key: 'ghi789:proposal_reverted:1', ts: '2026-08-01T00:00:00.000Z' },
  ]
  const result = mod.aggregateProposalOutcomes(records)
  assert.equal(result.get('abc123').lastRejectionTs, '2026-09-01T00:00:00.000Z', 'must report the LATEST rejection, not the first')
  assert.equal(result.get('def456').revertedTwiceOrMore, true)
  assert.equal(result.get('ghi789').revertedTwiceOrMore, false, 'a single revert must not trip the >=2 flag')
})

test('optimise-read: aggregateProposalOutcomes ignores conduct_plan_event lines whose event is not one of the three proposal-outcome kinds (e.g. ci_wait_started), and never throws on a malformed event_key', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'proposal_adopted', event_key: 'onlyoneseg', ts: '2026-08-01T00:00:00.000Z' }, // malformed: no ":event:occurrence"
    { kind: 'tdd_task', repo: 'demo', outcome: 'done' },
  ]
  const result = mod.aggregateProposalOutcomes(records)
  assert.equal(result.size, 0, 'the ci_wait line and the malformed proposal line must not produce a bogus entry')
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

// ---- Review round-2 M2 (AC-DATA-10): a bare Object.keys(target).sort() replacer only sorts the TOP level; JSON.stringify's replacer array is re-applied at every nesting level, so a nested key not present at top level is dropped entirely, and every nested object serialises to "{}" regardless of its content ----

test('optimise-read: stableProposalId does NOT collide two distinct targets that differ only in a NESTED field -- reproduces the reviewer\'s exact collision ({trigger:{glob:"*.js"}} vs {trigger:{glob:"*.py"}}) (AC-DATA-10, M2)', () => {
  const idJs = mod.stableProposalId({ category: 'trigger_tune', trigger: { glob: '*.js' } })
  const idPy = mod.stableProposalId({ category: 'trigger_tune', trigger: { glob: '*.py' } })
  assert.notEqual(idJs, idPy, 'two targets differing only in a nested field must not collide')
})

test('optimise-read: stableProposalId is stable regardless of KEY ORDER at any nesting depth, not just the top level', () => {
  const idOrderA = mod.stableProposalId({ category: 'trigger_tune', trigger: { glob: '*.js', mode: 'narrow' } })
  const idOrderB = mod.stableProposalId({ trigger: { mode: 'narrow', glob: '*.js' }, category: 'trigger_tune' })
  assert.equal(idOrderA, idOrderB, 'the same target, with keys reordered at both the top level and inside the nested object, must hash identically')
})

test('optimise-read: stableProposalId still yields the SAME id for the identical target across two calls after the fix (regression: the fix must not make a previously-stable id unstable)', () => {
  const target = { category: 'ci_demote', workflow_file: '.github/workflows/ci.yml', job_name: 'lint' }
  const id1 = mod.stableProposalId(target)
  const id2 = mod.stableProposalId({ category: 'ci_demote', workflow_file: '.github/workflows/ci.yml', job_name: 'lint' })
  assert.equal(id1, id2)
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

// ---- Review round-3 F5 (AC-QA-17, the untested PRIMARY production path): the two-repo ledger CLI invocation ----
//
// Every prior CLI test used exactly one root; the two-repo path is exactly
// what T4 runs against the real delivery repos, and it was never exercised
// with two REAL reads (only via a fixture, in the workflow-level tests).
// Untested specifically: cross-root record concatenation, the perRepo
// array from two real reads, and windowRecords' behaviour once the
// COMBINED total exceeds a small --window -- the first-listed repo's
// records sit at the HEAD of the concatenated array, so a window keeping
// only the TAIL drops them first regardless of true recency, while
// perRepo's own recordCount (computed BEFORE windowing, per-repo) can
// still show the repo's full count. This test proves that mismatch is
// VISIBLE in the existing output (n, windowTruncated, windowDroppedCount,
// perRepo), not merely a silent internal detail.

test('optimise-read CLI: `node optimise-read.mjs ledger <rootA> <rootB>` combines two REAL repos\' ledgers -- correct combined n, both perRepo entries with their own full counts, and the window-starvation mismatch (repoA listed first loses ALL its records to a small --window) is visible via windowTruncated/windowDroppedCount/perRepo, not silent (round-3 F5)', () => {
  const repoA = makeTempRepo()
  const repoB = makeTempRepo()
  for (let i = 0; i < 3; i++) runAppend(repoA, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  for (let i = 0; i < 5; i++) runAppend(repoB, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })

  const res = spawnSync('node', [MODULE_PATH, 'ledger', repoA, repoB, '--window=4'], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())

  // Combined n is windowed (8 total records, window=4), not the raw sum.
  assert.equal(out.n, 4, 'the windowed combined n must be exactly the --window value, not the raw 8-record total')
  assert.equal(out.windowTruncated, true)
  assert.equal(out.windowDroppedCount, 4, '8 combined records minus the 4-record window')

  // Both real repos must have their own perRepo entry with their OWN full
  // (pre-window) record count -- never merged, never dropped from perRepo
  // just because the window truncated the combined aggregate.
  assert.equal(out.perRepo.length, 2)
  const entryA = out.perRepo.find((e) => e.root === repoA)
  const entryB = out.perRepo.find((e) => e.root === repoB)
  assert.ok(entryA && entryB, 'both repos must have their own perRepo entry')
  assert.equal(entryA.recordCount, 3, "repoA's own full record count, computed before windowing")
  assert.equal(entryB.recordCount, 5, "repoB's own full record count, computed before windowing")

  // THE STARVATION, made visible: repoA is listed FIRST, so its 3 records
  // sit at the head of the concatenated [A,A,A,B,B,B,B,B] array; a window
  // keeping the last 4 keeps ONLY repoB's records (B2..B5) and drops every
  // one of repoA's, even though repoA's own perRepo entry still reports
  // recordCount:3. The sum of perRepo counts (8) diverging from the
  // windowed n (4) IS the visible reconciliation signal -- a caller
  // comparing them can detect exactly this starvation without any
  // additional field.
  const perRepoSum = out.perRepo.reduce((acc, e) => acc + e.recordCount, 0)
  assert.equal(perRepoSum, 8)
  assert.notEqual(perRepoSum, out.n, 'perRepo\'s summed full counts must diverge from the windowed n whenever starvation occurred -- this divergence is the detectable signal')
  assert.equal(out.citationPool.length, 4, 'the citation pool must be drawn from the WINDOWED set only (4), never the raw 8')
})

test('optimise-read CLI: `node optimise-read.mjs ledger <rootA> <rootB>` combines two real repos\' ledgers correctly when the window is large enough that NO starvation occurs (sanity: the mismatch above is a real window effect, not a bug in every multi-repo run)', () => {
  const repoA = makeTempRepo()
  const repoB = makeTempRepo()
  runAppend(repoA, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  runAppend(repoA, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  runAppend(repoB, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })

  const res = spawnSync('node', [MODULE_PATH, 'ledger', repoA, repoB], { encoding: 'utf8' }) // default window (2000), no starvation
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.n, 3)
  assert.equal(out.windowTruncated, false)
  assert.equal(out.windowDroppedCount, 0)
  const perRepoSum = out.perRepo.reduce((acc, e) => acc + e.recordCount, 0)
  assert.equal(perRepoSum, out.n, 'with no window truncation, perRepo\'s summed counts must equal n exactly -- no starvation, no divergence')
})

test('optimise-read CLI: `node optimise-read.mjs ids` reads a batch of proposal targets from stdin and returns a stable id per target, in order', () => {
  const payload = { targets: [{ category: 'ci_demote', job_name: 'lint' }, { category: 'ci_demote', job_name: 'test' }] }
  const res = spawnSync('node', [MODULE_PATH, 'ids'], { input: JSON.stringify(payload), encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.ids.length, 2)
  assert.match(out.ids[0].proposal_id, /^[0-9a-f]{16}$/)
  assert.notEqual(out.ids[0].proposal_id, out.ids[1].proposal_id)
})

test('optimise-read CLI: `node optimise-read.mjs escaped-defects` reads commits from stdin and returns the fix: count', () => {
  const payload = { commits: [{ sha: 'a', subject: 'fix: repair a heal' }, { sha: 'b', subject: 'feat: add a thing' }] }
  const res = spawnSync('node', [MODULE_PATH, 'escaped-defects'], { input: JSON.stringify(payload), encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.count, 1)
  assert.equal(out.n_commits_examined, 2)
})

test('optimise-read CLI: an unknown command name is reported as an error, not a crash', () => {
  const res = spawnSync('node', [MODULE_PATH, 'bogus-command'], { encoding: 'utf8' })
  assert.equal(res.status, 0)
  const out = JSON.parse(res.stdout.trim())
  assert.ok(out.error)
})

test('optimise-read CLI: `node optimise-read.mjs ledger <root>` on a repo with no ledger file reports n:0 and does not create one (AC-QA-17 fixture at n=0)', () => {
  const repo = makeTempRepo()
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.n, 0)
  assert.equal(fs.existsSync(path.join(repo, '.claude', 'harness-ledger.jsonl')), false, 'reading must never create the ledger file')
})
