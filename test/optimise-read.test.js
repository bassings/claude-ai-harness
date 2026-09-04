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
const { makeTempRepo, runAppend, trackTempDir, cleanupTempRepos, SUITE_TMPDIR, sh, LEDGER_REL } = require('./helpers/temp-repo.js')
const fs = require('node:fs')
const os = require('node:os')

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
  assert.deepEqual(result.acVerdicts.get(keyA), { repo: 'demo', spec: 'specs/a.md', ac_id: 'AC-QA-1', pass: 2, fail: 0, unverifiable: 0, n: 2, unattributedVerdicts: 0 })
  assert.deepEqual(result.acVerdicts.get(keyB), { repo: 'demo', spec: 'specs/b.md', ac_id: 'AC-QA-1', pass: 0, fail: 1, unverifiable: 0, n: 1, unattributedVerdicts: 0 })
  assert.deepEqual(result.acVerdicts.get('demo|specs/a.md|AC-SEC-1'), { repo: 'demo', spec: 'specs/a.md', ac_id: 'AC-SEC-1', pass: 0, fail: 1, unverifiable: 0, n: 1, unattributedVerdicts: 0 })
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

// ---- Review round-2 M4: planBucketKey's `${repo}|${plan}` delimiter join
// is not injective -- a "|" inside a repo identity or spec path merges two
// distinct (repo, plan) pairs into one bucket, summing durations. Fixed by
// backslash-escaping any literal "|" (and "\") within each component before
// joining, which is IDENTICAL to the plain join for the overwhelmingly
// common case (neither component contains "|"), so every existing
// `byPlan.get('repo|plan')` lookup in this file keeps working unchanged. ----

test('optimise-read: aggregateWallClock keeps two DIFFERENT (repo, plan) pairs distinct even when a "|" in one component could otherwise make their naive joins collide (M4)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'a|weird.md', run_id: 'x1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'a|weird.md', run_id: 'x1', ts: '2026-08-01T00:01:00.000Z' }, // 60s
    { kind: 'tdd_task', repo: 'demo|a', outcome: 'started', spec: 'weird.md', run_id: 'x2', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo|a', outcome: 'done', spec: 'weird.md', run_id: 'x2', ts: '2026-08-01T00:02:00.000Z' }, // 120s
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.byPlan.size, 2, `naively-colliding (repo, plan) pairs must land in TWO buckets, not one merged bucket -- got ${JSON.stringify([...result.byPlan.values()].map((b) => ({ repo: b.repo, plan: b.plan, agentComputeSeconds: b.agentComputeSeconds, agentComputeN: b.agentComputeN })))}`)
  const buckets = [...result.byPlan.values()]
  const first = buckets.find((b) => b.repo === 'demo' && b.plan === 'a|weird.md')
  const second = buckets.find((b) => b.repo === 'demo|a' && b.plan === 'weird.md')
  assert.ok(first && second, `both distinct (repo, plan) pairs must have their own bucket, got ${JSON.stringify(buckets)}`)
  assert.equal(first.agentComputeSeconds, 60, 'durations must never be summed across the two distinct pairs')
  assert.equal(second.agentComputeSeconds, 120)
})

test('optimise-read: aggregateRework keeps two DIFFERENT (repo, plan, ac_id) triples distinct even when a "|" could otherwise make their naive joins collide (M4)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', spec: 'a|weird.md', round_key: 's1', outcome: 'done', findings: [], ac_verdicts: [{ ac_id: 'AC-X-1', verdict: 'PASS' }] },
    { kind: 'review_cycle', repo: 'demo|a', spec: 'weird.md', round_key: 's2', outcome: 'done', findings: [], ac_verdicts: [{ ac_id: 'AC-X-1', verdict: 'FAIL' }] },
  ]
  const result = mod.aggregateRework(records)
  assert.equal(result.acVerdicts.size, 2, `must produce two distinct acVerdicts entries, not one merged entry -- got ${JSON.stringify([...result.acVerdicts.values()])}`)
  const entries = [...result.acVerdicts.values()]
  const first = entries.find((e) => e.repo === 'demo' && e.spec === 'a|weird.md')
  const second = entries.find((e) => e.repo === 'demo|a' && e.spec === 'weird.md')
  assert.ok(first && second, `both distinct triples must have their own entry, got ${JSON.stringify(entries)}`)
  assert.equal(first.pass, 1)
  assert.equal(first.fail, 0)
  assert.equal(second.pass, 0)
  assert.equal(second.fail, 1, 'verdicts must never be merged across the two distinct (repo, plan, ac_id) triples')
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

// Review round-2 M-3: aggregateRework's invalidAcIdsDropped total was
// computed (previous test file section) but the CLI's `ledger` command
// explicitly whitelists which rework fields reach its JSON output --
// dropped at exactly that boundary, so it never reached optimise-cycle.js
// at all despite being computed correctly one function away.
test('optimise-read CLI: the ledger command\'s output includes rework.invalidAcIdsDropped, computed from a real record whose ac_id was sanitised by the writer (M-3)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md', ac_verdicts: [{ ac_id: 'none', verdict: 'FAIL' }] })
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.rework.invalidAcIdsDropped, 1)
})

// Fix round 1, finding 5: the same CLI-boundary whitelist gap, for
// invalid_fixed_ids_dropped/duplicate_fixed_ids_dropped/the cross-round
// dedupe count -- computed correctly one function away, but dropped at
// exactly this boundary unless explicitly named here too.
test('optimise-read CLI: the ledger command\'s output includes rework.invalidFixedIdsDropped and rework.duplicateFixedIdsDropped, computed from a real record (fix round 1, finding 5)', () => {
  const repo = makeTempRepo()
  runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    spec: 'specs/a.md',
    prior_findings: [{ id: 'e74fb146b7ddc6cb', lens: 'lens-security', location: 'foo.js:10', claim: 'missing auth check' }],
    fixed_findings: [
      { lens: 'lens-security', location: 'foo.js:10', claim: 'missing auth check' },
      { lens: 'lens-security', location: 'foo.js:10', claim: 'missing auth check' },
      { lens: 'lens-security', location: 'nowhere.js:1', claim: 'never reported open' },
    ],
  })
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.rework.invalidFixedIdsDropped, 1, 'the fabricated confirmation')
  assert.equal(out.rework.duplicateFixedIdsDropped, 1, 'the repeated confirmation')
})

test('optimise-read CLI: the ledger command\'s output includes rework.invalidPriorIdsDropped, computed from a real record (fix round 2, AC-3)', () => {
  const repo = makeTempRepo()
  runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    spec: 'specs/a.md',
    prior_findings: [{ id: 'wrongwrongwrong0', lens: 'lens-security', location: 'foo.js:10', claim: 'missing auth check' }],
  })
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.rework.invalidPriorIdsDropped, 1)
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

// Round-7 review F6: every taint-mechanism test up to this point calls
// mod.neverFailingAcs(rework.acVerdicts, { unattributedFailBuckets:
// rework.unattributedFailBuckets }) DIRECTLY -- the test supplies the
// wiring production is supposed to provide on its own. neverFailingAcs's
// own default (`unattributedFailBuckets = new Set()`) means a caller that
// forgets to pass it through gets silent, untainted output with the full
// suite green. This drives the REAL CLI end to end (real writer, real
// reader, no test-supplied wiring) to prove the production call site
// itself (optimise-read.mjs's own `ledger` command) actually connects
// aggregateRework's output to neverFailingAcs's input.
test('optimise-read CLI: `node optimise-read.mjs ledger <root>` wires the unattributed-FAIL taint end to end, with NO test-supplied unattributedFailBuckets -- proves the PRODUCTION call site, not just the function (round-7 F6)', () => {
  const repo = makeTempRepo()
  for (let i = 0; i < 5; i++) {
    runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md', ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'PASS' }] })
  }
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md', ac_verdicts: [{ ac_id: 'not-a-real-ac-id-so-it-fails-the-pattern', verdict: 'FAIL' }] })
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  const entry = out.neverFailingAcs.find((a) => a.ac_id === 'AC-QA-1')
  assert.ok(entry, `expected an AC-QA-1 entry, got: ${JSON.stringify(out.neverFailingAcs)}`)
  assert.equal(entry.never_failed, null, 'the production CLI path must wire the taint, not just the direct function call')
  assert.equal(entry.unattributed_fail_in_window, true)
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
  // just because the window truncated the combined aggregate. perRepo[].root
  // is looked up by the derived, non-identifying label (AC-SEC-3 round 2:
  // the raw absolute root path must never reach this field) -- neither repo
  // has an origin remote, so the writer's own repo-identity fallback is the
  // main checkout's basename, which is exactly what the label derives too.
  assert.equal(out.perRepo.length, 2)
  const entryA = out.perRepo.find((e) => e.root === path.basename(repoA))
  const entryB = out.perRepo.find((e) => e.root === path.basename(repoB))
  assert.ok(entryA && entryB, 'both repos must have their own perRepo entry')
  assert.ok(!entryA.root.includes(repoA) && !entryB.root.includes(repoB), 'perRepo[].root must never be (or contain) the raw absolute analysis path')
  // Review round-1 M5: rootIndex is the stable, positional key
  // optimise-cycle.js uses to look up its OWN scope-resolved label,
  // matching the position `roots` (and therefore `scope.resolved`) listed
  // this repo at -- repoA was passed first, repoB second.
  assert.equal(entryA.rootIndex, 0, 'repoA was the first positional root argument')
  assert.equal(entryB.rootIndex, 1, 'repoB was the second positional root argument')
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

// Round-4 review L8 (AC-QA-20): the AC states a 0.5s wall-clock bound over
// a 2000-record ledger, but the ONLY thing enforcing it was a structural
// guard (test/optimise-static.test.js: the per-record loops contain no fs
// call) -- real, but it proves an O(1)-per-record SHAPE, not a wall-clock
// NUMBER; an algorithmic regression that stayed fs-free but went quadratic
// in record count would pass every existing check. This is the timing
// assertion itself, generous (2s, not 0.5s) so it cannot flake under
// parallel suite load the way a tight bound would -- both lenses measured
// one to two orders of magnitude inside 0.5s (3.9-6.6ms via the exported
// functions, 43-50ms via the real CLI), so 2s leaves ample headroom while
// still catching a genuine quadratic-blowup regression.
test('optimise-read CLI: aggregating a real 2000-record ledger through the CLI stays well under a generous 2s wall-clock ceiling, three consecutive runs (L8, AC-QA-20)', () => {
  const repo = makeTempRepo()
  const ledgerPath = path.join(repo, LEDGER_REL)
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
  const lines = []
  for (let i = 0; i < 2000; i++) {
    lines.push(JSON.stringify({
      schema_version: 2, run_id: `r${i}`, ts: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      repo: 'demo', kind: 'review_cycle', outcome: 'done', spec: `specs/${i % 20}.md`, plan_key: `specs/${i % 20}.md`,
      lenses_run: ['lens-security', 'lens-qa'], lenses_skipped: [],
      findings: [{ id: `f${i}`, lens: 'lens-qa', severity: 'Low', ac_id: `AC-QA-${(i % 5) + 1}`, disposition: 'open' }],
      ac_verdicts: [{ ac_id: `AC-QA-${(i % 5) + 1}`, verdict: i % 7 === 0 ? 'FAIL' : 'PASS' }],
      write_ok: true, write_error: null,
    }))
  }
  fs.writeFileSync(ledgerPath, lines.join('\n') + '\n')
  const elapsedMs = []
  for (let run = 0; run < 3; run++) {
    const before = Date.now()
    const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
    elapsedMs.push(Date.now() - before)
    assert.equal(res.status, 0, res.stderr)
    const out = JSON.parse(res.stdout.trim())
    assert.equal(out.n, 2000, 'sanity: the real fixture must actually reach aggregation, not be windowed/skipped away')
  }
  // Round-7 review F13: AC-QA-20 states the bound as 0.5s ("current
  // measured: 0.05s"), but this test enforced 2s -- a round-4 L8 anti-
  // flake relaxation that, measured at the pinned tip, left roughly 40x
  // headroom rather than the AC's own ~10x. Tightened to the AC's actual
  // number (still ~10x headroom over the ~45ms baseline measured in
  // round-7's own review), asserted against the MEDIAN of the three runs
  // rather than each individually, so one slow-scheduled run on a loaded
  // CI box cannot flake the whole guard while a genuine quadratic
  // regression (which would move every run, not just one) still trips it.
  const sorted = [...elapsedMs].sort((a, b) => a - b)
  const median = sorted[1]
  assert.ok(median < 500, `expected the median of 3 runs under 500ms (AC-QA-20's own stated bound), got ${elapsedMs.join(', ')}ms (median ${median}ms)`)
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

// AC-1: the CLI no longer accepts a
// pre-parsed {commits:[...]} array -- it accepts the RAW, verbatim stdout
// of `git log --name-only --pretty=format:'%x1e%P%x1f%s'` (git_log_raw)
// plus the repo root, and parses/scores it deterministically itself
// (parseGitLogRaw + countEscapedDefectCandidates), so a mis-parse in an
// agent's own text handling can never misattribute a changed path.
test('optimise-read CLI: `node optimise-read.mjs escaped-defects` parses raw git log output (git_log_raw) and returns both the raw fix: count and a scoped count (AC-1, AC-2)', () => {
  const gitLogRaw = '\x1eparent1\x1ffix: repair a heal\nsrc/heal.js\ntest/heal.test.js\n' + '\x1eparent2\x1ffeat: add a thing\nsrc/thing.js\n'
  const payload = { git_log_raw: gitLogRaw, root: '/nonexistent-root-no-override-xyz' }
  const res = spawnSync('node', [MODULE_PATH, 'escaped-defects'], { input: JSON.stringify(payload), encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.count, 1)
  assert.equal(out.n_commits_examined, 2)
  assert.equal(out.scoped_count, 1, 'src/heal.js is outside the default excludes, so the fix: commit is scoped-counted')
  assert.equal(out.scoped_excluded_count, 0)
  assert.equal(out.scoped_unavailable_count, 0)
  assert.equal(out.scoped_config_source, 'default')
})

test('optimise-read CLI: `escaped-defects` with an empty/missing git_log_raw reports zero commits, never throwing', () => {
  const res = spawnSync('node', [MODULE_PATH, 'escaped-defects'], { input: JSON.stringify({}), encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.count, 0)
  assert.equal(out.n_commits_examined, 0)
  assert.equal(out.scoped_count, 0)
})

test('optimise-read CLI: `escaped-defects` with no root falls back to process.cwd() (does not crash, uses defaults when cwd has no override)', () => {
  const res = spawnSync('node', [MODULE_PATH, 'escaped-defects'], { input: JSON.stringify({ git_log_raw: '\x1ep\x1ffix: x\na.js\n' }), encoding: 'utf8', cwd: os.tmpdir() })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.count, 1)
  assert.equal(typeof out.scoped_count, 'number')
})

// ---- parseGitLogRaw (AC-1): the deterministic parser the CLI now owns ----

test('optimise-read: parseGitLogRaw splits raw `git log --name-only --pretty=format:\'%x1e%P%x1f%s\'` output into one {subject, paths} record per commit, in order', () => {
  const raw = '\x1eaaa\x1ffeat: first\nREADME.md\nsrc/a.js\n' + '\x1ebbb\x1ffix: second\nsrc/b.js\n'
  const result = mod.parseGitLogRaw(raw)
  assert.equal(result.length, 2)
  assert.equal(result[0].subject, 'feat: first')
  assert.deepEqual(result[0].paths, ['README.md', 'src/a.js'])
  assert.equal(result[1].subject, 'fix: second')
  assert.deepEqual(result[1].paths, ['src/b.js'])
})

test('optimise-read: parseGitLogRaw reports paths:null for a merge commit (2+ parent hashes) -- %P with no changed files is NOT the same as an ordinary commit that touched nothing (AC-4)', () => {
  const raw = '\x1eaaa bbb\x1fMerge pull request #1\n'
  const result = mod.parseGitLogRaw(raw)
  assert.equal(result.length, 1)
  assert.equal(result[0].paths, null)
})

test('optimise-read: parseGitLogRaw reports paths:[] (not null) for an ordinary single-parent commit that genuinely touched nothing, e.g. an --allow-empty commit', () => {
  const raw = '\x1eaaa\x1ffix: an empty commit\n'
  const result = mod.parseGitLogRaw(raw)
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].paths, [])
})

test('optimise-read: parseGitLogRaw on an empty string returns an empty array, never throwing', () => {
  assert.deepEqual(mod.parseGitLogRaw(''), [])
  assert.deepEqual(mod.parseGitLogRaw(undefined), [])
})

test('optimise-read: parseGitLogRaw treats a ROOT commit (no parents at all, %P empty) as non-merge, not unavailable', () => {
  const raw = '\x1e\x1ffix: the very first commit\nREADME.md\n'
  const result = mod.parseGitLogRaw(raw)
  assert.deepEqual(result[0].paths, ['README.md'])
})

// ---- countEscapedDefectCandidates: the scoped figure (AC-2, AC-4, AC-5) ----

test('optimise-read: countEscapedDefectCandidates with no options at all uses the harness default excludes and computes a scoped figure alongside the unchanged raw one (AC-2 backward compatibility)', () => {
  const commits = [
    { subject: 'fix: repair the torn-line heal', paths: ['workflows/lib/optimise-read.mjs'] },
    { subject: 'fix(ledger): handle a short write', paths: ['.github/workflows/ci.yml'] },
  ]
  const result = mod.countEscapedDefectCandidates(commits)
  assert.equal(result.count, 2, 'the raw figure must be unchanged by this change')
  assert.equal(result.scoped_config_source, 'default')
  assert.equal(result.scoped_count, 1, 'only the commit touching workflows/lib is outside the default excludes')
  assert.equal(result.scoped_excluded_count, 1, 'the commit touching ONLY .github/workflows/ci.yml is pipeline-only')
})

test('optimise-read: countEscapedDefectCandidates counts a fix: commit as scoped when AT LEAST ONE changed path is outside the exclude globs, even if others are inside them', () => {
  const commits = [{ subject: 'fix: bundled change', paths: ['.github/workflows/ci.yml', 'src/real.js'] }]
  const result = mod.countEscapedDefectCandidates(commits, { excludeGlobs: ['.github/**'], configSource: 'default' })
  assert.equal(result.scoped_count, 1)
  assert.equal(result.scoped_excluded_count, 0)
})

test('optimise-read: countEscapedDefectCandidates excludes a fix: commit whose changed paths are ALL inside the exclude globs', () => {
  const commits = [{ subject: 'fix: ci only', paths: ['.github/workflows/ci.yml', '.github/workflows/deploy.yml'] }]
  const result = mod.countEscapedDefectCandidates(commits, { excludeGlobs: ['.github/**'], configSource: 'default' })
  assert.equal(result.scoped_count, 0)
  assert.equal(result.scoped_excluded_count, 1)
})

test('optimise-read: countEscapedDefectCandidates(AC-4) counts a fix: commit with unavailable paths (paths:null, e.g. a merge commit) in NEITHER scoped_count nor scoped_excluded_count -- only scoped_unavailable_count', () => {
  const commits = [{ subject: 'fix: from a merge', paths: null }]
  const result = mod.countEscapedDefectCandidates(commits, { excludeGlobs: ['.github/**'], configSource: 'default' })
  assert.equal(result.scoped_count, 0)
  assert.equal(result.scoped_excluded_count, 0)
  assert.equal(result.scoped_unavailable_count, 1)
})

test('optimise-read: countEscapedDefectCandidates(AC-4) counts a fix: commit with a MISSING paths field (not present at all, never an array) as unavailable too', () => {
  const commits = [{ subject: 'fix: no paths field' }]
  const result = mod.countEscapedDefectCandidates(commits, { excludeGlobs: ['.github/**'], configSource: 'default' })
  assert.equal(result.scoped_unavailable_count, 1)
})

test('optimise-read: countEscapedDefectCandidates invariant -- scoped_count + scoped_excluded_count + scoped_unavailable_count always equals the raw count', () => {
  const commits = [
    { subject: 'fix: a', paths: ['src/a.js'] },
    { subject: 'fix: b', paths: ['.github/workflows/ci.yml'] },
    { subject: 'fix: c', paths: null },
    { subject: 'feat: not counted at all', paths: ['src/d.js'] },
  ]
  const result = mod.countEscapedDefectCandidates(commits, { excludeGlobs: ['.github/**'], configSource: 'default' })
  assert.equal(result.count, 3)
  assert.equal(result.scoped_count + result.scoped_excluded_count + result.scoped_unavailable_count, result.count)
})

test('optimise-read: countEscapedDefectCandidates(AC-4) reports the scoped figure as UNAVAILABLE (null), never a guessed default, when configError is set -- a broken repo override must not silently fall back to the default excludes', () => {
  const commits = [{ subject: 'fix: a', paths: ['src/a.js'] }]
  const result = mod.countEscapedDefectCandidates(commits, { configError: '.claude/harness-triggers.json is not valid JSON', configSource: 'repo-override' })
  assert.equal(result.count, 1, 'the raw figure is unaffected by a broken config')
  assert.equal(result.scoped_count, null)
  assert.equal(result.scoped_excluded_count, null)
  assert.equal(result.scoped_unavailable_count, null)
  assert.match(result.scoped_method, /unavailable/i)
  assert.match(result.scoped_method, /not valid JSON/)
})

test('optimise-read: countEscapedDefectCandidates scoped_method names what it counts (product source, excluding pipeline/tooling) and disclaims causal attribution, same as the raw method already does (AC-2, AC-6)', () => {
  const result = mod.countEscapedDefectCandidates([{ subject: 'fix: a', paths: ['src/a.js'] }])
  assert.match(result.scoped_method, /product source/i)
  assert.match(result.scoped_method, /pipeline|tooling/i)
  assert.match(result.scoped_method, /not.*verified causal attribution/i)
})

// ---- resolveProductSourceExcludeGlobs (AC-3, AC-4): reads .claude/harness-triggers.json's escapedDefectExcludePaths, the same file review-cycle.js reads ----

test('optimise-read: resolveProductSourceExcludeGlobs with no .claude/harness-triggers.json file at all returns the harness default excludes, no error (AC-3)', () => {
  const repo = makeTempRepo()
  const result = mod.resolveProductSourceExcludeGlobs(repo)
  assert.equal(result.configSource, 'default')
  assert.equal(result.configError, null)
  assert.deepEqual(result.excludeGlobs, mod.DEFAULT_PRODUCT_SOURCE_EXCLUDE_GLOBS)
})

test('optimise-read: resolveProductSourceExcludeGlobs reads a valid escapedDefectExcludePaths override from .claude/harness-triggers.json (AC-3)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.claude', 'harness-triggers.json'), JSON.stringify({ escapedDefectExcludePaths: ['scripts/**', 'deploy/**'] }))
  const result = mod.resolveProductSourceExcludeGlobs(repo)
  assert.equal(result.configSource, 'repo-override')
  assert.equal(result.configError, null)
  assert.deepEqual(result.excludeGlobs, ['scripts/**', 'deploy/**'])
})

test('optimise-read: resolveProductSourceExcludeGlobs with a harness-triggers.json that exists but does not carry the key falls back to the default, no error (a repo tuning ONLY review-cycle triggers must not break this)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.claude', 'harness-triggers.json'), JSON.stringify({ ui: ['**/*.foo'] }))
  const result = mod.resolveProductSourceExcludeGlobs(repo)
  assert.equal(result.configSource, 'default')
  assert.equal(result.configError, null)
})

test('optimise-read: resolveProductSourceExcludeGlobs(AC-4) fails closed with a configError, excludeGlobs:null, when harness-triggers.json is not valid JSON -- never silently falls back to defaults on a broken override', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.claude', 'harness-triggers.json'), '{not valid json')
  const result = mod.resolveProductSourceExcludeGlobs(repo)
  assert.equal(result.excludeGlobs, null)
  assert.ok(result.configError)
})

test('optimise-read: resolveProductSourceExcludeGlobs fails closed when harness-triggers.json parses to a non-object (e.g. a bare array)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.claude', 'harness-triggers.json'), '["not", "an", "object"]')
  const result = mod.resolveProductSourceExcludeGlobs(repo)
  assert.equal(result.excludeGlobs, null)
  assert.ok(result.configError)
})

test('optimise-read: resolveProductSourceExcludeGlobs fails closed when escapedDefectExcludePaths is not an array', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.claude', 'harness-triggers.json'), JSON.stringify({ escapedDefectExcludePaths: 'scripts/**' }))
  const result = mod.resolveProductSourceExcludeGlobs(repo)
  assert.equal(result.excludeGlobs, null)
  assert.match(result.configError, /array/)
})

test('optimise-read: resolveProductSourceExcludeGlobs fails closed when escapedDefectExcludePaths is an empty array (would exclude nothing and is not the supported way to opt out)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.claude', 'harness-triggers.json'), JSON.stringify({ escapedDefectExcludePaths: [] }))
  const result = mod.resolveProductSourceExcludeGlobs(repo)
  assert.equal(result.excludeGlobs, null)
  assert.match(result.configError, /empty/)
})

test('optimise-read: resolveProductSourceExcludeGlobs bounds glob length/wildcards/"**" segments/count the same way review-cycle.js does, against the SAME file (ReDoS defence in depth)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.claude', 'harness-triggers.json'), JSON.stringify({ escapedDefectExcludePaths: ['**a**a**a**a**a**a**b'] }))
  const result = mod.resolveProductSourceExcludeGlobs(repo)
  assert.equal(result.excludeGlobs, null)
  assert.ok(result.configError)
})

test('optimise-read CLI: an unknown command name is reported as an error, not a crash', () => {
  const res = spawnSync('node', [MODULE_PATH, 'bogus-command'], { encoding: 'utf8' })
  assert.equal(res.status, 0)
  const out = JSON.parse(res.stdout.trim())
  assert.ok(out.error)
})

// ---- Review round-2 L2: `ci`, `escaped-defects` and `ids` all echoed
// JSON.parse's own SyntaxError message on malformed stdin -- V8 embeds a
// snippet of the actual input it failed on in that message, matching L1's
// already-fixed ledger-line-parser leak (line 99), which was fixed there
// but not here. These commands are fed agent-assembled gh output and
// commit subjects, which optimise-cycle.js then carries into the
// synthesis prompt and the report. ----

for (const [command, malformedInput] of [['ci', '/Users/some-user/private not json'], ['escaped-defects', '/Users/some-user/private not json'], ['ids', '/Users/some-user/private not json']]) {
  test(`optimise-read CLI: \`${command}\` on malformed stdin beginning with an absolute path does not echo that path into the returned error (L2, AC-SEC-3)`, () => {
    const res = spawnSync('node', [MODULE_PATH, command], { input: malformedInput, encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    const out = JSON.parse(res.stdout.trim())
    assert.ok(out.error, `expected an error field, got ${JSON.stringify(out)}`)
    assert.ok(!out.error.includes('/Users/'), `error must not echo the raw stdin content: ${out.error}`)
    assert.ok(!out.error.includes('private'), `error must not echo the raw stdin content: ${out.error}`)
    assert.match(out.error, /valid JSON|pars|JSON/i, 'the error must still say WHY it failed, just not echo the raw content')
  })
}

test('optimise-read CLI: `node optimise-read.mjs ledger <root>` on a repo with no ledger file reports n:0 and does not create one (AC-QA-17 fixture at n=0)', () => {
  const repo = makeTempRepo()
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.n, 0)
  assert.equal(fs.existsSync(path.join(repo, '.claude', 'harness-ledger.jsonl')), false, 'reading must never create the ledger file')
})

// ---- HARN-OPT-2 PR1: read-side plan-identity normalisation is a
// REDACTION, not merely a regrouping (AC-SEC-3, AC-QA-5, AC-ARCH-4/5,
// AC-DATA-7, AC-OPS-5, AC-QA-7) ----

// Reproduces the real 9-record ledger (see the spec's own worked example):
// one absolute-form spec, one no-spec record, one stray "specs/x.md" record
// (the hand-injected test record, kept as ordinary data, never specially
// excluded), and five records for "specs/optimise-cycle.md" in its relative
// form. The absolute-form line uses THIS repo's own real absolute path (not
// a hardcoded machine-specific string) so the fixture is portable and the
// relativisation genuinely exercises the writer/reader's real root-matching
// logic, not a coincidence of a hardcoded prefix.
// Review round-1 M4: seeding the "historical absolute-form" line THROUGH
// runAppend (the real, FIXED writer) meant it could never actually be
// absolute by the time it reached the ledger -- the writer relativises it
// at write time, so the AC-QA-5 guard this fixture exists to prove had
// nothing left to fail on (355/355 stayed green even with read-side
// normalisation deleted entirely). rec0 is now hand-seeded directly, byte
// for byte the shape the PRE-PR1 writer actually produced: schema_version
// 1, a genuinely absolute spec, no plan_key at all -- the same technique
// already used for the AC-DATA-6 fixture above. repo identity matches what
// the REAL writer resolves for the other 8 records (this repo's own
// basename, no origin remote configured), or the two groups would land in
// different buckets for a reason unrelated to plan-identity collapsing.
function seedNineRecordFixture(repo) {
  const ledgerPath = path.join(repo, LEDGER_REL)
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
  const repoIdentity = path.basename(repo)
  const absSpec = path.join(repo, 'specs', 'optimise-cycle.md')
  const record0 = { schema_version: 1, run_id: 'rec0', ts: '2026-08-01T00:00:00.000Z', repo: repoIdentity, kind: 'review_cycle', outcome: 'started', spec: absSpec }
  fs.writeFileSync(ledgerPath, JSON.stringify(record0) + '\n')

  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', run_id: 'rec1' })
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', spec: 'specs/x.md', run_id: 'r1' })
  runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', event: 'ci_wait_started', event_scope: 'specs/optimise-cycle.md:T1:ci_wait_started' })
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'started', spec: 'specs/optimise-cycle.md', run_id: 'rec4' })
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'started', spec: 'specs/optimise-cycle.md', run_id: 'rec5' })
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'started', spec: 'specs/optimise-cycle.md', run_id: 'rec6' })
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'started', spec: 'specs/optimise-cycle.md', run_id: 'rec7' })
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/optimise-cycle.md', run_id: 'rec7' })
}

// Review round-1 M4: nested under a home-like path (a literal "home"
// segment plus the real `whoami` output, matching the recursive-walk
// fixture's own technique) so leak-freedom AND the 4-to-3 bucket collapse
// are proven together, over the SAME fixture, in one test.
test('optimise-read CLI: `ledger <root>` over a fixture reproducing the real 9-record ledger, hand-seeded so the historical absolute-form line genuinely reaches the ledger, nested under a home-like path -- ZERO leaked matches for /Users/, /Volumes/, /home/, C:\\\\ and whoami anywhere in the output (including perRepo), AND the absolute + relative forms of "specs/optimise-cycle.md" collapse into ONE wallClock.byPlan bucket, proven against a sanity check that the RAW fixture genuinely contains 4 distinct un-normalised spec forms (AC-SEC-3, AC-QA-5)', () => {
  const whoami = sh('whoami', SUITE_TMPDIR).trim()
  // whoami sits as an INTERMEDIATE path segment (a realistic
  // "/home/<user>/projects/<repo>" shape) -- NOT the checkout's own
  // basename. This repo has no origin remote, so the writer's repo-identity
  // fallback is that basename; if it were literally "whoami" too, the
  // record's own (legitimate) repo field would coincidentally equal the
  // account name for a reason unrelated to what this test guards, and the
  // recursive walk below would flag a false positive.
  const homeLikeRoot = path.join(SUITE_TMPDIR, 'home', whoami, 'repo-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(homeLikeRoot, { recursive: true })
  trackTempDir(path.join(SUITE_TMPDIR, 'home'))
  sh('git init -q -b main', homeLikeRoot)
  sh('git config user.email test@example.com', homeLikeRoot)
  sh('git config user.name Test', homeLikeRoot)
  fs.writeFileSync(path.join(homeLikeRoot, 'README.md'), 'seed\n')
  sh('git add README.md && git commit -q -m seed', homeLikeRoot)
  assert.ok(/\/home\//.test(homeLikeRoot) && homeLikeRoot.includes(whoami), 'sanity: the fixture root must genuinely be home-shaped')

  seedNineRecordFixture(homeLikeRoot)

  // Sanity ("4 before"): the RAW ledger content genuinely contains 4
  // distinct, un-normalised spec-identity forms. Without this, a fixture
  // that happened to already be normalised (M4's exact finding) would pass
  // "3 buckets" vacuously.
  const rawLines = fs.readFileSync(path.join(homeLikeRoot, LEDGER_REL), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const rawSpecIdentities = new Set(rawLines.filter((l) => l.kind !== 'conduct_plan_event').map((l) => l.spec ?? '<no-spec-raw>'))
  assert.equal(rawSpecIdentities.size, 4, `sanity: expected 4 distinct RAW (un-normalised) spec forms in the fixture, got ${JSON.stringify([...rawSpecIdentities])} -- the fixture must genuinely contain the historical absolute form or this test cannot prove anything about the fix`)
  // Review round-2 L3: JSON.stringify(rawLines[0]) is always an object
  // stringified to "{...}", so the negated startsWith('specs/') check could
  // never fail regardless of rec0's actual spec value -- checked directly
  // on the parsed field instead.
  assert.ok(path.isAbsolute(rawLines[0].spec), `sanity: rec0's raw spec must genuinely be absolute, not already relative -- got ${JSON.stringify(rawLines[0].spec)}`)

  const res = spawnSync('node', [MODULE_PATH, 'ledger', homeLikeRoot], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const stdout = res.stdout

  const violations = []
  function walk(value, at) {
    if (value === null || value === undefined) return
    if (typeof value === 'string') {
      if (/\/Users\//.test(value)) violations.push(`${at}: /Users/`)
      if (/\/Volumes\//.test(value)) violations.push(`${at}: /Volumes/`)
      if (/\/home\//.test(value)) violations.push(`${at}: /home/`)
      if (/C:\\/.test(value)) violations.push(`${at}: Windows path`)
      if (whoami && value.includes(whoami)) violations.push(`${at}: whoami in ${JSON.stringify(value)}`)
      return
    }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${at}[${i}]`)); return }
    if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) walk(v, `${at}.${k}`) }
  }
  const out = JSON.parse(stdout)
  walk(out, '$')
  assert.deepEqual(violations, [], `leaked path/username found in the emitted JSON:\n${violations.join('\n')}`)

  // AC-QA-5, "3 after": the absolute and relative forms of
  // "specs/optimise-cycle.md" must collapse into ONE bucket.
  const planKeys = Object.values(out.wallClock.byPlan).map((b) => b.plan)
  assert.equal(planKeys.length, 3, `expected exactly 3 buckets, got ${JSON.stringify(planKeys)}`)
  assert.ok(planKeys.includes('specs/optimise-cycle.md'))
  assert.ok(planKeys.includes('specs/x.md'))
  const optimiseCycleBucket = Object.values(out.wallClock.byPlan).find((b) => b.plan === 'specs/optimise-cycle.md')
  // rec0 (absolute, started) has no terminal pair; rec4-rec6 (started, no
  // terminal) are also orphans; rec7's started/done pair is the one real
  // measured pair -- 4 unmeasured attempts total once collapsed into one bucket.
  assert.equal(optimiseCycleBucket.agentComputeN, 1, 'the one real started/done pair must be measured')
  assert.equal(optimiseCycleBucket.agentComputeUnmeasuredN, 4, 'every orphan (including the absolute-form one) must land in the SAME bucket\'s unmeasured count, not a separate one')
})

// Round 2 (coordinator finding): the test above uses makeTempRepo()'s own
// temp-dir path as root, which on MOST machines is not a home-like path at
// all (a bare mktemp path, e.g. /tmp/xyz or /var/folders/...) -- so the
// assertion above could never actually fail on those machines even with the
// old, leaking code, and on the one machine where TMPDIR happens to live
// under /Volumes/.../home/..., that was a coincidence, not a deliberately
// sized fixture. This test deliberately nests the analysed repo under a
// path containing BOTH a literal "home" segment AND the real `whoami`
// output, so the assertion can actually fail regardless of the machine's
// own TMPDIR -- and walks the WHOLE emitted JSON recursively (every key,
// every string value, at every depth), not a spot-check of named fields,
// so a leak in any field -- not just the ones already known about -- is
// caught.
test('optimise-read CLI: `ledger <root>` -- recursively walking the ENTIRE emitted JSON (every key, every value, any depth) finds zero matches for /Users/, /Volumes/, /home/, C:\\\\ and the real whoami, when the analysed repo itself lives under a path containing a home-like segment and the real username (AC-SEC-3, perRepo[].root)', () => {
  const whoami = sh('whoami', SUITE_TMPDIR).trim()
  const homeLikeRoot = path.join(SUITE_TMPDIR, 'home', whoami, 'repo-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(homeLikeRoot, { recursive: true })
  trackTempDir(path.join(SUITE_TMPDIR, 'home'))
  sh('git init -q -b main', homeLikeRoot)
  sh('git config user.email test@example.com', homeLikeRoot)
  sh('git config user.name Test', homeLikeRoot)
  fs.writeFileSync(path.join(homeLikeRoot, 'README.md'), 'seed\n')
  sh('git add README.md && git commit -q -m seed', homeLikeRoot)
  assert.ok(/\/home\//.test(homeLikeRoot) && homeLikeRoot.includes(whoami), 'sanity: the fixture root itself must genuinely contain both a home-like segment and the real username, or this test proves nothing')

  runAppend(homeLikeRoot, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const res = spawnSync('node', [MODULE_PATH, 'ledger', homeLikeRoot], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())

  const violations = []
  function walk(value, at) {
    if (value === null || value === undefined) return
    if (typeof value === 'string') {
      if (/\/Users\//.test(value)) violations.push(`${at}: /Users/ in ${JSON.stringify(value)}`)
      if (/\/Volumes\//.test(value)) violations.push(`${at}: /Volumes/ in ${JSON.stringify(value)}`)
      if (/\/home\//.test(value)) violations.push(`${at}: /home/ in ${JSON.stringify(value)}`)
      if (/C:\\/.test(value)) violations.push(`${at}: Windows path in ${JSON.stringify(value)}`)
      if (whoami && value.includes(whoami)) violations.push(`${at}: whoami ("${whoami}") in ${JSON.stringify(value)}`)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${at}[${i}]`))
      return
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${at}.${k}`)
    }
  }
  walk(out, '$')
  assert.deepEqual(violations, [], `leaked path/username found in the emitted JSON:\n${violations.join('\n')}`)
})

test('optimise-read: aggregateWallClock collapses an absolute spec, a relative spec, and a ".."-containing spec for the SAME plan into one bucket, in both directions (agent_compute and, via the event_key plan segment, ci_wait) -- proven with an explicit root so the absolute form resolves (AC-ARCH-4)', () => {
  const root = '/repo'
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: '/repo/specs/a.md', run_id: 'abs-1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: '/repo/specs/a.md', run_id: 'abs-1', ts: '2026-08-01T00:01:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'rel-1', ts: '2026-08-01T01:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'rel-1', ts: '2026-08-01T01:02:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/sub/../a.md', run_id: 'dotdot-1', ts: '2026-08-01T02:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/sub/../a.md', run_id: 'dotdot-1', ts: '2026-08-01T02:03:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records, { root })
  assert.equal(result.byPlan.size, 1, `expected exactly one bucket, got ${JSON.stringify([...result.byPlan.keys()])}`)
  const bucket = result.byPlan.get('demo|specs/a.md')
  assert.ok(bucket, 'expected the canonical "demo|specs/a.md" bucket to exist')
  assert.equal(bucket.agentComputeN, 3, 'all three forms must be measured runs inside the ONE bucket')
})

test('optimise-read: aggregateRework collapses an absolute spec and a relative spec for the same plan into one acVerdicts entry (AC-ARCH-4)', () => {
  const root = '/repo'
  const records = [
    { kind: 'review_cycle', repo: 'demo', spec: '/repo/specs/a.md', round_key: 's1', outcome: 'done', findings: [], ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'PASS' }] },
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', round_key: 's2', outcome: 'done', findings: [], ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'PASS' }] },
  ]
  const result = mod.aggregateRework(records, { root })
  assert.equal(result.acVerdicts.size, 1, `expected one collapsed entry, got ${JSON.stringify([...result.acVerdicts.keys()])}`)
  const entry = [...result.acVerdicts.values()][0]
  assert.equal(entry.n, 2, 'both records must contribute to the ONE collapsed entry')
  assert.equal(entry.spec, 'specs/a.md', 'the reported spec must be the canonical, repo-relative form -- never the absolute one')
})

// ---- AC-DATA-6: a ledger mixing genuine pre-PR1-shaped lines (no plan_key
// at all, schema_version 1 -- exactly what the writer produced before this
// change) with post-PR1 lines (plan_key present, schema_version 2) for the
// SAME plan must aggregate to ONE bucket per plan, with every record
// counted -- none dropped uncounted just because it predates plan_key. ----

test('optimise-read CLI: a real ledger mixing hand-seeded pre-PR1-shaped lines (no plan_key, schema_version 1) with genuine post-PR1 writer output (plan_key present, schema_version 2) for the IDENTICAL plan collapses to ONE wallClock.byPlan bucket, and every record is counted -- none dropped uncounted for lacking plan_key (AC-DATA-6)', () => {
  const repo = makeTempRepo()
  const ledgerPath = path.join(repo, LEDGER_REL)
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })

  // Hand-seeded, byte-for-byte the shape the PRE-PR1 writer actually
  // produced: no plan_key field at all, schema_version 1. A genuine
  // started/done pair for "specs/shared.md", written directly (not via
  // runAppend, which would always add plan_key -- the whole point is to
  // reproduce lines that predate this change). repo is the SAME identity
  // the real writer resolves for this repo (its basename, no origin remote
  // configured) -- a fixture using a different, made-up repo string here
  // would land in a DIFFERENT bucket key (`${repo}|${plan}`) regardless of
  // plan_key, proving nothing about plan-identity collapsing specifically.
  const repoIdentity = path.basename(repo)
  const preChangeLines = [
    { schema_version: 1, run_id: 'pre-1', ts: '2026-01-01T00:00:00.000Z', repo: repoIdentity, kind: 'tdd_task', outcome: 'started', spec: 'specs/shared.md' },
    { schema_version: 1, run_id: 'pre-1', ts: '2026-01-01T00:01:00.000Z', repo: repoIdentity, kind: 'tdd_task', outcome: 'done', spec: 'specs/shared.md' },
  ]
  fs.writeFileSync(ledgerPath, preChangeLines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const preLinesRaw = fs.readFileSync(ledgerPath, 'utf8')

  // A genuine POST-PR1 write, through the real (fixed) writer, for the
  // IDENTICAL plan ("specs/shared.md") -- this line DOES carry plan_key
  // and schema_version 2.
  const postRes = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'started', spec: 'specs/shared.md', run_id: 'post-1' })
  const postOut = JSON.parse(postRes.stdout.trim().split('\n').pop())
  assert.equal(postOut.write_ok, true, postOut.write_error)
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', spec: 'specs/shared.md', run_id: 'post-1' })

  const rawAfter = fs.readFileSync(ledgerPath, 'utf8')
  assert.ok(rawAfter.startsWith(preLinesRaw), 'the hand-seeded pre-PR1 lines must survive byte for byte, unmoved, at the head of the append-only file (AC-DATA-6)')
  const allLines = rawAfter.split('\n').filter(Boolean)
  assert.equal(allLines.length, 4, 'all 4 lines (2 pre-PR1 + 2 post-PR1) must be present -- append-only, nothing rewritten')
  const postLine = JSON.parse(allLines[2])
  assert.ok('plan_key' in postLine && postLine.plan_key === 'specs/shared.md', 'sanity: the genuine post-PR1 line really does carry plan_key')
  assert.ok(!('plan_key' in JSON.parse(allLines[0])), 'sanity: the hand-seeded pre-PR1 line really does lack plan_key, or this test proves nothing about the mixed-version case')

  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.n, 4, 'all 4 records must be read and counted, none dropped uncounted for lacking plan_key')
  assert.equal(out.skipped.length, 0, 'a missing plan_key must never cause a line to be skipped -- plan_key is optional, per AC-ARCH-5')

  const sharedBuckets = Object.values(out.wallClock.byPlan).filter((b) => b.plan === 'specs/shared.md')
  assert.equal(sharedBuckets.length, 1, `expected the pre-PR1 pair and the post-PR1 pair to collapse into ONE bucket, got ${JSON.stringify(sharedBuckets)}`)
  assert.equal(sharedBuckets[0].agentComputeN, 2, 'BOTH the pre-PR1 pair and the post-PR1 pair must be measured inside the one collapsed bucket -- neither silently dropped')
})

// ---- HARN-OPT-2 PR2 (AC-DATA-10): agent_compute pairing purity. Only a
// run_id shared by EXACTLY one 'started' record and EXACTLY one terminal
// (non-'started') record may ever produce a measured duration. Today two
// 'started' records sharing a run_id have their timestamps subtracted
// anyway (the pairing loop only checked pair.length, never each record's
// own outcome), fabricating a duration for an attempt that never actually
// finished. ----

test('optimise-read: aggregateWallClock reproduces the AC-DATA-10 bug exactly as measured -- two started records one hour apart, sharing a run_id, must NOT report agentComputeSeconds=3600/measuredRuns=1; the fixed behaviour is 0 measured, 1 unmeasured, seconds null', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'two-starts', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'two-starts', ts: '2026-08-01T01:00:00.000Z' }, // +3600s
  ]
  const result = mod.aggregateWallClock(records)
  assert.notEqual(result.totals.agentComputeSeconds, 3600, 'two started records must never be treated as a measured start/terminal pair')
  assert.equal(result.totals.agentComputeMeasuredRuns, 0)
  assert.equal(result.totals.agentComputeUnmeasuredRuns, 1)
  assert.equal(result.totals.agentComputeSeconds, null)
})

test('optimise-read: aggregateWallClock treats two TERMINAL records (no started at all) sharing a run_id the same way -- 0 measured, 1 unmeasured, no fabricated duration (AC-DATA-10)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'two-terminals', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'aborted', spec: 'specs/a.md', run_id: 'two-terminals', ts: '2026-08-01T00:30:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeMeasuredRuns, 0)
  assert.equal(result.totals.agentComputeUnmeasuredRuns, 1)
  assert.equal(result.totals.agentComputeSeconds, null)
})

test('optimise-read: aggregateWallClock treats three or more records sharing one run_id (1 started + 2 terminal) the same way -- 0 measured, 1 unmeasured (AC-DATA-10)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'three-way', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'three-way', ts: '2026-08-01T00:05:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'three-way', ts: '2026-08-01T00:10:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeMeasuredRuns, 0)
  assert.equal(result.totals.agentComputeUnmeasuredRuns, 1)
  assert.equal(result.totals.agentComputeSeconds, null)
})

// ---- HARN-OPT-2 PR2 review round 1, H1 (AC-QA-12's third clause): "aborted
// pairs are counted under their own name and never contribute to any
// completed-run duration statistic." The version of this test that shipped
// in review round 1 encoded the OPPOSITE reading (asserted a crashed pair
// as `agentComputeMeasuredRuns: 1` / `agentComputeSeconds: 180`), which is
// exactly finding H1: the exception-guard fix (PR2's own terminal-write
// change) turns a crash from an orphan (correctly unmeasured) into a
// well-formed pair, and the OLD version of this test asserted that pair
// should read as a healthy completion. Confirmed by execution against the
// review's own repro (40 minutes apart): pre-fix this returned
// `{agentComputeSeconds: 2400, agentComputeMeasuredRuns: 1,
// agentComputeUnmeasuredRuns: 0}` -- byte-identical in SHAPE to a genuine
// completion, and `isUnmeasuredSegmentMotivated` (optimise-cycle.js) reads
// agentComputeUnmeasuredRuns to decide whether a proposal citing
// agent_compute is built on unmeasurable data. A workflow crashing on
// EVERY run would report as a fully measured, healthy repo. ----

test('optimise-read: a start/terminal pair whose terminal outcome is aborted (not done) is EXCLUDED from agentComputeSeconds/agentComputeMeasuredRuns, STILL counts toward agentComputeUnmeasuredRuns (so the proposal-safety gate stays armed), and is reported under its own agentComputeAbortedPairs/agentComputeAbortedSeconds names -- reproducing the review\'s exact 40-minute repro (H1, AC-QA-12)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'aborted-pair', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'aborted', spec: 'specs/a.md', run_id: 'aborted-pair', ts: '2026-08-01T00:40:00.000Z' }, // 40 minutes later
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeMeasuredRuns, 0, 'a crashed run must never read as a measured completion')
  assert.equal(result.totals.agentComputeSeconds, null, 'no fabricated duration must reach the completed-run statistic')
  assert.equal(result.totals.agentComputeUnmeasuredRuns, 1, 'the crash must still keep the segment "unmeasured" -- this is what keeps the proposal-safety gate armed')
  assert.equal(result.totals.agentComputeAbortedPairs, 1, 'the crash must be named and counted under its own counter')
  assert.equal(result.totals.agentComputeAbortedSeconds, 2400, 'the elapsed time IS known (a real number, not null) -- it is a crash duration, reported under its own name, never a work duration')
  // The record itself, unmodified, must still say aborted -- nothing in the
  // aggregate pipeline claims or implies this was a completion.
  assert.equal(records[1].outcome, 'aborted', 'aggregateWallClock must never mutate the input record\'s outcome field')
})

// Review round-2 M-4: round-1's H1 fix gated on `outcome !== 'done'`,
// which is wrong -- `blocked` (a legitimate terminating verdict,
// tdd-task.js's OUTCOME_BY_VERDICT) and `no-op` (review-cycle.js's
// ordinary "no changes found" case, __outcome: 'no-op') are both healthy
// COMPLETIONS with real, meaningful durations, not crashes. Only `aborted`
// is the outcome the exception guard actually produces for a genuine
// crash. Negating `done` misclassified every blocked/no-op run as a crash,
// excluding its real duration from agent_compute and rendering it as
// `aborted n=` in the report -- the mirror-image defect of H1 (the false
// clean; this is the false alarm), reachable for any repo whose review
// cycles usually find no changes.
test('optimise-read: a start/terminal pair whose terminal outcome is blocked is a LEGITIMATE COMPLETION -- measured, its duration counted, never classified as an aborted crash (M-4, corrects round-1\'s `outcome !== "done"` over-negation)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'blocked-pair', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'blocked', spec: 'specs/a.md', run_id: 'blocked-pair', ts: '2026-08-01T00:05:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeMeasuredRuns, 1, 'a blocked run completed and took real, meaningful time -- it must count as measured')
  assert.equal(result.totals.agentComputeSeconds, 300)
  assert.equal(result.totals.agentComputeAbortedPairs, 0, 'blocked is not a crash and must never be counted as one')
})

test('optimise-read: a start/terminal pair whose terminal outcome is no-op (review-cycle\'s ordinary "no changes found" case) is a LEGITIMATE COMPLETION, never classified as an aborted crash (M-4)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'noop-pair', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'review_cycle', repo: 'demo', outcome: 'no-op', spec: 'specs/a.md', run_id: 'noop-pair', ts: '2026-08-01T00:00:10.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeMeasuredRuns, 1, 'a no-op run (nothing to review) still completed and its real duration must count as measured, not be discarded as a crash')
  assert.equal(result.totals.agentComputeSeconds, 10)
  assert.equal(result.totals.agentComputeAbortedPairs, 0)
})

test('optimise-read: only outcome "aborted" is classified as a crash -- the exhaustive enumeration proof (done, blocked, no-op all measured; aborted alone excluded) (M-4)', () => {
  const outcomes = ['done', 'blocked', 'no-op', 'aborted']
  for (const outcome of outcomes) {
    const records = [
      { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: `run-${outcome}`, ts: '2026-08-01T00:00:00.000Z' },
      { kind: 'tdd_task', repo: 'demo', outcome, spec: 'specs/a.md', run_id: `run-${outcome}`, ts: '2026-08-01T00:01:00.000Z' },
    ]
    const result = mod.aggregateWallClock(records)
    if (outcome === 'aborted') {
      assert.equal(result.totals.agentComputeMeasuredRuns, 0, `${outcome} must be excluded from measured`)
      assert.equal(result.totals.agentComputeAbortedPairs, 1, `${outcome} must be counted as aborted`)
    } else {
      assert.equal(result.totals.agentComputeMeasuredRuns, 1, `${outcome} must be counted as measured`)
      assert.equal(result.totals.agentComputeAbortedPairs, 0, `${outcome} must NOT be counted as aborted`)
    }
  }
})

test('optimise-read: a per-plan bucket also carries its own agentComputeAbortedN, so an operator can see WHICH plan is crashing, not just a repo-wide total (H1)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/crashy.md', run_id: 'ab-1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'aborted', spec: 'specs/crashy.md', run_id: 'ab-1', ts: '2026-08-01T00:01:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  const bucket = result.byPlan.get('demo|specs/crashy.md')
  assert.ok(bucket, 'the crashed pair must still attribute to its real plan identity')
  assert.equal(bucket.agentComputeAbortedN, 1)
  assert.equal(bucket.agentComputeN, 0, 'a crashed pair must never count toward the same plan\'s completed-run count')
})

test('optimise-read: a genuine DONE pair is unaffected by the H1 fix -- still measured, seconds attributed, agentComputeAbortedPairs stays 0 (not vacuous)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'genuine-done', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'genuine-done', ts: '2026-08-01T00:03:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeMeasuredRuns, 1)
  assert.equal(result.totals.agentComputeSeconds, 180)
  assert.equal(result.totals.agentComputeAbortedPairs, 0)
  assert.equal(result.totals.agentComputeAbortedSeconds, 0)
})

test('optimise-read: aggregateWallClock still measures the genuine case -- exactly one started and one terminal record sharing a run_id (not vacuous: proves the AC-DATA-10 fix does not also break the ordinary pair)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'clean-pair', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'clean-pair', ts: '2026-08-01T00:02:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeMeasuredRuns, 1)
  assert.equal(result.totals.agentComputeUnmeasuredRuns, 0)
  assert.equal(result.totals.agentComputeSeconds, 120)
})

// ---- HARN-OPT-2 PR2 (AC-OPS-2): the two orphan classes -- a lone 'started'
// record (M1, round 4 remainder: the process was killed before the
// terminal write, or the terminal write's own payload was refused -- an
// exception escaping run() no longer causes this, since PR2's try/finally
// always attempts a terminal write) versus a lone terminal record (the
// START write itself failed) -- are different defects with different
// fixes, and must be counted and named SEPARATELY, in addition to the
// combined agentComputeUnmeasuredRuns total, so fixing one can never read
// as progress on the other. ----

test('optimise-read: aggregateWallClock counts a lone started record as a start-only orphan (agentComputeStartOnlyRuns), broken down by kind, distinct from a lone terminal record (AC-OPS-2)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'lone-start', ts: '2026-08-01T00:00:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeStartOnlyRuns, 1)
  assert.equal(result.totals.agentComputeTerminalOnlyRuns, 0)
  assert.equal(result.totals.agentComputeStartOnlyByKind.tdd_task, 1)
  assert.equal(result.totals.agentComputeUnmeasuredRuns, 1, 'the new named counter is IN ADDITION to the existing total, never a replacement for it')
})

test('optimise-read: aggregateWallClock counts a lone terminal record (a failed START write) as a terminal-only orphan (agentComputeTerminalOnlyRuns), broken down by kind, distinct from a lone started record (AC-OPS-2)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'lone-terminal', ts: '2026-08-01T00:00:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeStartOnlyRuns, 0)
  assert.equal(result.totals.agentComputeTerminalOnlyRuns, 1)
  assert.equal(result.totals.agentComputeTerminalOnlyByKind.review_cycle, 1)
  assert.equal(result.totals.agentComputeUnmeasuredRuns, 1)
})

test('optimise-read: a malformed pairing (two started, no terminal) is counted in the combined unmeasured total but is NEITHER a start-only NOR a terminal-only orphan -- those two counters name a specific single-record shape, not every unmeasured shape (AC-OPS-2, AC-DATA-10 boundary)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'two-starts', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'two-starts', ts: '2026-08-01T01:00:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.agentComputeUnmeasuredRuns, 1, 'still counted in the combined total -- never silently dropped')
  assert.equal(result.totals.agentComputeStartOnlyRuns, 0, 'two started records is not the single-lone-started shape the named counter guards')
  assert.equal(result.totals.agentComputeTerminalOnlyRuns, 0)
})

// ---- Review round-1 M4: an orphan whose plan identity is unattributable
// (out-of-repo/redaction marker) or fully degraded was counted in NEITHER
// orphan class, because the orphan classification sat AFTER the two
// identity `continue`s -- so AC-OPS-2's "in addition to
// agentComputeUnmeasuredRuns" promise was untrue for these runs. Fixed by
// classifying the orphan SHAPE (which needs no plan identity at all)
// before the identity continues, leaving byPlan bucketing exactly where it
// was: these orphans still cannot attribute to a plan bucket, but they DO
// now count in the global start-only/terminal-only totals. ----

test('optimise-read: a lone started record whose plan identity is unattributable (out-of-repo) still counts as a start-only orphan in the global total, even though it creates no byPlan bucket (M4)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: '/etc/outside.md', run_id: 'unattrib-start', ts: '2026-08-01T00:00:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records, { root: '/repo' })
  assert.equal(result.byPlan.size, 0, 'sanity: this really is the unattributable-identity path, no byPlan bucket created')
  assert.equal(result.totals.unattributableRuns, 1, 'sanity: still counted under the existing unattributable total too')
  assert.equal(result.totals.agentComputeStartOnlyRuns, 1, 'an orphan is an orphan regardless of whether its plan identity is known (M4)')
  assert.equal(result.totals.agentComputeStartOnlyByKind.tdd_task, 1)
})

test('optimise-read: a lone terminal record that is fully degraded (no spec/plan_key survives at all) still counts as a terminal-only orphan in the global total (M4)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', run_id: 'degraded-terminal', ts: '2026-08-01T00:00:00.000Z', outcome: 'done', degraded: true },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.byPlan.size, 0)
  assert.equal(result.totals.degradedUnattributedRuns, 1, 'sanity: still counted under the existing degraded total too')
  assert.equal(result.totals.agentComputeTerminalOnlyRuns, 1, 'a degraded orphan is still an orphan (M4)')
  assert.equal(result.totals.agentComputeTerminalOnlyByKind.review_cycle, 1)
})

// AC-OPS-2's own worked example: "Against a copy of the current live ledger
// it must report startOnly=4 and terminalOnly=2 rather than a single
// unmeasured count of 6." seedNineRecordFixture (above) reproduces that
// exact live-ledger shape: rec0/rec4/rec5/rec6 are lone 'started'
// review_cycle records (4 start-only orphans); rec1 (review_cycle) and r1
// (tdd_task) are lone terminal records with no matching start (2
// terminal-only orphans, the "failed start write" class); rec7's
// started/done pair is the one genuinely measured run.
test('optimise-read CLI: `ledger <root>` over a fixture reproducing the real 9-record ledger reports startOnly=4 and terminalOnly=2, broken down by kind, rather than a single combined unmeasured count of 6 (AC-OPS-2, the spec\'s own worked example)', () => {
  const repo = makeTempRepo()
  seedNineRecordFixture(repo)
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.wallClock.totals.agentComputeUnmeasuredRuns, 6, 'sanity: the combined total must still be 6, unchanged by adding the named breakdown')
  assert.equal(out.wallClock.totals.agentComputeStartOnlyRuns, 4, `expected startOnly=4 per the spec's own worked example, got ${out.wallClock.totals.agentComputeStartOnlyRuns}`)
  assert.equal(out.wallClock.totals.agentComputeTerminalOnlyRuns, 2, `expected terminalOnly=2 per the spec's own worked example, got ${out.wallClock.totals.agentComputeTerminalOnlyRuns}`)
  assert.equal(out.wallClock.totals.agentComputeStartOnlyByKind.review_cycle, 4, 'all 4 start-only orphans in this fixture are review_cycle records (rec0, rec4, rec5, rec6)')
  assert.equal(out.wallClock.totals.agentComputeTerminalOnlyByKind.review_cycle, 1, 'rec1 is the review_cycle terminal-only orphan')
  assert.equal(out.wallClock.totals.agentComputeTerminalOnlyByKind.tdd_task, 1, 'r1 is the tdd_task terminal-only orphan')
})

// ---- Review round-1 H2: the ci_wait/human_wait path lacked the
// REDACTED_PATH_MARKER guard the agent_compute path already had, so two
// DIFFERENT out-of-repo plans merged into one bucket literally named
// "<redacted-path>" and their durations SUMMED -- a regression against
// main, which kept them distinct. ----

test('optimise-read: aggregateWallClock never merges two DIFFERENT out-of-repo ci_wait plans into one bucket -- both excluded from byPlan, counted under a named unattributable-waits total, durations never summed (H2, regression against main)', () => {
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: '/elsewhereA/specs/plan-one.md:T1:ci_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: '/elsewhereA/specs/plan-one.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:00:10.000Z' }, // 10s
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: '/elsewhereB/specs/plan-two.md:T1:ci_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: '/elsewhereB/specs/plan-two.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:05:00.000Z' }, // 300s
  ]
  const result = mod.aggregateWallClock(records, { root: '/repo' })
  for (const bucket of result.byPlan.values()) {
    assert.notEqual(bucket.plan, '<redacted-path>', 'the redaction marker must never be rendered as if it were a real plan name')
  }
  assert.equal(result.byPlan.size, 0, 'neither out-of-repo ci_wait plan may create (or share) a byPlan bucket')
  assert.equal(result.totals.unattributableWaits, 4, 'all 4 unattributable wait records must be counted, distinctly -- never silently merged as if they were one plan\'s measurement')
})

// ---- Review round-1 M3: pair plan-identity selection must be
// order-independent and must prefer a REAL spec over the no-spec sentinel,
// restoring main's `pair.find(p => p.spec)?.spec` semantics. harn-opt-2:AC-QA-13. ----

test('optimise-read: a pair where one record has no spec and the other carries a real spec attributes to the REAL spec, regardless of which record comes first in file order (M3, harn-opt-2:AC-QA-13)', () => {
  const noSpecRecord = { kind: 'tdd_task', repo: 'demo', outcome: 'started', run_id: 'r1', ts: '2026-08-01T00:00:00.000Z' }
  const realSpecRecord = { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'r1', ts: '2026-08-01T00:01:00.000Z' }
  const forward = mod.aggregateWallClock([noSpecRecord, realSpecRecord])
  const reversed = mod.aggregateWallClock([realSpecRecord, noSpecRecord])
  assert.deepEqual([...forward.byPlan.keys()], ['demo|specs/a.md'], 'forward order must attribute to the real spec, not the no-spec sentinel')
  assert.deepEqual([...reversed.byPlan.keys()], ['demo|specs/a.md'], 'reversed order must attribute identically')
  assert.equal(
    JSON.stringify([...forward.byPlan.entries()]),
    JSON.stringify([...reversed.byPlan.entries()]),
    'forward and reversed order must produce byte-identical aggregate output (harn-opt-2:AC-QA-13)'
  )
})

// HARN-OPT-2 PR2 (harn-opt-2:AC-QA-13): the new start-only/terminal-only orphan
// classification (AC-OPS-2) must be exactly as order-independent as every
// other aggregate here -- pairing is by run_id, keyed via a Map, never by
// file position or adjacency, so shuffling which orphan/pair comes first
// must never change the counts.
//
// Review round-1 M1: the FIRST version of this test used only ONE kind per
// orphan class, so its own `agentComputeStartOnlyByKind`/
// `agentComputeTerminalOnlyByKind` objects each held exactly one key --
// no ordering could ever differ, so the byte-identity assertion below could
// never fail regardless of whether the implementation serialised those maps
// in a fixed order or in raw record-encounter order. CONFIRMED by
// orchestrator execution: two start-only orphans of DIFFERENT kinds
// (tdd_task, review_cycle) sharing one plan produced
// `{"tdd_task":1,"review_cycle":1}` forward and
// `{"review_cycle":1,"tdd_task":1}` reversed -- not byte-identical. Fixed
// by giving EACH orphan class two different kinds, so the guard can now
// actually distinguish "always the same order" from "coincidentally only
// one entry".
test('optimise-read: a mixed set of paired runs and both orphan classes -- with TWO DIFFERENT KINDS in EACH orphan class, so the byKind maps have something to reorder -- produces byte-identical aggregate output regardless of record order (harn-opt-2:AC-QA-13, AC-OPS-2, M1)', () => {
  const paired1 = { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'p1', ts: '2026-08-01T00:00:00.000Z' }
  const paired2 = { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'p1', ts: '2026-08-01T00:01:00.000Z' }
  const startOnlyA = { kind: 'review_cycle', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'orphan-start-1', ts: '2026-08-01T00:00:00.000Z' }
  const startOnlyB = { kind: 'plan_cycle', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'orphan-start-2', ts: '2026-08-01T00:00:00.000Z' }
  const terminalOnlyA = { kind: 'plan_cycle', repo: 'demo', outcome: 'blocked', spec: 'specs/a.md', run_id: 'orphan-terminal-1', ts: '2026-08-01T00:00:00.000Z' }
  const terminalOnlyB = { kind: 'review_cycle', repo: 'demo', outcome: 'aborted', spec: 'specs/a.md', run_id: 'orphan-terminal-2', ts: '2026-08-01T00:00:00.000Z' }
  const all = [paired1, paired2, startOnlyA, startOnlyB, terminalOnlyA, terminalOnlyB]
  const orderings = [
    all,
    [...all].reverse(),
    [startOnlyB, terminalOnlyA, paired1, startOnlyA, paired2, terminalOnlyB],
    [terminalOnlyB, startOnlyA, terminalOnlyA, paired2, startOnlyB, paired1],
  ]
  const results = orderings.map((records) => JSON.stringify(mod.aggregateWallClock(records).totals))
  for (const r of results) assert.equal(r, results[0], 'every ordering must produce byte-identical totals')
  const totals = JSON.parse(results[0])
  assert.equal(totals.agentComputeMeasuredRuns, 1)
  assert.equal(totals.agentComputeStartOnlyRuns, 2)
  assert.equal(totals.agentComputeTerminalOnlyRuns, 2)
  assert.equal(totals.agentComputeStartOnlyByKind.review_cycle, 1)
  assert.equal(totals.agentComputeStartOnlyByKind.plan_cycle, 1)
  assert.equal(totals.agentComputeTerminalOnlyByKind.plan_cycle, 1)
  assert.equal(totals.agentComputeTerminalOnlyByKind.review_cycle, 1)
})

// harn-opt-2:AC-QA-13's own literal wording: "a fixture interleaving two concurrent
// runs' start/terminal lines, then the same lines reversed and shuffled,
// produces byte-identical aggregate output." No test in the suite exercised
// this literally (two genuine PAIRS, interleaved) before review round 1.
test('optimise-read: two concurrent runs\' start/terminal lines, interleaved, then reversed, then shuffled, produce byte-identical aggregate output (harn-opt-2:AC-QA-13, literal wording)', () => {
  const runAStart = { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'concurrent-a', ts: '2026-08-01T00:00:00.000Z' }
  const runBStart = { kind: 'review_cycle', repo: 'demo', outcome: 'started', spec: 'specs/b.md', run_id: 'concurrent-b', ts: '2026-08-01T00:00:05.000Z' }
  const runAEnd = { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'concurrent-a', ts: '2026-08-01T00:02:00.000Z' } // 120s
  const runBEnd = { kind: 'review_cycle', repo: 'demo', outcome: 'done', spec: 'specs/b.md', run_id: 'concurrent-b', ts: '2026-08-01T00:00:35.000Z' } // 30s
  const orderings = [
    [runAStart, runBStart, runAEnd, runBEnd], // interleaved
    [runBEnd, runAEnd, runBStart, runAStart], // reversed
    [runAEnd, runBStart, runAStart, runBEnd], // shuffled
  ]
  const results = orderings.map((records) => JSON.stringify(mod.aggregateWallClock(records).totals))
  for (const r of results) assert.equal(r, results[0], 'every ordering must produce byte-identical totals')
  const totals = JSON.parse(results[0])
  assert.equal(totals.agentComputeMeasuredRuns, 2)
  assert.equal(totals.agentComputeSeconds, 150)
})

// Review round-2 L-7: harn-opt-2:AC-QA-13's byte-identity was proven only for
// `.totals` -- `byPlan` (a Map) follows record-ENCOUNTER order, not a
// sorted key order, and every harn-opt-2:AC-QA-13 test up to this one only ever
// stringified `.totals`, so a differently-ordered `byPlan` (e.g. from a
// multi-repo aggregate or a resumed read) was never caught. Sorted by key
// before being returned.
test('optimise-read: aggregateWallClock\'s FULL aggregate (byPlan included, not just totals) is byte-identical regardless of record order -- byPlan is sorted by key, not left in record-encounter order (L-7)', () => {
  const runAStart = { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/a.md', run_id: 'concurrent-a', ts: '2026-08-01T00:00:00.000Z' }
  const runBStart = { kind: 'review_cycle', repo: 'demo', outcome: 'started', spec: 'specs/b.md', run_id: 'concurrent-b', ts: '2026-08-01T00:00:05.000Z' }
  const runAEnd = { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: 'specs/a.md', run_id: 'concurrent-a', ts: '2026-08-01T00:02:00.000Z' }
  const runBEnd = { kind: 'review_cycle', repo: 'demo', outcome: 'done', spec: 'specs/b.md', run_id: 'concurrent-b', ts: '2026-08-01T00:00:35.000Z' }
  const orderings = [
    [runAStart, runBStart, runAEnd, runBEnd],
    [runBEnd, runAEnd, runBStart, runAStart],
    [runAEnd, runBStart, runAStart, runBEnd],
  ]
  const results = orderings.map((records) => {
    const { byPlan } = mod.aggregateWallClock(records)
    return JSON.stringify([...byPlan.entries()])
  })
  for (const r of results) assert.equal(r, results[0], 'byPlan itself (key order included) must be byte-identical regardless of record order')
  const keys = JSON.parse(results[0]).map(([k]) => k)
  assert.deepEqual(keys, [...keys].sort(), 'byPlan must be returned in sorted key order, not record-encounter order')
})

test('optimise-read: three records sharing one run_id (forward, reversed, and shuffled), only one of which carries a real spec, all attribute to the real spec and produce byte-identical aggregates (M3, harn-opt-2:AC-QA-13, shuffled)', () => {
  const a = { kind: 'tdd_task', repo: 'demo', outcome: 'started', run_id: 'r1', ts: '2026-08-01T00:00:00.000Z' } // no spec
  const b = { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: 'specs/real.md', run_id: 'r1', ts: '2026-08-01T00:00:30.000Z' }
  const c = { kind: 'tdd_task', repo: 'demo', outcome: 'done', run_id: 'r1', ts: '2026-08-01T00:01:00.000Z' } // no spec
  const orderings = [[a, b, c], [c, b, a], [b, c, a], [c, a, b]]
  const results = orderings.map((records) => JSON.stringify([...mod.aggregateWallClock(records).byPlan.entries()]))
  for (const r of results) assert.equal(r, results[0], 'every ordering must produce byte-identical aggregate output')
  assert.ok(results[0].includes('specs/real.md'), 'sanity: the real spec must actually win in every ordering, or this test proves nothing')
  assert.ok(!results[0].includes('<no-spec>'), 'sanity: the no-spec sentinel must never win when a real spec is present anywhere in the pair')
})

// ---- Review round-1 M1 (read-side half), reproduction updated in round 2:
// round-1's canonicalPlanKey had a second "final shape" regex check
// (UNSAFE_EMBEDDED_SLASH_RE) that caught an embedded-but-not-leading
// absolute path like "plan=/Users/<user>/x.md". Round 2 removed that check
// entirely (Decision 1: it fired on legitimate already-relative segments
// containing ordinary punctuation indistinguishably from a genuine leak --
// see H1). The read-side re-canonicalisation itself is UNCHANGED and still
// load-bearing: a stored plan_key that is genuinely ABSOLUTE (starts with
// "/") and matches no known root is still redacted on read, exactly like a
// hostile `spec` would be -- defence in depth against a hand-edited or
// foreign ledger line. ----

test('optimise-read: aggregateWallClock re-canonicalises a STORED plan_key on read rather than trusting it verbatim -- a hand-edited line whose plan_key is a genuine absolute path outside every known root is still redacted (M1, read-side defence in depth)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', plan_key: '/Users/some-user/private/plan.md', run_id: 'r1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', plan_key: '/Users/some-user/private/plan.md', run_id: 'r1', ts: '2026-08-01T00:01:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  const stdout = JSON.stringify([...result.byPlan.entries()])
  assert.ok(!stdout.includes('/Users/'), 'a hostile stored plan_key must not reach byPlan verbatim')
  assert.equal(result.byPlan.size, 0, 'the re-canonicalised key must resolve to the out-of-repo marker and be excluded, exactly like a hostile spec would be')
  assert.equal(result.totals.unattributableRuns, 1)
})

test('optimise-read: a stored plan_key that is a genuine absolute path UNDER the analysis root re-canonicalises to the correct relative key on read (not vacuous: proves re-canonicalisation actually runs canonicalPlanKey\'s real logic, not just a blanket redact-if-absolute rule)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', plan_key: '/repo/specs/a.md', run_id: 'r1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', plan_key: '/repo/specs/a.md', run_id: 'r1', ts: '2026-08-01T00:01:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records, { root: '/repo' })
  assert.ok(result.byPlan.has('demo|specs/a.md'), `expected the absolute stored plan_key to re-canonicalise to the relative key under the analysis root, got ${JSON.stringify([...result.byPlan.keys()])}`)
})

// ---- Review round-2 M1 (the guard's REAL consumer): a pre-PR1 line's
// `spec` can be a verbatim "../" traversal -- main's own ABSOLUTE_PATH_RE
// matched only leading-slash/drive forms, so a relative traversal reached
// the ledger unredacted. This is exactly what planKeyForRecord's fallback
// (re-deriving from `spec` when no `plan_key` is stored) exists to catch
// on READ. Hand-seeded, not written through runAppend, since the fixed
// writer can no longer PRODUCE this shape at write time (the same fixture
// technique AC-DATA-6/AC-QA-5's fixtures already use). ----

test('optimise-read: a hand-seeded pre-PR1 line whose spec is a verbatim "../" traversal (no plan_key stored) is redacted on read via the spec fallback, counted as unattributable, and leaks nothing into the output (M1, end-to-end)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: '../../../home/some-operator/.ssh/config', run_id: 'r1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: '../../../home/some-operator/.ssh/config', run_id: 'r1', ts: '2026-08-01T00:01:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records, { root: '/repo' })
  assert.equal(result.byPlan.size, 0, 'the traversal must never create (or share) a byPlan bucket')
  assert.equal(result.totals.unattributableRuns, 1)
  const stdout = JSON.stringify([...result.byPlan.entries()]) + JSON.stringify(result.totals)
  assert.ok(!stdout.includes('/home/'), 'must not leak /home/')
  assert.ok(!stdout.includes('scott.b'), 'must not leak the account name')
  assert.ok(!stdout.includes('.ssh'), 'must not leak the traversal\'s target file name')
})

test('optimise-read: a genuinely clean stored plan_key is unaffected by re-canonicalisation (not vacuous)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', plan_key: 'specs/a.md', run_id: 'r1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', plan_key: 'specs/a.md', run_id: 'r1', ts: '2026-08-01T00:01:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records)
  assert.ok(result.byPlan.has('demo|specs/a.md'))
})

// Round 5 medium (AC-SEC-3): planKeyForRecord's line 163 branch
// (`record.plan_key` present, re-canonicalised regardless) had a real
// pre-PR1-shaped-line sibling test (M1, above) covering line 164's spec
// fallback with a HOSTILE value, but no equivalent for a hostile STORED
// plan_key -- a hand-edited or foreign ledger line (the spec itself
// documents this can happen) that carries plan_key already set to an
// absolute, out-of-repo path. Re-canonicalisation must catch it exactly
// like a hostile spec would.
test('optimise-read (round 5 medium, AC-SEC-3): a hand-seeded line whose STORED plan_key is itself an absolute, out-of-repo path is redacted on re-canonicalisation, counted as unattributable, and leaks nothing (line 163\'s branch, not just line 164\'s)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', plan_key: '/etc/hostile-secret.md', run_id: 'r1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', plan_key: '/etc/hostile-secret.md', run_id: 'r1', ts: '2026-08-01T00:01:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records, { root: '/repo' })
  assert.equal(result.byPlan.size, 0, 'a hostile stored plan_key must never create (or share) a byPlan bucket')
  assert.equal(result.totals.unattributableRuns, 1)
  const stdout = JSON.stringify([...result.byPlan.entries()]) + JSON.stringify(result.totals)
  assert.ok(!stdout.includes('/etc/'), 'must not leak the hostile path')
  assert.ok(!stdout.includes('hostile-secret'), 'must not leak the hostile filename')
})

// ---- Review round-1 M7: derivePerRepoLabel's no-records (uninstrumented)
// branch was covered by no test, and its old fallback (path.basename(root))
// could itself be the operator's account name for a home-shaped root. ----

test('optimise-read CLI: `ledger <root>` on an UNINSTRUMENTED root (no ledger file, no records) whose own BASENAME is the account name never emits the account name as perRepo[].root -- recursive walk for the same five patterns (M7, AC-SEC-3, reproducing the review\'s exact `<scratch>/Users/<user>` shape)', () => {
  const whoami = sh('whoami', SUITE_TMPDIR).trim()
  // The analysed root's own LAST path segment (its basename) is literally
  // the account name -- exactly `node optimise-read.mjs ledger <scratch>/Users/<user>`,
  // the review's own reproduction. A random segment sits BEFORE it only for
  // per-run uniqueness; it must never be the trailing (basename) segment.
  const homeLikeRoot = path.join(SUITE_TMPDIR, 'home', Math.random().toString(36).slice(2), whoami)
  fs.mkdirSync(homeLikeRoot, { recursive: true })
  trackTempDir(path.join(SUITE_TMPDIR, 'home'))
  sh('git init -q -b main', homeLikeRoot)
  sh('git config user.email test@example.com', homeLikeRoot)
  sh('git config user.name Test', homeLikeRoot)
  fs.writeFileSync(path.join(homeLikeRoot, 'README.md'), 'seed\n')
  sh('git add README.md && git commit -q -m seed', homeLikeRoot)
  assert.ok(/\/home\//.test(homeLikeRoot) && homeLikeRoot.includes(whoami), 'sanity: the fixture root must genuinely be home-shaped')
  // No runAppend call: this repo is deliberately UNINSTRUMENTED (no ledger
  // file at all), which is exactly the branch derivePerRepoLabel's fallback
  // governs -- withRepo is never found, so the fallback fires for real.

  const res = spawnSync('node', [MODULE_PATH, 'ledger', homeLikeRoot], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.perRepo.length, 1)
  assert.equal(out.perRepo[0].uninstrumented, true, 'sanity: this must genuinely exercise the no-records branch')
  assert.notEqual(out.perRepo[0].root, whoami, 'the fallback must never emit the bare account name')

  const violations = []
  function walk(value, at) {
    if (value === null || value === undefined) return
    if (typeof value === 'string') {
      if (/\/Users\//.test(value)) violations.push(`${at}: /Users/`)
      if (/\/Volumes\//.test(value)) violations.push(`${at}: /Volumes/`)
      if (/\/home\//.test(value)) violations.push(`${at}: /home/`)
      if (/C:\\/.test(value)) violations.push(`${at}: Windows path`)
      if (whoami && value.includes(whoami)) violations.push(`${at}: whoami in ${JSON.stringify(value)}`)
      return
    }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${at}[${i}]`)); return }
    if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) walk(v, `${at}.${k}`) }
  }
  walk(out, '$')
  assert.deepEqual(violations, [])
})

// ---- Review round-1 L1: skipped-line reasons echoed the parser's own
// error message verbatim, which can itself embed the first characters of
// the raw (corrupt) line -- including a leaked absolute path. ----

test('optimise-read: a skipped line beginning with an absolute path does not leak that path into the skip reason (L1, AC-SEC-3)', () => {
  const raw = '/Users/some-user/private/secret-plan.md was here\n'
  const { skipped } = mod.parseLedgerContent(raw)
  assert.equal(skipped.length, 1)
  assert.ok(!skipped[0].reason.includes('/Users/'), `skip reason must not echo the raw line's own content: ${JSON.stringify(skipped[0].reason)}`)
  assert.ok(!skipped[0].reason.includes('secret-plan'), `skip reason must not echo the raw line's target file name: ${JSON.stringify(skipped[0].reason)}`)
  assert.match(skipped[0].reason, /pars|JSON|invalid/i, 'the reason must still say WHY it was skipped, just not echo the raw content')
})

test('optimise-read: a skipped line with an ordinary (non-leaking) parse error still names the reason clearly (not vacuous)', () => {
  const raw = 'not json at all\n'
  const { skipped } = mod.parseLedgerContent(raw)
  assert.equal(skipped.length, 1)
  assert.match(skipped[0].reason, /pars|JSON|invalid/i)
})

test('optimise-read: aggregateWallClock never presents two DIFFERENT out-of-repo specs as one merged plan -- both are excluded from byPlan and counted under a named unattributable total instead (AC-DATA-7, AC-OPS-5)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: '/etc/plan-one.md', run_id: 'oor-1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: '/etc/plan-one.md', run_id: 'oor-1', ts: '2026-08-01T00:01:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'started', spec: '/var/plan-two.md', run_id: 'oor-2', ts: '2026-08-01T01:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', outcome: 'done', spec: '/var/plan-two.md', run_id: 'oor-2', ts: '2026-08-01T01:01:00.000Z' },
  ]
  const result = mod.aggregateWallClock(records, { root: '/repo' })
  for (const bucket of result.byPlan.values()) {
    assert.notEqual(bucket.plan, '<redacted-path>', 'the redaction marker must never be rendered as if it were a real plan name')
  }
  assert.equal(result.byPlan.size, 0, 'neither out-of-repo record may create (or share) a byPlan bucket')
  assert.equal(result.totals.unattributableRuns, 2, 'both records must be counted, distinctly, under the named unattributable total -- never silently merged as if they were the same plan')
})

test('optimise-read: aggregateRework excludes an out-of-repo spec from acVerdicts and counts it under unattributableCount instead of a plan-shaped bucket (AC-DATA-7, AC-OPS-5)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', spec: '/etc/plan-one.md', round_key: 's1', outcome: 'done', findings: [], ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'PASS' }] },
  ]
  const result = mod.aggregateRework(records, { root: '/repo' })
  assert.equal(result.acVerdicts.size, 0)
  assert.equal(result.unattributableCount, 1)
})

// ---- Review round-2 M-3, read side: ledger-append.mjs now writes
// ac_verdicts entries with a NULLED ac_id (never dropped) when the
// original was non-conforming, retaining ac_id_raw instead. aggregateRework
// keys its acVerdicts map by `${repo}|${plan}|${v.ac_id}` -- an unguarded
// null ac_id would stringify to the literal "null" and merge EVERY
// sanitised verdict from every plan into one fake "null" AC bucket,
// exactly the "different plans merge" bug class this whole spec exists to
// close, one field over. Guarded by excluding null-ac_id verdicts from
// bucketing; the per-record invalid_ac_ids_dropped counter (already
// computed by the writer, covering both findings and ac_verdicts) is
// summed across the window and exposed on the return so
// optimise-cycle.js can render it. ----

test('optimise-read: aggregateRework never merges verdicts with a NULLED ac_id (a sanitised, non-conforming id) into one fake "null" AC bucket -- two DIFFERENT plans\' sanitised verdicts must never collide (M-3, read-side guard)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: null, ac_id_raw: 'none', verdict: 'FAIL' }], invalid_ac_ids_dropped: 1 },
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/b.md', outcome: 'done', ac_verdicts: [{ ac_id: null, ac_id_raw: 'also-bad', verdict: 'PASS' }], invalid_ac_ids_dropped: 1 },
  ]
  const result = mod.aggregateRework(records)
  for (const [, entry] of result.acVerdicts.entries()) {
    assert.notEqual(entry.ac_id, null, 'a null ac_id must never reach a real bucket')
  }
  assert.equal(result.acVerdicts.size, 0, 'both sanitised verdicts must be excluded from acVerdicts entirely, never merged into one shared bucket')
})

test('optimise-read: aggregateRework still buckets a WELL-FORMED ac_verdicts entry normally when it shares a record with a sanitised (nulled) one -- the guard must not over-exclude (M-3, not vacuous)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-SEC-1', verdict: 'PASS' }, { ac_id: null, ac_id_raw: 'none', verdict: 'FAIL' }], invalid_ac_ids_dropped: 1 },
  ]
  const result = mod.aggregateRework(records)
  assert.equal(result.acVerdicts.size, 1)
  const entry = [...result.acVerdicts.values()][0]
  assert.equal(entry.ac_id, 'AC-SEC-1')
  assert.equal(entry.pass, 1)
})

test('optimise-read: aggregateRework sums invalid_ac_ids_dropped across the window and returns it, a real zero when clean (M-3)', () => {
  const clean = mod.aggregateRework([{ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-SEC-1', verdict: 'PASS' }], invalid_ac_ids_dropped: 0 }])
  assert.equal(clean.invalidAcIdsDropped, 0)
  const dirty = mod.aggregateRework([
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', invalid_ac_ids_dropped: 2 },
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/b.md', outcome: 'done', invalid_ac_ids_dropped: 1 },
  ])
  assert.equal(dirty.invalidAcIdsDropped, 3, 'must sum across every review_cycle record in the window')
})

// Fix round 1, finding 5: invalid_fixed_ids_dropped (specs/record-fixed-findings.md
// AC-3's own counter) was written to every review_cycle line and summed by
// nothing -- the one signal that a synthesis fabricated a confirmation this
// round reached no report. Mirrors invalidAcIdsDropped's own test exactly.
test('optimise-read: aggregateRework sums invalid_fixed_ids_dropped across the window and returns it, a real zero when clean (fix round 1, finding 5)', () => {
  const clean = mod.aggregateRework([{ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', invalid_fixed_ids_dropped: 0 }])
  assert.equal(clean.invalidFixedIdsDropped, 0)
  const dirty = mod.aggregateRework([
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', invalid_fixed_ids_dropped: 2 },
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/b.md', outcome: 'done', invalid_fixed_ids_dropped: 1 },
  ])
  assert.equal(dirty.invalidFixedIdsDropped, 3, 'must sum across every review_cycle record in the window')
})

// Fix round 1, finding 1 (read-side half): duplicate_fixed_ids_dropped
// gets the same treatment as invalid_fixed_ids_dropped above -- the new
// counter this fix round's writer-side dedup introduced must not become
// the NEXT "written to every line and read by nothing" field.
test('optimise-read: aggregateRework sums duplicate_fixed_ids_dropped across the window and returns it, a real zero when clean (fix round 1, finding 1 read-side)', () => {
  const clean = mod.aggregateRework([{ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', duplicate_fixed_ids_dropped: 0 }])
  assert.equal(clean.duplicateFixedIdsDropped, 0)
  const dirty = mod.aggregateRework([
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', duplicate_fixed_ids_dropped: 2 },
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/b.md', outcome: 'done', duplicate_fixed_ids_dropped: 1 },
  ])
  assert.equal(dirty.duplicateFixedIdsDropped, 3, 'must sum across every review_cycle record in the window')
})

// Fix round 2, AC-3 (specs/record-fixed-findings.md): invalid_prior_ids_dropped
// (the new trust-boundary counter -- a supplied prior_findings id that did
// not match its own recomputed content) gets the same summing treatment.
test('optimise-read: aggregateRework sums invalid_prior_ids_dropped across the window and returns it, a real zero when clean (fix round 2, AC-3)', () => {
  const clean = mod.aggregateRework([{ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', invalid_prior_ids_dropped: 0 }])
  assert.equal(clean.invalidPriorIdsDropped, 0)
  const dirty = mod.aggregateRework([
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', invalid_prior_ids_dropped: 2 },
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/b.md', outcome: 'done', invalid_prior_ids_dropped: 1 },
  ])
  assert.equal(dirty.invalidPriorIdsDropped, 3, 'must sum across every review_cycle record in the window')
})

// Fix round 1, finding 2 (HIGH, coordinator finding): the ledger has no
// memory across lines, and a conductor that re-supplies an already-
// confirmed finding as prior_findings on a LATER round (SKILL.md's own
// ambiguity, tightened but not eliminable in prose) produces a SECOND
// ledger line recording the SAME finding id 'fixed' again. Deduplication
// has to happen here, read-side, across the whole window -- the writer
// cannot see a different record it already wrote.
test('optimise-read: aggregateRework counts the SAME finding id confirmed fixed in TWO DIFFERENT records (same repo) only ONCE in lensDispositionCounts, not once per record (fix round 1, finding 2)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', round_key: 'sha1', outcome: 'done', findings: [{ id: 'f1', lens: 'lens-security', severity: 'High', ac_id: null, disposition: 'fixed' }] },
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', round_key: 'sha2', outcome: 'done', findings: [{ id: 'f1', lens: 'lens-security', severity: 'High', ac_id: null, disposition: 'fixed' }] },
  ]
  const result = mod.aggregateRework(records)
  assert.equal(result.lensDispositionCounts['lens-security'].fixed, 1, 'the same finding id confirmed twice across rounds must count once, not twice')
  assert.equal(result.duplicateFixedAcrossRounds, 1, 'the skip itself must be visible, not silently swallowed')
})

test('optimise-read: aggregateRework counts a finding id confirmed fixed once, PLUS a genuinely DIFFERENT finding id confirmed fixed, as two -- the cross-round dedupe must not over-collapse distinct findings (fix round 1, finding 2, not vacuous)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', round_key: 'sha1', outcome: 'done', findings: [{ id: 'f1', lens: 'lens-security', severity: 'High', ac_id: null, disposition: 'fixed' }] },
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', round_key: 'sha2', outcome: 'done', findings: [{ id: 'f2', lens: 'lens-security', severity: 'High', ac_id: null, disposition: 'fixed' }] },
  ]
  const result = mod.aggregateRework(records)
  assert.equal(result.lensDispositionCounts['lens-security'].fixed, 2, 'two genuinely different finding ids must both count')
})

test('optimise-read: aggregateRework does NOT dedupe the same finding id across TWO DIFFERENT repos -- distinct repos are distinct evidence, even on the astronomically unlikely id collision (fix round 1, finding 2, scope check)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo-a', spec: 'specs/a.md', round_key: 'sha1', outcome: 'done', findings: [{ id: 'f1', lens: 'lens-security', severity: 'High', ac_id: null, disposition: 'fixed' }] },
    { kind: 'review_cycle', repo: 'demo-b', spec: 'specs/a.md', round_key: 'sha1', outcome: 'done', findings: [{ id: 'f1', lens: 'lens-security', severity: 'High', ac_id: null, disposition: 'fixed' }] },
  ]
  const result = mod.aggregateRework(records)
  assert.equal(result.lensDispositionCounts['lens-security'].fixed, 2, 'the same id in two different repos must both count -- dedup is scoped per repo, not global')
})

// ---- Round-4 review M3: a FAILED criterion silently inverts to
// never_failed:true when the failing verdict's ac_id was sanitised (round-
// 2 M-3's own ac_id_raw retention) or supplied explicitly null. Both
// routes reach the exact same silent `continue` in aggregateRework: the
// FAIL is on disk (ac_id_raw, or just the bare FAIL verdict) but never
// enters any acVerdicts bucket, so a key with only PASS entries for the
// same (repo, plan) window reports a confident never_failed:true while the
// FAIL sits unread two lines away. This is precisely what neverFailingAcs
// feeds to the retire-the-guard proposal lane -- an inverted conclusion
// here means proposing to delete a check that DOES fail. Fixed minimally
// and safely (the review's own "or, minimally" option, chosen over
// re-attribution by ac_id_raw pattern-matching: re-attribution would let a
// hostile ac_id/ac_id_raw string ending in a real AC id redirect its own
// FAIL onto an unrelated criterion, a second injection route into
// telemetry): aggregateRework now tracks which (repo, plan) windows saw an
// unattributed FAIL, and neverFailingAcs degrades every ac_id in that
// window to never_failed:null with unattributed_fail_in_window:true,
// rather than computing from the (incomplete) pass/fail counts it can see. ----

test('optimise-read: neverFailingAcs never reports never_failed:true when an unattributed FAIL verdict (a sanitised, non-conforming ac_id) exists in the same repo+plan window -- a dropped FAIL row must degrade the claim to unknown, never invert it to true (M3, lens-data route, mirrors the review\'s own fixture)', () => {
  const passRecords = Array.from({ length: 5 }, () => ({
    kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done',
    ac_verdicts: [{ ac_id: 'AC-DATA-1', verdict: 'PASS' }],
  }))
  const failRecords = [
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: null, ac_id_raw: 'optimise-cycle:AC-DATA-1', verdict: 'FAIL' }], invalid_ac_ids_dropped: 1 },
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: null, ac_id_raw: 'optimise-cycle:AC-DATA-1', verdict: 'FAIL' }], invalid_ac_ids_dropped: 1 },
  ]
  const rework = mod.aggregateRework([...passRecords, ...failRecords])
  const never = mod.neverFailingAcs(rework.acVerdicts, { unattributedFailBuckets: rework.unattributedFailBuckets })
  assert.equal(never.length, 1, 'sanity: the 2 unattributed FAILs must not have created a second bucket')
  const entry = never[0]
  assert.equal(entry.ac_id, 'AC-DATA-1')
  assert.equal(entry.n, 5, 'sanity: the 2 unattributed FAILs must not have entered this bucket by any other route')
  assert.equal(entry.never_failed, null, 'a hidden FAIL must never be reported as a confident never_failed:true')
  assert.equal(entry.unattributed_fail_in_window, true, 'the degradation reason must be distinguishable from insufficient_data')
})

test('optimise-read: an EXPLICITLY-null ac_id FAIL (never sanitised -- supplied that way, no ac_id_raw at all) taints the bucket the same way a sanitised one does (M3, lens-security route)', () => {
  const records = [
    ...Array.from({ length: 5 }, () => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-SEC-9', verdict: 'PASS' }] })),
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: null, verdict: 'FAIL' }] },
  ]
  const rework = mod.aggregateRework(records)
  const never = mod.neverFailingAcs(rework.acVerdicts, { unattributedFailBuckets: rework.unattributedFailBuckets })
  const entry = never.find((e) => e.ac_id === 'AC-SEC-9')
  assert.equal(entry.never_failed, null)
  assert.equal(entry.unattributed_fail_in_window, true)
})

test('optimise-read: neverFailingAcs does NOT taint a bucket when the unattributed verdict was a PASS or UNVERIFIABLE, not a FAIL -- only a hidden FAIL is the inversion risk (M3, not vacuous)', () => {
  const records = [
    ...Array.from({ length: 5 }, () => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-DATA-1', verdict: 'PASS' }] })),
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: null, ac_id_raw: 'optimise-cycle:AC-DATA-1', verdict: 'PASS' }], invalid_ac_ids_dropped: 1 },
  ]
  const rework = mod.aggregateRework(records)
  const never = mod.neverFailingAcs(rework.acVerdicts, { unattributedFailBuckets: rework.unattributedFailBuckets })
  const entry = never.find((e) => e.ac_id === 'AC-DATA-1')
  assert.equal(entry.never_failed, true, 'an unattributed PASS carries no inversion risk and must not suppress a genuine never_failed:true')
  assert.equal(entry.unattributed_fail_in_window, false)
})

test('optimise-read: an unattributed FAIL in one plan\'s window does not taint a DIFFERENT plan\'s never_failed claim (M3, not over-broad)', () => {
  const records = [
    ...Array.from({ length: 5 }, () => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-DATA-1', verdict: 'PASS' }] })),
    ...Array.from({ length: 5 }, () => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/b.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-DATA-2', verdict: 'PASS' }] })),
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: null, ac_id_raw: 'optimise-cycle:AC-DATA-1', verdict: 'FAIL' }], invalid_ac_ids_dropped: 1 },
  ]
  const rework = mod.aggregateRework(records)
  const never = mod.neverFailingAcs(rework.acVerdicts, { unattributedFailBuckets: rework.unattributedFailBuckets })
  const tainted = never.find((e) => e.ac_id === 'AC-DATA-1')
  const clean = never.find((e) => e.ac_id === 'AC-DATA-2')
  assert.equal(tainted.never_failed, null)
  assert.equal(clean.never_failed, true, 'a different plan\'s bucket must never be tainted by another plan\'s unattributed FAIL')
})

test('optimise-read: neverFailingAcs called with no unattributedFailBuckets option at all (every pre-M3 call site) behaves exactly as before -- backward compatible, no default taint (M3)', () => {
  const records = Array.from({ length: 5 }, () => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-DATA-1', verdict: 'PASS' }] }))
  const rework = mod.aggregateRework(records)
  const never = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 5 })
  assert.equal(never[0].never_failed, true)
  assert.equal(never[0].unattributed_fail_in_window, false)
})

// ---- Round-6 review H1 (§12 reframe, read-side half), corrected AGAIN in
// round 7 -- read the round-7 fix comments in optimise-read.mjs itself
// before touching this table. Round-6's guard (and this exact table)
// asked a SHAPE question: "is the value null AND does a *_raw sibling
// happen to be present?" The round-6 coordinator verification used
// exactly that shape ({verdict:null, verdict_raw:'FAILED'}) and reported
// the bug fixed; it was not -- a BARE `verdict:null` with NO sibling at
// all (schema-legal, a caller can supply it directly, never touches
// degradeEntry) sailed straight past the guard and reproduced the
// IDENTICAL inversion. That is the fourth recurrence of "the fixture
// agrees with the code" on this PR, and this time it was in the
// verification, not just the implementation.
//
// THE STANDING RULE, so a fifth recurrence does not happen: an "is this
// evidence?" test must enumerate the VALID values and assert that
// EVERYTHING ELSE is not evidence. It must NEVER match on the shape a
// particular fix happens to produce. Concretely, every neutralisable
// field below is driven through THREE rows -- (a) null WITH the *_raw
// sibling present (degradeEntry's own shape), (b) a BARE null with NO
// sibling at all, and (c) an arbitrary junk value that is not null at
// all -- all asserting NOT evidence. If a future change to this table
// removes case (b) or (c) and keeps only (a), that IS this exact mistake
// recurring: do not approve it. ----

const VERDICT_NOT_EVIDENCE_TABLE = [
  { label: 'null + verdict_raw present (degradeEntry\'s own shape -- what round-6\'s fix AND its own verification tested)', verdict: null, verdict_raw: 'FAILED' },
  { label: 'BARE null, NO verdict_raw at all (schema-legal, never touches degradeEntry -- the shape round-6 missed, reproduced verbatim by the coordinator against the round-6 tip)', verdict: null },
  { label: 'arbitrary junk string, not null, not a known verdict (a hand-edited or pre-degradeEntry ledger line)', verdict: 'MAYBE' },
]

for (const row of VERDICT_NOT_EVIDENCE_TABLE) {
  test(`optimise-read: NEUTRALISED-VALUE TABLE -- ac_verdicts[].verdict, ${row.label}: does not count toward n, does not move pass/fail, taints never_failed to null (round-7 F1)`, () => {
    const acVerdict = { ac_id: 'AC-DATA-9', verdict: row.verdict }
    if ('verdict_raw' in row) acVerdict.verdict_raw = row.verdict_raw
    const records = Array.from({ length: 5 }, () => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ...acVerdict }] }))
    const rework = mod.aggregateRework(records)
    const entry = [...rework.acVerdicts.values()].find((e) => e.ac_id === 'AC-DATA-9')
    assert.ok(entry, `${row.label}: the ac_id must still be VISIBLE in the report`)
    assert.equal(entry.n, 0, `${row.label}: must not count toward n`)
    assert.equal(entry.pass, 0, `${row.label}: must not move pass`)
    assert.equal(entry.fail, 0, `${row.label}: must not move fail`)
    const never = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 5, unattributedFailBuckets: rework.unattributedFailBuckets })
    const nf = never.find((a) => a.ac_id === 'AC-DATA-9')
    assert.equal(nf.never_failed, null, `${row.label}: must NEVER report true on zero real evidence`)
    assert.equal(nf.unattributed_verdict_in_entry, true, `${row.label}: must trip the taint signal independently`)
  })
}

const LENS_NOT_EVIDENCE_TABLE = [
  { label: 'null + lens_raw present (degradeEntry\'s own shape)', lens: null, lens_raw: 'orchestrator' },
  { label: 'BARE null, NO lens_raw at all (a genuinely omitted `lens` field, round-7 F2\'s own shape)', lens: null },
  { label: 'arbitrary junk string not matching the lens/reviewer pattern', lens: 'not-a-real-lens-name' },
]

for (const row of LENS_NOT_EVIDENCE_TABLE) {
  test(`optimise-read: NEUTRALISED-VALUE TABLE -- findings[].lens, ${row.label}: excluded from lensDispositionCounts, never creates a bucket (round-7 F1)`, () => {
    const finding = { id: 'f1', severity: 'Low', ac_id: null, disposition: 'open', lens: row.lens }
    if ('lens_raw' in row) finding.lens_raw = row.lens_raw
    const records = [{ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', findings: [finding] }]
    const rework = mod.aggregateRework(records)
    assert.equal(Object.keys(rework.lensDispositionCounts).length, 0, `${row.label}: must not create ANY disposition bucket, real or fake`)
  })
}

test('optimise-read: NEUTRALISED-VALUE TABLE -- findings[].lens: two DIFFERENT non-evidence lenses (one neutralised-with-sibling, one bare-null) never merge into one fake shared bucket, and a genuine lens alongside them is still counted normally (round-7, not over-broad)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', findings: [{ id: 'f1', lens: null, lens_raw: 'orchestrator', severity: 'Low', ac_id: null, disposition: 'open' }] },
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', findings: [{ id: 'f2', lens: null, severity: 'Low', ac_id: null, disposition: 'spec_bug' }] }, // bare null, no sibling
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', findings: [{ id: 'f3', lens: 'lens-security', severity: 'Low', ac_id: null, disposition: 'rejected' }] },
  ]
  const rework = mod.aggregateRework(records)
  assert.equal(rework.lensDispositionCounts['null'], undefined, 'two DIFFERENT non-evidence lenses must never merge into one fake "null" bucket')
  assert.deepEqual(rework.lensDispositionCounts['lens-security'], { fixed: 0, rejected: 1, spec_bug: 0, open: 0 }, 'the one genuine lens must still be counted normally -- the guard must not over-exclude')
  assert.equal(Object.keys(rework.lensDispositionCounts).length, 1, 'only the genuine lens should appear at all')
})

const AC_ID_NOT_EVIDENCE_TABLE = [
  { label: 'null + ac_id_raw present (degradeEntry\'s own shape)', ac_id: null, ac_id_raw: 'optimise-cycle:AC-DATA-1' },
  { label: 'BARE null, NO ac_id_raw at all (round-4 M3\'s own explicit-null shape)', ac_id: null },
]

for (const row of AC_ID_NOT_EVIDENCE_TABLE) {
  test(`optimise-read: NEUTRALISED-VALUE TABLE -- ac_verdicts[].ac_id, ${row.label}: excluded from bucketing (pre-existing round-4 M3 mechanism, already value-based -- re-verified under round-7's own table discipline)`, () => {
    const verdict = { verdict: 'FAIL', ac_id: row.ac_id }
    if ('ac_id_raw' in row) verdict.ac_id_raw = row.ac_id_raw
    const records = Array.from({ length: 5 }, () => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ...verdict }] }))
    const rework = mod.aggregateRework(records)
    assert.equal(rework.acVerdicts.size, 0, `${row.label}: must never create a bucket keyed on the literal string "null"`)
  })
}

test('optimise-read: NEUTRALISED-VALUE TABLE -- findings[].severity, neutralised: has NO current read-side consumer, so there is nothing to taint -- stated and proven directly, not silently skipped (round-6 instruction 3)', () => {
  const records = [{ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', findings: [{ id: 'f1', lens: 'lens-security', severity: null, severity_raw: 'Urgent', ac_id: null, disposition: 'open' }] }]
  const rework = mod.aggregateRework(records)
  // The only conclusion aggregateRework draws from a finding is its
  // disposition (bumpDisposition, by lens) -- severity never reaches any
  // aggregate today. Proven, not assumed: the genuine lens's disposition
  // count is unaffected by severity being neutralised alongside it.
  assert.deepEqual(rework.lensDispositionCounts['lens-security'], { fixed: 0, rejected: 0, spec_bug: 0, open: 1 })
})

test('optimise-read: NEUTRALISED-VALUE TABLE -- invalid_record_values_dropped is summed across the window and returned, mirroring invalidAcIdsDropped exactly (round-6 instruction 4)', () => {
  const records = [
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', invalid_record_values_dropped: 2 },
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/b.md', outcome: 'done', invalid_record_values_dropped: 1 },
  ]
  const rework = mod.aggregateRework(records)
  assert.equal(rework.invalidRecordValuesDropped, 3)
})

// ---- Round-6: the NON-neutralised control. The fix must not degenerate
// into tainting everything -- a genuine FAIL must still report
// never_failed:false, and a genuine all-PASS window must still report
// true. Run in the SAME file, immediately after the neutralised table, so
// a reader sees both halves of the proof together. ----

test('optimise-read: NON-neutralised control -- a genuine FAIL verdict (not null, no *_raw sibling involved) still reports never_failed:false, exactly as before (round-6, proves the fix does not over-taint)', () => {
  const records = Array.from({ length: 5 }, (_, i) => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-DATA-10', verdict: i === 2 ? 'FAIL' : 'PASS' }] }))
  const rework = mod.aggregateRework(records)
  const entry = [...rework.acVerdicts.values()].find((e) => e.ac_id === 'AC-DATA-10')
  assert.equal(entry.n, 5)
  const never = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 5, unattributedFailBuckets: rework.unattributedFailBuckets })
  const nf = never.find((a) => a.ac_id === 'AC-DATA-10')
  assert.equal(nf.never_failed, false, 'a genuine, real FAIL must still be reported as a real FAIL')
  assert.equal(nf.unattributed_verdict_in_entry, false)
})

test('optimise-read: NON-neutralised control -- a genuine all-PASS window (n meeting the minimum, no neutralised verdicts anywhere) still reports never_failed:true (round-6, proves the fix does not over-taint)', () => {
  const records = Array.from({ length: 5 }, () => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-DATA-11', verdict: 'PASS' }] }))
  const rework = mod.aggregateRework(records)
  const never = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 5, unattributedFailBuckets: rework.unattributedFailBuckets })
  const nf = never.find((a) => a.ac_id === 'AC-DATA-11')
  assert.equal(nf.never_failed, true, 'a genuinely well-supported never-failing criterion must still be reported as such -- the fix must not blind the report entirely')
  assert.equal(nf.unattributed_verdict_in_entry, false)
})

test('optimise-read: NON-neutralised control -- a MIX of real verdicts and one neutralised verdict for the SAME ac_id still taints never_failed to null (not diluted into a false confidence by the real evidence sitting alongside it)', () => {
  const records = [
    ...Array.from({ length: 5 }, () => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-DATA-12', verdict: 'PASS' }] })),
    { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-DATA-12', verdict: null, verdict_raw: 'FAILED' }] },
  ]
  const rework = mod.aggregateRework(records)
  const entry = [...rework.acVerdicts.values()].find((e) => e.ac_id === 'AC-DATA-12')
  assert.equal(entry.n, 5, 'the 5 real PASS verdicts must still count -- the neutralised one must not subtract from n, only fail to ADD to it')
  const never = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 5, unattributedFailBuckets: rework.unattributedFailBuckets })
  const nf = never.find((a) => a.ac_id === 'AC-DATA-12')
  assert.equal(nf.never_failed, null, 'one neutralised verdict alongside five real PASSes must still taint the claim -- real evidence does not vouch for the unknown sitting next to it')
})

// Round-7 review F4: DUAL corruption (an unattributed ac_id AND a
// non-evidence verdict on the SAME entry) used to produce NO taint at
// all -- more corruption yielding MORE confidence than a single-field
// defect, since the taint check tested `v.verdict === 'FAIL'` literally
// and neither null nor an arbitrary junk string is the literal string
// 'FAIL'. Reproduces the review's own two shapes: both explicitly null,
// and the realistic writer output for a model-supplied combined field
// like {ac_id:'AC-QA-8 (partial)', verdict:'PARTIAL'} (degradeEntry
// neutralises BOTH independently, in one pass, to {ac_id:null,
// verdict:null}).
test('optimise-read: NEUTRALISED-VALUE TABLE -- DUAL corruption (ac_id AND verdict both non-evidence on the same entry) still taints the (repo,plan) window -- must not produce MORE confidence than a single-field defect (round-7 F4)', () => {
  const dualCorrupt = [
    { ac_id: null, verdict: null }, // both explicitly null, no *_raw at all
    { ac_id: null, ac_id_raw: 'AC-QA-8 (partial)', verdict: null, verdict_raw: 'PARTIAL' }, // degradeEntry's own realistic shape
  ]
  for (const badVerdict of dualCorrupt) {
    const records = [
      ...Array.from({ length: 5 }, () => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'PASS' }] })),
      { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ...badVerdict }] },
    ]
    const rework = mod.aggregateRework(records)
    const never = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 5, unattributedFailBuckets: rework.unattributedFailBuckets })
    const nf = never.find((a) => a.ac_id === 'AC-QA-1')
    assert.equal(nf.never_failed, null, `dual-corrupt shape ${JSON.stringify(badVerdict)} must still taint the window, not report a confident true`)
  }
})

test('optimise-read: NON-neutralised control -- an unattributed ac_id whose verdict is a genuine PASS or UNVERIFIABLE (not a hidden FAIL) does NOT taint the window -- round-7 F4 must not over-taint (not vacuous)', () => {
  for (const cleanVerdict of ['PASS', 'UNVERIFIABLE']) {
    const records = [
      ...Array.from({ length: 5 }, () => ({ kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: 'AC-QA-2', verdict: 'PASS' }] })),
      { kind: 'review_cycle', repo: 'demo', spec: 'specs/a.md', outcome: 'done', ac_verdicts: [{ ac_id: null, ac_id_raw: 'bogus', verdict: cleanVerdict }] },
    ]
    const rework = mod.aggregateRework(records)
    const never = mod.neverFailingAcs(rework.acVerdicts, { minRuns: 5, unattributedFailBuckets: rework.unattributedFailBuckets })
    const nf = never.find((a) => a.ac_id === 'AC-QA-2')
    assert.equal(nf.never_failed, true, `an unattributed ac_id with a genuine ${cleanVerdict} carries no inversion risk and must not taint the window`)
  }
})

test('optimise-read: aggregateWallClock excludes a fully-degraded pair (both records marked degraded:true, no spec survives) from byPlan -- counted under a named degraded-run total, never silently folded into the no-spec bucket (AC-QA-7)', () => {
  const records = [
    { kind: 'tdd_task', repo: 'demo', run_id: 'deg-1', ts: '2026-08-01T00:00:00.000Z', degraded: true },
    { kind: 'tdd_task', repo: 'demo', run_id: 'deg-1', ts: '2026-08-01T00:01:00.000Z', outcome: 'done', degraded: true },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.byPlan.size, 0, 'a fully-degraded pair must not create (or fall into) a no-spec byPlan bucket')
  assert.equal(result.totals.degradedUnattributedRuns, 1)
})

test('optimise-read: aggregateWallClock still attributes a pair where only ONE side degraded -- the surviving side\'s plan identity is real and must not be discarded just because its partner degraded (AC-QA-7, not vacuous)', () => {
  // HARN-OPT-2 PR2 (AC-DATA-10): the start record must carry outcome
  // 'started' like every other pair fixture in this file (and like every
  // real start record the writer actually emits) -- a genuine start/terminal
  // pair is now identified by outcome, not merely by record count.
  const records = [
    { kind: 'tdd_task', repo: 'demo', run_id: 'partial-1', spec: 'specs/a.md', outcome: 'started', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'tdd_task', repo: 'demo', run_id: 'partial-1', ts: '2026-08-01T00:01:00.000Z', outcome: 'done', degraded: true },
  ]
  const result = mod.aggregateWallClock(records)
  assert.equal(result.totals.degradedUnattributedRuns, 0, 'a pair with a real spec on one side must not count as unattributed-degraded')
  const bucket = result.byPlan.get('demo|specs/a.md')
  assert.ok(bucket, 'the real plan identity must survive even though its terminal partner degraded')
  assert.equal(bucket.agentComputeN, 1)
})

test('optimise-read: aggregateWallClock canonicalises the ci_wait event_key plan segment too, not just agent_compute\'s spec -- an absolute-form event_key and a relative-form event_key for the same plan collapse into ONE bucket (AC-ARCH-4, the ci_wait/human_wait half)', () => {
  const root = '/repo'
  const records = [
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: '/repo/specs/a.md:T1:ci_wait_started:1', ts: '2026-08-01T00:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: '/repo/specs/a.md:T1:ci_wait_ended:1', ts: '2026-08-01T00:00:10.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_started', event_key: 'specs/a.md:T1:ci_wait_started:2', ts: '2026-08-01T01:00:00.000Z' },
    { kind: 'conduct_plan_event', repo: 'demo', event: 'ci_wait_ended', event_key: 'specs/a.md:T1:ci_wait_ended:2', ts: '2026-08-01T01:00:20.000Z' },
  ]
  const result = mod.aggregateWallClock(records, { root })
  assert.equal(result.byPlan.size, 1, `expected the absolute and relative event_key forms to collapse into one bucket, got ${JSON.stringify([...result.byPlan.keys()])}`)
  const bucket = result.byPlan.get('demo|specs/a.md')
  assert.ok(bucket, 'expected the canonical "demo|specs/a.md" bucket')
  assert.equal(bucket.ciWaitN, 2, 'both the absolute-form and relative-form pairs must be measured inside the ONE bucket')
  assert.equal(bucket.ciWaitSeconds, 30)
})

test('optimise-read module: canonicalPlanKey and the marker/sentinel constants are imported from ledger-append.mjs, not redeclared -- no second normalisation implementation (no path-stripping regex, no path.normalize on a spec value) anywhere in optimise-read.mjs (AC-ARCH-1)', () => {
  const contents = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'lib', 'optimise-read.mjs'), 'utf8')
  assert.ok(/import\s*\{[^}]*canonicalPlanKey[^}]*\}\s*from\s*['"]\.\/ledger-append\.mjs['"]/.test(contents), 'expected optimise-read.mjs to import canonicalPlanKey from ledger-append.mjs')
  assert.ok(!/path\.normalize/.test(contents), 'optimise-read.mjs must not run its own path.normalize on a spec value -- canonicalPlanKey is the single definition site')
  assert.ok(!/function\s+canonicalPlanKey/.test(contents.replace(/import[^\n]*canonicalPlanKey[^\n]*/, '')), 'optimise-read.mjs must not declare a second canonicalPlanKey of its own')
})

// ---- window selection must be by recency, not by argument order ----
//
// Round-3 F5 established that a small --window starves the FIRST-listed
// repo, and made the loss detectable by comparing perRepo's summed
// recordCount against the windowed n. That reconciliation signal is real and
// stays. What it does not establish is that the RIGHT records were kept.
//
// combinedRecords is built by concatenating each root's records in root
// order, so the array is repo-major and only time-ordered WITHIN a repo.
// windowRecords keeps the array TAIL. The two facts together mean the window
// is selected by argument position rather than by time: whichever repo is
// listed last wins, and its OLDEST records outrank the first-listed repo's
// NEWEST ones. citationPool has the same positional assumption -- it walks
// the array backwards and calls that "most-recent-first".
//
// F5's own fixture could not catch this, because it appended repoA's records
// before repoB's, so the first-listed repo genuinely WAS the oldest and
// position happened to agree with time. This fixture breaks that agreement:
// the first-listed repo holds the newest records. That is not a contrived
// case -- it is what an alphabetical or config-file-ordered root list gives
// you the moment one repo is busier than another, which is precisely the
// multi-repo shape T1 instruments the delivery repos for.
test('optimise-read CLI: the --window keeps the globally most RECENT records across roots, not merely the tail of the concatenated array -- the first-listed root\'s newest records must outrank a later-listed root\'s oldest', () => {
  const repoA = makeTempRepo()
  const repoB = makeTempRepo()

  const write = (repo, records) => {
    const p = path.join(repo, '.claude', 'harness-ledger.jsonl')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  }
  const rec = (id, ts) => ({ schema_version: 2, run_id: id, ts, repo: 'fixture/repo', kind: 'tdd_task', outcome: 'done' })

  // repoA is listed FIRST and holds the three NEWEST records.
  write(repoA, [
    rec('A-newest-1', '2026-08-18T10:00:00.000Z'),
    rec('A-newest-2', '2026-08-18T11:00:00.000Z'),
    rec('A-newest-3', '2026-08-18T12:00:00.000Z'),
  ])
  // repoB is listed SECOND and holds five OLDER records.
  write(repoB, [
    rec('B-old-1', '2026-08-10T01:00:00.000Z'),
    rec('B-old-2', '2026-08-10T02:00:00.000Z'),
    rec('B-old-3', '2026-08-10T03:00:00.000Z'),
    rec('B-old-4', '2026-08-10T04:00:00.000Z'),
    rec('B-old-5', '2026-08-10T05:00:00.000Z'),
  ])

  const res = spawnSync('node', [MODULE_PATH, 'ledger', repoA, repoB, '--window=4'], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())

  assert.equal(out.n, 4, 'window=4 over 8 combined records')
  assert.equal(out.windowTruncated, true)
  assert.equal(out.windowDroppedCount, 4)

  // The four surviving records must be the four newest BY TIMESTAMP:
  // A's three, plus B's single newest. Under tail-slicing they would instead
  // be B-old-2..B-old-5, discarding every one of the newest three.
  const kept = new Set(out.citationPool)
  for (const id of ['A-newest-1', 'A-newest-2', 'A-newest-3']) {
    assert.ok(kept.has(id), `${id} is among the four newest records by timestamp and must survive a window of 4; kept=${JSON.stringify(out.citationPool)}`)
  }
  assert.ok(kept.has('B-old-5'), 'B-old-5 is the fourth-newest record and must survive')
  for (const id of ['B-old-1', 'B-old-2', 'B-old-3', 'B-old-4']) {
    assert.ok(!kept.has(id), `${id} is older than four other records and must be dropped by a window of 4; kept=${JSON.stringify(out.citationPool)}`)
  }

  // citationPool documents itself as most-recent-first; with the window
  // selected by time that ordering must actually hold.
  assert.deepEqual(
    out.citationPool,
    ['A-newest-3', 'A-newest-2', 'A-newest-1', 'B-old-5'],
    'citationPool must be ordered most-recent-first by timestamp, across roots'
  )
})

// The ledger envelope requires `ts` to be a non-empty string and nothing
// more (ledger-append.mjs's schema: `{ type: 'string', minLength: 1 }`), so a
// non-ISO value is reachable from a hand-edited file, a future writer, or a
// hostile repo. sortRecordsByTime deliberately treats such a record as the
// OLDEST rather than the newest: an unusable timestamp must never displace a
// record whose time is known and recent. Tested directly rather than only
// through the CLI, because the rule is a decision, and a decision nobody has
// watched fail is not guarded.
test('optimise-read: sortRecordsByTime treats a missing or unparseable ts as OLDEST, never newest, and keeps equal-timestamp records in their original read order', () => {
  const records = [
    { run_id: 'no-ts' },
    { run_id: 'newest', ts: '2026-08-18T12:00:00.000Z' },
    { run_id: 'garbage-ts', ts: 'not-a-timestamp' },
    { run_id: 'tie-a', ts: '2026-08-11T00:00:00.000Z' },
    { run_id: 'oldest', ts: '2026-08-10T00:00:00.000Z' },
    { run_id: 'tie-b', ts: '2026-08-11T00:00:00.000Z' },
    { run_id: 'empty-ts', ts: '' },
  ]
  const sorted = mod.sortRecordsByTime(records).map((r) => r.run_id)

  // The three unusable-ts records lead (oldest), in their original order.
  assert.deepEqual(sorted.slice(0, 3), ['no-ts', 'garbage-ts', 'empty-ts'], 'records with no usable ts sort oldest, preserving read order among themselves')
  // Then real timestamps ascending, with the tie broken by read order.
  assert.deepEqual(sorted.slice(3), ['oldest', 'tie-a', 'tie-b', 'newest'])

  // The property that matters: an unusable ts must never survive a window
  // that a real, recent record loses.
  const { windowed } = mod.windowRecords(mod.sortRecordsByTime(records), 2)
  assert.deepEqual(windowed.map((r) => r.run_id), ['tie-b', 'newest'], 'a 2-record window keeps the two genuinely newest, not the untimestamped ones')

  // Non-mutating: the caller's array is untouched.
  assert.equal(records[0].run_id, 'no-ts', 'sortRecordsByTime must not reorder the caller\'s array in place')
})
