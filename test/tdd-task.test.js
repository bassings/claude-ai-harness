const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { runWorkflow } = require('./helpers/fake-runtime.js')

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

test('tdd-task.js: every terminating return reaches exactly one start write and one terminal write (AC-ARCH-3, AC-DATA-5)', async () => {
  const cases = [
    { name: 'test-writer agent fails', agent: {} },
    { name: 'RED verifier agent fails', agent: { 'write-test#1': DONE_AGENT['write-test#1'] } },
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
    },
    {
      name: 'implementer agent fails',
      agent: { 'write-test#1': DONE_AGENT['write-test#1'], 'verify-red#1': DONE_AGENT['verify-red#1'] },
    },
    {
      name: 'GREEN verifier agent fails',
      agent: {
        'write-test#1': DONE_AGENT['write-test#1'],
        'verify-red#1': DONE_AGENT['verify-red#1'],
        'implement#1': DONE_AGENT['implement#1'],
      },
    },
    {
      name: 'hashes changed between RED and GREEN (BLOCKED)',
      agent: {
        'write-test#1': DONE_AGENT['write-test#1'],
        'verify-red#1': DONE_AGENT['verify-red#1'],
        'implement#1': DONE_AGENT['implement#1'],
        'verify-green#1': { green: true, suite_green: true, hashes_match: false, evidence: 'test edited' },
      },
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
    },
    { name: 'DONE', agent: DONE_AGENT },
  ]
  for (const c of cases) {
    const { calls, result } = await runWorkflow(WF, {
      args: { task: 'x' },
      agent: { ...c.agent, 'ledger:write': LEDGER_OK },
    })
    const ledgerCalls = calls.filter((call) => call.opts.label === 'ledger:write')
    assert.equal(ledgerCalls.length, 2, `${c.name}: expected one start write + one terminal write, got ${ledgerCalls.length}`)
    assert.ok(result.telemetry, `${c.name}: telemetry missing`)
    assert.ok(['done', 'blocked', 'aborted'].includes(result.telemetry.outcome), `${c.name}: outcome was ${result.telemetry.outcome}`)
  }
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

test('tdd-task.js: telemetry.budget_spent is null (not 0) when no budget is supplied (AC-QA-15)', async () => {
  const { result } = await runWorkflow(WF, { args: { task: 'x' }, agent: DONE_AGENT })
  assert.equal(result.telemetry.budget_spent, null)
})

test('tdd-task.js: telemetry.budget_spent reflects budget.spent() when supplied', async () => {
  const { result } = await runWorkflow(WF, { args: { task: 'x' }, agent: DONE_AGENT, budget: { spent: () => 5000 } })
  assert.equal(result.telemetry.budget_spent, 5000)
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
  assert.ok(!ledgerCalls[0].prompt.includes('"run_id":"start-run-id-123"'), 'the start write does not request an existing run_id (it generates one)')
  assert.ok(ledgerCalls[1].prompt.includes('"run_id":"start-run-id-123"'), 'the terminal write must request reuse of the start write\'s run_id')
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
  assert.ok(!ledgerCalls[1].prompt.includes('"run_id":"irrelevant"'), 'with no successful start write, the terminal write must not claim a run_id to reuse')
})

test('tdd-task.js: telemetry records spec identity as null when no spec was supplied, and the value when it was (AC-DATA-7)', async () => {
  const withoutSpec = await runWorkflow(WF, { args: { task: 'x' }, agent: DONE_AGENT })
  assert.equal(withoutSpec.result.telemetry.spec, null)
  const withSpec = await runWorkflow(WF, { args: { task: 'x', spec: 'specs/foo.md' }, agent: DONE_AGENT })
  assert.equal(withSpec.result.telemetry.spec, 'specs/foo.md')
})
