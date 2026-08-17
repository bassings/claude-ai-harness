const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')

const WF = path.join(__dirname, '..', 'workflows', 'tdd-task.js')

const LEDGER_OK = { run_id: 'r1', ts: '2026-08-10T00:00:00.000Z', write_ok: true, write_error: null }

const DONE_AGENT = {
  'write-test#1': { test_files: ['a.test.js'], test_command: 'node a.test.js', expected_failure: 'missing fn' },
  'verify-red#1': { red: true, right_reason: true, evidence: 'threw', test_hashes: [{ file: 'a.test.js', sha256: 'abc' }] },
  'implement#1': { summary: 'added fn', files_changed: ['a.js'] },
  'verify-green#1': { green: true, suite_green: true, hashes_match: true, evidence: 'passed' },
  commit: { sha: 'deadbeef', message: 'feat: thing' },
  'ledger:write': LEDGER_OK,
}

test('tdd-task.js: DONE path returns the pre-existing documented shape unchanged, plus telemetry under one new key (AC-ARCH-10)', async () => {
  const { result, calls } = await runWorkflow(WF, { args: { task: 'do the thing' }, agent: DONE_AGENT })
  assert.equal(result.verdict, 'DONE')
  assert.equal(result.task, 'do the thing')
  assert.deepEqual(result.test_files, ['a.test.js'])
  assert.equal(result.red_evidence, 'threw')
  assert.equal(result.green_evidence, 'passed')
  assert.equal(result.tests_frozen, true)
  assert.equal(result.implementation, 'added fn')
  assert.deepEqual(result.commit, { sha: 'deadbeef', message: 'feat: thing' })
  assert.ok(calls.find((c) => c.opts.label === 'commit'))
  assert.ok(result.telemetry, 'telemetry must be added under a new top-level key')
  assert.equal(result.telemetry.outcome, 'done')
})

// L5: AC-ARCH-10's "exactly one new top-level key" clause was unguarded --
// nothing asserted the FULL key set, only that specific keys existed and had
// the right value, so leaking the internal __outcome sentinel into the
// public result (instead of destructuring it out) would pass every existing
// assertion above unnoticed.
test('tdd-task.js: the DONE-path result carries EXACTLY its documented keys plus telemetry -- no internal sentinel (__outcome or otherwise) leaks through (L5, AC-ARCH-10)', async () => {
  const { result } = await runWorkflow(WF, { args: { task: 'do the thing' }, agent: DONE_AGENT })
  assert.deepEqual(
    Object.keys(result).sort(),
    ['commit', 'green_evidence', 'implementation', 'red_evidence', 'task', 'telemetry', 'test_files', 'tests_frozen', 'verdict']
  )
})

// M3: every existing ledger assertion filters to ledger:write calls first,
// or distinguishes writes by payload -- none of them compares a ledger
// call's position against a work-agent call's in the UNFILTERED list, so
// nothing actually pins the start record to before the work, which is the
// entire reason the start record exists (a killed run must still leave a
// "started" line behind). Moving the start write after the first work call
// would leave every ledger:write-filtered assertion green.
test('tdd-task.js: the start-record ledger write is the very first agent() call, strictly before any work-agent step (M3)', async () => {
  const { calls } = await runWorkflow(WF, { args: { task: 'do the thing' }, agent: DONE_AGENT })
  assert.ok(calls.length > 1, 'expected more than just the start write')
  assert.equal(calls[0].opts.label, 'ledger:write', 'the start-record ledger write must be the FIRST agent() call in the unfiltered order')
  assert.equal(calls[1].opts.label, 'write-test#1', 'the second call must be the first real work step, not another ledger write')
})

test('tdd-task.js: every terminating return reaches exactly one start write and one terminal write, with the RIGHT verdict per case (AC-ARCH-3, AC-DATA-5, H4)', async () => {
  // H4: the previous version of this loop only asserted the outcome was ANY
  // of done/blocked/aborted, which every one of these cases satisfies no
  // matter which verdict actually came back -- deleting the hashes_match
  // gate (so a mutant proceeds to commit with tests_frozen:false) or turning
  // the exhausted-implement BLOCKED into ABORTED both left the suite green.
  // Each case now names its expected verdict, so a wrong-but-still-terminal
  // outcome fails instead of passing.
  const cases = [
    { name: 'test-writer agent fails', agent: {}, expect: 'ABORTED' },
    { name: 'RED verifier agent fails', agent: { 'write-test#1': DONE_AGENT['write-test#1'] }, expect: 'ABORTED' },
    {
      name: 'RED gate rejects 3 times (BLOCKED)',
      agent: {
        'write-test#1': DONE_AGENT['write-test#1'],
        'write-test#2': DONE_AGENT['write-test#1'],
        'write-test#3': DONE_AGENT['write-test#1'],
        'verify-red#1': { red: false, right_reason: false, evidence: 'passed already', test_hashes: [] },
        'verify-red#2': { red: false, right_reason: false, evidence: 'passed already', test_hashes: [] },
        'verify-red#3': { red: false, right_reason: false, evidence: 'passed already', test_hashes: [] },
      },
      expect: 'BLOCKED',
    },
    {
      name: 'implementer agent fails',
      agent: { 'write-test#1': DONE_AGENT['write-test#1'], 'verify-red#1': DONE_AGENT['verify-red#1'] },
      expect: 'ABORTED',
    },
    {
      name: 'GREEN verifier agent fails',
      agent: {
        'write-test#1': DONE_AGENT['write-test#1'],
        'verify-red#1': DONE_AGENT['verify-red#1'],
        'implement#1': DONE_AGENT['implement#1'],
      },
      expect: 'ABORTED',
    },
    {
      name: 'hashes changed between RED and GREEN (BLOCKED)',
      agent: {
        'write-test#1': DONE_AGENT['write-test#1'],
        'verify-red#1': DONE_AGENT['verify-red#1'],
        'implement#1': DONE_AGENT['implement#1'],
        'verify-green#1': { green: true, suite_green: true, hashes_match: false, evidence: 'test edited' },
      },
      expect: 'BLOCKED',
    },
    {
      name: 'GREEN gate rejects 3 times (BLOCKED)',
      agent: {
        'write-test#1': DONE_AGENT['write-test#1'],
        'verify-red#1': DONE_AGENT['verify-red#1'],
        'implement#1': DONE_AGENT['implement#1'],
        'implement#2': DONE_AGENT['implement#1'],
        'implement#3': DONE_AGENT['implement#1'],
        'verify-green#1': { green: false, suite_green: false, hashes_match: true, evidence: 'still red' },
        'verify-green#2': { green: false, suite_green: false, hashes_match: true, evidence: 'still red' },
        'verify-green#3': { green: false, suite_green: false, hashes_match: true, evidence: 'still red' },
      },
      expect: 'BLOCKED',
    },
    { name: 'DONE', agent: DONE_AGENT, expect: 'DONE' },
  ]
  const OUTCOME_BY_VERDICT = { DONE: 'done', BLOCKED: 'blocked', ABORTED: 'aborted' }
  // AC-QA-9: distinct run_ids per call (not the same LEDGER_OK object for
  // both) so "the terminal write carries the start's run_id" is a real,
  // non-vacuous assertion for EVERY return path, not just the one dedicated
  // AC-DATA-5 pairing test further down (which only covers the DONE case).
  for (const c of cases) {
    const { calls, result } = await runWorkflow(WF, {
      args: { task: 'x' },
      agent: {
        ...c.agent,
        'ledger:write': [
          { run_id: `${c.name}-start`, ts: 't1', write_ok: true, write_error: null },
          { run_id: `${c.name}-terminal`, ts: 't2', write_ok: true, write_error: null },
        ],
      },
    })
    const ledgerCalls = calls.filter((call) => call.opts.label === 'ledger:write')
    assert.equal(ledgerCalls.length, 2, `${c.name}: expected one start write + one terminal write, got ${ledgerCalls.length}`)
    assert.equal(result.verdict, c.expect, `${c.name}: expected verdict ${c.expect}, got ${result.verdict}`)
    assert.ok(result.telemetry, `${c.name}: telemetry missing`)
    assert.equal(result.telemetry.outcome, OUTCOME_BY_VERDICT[c.expect], `${c.name}: outcome was ${result.telemetry.outcome}`)
    const terminalRequest = extractLedgerPayload(ledgerCalls[1].prompt)
    assert.equal(terminalRequest.run_id, `${c.name}-start`, `${c.name}: the terminal write must request reuse of the START write's run_id, for every return path`)
  }
})

test('tdd-task.js: hashes_match:false BLOCKs with zero commit calls (H4, dedicated)', async () => {
  const { calls, result } = await runWorkflow(WF, {
    args: { task: 'x' },
    agent: {
      'write-test#1': DONE_AGENT['write-test#1'],
      'verify-red#1': DONE_AGENT['verify-red#1'],
      'implement#1': DONE_AGENT['implement#1'],
      'verify-green#1': { green: true, suite_green: true, hashes_match: false, evidence: 'test edited to pass' },
      'ledger:write': LEDGER_OK,
    },
  })
  assert.equal(result.verdict, 'BLOCKED')
  assert.equal(calls.filter((c) => c.opts.label === 'commit').length, 0, 'a test edited between RED and GREEN must never reach the commit step')
})

test('tdd-task.js: exhausted implement attempts (3 non-green GREEN verifications) BLOCKs with zero commit calls (H4, dedicated)', async () => {
  const { calls, result } = await runWorkflow(WF, {
    args: { task: 'x' },
    agent: {
      'write-test#1': DONE_AGENT['write-test#1'],
      'verify-red#1': DONE_AGENT['verify-red#1'],
      'implement#1': DONE_AGENT['implement#1'],
      'implement#2': DONE_AGENT['implement#1'],
      'implement#3': DONE_AGENT['implement#1'],
      'verify-green#1': { green: false, suite_green: false, hashes_match: true, evidence: 'still red 1' },
      'verify-green#2': { green: false, suite_green: false, hashes_match: true, evidence: 'still red 2' },
      'verify-green#3': { green: false, suite_green: false, hashes_match: true, evidence: 'still red 3' },
      'ledger:write': LEDGER_OK,
    },
  })
  assert.equal(result.verdict, 'BLOCKED')
  assert.equal(calls.filter((c) => c.opts.label === 'commit').length, 0, 'exhausting implement attempts without going green must never reach the commit step')
})

test('tdd-task.js: telemetry.outcome distinguishes done, blocked and aborted (AC-ARCH-3)', async () => {
  const aborted = await runWorkflow(WF, { args: { task: 'x' }, agent: { 'ledger:write': LEDGER_OK } })
  assert.equal(aborted.result.verdict, 'ABORTED')
  assert.equal(aborted.result.telemetry.outcome, 'aborted')

  const blocked = await runWorkflow(WF, {
    args: { task: 'x' },
    agent: {
      'write-test#1': DONE_AGENT['write-test#1'],
      'write-test#2': DONE_AGENT['write-test#1'],
      'write-test#3': DONE_AGENT['write-test#1'],
      'verify-red#1': { red: false, right_reason: false, evidence: 'nope', test_hashes: [] },
      'verify-red#2': { red: false, right_reason: false, evidence: 'nope', test_hashes: [] },
      'verify-red#3': { red: false, right_reason: false, evidence: 'nope', test_hashes: [] },
      'ledger:write': LEDGER_OK,
    },
  })
  assert.equal(blocked.result.verdict, 'BLOCKED')
  assert.equal(blocked.result.telemetry.outcome, 'blocked')

  const done = await runWorkflow(WF, { args: { task: 'x' }, agent: DONE_AGENT })
  assert.equal(done.result.verdict, 'DONE')
  assert.equal(done.result.telemetry.outcome, 'done')
})

test('tdd-task.js: no telemetry code path can reach the commit step when RED was never confirmed (AC-QA-23)', async () => {
  // The test-writer never produces a right-reason failure: RED is rejected
  // every attempt. The commit agent must never be called, with or without
  // ledger instrumentation attached.
  const { calls, result } = await runWorkflow(WF, {
    args: { task: 'x' },
    agent: {
      'write-test#1': DONE_AGENT['write-test#1'],
      'write-test#2': DONE_AGENT['write-test#1'],
      'write-test#3': DONE_AGENT['write-test#1'],
      'verify-red#1': { red: false, right_reason: false, evidence: 'nope', test_hashes: [] },
      'verify-red#2': { red: false, right_reason: false, evidence: 'nope', test_hashes: [] },
      'verify-red#3': { red: false, right_reason: false, evidence: 'nope', test_hashes: [] },
      'ledger:write': LEDGER_OK,
    },
  })
  assert.equal(result.verdict, 'BLOCKED')
  assert.equal(calls.filter((c) => c.opts.label === 'commit').length, 0)
})

test('tdd-task.js: a test that fails (red: true) but NOT for the right reason (right_reason: false) must still be rejected -- both conditions gate RED, not just red (AC-QA-23)', async () => {
  const { calls, result } = await runWorkflow(WF, {
    args: { task: 'x' },
    agent: {
      'write-test#1': DONE_AGENT['write-test#1'],
      'write-test#2': DONE_AGENT['write-test#1'],
      'write-test#3': DONE_AGENT['write-test#1'],
      'verify-red#1': { red: true, right_reason: false, evidence: 'threw a typo error', test_hashes: [] },
      'verify-red#2': { red: true, right_reason: false, evidence: 'threw a typo error', test_hashes: [] },
      'verify-red#3': { red: true, right_reason: false, evidence: 'threw a typo error', test_hashes: [] },
      'ledger:write': LEDGER_OK,
    },
  })
  assert.equal(result.verdict, 'BLOCKED')
  assert.equal(calls.filter((c) => c.opts.label === 'commit').length, 0, 'red-but-wrong-reason must never reach the commit step')
  assert.equal(calls.filter((c) => c.opts.label === 'implement#1').length, 0, 'red-but-wrong-reason must never reach the Implement phase at all')
})

test('tdd-task.js: a ledger write failure never fails the run; the normal verdict and result are still returned (AC-QA-7)', async () => {
  const { result, logs } = await runWorkflow(WF, {
    args: { task: 'do the thing' },
    agent: { ...DONE_AGENT, 'ledger:write': { run_id: 'r9', ts: 'x', write_ok: false, write_error: 'disk full' } },
  })
  assert.equal(result.verdict, 'DONE')
  assert.equal(result.task, 'do the thing')
  assert.ok(logs.some((l) => l.includes('r9') && l.includes('disk full')), 'the failure must be surfaced once, naming run id and reason')
})

test('tdd-task.js: a ledger write failure via a stopped agent (undefined response) never fails the run', async () => {
  const { result } = await runWorkflow(WF, {
    args: { task: 'do the thing' },
    agent: { ...DONE_AGENT, 'ledger:write': undefined },
  })
  assert.equal(result.verdict, 'DONE')
})

test('tdd-task.js: a ledger write failure via the agent call itself throwing never fails the run (AC-QA-7)', async () => {
  const { result } = await runWorkflow(WF, {
    args: { task: 'do the thing' },
    agent: { ...DONE_AGENT, 'ledger:write': () => { throw new Error('agent crashed') } },
  })
  assert.equal(result.verdict, 'DONE')
})

// Review round-1 L2: when the response itself carries no run_id (a stopped
// agent, or the agent call throwing), the failure log fell back to the
// literal string "unknown" -- but for the TERMINAL write specifically, the
// PAYLOAD it was asked to send already names the run_id to reuse (the
// start write's own run_id). This is exactly the case that produces a
// terminal-only orphan (a failed START write's terminal record can carry
// no reused run_id, but a failed TERMINAL write for an otherwise-successful
// start SHOULD still be traceable) -- naming the run in the log is what
// lets an operator correlate the failure to a ledger line at all.
test('tdd-task.js: when the TERMINAL ledger write fails with a response carrying no run_id, the failure log still names the run via the payload\'s own requested run_id, not the literal string "unknown" (L2)', async () => {
  const { logs } = await runWorkflow(WF, {
    args: { task: 'do the thing' },
    agent: {
      ...DONE_AGENT,
      'ledger:write': [
        { run_id: 'known-start-id', ts: 't1', write_ok: true, write_error: null },
        undefined, // the terminal write's own agent call fails outright
      ],
    },
  })
  const terminalFailureLog = logs.find((l) => l.includes('Ledger write failed'))
  assert.ok(terminalFailureLog, `expected a terminal-write failure log line, got ${JSON.stringify(logs)}`)
  assert.ok(terminalFailureLog.includes('known-start-id'), `expected the failure log to name the run via the payload's requested run_id, got: ${terminalFailureLog}`)
  assert.ok(!terminalFailureLog.includes('run unknown'), `the log must not fall back to "unknown" when the payload itself names the run: ${terminalFailureLog}`)
})

// Review round-2 M-3: invalid_ac_ids_dropped now rides on ledger-append.mjs's
// own CLI result (not just the stored line), so writeLedger can surface it
// -- a silent sanitisation (a lens's malformed ac_id) previously left no
// operator-visible trace at all beyond the counter buried in the ledger
// file itself.
test('tdd-task.js: when the ledger:write response carries invalid_ac_ids_dropped > 0, writeLedger logs one visible line naming the run and the count (M-3)', async () => {
  const { logs } = await runWorkflow(WF, {
    args: { task: 'do the thing' },
    agent: {
      ...DONE_AGENT,
      'ledger:write': [
        { run_id: 'run-with-sanitised-ids', ts: 't1', write_ok: true, write_error: null },
        { run_id: 'run-with-sanitised-ids', ts: 't2', write_ok: true, write_error: null, invalid_ac_ids_dropped: 2 },
      ],
    },
  })
  const sanitiseLog = logs.find((l) => l.includes('invalid_ac_ids_dropped') || l.toLowerCase().includes('sanitised'))
  assert.ok(sanitiseLog, `expected a log line about the sanitisation, got: ${JSON.stringify(logs)}`)
  assert.ok(sanitiseLog.includes('run-with-sanitised-ids'), `must name the run, got: ${sanitiseLog}`)
  assert.ok(sanitiseLog.includes('2'), `must name the count, got: ${sanitiseLog}`)
})

test('tdd-task.js: a ledger:write response with invalid_ac_ids_dropped 0 (or absent) logs NOTHING extra -- the clean case must stay silent (M-3, not vacuous)', async () => {
  const { logs } = await runWorkflow(WF, { args: { task: 'do the thing' }, agent: DONE_AGENT })
  assert.ok(!logs.some((l) => l.includes('invalid_ac_ids_dropped') || l.toLowerCase().includes('sanitised')), `expected no sanitisation log on the clean path, got: ${JSON.stringify(logs)}`)
})

test('tdd-task.js: telemetry.budget_spent is null (not 0) when no budget is supplied (AC-QA-15)', async () => {
  const { result } = await runWorkflow(WF, { args: { task: 'x' }, agent: DONE_AGENT })
  assert.equal(result.telemetry.budget_spent, null)
})

test('tdd-task.js: telemetry.budget_spent reflects budget.spent() when supplied', async () => {
  const { result } = await runWorkflow(WF, { args: { task: 'x' }, agent: DONE_AGENT, budget: { spent: () => 5000 } })
  assert.equal(result.telemetry.budget_spent, 5000)
})

test('tdd-task.js: telemetry.budget_spent is null (not 0) when budget.spent() throws, and the verdict is unchanged (L2: this branch lost its only test in the no-imports rework, when readBudgetSpent was inlined out of the deleted workflows/lib/ledger.mjs)', async () => {
  const { result } = await runWorkflow(WF, {
    args: { task: 'do the thing' },
    agent: DONE_AGENT,
    budget: { spent: () => { throw new Error('budget backend unavailable') } },
  })
  assert.equal(result.telemetry.budget_spent, null)
  assert.equal(result.verdict, 'DONE')
})

// L7: telemetry.rounds is new behaviour this PR added, with no test at all
// -- swapping the two counters, or zeroing either, would keep the suite
// green. Three cases, each with a different real value for at least one
// counter, so a swap or a hardcoded value is distinguishable from the
// correct count.
test('tdd-task.js: telemetry.rounds records the real attempt counts on the DONE path -- one of each when everything succeeds first try (L7)', async () => {
  const { result } = await runWorkflow(WF, { args: { task: 'x' }, agent: DONE_AGENT })
  assert.deepEqual(result.telemetry.rounds, { test_attempts: 1, implement_attempts: 1 })
})

test('tdd-task.js: telemetry.rounds.test_attempts reflects every RED attempt, even when RED is never confirmed and implement is never reached (L7)', async () => {
  const { result } = await runWorkflow(WF, {
    args: { task: 'x' },
    agent: {
      'write-test#1': DONE_AGENT['write-test#1'],
      'write-test#2': DONE_AGENT['write-test#1'],
      'write-test#3': DONE_AGENT['write-test#1'],
      'verify-red#1': { red: false, right_reason: false, evidence: 'nope', test_hashes: [] },
      'verify-red#2': { red: false, right_reason: false, evidence: 'nope', test_hashes: [] },
      'verify-red#3': { red: false, right_reason: false, evidence: 'nope', test_hashes: [] },
      'ledger:write': LEDGER_OK,
    },
  })
  assert.deepEqual(result.telemetry.rounds, { test_attempts: 3, implement_attempts: 0 }, 'implement_attempts must stay 0 -- implement was never reached')
})

test('tdd-task.js: telemetry.rounds.implement_attempts reflects every GREEN attempt, distinct from test_attempts (L7)', async () => {
  const { result } = await runWorkflow(WF, {
    args: { task: 'x' },
    agent: {
      'write-test#1': DONE_AGENT['write-test#1'],
      'verify-red#1': DONE_AGENT['verify-red#1'],
      'implement#1': DONE_AGENT['implement#1'],
      'implement#2': DONE_AGENT['implement#1'],
      'implement#3': DONE_AGENT['implement#1'],
      'verify-green#1': { green: false, suite_green: false, hashes_match: true, evidence: 'still red 1' },
      'verify-green#2': { green: false, suite_green: false, hashes_match: true, evidence: 'still red 2' },
      'verify-green#3': { green: false, suite_green: false, hashes_match: true, evidence: 'still red 3' },
      'ledger:write': LEDGER_OK,
    },
  })
  assert.deepEqual(result.telemetry.rounds, { test_attempts: 1, implement_attempts: 3 }, 'test_attempts must stay 1 -- RED was confirmed first try, only implement retried')
})

test('tdd-task.js: the terminal ledger write requests reuse of the start write\'s run_id (AC-DATA-5 pairing)', async () => {
  const { calls } = await runWorkflow(WF, {
    args: { task: 'x' },
    agent: {
      ...DONE_AGENT,
      'ledger:write': [
        { run_id: 'start-run-id-123', ts: 't1', write_ok: true, write_error: null },
        { run_id: 'terminal-run-id-456', ts: 't2', write_ok: true, write_error: null },
      ],
    },
  })
  const ledgerCalls = calls.filter((c) => c.opts.label === 'ledger:write')
  assert.equal(ledgerCalls.length, 2)
  // The prompt embeds the payload base64-encoded (H1), so this decodes it
  // rather than string-matching the prompt text directly.
  const startPayload = extractLedgerPayload(ledgerCalls[0].prompt)
  const terminalPayload = extractLedgerPayload(ledgerCalls[1].prompt)
  assert.ok(!('run_id' in startPayload), 'the start write does not request an existing run_id (it generates one)')
  assert.equal(terminalPayload.run_id, 'start-run-id-123', 'the terminal write must request reuse of the start write\'s run_id')
})

test('tdd-task.js: if the start write fails, the terminal write still proceeds without a run_id override (AC-QA-7 + AC-DATA-5 non-fatal interaction)', async () => {
  const { calls, result } = await runWorkflow(WF, {
    args: { task: 'x' },
    agent: {
      ...DONE_AGENT,
      'ledger:write': [
        { run_id: 'irrelevant', ts: 't1', write_ok: false, write_error: 'disk full' },
        { run_id: 'terminal-only', ts: 't2', write_ok: true, write_error: null },
      ],
    },
  })
  assert.equal(result.verdict, 'DONE')
  const ledgerCalls = calls.filter((c) => c.opts.label === 'ledger:write')
  assert.equal(ledgerCalls.length, 2)
  const terminalPayload = extractLedgerPayload(ledgerCalls[1].prompt)
  assert.ok(!('run_id' in terminalPayload) || terminalPayload.run_id !== 'irrelevant', 'with no successful start write, the terminal write must not claim a run_id to reuse')
})

test('tdd-task.js: telemetry records spec identity as null when no spec was supplied, and the value when it was (AC-DATA-7)', async () => {
  const withoutSpec = await runWorkflow(WF, { args: { task: 'x' }, agent: DONE_AGENT })
  assert.equal(withoutSpec.result.telemetry.spec, null)
  const withSpec = await runWorkflow(WF, { args: { task: 'x', spec: 'specs/foo.md' }, agent: DONE_AGENT })
  assert.equal(withSpec.result.telemetry.spec, 'specs/foo.md')
})

// HARN-OPT-2 PR2 (AC-QA-8, AC-OPS-1, AC-ARCH-9): the measured defect. An
// exception thrown by an agent() call inside run() -- distinct from the
// existing "agent returned undefined/falsy" ABORTED paths above, which are
// all handled returns, not throws -- previously escaped past the single
// start/terminal ledger write entirely: the process died with only a
// 'started' line on disk and no terminal record. This is a real, unhandled
// throw: write-test#1 is scripted as a function that throws synchronously,
// which the fake agent stub (an async function) turns into a rejection,
// exactly like a real agent step crashing.
test('tdd-task.js: an exception thrown by an agent() call inside run() still produces exactly one terminal ledger write, carrying the start run_id and outcome aborted, AND the original error still reaches the caller (AC-QA-8, AC-OPS-1)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: { task: 'x' },
        agent: {
          'write-test#1': () => { throw new Error('agent step crashed mid-run') },
          'ledger:write': [
            { run_id: 'start-abc', ts: 't1', write_ok: true, write_error: null },
            { run_id: 'terminal-abc', ts: 't2', write_ok: true, write_error: null },
          ],
        },
      }),
    (err) => {
      assert.match(err.message, /agent step crashed mid-run/, 'the ORIGINAL error must reach the caller unchanged, not be replaced by a ledger-write error')
      const ledgerCalls = err.calls.filter((c) => c.opts.label === 'ledger:write')
      assert.equal(ledgerCalls.length, 2, `expected one start write + one terminal write even though run() threw, got ${ledgerCalls.length}`)
      const startPayload = extractLedgerPayload(ledgerCalls[0].prompt)
      const terminalPayload = extractLedgerPayload(ledgerCalls[1].prompt)
      assert.ok(!('run_id' in startPayload), 'the start write does not request an existing run_id')
      assert.equal(terminalPayload.run_id, 'start-abc', 'the terminal write must reuse the start run_id')
      assert.equal(terminalPayload.outcome, 'aborted', 'a thrown run() must never be recorded as done or blocked (AC-QA-12)')
      assert.ok(
        err.logs.some((l) => l.includes('start-abc') && l.includes('agent step crashed mid-run')),
        `expected one log line naming the run_id and the failure, got ${JSON.stringify(err.logs)}`
      )
      return true
    }
  )
})

// Review round-2 L-2: the exception guard's own log line previously printed
// e.message VERBATIM. workflow scripts have no fs/child_process access, so
// they cannot resolve the checkout root the way ledger-append.mjs's
// stripRoot does -- but a real Node error thrown deep in a real toolchain
// commonly embeds an absolute path (ENOENT, module resolution, a stack
// frame), and on the machine that ran this, that absolute path discloses
// the local account name. This never reaches the ledger file (which has its
// own, root-aware redaction) -- only the operator-visible console log.
test('tdd-task.js: the exception guard\'s log line redacts an absolute /Users or /home path embedded in the thrown error\'s message, rather than printing it verbatim (L-2)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: { task: 'x' },
        agent: {
          'write-test#1': () => { throw new Error("ENOENT: no such file, open '/Users/victim/secret-project/config.js'") },
          'ledger:write': [
            { run_id: 'start-abc', ts: 't1', write_ok: true, write_error: null },
            { run_id: 'terminal-abc', ts: 't2', write_ok: true, write_error: null },
          ],
        },
      }),
    (err) => {
      const line = err.logs.find((l) => l.includes('start-abc'))
      assert.ok(line, `expected a log line naming the run_id, got ${JSON.stringify(err.logs)}`)
      assert.ok(!line.includes('/Users/victim/secret-project'), `the log line must not carry the raw absolute path verbatim, got: ${line}`)
      assert.ok(!line.includes('victim'), `the log line must not leak the local account name, got: ${line}`)
      return true
    }
  )
})

test('tdd-task.js: the exception guard\'s log line is bounded in length, even when the thrown error\'s message is very long (L-2)', async () => {
  const longMessage = 'x'.repeat(5000)
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: { task: 'x' },
        agent: {
          'write-test#1': () => { throw new Error(longMessage) },
          'ledger:write': [
            { run_id: 'start-abc', ts: 't1', write_ok: true, write_error: null },
            { run_id: 'terminal-abc', ts: 't2', write_ok: true, write_error: null },
          ],
        },
      }),
    (err) => {
      const line = err.logs.find((l) => l.includes('start-abc'))
      assert.ok(line, `expected a log line naming the run_id, got ${JSON.stringify(err.logs)}`)
      assert.ok(line.length < 700, `expected the log line bounded near MAX_LOG_TEXT (500) plus its fixed prefix, not merely under the 5000-char thrown message (round-7 review F14: the old bound could not catch MAX_LOG_TEXT being widened by an order of magnitude), got length ${line.length}`)
      return true
    }
  )
})

test('tdd-task.js: the original error still reaches the caller even when the terminal ledger write ALSO fails (AC-OPS-1: never swallowed by a failure of the terminal write itself)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: { task: 'x' },
        agent: {
          'write-test#1': () => { throw new Error('body boom') },
          'ledger:write': [
            { run_id: 'start-xyz', ts: 't1', write_ok: true, write_error: null },
            { run_id: 'irrelevant', ts: 't2', write_ok: false, write_error: 'disk full' },
          ],
        },
      }),
    (err) => {
      assert.match(err.message, /body boom/, 'the run() error must win, not a ledger-write-failure error')
      const ledgerCalls = err.calls.filter((c) => c.opts.label === 'ledger:write')
      assert.equal(ledgerCalls.length, 2, 'a failing terminal write must still be ATTEMPTED before the original error is re-thrown')
      return true
    }
  )
})

// Review round-1 M2: `if (runError) throw runError` tests the THROWN
// VALUE'S truthiness, not whether the catch fired -- `throw null`,
// `throw undefined`, `throw 0` and `throw ''` are all falsy, so the guard
// declines to re-throw them and the workflow resolves normally instead of
// propagating. This is a REGRESSION: before PR2 added this guard, every
// throw (falsy or not) reached the caller because there was no catch at
// all. `Promise.reject()` with no argument rejects with `undefined`, so
// this is not an exotic input a real agent step could never produce.
for (const falsyValue of [null, undefined, 0, '']) {
  test(`tdd-task.js: a falsy thrown value (${JSON.stringify(falsyValue)}) from an agent() call inside run() still propagates -- it must not be swallowed into a resolved promise just because the guard's re-throw check is falsy (M2, regression)`, async () => {
    await assert.rejects(
      () =>
        runWorkflow(WF, {
          args: { task: 'x' },
          agent: {
            'write-test#1': () => { throw falsyValue },
            'ledger:write': LEDGER_OK,
          },
        }),
      (err) => {
        // A falsy non-Error thrown value still arrives as whatever was
        // thrown (assert.rejects accepts a rejection with any reason, not
        // only an Error instance) -- the only claim under test is that the
        // promise REJECTS at all, rather than resolving.
        assert.equal(err, falsyValue)
        return true
      }
    )
  })
}
