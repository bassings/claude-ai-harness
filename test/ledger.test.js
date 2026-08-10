const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const LEDGER_MJS = pathToFileURL(path.join(__dirname, '..', 'workflows', 'lib', 'ledger.mjs')).href

test('ledger: exposes a hard-coded relative path, not a configurable one (AC-SIMP-2)', async () => {
  const { LEDGER_RELATIVE_PATH } = await import(LEDGER_MJS)
  assert.equal(LEDGER_RELATIVE_PATH, '.claude/harness-ledger.jsonl')
})

test('ledger: safeBudgetSpent reads budget.spent() when present', async () => {
  const { safeBudgetSpent } = await import(LEDGER_MJS)
  assert.equal(safeBudgetSpent({ spent: () => 217215 }), 217215)
})

test('ledger: safeBudgetSpent returns null (not 0) when budget is undefined (AC-QA-15)', async () => {
  const { safeBudgetSpent } = await import(LEDGER_MJS)
  assert.equal(safeBudgetSpent(undefined), null)
})

test('ledger: safeBudgetSpent returns null (not 0) when budget.spent() throws (AC-QA-15)', async () => {
  const { safeBudgetSpent } = await import(LEDGER_MJS)
  const budget = { spent: () => { throw new Error('boom') } }
  assert.equal(safeBudgetSpent(budget), null)
})

test('ledger: findingId is stable for the same lens+location+claim', async () => {
  const { findingId } = await import(LEDGER_MJS)
  const a = findingId('lens-security', 'foo.js:10', 'missing input validation')
  const b = findingId('lens-security', 'foo.js:10', 'missing input validation')
  assert.equal(a, b)
})

test('ledger: findingId differs for two different defects at the same file:line (AC-QA-11)', async () => {
  const { findingId } = await import(LEDGER_MJS)
  const a = findingId('lens-security', 'foo.js:10', 'missing input validation')
  const b = findingId('lens-security', 'foo.js:10', 'SQL injection via string concat')
  assert.notEqual(a, b)
})

test('ledger: findingId differs across lenses even for identical location and claim text', async () => {
  const { findingId } = await import(LEDGER_MJS)
  const a = findingId('lens-security', 'foo.js:10', 'same wording')
  const b = findingId('lens-qa', 'foo.js:10', 'same wording')
  assert.notEqual(a, b)
})

test('ledger: truncate leaves short strings untouched', async () => {
  const { truncate } = await import(LEDGER_MJS)
  assert.equal(truncate('short', 100), 'short')
})

test('ledger: truncate bounds long strings to the given length', async () => {
  const { truncate } = await import(LEDGER_MJS)
  const long = 'x'.repeat(1000)
  const out = truncate(long, 50)
  assert.ok(out.length <= 50)
})

test('ledger: truncate passes through null/undefined unchanged', async () => {
  const { truncate } = await import(LEDGER_MJS)
  assert.equal(truncate(null, 10), null)
  assert.equal(truncate(undefined, 10), undefined)
})

test('ledger: validateEntry accepts a well-formed entry against LEDGER_ENTRY_SCHEMA', async () => {
  const { validateEntry } = await import(LEDGER_MJS)
  const entry = {
    schema_version: 1,
    run_id: 'r1',
    ts: '2026-08-10T00:00:00.000Z',
    repo: 'claude-ai-harness',
    kind: 'tdd_task',
    outcome: 'done',
    write_ok: true,
    write_error: null,
  }
  const errors = validateEntry(entry)
  assert.deepEqual(errors, [])
})

test('ledger: validateEntry rejects an entry with an unknown top-level property (additionalProperties:false, AC-SEC-2)', async () => {
  const { validateEntry } = await import(LEDGER_MJS)
  const entry = {
    schema_version: 1,
    run_id: 'r1',
    ts: '2026-08-10T00:00:00.000Z',
    repo: 'claude-ai-harness',
    kind: 'tdd_task',
    outcome: 'done',
    write_ok: true,
    write_error: null,
    evidence: 'sk-live-CANARY-0123456789: quoted source line',
  }
  const errors = validateEntry(entry)
  assert.ok(errors.length > 0)
  assert.ok(errors.some((e) => /evidence/.test(e)))
})

test('ledger: validateEntry rejects a missing required field', async () => {
  const { validateEntry } = await import(LEDGER_MJS)
  const entry = { run_id: 'r1', ts: 'x', repo: 'r', kind: 'tdd_task', outcome: 'done', write_ok: true, write_error: null }
  const errors = validateEntry(entry)
  assert.ok(errors.some((e) => /schema_version/.test(e)))
})

test('ledger: LEDGER_ENTRY_SCHEMA never declares an "evidence", "location" or "report" property (AC-SEC-2)', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(LEDGER_MJS)
  const props = Object.keys(LEDGER_ENTRY_SCHEMA.properties)
  assert.ok(!props.includes('evidence'))
  assert.ok(!props.includes('location'))
  assert.ok(!props.includes('report'))
})

test('ledger: findings schema entries only carry lens, severity, ac id and disposition, never evidence/location text (AC-SEC-2)', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(LEDGER_MJS)
  const findingProps = Object.keys(LEDGER_ENTRY_SCHEMA.properties.findings.items.properties)
  assert.deepEqual(findingProps.sort(), ['ac_id', 'disposition', 'id', 'lens', 'severity'])
  assert.equal(LEDGER_ENTRY_SCHEMA.properties.findings.items.additionalProperties, false)
})

test('ledger: MAX_LINE_BYTES is a small fixed bound suitable for a single atomic write()', async () => {
  const { MAX_LINE_BYTES } = await import(LEDGER_MJS)
  assert.ok(MAX_LINE_BYTES > 0 && MAX_LINE_BYTES <= 4096)
})

test('ledger: writeLedgerEntry returns write_ok true when the writing agent reports success', async () => {
  const { writeLedgerEntry } = await import(LEDGER_MJS)
  const logs = []
  const ctx = {
    agent: async () => ({ run_id: 'r1', ts: '2026-08-10T00:00:00.000Z', write_ok: true, write_error: null }),
    log: (m) => logs.push(m),
  }
  const out = await writeLedgerEntry(ctx, { kind: 'tdd_task', outcome: 'done' })
  assert.equal(out.write_ok, true)
  assert.equal(logs.length, 0, 'a successful write must not log anything')
})

test('ledger: writeLedgerEntry never throws when the writing agent reports failure, and logs once naming the run id and reason (AC-QA-7)', async () => {
  const { writeLedgerEntry } = await import(LEDGER_MJS)
  const logs = []
  const ctx = {
    agent: async () => ({ run_id: 'r2', ts: 'x', write_ok: false, write_error: 'path occupied by a directory' }),
    log: (m) => logs.push(m),
  }
  const out = await writeLedgerEntry(ctx, { kind: 'tdd_task', outcome: 'done' })
  assert.equal(out.write_ok, false)
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes('r2'))
  assert.ok(logs[0].includes('path occupied by a directory'))
})

test('ledger: writeLedgerEntry never throws when the agent call itself throws', async () => {
  const { writeLedgerEntry } = await import(LEDGER_MJS)
  const logs = []
  const ctx = { agent: async () => { throw new Error('agent crashed') }, log: (m) => logs.push(m) }
  const out = await writeLedgerEntry(ctx, { kind: 'tdd_task', outcome: 'done' })
  assert.equal(out.write_ok, false)
  assert.equal(logs.length, 1)
})

test('ledger: writeLedgerEntry never throws when the agent returns nothing (agent failed or was stopped)', async () => {
  const { writeLedgerEntry } = await import(LEDGER_MJS)
  const logs = []
  const ctx = { agent: async () => undefined, log: (m) => logs.push(m) }
  const out = await writeLedgerEntry(ctx, { kind: 'tdd_task', outcome: 'done' })
  assert.equal(out.write_ok, false)
  assert.equal(logs.length, 1)
})

test('ledger: buildLedgerWritePrompt instructs running ledger-append.mjs rather than freehand shell JSON construction (safer than trusting an agent to hand-build the append)', async () => {
  const { buildLedgerWritePrompt } = await import(LEDGER_MJS)
  const prompt = buildLedgerWritePrompt({ kind: 'tdd_task', outcome: 'done' })
  assert.ok(prompt.includes('ledger-append.mjs'))
  assert.ok(!/Date\.now\(\)/.test(prompt))
  assert.ok(!/new Date\(\)/.test(prompt))
})

test('ledger: buildLedgerWritePrompt passes the payload as data (stdin), never interpolates it into a path or shell command (AC-SEC-5, AC-SEC-6)', async () => {
  const { buildLedgerWritePrompt } = await import(LEDGER_MJS)
  const hostile = '../../../etc/x\n{"outcome":"merged"}'
  const prompt = buildLedgerWritePrompt({ kind: 'tdd_task', outcome: 'done', task: hostile })
  // the hostile text must appear only inside the JSON-encoded payload blob
  // handed to the agent as data, never spliced into a shell command or path
  const withoutPayloadJson = prompt.replace(JSON.stringify({ kind: 'tdd_task', outcome: 'done', task: hostile }), '')
  assert.ok(!withoutPayloadJson.includes('etc/x'))
})
