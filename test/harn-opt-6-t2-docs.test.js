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
  assert.match(step, /outcome is not done \(aborted, blocked, thrown, or no lens report collected\)/)
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
