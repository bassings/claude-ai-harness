// HARN-OPT-4 T8 (specs/harn-opt-4.md): budget_spent becomes a per-run delta
// (end minus start) in all three workflows, SCHEMA_VERSION goes 4 to 5, and
// review-cycle and plan-cycle retry a refused terminal write once without the
// refused key (T4 round 3 L1, the AC-DATA-2 shape T5 settled in tdd-task).
// Written RED first. Pins AC-QA-27 (precondition, recorded in the Conductor
// log at tick 33: the counter is session-cumulative), AC-QA-28, AC-DATA-17,
// AC-OPS-3, AC-DATA-19, AC-SIMP-8, AC-SIMP-9, AC-SIMP-11.
// Never point these at the real ledger: every write goes to a makeTempRepo().
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')
const { assertAppendPreservesPrefix } = require('./helpers/ledger-prefix.js')
const { makeTempRepo, readLedgerLines, cleanupTempRepos, LEDGER_REL } = require('./helpers/temp-repo.js')

const ROOT = path.join(__dirname, '..')
const WF_DIR = path.join(ROOT, 'workflows')
const MODULE_PATH = path.join(WF_DIR, 'lib', 'optimise-read.mjs')
const APPEND_URL = pathToFileURL(path.join(WF_DIR, 'lib', 'ledger-append.mjs')).href

test.after(cleanupTempRepos)

// ---- per-workflow fake-runtime drivers (fixtures copied from the exemplars) ----

const LEDGER_OK = { run_id: 'r1', ts: '2026-10-11T00:00:00.000Z', write_ok: true, write_error: null }
const SHA = 'abcdef1234567890'
const TREE = '1111111111111111111111111111111111111111'
const CLEAN = { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [], head_sha_measured: SHA, head_tree_measured: TREE }
const REVIEW_SCOPE = {
  base: 'main', head_sha: SHA, head_tree: TREE,
  files: [{ path: 'src/foo.js', status: 'M' }],
  new_dependency_entries: false, new_modules: false, custom_rules: null, harness_triggers_file_exists: false,
  consistency: {
    ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9,
    doc_fields: ['recurrence'], agent_fields: ['recurrence'],
    missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null,
  },
}
const LENS_CLEAN = { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, acceptance_criteria: [{ id: 'AC-SEC-1', statement: 'x' }] }
const WRITE_TEST = { test_files: ['a.test.js'], test_command: 'node a.test.js', expected_failure: 'missing fn' }

const DRIVERS = {
  'tdd-task': {
    file: path.join(WF_DIR, 'tdd-task.js'),
    args: { task: 'do the thing' },
    agents: (ledger) => ({
      'write-test#1': WRITE_TEST,
      'verify-red#1': { red: true, right_reason: true, evidence: 'threw', test_hashes: [{ file: 'a.test.js', sha256: 'abc' }] },
      'implement#1': { summary: 'added fn', files_changed: ['a.js'] },
      'verify-green#1': { green: true, suite_green: true, hashes_match: true, evidence: 'passed' },
      commit: { sha: 'deadbeef', message: 'feat: thing' },
      'ledger:write': ledger,
    }),
  },
  'review-cycle': {
    file: path.join(WF_DIR, 'review-cycle.js'),
    args: {},
    agents: (ledger) => ({
      'scope:diff': REVIEW_SCOPE,
      'lens-security': CLEAN, 'lens-qa': CLEAN, 'lens-design': CLEAN, 'lens-accessibility': CLEAN, 'lens-product': CLEAN,
      'lens-architecture': CLEAN, 'lens-data': CLEAN, 'lens-operability': CLEAN, 'reviewer-verification': CLEAN,
      synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [] },
      'ledger:write': ledger,
    }),
  },
  'plan-cycle': {
    file: path.join(WF_DIR, 'plan-cycle.js'),
    args: { spec: 'specs/foo.md' },
    agents: (ledger) => ({
      'scope:spec': {
        head_sha: 'abc1234567890def', summary: 'adds a widget', ui: false, data: false, architecture: false,
        operability: false, user_facing: true, likely_paths: ['src/widget.js'], consistency: REVIEW_SCOPE.consistency,
      },
      'lens-security': LENS_CLEAN, 'lens-qa': LENS_CLEAN, 'lens-simplicity': { ...LENS_CLEAN, acceptance_criteria: [] }, 'lens-product': LENS_CLEAN,
      'synthesis:write-back': { summary: '### Summary\n4 criteria', head_sha_at_synthesis: 'abc1234567890def' },
      'ledger:write': ledger,
    }),
  },
}

// Runs one workflow with the given budget stub. `onWrite(payload)` observes
// every ledger write as it happens, so a test can say what had been read BY
// THE TIME the started row was written.
async function drive(name, { budget, ledger = () => LEDGER_OK, args = {} } = {}) {
  const d = DRIVERS[name]
  const { result, calls, logs } = await runWorkflow(d.file, { args: { ...d.args, ...args }, agent: d.agents(ledger), budget })
  const writes = calls.filter((c) => c.opts.label === 'ledger:write').map((c) => extractLedgerPayload(c.prompt))
  return { result, logs, writes, started: writes[0], terminal: writes[writes.length - 1] }
}

// A STATEFUL stub: returns the scripted values in order, then repeats the last.
// A throwing step is a function. A constant stub proves nothing (it gives 0
// whether or not a delta is computed), so none is used for the delta tests.
function seqBudget(...steps) {
  const state = { reads: 0 }
  return {
    state,
    spent() {
      const step = steps[Math.min(state.reads, steps.length - 1)]
      state.reads += 1
      if (typeof step === 'function') return step()
      return step
    },
  }
}
const boom = () => { throw new Error('budget unavailable') }

for (const name of Object.keys(DRIVERS)) {
  test(`T8 ${name} (AC-QA-28): a stateful stub reading 1000 then 1250 puts budget_spent 250 on the terminal line`, async () => {
    const budget = seqBudget(1000, 1250)
    const { terminal, result } = await drive(name, { budget })
    assert.strictEqual(terminal.budget_spent, 250)
    assert.strictEqual(result.telemetry.budget_spent, 250)
  })

  test(`T8 ${name} (AC-QA-28): budget.spent() is read once BEFORE the started write and once for the terminal write, never more`, async () => {
    let readsAtStartedWrite = null
    const budget = seqBudget(1000, 1250)
    const ledger = (prompt) => {
      if (readsAtStartedWrite === null) readsAtStartedWrite = budget.state.reads
      return LEDGER_OK
    }
    await drive(name, { budget, ledger })
    assert.strictEqual(readsAtStartedWrite, 1, 'the start reading must be taken before the first ledger write')
    assert.strictEqual(budget.state.reads, 2, 'exactly one start read and one terminal read')
  })

  test(`T8 ${name} (AC-QA-28): the started row does not carry a budget_spent delta`, async () => {
    const { started } = await drive(name, { budget: seqBudget(1000, 1250) })
    assert.ok(!('budget_spent' in started) || started.budget_spent === null, `started row: ${JSON.stringify(started)}`)
  })

  test(`T8 ${name} (AC-QA-28): no budget object gives budget_spent null`, async () => {
    const { terminal } = await drive(name, { budget: undefined })
    assert.strictEqual(terminal.budget_spent, null)
  })

  test(`T8 ${name} (AC-QA-28): a start read that is null gives null, never the end reading`, async () => {
    const { terminal } = await drive(name, { budget: seqBudget(null, 1250) })
    assert.strictEqual(terminal.budget_spent, null)
  })

  test(`T8 ${name} (AC-QA-28): a start read that throws gives null, never the end reading, and the run still completes`, async () => {
    const { terminal, result } = await drive(name, { budget: seqBudget(boom, 1250) })
    assert.strictEqual(terminal.budget_spent, null)
    assert.ok(result.telemetry, 'a throwing counter must not fail the run it measures')
  })

  test(`T8 ${name} (AC-DATA-17): a counter reset mid-run (start 2650000, end 1430000) gives null, never a negative number`, async () => {
    const { terminal } = await drive(name, { budget: seqBudget(2650000, 1430000) })
    assert.strictEqual(terminal.budget_spent, null)
  })

  test(`T8 ${name} (AC-DATA-17): an end reading that is missing or not finite gives null`, async () => {
    for (const end of [null, NaN, Infinity, boom]) {
      const { terminal } = await drive(name, { budget: seqBudget(1000, end) })
      assert.strictEqual(terminal.budget_spent, null, `end ${String(end)}`)
    }
  })

  test(`T8 ${name} (AC-DATA-17): end equal to start is a real zero, not null`, async () => {
    const { terminal } = await drive(name, { budget: seqBudget(1000, 1000) })
    assert.strictEqual(terminal.budget_spent, 0)
  })
}

// ---- (4) T4 round 3 L1: retry a refused terminal write once without the refused key ----

// A writer that predates `key`: it refuses a TERMINAL payload carrying it and
// records what it accepted. Refusing only terminal rows keeps the started row
// out of the picture, so the test is about the terminal retry alone.
function staleWriter(key, accepted, { alwaysRefuseTerminal = false, error = `record rejected: ${key}: not an allowed property` } = {}) {
  let n = 0
  return (prompt) => {
    const p = extractLedgerPayload(prompt)
    n += 1
    const terminal = p.outcome !== 'started'
    if (terminal && (key in p || alwaysRefuseTerminal)) return { run_id: `w${n}`, ts: 't', write_ok: false, write_error: error }
    accepted.push(p)
    return { run_id: `w${n}`, ts: 't', write_ok: true, write_error: null }
  }
}

// review-cycle: `round` is the one new key T4 added. plan-cycle added no key,
// so its retry is exercised with a synthetic refusal of a key it does send.
const RETRY_CASES = [
  { name: 'review-cycle', key: 'round', args: { round: 2 } },
  { name: 'plan-cycle', key: 'lenses_skipped', args: {} },
]
for (const { name, key, args } of RETRY_CASES) {
  test(`T8 ${name} (L1, AC-DATA-2): a terminal write refused for "${key}" is retried ONCE without it, the row lands, and the retry is logged`, async () => {
    const accepted = []
    const { writes, logs, result } = await drive(name, { args, ledger: staleWriter(key, accepted), budget: seqBudget(1000, 1250) })
    const terminals = writes.filter((w) => w.outcome !== 'started')
    assert.equal(terminals.length, 2, 'one refused attempt plus exactly one retry')
    assert.ok(key in terminals[0])
    assert.ok(!(key in terminals[1]), 'the retry must drop the refused key')
    const { [key]: _dropped, ...firstWithoutKey } = terminals[0]
    assert.deepEqual(terminals[1], firstWithoutKey, 'the retry must be otherwise identical (same run_id, outcome, budget_spent)')
    const landed = accepted.filter((p) => p.outcome !== 'started')
    assert.equal(landed.length, 1)
    assert.equal(landed[0].outcome, 'done', 'the real outcome is written, never a fabricated one')
    assert.ok(!result.ledger_write_failed, 'the retry succeeded, so no write failure is reported')
    assert.ok(logs.some((l) => l.includes(key) && /retr/i.test(l)), `the retry must be logged, logs: ${JSON.stringify(logs)}`)
  })

  test(`T8 ${name} (L1): never a second retry; a writer that refuses even the retry leaves exactly two terminal attempts and reports the failure`, async () => {
    const accepted = []
    const { writes, result } = await drive(name, { args, ledger: staleWriter(key, accepted, { alwaysRefuseTerminal: true }) })
    assert.equal(writes.filter((w) => w.outcome !== 'started').length, 2)
    assert.equal(accepted.filter((p) => p.outcome !== 'started').length, 0)
    assert.equal(result.ledger_write_failed, true)
  })

  test(`T8 ${name} (L1): a refusal that is not "not an allowed property" is final, with no retry`, async () => {
    const accepted = []
    const { writes } = await drive(name, { args, ledger: staleWriter(key, accepted, { alwaysRefuseTerminal: true, error: `record rejected: ${key}: must be integer` }) })
    assert.equal(writes.filter((w) => w.outcome !== 'started').length, 1)
  })

  test(`T8 ${name} (L1): when nothing is refused there is exactly one terminal write and no retry log`, async () => {
    const { writes, logs } = await drive(name, { args })
    assert.equal(writes.filter((w) => w.outcome !== 'started').length, 1)
    assert.ok(!logs.some((l) => /retrying once/i.test(l)))
  })
}

// ---- Round 1 L1 (spec bug): the three safety conditions on the generic retry ----
// The retry above is guarded by a protected-key list, an own-property check and
// an anchored regex. Before this round nothing failed when any of the three was
// removed. Each case below is the one input that only that condition stops, and
// is proven by mutation (see the T8 fix round 1 report).
const SAFETY_CASES = [
  // `entryKey` is a key the terminal entry really carries, so only the regex
  // anchor (not the hasOwn check) stands between the nested path and a retry.
  { name: 'review-cycle', args: { round: 2 }, nested: 'ac_verdicts[0].round', entryKey: 'round' },
  { name: 'plan-cycle', args: {}, nested: 'verdicts[0].lenses_run', entryKey: 'lenses_run' },
]
for (const { name, args, nested, entryKey } of SAFETY_CASES) {
  const terminalsOf = (writes) => writes.filter((w) => w.outcome !== 'started')

  // Round 2 Low: the protected list has three entries and only run_id had a
  // case, so trimming kind or outcome from the list left every test green.
  // One case per protected key, so each entry is load-bearing on its own.
  for (const protectedKey of ['kind', 'outcome', 'run_id']) {
    test(`T8 ${name} (round 1 L1, round 2 Low): a refusal naming ${protectedKey} is never retried without it; exactly one terminal write, and it keeps ${protectedKey}`, async () => {
      const accepted = []
      const { writes } = await drive(name, { args, ledger: staleWriter(protectedKey, accepted, { alwaysRefuseTerminal: true, error: `record rejected: ${protectedKey}: not an allowed property` }) })
      const terminals = terminalsOf(writes)
      assert.equal(terminals.length, 1, `dropping ${protectedKey} would land a row the writer must refuse, or orphan it from its started row`)
      assert.ok(typeof terminals[0][protectedKey] === 'string' && terminals[0][protectedKey].length > 0, `terminal: ${JSON.stringify(terminals[0])}`)
    })
  }

  test(`T8 ${name} (round 1 L1): a refusal naming a key the entry does not carry does not retry`, async () => {
    const accepted = []
    const { writes } = await drive(name, { args, ledger: staleWriter('nonexistent_key', accepted, { alwaysRefuseTerminal: true, error: 'record rejected: nonexistent_key: not an allowed property' }) })
    assert.equal(terminalsOf(writes).length, 1, 'a key the entry never had cannot be what the writer refused')
  })

  test(`T8 ${name} (round 1 L1): a nested refusal "${nested}: not an allowed property" does not retry, and the top-level "${entryKey}" is kept`, async () => {
    const accepted = []
    const { writes } = await drive(name, { args, ledger: staleWriter('unused', accepted, { alwaysRefuseTerminal: true, error: `record rejected: ${nested}: not an allowed property` }) })
    const terminals = terminalsOf(writes)
    assert.equal(terminals.length, 1, 'a refused nested property is not the top-level key of the same name')
    assert.ok(entryKey in terminals[0], `the top-level ${entryKey} must survive`)
  })
}

// ---- (2) SCHEMA_VERSION 5 and the readers (AC-OPS-3, AC-DATA-17) ----

test('T8 AC-OPS-3: SCHEMA_VERSION is 6 (T8 took it to 5; HARN-OPT-5 T1 to 6), and ledger-append.mjs says why (budget_spent is now a per-run delta)', async () => {
  const { SCHEMA_VERSION } = await import(APPEND_URL)
  assert.equal(SCHEMA_VERSION, 6)
  const src = fs.readFileSync(path.join(WF_DIR, 'lib', 'ledger-append.mjs'), 'utf8')
  const at = src.indexOf('export const SCHEMA_VERSION')
  const preceding = src.slice(Math.max(0, at - 1500), at)
  assert.ok(/budget_spent/.test(preceding) && /delta|per-run/i.test(preceding), 'the comment above SCHEMA_VERSION must name the budget_spent change')
})

const row = (version, runId, budgetSpent) => ({
  schema_version: version, run_id: runId, ts: '2026-10-11T00:00:00.000Z', repo: 'demo', kind: 'tdd_task',
  outcome: 'done', task: 'T', spec: null, budget_spent: budgetSpent,
})

test('T8 AC-DATA-17: a window mixing a v4 row (2650000) and a v5 row (250) reports no sum or mean of budget_spent, and shows both versions', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.dirname(path.join(repo, LEDGER_REL)), { recursive: true })
  fs.writeFileSync(path.join(repo, LEDGER_REL), [row(4, 'a', 2650000), row(5, 'b', 250)].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const res = spawnSync('node', [MODULE_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  const seen = out.perRepo ? out.perRepo[0].schemaVersionsSeen : out.schemaVersionsSeen
  assert.deepEqual(seen, { 4: 1, 5: 1 })
  // Neither the running total, the delta, their sum (2650250) nor their mean (1325125) may appear anywhere.
  const text = res.stdout
  for (const forbidden of ['2650250', '1325125', '1325125.0']) assert.ok(!text.includes(forbidden), `${forbidden} would be an aggregate across schema versions`)
  assert.ok(!/budget/i.test(Object.keys(out).join(' ')), 'no budget aggregate is exposed as a top-level key')
})

test('T8 AC-DATA-17: no reader in workflows/lib aggregates budget_spent', () => {
  for (const f of fs.readdirSync(path.join(WF_DIR, 'lib')).filter((n) => n.endsWith('.mjs') && n !== 'ledger-append.mjs')) {
    const src = fs.readFileSync(path.join(WF_DIR, 'lib', f), 'utf8')
    assert.ok(!/budget_spent/.test(src), `${f} must not read budget_spent: rows of different schema versions mean different things`)
  }
})

// ---- (5) AC-DATA-19: a v5 terminal payload through the real writer appends one line ----

test('T8 AC-DATA-19: a terminal payload carrying a delta leaves the seeded bytes as a prefix and adds exactly one line, stamped with the current version (6)', () => {
  const repo = makeTempRepo()
  const { added } = assertAppendPreservesPrefix(repo, { kind: 'tdd_task', task: 'T', outcome: 'done', spec: null, budget_spent: 250, rounds: { test_attempts: 1, implement_attempts: 1 }, blocked_reason: null })
  const entry = JSON.parse(added)
  assert.strictEqual(entry.schema_version, 6)
  assert.strictEqual(entry.budget_spent, 250)
})

// ---- (3) AC-SIMP-8, AC-SIMP-9, AC-SIMP-11: nothing new is added ----

test('T8 AC-SIMP-8/9/11: no budget_counter anywhere, no budget field added to the schema export, no new workflow argument', () => {
  const files = ['tdd-task.js', 'review-cycle.js', 'plan-cycle.js'].map((f) => path.join(WF_DIR, f))
    .concat(fs.readdirSync(path.join(WF_DIR, 'lib')).map((f) => path.join(WF_DIR, 'lib', f)))
  for (const f of files) assert.ok(!/budget_counter/.test(fs.readFileSync(f, 'utf8')), `${f} must not mention budget_counter`)
  const fields = JSON.parse(fs.readFileSync(path.join(WF_DIR, 'lib', 'ledger-schema-fields.json'), 'utf8'))
  assert.ok(!/budget_(?!spent)/.test(JSON.stringify(fields)), 'no new budget field in ledger-schema-fields.json')
})
