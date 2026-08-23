const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')

const WF = path.join(__dirname, '..', 'workflows', 'plan-cycle.js')

const LEDGER_OK = { run_id: 'r1', ts: '2026-08-10T00:00:00.000Z', write_ok: true, write_error: null }

// specs/harn-fix-3.md AC-QA-1..4: the shape workflows/lib/install-consistency.mjs
// actually prints (see test/install-consistency.test.js for the real script's
// own output shape); a consistent, non-blind install is the default fixture so
// every pre-existing test keeps dispatching lenses unless it deliberately
// overrides this field.
const CONSISTENCY_OK = {
  ok: true,
  consistent: true,
  blind: false,
  checked_dir: '/fake/install',
  lens_files_checked: 9,
  // MED-2: doc_fields/agent_fields must be a subset the REAL PLAN_SCHEMA and
  // REVIEW_SCHEMA both declare, or the in-process cross-check refuses even
  // this "consistent" fixture -- 'recurrence' is the one field both real
  // schemas' findings items actually carry.
  doc_fields: ['recurrence'],
  agent_fields: ['recurrence'],
  missing_in_review_schema: [],
  missing_in_plan_schema: [],
  review_only_props: [],
  plan_only_props: [],
  error: null,
  escape_hatch_active: false,
}

const SCOPE_OK = {
  head_sha: 'abc1234567890def',
  summary: 'adds a widget',
  ui: false,
  data: false,
  architecture: false,
  operability: false,
  user_facing: true,
  likely_paths: ['src/widget.js'],
  consistency: CONSISTENCY_OK,
}

const LENS_CLEAN = { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, acceptance_criteria: [{ id: 'AC-SEC-1', statement: 'x' }] }

function baseAgent(overrides = {}) {
  return {
    'scope:spec': SCOPE_OK,
    'lens-security': LENS_CLEAN,
    'lens-qa': LENS_CLEAN,
    'lens-simplicity': { ...LENS_CLEAN, acceptance_criteria: [] },
    'lens-product': LENS_CLEAN,
    'synthesis:write-back': { summary: '### Summary\n4 criteria', head_sha_at_synthesis: 'abc1234567890def' },
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
//
// Review round-4 M2: see review-cycle.test.js's identical test for the
// full rationale -- the original `export`-then-invoke wording (this file's
// own, propagated from round 3) cannot work in this runtime, because shell
// state does not persist across separate tool calls. Fixed to the
// SAME-COMMAND form here too.
test('plan-cycle.js: every lens\'s prompt instructs it to set HARNESS_LEDGER_READONLY on the SAME command line as the writer invocation (never a separate `export`, which cannot survive to the next tool call), before it probes ledger-append.mjs (M2)', async () => {
  const { calls } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  const lensCall = calls.find((c) => c.opts.label === 'lens-security')
  assert.ok(lensCall, 'expected a lens-security call')
  assert.match(lensCall.prompt, /HARNESS_LEDGER_READONLY/, 'the lens prompt must name the env var')
  assert.match(lensCall.prompt, /HARNESS_LEDGER_READONLY=1 node\b/, 'the lens prompt must give the concrete SAME-COMMAND form (var=value prefixed onto the invocation), never a separate export')
  assert.doesNotMatch(lensCall.prompt, /\bexport HARNESS_LEDGER_READONLY/i, 'the lens prompt must NEVER instruct a bare `export` -- it cannot survive to the next tool call in this runtime')
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

test('plan-cycle.js: outcome is aborted (not done) when synthesis:write-back returns an empty summary (M1)', async () => {
  const { result } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent({ 'synthesis:write-back': { summary: '' } }) })
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
      assert.ok(line.length < 700, `expected the log line bounded near MAX_LOG_TEXT (500) plus its fixed prefix, not merely under the 5000-char thrown message (round-7 review F14: the old bound could not catch MAX_LOG_TEXT being widened by an order of magnitude), got length ${line.length}`)
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

// 2026-08-18: the ledger stopped recording for six days and nothing noticed.
// The write failure was correctly caught, correctly logged, and correctly
// returned as write_ok:false -- to NO CONSUMER. AC-QA-7 says a ledger write
// failure must never FAIL the run; it does not say the failure must be
// indistinguishable from success. These pin the consumer, so the next silent
// outage is loud on the first run rather than on the sixth day.
test('plan-cycle.js: a failed ledger write surfaces in the workflow RETURN VALUE, not only in a log line nobody re-reads', async () => {
  const failing = { run_id: 'r1', ts: '2026-08-10T00:00:00.000Z', write_ok: false, write_error: 'ReferenceError: Buffer is not defined' }
  const { result } = await runWorkflow(WF, {
    args: { spec: 'specs/x.md' },
    agent: baseAgent({ 'ledger:write': failing }),
  })
  assert.equal(result.ledger_write_failed, true, 'the caller must be able to tell telemetry did not land')
  assert.match(String(result.ledger_write_error), /Buffer is not defined/, 'and must carry WHY, not just that it failed')
})

test('plan-cycle.js: a SUCCESSFUL ledger write does not raise the failure flag (the signal must not cry wolf)', async () => {
  const { result } = await runWorkflow(WF, { args: { spec: 'specs/x.md' }, agent: baseAgent() })
  assert.notEqual(result.ledger_write_failed, true, 'a healthy run must not report a ledger failure')
})

// 2026-08-18 (H1): the shared-checkout mis-review HAPPENED here, in planning,
// not in review. A planning lens emitted confident, line-cited criteria about
// a branch nobody asked about, because another session had the shared main
// checkout on its own branch. The drift guard went into review-cycle first --
// the cycle whose lenses already run in ISOLATED WORKTREES. Planning's do not
// (plan-cycle.js:229, "planning is read-only, no isolation needed"), so this
// is the more exposed of the two and got the guard second.
test('plan-cycle.js: a HEAD that moves mid-plan is surfaced, not silently written into the spec', async () => {
  const moved = { summary: '### Summary\n4 criteria', head_sha_at_synthesis: 'ffffffffffffffff' }
  const { result } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent({ 'synthesis:write-back': moved }) })
  assert.equal(result.checkout_moved, true, 'the caller must learn the tree moved under the plan')
  assert.match(String(result.checkout_moved_detail), /abc1234567890def/, 'and must name the sha it scoped')
  assert.match(String(result.checkout_moved_detail), /ffffffffffffffff/, 'and the sha it ended on')
})

test('plan-cycle.js: a stable HEAD does not raise the moved-checkout flag (must not cry wolf)', async () => {
  const { result } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  assert.notEqual(result.checkout_moved, true, 'an unmoved checkout must not report a move')
})

test('plan-cycle.js: a synthesis omitting head_sha_at_synthesis does not fabricate a verdict either way', async () => {
  const noSha = { summary: '### Summary\n4 criteria' }
  const { result } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent({ 'synthesis:write-back': noSha }) })
  assert.notEqual(result.checkout_moved, true, 'absent evidence must not be read as a move')
})

// specs/harn-fix-3.md AC-QA-1/AC-QA-2/AC-QA-3/AC-QA-4: the install-consistency
// preflight, folded into the scope:spec agent() call (never a new one --
// AC-QA-3).
const ALL_LENSES = ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product', 'lens-design', 'lens-accessibility', 'lens-data', 'lens-architecture', 'lens-operability']

// specs/harn-fix-3.md AC-QA-2 (AMENDED, round-two review): refuse ONLY on a
// PROVEN mismatch (the in-process cross-check against PLAN_SCHEMA as this
// process actually holds it); everything uncertain -- blind, could-not-check,
// a missing consistency field, or the script's own prose-derived verdict
// with no in-process proof -- now WARNS and PROCEEDS. Certainty refuses,
// uncertainty warns, never halts.
test('plan-cycle.js: AC-QA-1/AC-QA-2 (amended) -- a PROVEN mismatch (consistent:false backed by doc_fields/agent_fields naming a field absent from the RUNNING PLAN_SCHEMA) refuses BEFORE dispatching any lens, names the mismatched field and both sides, and exits non-zero (throws)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: { spec: 'specs/foo.md' },
        agent: baseAgent({
          'scope:spec': {
            ...SCOPE_OK,
            consistency: {
              ...CONSISTENCY_OK,
              consistent: false,
              doc_fields: ['recurrence', 'effort'],
              agent_fields: ['effort'],
              missing_in_review_schema: ['effort'],
              missing_in_plan_schema: ['effort'],
            },
          },
        }),
      }),
    (err) => {
      assert.match(err.message, /PROVEN by the in-process cross-check/, 'must name the reliable, in-process half as the reason for refusing (AC-QA-2 amendment)')
      assert.match(err.message, /effort/, 'the error must name the mismatched field')
      assert.match(err.message, /PLAN_SCHEMA/, 'the error must name the running schema it checked')
      const dispatchedLenses = err.calls.filter((c) => ALL_LENSES.includes(c.opts.label))
      assert.equal(dispatchedLenses.length, 0, `no lens agent may be dispatched on refusal, by COUNT, got: ${dispatchedLenses.map((c) => c.opts.label)}`)
      return true
    }
  )
})

test('plan-cycle.js: AC-QA-1/AC-QA-2 (amended, H2) -- blind:true (the check found nothing to compare) now WARNS and PROCEEDS -- lenses still dispatch, one loud log line records the uncertainty', async () => {
  const { result, calls, logs } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({
      'scope:spec': { ...SCOPE_OK, consistency: { ...CONSISTENCY_OK, consistent: false, blind: true, doc_fields: [], agent_fields: [] } },
    }),
  })
  assert.deepEqual(result.lenses, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'], 'blind must no longer block dispatch (AC-QA-2 amendment)')
  const dispatchedLenses = calls.filter((c) => ALL_LENSES.includes(c.opts.label))
  assert.ok(dispatchedLenses.length > 0, 'expected lenses to have dispatched')
  assert.ok(logs.some((l) => l.includes('WARNING') && l.includes('blind')), `expected a warning log naming the blind condition, got: ${JSON.stringify(logs)}`)
})

test('plan-cycle.js: AC-QA-1/AC-QA-2 (amended, H2) -- a scope response missing the consistency field entirely (an old or misbehaving agent) now WARNS and PROCEEDS rather than refusing or silently assuming clean', async () => {
  const { consistency, ...scopeWithoutConsistency } = SCOPE_OK
  const { result, logs } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({ 'scope:spec': { ...scopeWithoutConsistency, consistency: undefined, __bypassSchemaValidation: true } }),
  })
  assert.deepEqual(result.lenses, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'])
  assert.ok(logs.some((l) => l.includes('WARNING') && l.includes('no "consistency" field')), `expected a warning log, got: ${JSON.stringify(logs)}`)
})

test('plan-cycle.js: AC-QA-1/AC-QA-2 (amended, H2) -- the SCRIPT\'s own prose-derived consistent:false, with NO proof from the in-process cross-check (doc_fields/agent_fields both genuinely present in the running schema), now WARNS and PROCEEDS instead of refusing -- this is the exact asymmetry the ruling names: a heuristic disagreeing with the reliable half is doubt, not proof', async () => {
  const { result, logs } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({
      'scope:spec': {
        ...SCOPE_OK,
        consistency: { ...CONSISTENCY_OK, consistent: false, doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: ['recurrence'] },
      },
    }),
  })
  assert.deepEqual(result.lenses, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'])
  assert.ok(logs.some((l) => l.includes('WARNING') && l.includes('no proof')), `expected a warning naming the lack of in-process proof, got: ${JSON.stringify(logs)}`)
})

// round-one review MED-6: the ORIGINAL form of this test compared a run
// against a second, identical run of the SAME code -- baselineCalls was
// not a baseline, it was the change already applied, so the assertion
// could only ever fail on nondeterminism. Proven by mutation (see
// docs/install-consistency-mutation-proofs.md): inserting a real spurious
// agent() dispatch before the gate left this test passing. Fixed by
// pinning the ABSOLUTE expected call sequence instead, which needs only
// ONE run and fails on any added, removed or reordered dispatch.
test('plan-cycle.js: AC-QA-3 -- a consistent, non-blind install dispatches EXACTLY this call sequence, with no extra agent() call for the consistency check (pinned absolute sequence, not a self-comparison -- MED-6)', async () => {
  const { result, calls } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  assert.deepEqual(result.lenses, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'], 'lenses must still dispatch normally')
  assert.deepEqual(calls.map((c) => c.opts.label), [
    'ledger:write',
    'scope:spec',
    'lens-security',
    'lens-qa',
    'lens-simplicity',
    'lens-product',
    'synthesis:write-back',
    'ledger:write',
  ])
})

test('plan-cycle.js: AC-QA-1 -- the scope:spec prompt instructs locating install-consistency.mjs via (a)/(b) ONLY, with NO repo-local fallback (M2, round-two review), CLAUDE_HOME taking priority (M11), and passing the install root as an explicit argument', async () => {
  const { calls } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  const scopeCall = calls.find((c) => c.opts.label === 'scope:spec')
  assert.ok(scopeCall, 'expected a scope:spec call')
  assert.match(scopeCall.prompt, /install-consistency\.mjs/)
  assert.match(scopeCall.prompt, /~\/\.claude\/workflows\/lib\/install-consistency\.mjs/, 'must name the global mirror install location, same convention as the ledger writer')
  // M11 (round-two review): CLAUDE_HOME must be named as a real, reachable
  // override for this call path, not only for the staleness check.
  assert.match(scopeCall.prompt, /CLAUDE_HOME/, 'must name CLAUDE_HOME as an override (M11)')
  assert.match(scopeCall.prompt, /takes priority and skips the search/, 'must state CLAUDE_HOME is checked FIRST, ahead of the (a)/(b) search')
  // M2 (round-two review): option (c), the repo-local fallback, is REMOVED
  // entirely -- a prose prohibition on USING a hostile repo-local copy
  // (round-one's MED-1 fix) was not sufficient, because the search order
  // still offered a path inside the reviewed checkout to consider at all.
  // Proven absent by asserting the distinctive (c)-only text is gone.
  assert.doesNotMatch(scopeCall.prompt, /git rev-parse --show-toplevel/, 'M2: the repo-local resolution branch (c) must be removed entirely, not merely prohibited in prose')
  assert.match(scopeCall.prompt, /deliberately no repo-local fallback option at all/, 'must state plainly that no repo-local fallback exists at all (M2)')
  assert.match(scopeCall.prompt, /NEVER a path inside the repository currently being planned or reviewed/, 'must forbid branch (b) resolving to anything inside the reviewed checkout (M2)')
  assert.match(scopeCall.prompt, /as its ONE argument/, 'must instruct passing the resolved install root explicitly, not relying on the script\'s own ~/.claude default')
})

test('plan-cycle.js: the scope:spec schema requires "consistency" -- an omitted field is rejected before the workflow ever sees it (AC-QA-1)', async () => {
  const { calls } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  const scopeCall = calls.find((c) => c.opts.label === 'scope:spec')
  assert.ok(scopeCall.opts.schema.required.includes('consistency'))
})

// round-one review MED-2: the refusal must not be decided SOLELY by the
// "consistent" boolean the scope agent reports -- a fabricated
// {consistent:true} previously satisfied the schema and passed the gate
// undetectably. These prove the in-process cross-check (crossCheckAgainstOwnSchema,
// verified against the LITERAL PLAN_SCHEMA object this process holds) closes
// that specific bypass.
test('plan-cycle.js: MED-2 -- a FABRICATED consistent:true is still refused when the reported doc_fields/agent_fields name a field the RUNNING PLAN_SCHEMA does not declare (the in-process cross-check catches what the model-reported verdict alone could not)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: { spec: 'specs/foo.md' },
        agent: baseAgent({
          'scope:spec': {
            ...SCOPE_OK,
            consistency: { ...CONSISTENCY_OK, consistent: true, doc_fields: ['made_up_field'], agent_fields: ['made_up_field'] },
          },
        }),
      }),
    (err) => {
      assert.match(err.message, /PROVEN by the in-process cross-check/, 'must name the reliable, in-process half as the reason for refusing (AC-QA-2 amendment)')
      assert.match(err.message, /made_up_field/, 'must name the offending field')
      assert.match(err.message, /PLAN_SCHEMA/)
      const dispatchedLenses = err.calls.filter((c) => ALL_LENSES.includes(c.opts.label))
      assert.equal(dispatchedLenses.length, 0, 'a fabricated consistent:true must not reach lens dispatch')
      return true
    }
  )
})

// AC-QA-2 amendment (H2, round-two review): an empty doc_fields/agent_fields
// report has NOTHING for the in-process cross-check to prove wrong -- it is
// uncertainty (nothing to check), not proof of a mismatch, so it now WARNS
// and PROCEEDS rather than refusing, even though "consistent:true" was
// ALSO reported (the model asserted clean with no evidence to back it).
test('plan-cycle.js: MED-2/H2 -- a fabricated consistent:true with EMPTY doc_fields/agent_fields now WARNS and PROCEEDS (nothing was reported to cross-check, which is uncertainty, not proof)', async () => {
  const { result, logs } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({
      'scope:spec': { ...SCOPE_OK, consistency: { ...CONSISTENCY_OK, consistent: true, doc_fields: [], agent_fields: [] } },
    }),
  })
  assert.deepEqual(result.lenses, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'])
  assert.ok(logs.some((l) => l.includes('WARNING') && l.includes('nothing to cross-check')), `expected a warning naming the empty report, got: ${JSON.stringify(logs)}`)
})

test('plan-cycle.js: MED-2 -- a GENUINE, real-shaped consistency report (doc_fields/agent_fields naming a field the running PLAN_SCHEMA DOES declare) still dispatches normally (the cross-check must not cry wolf on honest input)', async () => {
  const { result } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({
      'scope:spec': { ...SCOPE_OK, consistency: { ...CONSISTENCY_OK, doc_fields: ['recurrence', 'evidence'], agent_fields: ['recurrence'] } },
    }),
  })
  assert.deepEqual(result.lenses, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'])
})

// round-two review M9: the escape hatch. HARNESS_ALLOW_INCONSISTENT_INSTALL=1
// is read by install-consistency.mjs's main() (real Node, has process.env)
// and relayed as consistency.escape_hatch_active; the workflow (no
// process.env access at all) only ever reads that relayed boolean.
test('plan-cycle.js: M9 -- a PROVEN mismatch with escape_hatch_active:true WARNS and PROCEEDS instead of refusing, and the warning names the override explicitly', async () => {
  const { result, logs } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({
      'scope:spec': {
        ...SCOPE_OK,
        consistency: { ...CONSISTENCY_OK, consistent: false, doc_fields: ['effort'], agent_fields: ['effort'], missing_in_review_schema: ['effort'], missing_in_plan_schema: ['effort'], escape_hatch_active: true },
      },
    }),
  })
  assert.deepEqual(result.lenses, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'], 'the escape hatch must let dispatch proceed')
  assert.ok(logs.some((l) => l.includes('WARNING') && l.includes('HARNESS_ALLOW_INCONSISTENT_INSTALL')), `expected a warning naming the override, got: ${JSON.stringify(logs)}`)
})

test('plan-cycle.js: M9 -- a PROVEN mismatch with escape_hatch_active:false (the default) still refuses -- the escape hatch must not be active by default', async () => {
  await assert.rejects(() =>
    runWorkflow(WF, {
      args: { spec: 'specs/foo.md' },
      agent: baseAgent({
        'scope:spec': {
          ...SCOPE_OK,
          consistency: { ...CONSISTENCY_OK, consistent: false, doc_fields: ['effort'], agent_fields: ['effort'], missing_in_review_schema: ['effort'], missing_in_plan_schema: ['effort'], escape_hatch_active: false },
        },
      }),
    })
  )
})

// round-two review M3: a self-contradictory report (consistent:true
// alongside a non-empty mismatch array, or alongside blind:true) needs no
// external parsing to detect -- it is a fact about the report's own
// structure -- so it is treated as PROVEN, refusing exactly like a genuine
// cross-check failure, never as mere uncertainty.
test('plan-cycle.js: M3 -- a self-contradictory report (consistent:true alongside a non-empty missing_in_plan_schema) refuses, by count, naming the contradiction', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: { spec: 'specs/foo.md' },
        agent: baseAgent({
          'scope:spec': {
            ...SCOPE_OK,
            consistency: { ...CONSISTENCY_OK, consistent: true, missing_in_plan_schema: ['recurrence'] },
          },
        }),
      }),
    (err) => {
      assert.match(err.message, /self-contradictory/)
      const dispatchedLenses = err.calls.filter((c) => ALL_LENSES.includes(c.opts.label))
      assert.equal(dispatchedLenses.length, 0, 'a self-contradictory report must not reach lens dispatch, by COUNT')
      return true
    }
  )
})

test('plan-cycle.js: M3 -- a self-contradictory report (consistent:true alongside blind:true) also refuses', async () => {
  await assert.rejects(() =>
    runWorkflow(WF, {
      args: { spec: 'specs/foo.md' },
      agent: baseAgent({
        'scope:spec': { ...SCOPE_OK, consistency: { ...CONSISTENCY_OK, consistent: true, blind: true } },
      }),
    })
  )
})

test('plan-cycle.js: M3 -- a self-contradictory report with escape_hatch_active:true WARNS and PROCEEDS instead of refusing', async () => {
  const { result, logs } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({
      'scope:spec': {
        ...SCOPE_OK,
        consistency: { ...CONSISTENCY_OK, consistent: true, missing_in_plan_schema: ['recurrence'], escape_hatch_active: true },
      },
    }),
  })
  assert.deepEqual(result.lenses, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'])
  assert.ok(logs.some((l) => l.includes('WARNING') && l.includes('self-contradiction')), `expected a warning naming the override, got: ${JSON.stringify(logs)}`)
})

test('plan-cycle.js: M3 -- a NON-contradictory report (consistent:true, all four mismatch arrays genuinely empty, blind:false) is not flagged as self-contradictory (must not cry wolf)', async () => {
  const { result } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  assert.deepEqual(result.lenses, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'])
})
