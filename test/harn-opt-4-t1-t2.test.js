// HARN-OPT-4 T1 + T2 (specs/harn-opt-4.md): a full review's findings are held
// instead of cut at 15 (T2), and a finding whose lens label names more than one
// roster lens is attributed to the first (T1). HARN-OPT-6 moved that label
// resolution out of the writer and into review-cycle.js, so the T1 compound-label
// tests now live in test/review-cycle-finding-ids.test.js; what remains here is
// what the writer still does with already-resolved ids. Everything runs through
// the real writer script in a temp repo, so these prove the written line rather
// than an internal call.
// Never point these at the real ledger: makeTempRepo() is a throwaway repo.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { APPEND_SCRIPT, makeTempRepo, runAppend: runAppendIds, readLedgerLines, cleanupTempRepos } = require('./helpers/temp-repo.js')
const { toFindingEntries } = require('./helpers/finding-entries.js')

// HARN-OPT-6: the writer takes finding ids, so a round described as descriptors
// is converted to the id-bearing payload review-cycle.js sends.
function runAppend(repo, payload, ...rest) {
  return runAppendIds(repo, toFindingEntries(payload), ...rest)
}

const APPEND_MODULE_URL = pathToFileURL(APPEND_SCRIPT).href
const READ_MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'workflows', 'lib', 'optimise-read.mjs')).href

test.after(cleanupTempRepos)

const envelope = () => ({
  kind: 'review_cycle',
  outcome: 'done',
  spec: 'a.md',
  lenses_run: ['lens-security', 'lens-qa'],
  verdicts: { 'lens-security': 'FINDINGS', 'lens-qa': 'CLEAN' },
  ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'PASS' }],
})

// Writes one review_cycle row carrying the given open findings and returns
// the parsed CLI result plus the parsed ledger line.
function writeOpen(lensLabels, extra = {}) {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    ...envelope(),
    ...extra,
    open_findings: lensLabels.map((lens, i) => ({ lens, location: `a.js:${i + 1}`, claim: `claim ${i}` })),
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, `expected exactly one line, stderr: ${res.stderr}`)
  return { out, raw: lines[0], entry: JSON.parse(lines[0]) }
}

// Moved from 4 to 5 by HARN-OPT-4 T8: budget_spent changed meaning from a
// session running total to a per-run delta, which is a second bump (AC-OPS-3).
test('T1: SCHEMA_VERSION is 6 (T1 bumped to 4, T8 to 5, HARN-OPT-5 T1 to 6) so post-change rows are separable from legacy rows (AC-OPS-3)', async () => {
  const { SCHEMA_VERSION } = await import(APPEND_MODULE_URL)
  assert.equal(SCHEMA_VERSION, 6)
})

test('T2: MAX_FINDINGS is at least 60 (AC-SIMP-1)', async () => {
  const { MAX_FINDINGS } = await import(APPEND_MODULE_URL)
  assert.ok(MAX_FINDINGS >= 60, `MAX_FINDINGS is ${MAX_FINDINGS}`)
})

test('T2: 50 findings at the measured maximum size plus 96 ac_verdicts write findings_truncated 0 inside MAX_LINE_BYTES (AC-QA-5)', async () => {
  const { MAX_LINE_BYTES } = await import(APPEND_MODULE_URL)
  const labels = Array.from({ length: 50 }, (_, i) => (i % 2 ? 'lens-security' : 'lens-architecture'))
  const ac_verdicts = Array.from({ length: 96 }, (_, i) => ({ ac_id: `AC-QA-${i + 1}`, verdict: 'PASS' }))
  const { out, raw, entry } = writeOpen(labels, { ac_verdicts })
  assert.equal(out.write_ok, true, out.write_error)
  assert.equal(entry.findings.length, 50)
  assert.equal(entry.findings_truncated, 0)
  assert.equal(entry.ac_verdicts.length, 96)
  assert.ok(Buffer.byteLength(raw) <= MAX_LINE_BYTES, `line was ${Buffer.byteLength(raw)} bytes`)
  assert.ok(entry.findings.every((f) => Buffer.byteLength(JSON.stringify(f)) <= 150), 'fixture findings sit at the measured maximum (about 144 bytes)')
  // Review round 1, L4 (AC-PROD-1): every one of these 50 findings carries a
  // roster lens, so the reader must account for all 50 and leave none
  // unattributed.
  const mod = await import(READ_MODULE_URL)
  const rework = mod.aggregateRework([{ ...entry, repo: 'demo' }])
  const perLens = Object.values(rework.lensDispositionCounts).reduce((n, c) => n + c.fixed + c.rejected + c.spec_bug + c.open, 0)
  assert.equal(rework.unattributedFindings, 0, 'no roster-lens finding may be unattributed')
  assert.equal(perLens + rework.unattributedFindings, 50, 'per-lens totals plus unattributed account for all 50 findings')
})

test('T2: 400 findings with 400 distinct hostile lens strings still write a full envelope inside MAX_LINE_BYTES (AC-SEC-3)', async () => {
  const { MAX_LINE_BYTES, MAX_FINDINGS } = await import(APPEND_MODULE_URL)
  const pathLens = '/Users/scott/very-private-project-dir'
  const tokenLens = 'ghp_' + 'Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'
  assert.equal(tokenLens.length, 40)
  const labels = [pathLens, tokenLens, ...Array.from({ length: 398 }, (_, i) => `lens-${'abcdefghij'[i % 10]}${String.fromCharCode(97 + (Math.floor(i / 10) % 26))}${String.fromCharCode(97 + (Math.floor(i / 260) % 26))}${'klmnopqrst'[i % 10]}${i}`.replace(/[0-9]/g, (d) => 'abcdefghij'[d]))]
  assert.equal(new Set(labels).size, 400)
  const ac_verdicts = Array.from({ length: 96 }, (_, i) => ({ ac_id: `AC-QA-${i + 1}`, verdict: 'PASS' }))
  const { out, raw, entry } = writeOpen(labels, { ac_verdicts })
  assert.equal(out.write_ok, true, out.write_error)
  assert.ok(Buffer.byteLength(raw) <= MAX_LINE_BYTES, `line was ${Buffer.byteLength(raw)} bytes`)
  assert.ok(entry.findings.length <= MAX_FINDINGS)
  assert.ok(entry.findings.length >= 60, `only ${entry.findings.length} findings survived the raised cap`)
  assert.deepEqual(entry.lenses_run, ['lens-security', 'lens-qa'])
  assert.deepEqual(entry.verdicts, { 'lens-security': 'FINDINGS', 'lens-qa': 'CLEAN' })
  assert.ok(entry.ac_verdicts.length > 0)
  assert.equal(raw.includes('/Users/'), false, 'the path-shaped lens must never reach the line')
  assert.equal(raw.includes(tokenLens), false, 'the full token-shaped lens must never reach the line (lens_raw is bounded)')
})

// Review round 1, L3 (spec bug): '+' with no space before the path slipped
// past ABSOLUTE_PATH_RE's prefix class. Every *_raw field fed by redactPaths
// shares that gap, so ac_id_raw is pinned too. (The lens_raw half moved with
// compound-label resolution into review-cycle.js, which now keeps no *_raw.)
test('L3: a path directly after "+" is redacted in ac_id_raw', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { ...envelope(), open_findings: [{ lens: 'lens-qa', location: 'a.js:1', claim: 'c', ac_id: 'AC-QA-1+/Users/x' }] })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const raw = readLedgerLines(repo)[0]
  assert.equal(raw.includes('/Users/'), false, 'ac_id_raw must redact a path glued to "+"')
})
