// HARN-OPT-6 T1 gap round (specs/harn-opt-6.md): AC-QA-9, AC-SEC-2 (round_key and lens_checkout_drift),
// AC-OPS-6, AC-DATA-8 and AC-OPS-12. The AC-OPS-4 strengthening lives in test/harn-opt-6-t1.test.js.
// The 06049e4 reader, writer and review-cycle.js are read from git into a temp directory, never from the working tree.
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')
const { findingId: oracleId } = require('./helpers/finding-entries.js')
const { sanitizedGitEnv } = require('./helpers/git-env.js')
const { makeTempRepo, runAppend, readLedgerLines, cleanupTempRepos, SUITE_TMPDIR } = require('./helpers/temp-repo.js')

const ROOT = path.join(__dirname, '..')
const WF = path.join(ROOT, 'workflows', 'review-cycle.js')
const SPEC = path.join(ROOT, 'specs', 'harn-opt-6.md')
// The live ledger is where the writer puts it: the parent of `git rev-parse --path-format=absolute --git-common-dir`, so a
// linked worktree resolves to the MAIN checkout's ledger rather than to an .claude/ of its own that never holds one.
function liveLedgerPath(cwd) {
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', env: sanitizedGitEnv() }).trim()
  return path.join(path.dirname(commonDir), '.claude', 'harness-ledger.jsonl')
}
const LIVE_LEDGER = liveLedgerPath(ROOT)
const OLD = '06049e4'

test.after(cleanupTempRepos)

// ---- the live ledger must be untouched by this whole file (AC-DATA-8) ----
const ledgerStamp = () => (fs.existsSync(LIVE_LEDGER) ? { size: fs.statSync(LIVE_LEDGER).size, sha: createHash('sha256').update(fs.readFileSync(LIVE_LEDGER)).digest('hex') } : null)
const LEDGER_BEFORE = ledgerStamp()
const LIVE_COPY = LEDGER_BEFORE ? fs.readFileSync(LIVE_LEDGER, 'utf8') : null
test.after(() => {
  assert.deepEqual(ledgerStamp(), LEDGER_BEFORE, 'the live ledger changed size or sha256 during this test file')
})

function gitShow(rel) {
  return execFileSync('git', ['show', `${OLD}:${rel}`], { cwd: ROOT, encoding: 'utf8', env: sanitizedGitEnv(), maxBuffer: 64 * 1024 * 1024 })
}
const OLD_DIR = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'old-06049e4-'))
fs.mkdirSync(path.join(OLD_DIR, 'lib'))
fs.writeFileSync(path.join(OLD_DIR, 'lib', 'ledger-append.mjs'), gitShow('workflows/lib/ledger-append.mjs'))
fs.writeFileSync(path.join(OLD_DIR, 'lib', 'optimise-read.mjs'), gitShow('workflows/lib/optimise-read.mjs'))
fs.writeFileSync(path.join(OLD_DIR, 'review-cycle.js'), gitShow('workflows/review-cycle.js'))
fs.writeFileSync(path.join(OLD_DIR, 'plan-cycle.js'), gitShow('workflows/plan-cycle.js'))
fs.writeFileSync(path.join(OLD_DIR, 'tdd-task.js'), gitShow('workflows/tdd-task.js'))
const OLD_WRITER = path.join(OLD_DIR, 'lib', 'ledger-append.mjs')
const OLD_WF = path.join(OLD_DIR, 'review-cycle.js')
const runOldWriter = (repo, payload) => JSON.parse(spawnSync('node', [OLD_WRITER], { cwd: repo, input: JSON.stringify(payload), encoding: 'utf8', env: sanitizedGitEnv() }).stdout.trim().split('\n').pop())
const newWriter = (repo) => (prompt) => JSON.parse(runAppend(repo, extractLedgerPayload(prompt)).stdout.trim().split('\n').pop())
const oldWriterAgent = (repo) => (prompt) => runOldWriter(repo, extractLedgerPayload(prompt))

// ---- fixtures (same shapes as test/review-cycle-finding-ids.test.js) ----
const LEDGER_OK = { run_id: '3c9d1e62-5a7b-4f08-8e21-9b4d6c0a7f13', ts: '2026-08-10T00:00:00.000Z', write_ok: true, write_error: null }
const TIP = { head_sha_measured: 'abcdef1234567890', head_tree_measured: '1111111111111111111111111111111111111111' }
const COVERAGE = { examined: 'x', verified_by: 'y', could_not_check: 'z' }
const CLEAN = { verdict: 'CLEAN', coverage: COVERAGE, findings: [], ...TIP }
const SCOPE_OK = {
  base: 'main', head_sha: 'abcdef1234567890', head_tree: '1111111111111111111111111111111111111111',
  files: [{ path: 'src/foo.js', status: 'M' }], new_dependency_entries: false, new_modules: false, custom_rules: null,
  harness_triggers_file_exists: false,
  consistency: { ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9, doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null },
}
const ALL_LENSES = ['lens-security', 'lens-qa', 'lens-design', 'lens-accessibility', 'lens-product', 'lens-architecture', 'lens-data', 'lens-operability', 'reviewer-verification']
function agents(overrides = {}) {
  return {
    'scope:diff': SCOPE_OK,
    ...Object.fromEntries(ALL_LENSES.map((l) => [l, CLEAN])),
    synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [] },
    'ledger:write': LEDGER_OK,
    ...overrides,
  }
}
async function review(args, overrides, wf = WF) {
  const out = await runWorkflow(wf, { args, agent: agents(overrides) })
  const payloads = out.calls.filter((c) => c.opts.label === 'ledger:write').map((c) => extractLedgerPayload(c.prompt))
  return { ...out, payloads, terminal: payloads.filter((p) => p.outcome !== 'started').pop() }
}
const lensFinding = (claim, location, extra = {}) => ({ severity: 'High', claim, location, evidence: 'e', consequence: 'c', fix: 'f', ...extra })
const withFindings = (findings) => ({ 'lens-security': { verdict: 'FINDINGS', coverage: COVERAGE, findings, ...TIP } })
const confirm = (p) => ({ lens: p.lens, location: p.location, claim: p.claim })
const withId = (p) => ({ ...p, id: oracleId(p.lens, p.location, p.claim) })
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => allStrings(v, out))
  return out
}

// ---- AC-QA-9: the payload size ceiling is a measured number recorded in the spec, and the largest payload stays under it ----
function problemSection() {
  const spec = fs.readFileSync(SPEC, 'utf8')
  const start = spec.indexOf('\n## Problem')
  const end = spec.indexOf('\n## ', start + 1)
  assert.ok(start >= 0 && end > start, 'could not find the Problem section')
  return spec.slice(start, end)
}

test('AC-QA-9: the spec records the payload size measurements under a Payload size paragraph in Problem, and states a byte ceiling', () => {
  const problem = problemSection()
  const para = /\bPayload size\b[\s\S]*/.exec(problem)
  assert.ok(para, 'the Problem section has no "Payload size" paragraph')
  const text = para[0]
  assert.match(text, /cannot be recovered|can no longer be recovered|were never written/i, 'it must say the four stopped payload sizes cannot be recovered')
  assert.match(text, /typical/i, 'it must record the measured size of a typical terminal payload')
  assert.match(text, /largest/i, 'it must record the measured size of the largest accepted terminal payload')
  assert.match(text, /ceiling[^0-9\n]*[0-9][0-9,]*\s*bytes/i, 'it must state the ceiling as "ceiling ... N bytes"')
  const acSection = fs.readFileSync(SPEC, 'utf8').split('\n## Acceptance criteria')[1] || ''
  assert.ok(!/Payload size/.test(acSection), 'the paragraph belongs in Problem, never under Acceptance criteria')
})

// The payload-size measurement itself (the largest payload of conforming values) lives in test/harn-opt-6-r2.test.js, rebuilt
// at fix round 2 after the owner's amendment of AC-QA-9 (verified prior ids are never capped).

// ---- AC-SEC-2: round_key and lens_checkout_drift values are in the closed allowlist, enforced in the script ----
const SHA_ALLOW = /^[0-9a-f]{7,64}$/
test('AC-SEC-2: round_key and every lens_checkout_drift value match ^[0-9a-f]{7,64}$ in both payloads, and a non-conforming drift value never reaches the payload', async () => {
  const hostile = '/home/canary-user/secret $(id) `x`'
  const { payloads, terminal } = await review({}, {
    'lens-qa': { ...CLEAN, __bypassSchemaValidation: true, head_sha_measured: hostile },
    // lens-security runs on the default scope (lens-data does not), so its conforming value can be recorded.
    'lens-security': { ...CLEAN, head_sha_measured: '0123456789abcdef' },
  })
  for (const p of payloads) {
    if ('round_key' in p) assert.match(p.round_key, SHA_ALLOW)
    for (const v of Object.values(p.lens_checkout_drift || {})) assert.match(String(v), SHA_ALLOW, `lens_checkout_drift value outside the allowlist: ${JSON.stringify(v)}`)
  }
  assert.ok(!JSON.stringify(payloads).includes('canary-user'), 'a hostile head_sha_measured reached a payload')
  assert.equal(terminal.lens_checkout_drift['lens-security'], '0123456789abcdef', 'a conforming drift value must still be recorded')
  assert.ok(!('lens-qa' in terminal.lens_checkout_drift) || terminal.lens_checkout_drift['lens-qa'] === null, 'the non-conforming entry must be dropped or nulled')
})

test('AC-SEC-2: a payload with a non-conforming drift value is still accepted by the real writer (the writer schema takes strings only, so the entry is omitted)', async () => {
  const repo = makeTempRepo()
  const { terminal } = await review({}, {
    'lens-qa': { ...CLEAN, __bypassSchemaValidation: true, head_sha_measured: '/home/canary-user/secret' },
    'ledger:write': newWriter(repo),
  })
  assert.ok(terminal)
  const rows = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.equal(rows.at(-1).outcome, 'done', 'the terminal row must land')
  assert.ok(!readLedgerLines(repo).join('\n').includes('canary-user'))
})

// ---- AC-OPS-6 ----
test('AC-OPS-6: every non-zero drop count is named with its reason on one line, and nothing else logs a drop', async () => {
  const stalePrior = { lens: 'lens-qa', location: 'x.js:1', claim: 'stale', id: '0000000000000000' }
  const { logs } = await review({ prior_findings: [stalePrior] }, {
    ...withFindings([lensFinding('c', 'a.js:1', { ac_id: 'free text' })]),
    'lens-qa': { ...CLEAN, __bypassSchemaValidation: true, ac_verdicts: [{ id: 'AC-QA-1', verdict: 'MAYBE', evidence: 'e' }] },
    synthesis: { __bypassSchemaValidation: true, report: '### VERDICT\nFINDINGS', spec_bugs: [{ lens: 'not a lens', location: 'b.js:2', claim: 'c2', severity: 'High' }, null], rejected_findings: [] },
  })
  const lines = logs.filter((l) => /_dropped=/.test(l))
  assert.equal(lines.length, 1, `expected exactly one drop line, got ${JSON.stringify(lines)}`)
  for (const name of ['invalid_prior_ids_dropped', 'invalid_ac_ids_dropped', 'invalid_finding_fields_dropped', 'invalid_record_values_dropped']) assert.match(lines[0], new RegExp(`${name}=[1-9]`))
})

// HARN-OPT-6 simplify-and-finish pass (owner decision 2026-10-28, M2): the writer is the single owner of the fixed-claim rule,
// so the run-time line says how many fixed confirmations were sent and points at the row for the writer's two counts.
test('AC-OPS-6: the drop line says how many fixed confirmations were sent, and the row (not the script) carries invalid_fixed_ids_dropped and duplicate_fixed_ids_dropped', async () => {
  const keep = withId({ lens: 'lens-qa', location: 'k.js:1', claim: 'confirmed once and repeated' })
  const stillOpen = withId({ lens: 'lens-security', location: 'o.js:2', claim: 'confirmed but open again' })
  const repo = makeTempRepo()
  const { logs, terminal } = await review({ spec: 'specs/example.md', round: 2, prior_findings: [keep, stillOpen] }, {
    ...withFindings([lensFinding(stillOpen.claim, stillOpen.location)]),
    synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(keep), confirm(keep), confirm(stillOpen), { lens: 'lens-qa', location: 'never.js:1', claim: 'never open' }] },
    'ledger:write': newWriter(repo),
  })
  const row = readLedgerLines(repo).map((l) => JSON.parse(l)).filter((r) => r.outcome !== 'started').pop()
  assert.equal(row.invalid_fixed_ids_dropped, 2, 'the unmatched claim and the claim that is also open')
  assert.equal(row.duplicate_fixed_ids_dropped, 1, 'the repeated confirmation')
  const lines = logs.filter((l) => /fixed_confirmations_sent=/.test(l))
  assert.equal(lines.length, 1, `expected exactly one fixed_confirmations_sent line, got ${JSON.stringify(logs)}`)
  assert.match(lines[0], /\bfixed_confirmations_sent=4\b/)
  assert.match(lines[0], /see invalid_fixed_ids_dropped and duplicate_fixed_ids_dropped on the row/)
  assert.ok(!logs.some((l) => /\b(invalid|duplicate)_fixed_ids_dropped=\d/.test(l)), 'the script no longer logs a count it does not own')
  assert.ok(!('invalid_fixed_ids_dropped' in terminal) && !('duplicate_fixed_ids_dropped' in terminal), 'the counts are the writer\'s alone')
})

test('AC-OPS-6: fixed_confirmations_sent counts what was sent whatever the writer later decides (a same-round open claim past the 60th included), and is absent when fixed_findings was not supplied or was empty', async () => {
  const many = Array.from({ length: 65 }, (_, i) => lensFinding(`claim ${i}`, `f${i}.js:${i + 1}`))
  const last = withId({ lens: 'lens-security', location: many[64].location, claim: many[64].claim })
  const over = await review({ spec: 'specs/example.md', round: 2, prior_findings: [last] }, {
    ...withFindings(many),
    synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(last)] },
  })
  assert.match(over.logs.join('\n'), /\bfixed_confirmations_sent=1\b/)
  assert.ok(!over.logs.some((l) => /\b(invalid|duplicate)_fixed_ids_dropped=\d/.test(l)))
  const clean = await review({ spec: 'specs/example.md', round: 2, prior_findings: [last] }, { synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(last)] } })
  assert.match(clean.logs.join('\n'), /\bfixed_confirmations_sent=1\b/, 'a valid confirmation is still a confirmation sent')
  const none = await review({ spec: 'specs/example.md', round: 2, prior_findings: [last] }, {})
  assert.ok(!none.logs.some((l) => /fixed_confirmations_sent/.test(l)), 'fixed_findings was not supplied, so nothing was sent')
})

// Fix round 3, item C: the live ledger resolves the way the writer resolves it, from a linked worktree too.
test('C: liveLedgerPath from a linked worktree is the file the writer lands its row in, in the main checkout', () => {
  const main = makeTempRepo()
  const wt = path.join(SUITE_TMPDIR, `wt-${path.basename(main)}`)
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'wt-branch'], { cwd: main, env: sanitizedGitEnv() })
  const out = JSON.parse(runAppend(wt, { schema_version: 1, kind: 'tdd_task', outcome: 'done' }).stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const resolved = liveLedgerPath(wt)
  assert.equal(fs.realpathSync(resolved), fs.realpathSync(path.join(main, '.claude', 'harness-ledger.jsonl')))
  assert.equal(readLedgerLines(main).length, 1, 'the row landed in the main checkout')
  assert.ok(!fs.existsSync(path.join(wt, '.claude', 'harness-ledger.jsonl')), 'the worktree has no ledger of its own')
  assert.notEqual(path.join(wt, '.claude', 'harness-ledger.jsonl'), resolved, 'a join on the worktree root is the wrong answer')
})

test('C: no test file joins the checkout root to .claude/harness-ledger.jsonl directly (it is wrong from a linked worktree)', () => {
  const testDir = __dirname
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.js')).map((f) => path.join(testDir, f))
  const direct = new RegExp(['path\\.join\\(\\s*(?:ROOT|REPO_ROOT|__dirname)\\b[^)]*', "['\"]harness-ledger\\.jsonl['\"]"].join(''))
  const offenders = files.filter((f) => direct.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f))
  assert.deepEqual(offenders, [], 'resolve the live ledger through git --git-common-dir, as the writer does')
})

// ---- AC-DATA-8 and AC-OPS-12 need the reader as it stood at 06049e4 ----
const importFresh = (file) => import(pathToFileURL(file).href)
const plain = (x) => JSON.stringify(x, (k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v))
const rework = (mod, raw) => mod.aggregateRework(mod.parseLedgerContent(raw).records)
const PRIOR = { lens: 'lens-security', location: 'foo.js:10', claim: 'missing auth check', severity: 'High', ac_id: 'AC-SEC-1' }

// Round 1 by the 06049e4 workflow and writer; rounds 2 and 3 by the current workflow and writer, same ledger.
async function crossVersionRepo() {
  const repo = makeTempRepo()
  const r1 = await review({ spec: 'specs/example.md' }, { ...withFindings([lensFinding(PRIOR.claim, PRIOR.location, { ac_id: PRIOR.ac_id })]), 'ledger:write': oldWriterAgent(repo) }, OLD_WF)
  assert.equal(r1.result.open_findings.length, 1, 'the 06049e4 workflow must return the open finding')
  const prior = r1.result.open_findings
  assert.equal(prior[0].id, oracleId(PRIOR.lens, PRIOR.location, PRIOR.claim))
  const fixedSynthesis = { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(PRIOR)] }
  for (const round of [2, 3]) {
    const r = await review({ spec: 'specs/example.md', round, prior_findings: prior }, { synthesis: fixedSynthesis, 'ledger:write': newWriter(repo) })
    assert.equal(r.terminal.finding_entries.filter((e) => e.disposition === 'fixed').length, 1)
  }
  return repo
}

test('AC-DATA-8: an open row from the 06049e4 writer and fixed rows from the new path in two later rounds join under one id and lens, the repeat counted as a duplicate', async () => {
  const repo = await crossVersionRepo()
  const lines = readLedgerLines(repo).map((l) => JSON.parse(l)).filter((r) => r.outcome !== 'started')
  assert.equal(lines.length, 3)
  const id = oracleId(PRIOR.lens, PRIOR.location, PRIOR.claim)
  assert.deepEqual(lines.map((r) => r.findings.map((f) => [f.id, f.lens, f.disposition])), [[[id, 'lens-security', 'open']], [[id, 'lens-security', 'fixed']], [[id, 'lens-security', 'fixed']]])
  const raw = fs.readFileSync(path.join(repo, '.claude', 'harness-ledger.jsonl'), 'utf8')
  const current = rework(await importFresh(path.join(ROOT, 'workflows', 'lib', 'optimise-read.mjs')), raw)
  assert.equal(current.duplicateFixedAcrossRounds, 1)
  const counts = JSON.parse(plain(current.lensDispositionCounts))
  assert.match(plain(counts), /lens-security/)
  assert.equal((plain(counts).match(/lens-security/g) || []).length, 1, 'the finding must be attributed under exactly one lens')
  assert.match(plain(counts), /"open",?:?\s*1|\["open",1\]|"open":1/, `expected one open under lens-security: ${plain(counts)}`)
  assert.match(plain(counts), /"fixed":1|\["fixed",1\]/, `expected exactly one fixed (the repeat is a duplicate): ${plain(counts)}`)
})

test('AC-DATA-8: optimise-read over a copy of the live ledger gives the same rework aggregates as the 06049e4 reader, and the live ledger is not read-modified', { skip: !LIVE_COPY && `UNVERIFIED: no live ledger at ${LIVE_LEDGER} (it is untracked), so the live-copy comparison against the 06049e4 reader did not run` }, async () => {
  const copyDir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'live-copy-'))
  const copy = path.join(copyDir, 'harness-ledger.jsonl')
  fs.writeFileSync(copy, LIVE_COPY)
  const raw = fs.readFileSync(copy, 'utf8')
  const before = plain(rework(await importFresh(path.join(OLD_DIR, 'lib', 'optimise-read.mjs')), raw))
  const after = plain(rework(await importFresh(path.join(ROOT, 'workflows', 'lib', 'optimise-read.mjs')), raw))
  assert.equal(after, before)
  assert.equal(fs.readFileSync(copy, 'utf8'), LIVE_COPY, 'the reader rewrote a line of the ledger copy')
  assert.deepEqual(ledgerStamp(), LEDGER_BEFORE, 'the live ledger changed during the test')
})

// ---- AC-OPS-12: rollback ----
test('AC-OPS-12: rows written by the new path are read by the 06049e4 optimise-read.mjs with no error and the same rework counts as the rows the old path writes for the same round', async () => {
  const oldMod = await importFresh(path.join(OLD_DIR, 'lib', 'optimise-read.mjs'))
  const overrides = { ...withFindings([lensFinding('first', 'a.js:1', { ac_id: 'AC-SEC-1' }), lensFinding('second', 'a.js:2')]), synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: [{ lens: 'lens-qa', location: 'b.js:1', claim: 'sb', severity: 'Low' }], rejected_findings: [{ lens: 'lens-data', location: 'c.js:1', claim: 'rj', severity: 'Low' }] } }
  const newRepo = makeTempRepo()
  const oldRepo = makeTempRepo()
  await review({ spec: 'specs/example.md' }, { ...overrides, 'ledger:write': newWriter(newRepo) })
  await review({ spec: 'specs/example.md' }, { ...overrides, 'ledger:write': oldWriterAgent(oldRepo) }, OLD_WF)
  const read = (repo) => oldMod.parseLedgerContent(fs.readFileSync(path.join(repo, '.claude', 'harness-ledger.jsonl'), 'utf8'))
  const fromNew = read(newRepo)
  assert.deepEqual(fromNew.skipped, [], 'the 06049e4 reader skipped a new-path row')
  assert.ok(fromNew.records.some((r) => r.kind === 'review_cycle' && r.outcome === 'done'))
  assert.equal(plain(oldMod.aggregateRework(fromNew.records)), plain(oldMod.aggregateRework(read(oldRepo).records)))
})

test('AC-OPS-12: a conductor-prior-findings.json written after the change is accepted by the 06049e4 review-cycle id guard with invalid_prior_ids_dropped 0', async () => {
  const repo = makeTempRepo()
  const r1 = await review({ spec: 'specs/example.md' }, { ...withFindings([lensFinding(PRIOR.claim, PRIOR.location, { ac_id: PRIOR.ac_id }), lensFinding('second claim', 'b.js:2')]) })
  assert.equal(r1.result.open_findings.length, 2)
  const stateFile = path.join(repo, '.claude', 'conductor-prior-findings.json')
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify({ 'specs/example.md:T1': r1.result.open_findings }))
  const prior = JSON.parse(fs.readFileSync(stateFile, 'utf8'))['specs/example.md:T1']
  const r2 = await review({ spec: 'specs/example.md', round: 2, prior_findings: prior }, {
    synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(PRIOR)] },
    'ledger:write': oldWriterAgent(repo),
  }, OLD_WF)
  const row = readLedgerLines(repo).map((l) => JSON.parse(l)).filter((r) => r.outcome !== 'started').pop()
  assert.equal(row.invalid_prior_ids_dropped, 0)
  assert.deepEqual(row.findings.filter((f) => f.disposition === 'fixed').map((f) => f.id), [oracleId(PRIOR.lens, PRIOR.location, PRIOR.claim)])
  assert.ok(r2.result)
})

// ---- AC-QA-12: plan-cycle.js and tdd-task.js are otherwise unaffected ----
// The same scripted agents run through each workflow as it stands at 06049e4 (read from git) and as it stands now;
// every ledger payload must deep-equal apart from run_id (the writer mints it, and here the script reuses the scripted one).
const OLD_PLAN_WF = path.join(OLD_DIR, 'plan-cycle.js')
const OLD_TDD_WF = path.join(OLD_DIR, 'tdd-task.js')
const PLAN_WF = path.join(ROOT, 'workflows', 'plan-cycle.js')
const TDD_WF = path.join(ROOT, 'workflows', 'tdd-task.js')
const withoutRunId = ({ run_id, ...rest }) => rest
async function ledgerPayloads(wf, args, agent) {
  const out = await runWorkflow(wf, { args, agent })
  return out.calls.filter((c) => c.opts.label === 'ledger:write').map((c) => withoutRunId(extractLedgerPayload(c.prompt)))
}

const PLAN_SCOPE = {
  head_sha: 'abc1234567890def', summary: 'adds a widget', ui: false, data: false, architecture: false, operability: false, user_facing: true, likely_paths: ['src/widget.js'],
  consistency: { ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9, doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null },
}
const PLAN_LENS = { verdict: 'CLEAN', coverage: COVERAGE, acceptance_criteria: [{ id: 'AC-SEC-1', statement: 'x' }] }
const PLAN_SHA = 'a'.repeat(64)
const planAgent = (overrides = {}) => ({
  'scope:spec': { ...PLAN_SCOPE, spec_snapshot: JSON.stringify({ file: '/tmp/harn-specwb-base/spec.snapshot', sha256: PLAN_SHA, headings: ['## Problem'], ac_ids: [] }) },
  'lens-security': PLAN_LENS,
  'lens-qa': PLAN_LENS,
  'lens-simplicity': { ...PLAN_LENS, acceptance_criteria: [] },
  'lens-product': PLAN_LENS,
  'synthesis:write-back': { summary: '### Summary\n4 criteria', head_sha_at_synthesis: 'abc1234567890def', surviving_ids: [], writeback_check: JSON.stringify({ ok: true, problems: [], restored: false, spec_sha256: 'b'.repeat(64), snapshot_sha256: PLAN_SHA, surviving_ids_checked: [] }) },
  'ledger:write': LEDGER_OK,
  ...overrides,
})
const TDD_DONE = {
  'write-test#1': { test_files: ['a.test.js'], test_command: 'node a.test.js', expected_failure: 'missing fn' },
  'verify-red#1': { red: true, right_reason: true, evidence: 'threw', test_hashes: [{ file: 'a.test.js', sha256: 'abc' }] },
  'implement#1': { summary: 'added fn', files_changed: ['a.js'] },
  'verify-green#1': { green: true, suite_green: true, hashes_match: true, evidence: 'passed' },
  commit: { sha: 'deadbeef', message: 'feat: thing' },
  'ledger:write': LEDGER_OK,
}
const TDD_RED_REJECTED = {
  'write-test#1': TDD_DONE['write-test#1'], 'write-test#2': TDD_DONE['write-test#1'], 'write-test#3': TDD_DONE['write-test#1'],
  'verify-red#1': { red: false, right_reason: false, evidence: 'passed already', test_hashes: [] },
  'verify-red#2': { red: false, right_reason: false, evidence: 'passed already', test_hashes: [] },
  'verify-red#3': { red: false, right_reason: false, evidence: 'passed already', test_hashes: [] },
  'ledger:write': LEDGER_OK,
}
for (const [name, newWf, oldWf, args, agent] of [
  ['plan-cycle.js, all lenses clean', PLAN_WF, OLD_PLAN_WF, { spec: 'specs/foo.md' }, planAgent()],
  ['plan-cycle.js, a lens reports findings', PLAN_WF, OLD_PLAN_WF, { spec: 'specs/foo.md' }, planAgent({ 'lens-qa': { ...PLAN_LENS, verdict: 'FINDINGS' } })],
  ['plan-cycle.js, the scope agent fails', PLAN_WF, OLD_PLAN_WF, { spec: 'specs/foo.md' }, { 'ledger:write': LEDGER_OK }],
  ['tdd-task.js, done', TDD_WF, OLD_TDD_WF, { task: 'do the thing' }, TDD_DONE],
  ['tdd-task.js, RED rejected three times', TDD_WF, OLD_TDD_WF, { task: 'do the thing' }, TDD_RED_REJECTED],
  ['tdd-task.js, the test writer fails', TDD_WF, OLD_TDD_WF, { task: 'do the thing' }, { 'ledger:write': LEDGER_OK }],
]) {
  test(`AC-QA-12: ${name}: the ledger payloads at HEAD deep-equal those at ${OLD}, apart from run_id`, async () => {
    const before = await ledgerPayloads(oldWf, args, agent)
    const after = await ledgerPayloads(newWf, args, agent)
    assert.ok(before.length >= 2, `expected a start and a terminal write at ${OLD}, got ${before.length}`)
    assert.deepEqual(after, before)
    assert.ok(after.every((p) => !('finding_entries' in p)), 'plan-cycle.js and tdd-task.js carry no finding_entries')
  })
}
