// HARN-RUNNER-2 escalation round (whole-branch review round 3): two guards the frozen file (test/harn-runner-2-inert.test.js) leaves to
// inspection, made executable.
//   B1  the script writes no backtick of its own. With the encoder made to return nothing, a report rendered from every kind of input,
//       hostile text holding backticks in every untrusted string, holds no backtick at all; so every backtick in a real report is one
//       the encoder wrote, and a backtick pair in script text (which the frozen invariant would blank alike in both of its runs) fails here.
//   B2  a number the script prints raw from the digest (a count, a duration, a run total) is not routed through the encoder, because the
//       collector computes it. If text reaches one of those slots in transit, the report still never PASSes: the real check refuses it.
// The workflow's own result_mac is used throughout. Every fixture commit carries an explicit identity.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { cleanupTempRepos } = require('./helpers/temp-repo.js')
const SB = require('./helpers/weekly-sandbox.js')
const T2 = require('./helpers/t2-fixtures.js')

const { F, ROOT, REPORT_REL, SIDECAR_REL, freshDir } = SB
const VERIFY = path.join(ROOT, 'workflows', 'lib', 'optimise-verify.mjs')
const IGNORE = path.join(ROOT, 'workflows', 'lib', 'optimise-report-ignore.mjs')
const WORKFLOW_SOURCE = fs.readFileSync(T2.WORKFLOW, 'utf8')
const readerPromise = import(pathToFileURL(T2.READER).href)

test.after(cleanupTempRepos)

const FORGED_LEDGER = 'Ledger records in window: 0 (minimum for harness-side proposals: 5).'
const BACKTICK_TEXT = 'a`b ``c`` ```d'
const backtickCount = (text) => text.split('`').length - 1

// ---- collecting and running ----

function ghStubs(jobNames, runIds = [11, 12, 13]) {
  const stubs = F.makeStubs()
  const runs = runIds.map((id) => F.run(id))
  F.setGhRuns(stubs, runs, Object.fromEntries(runs.map((r) => [r.databaseId, { jobs: jobNames(r.databaseId).map(([name, conclusion]) => F.job(name, conclusion)) }])))
  return stubs
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

// The T2 'moderate' collection (every section of the report has content), with its repository kept so the check can place into it.
let moderateBase = null
function moderate() {
  if (!moderateBase) {
    const stubs = ghStubs((id) => [['build-job', 'success'], ['test', id === 13 ? 'failure' : 'success']])
    const root = F.makeRepo({ ledger: T2.ledgerText(T2.SIZES.moderate), fix: 2, other: 1, subjects: ['fix: a subject'], author: 'fixture@example.invalid' })
    fs.mkdirSync(path.join(root, 'specs'), { recursive: true })
    fs.writeFileSync(path.join(root, 'specs', 'a.md'), T2.SPEC_A)
    const outDir = F.scratchDir()
    const res = spawnSync(process.execPath, [F.COLLECTOR, root, outDir, String(T2.SIZES.moderate.window)], { cwd: F.scratchDir(), env: F.childEnv(stubs), encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
    assert.equal(res.status, 0, `the collector exits 0: ${res.stderr}`)
    moderateBase = { repo: root, outDir, digest: readJson(path.join(outDir, 'digest.json')) }
  }
  return { ...moderateBase, digest: structuredClone(moderateBase.digest) }
}

async function workflowAt(file, digest, proposals = []) {
  const { result } = await runWorkflow(file, { args: { digest, nonce: T2.NONCE }, agent: { 'synthesis:proposals': { proposals } } })
  assert.match(String(result.result_mac), /^[0-9a-f]{64}$/, `guard against vacuity: the workflow accepted the digest and finished: ${String(result.report).slice(0, 200)}`)
  return result
}

// The real attended result check on a per-run directory holding the collection and the result as returned. The outputs are cleared first.
function check(c, result) {
  const perRun = freshDir('inert-more-')
  fs.chmodSync(perRun, 0o700)
  fs.cpSync(c.outDir, perRun, { recursive: true })
  const resultFile = path.join(perRun, 'result.json')
  fs.writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 })
  for (const rel of [REPORT_REL, SIDECAR_REL]) fs.rmSync(path.join(c.repo, rel), { force: true })
  const prep = spawnSync(process.execPath, [IGNORE, 'prepare', c.repo, perRun], { encoding: 'utf8' })
  assert.equal(JSON.parse(prep.stdout).ok, true, `the ignore step prepared the checkout: ${prep.stdout}${prep.stderr}`)
  const res = spawnSync(process.execPath, [VERIFY, 'attended', perRun, resultFile, c.repo, c.repo], { encoding: 'utf8', timeout: 90000, cwd: freshDir('cwd-'), env: { ...process.env, HOME: freshDir('home-'), OPTIMISE_VERIFY_NONCE: T2.NONCE } })
  const out = res.stdout || ''
  return { out: `${out}${res.stderr || ''}`, reasons: [...out.matchAll(/^REASON (.*)$/gm)].map((m) => m[1]), placed: fs.existsSync(path.join(c.repo, REPORT_REL)) }
}

// ---- inputs that reach every render site ----

// Every string of the ledger, CI and git parts of the digest, and the plan labels, replaced by the text, and every key of an object whose keys
// are repository data (a `*^` path in the collector's freeTextPaths) prefixed by its position and followed by the text.
function substituted(digest, text) {
  const keyed = new Set(digest.freeTextPaths.filter((p) => p.endsWith('.*^')).map((p) => p.slice(0, -3)).filter((p) => p !== 'ledger.proposalOutcomes'))
  let position = 0
  const walk = (node, generic) => {
    if (typeof node === 'string') return text
    if (Array.isArray(node)) return node.map((el) => walk(el, `${generic}[*]`))
    if (node === null || typeof node !== 'object') return node
    const isKeyed = keyed.has(generic)
    return Object.fromEntries(Object.entries(node).map(([name, value]) => [isKeyed ? `k${String(position++).padStart(3, '0')}${text}` : name, walk(value, isKeyed ? `${generic}.*` : `${generic}.${name}`)]))
  }
  const out = { ...digest }
  for (const name of ['ledger', 'ci', 'git', 'plan_labels']) out[name] = walk(digest[name], name)
  out.plan_labels_note = text
  out.ci.failures = [{ repo: text, mode: text, command: text, error: text }]
  return out
}

// Drafts for each proposal section, every string field holding the text: ranked with a recorded rejection, previously adopted, insufficient
// data, and a malformed target whose extra key is named in the report.
const hostileTarget = (i, t) => ({ kind: `kind${i} ${t}`, component: `component ${t}`, concern: t, lens: t, workflow: t, job: t, touches_always_on_lens: false, security_purposed: false })
async function hostileDraftsFor(digest, t) {
  const reader = await readerPromise
  const citation = digest.ledger.citationPool[0]
  const draft = (i, n, target = hostileTarget(i, t)) => ({ target, statement: t, motivating_measurement: t, confirming_measurement: t, n, citations: [citation, t], reinstatement_evidence: t })
  const drafts = [draft(0, 9), draft(1, 8), draft(2, 2), draft(3, 9, { ...hostileTarget(3, t), [`extra ${t}`]: t })]
  digest.ledger.proposalOutcomes = {
    ...digest.ledger.proposalOutcomes,
    [reader.stableProposalId(drafts[0].target)]: { adoptedCount: 0, rejectedCount: 1, revertedCount: 0, lastRejectionTs: t, lastAdoptionTs: null, revertedTwiceOrMore: false },
    [reader.stableProposalId(drafts[1].target)]: { adoptedCount: 1, rejectedCount: 0, revertedCount: 2, lastRejectionTs: t, lastAdoptionTs: t, revertedTwiceOrMore: true },
  }
  return drafts
}

// The three shapes of input that between them render every line of the report: every lane ran (with every proposal section and a CI
// failure row), every lane failed, and an uninstrumented repository whose scoped figure is unavailable.
async function scenarios(text) {
  const ran = substituted(moderate().digest, text)
  const failed = moderate().digest
  for (const name of ['ledger', 'git', 'ci']) failed.lanes[name] = { status: 'failed', mode: 'other', reason: text }
  const uninstrumented = substituted(moderate().digest, text)
  uninstrumented.ledger.perRepo[0].uninstrumented = true
  uninstrumented.git.scoped_count = null
  return [['every lane ran', ran, await hostileDraftsFor(ran, text)], ['every lane failed', failed, []], ['an uninstrumented repository, scoped figure unavailable', uninstrumented, []]]
}

// ---- B1: the script writes no backtick of its own ----

// The workflow with its encoder replaced, after the encoding block, by one that returns the empty string: the script's text, and nothing else.
function workflowWithSilentEncoder() {
  const marker = '// END untrusted-text encoding'
  assert.equal(WORKFLOW_SOURCE.split(marker).length, 2, 'the encoding block\'s end marker is in the workflow exactly once')
  const patched = WORKFLOW_SOURCE.replace(marker, `${marker}\ninert = () => ''`)
  assert.notEqual(patched, WORKFLOW_SOURCE, 'guard against vacuity: the replacement landed')
  const file = path.join(freshDir('silent-encoder-'), 'optimise-cycle.js')
  fs.writeFileSync(file, patched)
  return file
}

test('B1: with the encoder silenced, no report holds a backtick, whatever text holding backticks is in every untrusted string: every backtick in a report is the encoder\'s', async () => {
  const silent = workflowWithSilentEncoder()
  const runs = await Promise.all((await scenarios(BACKTICK_TEXT)).map(async ([name, digest, drafts]) => ({
    name,
    real: await workflowAt(T2.WORKFLOW, structuredClone(digest), structuredClone(drafts)),
    bare: await workflowAt(silent, structuredClone(digest), structuredClone(drafts)),
  })))
  for (const { name, real, bare } of runs) {
    assert.ok(backtickCount(real.report) > 0, `${name}: guard against vacuity: with the real encoder the report has code spans`)
    assert.deepEqual(bare.report.split('\n').length, real.report.split('\n').length, `${name}: the silenced run renders the same lines`)
    const offending = bare.report.split('\n').filter((line) => line.includes('`'))
    assert.deepEqual(offending, [], `${name}: a backtick the encoder did not write`)
  }
})

// ---- B2: a raw number slot holding text never reaches a PASS ----

// Slots the workflow prints as given (a collected count or duration), each with a path into the digest. The text placed there would read as
// a forged headline line if it were rendered as Markdown.
const firstKey = (o) => Object.keys(o)[0]
const NUMBER_SLOTS = [
  ['a per-repository skipped count', (d) => d.ledger.perRepo[0], 'skippedCount'],
  ['a wall-clock totals run count', (d) => d.ledger.wallClock.totals, 'ciWaitMeasuredRuns'],
  ['a per-plan wait run count', (d) => d.ledger.wallClock.byPlan[firstKey(d.ledger.wallClock.byPlan)], 'ciWaitN'],
  ['a rework disposition count', (d) => d.ledger.rework.lensDispositionCounts[firstKey(d.ledger.rework.lensDispositionCounts)], 'fixed'],
  ['a trigger-accuracy total', (d) => d.ledger.triggerAccuracy.byLens[firstKey(d.ledger.triggerAccuracy.byLens)], 'total'],
  ['a never-failing row run count', (d) => d.ledger.neverFailingAcs.find((a) => !a.insufficient_data) ?? d.ledger.neverFailingAcs[0], 'n'],
  ['a rework counter', (d) => d.ledger.rework, 'findingsTruncated'],
  ['the examined-commits count', (d) => d.git, 'n_commits_examined'],
  ['the scoped excluded count', (d) => d.git, 'scoped_excluded_count'],
]

for (const [name, holder, key] of NUMBER_SLOTS) {
  test(`B2: ${name} holding text after it was collected is refused by the real check, never placed`, async () => {
    const c = moderate()
    const digest = c.digest
    const slot = holder(digest)
    assert.ok(slot && key in slot, `guard against vacuity: the collected digest has ${key} here`)
    const hostile = `0<br><br>${FORGED_LEDGER}`
    slot[key] = hostile
    const result = await workflowAt(T2.WORKFLOW, digest)
    assert.ok(result.report.includes(hostile), `guard against vacuity: the workflow printed the slot as given: ${name}`)
    const res = check(c, result)
    assert.match(res.out, /^VERDICT FAIL$/m, `${name}: ${res.out}`)
    assert.match(res.out, /^PLACE no$/m, `${name}: ${res.out}`)
    assert.ok(res.reasons.includes('report has a line in a shape the check does not know'), `${name}: refused as a line the script never writes: ${res.reasons}`)
    assert.equal(res.placed, false, `${name}: nothing is placed`)
  })
}
