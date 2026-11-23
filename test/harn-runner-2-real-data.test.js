// HARN-RUNNER-2 whole-branch review round 4: the result check must accept HONEST output on real data. Tidy fixtures, whose durations add up
// exactly in binary, hid a false FAIL (F1: a summed duration printed as 5876.967000000001s is no shape the check knows). So this file renders
// real data end to end: the real collector, the real workflow under the fake runtime with a drafting agent returning two ordinary proposals,
// the workflow's own result_mac (nothing is signed by hand), and the real attended result check, in a temporary clone so nothing is placed in
// this checkout and nothing is written into its .claude directory.
//   real ledger      this repository's own .claude/harness-ledger.jsonl, read only and copied into the clone. It is untracked, so on a CI
//                    checkout it is absent: that test then SKIPS, saying so, and the committed real-shaped fixture below runs in its place.
//   fixture ledger   test/fixtures/harn-runner-2-real-shaped-ledger.jsonl: records in the real ledger's shape whose durations do not sum
//                    exactly in binary (0.1 + 0.2, and 0.015 + 5876.952, the real 5876.967000000001 pattern).
// Each runs twice: with `gh` off PATH (the CI lane cannot run, so the verdict is FAIL with exactly that one fixed reason, and the report is
// still placed under AC-PROD-3), and with a stub `gh` returning a plausible run list (PASS).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { cleanupTempRepos, sanitizedGitEnv } = require('./helpers/temp-repo.js')
const SB = require('./helpers/weekly-sandbox.js')
const T2 = require('./helpers/t2-fixtures.js')

const { F, ROOT, REPORT_REL, SIDECAR_REL, freshDir } = SB
const VERIFY = path.join(ROOT, 'workflows', 'lib', 'optimise-verify.mjs')
const IGNORE = path.join(ROOT, 'workflows', 'lib', 'optimise-report-ignore.mjs')
const LEDGER_REL = path.join('.claude', 'harness-ledger.jsonl')
const FIXTURE_LEDGER = path.join(__dirname, 'fixtures', 'harn-runner-2-real-shaped-ledger.jsonl')

test.after(cleanupTempRepos)

// ---- the two sources ----

// This repository's own ledger, read only: { text } when it exists as a regular file and at least one line parses, else { skip } saying why.
function realLedger() {
  const file = path.join(ROOT, LEDGER_REL)
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch {
    return { skip: `this checkout has no ${LEDGER_REL} (it is untracked, so a CI checkout never has one); the fixture-ledger tests run instead` }
  }
  if (!stat.isFile()) return { skip: `${LEDGER_REL} is not a regular file here; the fixture-ledger tests run instead` }
  const text = fs.readFileSync(file, 'utf8')
  const parses = text.split('\n').some((line) => {
    try {
      return line.trim() !== '' && typeof JSON.parse(line) === 'object'
    } catch {
      return false
    }
  })
  return parses ? { text } : { skip: `${LEDGER_REL} holds no line that parses; the fixture-ledger tests run instead` }
}

// ---- a temporary clone of this repository holding the ledger ----

// A clone of this repository's committed history (read only on this checkout) with the ledger copied in. The clone is what is collected and
// what the check places into, so this checkout and its .claude directory are never written.
function cloneWith(ledgerText) {
  const clone = path.join(freshDir('real-data-'), 'repo')
  const res = spawnSync(F.REAL_GIT, ['clone', '-q', '--no-local', ROOT, clone], { encoding: 'utf8', env: sanitizedGitEnv(), timeout: 120000 })
  assert.equal(res.status, 0, `the clone succeeded: ${res.stderr}`)
  fs.mkdirSync(path.join(clone, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(clone, LEDGER_REL), ledgerText)
  return clone
}

// A plausible run list: three completed runs of two jobs, one failure.
function ghWithRuns() {
  const stubs = F.makeStubs()
  const runs = [21, 22, 23].map((id) => F.run(id))
  F.setGhRuns(stubs, runs, Object.fromEntries(runs.map((r) => [r.databaseId, { jobs: [F.job('test', r.databaseId === 23 ? 'failure' : 'success'), F.job('lint')] }])))
  return stubs
}

function collect(repo, stubs) {
  const outDir = F.scratchDir()
  const res = spawnSync(process.execPath, [F.COLLECTOR, repo, outDir], { cwd: F.scratchDir(), env: F.childEnv(stubs), encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(res.status, 0, `the collector exits 0: ${res.stderr}`)
  return { repo, outDir, digest: JSON.parse(fs.readFileSync(path.join(outDir, 'digest.json'), 'utf8')) }
}

// Two ordinary proposals citing the first thing the ledger lets them cite.
function ordinaryProposals(digest) {
  const citation = digest.ledger.citationPool[0]
  assert.ok(citation, 'guard against vacuity: the collected ledger offers a citation')
  const target = (kind, concern) => ({ kind, component: 'review', concern, lens: '', workflow: '', job: '', touches_always_on_lens: false, security_purposed: false })
  return [
    { target: target('trigger_tune', 'noise'), statement: 'Narrow a trigger glob that matches docs-only changes', motivating_measurement: 'several review runs matched nothing they changed', confirming_measurement: 'fewer clean runs with matches', n: 9, citations: [citation], reinstatement_evidence: null },
    { target: target('process_note', 'waits'), statement: 'Batch human reviews to shorten human waits', motivating_measurement: 'human waits dominate the wall clock', confirming_measurement: 'human_wait per plan falls', n: 7, citations: [citation], reinstatement_evidence: null },
  ]
}

// The real attended result check on a private per-run directory holding the collection and the workflow's result as returned.
function check(c, result) {
  const perRun = freshDir('real-data-run-')
  fs.chmodSync(perRun, 0o700)
  fs.cpSync(c.outDir, perRun, { recursive: true })
  const resultFile = path.join(perRun, 'result.json')
  fs.writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 })
  for (const rel of [REPORT_REL, SIDECAR_REL]) fs.rmSync(path.join(c.repo, rel), { force: true })
  const prep = spawnSync(process.execPath, [IGNORE, 'prepare', c.repo, perRun], { encoding: 'utf8' })
  assert.equal(JSON.parse(prep.stdout).ok, true, `the ignore step prepared the clone: ${prep.stdout}${prep.stderr}`)
  const res = spawnSync(process.execPath, [VERIFY, 'attended', perRun, resultFile, c.repo, c.repo], { encoding: 'utf8', timeout: 90000, cwd: freshDir('cwd-'), env: { ...process.env, HOME: freshDir('home-'), OPTIMISE_VERIFY_NONCE: T2.NONCE } })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  return { out, reasons: [...out.matchAll(/^REASON (.*)$/gm)].map((m) => m[1]), placed: fs.existsSync(path.join(c.repo, REPORT_REL)) }
}

async function renderAndCheck(ledgerText, stubs) {
  const c = collect(cloneWith(ledgerText), stubs)
  const { result } = await runWorkflow(T2.WORKFLOW, { args: { digest: c.digest, nonce: T2.NONCE }, agent: { 'synthesis:proposals': { proposals: ordinaryProposals(c.digest) } } })
  assert.match(String(result.result_mac), /^[0-9a-f]{64}$/, `the workflow accepted the digest and finished: ${String(result.report).slice(0, 200)}`)
  assert.ok(result.proposals_ranked.length + result.proposals_insufficient_data.length > 0, 'guard against vacuity: the drafted proposals reached the report')
  return { c, result, res: check(c, result) }
}

// ---- the verdicts the lanes dictate ----

async function assertCiLaneCouldNotRun(ledgerText) {
  const { result, res } = await renderAndCheck(ledgerText, F.makeStubs({ gh: false }))
  assert.equal(result.lanes.ci.status, 'failed', 'guard against vacuity: with gh off PATH the CI lane did not run')
  assert.match(res.out, /^VERDICT FAIL$/m, res.out)
  assert.equal(res.reasons.length, 1, `exactly one reason, the CI lane's: ${res.reasons}`)
  assert.match(res.reasons[0], /^ci lane could not run: \S+$/, res.out)
  assert.match(res.out, /^PLACE yes$/m, `the report is still placed (AC-PROD-3): ${res.out}`)
  assert.equal(res.placed, true)
}

async function assertPass(ledgerText) {
  const { result, res } = await renderAndCheck(ledgerText, ghWithRuns())
  assert.equal(result.lanes.ci.status, 'ran', 'guard against vacuity: the CI lane ran on the stub run list')
  assert.match(res.out, /^VERDICT PASS$/m, res.out)
  assert.match(res.out, /^PLACE yes$/m, res.out)
  assert.equal(res.placed, true)
}

const real = realLedger()

test('real data (source: this repository\'s own ledger, read only): gh off PATH gives FAIL with exactly the CI lane\'s fixed reason, the report still placed', { skip: real.skip ?? false }, async () => {
  await assertCiLaneCouldNotRun(real.text)
})

test('real data (source: this repository\'s own ledger, read only): a stub gh with a plausible run list gives PASS', { skip: real.skip ?? false }, async () => {
  await assertPass(real.text)
})

test('real data (source: the committed real-shaped fixture ledger, durations that do not sum exactly): gh off PATH gives FAIL with exactly the CI lane\'s fixed reason, the report still placed', async () => {
  await assertCiLaneCouldNotRun(fs.readFileSync(FIXTURE_LEDGER, 'utf8'))
})

test('real data (source: the committed real-shaped fixture ledger, durations that do not sum exactly): a stub gh with a plausible run list gives PASS', async () => {
  await assertPass(fs.readFileSync(FIXTURE_LEDGER, 'utf8'))
})

test('the fixture ledger really holds durations that do not sum exactly in binary, so the tests above exercise F1', () => {
  assert.notEqual(0.1 + 0.2, 0.3)
  assert.equal(String(0.015 + 5876.952), '5876.967000000001')
  const records = fs.readFileSync(FIXTURE_LEDGER, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const ms = (r) => Date.parse(r.ts)
  const spans = new Map()
  for (const r of records.filter((x) => x.kind === 'tdd_task')) spans.set(r.run_id, [...(spans.get(r.run_id) ?? []), ms(r)])
  const durations = [...spans.values()].filter((t) => t.length === 2).map(([a, b]) => Math.abs(b - a) / 1000)
  assert.ok(durations.includes(0.015) && durations.includes(5876.952), `agent-compute durations hold the real pattern: ${durations}`)
  assert.ok(durations.includes(0.1) && durations.includes(0.2), `and 0.1 + 0.2: ${durations}`)
})
