const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')

const WF = path.join(__dirname, '..', 'workflows', 'plan-cycle.js')

const LEDGER_OK = { run_id: 'r1', ts: '2026-08-10T00:00:00.000Z', write_ok: true, write_error: null }

const SCOPE_OK = {
  summary: 'adds a widget',
  ui: false,
  data: false,
  architecture: false,
  operability: false,
  user_facing: true,
  likely_paths: ['src/widget.js'],
}

const LENS_CLEAN = { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, acceptance_criteria: [{ id: 'AC-SEC-1', statement: 'x' }] }

function baseAgent(overrides = {}) {
  return {
    'scope:spec': SCOPE_OK,
    'lens-security': LENS_CLEAN,
    'lens-qa': LENS_CLEAN,
    'lens-simplicity': { ...LENS_CLEAN, acceptance_criteria: [] },
    'lens-product': LENS_CLEAN,
    'synthesis:write-back': '### Summary\n4 criteria',
    'ledger:write': LEDGER_OK,
    ...overrides,
  }
}

test('plan-cycle.js: normal completion preserves the existing return shape and adds telemetry under one new key (AC-ARCH-10)', async () => {
  const { result, calls } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  assert.equal(result.spec, 'specs/foo.md')
  assert.deepEqual(result.lenses, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'])
  assert.ok(Array.isArray(result.skipped))
  assert.deepEqual(result.verdicts, { 'lens-security': 'CLEAN', 'lens-qa': 'CLEAN', 'lens-simplicity': 'CLEAN', 'lens-product': 'CLEAN' })
  assert.equal(typeof result.report, 'string')
  assert.ok(result.telemetry)
  assert.equal(result.telemetry.outcome, 'done')
  assert.equal(result.telemetry.spec, 'specs/foo.md')
  assert.ok(calls.find((c) => c.opts.label === 'ledger:write'))
})

// Coordinator, round-3 triage item 2 (lens-security's L-1): plan-cycle
// also fans out to lenses, so the same live-ledger risk review-cycle's own
// lens prompt already guards against (a lens probing ledger-append.mjs
// from its own process, which resolves the MAIN checkout via
// --git-common-dir regardless of who invokes it -- AC-DATA-1) applies here
// too. Same mechanism, same wording.
test('plan-cycle.js: every lens\'s prompt instructs it to export HARNESS_LEDGER_READONLY (a truthy value) before it probes ledger-append.mjs, so a lens\'s own mutation experiments never reach the operator\'s real ledger', async () => {
  const { calls } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  const lensCall = calls.find((c) => c.opts.label === 'lens-security')
  assert.ok(lensCall, 'expected a lens-security call')
  assert.match(lensCall.prompt, /HARNESS_LEDGER_READONLY/, 'the lens prompt must name the env var')
  assert.match(lensCall.prompt, /export HARNESS_LEDGER_READONLY=1/i, 'the lens prompt must give a concrete, truthy export the lens can copy verbatim')
})

// L5: see review-cycle.js's identical test for the rationale -- nothing
// previously asserted the FULL key set, so the internal __outcome sentinel
// could leak into the public result unnoticed.
test('plan-cycle.js: the result carries EXACTLY its documented keys plus telemetry -- the internal __outcome sentinel does not leak through (L5, AC-ARCH-10)', async () => {
  const { result } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  assert.deepEqual(Object.keys(result).sort(), ['lenses', 'report', 'skipped', 'spec', 'telemetry', 'verdicts'])
})

// M3: see tdd-task.js for the identical guard gap and rationale -- nothing
// previously pinned the start record to before the work.
test('plan-cycle.js: the start-record ledger write is the very first agent() call, strictly before any work-agent step (M3)', async () => {
  const { calls } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  assert.ok(calls.length > 1, 'expected more than just the start write')
  assert.equal(calls[0].opts.label, 'ledger:write', 'the start-record ledger write must be the FIRST agent() call in the unfiltered order')
  assert.equal(calls[1].opts.label, 'scope:spec', 'the second call must be the first real work step, not another ledger write')
})

// AC-QA-9: distinct run_ids per call, and the terminal request checked
// against the START write's run_id, not just a call count -- see
// tdd-task.test.js's parametrized version for the identical rationale.
const PAIRED_LEDGER = [
  { run_id: 'return-path-start', ts: 't1', write_ok: true, write_error: null },
  { run_id: 'return-path-terminal', ts: 't2', write_ok: true, write_error: null },
]

test('plan-cycle.js: the "scope agent failed" early return (line 48 historically) still reaches the ledger write, with outcome aborted, and the terminal write reuses the start run_id (AC-ARCH-3, AC-QA-9)', async () => {
  const { result, calls } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent({ 'scope:spec': undefined, 'ledger:write': PAIRED_LEDGER }) })
  assert.equal(result.report, 'Scope agent failed; no plan produced.')
  assert.equal(result.telemetry.outcome, 'aborted')
  const ledgerCalls = calls.filter((c) => c.opts.label === 'ledger:write')
  assert.equal(ledgerCalls.length, 2, 'expected one start write + one terminal write')
  assert.equal(extractLedgerPayload(ledgerCalls[1].prompt).run_id, 'return-path-start', 'the terminal write must request reuse of the start run_id')
})

test('plan-cycle.js: the "every lens agent failed" early return (line 98 historically) still reaches the ledger write, with outcome aborted, and the terminal write reuses the start run_id (AC-ARCH-3, AC-QA-9)', async () => {
  const { result, calls } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({ 'lens-security': undefined, 'lens-qa': undefined, 'lens-simplicity': undefined, 'lens-product': undefined, 'ledger:write': PAIRED_LEDGER }),
  })
  assert.equal(result.report, 'Every lens agent failed or was stopped; no plan produced.')
  assert.equal(result.telemetry.outcome, 'aborted')
  const ledgerCalls = calls.filter((c) => c.opts.label === 'ledger:write')
  assert.equal(ledgerCalls.length, 2, 'expected one start write + one terminal write')
  assert.equal(extractLedgerPayload(ledgerCalls[1].prompt).run_id, 'return-path-start', 'the terminal write must request reuse of the start run_id')
})

// M1: a run whose synthesis:write-back agent fails (undefined response) or
// returns an empty summary string was previously recorded as outcome
// "done" -- see review-cycle.js's identical fix and rationale.
test('plan-cycle.js: outcome is aborted (not done) when the synthesis:write-back agent call fails entirely (undefined response), even though every lens completed cleanly (M1)', async () => {
  const { result } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent({ 'synthesis:write-back': undefined }) })
  assert.equal(result.telemetry.outcome, 'aborted')
  assert.equal(result.report, '', 'an aborted run must not carry a stale or partial report string')
})

test('plan-cycle.js: outcome is aborted (not done) when synthesis:write-back returns an empty string (M1)', async () => {
  const { result } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent({ 'synthesis:write-back': '' }) })
  assert.equal(result.telemetry.outcome, 'aborted')
})

test('plan-cycle.js: outcome is blocked when any lens returns BLOCKED', async () => {
  const { result } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({ 'lens-security': { ...LENS_CLEAN, verdict: 'BLOCKED' } }),
  })
  assert.equal(result.telemetry.outcome, 'blocked')
})

test('plan-cycle.js: a ledger write failure never fails the run (AC-QA-7)', async () => {
  const { result, logs } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({ 'ledger:write': { run_id: 'rZ', ts: 'x', write_ok: false, write_error: 'nope' } }),
  })
  assert.equal(typeof result.report, 'string')
  assert.ok(logs.some((l) => l.includes('rZ') && l.includes('nope')))
})

test('plan-cycle.js: a ledger write failure via the agent call itself throwing never fails the run (AC-QA-7)', async () => {
  const { result } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({ 'ledger:write': () => { throw new Error('agent crashed') } }),
  })
  assert.equal(typeof result.report, 'string')
})

// Review round-2 M-3: see tdd-task.test.js for the identical guard and
// its rationale.
test('plan-cycle.js: when the ledger:write response carries invalid_ac_ids_dropped > 0, writeLedger logs one visible line naming the run and the count (M-3)', async () => {
  const { logs } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({
      'ledger:write': [
        { run_id: 'run-with-sanitised-ids', ts: 't1', write_ok: true, write_error: null },
        { run_id: 'run-with-sanitised-ids', ts: 't2', write_ok: true, write_error: null, invalid_ac_ids_dropped: 2 },
      ],
    }),
  })
  const sanitiseLog = logs.find((l) => l.includes('invalid_ac_ids_dropped') || l.toLowerCase().includes('sanitised'))
  assert.ok(sanitiseLog, `expected a log line about the sanitisation, got: ${JSON.stringify(logs)}`)
  assert.ok(sanitiseLog.includes('run-with-sanitised-ids'), `must name the run, got: ${sanitiseLog}`)
  assert.ok(sanitiseLog.includes('2'), `must name the count, got: ${sanitiseLog}`)
})

test('plan-cycle.js: a ledger:write response with invalid_ac_ids_dropped 0 (or absent) logs NOTHING extra (M-3, not vacuous)', async () => {
  const { logs } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  assert.ok(!logs.some((l) => l.includes('invalid_ac_ids_dropped') || l.toLowerCase().includes('sanitised')), `expected no sanitisation log on the clean path, got: ${JSON.stringify(logs)}`)
})

test('plan-cycle.js: telemetry.budget_spent is null when no budget is supplied, and reflects budget.spent() when supplied (AC-QA-15)', async () => {
  const noBudget = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  assert.equal(noBudget.result.telemetry.budget_spent, null)
  const withBudget = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent(), budget: { spent: () => 999 } })
  assert.equal(withBudget.result.telemetry.budget_spent, 999)
})

// HARN-OPT-2 PR2 (AC-QA-8, AC-OPS-1, AC-ARCH-9): the measured defect. See
// tdd-task.test.js for the identical pattern and its rationale -- an
// exception thrown by an agent() call inside run() previously escaped past
// the single start/terminal ledger write entirely.
test('plan-cycle.js: an exception thrown by an agent() call inside run() still produces exactly one terminal ledger write, carrying the start run_id and outcome aborted, AND the original error still reaches the caller (AC-QA-8, AC-OPS-1)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: { spec: 'specs/foo.md' },
        agent: baseAgent({
          'scope:spec': () => { throw new Error('agent step crashed mid-run') },
          'ledger:write': [
            { run_id: 'start-abc', ts: 't1', write_ok: true, write_error: null },
            { run_id: 'terminal-abc', ts: 't2', write_ok: true, write_error: null },
          ],
        }),
      }),
    (err) => {
      assert.match(err.message, /agent step crashed mid-run/, 'the ORIGINAL error must reach the caller unchanged')
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

// Review round-2 L-2: see tdd-task.test.js for the identical guard and its
// rationale -- workflow scripts have no fs/child_process access, so they
// cannot resolve the checkout root the way ledger-append.mjs's stripRoot
// does. This is only the operator-visible console log; the ledger file
// itself has its own, separate, root-aware redaction.
test('plan-cycle.js: the exception guard\'s log line redacts an absolute /Users or /home path embedded in the thrown error\'s message, rather than printing it verbatim (L-2)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: { spec: 'specs/foo.md' },
        agent: baseAgent({
          'scope:spec': () => { throw new Error("ENOENT: no such file, open '/Users/victim/secret-project/config.js'") },
          'ledger:write': [
            { run_id: 'start-abc', ts: 't1', write_ok: true, write_error: null },
            { run_id: 'terminal-abc', ts: 't2', write_ok: true, write_error: null },
          ],
        }),
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

test('plan-cycle.js: the exception guard\'s log line is bounded in length, even when the thrown error\'s message is very long (L-2)', async () => {
  const longMessage = 'x'.repeat(5000)
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: { spec: 'specs/foo.md' },
        agent: baseAgent({
          'scope:spec': () => { throw new Error(longMessage) },
          'ledger:write': [
            { run_id: 'start-abc', ts: 't1', write_ok: true, write_error: null },
            { run_id: 'terminal-abc', ts: 't2', write_ok: true, write_error: null },
          ],
        }),
      }),
    (err) => {
      const line = err.logs.find((l) => l.includes('start-abc'))
      assert.ok(line, `expected a log line naming the run_id, got ${JSON.stringify(err.logs)}`)
      assert.ok(line.length < longMessage.length, `expected the log line to be bounded well under the 5000-char thrown message, got length ${line.length}`)
      return true
    }
  )
})

test('plan-cycle.js: the original error still reaches the caller even when the terminal ledger write ALSO fails (AC-OPS-1: never swallowed by a failure of the terminal write itself)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: { spec: 'specs/foo.md' },
        agent: baseAgent({
          'scope:spec': () => { throw new Error('body boom') },
          'ledger:write': [
            { run_id: 'start-xyz', ts: 't1', write_ok: true, write_error: null },
            { run_id: 'irrelevant', ts: 't2', write_ok: false, write_error: 'disk full' },
          ],
        }),
      }),
    (err) => {
      assert.match(err.message, /body boom/, 'the run() error must win, not a ledger-write-failure error')
      const ledgerCalls = err.calls.filter((c) => c.opts.label === 'ledger:write')
      assert.equal(ledgerCalls.length, 2, 'a failing terminal write must still be ATTEMPTED before the original error is re-thrown')
      return true
    }
  )
})

// Review round-1 M2: see tdd-task.test.js's identical guard for the
// rationale -- `if (runError) throw runError` tests truthiness, not
// whether the catch fired.
for (const falsyValue of [null, undefined, 0, '']) {
  test(`plan-cycle.js: a falsy thrown value (${JSON.stringify(falsyValue)}) from an agent() call inside run() still propagates (M2, regression)`, async () => {
    await assert.rejects(
      () =>
        runWorkflow(WF, {
          args: { spec: 'specs/foo.md' },
          agent: baseAgent({ 'scope:spec': () => { throw falsyValue } }),
        }),
      (err) => {
        assert.equal(err, falsyValue)
        return true
      }
    )
  })
}
