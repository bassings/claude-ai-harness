// Static pins for HARN-OPT-6 T2 (specs/harn-opt-6.md: AC-ARCH-11 as amended
// 2026-10-28, AC-OPS-9, AC-OPS-11). Same shape as
// test/conduct-plan-escalation.test.js: pin sentences verbatim after
// whitespace collapse, and reject the old sentences by grep.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')
const flat = (t) => t.replace(/\s+/g, ' ')
const skill = () => flat(read('skills', 'conduct-plan', 'SKILL.md'))
const readme = () => read('README.md')
const { runWorkflow } = require('./helpers/fake-runtime.js')

function openFindingsStep() {
  const s = skill()
  const start = s.indexOf('After `/review-cycle` returns, inspect its `open_findings` field')
  const end = s.indexOf('Do NOT accumulate')
  assert.ok(start !== -1 && end > start, 'could not locate the open_findings inspection step')
  return s.slice(start, end)
}

function writeFailureStep() {
  const s = skill()
  const start = s.indexOf("Check the writer's response every time")
  const end = s.indexOf('`event_scope` (never a pre-built')
  assert.ok(start !== -1 && end > start, 'could not locate the writer-response check')
  return s.slice(start, end)
}

function ledgerSection() {
  const r = flat(readme())
  const start = r.indexOf('## Run ledger')
  assert.ok(start !== -1, 'README has a Run ledger section')
  const next = r.indexOf(' ## ', start + 5)
  return r.slice(start, next === -1 ? undefined : next)
}

test('AC-ARCH-11: open_findings is null only for a not-done run or an older installed review-cycle.js', () => {
  const step = openFindingsStep()
  assert.doesNotMatch(step, /ledger write itself failed/i)
  assert.doesNotMatch(step, /older `ledger-append\.mjs` did not return ids/i)
  assert.match(step, /outcome is not done \(aborted, blocked, or no lens report collected\)/)
  assert.doesNotMatch(step, /blocked, thrown/)
  assert.match(step, /a thrown review surfaces as an error and leaves the stored entry untouched/)
  assert.match(step, /older installed `review-cycle\.js` that returns none/)
  assert.match(step, /open_findings was null for <task id>/, 'tick-log anomaly line kept')
  assert.doesNotMatch(skill(), /did not return ids/i)
})

test('AC-OPS-9: write-failure step records the review ledger line and never hand-writes a review_cycle row', () => {
  const step = writeFailureStep()
  assert.match(step, /ledger_write_failed/)
  assert.match(step, /review ledger not written: <ledger_write_error>/)
  assert.match(step, /never write a replacement `?review_cycle`? row by hand/i)
  assert.doesNotMatch(skill(), /(build|construct|compose|write)[^.]*review_cycle[^.]*row[^.]*from (the )?(returned )?telemetry/i)
  assert.doesNotMatch(skill(), /replacement review_cycle row from/i)
})

test('AC-OPS-11: README Run ledger failure-signal table pins each exact string and remedy', () => {
  const sec = ledgerSection()
  const rc = read('workflows', 'review-cycle.js')
  const la = read('workflows', 'lib', 'ledger-append.mjs')
  // Strings come from the code: a wording change there must break this test.
  const tel = /`(TELEMETRY NOT RECORDED) for this run:/.exec(rc) || /(TELEMETRY NOT RECORDED) for this run:/.exec(rc)
  assert.ok(tel, 'review-cycle.js still emits TELEMETRY NOT RECORDED')
  const predates = 'predates HARN-OPT-6'
  assert.ok(rc.includes(`ledger-append.mjs ${predates}`), 'review-cycle.js still names the stale writer')
  assert.ok(rc.includes('finding_entries: not an allowed property'), 'review-cycle.js still keys on finding_entries')
  const legacy = 'legacy_payload'
  assert.ok(la.includes('legacy_payload: true'), 'writer still sets legacy_payload: true')
  const term = 'Terminal ledger write payload was'
  assert.ok(rc.includes(`${term} \${`) && rc.includes('bytes (base64).'), 'review-cycle.js still emits the terminal size line')

  assert.ok(sec.includes('TELEMETRY NOT RECORDED'), 'signal (a) text')
  assert.ok(sec.includes('finding_entries'), 'signal (a) names finding_entries')
  assert.ok(sec.includes(predates), 'signal (a) names the stale writer')
  assert.ok(sec.includes(legacy + ': true'), 'signal (b) marker')
  assert.match(sec, /legacy_payload: true[^|]*no findings|no findings[^|]*legacy_payload: true/i)
  assert.ok(sec.includes('Terminal ledger write payload was N bytes (base64)'), 'signal (c) text')
  assert.match(sec, /size stop/i)
  assert.ok(sec.includes('bin/install.sh') && sec.includes('bin/install.sh --check'))
  assert.match(sec, /restart the session or dispatch by scriptPath/)
  assert.match(sec, /named workflows are cached per session/)
  // a table: at least three data rows
  assert.ok((sec.match(/\| [^|]*(TELEMETRY NOT RECORDED|legacy_payload|Terminal ledger write payload)/g) || []).length >= 3, 'three table rows')
})

test('M1: a done review with null open_findings means a stale installed review-cycle.js, with the remedy', () => {
  assert.ok(openFindingsStep().includes("If the review's outcome was done and open_findings is still null, the installed review-cycle.js predates HARN-OPT-6 (its ledger row carries legacy_payload: true); run bin/install.sh and bin/install.sh --check, then restart the session or dispatch by scriptPath, and record that in the tick log."))
})

test('L1: both relay instructions tell the conductor to replace home-directory paths with ~', () => {
  const step = writeFailureStep()
  const sentence = 'replace any absolute path under the home directory with ~ before writing it to the tracked plan log'
  assert.ok(step.split(sentence).length - 1 >= 2, 'both the event and the review-ledger relay carry the redaction instruction')
  assert.match(step, /<event> not written: <write_error>[^.]*\.[^.]*replace any absolute path|replace any absolute path[^`]*<event> not written/)
})

test('L1: review-cycle returns ledger_write_error redacted, as its log line already does', async () => {
  const CANARY = '/Users/canary-user/secret/ledger.jsonl'
  const COVERAGE = { examined: 'x', verified_by: 'y', could_not_check: 'z' }
  const TIP = { head_sha_measured: 'abcdef1234567890', head_tree_measured: '1111111111111111111111111111111111111111' }
  const CLEAN = { verdict: 'CLEAN', coverage: COVERAGE, findings: [], ...TIP }
  const OK = { run_id: '3c9d1e62-5a7b-4f08-8e21-9b4d6c0a7f13', ts: '2026-08-10T00:00:00.000Z', write_ok: true, write_error: null }
  const SCOPE = {
    base: 'main', head_sha: 'abcdef1234567890', head_tree: '1111111111111111111111111111111111111111',
    files: [{ path: 'src/foo.js', status: 'M' }], new_dependency_entries: false, new_modules: false, custom_rules: null,
    harness_triggers_file_exists: false,
    consistency: { ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9, doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null },
  }
  const lenses = ['lens-design', 'lens-accessibility', 'lens-product', 'lens-architecture', 'lens-data', 'lens-operability', 'reviewer-verification']
  const agent = {
    'scope:diff': SCOPE, 'lens-security': CLEAN, 'lens-qa': CLEAN,
    ...Object.fromEntries(lenses.map((l) => [l, CLEAN])),
    synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [] },
    'ledger:write': [OK, { run_id: 'r', ts: 't', write_ok: false, write_error: `cannot write ${CANARY}` }],
  }
  const { result } = await runWorkflow(path.join(ROOT, 'workflows', 'review-cycle.js'), { args: {}, agent })
  assert.equal(result.ledger_write_failed, true)
  assert.ok(typeof result.ledger_write_error === 'string' && result.ledger_write_error.includes('cannot write'), 'error text still returned')
  assert.ok(!result.ledger_write_error.includes('/Users/canary-user'), `home path leaked: ${result.ledger_write_error}`)
  assert.ok(result.ledger_write_error.includes('<redacted-path>'))
})

test('L2: spec AC-ARCH-11 amendment no longer lists thrown among the null cases', () => {
  const line = read('specs', 'harn-opt-6.md').split('\n').find((l) => l.startsWith('- **AC-ARCH-11:**'))
  assert.ok(line, 'AC-ARCH-11 found')
  assert.doesNotMatch(line, /blocked, thrown/)
  assert.match(flat(line), /a thrown review surfaces as an error and leaves the stored entry untouched/)
})

function ledgerRows() {
  const lines = readme().split('\n')
  const rows = {}
  for (const k of ['a', 'b', 'c']) {
    const row = lines.find((l) => l.startsWith(`| (${k}) `))
    assert.ok(row, `README row (${k}) present`)
    const cells = row.split('|').map((c) => c.trim())
    rows[k] = { signal: cells[2], remedy: cells[4] }
  }
  return rows
}

test('L3/AC-OPS-11: each README row carries its own signal and its own remedy', () => {
  const r = ledgerRows()
  const install = (x) => x.includes('bin/install.sh') && x.includes('bin/install.sh --check') && /restart the session or dispatch by scriptPath/.test(x) && /named workflows are cached per session/.test(x)
  assert.ok(r.a.signal.includes('TELEMETRY NOT RECORDED') && r.a.signal.includes('finding_entries') && r.a.signal.includes('predates HARN-OPT-6'))
  assert.ok(install(r.a.remedy), 'row (a) remedy')
  assert.ok(r.b.signal.includes('legacy_payload: true'))
  assert.ok(install(r.b.remedy), 'row (b) remedy')
  assert.ok(r.c.signal.includes('Terminal ledger write payload was N bytes (base64)'))
  assert.ok(!install(r.c.remedy), 'row (c) is not an install remedy')
})

test('L4/L5: README row (c) names every way past the ceiling and a standing remedy', () => {
  const c = flat(ledgerRows().c.remedy)
  assert.match(c, /more than 60 findings in one disposition or more than 60 prior ids or fixed confirmations/)
  assert.match(c, /record the stop and its size in the plan's conductor log/)
  assert.match(c, /treat a repeat as grounds to reopen the transport spec/)
  assert.match(c, /\(the AC-QA-13 tally[^)]*acceptance window[^)]*\)/)
  assert.doesNotMatch(c, /which only a round with more than 60 findings in one disposition can reach/)
})
