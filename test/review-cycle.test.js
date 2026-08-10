const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')

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

test('review-cycle.js: telemetry.round_key tracks a DIFFERENT head SHA, not a constant (M4: a hardcoded string equal to the fixture\'s usual SHA previously survived, because the old test only ever varied nothing)', async () => {
  const sameShaTwice = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  const differentSha = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, head_sha: '1111111111111111111111111111111111aaaa' } }),
  })
  assert.equal(differentSha.result.telemetry.round_key, '1111111111111111111111111111111111aaaa')
  assert.notEqual(sameShaTwice.result.telemetry.round_key, differentSha.result.telemetry.round_key, 'round_key must actually vary with the reviewed SHA, not be pinned to one literal value')
})

test('review-cycle.js: telemetry.trigger_counts is keyed BY LENS NAME, not by rule group, so it can be looked up directly against lenses_run (AC-QA-14, M1)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'scope:diff': { ...SCOPE_OK, files: [{ path: 'src/foo.css', status: 'M' }, { path: 'src/bar.js', status: 'M' }] },
      'lens-design': SECURITY_CLEAN,
      'lens-accessibility': SECURITY_CLEAN,
    }),
  })
  assert.equal(result.telemetry.trigger_counts['lens-design'], 1, 'exactly one file (foo.css) matched the ui surface')
  assert.equal(result.telemetry.trigger_counts['lens-accessibility'], 1)
})

test('review-cycle.js: a lens triggered by a non-glob signal (new_modules) is NOT credited with an unrelated rule group\'s count (M1)', async () => {
  // Before the fix, lens-architecture's count read archHit.length (files
  // matching the architecture globs) even when the lens was triggered
  // purely because new_modules was true and zero files matched the glob --
  // indistinguishable from "triggered with nothing in scope".
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'scope:diff': { ...SCOPE_OK, files: [{ path: 'src/newmodule/index.js', status: 'A' }], new_modules: true },
      'lens-architecture': SECURITY_CLEAN,
    }),
  })
  assert.ok(result.lenses.includes('lens-architecture'), 'sanity: lens-architecture must actually be triggered here')
  assert.equal(result.telemetry.trigger_counts['lens-architecture'], 0, 'zero files matched the architecture glob, and the count must say so honestly rather than borrowing another field')
})

test('review-cycle.js: lens-product\'s count reflects files that actually triggered it (specs/** OR the ui surface), not only specs/** (M1: the exact bug reproduced -- a UI-only diff triggers lens-product via uiHit but its count previously read specHit, always 0)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'scope:diff': { ...SCOPE_OK, files: [{ path: 'src/foo.css', status: 'M' }] },
      'lens-design': SECURITY_CLEAN,
      'lens-accessibility': SECURITY_CLEAN,
      'lens-product': SECURITY_CLEAN,
    }),
  })
  assert.ok(result.lenses.includes('lens-product'), 'sanity: lens-product must actually be triggered by the ui surface here')
  assert.equal(result.telemetry.trigger_counts['lens-product'], 1, 'lens-product was triggered by the one UI file; its count must reflect that, not a bare 0 from an unrelated specs/** count')
})

test('review-cycle.js: always-on lenses (security, qa) record the total changed-file count, so 0 always means a genuine zero-file diff (M1)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, files: [{ path: 'a.js', status: 'M' }, { path: 'b.js', status: 'M' }] } }),
  })
  assert.equal(result.telemetry.trigger_counts['lens-security'], 2)
  assert.equal(result.telemetry.trigger_counts['lens-qa'], 2)
})

test('review-cycle.js: two fixtures differing only in whether ANY lens has files in scope are distinguishable via trigger_counts, i.e. CLEAN-with-nothing-in-scope vs CLEAN-after-looking (AC-QA-14)', async () => {
  const nothingInScope = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  const somethingInScope = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, files: [{ path: 'migrations/001.sql', status: 'A' }] }, 'lens-data': SECURITY_CLEAN }),
  })
  assert.equal(nothingInScope.result.telemetry.trigger_counts['lens-data'], undefined, 'lens-data was never triggered, so it has no key at all')
  assert.equal(somethingInScope.result.telemetry.trigger_counts['lens-data'], 1)
})

test('review-cycle.js: synthesis missing spec_bugs/rejected_findings fields is treated as a failed step, not a ledger line with silently empty arrays (AC-QA-13)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    // The synthesis agent() call declares required: ['report', 'spec_bugs',
    // 'rejected_findings'] (L3 now enforces declared schemas), so this
    // fixture must opt out explicitly: it is deliberately simulating the
    // impossible-per-the-schema case that review-cycle.js's own defensive
    // fallback exists to guard against, not a normal successful response.
    agent: baseAgent({ synthesis: { report: 'markdown only, no structured fields', __bypassSchemaValidation: true } }),
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
  // The prompt embeds the payload base64-encoded (H1: no shell-injection
  // surface via raw quotes), so this decodes it rather than string-matching
  // the prompt text directly.
  const payload = extractLedgerPayload(terminalCall.prompt)
  assert.equal(payload.spec_bugs[0].lens, 'lens-qa')
  assert.equal(payload.spec_bugs[0].claim, 'no AC covers this')
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

test('review-cycle.js: every lens\'s reported findings are sent to the ledger-write step as open_findings (H5: accepted findings were previously never recorded at all, so fix-vs-reject could never be computed)', async () => {
  const { calls } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'lens-security': {
        verdict: 'FINDINGS',
        coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' },
        findings: [{ severity: 'High', claim: 'missing auth check', location: 'foo.js:10', evidence: 'e', consequence: 'c', fix: 'f' }],
      },
    }),
  })
  const terminalCall = calls.filter((c) => c.opts.label === 'ledger:write').pop()
  const payload = extractLedgerPayload(terminalCall.prompt)
  assert.ok(Array.isArray(payload.open_findings), 'expected an open_findings array in the terminal payload')
  assert.equal(payload.open_findings.length, 1)
  assert.equal(payload.open_findings[0].lens, 'lens-security')
  assert.equal(payload.open_findings[0].location, 'foo.js:10')
  assert.equal(payload.open_findings[0].claim, 'missing auth check')
  assert.equal(payload.open_findings[0].severity, 'High')
})

test('review-cycle.js: a CLEAN run with no findings from any lens sends an empty open_findings array, not null (a real measured zero)', async () => {
  const { calls } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  const terminalCall = calls.filter((c) => c.opts.label === 'ledger:write').pop()
  const payload = extractLedgerPayload(terminalCall.prompt)
  assert.deepEqual(payload.open_findings, [])
})
