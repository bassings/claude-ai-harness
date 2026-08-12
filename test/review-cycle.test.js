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

// L5: AC-ARCH-10's "exactly one new top-level key" clause was unguarded --
// nothing asserted the FULL key set, so leaking the internal __outcome
// sentinel (destructured out via `const { __outcome, ...result } = raw`
// before telemetry is added) into the public result would pass every
// existing assertion above unnoticed.
test('review-cycle.js: the result carries EXACTLY its documented keys plus telemetry -- the internal __outcome sentinel does not leak through (L5, AC-ARCH-10)', async () => {
  const { result } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  assert.deepEqual(Object.keys(result).sort(), ['base', 'head', 'lenses', 'report', 'skipped', 'telemetry', 'verdicts'])
})

// M1: a run whose synthesis agent fails (undefined response) or returns a
// structurally-valid-but-empty report was previously recorded as outcome
// "done" -- inflating the denominator of "rounds to clean", the spec's
// headline measure, and giving the operator no visible sign the run
// produced nothing.
test('review-cycle.js: outcome is aborted (not done) when the synthesis agent call fails entirely (undefined response), even though every lens completed cleanly (M1)', async () => {
  const { result } = await runWorkflow(WF, { args: {}, agent: baseAgent({ synthesis: undefined }) })
  assert.equal(result.telemetry.outcome, 'aborted')
  assert.equal(result.report, '', 'an aborted run must not carry a stale or partial report string')
})

test('review-cycle.js: outcome is aborted (not done) when synthesis returns a structurally-valid response with an empty report string (M1)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ synthesis: { report: '', spec_bugs: [], rejected_findings: [] } }),
  })
  assert.equal(result.telemetry.outcome, 'aborted')
})

// M3: see tdd-task.js for the identical guard gap and rationale -- nothing
// previously pinned the start record to before the work.
test('review-cycle.js: the start-record ledger write is the very first agent() call, strictly before any work-agent step (M3)', async () => {
  const { calls } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  assert.ok(calls.length > 1, 'expected more than just the start write')
  assert.equal(calls[0].opts.label, 'ledger:write', 'the start-record ledger write must be the FIRST agent() call in the unfiltered order')
  assert.equal(calls[1].opts.label, 'scope:diff', 'the second call must be the first real work step, not another ledger write')
})

// AC-QA-9: distinct run_ids per call, and the terminal request checked
// against the START write's run_id, not just a call count -- see
// tdd-task.test.js's parametrized version for the identical rationale.
const PAIRED_LEDGER = [
  { run_id: 'return-path-start', ts: 't1', write_ok: true, write_error: null },
  { run_id: 'return-path-terminal', ts: 't2', write_ok: true, write_error: null },
]

test('review-cycle.js: the "no changes found" early return (line 65 historically) still reaches the ledger write, with outcome no-op, and the terminal write reuses the start run_id (AC-ARCH-3, AC-QA-9)', async () => {
  const { result, calls } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, files: [] }, 'ledger:write': PAIRED_LEDGER }),
  })
  assert.equal(result.report, 'No changes found between the base ref and HEAD. Nothing to review.')
  assert.equal(result.telemetry.outcome, 'no-op')
  const ledgerCalls = calls.filter((c) => c.opts.label === 'ledger:write')
  assert.equal(ledgerCalls.length, 2, 'expected one start write + one terminal write')
  assert.equal(extractLedgerPayload(ledgerCalls[1].prompt).run_id, 'return-path-start', 'the terminal write must request reuse of the start run_id')
})

test('review-cycle.js: "every lens agent failed" early return (line 149 historically) still reaches the ledger write, with outcome aborted, and the terminal write reuses the start run_id (AC-ARCH-3, AC-QA-9)', async () => {
  const { result, calls } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'lens-security': undefined, 'lens-qa': undefined, 'ledger:write': PAIRED_LEDGER }),
  })
  assert.equal(result.report, 'Every lens agent failed or was stopped; no review produced.')
  assert.equal(result.telemetry.outcome, 'aborted')
  const ledgerCalls = calls.filter((c) => c.opts.label === 'ledger:write')
  assert.equal(ledgerCalls.length, 2, 'expected one start write + one terminal write')
  assert.equal(extractLedgerPayload(ledgerCalls[1].prompt).run_id, 'return-path-start', 'the terminal write must request reuse of the start run_id')
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

// M5 (AC-QA-14 guard gap): the three tests above for lens-data and
// lens-product each use a SINGLE-file diff, where the matched count and the
// total changed-file count are numerically identical -- a mutation reading
// `paths.length` (the total) instead of the correct matched-subset count
// survives unnoticed (measured: `= paths.length` for lens-data and
// lens-product left the suite green). lens-operability had no trigger_counts
// test at all (measured: `= 999` left it green). Every fixture below is a
// MULTI-file diff where the matched subset is strictly smaller than the
// total, so a wrong count (paths.length, or any other value) is
// distinguishable from the correct one.
test('review-cycle.js: lens-operability\'s trigger_counts reflects only the files that matched its glob, not the total changed-file count (M5, AC-QA-14)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'scope:diff': { ...SCOPE_OK, files: [{ path: 'Dockerfile', status: 'M' }, { path: 'src/unrelated1.js', status: 'M' }, { path: 'src/unrelated2.js', status: 'M' }] },
      'lens-operability': SECURITY_CLEAN,
    }),
  })
  assert.ok(result.lenses.includes('lens-operability'), 'sanity: lens-operability must actually be triggered here')
  assert.equal(result.telemetry.trigger_counts['lens-operability'], 1, 'exactly one of the three changed files (Dockerfile) matched the operability glob')
})

test('review-cycle.js: lens-data\'s trigger_counts reflects only the files that matched its glob, not the total changed-file count (M5, AC-QA-14, non-vacuous multi-file fixture)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'scope:diff': { ...SCOPE_OK, files: [{ path: 'migrations/001.sql', status: 'A' }, { path: 'src/unrelated1.js', status: 'M' }, { path: 'src/unrelated2.js', status: 'M' }] },
      'lens-data': SECURITY_CLEAN,
    }),
  })
  assert.ok(result.lenses.includes('lens-data'), 'sanity: lens-data must actually be triggered here')
  assert.equal(result.telemetry.trigger_counts['lens-data'], 1, 'exactly one of the three changed files (migrations/001.sql) matched the data glob')
})

test('review-cycle.js: lens-product\'s trigger_counts reflects only the files that actually triggered it, not the total changed-file count (M5, AC-QA-14, non-vacuous multi-file fixture)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'scope:diff': { ...SCOPE_OK, files: [{ path: 'src/foo.css', status: 'M' }, { path: 'src/unrelated1.js', status: 'M' }, { path: 'src/unrelated2.js', status: 'M' }] },
      'lens-design': SECURITY_CLEAN,
      'lens-accessibility': SECURITY_CLEAN,
      'lens-product': SECURITY_CLEAN,
    }),
  })
  assert.ok(result.lenses.includes('lens-product'), 'sanity: lens-product must actually be triggered by the ui surface here')
  assert.equal(result.telemetry.trigger_counts['lens-product'], 1, 'exactly one of the three changed files (foo.css) is in the ui surface')
})

// M6 (AC-QA-13 guard gap): the ONLY existing test of this path uses
// __bypassSchemaValidation to simulate a malformed synthesis response --
// which deliberately bypasses schema enforcement entirely, so it never
// actually exercises whether spec_bugs/rejected_findings are genuinely
// DECLARED REQUIRED on the schema itself (mutation: reducing required to
// just ['report'] left 19/19 green). This reads the real schema object the
// synthesis agent() call was made with, directly off the recorded call.
test('review-cycle.js: the synthesis agent() call declares report, spec_bugs and rejected_findings as REQUIRED on its schema, not merely optional properties (M6, AC-QA-13)', async () => {
  const { calls } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  const synthesisCall = calls.find((c) => c.opts.label === 'synthesis')
  assert.ok(synthesisCall, 'expected a synthesis call')
  assert.deepEqual(synthesisCall.opts.schema.required.slice().sort(), ['rejected_findings', 'report', 'spec_bugs'])
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

// H4: AC verdicts were collected from every lens (each lens's structured
// response already carries ac_verdicts, per REVIEW_SCHEMA) and then simply
// discarded -- never reaching the ledger payload at all, so "which ACs
// never fail" had no data source downstream.
test('review-cycle.js: every lens\'s ac_verdicts are aggregated into the ledger payload as {ac_id, verdict} pairs, with evidence text stripped (H4)', async () => {
  const { calls } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'lens-security': {
        verdict: 'FINDINGS',
        coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' },
        findings: [],
        ac_verdicts: [{ id: 'AC-SEC-3', verdict: 'FAIL', evidence: 'a secret quoted source line' }],
      },
      'lens-qa': {
        verdict: 'CLEAN',
        coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' },
        findings: [],
        ac_verdicts: [{ id: 'AC-QA-3', verdict: 'PASS', evidence: 'another secret line' }],
      },
    }),
  })
  const terminalCall = calls.filter((c) => c.opts.label === 'ledger:write').pop()
  const payload = extractLedgerPayload(terminalCall.prompt)
  assert.ok(Array.isArray(payload.ac_verdicts), 'expected an ac_verdicts array in the terminal payload')
  assert.deepEqual(
    payload.ac_verdicts.slice().sort((a, b) => a.ac_id.localeCompare(b.ac_id)),
    [
      { ac_id: 'AC-QA-3', verdict: 'PASS' },
      { ac_id: 'AC-SEC-3', verdict: 'FAIL' },
    ]
  )
  const serialised = JSON.stringify(payload.ac_verdicts)
  assert.ok(!serialised.includes('secret'), 'evidence text must never reach the ledger payload (AC-SEC-2)')
})

test('review-cycle.js: a run where no lens returns ac_verdicts sends an empty ac_verdicts array, not null (a real measured zero)', async () => {
  const { calls } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  const terminalCall = calls.filter((c) => c.opts.label === 'ledger:write').pop()
  const payload = extractLedgerPayload(terminalCall.prompt)
  assert.deepEqual(payload.ac_verdicts, [])
})

test('review-cycle.js: the schema each lens is called with declares ac_id on a finding, so a schema-following agent is actually invited to attribute a finding to an AC (H4: previously undeclared, so f.ac_id || null at the aggregation site was always null in practice, even though the JS itself would have carried a supplied value through)', async () => {
  const { calls } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  const lensCall = calls.find((c) => c.opts.label === 'lens-security')
  assert.ok(lensCall, 'expected a lens-security call')
  const findingProps = lensCall.opts.schema.properties.findings.items.properties
  assert.ok('ac_id' in findingProps, 'the findings schema each lens is called with must declare ac_id')
})

test('review-cycle.js: a finding\'s ac_id survives into open_findings when a lens supplies one, instead of always being null (H4)', async () => {
  const { calls } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'lens-security': {
        verdict: 'FINDINGS',
        coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' },
        findings: [{ severity: 'High', claim: 'missing auth check', location: 'foo.js:10', evidence: 'e', consequence: 'c', fix: 'f', ac_id: 'AC-SEC-3' }],
      },
    }),
  })
  const terminalCall = calls.filter((c) => c.opts.label === 'ledger:write').pop()
  const payload = extractLedgerPayload(terminalCall.prompt)
  assert.equal(payload.open_findings[0].ac_id, 'AC-SEC-3', 'a lens-supplied ac_id must survive, not be discarded to null')
})

// HARN-OPT-2 PR2 (AC-QA-8, AC-OPS-1, AC-ARCH-9): the measured defect. See
// tdd-task.test.js for the identical pattern and its rationale -- an
// exception thrown by an agent() call inside run() previously escaped past
// the single start/terminal ledger write entirely.
test('review-cycle.js: an exception thrown by an agent() call inside run() still produces exactly one terminal ledger write, carrying the start run_id and outcome aborted, AND the original error still reaches the caller (AC-QA-8, AC-OPS-1)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: {},
        agent: baseAgent({
          'scope:diff': () => { throw new Error('agent step crashed mid-run') },
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

test('review-cycle.js: the original error still reaches the caller even when the terminal ledger write ALSO fails (AC-OPS-1: never swallowed by a failure of the terminal write itself)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: {},
        agent: baseAgent({
          'scope:diff': () => { throw new Error('body boom') },
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
