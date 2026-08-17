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
  harness_triggers_file_exists: false,
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

// Review round-2 M-3: see tdd-task.test.js for the identical guard and
// its rationale -- see the L5 byte-identity guard for why this trio is
// necessarily triplicated.
test('review-cycle.js: when the ledger:write response carries invalid_ac_ids_dropped > 0, writeLedger logs one visible line naming the run and the count (M-3)', async () => {
  const { logs } = await runWorkflow(WF, {
    args: {},
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

test('review-cycle.js: a ledger:write response with invalid_ac_ids_dropped 0 (or absent) logs NOTHING extra (M-3, not vacuous)', async () => {
  const { logs } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  assert.ok(!logs.some((l) => l.includes('invalid_ac_ids_dropped') || l.toLowerCase().includes('sanitised')), `expected no sanitisation log on the clean path, got: ${JSON.stringify(logs)}`)
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

// Review round-2, new harness-level finding: during review round 2, a lens
// wrote two TEST-FIXTURE records into the live ledger while probing
// ledger-append.mjs -- lenses are specified read-only, but the writer
// resolves the MAIN checkout via --git-common-dir (AC-DATA-1) regardless of
// which worktree invoked it, so a lens's own probe from its isolated
// worktree still lands in the operator's real ledger. ledger-append.mjs now
// honours HARNESS_LEDGER_READONLY (see its own tests); this is the other
// half -- every lens must be TOLD to set it before it probes the writer.
// This is prompt-enforced at the lens boundary, not fully mechanical: a
// lens that ignores its own instructions is not stopped by this alone.
//
// Review round-4 M2 (the coordinator's own design error, corrected): the
// FIRST wording here told a lens to `export HARNESS_LEDGER_READONLY=1` in
// one command, then invoke the writer in a SEPARATE one -- inoperative,
// because this tool runtime does not persist shell state (env vars) across
// separate tool calls, confirmed directly (`export X=1` in one Bash call,
// `printenv X` in the next, returns nothing). The export died with the
// call that made it, so the guard was NEVER actually armed by ANY lens,
// ever, regardless of how carefully it followed the instruction. Fixed to
// the SAME-COMMAND form, the one shape that does not depend on anything
// surviving between calls: `HARNESS_LEDGER_READONLY=1 node <path> ...`, one
// command line, prefix and invocation together. The prompt states WHY
// (shell state does not persist), so an agent that understands the reason
// will not "helpfully" split it back into two commands.
test('review-cycle.js: every lens\'s prompt instructs it to set HARNESS_LEDGER_READONLY on the SAME command line as the writer invocation (never a separate `export`, which cannot survive to the next tool call), before it probes ledger-append.mjs (M2)', async () => {
  const { calls } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  const lensCall = calls.find((c) => c.opts.label === 'lens-security')
  assert.ok(lensCall, 'expected a lens-security call')
  assert.match(lensCall.prompt, /HARNESS_LEDGER_READONLY/, 'the lens prompt must name the env var')
  assert.match(lensCall.prompt, /HARNESS_LEDGER_READONLY=1 node\b/, 'the lens prompt must give the concrete SAME-COMMAND form (var=value prefixed onto the invocation), never a separate export')
  assert.doesNotMatch(lensCall.prompt, /\bexport HARNESS_LEDGER_READONLY/i, 'the lens prompt must NEVER instruct a bare `export` -- it cannot survive to the next tool call in this runtime')
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

// Review round-2 L-2: see tdd-task.test.js for the identical guard and its
// rationale -- workflow scripts have no fs/child_process access, so they
// cannot resolve the checkout root the way ledger-append.mjs's stripRoot
// does. This is only the operator-visible console log; the ledger file
// itself has its own, separate, root-aware redaction.
test('review-cycle.js: the exception guard\'s log line redacts an absolute /Users or /home path embedded in the thrown error\'s message, rather than printing it verbatim (L-2)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: {},
        agent: baseAgent({
          'scope:diff': () => { throw new Error("ENOENT: no such file, open '/Users/victim/secret-project/config.js'") },
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

test('review-cycle.js: the exception guard\'s log line is bounded in length, even when the thrown error\'s message is very long (L-2)', async () => {
  const longMessage = 'x'.repeat(5000)
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: {},
        agent: baseAgent({
          'scope:diff': () => { throw new Error(longMessage) },
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

// Review round-1 M2: see tdd-task.test.js's identical guard for the
// rationale -- `if (runError) throw runError` tests truthiness, not
// whether the catch fired.
for (const falsyValue of [null, undefined, 0, '']) {
  test(`review-cycle.js: a falsy thrown value (${JSON.stringify(falsyValue)}) from an agent() call inside run() still propagates (M2, regression)`, async () => {
    await assert.rejects(
      () =>
        runWorkflow(WF, {
          args: {},
          agent: baseAgent({ 'scope:diff': () => { throw falsyValue } }),
        }),
      (err) => {
        assert.equal(err, falsyValue)
        return true
      }
    )
  })
}

// specs/custom-rules-fail-closed.md: .claude/harness-triggers.json is
// transcribed by an LLM step into custom_rules. If it fails to arrive for
// one run, the merge at :227 (Object.assign({}, DEFAULT_RULES,
// scope.custom_rules || {})) silently falls back to harness defaults with
// no error -- a review conducted with the wrong lens roster and no sign of
// it. These tests pin the fail-closed fix: a required boolean
// harness_triggers_file_exists, a contradiction check (file exists +
// custom_rules null = abort), shape validation of custom_rules before use,
// and the rule source surfaced in the log and the ledger.

// AC-SEC-1: both custom_rules and harness_triggers_file_exists are on the
// scope schema's `required` list, matching the M6 precedent above (asserting
// the declared schema object directly, not merely a fixture's behaviour).
test('review-cycle.js: the scope agent() call declares custom_rules and harness_triggers_file_exists as REQUIRED on its schema (AC-SEC-1)', async () => {
  const { calls } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  const scopeCall = calls.find((c) => c.opts.label === 'scope:diff')
  assert.ok(scopeCall, 'expected a scope:diff call')
  assert.deepEqual(
    scopeCall.opts.schema.required.slice().sort(),
    ['base', 'custom_rules', 'files', 'harness_triggers_file_exists', 'head_sha', 'new_dependency_entries', 'new_modules']
  )
  assert.deepEqual(scopeCall.opts.schema.properties.harness_triggers_file_exists.type, 'boolean')
  assert.deepEqual(scopeCall.opts.schema.properties.custom_rules.type, ['object', 'null'], 'custom_rules keeps its loose type -- shape validation happens in the workflow, not the schema')
})

// AC-SEC-1 behavioural half: a scope response genuinely OMITTING the new
// required field (not merely set to a falsy value) must be rejected by the
// runtime's own structured-output enforcement -- confirmed here via the same
// schema-validating fake-runtime stub every other schema test in this file
// relies on.
test('review-cycle.js: a scope response with harness_triggers_file_exists omitted entirely fails structured-output validation (AC-SEC-1)', async () => {
  const { harness_triggers_file_exists, ...scopeWithoutField } = SCOPE_OK
  await assert.rejects(
    () => runWorkflow(WF, { args: {}, agent: baseAgent({ 'scope:diff': scopeWithoutField }) }),
    /does not match its declared schema/
  )
})

// AC-SEC-2 / AC-QA-1: the contradiction that catches a transcription
// failure -- the override file is there (the agent saw it) and its contents
// did not arrive. Deleting this guard (i.e. going back to `scope.custom_rules
// || {}`) must fail this test.
test('review-cycle.js: aborts naming a transcription failure when harness_triggers_file_exists is true and custom_rules is null (AC-SEC-2, AC-QA-1)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: {},
        agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, harness_triggers_file_exists: true, custom_rules: null } }),
      }),
    (err) => {
      assert.match(err.message, /HarnessTriggersTranscriptionFailed/, 'the error must be named, not a generic message')
      assert.match(err.message, /custom_rules/)
      return true
    }
  )
})

// AC-OPS-3: the abort message must say what the operator should do next, not
// merely that something went wrong.
test('review-cycle.js: the transcription-failure abort message tells the operator to re-run and what a recurrence means (AC-OPS-3)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: {},
        agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, harness_triggers_file_exists: true, custom_rules: null } }),
      }),
    (err) => {
      assert.match(err.message, /re-run/i)
      assert.match(err.message, /override file is not being read/i)
      return true
    }
  )
})

// AC-QA-2: the guard must not over-trigger. Both non-failure combinations
// still work: file absent (proceeds on defaults) and file present with a
// VALID custom_rules (proceeds on the merged rules, which actually changes
// lens triggering).
test('review-cycle.js: file absent + custom_rules null proceeds on harness defaults, no abort (AC-QA-2)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, harness_triggers_file_exists: false, custom_rules: null } }),
  })
  assert.equal(result.telemetry.outcome, 'done')
})

test('review-cycle.js: file present + valid custom_rules proceeds on the merged rules, actually changing which lenses trigger (AC-QA-2)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'scope:diff': {
        ...SCOPE_OK,
        harness_triggers_file_exists: true,
        custom_rules: { ui: ['**/*.foo'] },
        files: [{ path: 'src/x.foo', status: 'M' }],
      },
      'lens-design': SECURITY_CLEAN,
      'lens-accessibility': SECURITY_CLEAN,
    }),
  })
  assert.ok(result.lenses.includes('lens-design'), 'the custom ui glob (which does not match any DEFAULT_RULES.ui pattern) must have triggered lens-design')
  assert.equal(result.telemetry.outcome, 'done')
})

// AC-SEC-3 / AC-QA-3: custom_rules is shape-validated before it reaches
// matches() / glob compilation. Per rejection class, per the semantic-test
// rule -- not just the one malformed case the code happens to check first:
// an unknown key, a non-array value, and an array containing a non-string.
test('review-cycle.js: custom_rules with an unrecognised key aborts naming the offending key (AC-SEC-3, AC-QA-3)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: {},
        agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, harness_triggers_file_exists: true, custom_rules: { bogus: ['**/*.js'] } } }),
      }),
    (err) => {
      assert.match(err.message, /HarnessTriggersShapeInvalid/)
      assert.match(err.message, /bogus/)
      return true
    }
  )
})

test('review-cycle.js: custom_rules with a non-array value aborts naming the offending key (AC-SEC-3, AC-QA-3)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: {},
        agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, harness_triggers_file_exists: true, custom_rules: { ui: 'not-an-array' } } }),
      }),
    (err) => {
      assert.match(err.message, /HarnessTriggersShapeInvalid/)
      assert.match(err.message, /"ui"/)
      return true
    }
  )
})

test('review-cycle.js: custom_rules with an array containing a non-string aborts naming the offending key (AC-SEC-3, AC-QA-3)', async () => {
  await assert.rejects(
    () =>
      runWorkflow(WF, {
        args: {},
        agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, harness_triggers_file_exists: true, custom_rules: { data: ['**/*.sql', 42] } } }),
      }),
    (err) => {
      assert.match(err.message, /HarnessTriggersShapeInvalid/)
      assert.match(err.message, /"data"/)
      return true
    }
  )
})

// The accepted shape, enumerated positively per the semantic-test rule (not
// just "doesn't throw" -- it must actually change triggering, proving the
// value was used, not merely tolerated): all four known keys, each an array
// of strings.
test('review-cycle.js: custom_rules with all four known keys, each a valid array of strings, is accepted and used (AC-SEC-3)', async () => {
  const { result } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'scope:diff': {
        ...SCOPE_OK,
        harness_triggers_file_exists: true,
        custom_rules: { ui: ['**/*.foo'], data: ['**/*.bar'], architecture: ['**/*.baz'], operability: ['**/*.qux'] },
        files: [{ path: 'scripts/x.qux', status: 'M' }],
      },
      'lens-operability': SECURITY_CLEAN,
    }),
  })
  assert.ok(result.lenses.includes('lens-operability'), 'the custom operability glob must have triggered lens-operability')
  assert.equal(result.telemetry.outcome, 'done')
})

// AC-SEC-4: custom_rules content (a glob string) must never reach a later
// agent prompt -- it is matched by regex in the sandbox only.
test('review-cycle.js: no content from custom_rules is interpolated into any later agent prompt (AC-SEC-4)', async () => {
  const marker = 'UNIQUE_MARKER_zzq93_never_in_a_prompt'
  const { calls } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'scope:diff': { ...SCOPE_OK, harness_triggers_file_exists: true, custom_rules: { ui: [`**/${marker}/**`] } },
    }),
  })
  for (const call of calls) {
    assert.ok(!call.prompt.includes(marker), `custom_rules content leaked into the prompt for label "${call.opts.label}"`)
  }
})

// AC-OPS-1 / AC-QA-4: the log line states which rule source was used and,
// when repo-tuned, the count of overridden keys -- asserting only that SOME
// log line exists would pass with the source omitted.
test('review-cycle.js: the log states the rule source is repo-tuned with the count of overridden keys (AC-OPS-1, AC-QA-4)', async () => {
  const { logs } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({
      'scope:diff': { ...SCOPE_OK, harness_triggers_file_exists: true, custom_rules: { ui: ['**/*.foo'], data: ['**/*.bar'] } },
    }),
  })
  const line = logs.find((l) => l.includes('Rule source'))
  assert.ok(line, `expected a log line naming the rule source, got ${JSON.stringify(logs)}`)
  assert.match(line, /repo-tuned/)
  assert.match(line, /2/, 'must report the count of overridden keys (2: ui, data)')
})

test('review-cycle.js: the log states the rule source is harness defaults when no override is in force (AC-OPS-1, AC-QA-4)', async () => {
  const { logs } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  const line = logs.find((l) => l.includes('Rule source'))
  assert.ok(line, `expected a log line naming the rule source, got ${JSON.stringify(logs)}`)
  assert.match(line, /harness defaults/)
})

// AC-OPS-2: the rule source is recorded in the run ledger, both in the
// workflow's own telemetry and in the terminal payload sent to
// ledger-append.mjs.
test('review-cycle.js: telemetry.rule_source and rule_source_overridden_keys are repo-tuned/1 and reach the ledger payload (AC-OPS-2)', async () => {
  const { result, calls } = await runWorkflow(WF, {
    args: {},
    agent: baseAgent({ 'scope:diff': { ...SCOPE_OK, harness_triggers_file_exists: true, custom_rules: { ui: ['**/*.foo'] } } }),
  })
  assert.equal(result.telemetry.rule_source, 'repo-tuned')
  assert.equal(result.telemetry.rule_source_overridden_keys, 1)
  const terminalCall = calls.filter((c) => c.opts.label === 'ledger:write').pop()
  const payload = extractLedgerPayload(terminalCall.prompt)
  assert.equal(payload.rule_source, 'repo-tuned')
  assert.equal(payload.rule_source_overridden_keys, 1)
})

test('review-cycle.js: telemetry.rule_source is "harness defaults" with a null overridden-key count when no override applies (AC-OPS-2)', async () => {
  const { result } = await runWorkflow(WF, { args: {}, agent: baseAgent() })
  assert.equal(result.telemetry.rule_source, 'harness defaults')
  assert.equal(result.telemetry.rule_source_overridden_keys, null)
})
