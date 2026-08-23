// H3: seam contract tests. Nothing previously crossed the boundary between
// what a workflow actually emits and what workflows/lib/ledger-append.mjs
// actually accepts -- workflow tests only checked that a ledger:write agent
// call happened and inspected the prompt string; ledger-append tests only
// ever built hand-written payloads that happened to already be valid. That
// is exactly the gap that let C1 (array-of-string validation rejecting
// lenses_run/lenses_skipped) and H2 (absolute paths reaching the ledger)
// ship green.
//
// Each test here captures the REAL terminal payload a workflow's own code
// builds (by running it through the fake runtime and extracting the JSON
// the ledger-write prompt actually embeds -- see helpers/extract-ledger-payload.js,
// which stays valid across the H1 fix's raw-JSON -> base64 change), and
// pipes that exact payload into a real ledger-append.mjs run against a real
// temp git repo. This is the test class the finding calls out as required
// to fail before the C1 fix and pass after: that ordering is the RED proof.
const test = require('node:test')
const assert = require('node:assert/strict')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')
const { makeTempRepo, runAppend, readLedgerLines, cleanupTempRepos } = require('./helpers/temp-repo.js')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const OPTIMISE_READ_PATH = path.join(__dirname, '..', 'workflows', 'lib', 'optimise-read.mjs')

test.after(cleanupTempRepos)

const LEDGER_OK = { run_id: 'r1', ts: '2026-08-10T00:00:00.000Z', write_ok: true, write_error: null }

// Extracts the TERMINAL ledger:write payload (the one after the outcome is
// known), distinguishing it from the start-record write by outcome !==
// 'started': see the start/terminal protocol (AC-DATA-5) in each workflow.
function terminalPayload(calls) {
  const ledgerCalls = calls.filter((c) => c.opts.label === 'ledger:write')
  assert.ok(ledgerCalls.length >= 2, `expected a start write and a terminal write, got ${ledgerCalls.length}`)
  for (const call of ledgerCalls) {
    const payload = extractLedgerPayload(call.prompt)
    if (payload.outcome !== 'started') return payload
  }
  throw new Error('no non-started ledger:write payload found')
}

function pipeAndAssertWritten(payload, label) {
  const repo = makeTempRepo()
  const res = runAppend(repo, payload)
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `${label}: ledger-append.mjs refused the real payload this workflow emits: ${out.write_error}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, `${label}: expected exactly one line written`)
  return JSON.parse(lines[0])
}

test('seam: tdd_task terminal payload, captured from a real DONE run, is accepted by ledger-append.mjs', async () => {
  const WF = path.join(__dirname, '..', 'workflows', 'tdd-task.js')
  const { calls } = await runWorkflow(WF, {
    args: { task: 'do the thing', spec: 'specs/foo.md' },
    agent: {
      'write-test#1': { test_files: ['a.test.js'], test_command: 'node a.test.js', expected_failure: 'missing fn' },
      'verify-red#1': { red: true, right_reason: true, evidence: 'threw', test_hashes: [{ file: 'a.test.js', sha256: 'abc' }] },
      'implement#1': { summary: 'added fn', files_changed: ['a.js'] },
      'verify-green#1': { green: true, suite_green: true, hashes_match: true, evidence: 'passed' },
      commit: { sha: 'deadbeef', message: 'feat: thing' },
      'ledger:write': LEDGER_OK,
    },
  })
  const payload = terminalPayload(calls)
  const entry = pipeAndAssertWritten(payload, 'tdd_task')
  assert.equal(entry.kind, 'tdd_task')
  assert.equal(entry.outcome, 'done')
  assert.equal(entry.task, 'do the thing')
  assert.equal(entry.spec, 'specs/foo.md')
})

test('seam: review_cycle terminal payload, captured from a real run with a non-empty lenses_run, is accepted by ledger-append.mjs (this is the C1 regression test: lenses_run is a non-empty array of strings)', async () => {
  const WF = path.join(__dirname, '..', 'workflows', 'review-cycle.js')
  const { calls } = await runWorkflow(WF, {
    args: {},
    agent: {
      'scope:diff': {
        base: 'main',
        head_sha: 'abcdef1234567890',
        files: [{ path: 'src/foo.js', status: 'M' }],
        new_dependency_entries: false,
        new_modules: false,
        custom_rules: null,
        harness_triggers_file_exists: false,
        consistency: { ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9, doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null },
      },
      'lens-security': { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [] },
      'lens-qa': { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [] },
      synthesis: {
        report: '### VERDICT\nCLEAN',
        spec_bugs: [{ lens: 'lens-qa', location: 'foo.js:1', claim: 'no AC covers this' }],
        rejected_findings: [],
      },
      'ledger:write': LEDGER_OK,
    },
  })
  const payload = terminalPayload(calls)
  assert.ok(Array.isArray(payload.lenses_run) && payload.lenses_run.length > 0, 'sanity: this fixture must produce a non-empty lenses_run')
  const entry = pipeAndAssertWritten(payload, 'review_cycle')
  assert.equal(entry.kind, 'review_cycle')
  assert.deepEqual(entry.lenses_run, ['lens-security', 'lens-qa'])
  assert.equal(entry.spec_bug_count, 1)
})

test('seam: plan_cycle terminal payload, captured from a real run with a non-empty lenses_run, is accepted by ledger-append.mjs (C1 regression test)', async () => {
  const WF = path.join(__dirname, '..', 'workflows', 'plan-cycle.js')
  const LENS_CLEAN = { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, acceptance_criteria: [{ id: 'AC-SEC-1', statement: 'x' }] }
  const { calls } = await runWorkflow(WF, {
    args: { spec: 'specs/foo.md' },
    agent: {
      'scope:spec': { head_sha: 'abc1234567890def', summary: 'adds a widget', ui: false, data: false, architecture: false, operability: false, user_facing: true, likely_paths: ['src/widget.js'], consistency: { ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9, doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null } },
      'lens-security': LENS_CLEAN,
      'lens-qa': LENS_CLEAN,
      'lens-simplicity': { ...LENS_CLEAN, acceptance_criteria: [] },
      'lens-product': LENS_CLEAN,
      'synthesis:write-back': { summary: '### Summary\n4 criteria', head_sha_at_synthesis: 'abc1234567890def' },
      'ledger:write': LEDGER_OK,
    },
  })
  const payload = terminalPayload(calls)
  assert.ok(Array.isArray(payload.lenses_run) && payload.lenses_run.length > 0, 'sanity: this fixture must produce a non-empty lenses_run')
  const entry = pipeAndAssertWritten(payload, 'plan_cycle')
  assert.equal(entry.kind, 'plan_cycle')
  assert.deepEqual(entry.lenses_run, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'])
})

// HARN-OPT-2 PR2 (AC-QA-10): the full seam, both halves at once. The tests
// above each capture ONE payload (already known to be well-formed) and pipe
// it into a fresh, empty temp repo. This test instead runs the REAL
// ledger-write agent step's own logic end to end: both the start AND the
// terminal ledger:write calls are routed through the REAL
// ledger-append.mjs (not a scripted response), so the run_id in the file is
// the one ledger-append.mjs itself generated (never invented by the test),
// fed back to the terminal write exactly the way a real ledger:write agent
// step would report it. This is the one test in the suite that proves the
// whole pairing mechanism -- write, read-back run_id, pair, aggregate --
// works end to end, not just that each half in isolation accepts a
// hand-built payload.
test('seam: a real tdd_task run\'s start AND terminal payloads, BOTH piped through the real ledger-append.mjs (the run_id it itself generates, fed back exactly as a real ledger:write agent step would), produce exactly two lines sharing one run_id and one plan key, and aggregateWallClock reports agentComputeMeasuredRuns=1, agentComputeUnmeasuredRuns=0 (AC-QA-10)', async () => {
  const repo = makeTempRepo()
  const WF = path.join(__dirname, '..', 'workflows', 'tdd-task.js')
  // Stands in for the real ledger:write agent step (see tdd-task.js's own
  // ledgerWritePrompt): decode the base64 payload the workflow embedded,
  // pipe it into the REAL ledger-append.mjs, and hand back exactly what
  // the script printed -- run_id included -- so the workflow's own logic
  // (which extracts startRunId from this response and requests its reuse
  // on the terminal write) is exercised for real, not simulated.
  const realLedgerWriteAgent = (prompt) => {
    const payload = extractLedgerPayload(prompt)
    const res = runAppend(repo, payload)
    const lastLine = res.stdout.trim().split('\n').pop()
    return JSON.parse(lastLine)
  }
  const { calls } = await runWorkflow(WF, {
    args: { task: 'seam proof', spec: 'specs/seam.md' },
    agent: {
      'write-test#1': { test_files: ['a.test.js'], test_command: 'node a.test.js', expected_failure: 'missing fn' },
      'verify-red#1': { red: true, right_reason: true, evidence: 'threw', test_hashes: [{ file: 'a.test.js', sha256: 'abc' }] },
      'implement#1': { summary: 'added fn', files_changed: ['a.js'] },
      'verify-green#1': { green: true, suite_green: true, hashes_match: true, evidence: 'passed' },
      commit: { sha: 'deadbeef', message: 'feat: thing' },
      'ledger:write': realLedgerWriteAgent,
    },
  })
  assert.equal(calls.filter((c) => c.opts.label === 'ledger:write').length, 2, 'expected exactly one start write + one terminal write')

  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 2, `expected exactly two lines in the real ledger file, got ${lines.length}`)
  const [start, terminal] = lines.map((l) => JSON.parse(l))
  assert.equal(start.outcome, 'started')
  assert.notEqual(terminal.outcome, 'started')
  assert.ok(start.run_id, 'the start line must carry a run_id ledger-append.mjs itself generated')
  assert.equal(start.run_id, terminal.run_id, 'both lines must share the SAME run_id -- the terminal write requested reuse of the real generated one')
  assert.equal(start.plan_key, terminal.plan_key, 'both lines must carry an identical canonical plan key')

  const { aggregateWallClock } = await import(pathToFileURL(OPTIMISE_READ_PATH).href)
  const result = aggregateWallClock([start, terminal])
  assert.equal(result.totals.agentComputeMeasuredRuns, 1, 'the real pair must be measured')
  assert.equal(result.totals.agentComputeUnmeasuredRuns, 0, 'a genuine, real-generated-run_id pair must never be counted as unmeasured')
})

// Review round-1 L5: the three AC-QA-8 tests in tdd-task.test.js/
// review-cycle.test.js/plan-cycle.test.js script the ledger:write response,
// so the payload the exception-guard's THROW path builds was never
// actually validated by the real ledger-append.mjs -- only checked by
// hand, off-suite. If a future field were added to the terminal telemetry
// that the schema rejects on the abort path only, every test would stay
// green and the terminal record would be silently lost in production: the
// same class of gap this PR exists to close. Extends the AC-QA-10 seam
// pattern to the throw path specifically, for all three workflows.
function throwPathPayloads(err) {
  const ledgerCalls = err.calls.filter((c) => c.opts.label === 'ledger:write')
  assert.equal(ledgerCalls.length, 2, `expected a start write and a terminal write on the throw path, got ${ledgerCalls.length}`)
  const start = extractLedgerPayload(ledgerCalls[0].prompt)
  const terminal = extractLedgerPayload(ledgerCalls[1].prompt)
  assert.ok(!('run_id' in start))
  return { start, terminal }
}

function pipeThrowPathAndAssert(err, label) {
  const { start, terminal } = throwPathPayloads(err)
  const repo = makeTempRepo()
  const startRes = runAppend(repo, start)
  const startOut = JSON.parse(startRes.stdout.trim().split('\n').pop())
  assert.equal(startOut.write_ok, true, `${label}: real writer refused the throw path's START payload: ${startOut.write_error}`)
  // The terminal payload requests reuse of the run_id the REAL writer just
  // generated for the start write, exactly as production would feed it back.
  const terminalWithRealRunId = { ...terminal, run_id: startOut.run_id }
  const terminalRes = runAppend(repo, terminalWithRealRunId)
  const terminalOut = JSON.parse(terminalRes.stdout.trim().split('\n').pop())
  assert.equal(terminalOut.write_ok, true, `${label}: real writer refused the throw path's TERMINAL payload: ${terminalOut.write_error}`)
  const lines = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].run_id, lines[1].run_id, 'both lines must share the real generated run_id')
  assert.equal(lines[0].outcome, 'started')
  assert.equal(lines[1].outcome, 'aborted', 'the throw path\'s terminal outcome must be aborted, real writer agreeing (AC-QA-12)')
}

test('seam: tdd_task\'s THROW-path start AND terminal payloads (built by the try/catch exception guard, never by a normal return) are BOTH accepted by the real ledger-append.mjs, producing two lines sharing one run_id with terminal outcome aborted (L5, AC-QA-10/AC-QA-8)', async () => {
  const WF = path.join(__dirname, '..', 'workflows', 'tdd-task.js')
  let caught
  try {
    await runWorkflow(WF, {
      args: { task: 'seam throw proof', spec: 'specs/seam-throw.md' },
      agent: { 'write-test#1': () => { throw new Error('seam throw proof') }, 'ledger:write': LEDGER_OK },
    })
  } catch (e) {
    caught = e
  }
  assert.ok(caught, 'expected the workflow to throw')
  pipeThrowPathAndAssert(caught, 'tdd_task')
})

test('seam: review_cycle\'s THROW-path start AND terminal payloads are BOTH accepted by the real ledger-append.mjs, producing two lines sharing one run_id with terminal outcome aborted (L5, AC-QA-10/AC-QA-8)', async () => {
  const WF = path.join(__dirname, '..', 'workflows', 'review-cycle.js')
  let caught
  try {
    await runWorkflow(WF, {
      args: {},
      agent: { 'scope:diff': () => { throw new Error('seam throw proof') }, 'ledger:write': LEDGER_OK },
    })
  } catch (e) {
    caught = e
  }
  assert.ok(caught, 'expected the workflow to throw')
  pipeThrowPathAndAssert(caught, 'review_cycle')
})

test('seam: plan_cycle\'s THROW-path start AND terminal payloads are BOTH accepted by the real ledger-append.mjs, producing two lines sharing one run_id with terminal outcome aborted (L5, AC-QA-10/AC-QA-8)', async () => {
  const WF = path.join(__dirname, '..', 'workflows', 'plan-cycle.js')
  let caught
  try {
    await runWorkflow(WF, {
      args: { spec: 'specs/seam-throw.md' },
      agent: { 'scope:spec': () => { throw new Error('seam throw proof') }, 'ledger:write': LEDGER_OK },
    })
  } catch (e) {
    caught = e
  }
  assert.ok(caught, 'expected the workflow to throw')
  pipeThrowPathAndAssert(caught, 'plan_cycle')
})

// Review round-2 L-1: the three throw-path tests above only prove the throw
// at the FIRST agent step (before any lens ever ran), where lenses_run being
// empty is honest -- nothing ran yet. A throw at the LAST agent step
// (synthesis), AFTER every lens already reported back, is a different case:
// the lenses genuinely ran, but `result.lenses` (read from run()'s return
// value) is still undefined on the throw path, since run() never reaches its
// `return`. If lenses_run silently reports [] here too, an operator reading
// the ledger sees "no lenses ran" for a round that actually dispatched and
// received five lens reports before synthesis crashed -- the same
// computed-but-not-surfaced defect class as H-1/M-3, one field over.
test('seam: review_cycle\'s THROW-path terminal payload, when the throw happens at the LAST agent step (synthesis) AFTER every lens already reported, still carries the real lenses_run -- not [] (L-1)', async () => {
  const WF = path.join(__dirname, '..', 'workflows', 'review-cycle.js')
  let caught
  try {
    await runWorkflow(WF, {
      args: {},
      agent: {
        'scope:diff': {
          base: 'main',
          head_sha: 'abcdef1234567890',
          files: [{ path: 'src/foo.js', status: 'M' }],
          new_dependency_entries: false,
          new_modules: false,
          custom_rules: null,
          harness_triggers_file_exists: false,
          consistency: { ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9, doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null },
        },
        'lens-security': { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [] },
        'lens-qa': { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [] },
        synthesis: () => { throw new Error('synthesis crashed after every lens reported') },
        'ledger:write': LEDGER_OK,
      },
    })
  } catch (e) {
    caught = e
  }
  assert.ok(caught, 'expected the workflow to throw')
  const { terminal } = throwPathPayloads(caught)
  assert.deepEqual(terminal.lenses_run, ['lens-security', 'lens-qa'], 'lenses_run must reflect the lenses that actually reported, not an empty array, even though run() never returned')
  pipeThrowPathAndAssert(caught, 'review_cycle (throw at last step)')
})

test('seam: plan_cycle\'s THROW-path terminal payload, when the throw happens at the LAST agent step (synthesis:write-back) AFTER every lens already reported, still carries the real lenses_run -- not [] (L-1)', async () => {
  const WF = path.join(__dirname, '..', 'workflows', 'plan-cycle.js')
  const LENS_CLEAN = { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, acceptance_criteria: [{ id: 'AC-SEC-1', statement: 'x' }] }
  let caught
  try {
    await runWorkflow(WF, {
      args: { spec: 'specs/seam-throw.md' },
      agent: {
        'scope:spec': { head_sha: 'abc1234567890def', summary: 'adds a widget', ui: false, data: false, architecture: false, operability: false, user_facing: true, likely_paths: ['src/widget.js'], consistency: { ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9, doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null } },
        'lens-security': LENS_CLEAN,
        'lens-qa': LENS_CLEAN,
        'lens-simplicity': { ...LENS_CLEAN, acceptance_criteria: [] },
        'lens-product': LENS_CLEAN,
        'synthesis:write-back': () => { throw new Error('synthesis crashed after every lens reported') },
        'ledger:write': LEDGER_OK,
      },
    })
  } catch (e) {
    caught = e
  }
  assert.ok(caught, 'expected the workflow to throw')
  const { terminal } = throwPathPayloads(caught)
  assert.deepEqual(terminal.lenses_run, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'], 'lenses_run must reflect the lenses that actually reported, not an empty array, even though run() never returned')
  pipeThrowPathAndAssert(caught, 'plan_cycle (throw at last step)')
})

test('seam: conduct_plan_event payload, built exactly per skills/conduct-plan/SKILL.md\'s documented shape, is accepted by ledger-append.mjs', () => {
  // conduct-plan is a prose skill with no fake-runtime harness to drive it
  // (nothing sandboxes a live conducting agent); this hand-builds the
  // payload the SKILL.md text documents verbatim and proves the CONSUMER
  // side of that contract, which is the half a test can reach.
  const payload = {
    kind: 'conduct_plan_event',
    outcome: 'started',
    event: 'ci_wait_started',
    event_key: 'specs/optimise-cycle.md:T1:ci_wait_started:1',
  }
  const repo = makeTempRepo()
  const res = runAppend(repo, payload)
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `conduct_plan_event: ${out.write_error}`)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.kind, 'conduct_plan_event')
  assert.equal(entry.event, 'ci_wait_started')
  assert.equal(entry.event_key, 'specs/optimise-cycle.md:T1:ci_wait_started:1')
})
