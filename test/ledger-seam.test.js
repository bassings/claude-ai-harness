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
      'scope:spec': { summary: 'adds a widget', ui: false, data: false, architecture: false, operability: false, user_facing: true, likely_paths: ['src/widget.js'] },
      'lens-security': LENS_CLEAN,
      'lens-qa': LENS_CLEAN,
      'lens-simplicity': { ...LENS_CLEAN, acceptance_criteria: [] },
      'lens-product': LENS_CLEAN,
      'synthesis:write-back': '### Summary\n4 criteria',
      'ledger:write': LEDGER_OK,
    },
  })
  const payload = terminalPayload(calls)
  assert.ok(Array.isArray(payload.lenses_run) && payload.lenses_run.length > 0, 'sanity: this fixture must produce a non-empty lenses_run')
  const entry = pipeAndAssertWritten(payload, 'plan_cycle')
  assert.equal(entry.kind, 'plan_cycle')
  assert.deepEqual(entry.lenses_run, ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product'])
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
