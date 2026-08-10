const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { runWorkflow } = require('./helpers/fake-runtime.js')

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

test('plan-cycle.js: the "scope agent failed" early return (line 48 historically) still reaches the ledger write, with outcome aborted (AC-ARCH-3)', async () => {
  const { result, calls } = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent({ 'scope:spec': undefined }) })
  assert.equal(result.report, 'Scope agent failed; no plan produced.')
  assert.equal(result.telemetry.outcome, 'aborted')
  assert.equal(calls.filter((c) => c.opts.label === 'ledger:write').length, 2, 'expected one start write + one terminal write')
})

test('plan-cycle.js: the "every lens agent failed" early return (line 98 historically) still reaches the ledger write, with outcome aborted (AC-ARCH-3)', async () => {
  const { result, calls } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: baseAgent({ 'lens-security': undefined, 'lens-qa': undefined, 'lens-simplicity': undefined, 'lens-product': undefined }),
  })
  assert.equal(result.report, 'Every lens agent failed or was stopped; no plan produced.')
  assert.equal(result.telemetry.outcome, 'aborted')
  assert.equal(calls.filter((c) => c.opts.label === 'ledger:write').length, 2, 'expected one start write + one terminal write')
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

test('plan-cycle.js: telemetry.budget_spent is null when no budget is supplied, and reflects budget.spent() when supplied (AC-QA-15)', async () => {
  const noBudget = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent() })
  assert.equal(noBudget.result.telemetry.budget_spent, null)
  const withBudget = await runWorkflow(WF, { args: { spec: 'specs/foo.md' }, agent: baseAgent(), budget: { spent: () => 999 } })
  assert.equal(withBudget.result.telemetry.budget_spent, 999)
})
