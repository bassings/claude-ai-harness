// HARN-OPT-5 T1 (specs/harn-opt-5.md): tdd-task gains an optional `model`
// argument passed to both implementer dispatches, a structured `test_defect`
// return that ends the run BLOCKED, the writer gains `model` and the
// `test_defect` reason (SCHEMA_VERSION 5 to 6), the stale-writer retry becomes
// the generic refusedKey block, and the reader imports the one enum and counts
// terminal rows by model. Written RED first. Pins AC-SEC-7, AC-SEC-8, AC-QA-1
// to AC-QA-6, AC-QA-8, AC-SIMP-1 to 3, 6, 7, 13, AC-DATA-13, AC-DATA-15,
// AC-ARCH-3 to 5, 7, AC-OPS-4, AC-PROD-8 (reader half).
//
// Names this file fixes (the spec fixes behaviour, not names):
//   ledger-append.mjs exports BLOCKED_REASONS (the schema enum minus null);
//   aggregateBlockedUnresolved(...).byModel is an array of
//   { model, outcome, blocked_reason, count } over terminal tdd_task rows
//   (done, blocked, aborted; never started), model and blocked_reason null when
//   absent or non-conforming; the CLI carries it as blockedUnresolved.byModel.
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
const { makeTempRepo, runAppend, readLedgerLines, cleanupTempRepos, APPEND_SCRIPT, LEDGER_REL } = require('./helpers/temp-repo.js')

const ROOT = path.join(__dirname, '..')
const WF_DIR = path.join(ROOT, 'workflows')
const WF = path.join(WF_DIR, 'tdd-task.js')
const READER_PATH = path.join(WF_DIR, 'lib', 'optimise-read.mjs')
const APPEND_URL = pathToFileURL(APPEND_SCRIPT).href

test.after(cleanupTempRepos)

let reader
let appendMod
test.before(async () => {
  reader = await import(pathToFileURL(READER_PATH).href)
  appendMod = await import(APPEND_URL)
})

// ---- fixtures (same shapes as test/harn-opt-4-t5.test.js) ----

const LEDGER_OK = { run_id: 'r1', ts: '2026-10-11T00:00:00.000Z', write_ok: true, write_error: null }
const WRITE_TEST = { test_files: ['a.test.js'], test_command: 'node a.test.js', expected_failure: 'missing fn' }
const RED_OK = { red: true, right_reason: true, evidence: 'threw', test_hashes: [{ file: 'a.test.js', sha256: 'abc' }] }
const RED_BAD = { red: false, right_reason: false, evidence: 'passed already', test_hashes: [] }
const IMPL = { summary: 'added fn', files_changed: ['a.js'] }
const GREEN_OK = { green: true, suite_green: true, hashes_match: true, evidence: 'passed' }
const GREEN_RED = { green: false, suite_green: false, hashes_match: true, evidence: 'still red' }
const COMMIT = { sha: 'deadbeef', message: 'feat: thing' }
const DONE = { 'write-test#1': WRITE_TEST, 'verify-red#1': RED_OK, 'implement#1': IMPL, 'verify-green#1': GREEN_OK, commit: COMMIT }
// Two Test dispatches and two Implement dispatches, then done: every attempt
// path that carries an implementer agentType.
const TWO_ROUNDS = {
  'write-test#1': WRITE_TEST, 'write-test#2': WRITE_TEST,
  'verify-red#1': RED_BAD, 'verify-red#2': RED_OK,
  'implement#1': IMPL, 'implement#2': IMPL,
  'verify-green#1': GREEN_RED, 'verify-green#2': GREEN_OK,
  commit: COMMIT,
}

async function runTdd(agentMap, { args = {}, ledger = () => LEDGER_OK } = {}) {
  const { result, calls, logs } = await runWorkflow(WF, { args: { task: 'do the thing', ...args }, agent: { ...agentMap, 'ledger:write': ledger } })
  const writes = calls.filter((c) => c.opts.label === 'ledger:write').map((c) => extractLedgerPayload(c.prompt))
  return { result, calls, logs, writes, terminal: writes[writes.length - 1] }
}

const IMPLEMENTER_LABEL = /^(write-test|implement)#\d+$/

// ---- (1) the `model` argument (AC-QA-1, AC-QA-2, AC-QA-3, AC-OPS-4, AC-SIMP-3) ----

test('T1 model: an invalid value throws before the started write and before any agent dispatch, naming `model` and the rule (AC-QA-3)', async () => {
  const bad = ['', 'Opus', '.opus', '-opus', 'a'.repeat(65), 'op us', ' opus', 'opus\n', '../opus', 'a/b', 7, true, {}, ['opus'], null]
  // null (round 2 F4, AC-QA-3): throws by design, only undefined means absent.
  for (const model of bad) {
    const label = JSON.stringify(model)
    let thrown
    try { await runTdd(DONE, { args: { model } }) } catch (e) { thrown = e }
    assert.ok(thrown, `${label}: must throw`)
    assert.match(String(thrown.message), /\bmodel\b/, `${label}: the error must name model: ${thrown.message}`)
    assert.match(String(thrown.message), /a-z0-9|lowercase/i, `${label}: the error must state the rule: ${thrown.message}`)
    assert.deepEqual(thrown.calls, [], `${label}: no agent() call at all, so neither the started ledger write nor any dispatch happened`)
  }
})

test('T1 model: a valid value is passed as opts.model on EVERY write-test and implement dispatch across all attempts, and on no other agent() call (AC-QA-1)', async () => {
  for (const model of ['opus', 'sonnet', 'claude-sonnet-5-5', '0.1-x', 'a'.repeat(64)]) {
    const { calls, result } = await runTdd(TWO_ROUNDS, { args: { model } })
    assert.equal(result.verdict, 'DONE', model)
    const impl = calls.filter((c) => IMPLEMENTER_LABEL.test(c.opts.label || ''))
    assert.deepEqual(impl.map((c) => c.opts.label), ['write-test#1', 'write-test#2', 'implement#1', 'implement#2'], 'precondition: all four implementer dispatches happened')
    for (const c of impl) assert.strictEqual(c.opts.model, model, `${c.opts.label} must carry the model`)
    for (const c of impl) assert.strictEqual(c.opts.agentType, 'implementer')
    for (const c of calls.filter((x) => !IMPLEMENTER_LABEL.test(x.opts.label || ''))) {
      assert.ok(!('model' in c.opts), `${c.opts.label} must not carry a model key`)
    }
  }
})

test('T1 model: absent, no agent() call carries a model key and the terminal payload has no model key; the written line reads null (AC-QA-2)', async () => {
  const { calls, terminal, writes } = await runTdd(TWO_ROUNDS)
  for (const c of calls) assert.ok(!('model' in c.opts), `${c.opts.label} must not carry a model key when none was supplied`)
  for (const w of writes) assert.ok(!('model' in w), `payload must not carry model: ${JSON.stringify(w)}`)
  const repo = makeTempRepo()
  const res = runAppend(repo, terminal)
  assert.equal(JSON.parse(res.stdout.trim().split('\n').pop()).write_ok, true, res.stderr)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.ok('model' in entry, 'the writer normalises absence to an explicit null')
  assert.strictEqual(entry.model, null)
})

test('T1 model: a supplied token rides the terminal payload and survives the real writer (AC-OPS-4)', async () => {
  const { terminal } = await runTdd(DONE, { args: { model: 'opus' } })
  assert.strictEqual(terminal.model, 'opus')
  const repo = makeTempRepo()
  const res = runAppend(repo, terminal)
  assert.equal(JSON.parse(res.stdout.trim().split('\n').pop()).write_ok, true, res.stderr)
  assert.strictEqual(JSON.parse(readLedgerLines(repo)[0]).model, 'opus')
})

test('T1 model: exactly one log line names the model, emitted before the first Test dispatch (token, or "default") (AC-OPS-4)', async () => {
  // write-test#1 returns nothing, so the run aborts AT the first Test dispatch:
  // a log line seen here was necessarily emitted before it.
  const withModel = await runTdd({}, { args: { model: 'opus' } })
  const named = withModel.logs.filter((l) => /model/i.test(l))
  assert.equal(named.length, 1, `logs: ${JSON.stringify(withModel.logs)}`)
  assert.match(named[0], /opus/)
  const without = await runTdd({})
  const dflt = without.logs.filter((l) => /model/i.test(l))
  assert.equal(dflt.length, 1, `logs: ${JSON.stringify(without.logs)}`)
  assert.match(dflt[0], /default/)
})

test('T1 model: tdd-task whenToUse lists the one new argument, and no other workflow gains a model argument (AC-SIMP-3)', () => {
  const whenToUse = (f) => (fs.readFileSync(path.join(WF_DIR, f), 'utf8').match(/whenToUse:\s*(['"`])([\s\S]*?)\1,?\n/) || [])[2] || ''
  assert.match(whenToUse('tdd-task.js'), /model\?:/)
  for (const f of ['review-cycle.js', 'plan-cycle.js', 'optimise-cycle.js']) {
    assert.ok(whenToUse(f).length > 20, `${f}: sanity, whenToUse located`)
    assert.ok(!/\bmodel\b/.test(whenToUse(f)), `${f} must not gain a model argument`)
  }
})

// ---- (2) the writer (AC-SEC-7, AC-QA-4, AC-ARCH-3, AC-SIMP-2, AC-DATA-15) ----

function writeRow(extra, base = { kind: 'tdd_task', outcome: 'done', task: 'x', spec: 'specs/a.md' }) {
  const repo = makeTempRepo()
  const res = runAppend(repo, { ...base, ...extra })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `the writer refused the row: ${out.write_error}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, `stderr: ${res.stderr}`)
  return { out, entry: JSON.parse(lines[0]), raw: fs.readFileSync(path.join(repo, LEDGER_REL), 'utf8') }
}

test('T1 schema: SCHEMA_VERSION is 6, with one comment naming both changes (model and test_defect), and no other bump (AC-SIMP-2)', () => {
  assert.equal(appendMod.SCHEMA_VERSION, 6)
  const src = fs.readFileSync(APPEND_SCRIPT, 'utf8')
  assert.equal((src.match(/export const SCHEMA_VERSION = /g) || []).length, 1)
  const at = src.indexOf('export const SCHEMA_VERSION')
  const preceding = src.slice(Math.max(0, at - 2500), at)
  assert.ok(/\bmodel\b/.test(preceding) && /test_defect/.test(preceding), 'the comment above SCHEMA_VERSION must name both model and test_defect')
})

test('T1 schema: model is string-or-null with the token pattern in LEDGER_ENTRY_SCHEMA; the fields export gains exactly model; the enum gains exactly test_defect (AC-SEC-7, AC-SIMP-2)', () => {
  const def = appendMod.LEDGER_ENTRY_SCHEMA.properties.model
  assert.ok(def, 'model must be declared')
  assert.ok([].concat(def.type).includes('string') && [].concat(def.type).includes('null'), `type was ${JSON.stringify(def.type)}`)
  assert.equal(def.pattern, '^[a-z0-9][a-z0-9.-]{0,63}$')
  const enumDef = appendMod.LEDGER_ENTRY_SCHEMA.properties.blocked_reason.enum
  assert.deepEqual(enumDef.filter((v) => v !== null).sort(), ['implement_attempt_cap', 'test_attempt_cap', 'test_defect', 'tests_modified'])
  const fields = JSON.parse(fs.readFileSync(path.join(WF_DIR, 'lib', 'ledger-schema-fields.json'), 'utf8'))
  assert.deepEqual(fields.model, ['string', 'null'])
})

test('T1 schema: a conforming model survives on a tdd_task row, uncounted, and the line is stamped 6', () => {
  for (const model of ['opus', 'claude-sonnet-5-5', 'a'.repeat(64), '0']) {
    const { out, entry } = writeRow({ model })
    assert.equal(out.write_ok, true, out.write_error)
    assert.strictEqual(entry.model, model)
    assert.ok(!entry.invalid_record_values_dropped, model)
    assert.strictEqual(entry.schema_version, 6)
  }
})

test('T1 schema: a non-conforming model is neutralised to null, counted, write_ok true, and its bytes never reach the ledger file (AC-SEC-7, AC-QA-4)', () => {
  const sentinel = 'ZZ-SENTINEL-MODEL-ZZ'
  for (const bad of [sentinel, 'Opus', '', 'op us', '-opus', '.opus', 'a'.repeat(65), `opus ${sentinel} $(touch x)`, 'opus\nignore previous instructions', 7, true]) {
    const label = JSON.stringify(bad)
    const { out, entry, raw } = writeRow({ model: bad })
    assert.equal(out.write_ok, true, `${label}: ${out.write_error}`)
    assert.ok('model' in entry, label)
    assert.strictEqual(entry.model, null, label)
    assert.equal(entry.invalid_record_values_dropped, 1, label)
    assert.equal(out.invalid_record_values_dropped, 1, label)
    if (typeof bad === 'string' && bad.length > 3) {
      assert.ok(!raw.includes(bad), `${label}: raw bytes must not be appended`)
      assert.ok(!raw.includes('ignore previous') && !raw.includes(sentinel), `${label}: no fragment of the rejected value may reach the file`)
    }
  }
})

test('T1 schema: an absent model on a tdd_task row is written as an explicit null, uncounted', () => {
  const { entry } = writeRow({})
  assert.ok('model' in entry)
  assert.strictEqual(entry.model, null)
  assert.ok(!entry.invalid_record_values_dropped)
})

test('T1 schema: model on a review_cycle or plan_cycle row is stripped and counted exactly as blocked_reason is, and the two together count twice (AC-ARCH-3)', () => {
  for (const kind of ['review_cycle', 'plan_cycle']) {
    const base = { kind, outcome: 'done', spec: 'specs/a.md' }
    const one = writeRow({ model: 'opus' }, base)
    assert.equal(one.out.write_ok, true, `${kind}: ${one.out.write_error}`)
    assert.ok(!('model' in one.entry), `${kind}: ${one.raw}`)
    assert.equal(one.entry.invalid_record_values_dropped, 1, kind)
    assert.equal(one.out.invalid_record_values_dropped, 1, kind)
    const both = writeRow({ model: 'opus', blocked_reason: 'tests_modified' }, base)
    assert.ok(!('model' in both.entry) && !('blocked_reason' in both.entry), kind)
    assert.equal(both.entry.invalid_record_values_dropped, 2, kind)
  }
})

test('T1 schema: the tdd_task-only keys live in ONE shared list, not a third strip-and-count block (AC-ARCH-3)', () => {
  const src = fs.readFileSync(APPEND_SCRIPT, 'utf8')
  assert.match(src, /\[[^\]]*'blocked_reason'[^\]]*'model'[^\]]*\]|\[[^\]]*'model'[^\]]*'blocked_reason'[^\]]*\]/, 'one array literal must hold both keys')
  assert.ok(!/stray\w*Model|strayModel/i.test(src), 'no separate stray-model counter')
})

test('T1 schema (AC-DATA-15): after 100 v5 lines and one appended v6 line the first 100 are byte-identical, the mix parses, and both versions are visible', () => {
  const repo = makeTempRepo()
  const p = path.join(repo, LEDGER_REL)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const v5 = Array.from({ length: 100 }, (_, i) => JSON.stringify({
    schema_version: 5, run_id: `seed${i}`, ts: '2026-10-11T00:00:00.000Z', repo: 'demo', kind: 'tdd_task',
    outcome: i % 2 ? 'done' : 'blocked', task: `t${i}`, spec: 'specs/a.md', blocked_reason: i % 2 ? null : 'tests_modified',
  }))
  const seed = v5.join('\n') + '\n'
  fs.writeFileSync(p, seed)
  const res = runAppend(repo, { kind: 'tdd_task', outcome: 'blocked', task: 'new', spec: 'specs/a.md', blocked_reason: 'test_defect', model: 'opus' })
  assert.equal(JSON.parse(res.stdout.trim().split('\n').pop()).write_ok, true, res.stderr)
  const after = fs.readFileSync(p, 'utf8')
  assert.ok(after.startsWith(seed), 'the 100 v5 lines must be an untouched prefix')
  const added = after.slice(seed.length)
  assert.equal(added.split('\n').length - 1, 1, 'exactly one line added')
  const row = JSON.parse(added)
  assert.equal(row.schema_version, 6)
  assert.equal(row.blocked_reason, 'test_defect')
  assert.equal(row.model, 'opus')
  const parsed = reader.parseLedgerContent(after)
  assert.equal(parsed.records.length, 101)
  assert.equal(parsed.skipped.length, 0)
  assert.deepEqual([...parsed.schemaVersionsSeen.entries()].sort(), [[5, 100], [6, 1]])
  const cli = spawnSync('node', [READER_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  const out = JSON.parse(cli.stdout.trim())
  const seen = out.perRepo ? out.perRepo[0].schemaVersionsSeen : out.schemaVersionsSeen
  assert.deepEqual(seen, { 5: 100, 6: 1 })
})

// ---- (3) the stale-writer retry (AC-QA-5, AC-ARCH-4) ----

// A writer that predates `model` and/or `blocked_reason`: it refuses any payload
// carrying a key in `refuse`, as the real validator does, listing every offending
// key in one message (`allAtOnce`) or, for a validator that stops at the first,
// one key per refusal. Records what it accepted, and every payload it saw.
function staleWriter({ refuse, allAtOnce = true, accepted, seen }) {
  let n = 0
  return (prompt) => {
    const p = extractLedgerPayload(prompt)
    n += 1
    seen.push(p)
    const present = refuse.filter((k) => k in p)
    if (p.outcome !== 'started' && present.length) {
      const msg = (allAtOnce ? present : present.slice(0, 1)).map((k) => `${k}: not an allowed property`).join('; ')
      return { run_id: `w${n}`, ts: 't', write_ok: false, write_error: `payload failed ledger schema validation: ${msg}` }
    }
    accepted.push(p)
    return { run_id: 'w1', ts: 't', write_ok: true, write_error: null }
  }
}
const terminalsOf = (seen) => seen.filter((p) => p.outcome !== 'started')

test('T1 retry: a DONE run against a writer refusing model lands after exactly one retry, paired by run_id, with the key named in the log (AC-QA-5)', async () => {
  const accepted = []; const seen = []
  const { result, logs } = await runTdd(DONE, { args: { model: 'opus' }, ledger: staleWriter({ refuse: ['model'], accepted, seen }) })
  const terminals = terminalsOf(seen)
  assert.equal(terminals.length, 2, 'one refusal plus one retry')
  assert.ok('model' in terminals[0] && !('model' in terminals[1]))
  const landed = terminalsOf(accepted)
  assert.equal(landed.length, 1)
  assert.equal(landed[0].outcome, 'done')
  assert.equal(landed[0].run_id, 'w1', 'the retry keeps the started row\'s run_id, so the pair still joins')
  assert.equal(result.verdict, 'DONE', 'never a fabricated block')
  assert.ok(!result.ledger_write_failed)
  assert.ok(logs.some((l) => /model/.test(l) && /retr/i.test(l)), `logs: ${JSON.stringify(logs)}`)
})

test('T1 retry: a BLOCKED run carrying model and blocked_reason against a writer refusing both still lands its terminal row, paired by run_id, bounded, every stripped key named (AC-QA-5, AC-ARCH-4)', async () => {
  const implCap = {
    'write-test#1': WRITE_TEST, 'verify-red#1': RED_OK,
    'implement#1': IMPL, 'implement#2': IMPL, 'implement#3': IMPL,
    'verify-green#1': GREEN_RED, 'verify-green#2': GREEN_RED, 'verify-green#3': GREEN_RED,
  }
  for (const allAtOnce of [true, false]) {
    const accepted = []; const seen = []
    const { result, logs } = await runTdd(implCap, { args: { model: 'opus' }, ledger: staleWriter({ refuse: ['model', 'blocked_reason'], allAtOnce, accepted, seen }) })
    const terminals = terminalsOf(seen)
    assert.ok('model' in terminals[0] && 'blocked_reason' in terminals[0], 'precondition: both optional keys were sent')
    assert.ok(terminals.length <= 3, `allAtOnce=${allAtOnce}: bounded by the optional keys sent (2) plus the first attempt, got ${terminals.length}`)
    const landed = terminalsOf(accepted)
    assert.equal(landed.length, 1, `allAtOnce=${allAtOnce}`)
    assert.equal(landed[0].outcome, 'blocked')
    assert.equal(landed[0].run_id, 'w1', 'paired by run_id')
    assert.ok(!('model' in landed[0]) && !('blocked_reason' in landed[0]))
    assert.equal(result.verdict, 'BLOCKED')
    assert.ok(!result.ledger_write_failed)
    const text = logs.join('\n')
    assert.ok(/model/.test(text) && /blocked_reason/.test(text), `every stripped key must be named in the log: ${JSON.stringify(logs)}`)
  }
})

test('T1 retry: only a key the payload carries, and never kind, outcome or run_id, is stripped; any other refusal is final (AC-QA-5)', async () => {
  const refusals = ['spec_raw: not an allowed property', 'kind: not an allowed property', 'outcome: not an allowed property', 'run_id: not an allowed property', 'model: must match pattern', 'disk full']
  for (const err of refusals) {
    const seen = []
    const ledger = (prompt) => {
      const p = extractLedgerPayload(prompt)
      seen.push(p)
      if (p.outcome === 'started') return LEDGER_OK
      return { run_id: 'w', ts: 't', write_ok: false, write_error: `payload failed ledger schema validation: ${err}` }
    }
    const { result } = await runTdd(DONE, { args: { model: 'opus' }, ledger })
    assert.equal(terminalsOf(seen).length, 1, `${err}: must not be retried`)
    assert.equal(result.ledger_write_failed, true, err)
  }
})

test('T1 retry: tdd-task.js uses the generic refusedKey block and the key-specific blocked_reason retry is gone (AC-ARCH-4)', () => {
  const src = fs.readFileSync(WF, 'utf8')
  assert.ok(src.includes('const refusedKey ='), 'the generic block must be present')
  assert.ok(!/\/blocked_reason\/\.test\(/.test(src), 'the key-specific test is gone')
})

// ---- (4) test_defect (AC-SEC-8, AC-QA-6, AC-QA-8, AC-ARCH-7, AC-DATA-13, AC-SIMP-6, AC-SIMP-7, AC-SIMP-13) ----

const TD = { test_defect: { file: 'b.test.js', reason: 'asserts the wrong thing' } }
const afterLastImplement = (calls) => {
  const last = calls.map((c) => c.opts.label || '').reduce((acc, l, i) => (/^implement#/.test(l) ? i : acc), -1)
  return calls.slice(last + 1)
}

test('T1 test_defect: a test_defect on attempt 1 ends BLOCKED with the enum code; the result names file and reason; no verify-green, no commit (AC-QA-6)', async () => {
  const { result, calls, terminal } = await runTdd({ ...DONE, 'implement#1': TD })
  assert.equal(result.verdict, 'BLOCKED')
  assert.equal(result.telemetry.outcome, 'blocked')
  assert.equal(terminal.outcome, 'blocked')
  assert.strictEqual(terminal.blocked_reason, 'test_defect')
  const text = JSON.stringify(result)
  assert.ok(text.includes('b.test.js') && text.includes('asserts the wrong thing'), `the returned result must name file and reason: ${text}`)
  assert.equal(calls.filter((c) => c.opts.label === 'commit').length, 0)
  assert.equal(calls.filter((c) => /^verify-green#/.test(c.opts.label || '')).length, 0)
  assert.equal(calls.filter((c) => /^implement#/.test(c.opts.label || '')).length, 1)
})

test('T1 test_defect: on attempt 3, after two GREEN rejections, it still ends BLOCKED test_defect with no commit and no further verifier (AC-QA-6, AC-DATA-13)', async () => {
  const map = {
    'write-test#1': WRITE_TEST, 'verify-red#1': RED_OK,
    'implement#1': IMPL, 'implement#2': IMPL, 'implement#3': TD,
    'verify-green#1': GREEN_RED, 'verify-green#2': GREEN_RED, 'verify-green#3': GREEN_OK, commit: COMMIT,
  }
  const { result, calls, terminal } = await runTdd(map)
  assert.equal(result.verdict, 'BLOCKED')
  assert.strictEqual(terminal.blocked_reason, 'test_defect', 'never the cap value')
  assert.equal(calls.filter((c) => /^implement#/.test(c.opts.label || '')).length, 3)
  assert.equal(calls.filter((c) => /^verify-green#/.test(c.opts.label || '')).length, 2)
  assert.equal(calls.filter((c) => c.opts.label === 'commit').length, 0)
})

test('T1 test_defect: after the test_defect return only the terminal ledger write follows, and exactly one terminal write happens (AC-DATA-13, AC-ARCH-7)', async () => {
  const { calls, writes, result } = await runTdd({ ...DONE, 'implement#1': TD })
  assert.ok(afterLastImplement(calls).length > 0 && afterLastImplement(calls).every((c) => c.opts.label === 'ledger:write'), 'no git, verify or commit agent may run after the return')
  assert.equal(writes.filter((w) => w.outcome !== 'started').length, 1)
  assert.equal(writes.filter((w) => w.outcome === 'started').length, 1)
  assert.ok(!result.ledger_write_failed)
  for (const w of calls.filter((c) => c.opts.label === 'ledger:write')) assert.ok(!/git (checkout|reset|clean|stash)/.test(w.prompt))
})

test('T1 test_defect: hostile file and reason text appear in no appended byte and no field of the terminal payload; the row carries only the enum (AC-SEC-8)', async () => {
  const reason = `it's "wrong"\n$(touch /tmp/pwned) \`id\` ${'R'.repeat(2048)} SENTINEL_REASON_9F3A`
  const file = `SENTINEL_FILE_77C1/'";$(id).test.js`
  const { result, calls, terminal, writes } = await runTdd({ ...DONE, 'implement#1': { test_defect: { file, reason } } })
  assert.equal(result.verdict, 'BLOCKED')
  assert.strictEqual(terminal.blocked_reason, 'test_defect')
  for (const w of writes) {
    const s = JSON.stringify(w)
    assert.ok(!s.includes('SENTINEL_REASON_9F3A') && !s.includes('SENTINEL_FILE_77C1') && !s.includes('RRRRRRRR'), `payload leaked: ${s.slice(0, 200)}`)
  }
  for (const c of calls.filter((x) => x.opts.label === 'ledger:write')) {
    assert.ok(!c.prompt.includes('SENTINEL_REASON_9F3A') && !c.prompt.includes('SENTINEL_FILE_77C1'), 'the ledger:write prompt must not carry the text')
  }
  const repo = makeTempRepo()
  const res = runAppend(repo, terminal)
  assert.equal(JSON.parse(res.stdout.trim().split('\n').pop()).write_ok, true, res.stderr)
  const raw = fs.readFileSync(path.join(repo, LEDGER_REL), 'utf8')
  assert.ok(!raw.includes('SENTINEL_REASON_9F3A') && !raw.includes('SENTINEL_FILE_77C1') && !raw.includes('pwned'))
  assert.equal(JSON.parse(raw).blocked_reason, 'test_defect')
})

test('T1 test_defect: the implement schema accepts either shape and the structured instruction replaces the prose (AC-QA-6, AC-SIMP-6)', async () => {
  const { calls } = await runTdd(DONE)
  const impl = calls.find((c) => c.opts.label === 'implement#1')
  const schemaText = JSON.stringify(impl.opts.schema)
  assert.ok(/test_defect/.test(schemaText) && /"file"/.test(schemaText) && /"reason"/.test(schemaText), schemaText)
  assert.ok(/test_defect/.test(impl.prompt), 'the implement prompt must instruct the structured return')
  assert.ok(!impl.prompt.includes('if the test is wrong, stop and say so'))
  assert.ok(!fs.readFileSync(WF, 'utf8').includes('if the test is wrong, stop and say so'))
})

test('T1 test_defect (AC-QA-8): a response with neither shape, both shapes, a test_defect missing file, or a non-string reason is a failed attempt; at the cap the run ends BLOCKED implement_attempt_cap with no verify-green and no commit', async () => {
  const byp = (o) => ({ __bypassSchemaValidation: true, ...o })
  const malformed = [
    byp({ summary: 'x' }),
    byp({ ...TD, summary: 'x', files_changed: ['a.js'] }),
    byp({ test_defect: { reason: 'r' } }),
    byp({ test_defect: { file: 'b.test.js', reason: 7 } }),
    byp({}),
    // Round 3 F1 (spec bug against AC-QA-8): the either-or moved out of the
    // JSON schema into code, so the `summary` string check and the
    // files_changed string-items check are the only guard; pin both halves.
    byp({ files_changed: ['a.js'] }),
    byp({ summary: 'x', files_changed: [7] }),
  ]
  for (let i = 0; i + 3 <= malformed.length; i++) {
    const trio = malformed.slice(i, i + 3)
    const { result, calls, terminal } = await runTdd({
      'write-test#1': WRITE_TEST, 'verify-red#1': RED_OK,
      'implement#1': trio[0], 'implement#2': trio[1], 'implement#3': trio[2],
      'verify-green#1': GREEN_OK, 'verify-green#2': GREEN_OK, 'verify-green#3': GREEN_OK, commit: COMMIT,
    })
    assert.equal(result.verdict, 'BLOCKED', `window ${i}`)
    assert.strictEqual(terminal.blocked_reason, 'implement_attempt_cap', `window ${i}`)
    assert.equal(calls.filter((c) => /^implement#/.test(c.opts.label || '')).length, 3)
    assert.equal(calls.filter((c) => /^verify-green#/.test(c.opts.label || '')).length, 0, 'a malformed response never reaches the verifier')
    assert.equal(calls.filter((c) => c.opts.label === 'commit').length, 0)
  }
})

test('T1 test_defect (AC-QA-8): a malformed response on attempt 1 followed by a valid one on attempt 2 still reaches DONE', async () => {
  const { result, calls } = await runTdd({
    ...DONE,
    'implement#1': { __bypassSchemaValidation: true, summary: 'no files_changed' },
    'implement#2': IMPL, 'verify-green#2': GREEN_OK,
  })
  assert.equal(result.verdict, 'DONE')
  assert.equal(calls.filter((c) => /^implement#/.test(c.opts.label || '')).length, 2)
})

test('T1 test_defect (AC-ARCH-7, AC-SIMP-7): no new verdict value, no escalation in tdd-task.js, MAX_ATTEMPTS stays 3, six agent sites', () => {
  const src = fs.readFileSync(WF, 'utf8')
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  const verdicts = new Set([...code.matchAll(/verdict:\s*'([A-Z_]+)'/g)].map((m) => m[1]))
  assert.deepEqual([...verdicts].sort(), ['ABORTED', 'BLOCKED', 'DONE'])
  assert.equal((code.match(/escalat/gi) || []).length, 0)
  assert.match(src, /const MAX_ATTEMPTS = 3\b/)
  assert.equal((code.match(/\bawait agent\(/g) || []).length, 6)
  assert.equal((code.match(/\bwriteLedger\(terminalEntry\)/g) || []).length >= 1, true)
  assert.match(src, /blockedReason = 'test_defect'/)
})

// ---- (5) the reader (AC-ARCH-5, AC-DATA-15, AC-PROD-8) ----

let seq = 0
const tdd = (outcome, task, extra = {}) => ({ schema_version: 6, run_id: `run${++seq}`, ts: `2026-10-11T0${(seq % 9) + 1}:00:00.000Z`, repo: 'demo', kind: 'tdd_task', outcome, task, spec: 'specs/a.md', ...extra })

test('T1 reader: ledger-append.mjs exports the blocked_reason enum minus null, and optimise-read.mjs imports it with no local literal (AC-ARCH-5)', () => {
  assert.deepEqual([...appendMod.BLOCKED_REASONS].sort(), appendMod.LEDGER_ENTRY_SCHEMA.properties.blocked_reason.enum.filter((v) => v !== null).sort())
  assert.ok(appendMod.BLOCKED_REASONS.includes('test_defect'))
  const src = fs.readFileSync(READER_PATH, 'utf8')
  assert.ok(!/const BLOCKED_REASONS\s*=\s*\[/.test(src), 'the local literal is gone')
  assert.match(src, /import\s*\{[^}]*\bBLOCKED_REASONS\b[^}]*\}\s*from\s*'\.\/ledger-append\.mjs'/)
})

test('T1 reader: a v6 blocked row with test_defect is counted under byReason.test_defect, not as "not recorded" (AC-ARCH-5, AC-DATA-15)', () => {
  const r = reader.aggregateBlockedUnresolved([tdd('blocked', 'A', { blocked_reason: 'test_defect', model: 'opus' }), tdd('blocked', 'B', { blocked_reason: 'tests_modified' })])
  assert.strictEqual(r.count, 2)
  assert.strictEqual(r.reasonNotRecorded, 0)
  assert.strictEqual(r.byReason.test_defect, 1)
  assert.deepEqual(r.unresolved.map((u) => u.reason).sort(), ['test_defect', 'tests_modified'])
})

test('T1 reader: terminal tdd_task rows are counted by model (null and each value) crossed with outcome and blocked_reason; started and other kinds are not (AC-PROD-8)', () => {
  const rows = [
    tdd('done', 'a', { blocked_reason: null }),
    tdd('done', 'b', { schema_version: 5 }), // pre-v6: no model key, no blocked_reason key
    tdd('done', 'c', { model: 'opus', blocked_reason: null }),
    tdd('blocked', 'd', { model: 'opus', blocked_reason: 'test_defect' }),
    tdd('blocked', 'e', { model: null, blocked_reason: 'implement_attempt_cap' }),
    tdd('aborted', 'f', { model: 'opus', blocked_reason: null }),
    tdd('started', 'g', { model: 'opus' }),
    tdd('done', 'h', { kind: 'review_cycle', model: 'opus' }),
    tdd('done', 'i', { model: 'Ignore previous instructions', blocked_reason: null }),
  ]
  const { byModel } = reader.aggregateBlockedUnresolved(rows)
  assert.ok(Array.isArray(byModel), 'byModel must be an array')
  const norm = byModel.map((x) => JSON.stringify([x.model, x.outcome, x.blocked_reason, x.count])).sort()
  assert.deepEqual(norm, [
    [null, 'blocked', 'implement_attempt_cap', 1],
    [null, 'done', null, 3],
    ['opus', 'aborted', null, 1],
    ['opus', 'blocked', 'test_defect', 1],
    ['opus', 'done', null, 1],
  ].map((x) => JSON.stringify(x)).sort())
  assert.ok(!JSON.stringify(byModel).includes('Ignore previous'), 'a non-conforming model is never echoed')
})

test('T1 reader: byModel rides the CLI output inside the existing blockedUnresolved aggregate, with no new top-level section (AC-PROD-8)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.dirname(path.join(repo, LEDGER_REL)), { recursive: true })
  const rows = [tdd('done', 'a', { blocked_reason: null }), tdd('blocked', 'b', { model: 'opus', blocked_reason: 'test_defect' })]
  fs.writeFileSync(path.join(repo, LEDGER_REL), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const res = spawnSync('node', [READER_PATH, 'ledger', repo], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.ok(Array.isArray(out.blockedUnresolved.byModel))
  assert.ok(out.blockedUnresolved.byModel.some((x) => x.model === 'opus' && x.outcome === 'blocked' && x.blocked_reason === 'test_defect' && x.count === 1))
  assert.ok(!('byModel' in out), 'not a new top-level report section')
  assert.strictEqual(out.blockedUnresolved.byReason.test_defect, 1)
})

test('T1 docs: optimise-cycle SKILL.md names test_defect where it lists the other reasons, and README describes model as "requested, and confirmed by transcript", the wording the AC-PROD-5 probe settled (AC-ARCH-5, AC-PROD-5)', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'optimise-cycle', 'SKILL.md'), 'utf8')
  const at = skill.indexOf('`tests_modified`')
  assert.ok(at >= 0)
  assert.ok(/test_defect/.test(skill.slice(Math.max(0, at - 400), at + 400)), 'test_defect must sit beside the other three reasons')
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const ledger = readme.slice(readme.indexOf('## Run ledger'))
  assert.match(ledger, /`model`[^\n]*(\n[^\n]*)?requested, and confirmed by transcript|requested, and confirmed by transcript[^\n]*(\n[^\n]*)?`model`/)
  assert.match(ledger, /claude-opus-5-5[\s\S]{0,200}claude-sonnet-5-5/, 'the probe measurement is stated, not just the claim')
})

// Conductor fix after CI round 1: the first form diffed against the revision
// `main`, which exists locally but not in a CI checkout (only origin/main does),
// so the test failed on both CI jobs with "bad revision 'main'". The invariant
// AC-SIMP-1 wants is simpler and environment-free: this repo tracks no package
// manifest or lockfile at all, so "no new dependency" means none appears.
test('T1 AC-SIMP-1: no dependency is added (no package manifest or lockfile is tracked, so none can have changed)', () => {
  const tracked = spawnSync('git', ['ls-files', '--', 'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(tracked.status, 0, tracked.stderr)
  assert.equal(tracked.stdout.trim(), '', `a manifest or lockfile is tracked: ${tracked.stdout}`)
})

// ---- review round 1 fixes (F1 to F5), written RED first ----

test('T1 round 1 F1 (AC-QA-8): the verifier\'s GREEN evidence survives a malformed implement response, so the next implementer still sees it', async () => {
  const EVIDENCE = 'SENTINEL_GREEN_EVIDENCE_5E2B expected 3 got 2'
  const map = {
    'write-test#1': WRITE_TEST, 'verify-red#1': RED_OK,
    'implement#1': IMPL, 'verify-green#1': { ...GREEN_RED, evidence: EVIDENCE },
    'implement#2': {}, // malformed: neither shape
    'implement#3': TD, // ends the run once its prompt has been captured
  }
  const { calls } = await runTdd(map)
  const third = calls.find((c) => c.opts.label === 'implement#3')
  assert.ok(third, 'implement#3 must be dispatched')
  assert.ok(third.prompt.includes(EVIDENCE), 'the GREEN evidence must reach implement#3 even though attempt 2 was malformed')
  assert.ok(/malformed/.test(third.prompt), 'and the malformed-response note is sent too, both when both apply')
})

test('T1 round 1 F2 (AC-DATA-13): the test_defect and malformed-at-cap BLOCKED results return the RED-time test_hashes so the human can verify the tests are untouched', async () => {
  const defect = await runTdd({ ...DONE, 'implement#1': TD })
  assert.equal(defect.result.verdict, 'BLOCKED')
  assert.deepEqual(defect.result.test_hashes, RED_OK.test_hashes, 'test_defect result must carry the RED verifier\'s hashes')
  const capped = await runTdd({ ...DONE, 'implement#1': {}, 'implement#2': {}, 'implement#3': {} })
  assert.equal(capped.result.verdict, 'BLOCKED')
  assert.strictEqual(capped.terminal.blocked_reason, 'implement_attempt_cap')
  assert.deepEqual(capped.result.test_hashes, RED_OK.test_hashes, 'malformed-at-cap result must carry the same hashes')
})

test('T1 round 1 F3 (AC-QA-5): each stripped key is named by its OWN retry log line, in the workflow\'s wording, not by the incidental model line or the writer\'s error text', async () => {
  const implCap = {
    'write-test#1': WRITE_TEST, 'verify-red#1': RED_OK,
    'implement#1': IMPL, 'implement#2': IMPL, 'implement#3': IMPL,
    'verify-green#1': GREEN_RED, 'verify-green#2': GREEN_RED, 'verify-green#3': GREEN_RED,
  }
  const accepted = []; const seen = []
  const { logs } = await runTdd(implCap, { args: { model: 'opus' }, ledger: staleWriter({ refuse: ['model', 'blocked_reason'], allAtOnce: true, accepted, seen }) })
  assert.equal(logs.filter((l) => /^Terminal ledger write refused model \(installed writer predates it\); retrying once without it/.test(l)).length, 1, `logs: ${JSON.stringify(logs)}`)
  assert.equal(logs.filter((l) => /^Terminal ledger write refused blocked_reason as well \(installed writer predates it\); retrying without model, blocked_reason:/.test(l)).length, 1, `logs: ${JSON.stringify(logs)}`)
})

test('T1 round 1 F4 (AC-QA-1): review-cycle and plan-cycle write no `model` key on any ledger payload', async () => {
  const consistency = { ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9, doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null }
  const tip = { head_sha: 'abcdef1234567890', head_tree: '1111111111111111111111111111111111111111' }
  const cov = { examined: 'x', verified_by: 'y', could_not_check: 'z' }
  const revLens = { verdict: 'CLEAN', coverage: cov, findings: [], head_sha_measured: tip.head_sha, head_tree_measured: tip.head_tree }
  const review = await runWorkflow(path.join(WF_DIR, 'review-cycle.js'), {
    args: {},
    agent: {
      'scope:diff': { base: 'main', ...tip, files: [{ path: 'src/foo.js', status: 'M' }], new_dependency_entries: false, new_modules: false, custom_rules: null, harness_triggers_file_exists: false, consistency },
      'lens-security': revLens, 'lens-qa': revLens,
      synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [] },
      'ledger:write': LEDGER_OK,
    },
  })
  const planLens = { verdict: 'CLEAN', coverage: cov, acceptance_criteria: [{ id: 'AC-SEC-1', statement: 'x' }] }
  const plan = await runWorkflow(path.join(WF_DIR, 'plan-cycle.js'), {
    args: { spec: 'specs/foo.md' },
    agent: {
      'scope:spec': { head_sha: 'abc1234567890def', summary: 's', ui: false, data: false, architecture: false, operability: false, user_facing: true, likely_paths: ['src/widget.js'], consistency , spec_snapshot: JSON.stringify({ file: '/tmp/harn-specwb-fx/spec.snapshot', sha256: 'a'.repeat(64), headings: ['## Problem'], ac_ids: [] }) },  // HARN-OPT-5 T8: a valid snapshot so the run can reach done
      'lens-security': planLens, 'lens-qa': planLens, 'lens-simplicity': { ...planLens, acceptance_criteria: [] }, 'lens-product': planLens,
      'synthesis:write-back': { summary: '### Summary\n4 criteria', head_sha_at_synthesis: 'abc1234567890def', surviving_ids: [], writeback_check: JSON.stringify({ ok: true, problems: [], restored: false, spec_sha256: 'b'.repeat(64), snapshot_sha256: 'a'.repeat(64), surviving_ids_checked: [] }) },  // HARN-OPT-5 T8
      'ledger:write': LEDGER_OK,
    },
  })
  for (const [name, run] of [['review-cycle', review], ['plan-cycle', plan]]) {
    assert.equal(run.result.telemetry.outcome, 'done', `${name} must reach its DONE fixture`)
    const payloads = run.calls.filter((c) => c.opts.label === 'ledger:write').map((c) => extractLedgerPayload(c.prompt))
    assert.ok(payloads.length >= 2, `${name}: started and terminal writes expected`)
    for (const p of payloads) assert.ok(!('model' in p), `${name}: a payload carries model: ${JSON.stringify(p)}`)
  }
})

test('T1 round 1 F5 (AC-PROD-8): SKILL.md says the byModel null bucket means no model was recorded, listing all three causes, not "none was given"', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'optimise-cycle', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(skill.includes('null when no model was recorded: none was given, or the key was stripped for a stale writer, or the row is degraded'), 'the null bucket wording must name all three causes')
  assert.ok(!skill.includes('(null when none was given)'), 'the old, narrower wording is gone')
})

// ---- review round 2 fixes (F1 to F4), written RED first ----

const COMPARE_RE = /compare the sha256 of each test file with test_hashes before editing; a mismatch means the implementer modified the frozen test/

test('T1 round 2 F1 (AC-QA-8): a malformed response at the cap after two well-formed red attempts returns the second verifier\'s evidence and a reason counting both kinds of attempt', async () => {
  const E1 = 'FIRST_GREEN_EVIDENCE_A1'; const E2 = 'SECOND_GREEN_EVIDENCE_B2'
  const { result, terminal } = await runTdd({
    'write-test#1': WRITE_TEST, 'verify-red#1': RED_OK,
    'implement#1': IMPL, 'verify-green#1': { ...GREEN_RED, evidence: E1 },
    'implement#2': IMPL, 'verify-green#2': { ...GREEN_RED, evidence: E2 },
    'implement#3': {},
  })
  assert.equal(result.verdict, 'BLOCKED')
  assert.strictEqual(terminal.blocked_reason, 'implement_attempt_cap')
  assert.strictEqual(result.last_evidence, E2, 'the latest GREEN verifier evidence must ride the malformed-at-cap exit')
  assert.match(result.reason, /2 well-formed/, `reason must count well-formed attempts: ${result.reason}`)
  assert.match(result.reason, /1 malformed/, `reason must count malformed attempts: ${result.reason}`)
  assert.ok(!/did not produce a well-formed response/.test(result.reason), 'the false "every attempt was malformed" wording is gone')
  assert.deepEqual(result.test_hashes, RED_OK.test_hashes)
})

test('T1 round 2 F1 (AC-QA-8): three malformed attempts report 3 malformed, no last_evidence; a test_defect after a rejected GREEN carries that evidence and test_hashes', async () => {
  const allBad = await runTdd({ ...DONE, 'implement#1': {}, 'implement#2': {}, 'implement#3': {} })
  assert.match(allBad.result.reason, /3 malformed/, allBad.result.reason)
  assert.match(allBad.result.reason, /0 well-formed/, allBad.result.reason)
  assert.ok(allBad.result.last_evidence === undefined, 'no GREEN verifier ran, so no last_evidence')
  const EV = 'GREEN_BEFORE_DEFECT_EVIDENCE'
  const defect = await runTdd({
    ...DONE, 'implement#1': IMPL, 'verify-green#1': { ...GREEN_RED, evidence: EV }, 'implement#2': TD,
  })
  assert.equal(defect.result.verdict, 'BLOCKED')
  assert.strictEqual(defect.terminal.blocked_reason, 'test_defect')
  assert.strictEqual(defect.result.last_evidence, EV)
  assert.deepEqual(defect.result.test_hashes, RED_OK.test_hashes)
  assert.deepEqual(defect.result.test_defect, TD.test_defect)
})

test('T1 round 2 F2 (AC-DATA-13): the test_defect and malformed-at-cap reasons instruct comparing the sha256 of each test file with test_hashes, and test_hashes is present', async () => {
  const defect = await runTdd({ ...DONE, 'implement#1': TD })
  const capped = await runTdd({ ...DONE, 'implement#1': {}, 'implement#2': {}, 'implement#3': {} })
  for (const [name, r] of [['test_defect', defect.result], ['malformed-at-cap', capped.result]]) {
    assert.match(r.reason, COMPARE_RE, `${name}: ${r.reason}`)
    assert.deepEqual(r.test_hashes, RED_OK.test_hashes, `${name}: test_hashes present`)
  }
})

test('T1 round 2 F3 (spec bug): README documents the stale-writer test_defect neutralisation and the byModel null bucket carries the same three causes as SKILL.md', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').slice(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').indexOf('## Run ledger')).replace(/\s+/g, ' ')
  assert.ok(readme.includes('a `test_defect` blocked_reason is neutralised to null by `degradeEntry`'), 'README must say degradeEntry neutralises test_defect')
  assert.ok(/not an allowed property/.test(readme) && /enum mismatch/.test(readme), 'and name why the stale-writer retry does not handle it (enum mismatch, not "not an allowed property")')
  assert.ok(/stamped 5/.test(readme) && readme.includes('invalid_record_values_dropped'), 'and the stamp 5 and the counter')
  assert.ok(/not recorded/.test(readme) && /reinstall/.test(readme), 'and that such runs read as not recorded until the writer is reinstalled')
  const phrase = 'null when no model was recorded: none was given, or the key was stripped for a stale writer, or the row is degraded'
  assert.ok(readme.includes(phrase), 'README byModel null bucket wording')
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'optimise-cycle', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(skill.includes(phrase), 'SKILL.md byModel null bucket wording is identical')
})
