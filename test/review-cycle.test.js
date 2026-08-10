const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { runWorkflow } = require('./helpers/fake-runtime.js')

const WF = path.join(__dirname, '..', 'workflows', 'review-cycle.js')

const LEDGER_OK = { run_id: 'r1', ts: '2026-08-10T00:00:00.000Z', write_ok: true, write_error: null }

const SCOPE_OK = {
  base: 'main',
  head_sha: 'abcdef1234567890',
  files: [{ path: 'src/foo.js', status: 'M' }],
  new_dependency_entries: false,
  new_modules: false,
  custom_rules: null,
}

const SECURITY_CLEAN = { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [] }
const QA_CLEAN = { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [] }

const SYNTHESIS_OK = {
  report: '### VERDICT\nCLEAN',
  spec_bugs: [],
  rejected_findings: [],
}

function baseAgent(overrides = {}) {
  return {
    'scope:diff': SCOPE_OK,
    'lens-security': SECURITY_CLEAN,
    'lens-qa': QA_CLEAN,
    synthesis: SYNTHESIS_OK,
    'ledger:write': LEDGER_OK,
    ...overrides,
  }
}

test('review-cycle.js: normal completion preserves the existing return shape and adds telemetry under one new key (AC-ARCH-10)', async () => {
  const { result, calls } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  assert.equal(result.base, 'main')
  assert.equal(result.head, 'abcdef1234567890')
  assert.deepEqual(result.lenses, ['lens-security', 'lens-qa'])
  assert.ok(Array.isArray(result.skipped))
  assert.deepEqual(result.verdicts, { 'lens-security': 'CLEAN', 'lens-qa': 'CLEAN' })
  assert.equal(typeof result.report, 'string', 'report must stay a string, matching its existing documented type')
  assert.ok(result.telemetry)
  assert.equal(result.telemetry.outcome, 'done')
  assert.ok(calls.find((c) => c.opts.label === 'ledger:write'))
})

test('review-cycle.js: the "no changes found" early return (line 65 historically) still reaches the ledger write, with outcome no-op (AC-ARCH-3)', async () => {
  const { result, calls } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, files: [] } }),
  })
  assert.equal(result.report, 'No changes found between the base ref and HEAD. Nothing to review.')
  assert.equal(result.telemetry.outcome, 'no-op')
  assert.equal(calls.filter((c) => c.opts.label === 'ledger:write').length, 2, 'expected one start write + one terminal write')
})

test('review-cycle.js: "every lens agent failed" early return (line 149 historically) still reaches the ledger write, with outcome aborted (AC-ARCH-3)', async () => {
  const { result, calls } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'lens-security': undefined, 'lens-qa': undefined }),
  })
  assert.equal(result.report, 'Every lens agent failed or was stopped; no review produced.')
  assert.equal(result.telemetry.outcome, 'aborted')
  assert.equal(calls.filter((c) => c.opts.label === 'ledger:write').length, 2, 'expected one start write + one terminal write')
})

test('review-cycle.js: outcome is blocked when any lens returns BLOCKED', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'lens-security': { ...SECURITY_CLEAN, verdict: 'BLOCKED' } }),
  })
  assert.equal(result.telemetry.outcome, 'blocked')
})

test('review-cycle.js: telemetry.round_key is the reviewed head SHA, identical across two runs at the same SHA (AC-QA-12)', async () => {
  const first = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  const second = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  assert.equal(first.result.telemetry.round_key, 'abcdef1234567890')
  assert.equal(first.result.telemetry.round_key, second.result.telemetry.round_key)
})

test('review-cycle.js: telemetry.trigger_counts records how many changed files matched each triggered lens surface (AC-QA-14)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'scope:diff': { ...SCOPE_OK, files: [{ path: 'src/foo.css', status: 'M' }, { path: 'src/bar.js', status: 'M' }] },
      'lens-design': SECURITY_CLEAN,
      'lens-accessibility': SECURITY_CLEAN,
    }),
  })
  assert.ok(result.telemetry.trigger_counts.ui >= 1, 'a .css change must count toward the ui trigger surface')
})

test('review-cycle.js: two fixtures differing only in trigger_counts (0 vs >0) are distinguishable, i.e. CLEAN-with-nothing-in-scope vs CLEAN-after-looking (AC-QA-14)', async () => {
  const nothingInScope = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  const somethingInScope = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, files: [{ path: 'migrations/001.sql', status: 'A' }] }, 'lens-data': SECURITY_CLEAN }),
  })
  assert.notDeepEqual(nothingInScope.result.telemetry.trigger_counts, somethingInScope.result.telemetry.trigger_counts)
})

test('review-cycle.js: synthesis missing spec_bugs/rejected_findings fields is treated as a failed step, not a ledger line with silently empty arrays (AC-QA-13)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ synthesis: { report: 'markdown only, no structured fields' } }),
  })
  // The malformed synthesis response (missing the required structured
  // fields) must not silently produce spec_bug_count: 0 / rejected_finding_count: 0.
  assert.equal(result.telemetry.spec_bug_count, null)
  assert.equal(result.telemetry.rejected_finding_count, null)
})

test('review-cycle.js: spec bugs and rejected findings from a well-formed synthesis are counted in the workflow\'s own telemetry (AC-QA-13)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      synthesis: {
        report: '### VERDICT\nFINDINGS',
        spec_bugs: [{ lens: 'lens-qa', location: 'foo.js:1', claim: 'no AC covers this' }],
        rejected_findings: [{ lens: 'lens-security', location: 'bar.js:2', claim: 'false alarm', ac_id: 'AC-SEC-1' }],
      },
    }),
  })
  assert.equal(result.telemetry.spec_bug_count, 1)
  assert.equal(result.telemetry.rejected_finding_count, 1)
})

test('review-cycle.js: the raw spec_bugs/rejected_findings descriptors are sent to the ledger-write step as data, since workflow scripts have no node:crypto to compute finding ids themselves (AC-QA-11) -- ledger-append.mjs computes the actual ids (see its own tests)', async () => {
  const { calls } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      synthesis: {
        report: 'x',
        spec_bugs: [{ lens: 'lens-qa', location: 'foo.js:1', claim: 'no AC covers this' }],
        rejected_findings: [],
      },
    }),
  })
  const terminalCall = calls.filter((c) => c.opts.label === 'ledger:write').pop()
  assert.ok(terminalCall.prompt.includes('"lens":"lens-qa"'))
  assert.ok(terminalCall.prompt.includes('"claim":"no AC covers this"'))
})

test('review-cycle.js: a ledger write failure never fails the run (AC-QA-7)', async () => {
  const { result, logs } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'ledger:write': { run_id: 'rX', ts: 'x', write_ok: false, write_error: 'boom' } }),
  })
  assert.equal(typeof result.report, 'string')
  assert.ok(logs.some((l) => l.includes('rX') && l.includes('boom')))
})

test('review-cycle.js: a ledger write failure via the agent call itself throwing never fails the run (AC-QA-7)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'ledger:write': () => { throw new Error('agent crashed') } }),
  })
  assert.equal(typeof result.report, 'string')
})

test('review-cycle.js: telemetry.budget_spent is null when no budget is supplied (AC-QA-15)', async () => {
  const { result } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  assert.equal(result.telemetry.budget_spent, null)
})
