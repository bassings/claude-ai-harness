// HARN-RUNNER-2 whole-branch fix round 1 (T2 to T4 together): the findings of the whole-branch review that are tests.
//   M2  the workflow returns a keyed digest (result_mac) over everything the result check places or acts on, and the check refuses
//       a reply whose text was edited after the workflow returned it; a proposal that removes an always-on lens is refused too.
//   M1  a report cannot carry a forged headline figure beside or instead of the true one (look-alike lines, comments, invisible characters).
// The MAC's byte sequence is pinned here once more, independently of both implementations:
//   sha256( nonce \n report \n canonicalJson(proposal_targets) \n canonicalJson(lanes) ), UTF-8, canonicalJson = keys sorted at every depth.
// Every fixture commit carries an explicit identity. Figures a test expects come from its own fixtures.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { cleanupTempRepos } = require('./helpers/temp-repo.js')
const SB = require('./helpers/weekly-sandbox.js')
const T2 = require('./helpers/t2-fixtures.js')

const { F, ROOT, REPORT_REL, SIDECAR_REL, freshDir, marker, runRunner } = SB
const VERIFY = path.join(ROOT, 'workflows', 'lib', 'optimise-verify.mjs')
const WORKFLOW_SOURCE = fs.readFileSync(T2.WORKFLOW, 'utf8')
const AUTHOR = 'canary-author@example.invalid'
const IGNORE = path.join(ROOT, 'workflows', 'lib', 'optimise-report-ignore.mjs')
const load = () => import(pathToFileURL(VERIFY).href)
const readerPromise = import(pathToFileURL(T2.READER).href)

test.after(cleanupTempRepos)

const { macOf: macWith, resign: resignWith } = require('./helpers/result-mac.js')
const macOf = (result, nonce = T2.NONCE) => macWith(result, nonce)
const resign = (result) => resignWith(result, T2.NONCE)

function ghStubs() {
  const stubs = F.makeStubs()
  const runs = [11, 12].map((id) => F.run(id))
  F.setGhRuns(stubs, runs, Object.fromEntries(runs.map((r) => [r.databaseId, { jobs: [F.job('build'), F.job('test')] }])))
  return stubs
}

// One collection and the workflow's own returned object for it; `make` saves a per-run directory holding a (possibly altered) copy.
async function collected({ ledgerText = F.validLedger(5), proposals = [], repo: given = null } = {}) {
  const repo = given ?? F.makeRepo({ ledger: ledgerText, fix: 2, other: 1, author: AUTHOR })
  const { outDir } = F.collect(ghStubs(), repo)
  const digest = JSON.parse(fs.readFileSync(path.join(outDir, 'digest.json'), 'utf8'))
  const drafted = typeof proposals === 'function' ? proposals(digest) : proposals
  const { result } = await runWorkflow(T2.WORKFLOW, { args: { digest, nonce: T2.NONCE }, agent: { 'synthesis:proposals': { proposals: drafted } } })
  return {
    repo,
    result,
    digest,
    make(alter, { sign = true } = {}) {
      const perRun = freshDir('whole-')
      fs.chmodSync(perRun, 0o700)
      fs.cpSync(outDir, perRun, { recursive: true })
      const copy = structuredClone(result)
      if (alter) alter(copy)
      if (sign) resign(copy)
      const resultFile = path.join(perRun, 'result.json')
      fs.writeFileSync(resultFile, JSON.stringify(copy), { mode: 0o600 })
      return { repo, perRun, resultFile, result: copy }
    },
  }
}

function attended(run, { skipProof = false } = {}) {
  if (!skipProof) assert.equal(JSON.parse(spawnSync(process.execPath, [IGNORE, 'prepare', run.repo, run.perRun], { encoding: 'utf8' }).stdout).ok, true)
  const res = spawnSync(process.execPath, [VERIFY, 'attended', run.perRun, run.resultFile, run.repo, run.repo], { encoding: 'utf8', timeout: 90000, cwd: freshDir('cwd-'), env: { ...process.env, HOME: freshDir('home-'), OPTIMISE_VERIFY_NONCE: T2.NONCE } })
  return { ...res, out: res.stdout || '' }
}
const reasons = (out) => [...out.matchAll(/^REASON (.*)$/gm)].map((m) => m[1])

function seed(repo) {
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, REPORT_REL), '# Delivery optimiser report\n\nThe last good report.\n')
  fs.writeFileSync(path.join(repo, SIDECAR_REL), '{}\n')
  return [fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8')]
}
const kept = (repo, before) => assert.deepEqual([fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8')], before, 'the last good report and sidecar are untouched')

// ---- M2: the keyed digest ----

test('M2: the workflow returns result_mac, the SHA-256 of the nonce, the report, the canonical targets and the canonical lanes, each followed by a newline except the last', async () => {
  const { result } = await collected()
  assert.equal(result.result_mac, macOf(result), 'the byte sequence the comment in the workflow and in the result check defines')
  assert.match(result.result_mac, /^[0-9a-f]{64}$/)
  assert.ok(Object.hasOwn(result, 'nonce_sha256'), 'the nonce echo is kept (the criteria name it) but nothing relies on it alone')
})

// The workflow's own hash block, lifted out as the proposal-id parity test lifts it, against the result check's.
function workflowMac() {
  const start = WORKFLOW_SOURCE.indexOf('const SHA256_K = [')
  const end = WORKFLOW_SOURCE.indexOf('// END proposal-id block')
  assert.ok(start > 0 && end > start, 'the proposal-id block markers are in the workflow')
  return new Function(`${WORKFLOW_SOURCE.slice(start, end)}\nreturn typeof resultMacOf === 'function' ? resultMacOf : null`)()
}

const PARITY_REPORTS = ['', '# Report\n', '# Rapporté 日本語\n', '# Astral 😀 𝒜 end\n', 'line one\r\nline two\r\n', ' trailing space \n', '# Lone \ud800 surrogate\n', 'x'.repeat(10000)]
const PARITY_TARGETS = [{}, { a: { b: 1, a: 2 }, 'é': [3, { z: null, y: true }] }, { b: 1, a: 2 }, { a: 2, b: 1 }, { '😀': 'x' }]
const PARITY_LANES = [{ ledger: { status: 'ran', mode: null, reason: null }, git: { status: 'failed', mode: 'other', reason: 'a reason' }, ci: { status: 'ran', mode: null, reason: null } }, {}]

test('M2: the workflow\'s keyed digest and the result check\'s agree over reports and targets with non-ASCII, astral characters, CRLF, an empty report, empty targets and every key order', async () => {
  const mac = workflowMac()
  assert.equal(typeof mac, 'function', 'the workflow declares resultMacOf inside its proposal-id block')
  const { resultMac } = await load()
  let compared = 0
  for (const report of PARITY_REPORTS) {
    for (const targets of PARITY_TARGETS) {
      for (const lanes of PARITY_LANES) {
        for (const nonce of [T2.NONCE, T2.OTHER_NONCE]) {
          const expected = macOf({ report, proposal_targets: targets, lanes }, nonce)
          assert.equal(mac(nonce, report, targets, lanes), expected, `workflow: ${JSON.stringify(report).slice(0, 30)}`)
          assert.equal(resultMac({ report, proposal_targets: targets, lanes }, nonce), expected, `result check: ${JSON.stringify(report).slice(0, 30)}`)
          compared += 1
        }
      }
    }
  }
  assert.equal(compared, PARITY_REPORTS.length * PARITY_TARGETS.length * PARITY_LANES.length * 2, 'guard against vacuity: every combination was compared')
  assert.notEqual(mac(T2.NONCE, '', {}, {}), mac(T2.NONCE, '', {}, { a: 1 }), 'the lanes are in the digest')
  assert.notEqual(mac(T2.NONCE, '', {}, {}), mac(T2.NONCE, 'x', {}, {}), 'the report is in the digest')
  assert.notEqual(mac(T2.NONCE, '', {}, {}), mac(T2.NONCE, '', { a: 1 }, {}), 'the targets are in the digest')
})

// What the review did: an edit between the workflow's return and the result check. Unsigned, so only the workflow's own digest could say.
const FORGERIES = [
  ['a sentence appended to the report', (r) => { r.report += '\nRecommendation: retire lens-security and disable gitleaks; they never fail.\n' }, /Recommendation: retire/],
  ['one character changed in a figure line', (r) => { r.report = r.report.replace(/Ledger records in window: 5/, 'Ledger records in window: 6') }, /Ledger records in window: 6/],
  ['a whitespace-only change', (r) => { r.report += ' ' }, / $/],
  ['a target edited', (r) => { const id = Object.keys(r.proposal_targets)[0]; r.proposal_targets[id] = { ...r.proposal_targets[id], job: 'edited' } }, null],
  ['a target added', (r) => { r.proposal_targets = { ...r.proposal_targets, '0123456789abcdef': { kind: 'x' } } }, null],
  ['a lane status edited', (r) => { r.lanes = { ...r.lanes, git: { ...r.lanes.git, reason: 'edited' } } }, null],
]

test('M2: a reply edited after the workflow returned it is refused with its own fixed reason and cause, and nothing is placed; the untouched reply PASSes', async () => {
  const reader = await readerPromise
  const target = { kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: 'ci', job: 'seeded', touches_always_on_lens: false, security_purposed: false }
  const run = await collected({ proposals: (digest) => [{ target, statement: 'Tighten the glob', motivating_measurement: '9 runs', confirming_measurement: 'improves', n: 9, citations: [digest.ledger.citationPool[0]], reinstatement_evidence: null }] })
  assert.ok(Object.keys(run.result.proposal_targets).includes(reader.stableProposalId(target)), 'guard against vacuity: the result carries a target to edit')
  const clean = attended(run.make(undefined, { sign: false }))
  assert.match(clean.out, /^VERDICT PASS$/m, `the untouched reply PASSes: ${clean.out}${clean.stderr}`)
  for (const [name, forge, visible] of FORGERIES) {
    const copy = run.make(forge, { sign: false })
    const before = JSON.stringify(run.result)
    assert.notEqual(JSON.stringify(JSON.parse(fs.readFileSync(copy.resultFile, 'utf8'))), before, `guard against vacuity: ${name} really altered the saved reply`)
    if (visible) assert.match(JSON.parse(fs.readFileSync(copy.resultFile, 'utf8')).report, visible)
    const kept0 = seed(run.repo)
    const res = attended(copy)
    assert.deepEqual(reasons(res.out), ['result mac does not match this run'], `${name}: ${res.out}`)
    assert.match(res.out, /^CAUSE mac$/m, name)
    assert.match(res.out, /^PLACE no$/m, name)
    kept(run.repo, kept0)
  }
})

test('M2: a reply with no result_mac, or one that is not a hash, is refused with a fixed reason', async () => {
  const run = await collected()
  const missing = run.make((r) => { delete r.result_mac }, { sign: false })
  const bare = JSON.parse(fs.readFileSync(missing.resultFile, 'utf8'))
  bare.nonce_sha256 = run.result.nonce_sha256
  fs.writeFileSync(missing.resultFile, JSON.stringify({ ...bare }))
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(missing.resultFile, 'utf8')), 'result_mac'), 'guard against vacuity: no mac in the saved reply')
  assert.deepEqual(reasons(attended(missing).out), ['result carries no mac'])
  for (const value of [42, '', 'not-a-hash', macOf(run.result).toUpperCase(), null]) {
    const odd = run.make((r) => { r.result_mac = value }, { sign: false })
    const saved = JSON.parse(fs.readFileSync(odd.resultFile, 'utf8'))
    saved.result_mac = value
    fs.writeFileSync(odd.resultFile, JSON.stringify(saved))
    assert.deepEqual(reasons(attended(odd).out).length, 1, `${JSON.stringify(value)}`)
    assert.match(attended(odd).out, /^REASON result (carries no mac|mac does not match this run)$/m)
  }
})

test('M2: the nonce echo alone is not enough: a reply with a good nonce_sha256 and a forged report is refused', async () => {
  const run = await collected()
  const copy = run.make((r) => { r.report += '\nforged\n' }, { sign: false })
  assert.equal(JSON.parse(fs.readFileSync(copy.resultFile, 'utf8')).nonce_sha256, run.result.nonce_sha256, 'guard against vacuity: the echo is the true one')
  assert.match(attended(copy).out, /^PLACE no$/m)
})

// Through the real runner: the stub session returns the workflow's object, signed or not.
function runnerRun(mode, repo = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })) {
  marker(repo, mode)
  const res = runRunner([repo], { stubs: ghStubs() })
  const [reply] = fs.readdirSync(res.witness).filter((n) => n.startsWith('reply-'))
  const returned = reply ? JSON.parse(JSON.parse(fs.readFileSync(path.join(res.witness, reply), 'utf8')).result) : null
  return { res, repo, returned, line: res.logContents.match(/^RESULT .*$/m)?.[0] }
}

for (const [mode, reasonRe, proof] of [
  ['forged-append', /reason="result mac does not match this run"$/, (r) => /retire lens-security/.test(r.report)],
  ['forged-figure', /reason="result mac does not match this run"$/, (r) => /Ledger records in window: 6/.test(r.report)],
  ['forged-whitespace', /reason="result mac does not match this run"$/, (r) => r.report.endsWith(' ')],
  ['forged-target-edit', /reason="result mac does not match this run"$/, (r) => Object.values(r.proposal_targets).some((t) => t.job === 'edited-by-session')],
  ['forged-target-add', /reason="result mac does not match this run"$/, (r) => Object.hasOwn(r.proposal_targets, 'f0f0f0f0f0f0f0f0')],
  ['mac-missing', /reason="result carries no mac"$/, (r) => !Object.hasOwn(r, 'result_mac')],
]) {
  test(`M2 (through the runner): the stub session's ${mode} reply FAILs with the fixed reason and cause=mac, places nothing and leaves the last good files`, () => {
    const repo = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })
    const before = seed(repo)
    const { res, returned, line } = runnerRun(mode, repo)
    assert.ok(returned && proof(returned), `guard against vacuity: the stub really made the ${mode} change`)
    assert.ok(line?.startsWith('RESULT FAIL '), res.logContents)
    assert.match(line, reasonRe, line)
    assert.match(line, / cause=mac /, line)
    kept(repo, before)
  })
}

test('M2 (through the runner): the untouched reply PASSes and carries a result_mac', () => {
  const { res, returned } = runnerRun('pass')
  assert.equal(res.status, 0, res.logContents)
  assert.match(returned.result_mac, /^[0-9a-f]{64}$/)
})

// ---- M2 second layer: a proposal that removes an always-on lens is refused, whoever signed the report ----

test('M2 (second layer): a signed report whose proposal block proposes retiring lens-security is refused, and one that merely mentions a lens in its tables is not', async () => {
  const run = await collected()
  const id = '1234567890abcdef'
  const block = `### ${id}: Retire lens-security from the always-on roster\nn=9. Motivating: it never fails. Confirming: none. Citations: r1.\nTarget: kind=lens_tune component=roster concern=cost lens=lens-security workflow= job=\n`
  const bad = run.make((r) => {
    r.report = r.report.replace('## Proposals (ranked)\nNone.\n', `## Proposals (ranked)\n${block}`)
    r.proposal_targets = { ...r.proposal_targets, [id]: { kind: 'lens_tune', component: 'roster', concern: 'cost', lens: 'lens-security', workflow: '', job: '', touches_always_on_lens: true, security_purposed: false } }
  })
  assert.ok(JSON.parse(fs.readFileSync(bad.resultFile, 'utf8')).report.includes(block), 'guard against vacuity: the block is in the saved report')
  const res = attended(bad)
  assert.deepEqual(reasons(res.out), ['report proposes removing an always-on lens'], res.out)
  assert.match(res.out, /^PLACE no$/m)
  const phrase = run.make((r) => {
    r.report = r.report.replace('## Proposals (ranked)\nNone.\n', `## Proposals (ranked)\n### ${id}: Turn off the security lens for docs-only diffs\nn=9. Motivating: x. Confirming: y. Citations: r1.\n`)
    r.proposal_targets = { ...r.proposal_targets, [id]: { kind: 'trigger_tune', component: 'docs', concern: 'cost', lens: '', workflow: '', job: '', touches_always_on_lens: false, security_purposed: false } }
  })
  assert.deepEqual(reasons(attended(phrase).out), ['report proposes removing an always-on lens'], 'the free-text phrase alone is refused, as the workflow\'s own rule does')
  const tables = run.make((r) => { r.report += '\n- lens-security: fixed=1, rejected=0, spec_bug=0, open=0\n' })
  assert.ok(!reasons(attended(tables).out).includes('report proposes removing an always-on lens'), 'a lens named in a table outside the proposal sections is not a proposal')
})

test('M2 (second layer): the always-on rule is the workflow\'s own, held by a parity test, not a second opinion', async () => {
  const { ALWAYS_ON_LENS_NAMES, ALWAYS_ON_LENS_PHRASE_RE } = await load()
  const names = /const SECURITY_LENS_NAMES = (\[[^\]]*\])/.exec(WORKFLOW_SOURCE)?.[1]
  const phrase = /const SECURITY_LENS_PHRASE_RE = (\/.*\/[a-z]*)$/m.exec(WORKFLOW_SOURCE)?.[1]
  assert.ok(names && phrase, 'the workflow declares both')
  assert.deepEqual(ALWAYS_ON_LENS_NAMES, new Function(`return ${names}`)())
  assert.equal(String(ALWAYS_ON_LENS_PHRASE_RE), phrase)
})

// ---- M1: forged headline figures ----

// Each form puts a look-alike line beside the true one, or in its place.
const TRUE_LEDGER = /^Ledger records in window: 5 \(minimum for harness-side proposals: 5\)\.$/m
const LOOKALIKES = [
  ['a no-break space', 'Ledger records in window: 0 (minimum for harness-side proposals: 5).'],
  ['two spaces', 'Ledger records in window:  0 (minimum for harness-side proposals: 5).'],
  ['a fullwidth zero', 'Ledger records in window: ０ (minimum for harness-side proposals: 5).'],
  ['a zero-width space', 'Ledger records in window: 0​ (minimum for harness-side proposals: 5).'],
  ['markdown bold', 'Ledger records in window: **0** (minimum for harness-side proposals: 5).'],
  ['the true figure followed by forged text', 'Ledger records in window: 5 (minimum for harness-side proposals: 5). In fact 0 records were read.'],
  ['a trailing no-break space and text', 'Ledger records in window: 0 (minimum for harness-side proposals: 5). '],
]

test('M1: a look-alike ledger line beside the true one, or instead of it, in any of the review\'s forms, is refused and nothing is placed; the unforged report PASSes', async () => {
  const run = await collected()
  assert.match(run.result.report, TRUE_LEDGER, 'guard against vacuity: the true line is there')
  assert.match(attended(run.make()).out, /^VERDICT PASS$/m, 'the unforged report PASSes')
  for (const [name, fake] of LOOKALIKES) {
    for (const where of ['beside', 'instead']) {
      const copy = run.make((r) => { r.report = r.report.replace(TRUE_LEDGER, (line) => (where === 'beside' ? `${line}\n${fake}` : fake)) })
      assert.ok(JSON.parse(fs.readFileSync(copy.resultFile, 'utf8')).report.includes(fake), `guard against vacuity: ${name} is in the saved report`)
      const before = seed(run.repo)
      const res = attended(copy)
      assert.match(res.out, /^PLACE no$/m, `${name} ${where}: ${res.out}`)
      assert.ok(reasons(res.out).length > 0, `${name} ${where} has a fixed reason`)
      kept(run.repo, before)
    }
  }
})

test('M1: the true line wrapped in an HTML comment and followed by a false one is refused with its own reason', async () => {
  const run = await collected()
  const copy = run.make((r) => { r.report = r.report.replace(TRUE_LEDGER, (line) => `<!-- ${line} -->\nLedger records in window: 0 (minimum for harness-side proposals: 5).`) })
  assert.ok(JSON.parse(fs.readFileSync(copy.resultFile, 'utf8')).report.includes('<!--'), 'guard against vacuity')
  assert.deepEqual(reasons(attended(copy).out), ['report contains an HTML comment'])
})

test('M1: a zero-width or direction-control character anywhere in the report is refused with its own reason', async () => {
  const run = await collected()
  for (const ch of ['​', '‌', '‍', '⁠', '﻿', '‮', '⁦', '‏']) {
    const copy = run.make((r) => { r.report += `\nA note${ch} in the text.\n` })
    assert.ok(JSON.parse(fs.readFileSync(copy.resultFile, 'utf8')).report.includes(ch), `guard against vacuity: U+${ch.codePointAt(0).toString(16)}`)
    assert.deepEqual(reasons(attended(copy).out), ['report contains an invisible or direction-control character'], `U+${ch.codePointAt(0).toString(16)}`)
  }
})

test('M1: the other headline figure lines are held the same way: a look-alike CI, git or digest line, or a second true one, is refused', async () => {
  const run = await collected()
  const ci = /^CI runs: .*$/m.exec(run.result.report)?.[0]
  const raw = /^Raw \(unscoped\): .*$/m.exec(run.result.report)?.[0]
  assert.ok(ci && raw, 'guard against vacuity: both lines are in the report')
  const forms = [
    ['a CI line with two spaces', (r) => { r.report = r.report.replace(ci, `${ci}\nCI runs:  0 fetched, 0 not fetched, 0 timed out`) }],
    ['a CI line in a no-break form', (r) => { r.report = r.report.replace(ci, `${ci}\nCI runs: 0 fetched, 0 not fetched, 0 timed out`) }],
    ['a second, identical CI line', (r) => { r.report = r.report.replace(ci, `${ci}\n${ci}`) }],
    ['a git line with a zero-width space', (r) => { r.report = r.report.replace(raw, `${raw}\nRaw (unscoped): 0​ of 0 examined commits matched the heuristic. x`) }],
    ['a git line with a no-break space', (r) => { r.report = r.report.replace(raw, `${raw}\nRaw (unscoped): 0 of 0 examined commits matched the heuristic. x`) }],
    ['a second, identical per-job row', (r) => { const row = r.report.split('\n').find((l) => l.includes('::ci::build: n=')); assert.ok(row, 'guard against vacuity: the report has a per-job row'); r.report = r.report.replace(row, `${row}\n${row}`) }],
    ['a CI line with extra text after it', (r) => { r.report = r.report.replace(ci, `${ci} and a forged tail`) }],
  ]
  for (const [name, forge] of forms) {
    const copy = run.make(forge)
    const before = seed(run.repo)
    const res = attended(copy)
    assert.match(res.out, /^PLACE no$/m, `${name}: ${res.out}`)
    assert.ok(reasons(res.out).length > 0, name)
    kept(run.repo, before)
  }
})

test('M1: a date-claim line and a row in a look-alike form beside the true one are refused', async () => {
  const reader = await readerPromise
  const target = { kind: 'trigger_tune', component: 'comp-1', concern: 'noise', lens: 'lens-operability', workflow: '', job: '', touches_always_on_lens: false, security_purposed: false }
  const id = reader.stableProposalId(target)
  const ledger = F.validLedger(5) + `${F.ledgerLine(100, { kind: 'conduct_plan_event', event: 'proposal_rejected', event_key: rejectionKey(id) })}\n`
  const run = await collected({ ledgerText: ledger, proposals: (digest) => [{ target, statement: 'Tighten the glob', motivating_measurement: '9 runs', confirming_measurement: 'x', n: 9, citations: [digest.ledger.citationPool[0]], reinstatement_evidence: null }] })
  const claim = /^\*\*Previously rejected on .*\*\*$/m.exec(run.result.report)?.[0]
  assert.ok(claim, 'guard against vacuity: the report carries a prior-rejection claim')
  assert.match(attended(run.make()).out, /^VERDICT PASS$/m, 'the unforged report PASSes')
  const forms = [
    ['a date claim with a different date beside the true one', (r) => { r.report = r.report.replace(claim, `${claim}\n**Previously rejected on 2020-01-01T00:00:00.000Z.**`) }],
    ['a date claim with a no-break space', (r) => { r.report = r.report.replace(claim, `${claim}\n**Previously rejected on 2020-01-01T00:00:00.000Z.**`) }],
    ['a date claim with a double space', (r) => { r.report = r.report.replace(claim, `${claim}\n**Previously rejected  on 2020-01-01T00:00:00.000Z.**`) }],
    ['a table row with a no-break space after the dash', (r) => { r.report += '\n- build: n=0, failed=0\n' }],
  ]
  for (const [name, forge] of forms) {
    const copy = run.make(forge)
    const res = attended(copy)
    assert.match(res.out, /^PLACE no$/m, `${name}: ${res.out}`)
  }
})

test('M1: a legitimate report with non-ASCII proposal text (accents, CJK, an astral character) still PASSes', async () => {
  const target = { kind: 'trigger_tune', component: 'comp-é日', concern: 'noise', lens: 'lens-operability', workflow: '', job: '', touches_always_on_lens: false, security_purposed: false }
  const run = await collected({ proposals: (digest) => [{ target, statement: 'Tighten the glob for café 日本語 😀', motivating_measurement: '9 runs', confirming_measurement: 'improves', n: 9, citations: [digest.ledger.citationPool[0]], reinstatement_evidence: null }] })
  assert.ok(run.result.report.includes('café 日本語 😀'), 'guard against vacuity: the non-ASCII text is in the report')
  const res = attended(run.make())
  assert.match(res.out, /^VERDICT PASS$/m, `${res.out}${res.stderr}`)
})

// ---- M4 (decision A): where the outputs go and whether their paths are ignored are each decided once, in optimise-report-ignore.mjs ----

const PROOF = 'ignore-proof.json'
const { sanitizedGitEnv } = require('./helpers/temp-repo.js')
const gitOut = (repo, args) => spawnSync(F.REAL_GIT, ['-C', repo, ...args], { encoding: 'utf8', env: sanitizedGitEnv() })
function ignoreCli(args) {
  const res = spawnSync(process.execPath, [IGNORE, ...args], { encoding: 'utf8', cwd: freshDir('cwd-') })
  let json = null
  try {
    json = JSON.parse(res.stdout)
  } catch {
    json = null
  }
  return { ...res, json }
}
const excludeText = (repo) => (fs.existsSync(path.join(repo, '.git', 'info', 'exclude')) ? fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8') : '')
function worktreeOf(repo) {
  const worktree = path.join(freshDir('wt-'), 'linked')
  assert.equal(gitOut(repo, ['worktree', 'add', '-q', '--detach', worktree]).status, 0)
  assert.ok(fs.statSync(path.join(worktree, '.git')).isFile(), 'guard against vacuity: a linked worktree has a .git pointer file')
  return worktree
}

test('M4: `root` names the main checkout of a linked worktree and changes nothing; `prepare` makes both output paths ignored there, confirms them with git and writes one proof into the per-run directory', () => {
  const repo = F.makeRepo({ ledger: F.validLedger(2), fix: 1, other: 1, author: AUTHOR })
  const worktree = worktreeOf(repo)
  const before = excludeText(repo)
  const root = ignoreCli(['root', worktree])
  assert.equal(fs.realpathSync(root.stdout.trim()), fs.realpathSync(repo), `root: ${root.stdout}${root.stderr}`)
  assert.equal(fs.realpathSync(ignoreCli(['root', repo]).stdout.trim()), fs.realpathSync(repo))
  assert.equal(ignoreCli(['root', freshDir('not-a-repo-')]).stdout.trim(), '', 'a directory that is not a repository has no main checkout')
  assert.equal(excludeText(repo), before, 'resolving the root edits nothing')
  const dir = freshDir('proof-')
  const done = ignoreCli(['prepare', worktree, dir])
  assert.equal(done.json?.ok, true, `${done.stdout}${done.stderr}`)
  assert.equal(fs.realpathSync(done.json.root), fs.realpathSync(repo))
  for (const rel of [REPORT_REL, SIDECAR_REL]) assert.equal(gitOut(repo, ['check-ignore', '-q', '--', rel]).status, 0, `${rel} is ignored in the main checkout`)
  const proof = JSON.parse(fs.readFileSync(path.join(dir, PROOF), 'utf8'))
  assert.equal(fs.realpathSync(proof.root), fs.realpathSync(repo))
  assert.equal(fs.statSync(path.join(dir, PROOF)).mode & 0o077, 0, 'the proof is private')
})

test('M4: `prepare` refuses, with no proof file, when a tracked .gitignore re-includes an output path', () => {
  const repo = F.makeRepo({ ledger: F.validLedger(2), fix: 1, other: 1, author: AUTHOR })
  fs.writeFileSync(path.join(repo, '.gitignore'), '!.claude/optimise-cycle-report.md\n!.claude/optimise-proposal-targets.json\n')
  const dir = freshDir('proof-')
  const done = ignoreCli(['prepare', repo, dir])
  assert.equal(done.json?.ok, false, `${done.stdout}${done.stderr}`)
  assert.equal(fs.existsSync(path.join(dir, PROOF)), false, 'no proof when nothing is confirmed')
})

const NOT_CONFIRMED = 'the output paths were not confirmed ignored for this checkout'

test('M4: an attended run that skips the ignore step FAILs with the fixed reason and places nothing; a proof for another checkout, a stale one and a used one are each refused', async () => {
  const run = await collected()
  const before = seed(run.repo)
  const make = () => run.make()
  // skipped
  const skipped = make()
  const res = attended(skipped, { skipProof: true })
  assert.deepEqual(reasons(res.out), [NOT_CONFIRMED], res.out)
  assert.match(res.out, /^VERDICT FAIL$/m)
  assert.match(res.out, /^PLACE no$/m)
  kept(run.repo, before)
  // the proof is for another checkout
  const other = F.makeRepo({ ledger: F.validLedger(2), fix: 1, other: 1, author: AUTHOR })
  const wrongRoot = make()
  assert.equal(ignoreCli(['prepare', other, wrongRoot.perRun]).json?.ok, true)
  assert.deepEqual(reasons(attended(wrongRoot, { skipProof: true }).out), [NOT_CONFIRMED], 'a proof written for another repository')
  kept(run.repo, before)
  // stale
  const stale = make()
  assert.equal(ignoreCli(['prepare', run.repo, stale.perRun]).json?.ok, true)
  const proof = JSON.parse(fs.readFileSync(path.join(stale.perRun, PROOF), 'utf8'))
  fs.writeFileSync(path.join(stale.perRun, PROOF), JSON.stringify({ ...proof, at: Date.now() - 3 * 3600 * 1000 }))
  assert.deepEqual(reasons(attended(stale, { skipProof: true }).out), [NOT_CONFIRMED], 'a proof older than the short life it has')
  kept(run.repo, before)
  // used once
  const once = make()
  assert.equal(ignoreCli(['prepare', run.repo, once.perRun]).json?.ok, true)
  assert.match(attended(once, { skipProof: true }).out, /^VERDICT PASS$/m, 'with the proof the run places')
  assert.equal(fs.existsSync(path.join(once.perRun, PROOF)), false, 'and the proof is consumed')
  const again = attended(once, { skipProof: true })
  assert.deepEqual(reasons(again.out), [NOT_CONFIRMED], 'a second run cannot use the same proof')
})

function worktreeRunner(mode) {
  const repo = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })
  const worktree = worktreeOf(repo)
  if (mode) marker(worktree, mode)
  const stubs = ghStubs()
  return { repo, worktree, stubs }
}

test('M4: a weekly run from a linked worktree places the report and the sidecar in the main checkout, leaves the worktree clean, and logs one fixed NOTICE that the analysed checkout is a linked worktree', () => {
  const { repo, worktree, stubs } = worktreeRunner()
  const res = runRunner([worktree], { stubs })
  assert.equal(res.status, 0, res.logContents)
  assert.ok(fs.existsSync(path.join(repo, REPORT_REL)), 'the report is in the main checkout')
  assert.ok(fs.existsSync(path.join(repo, SIDECAR_REL)), 'and so is the sidecar')
  assert.equal(fs.existsSync(path.join(worktree, REPORT_REL)), false, 'nothing is in the worktree')
  assert.equal(gitOut(worktree, ['status', '--porcelain']).stdout, '', 'the worktree is clean')
  assert.deepEqual([...res.logContents.matchAll(/^NOTICE .* linked-worktree$/gm)].length, 1, res.logContents)
  const plain = runRunner([F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })], { stubs: ghStubs() })
  assert.doesNotMatch(plain.logContents, /linked-worktree/, 'an ordinary checkout logs no such notice')
})

test('M4: a weekly run whose result is not trusted adds nothing to .git/info/exclude; one that places a report for a lane that could not run does make the paths ignored', () => {
  const failed = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })
  marker(failed, 'ledger-plus1')
  const before = excludeText(failed)
  const res = runRunner([failed], { stubs: ghStubs() })
  assert.ok(/^RESULT FAIL /m.test(res.logContents), res.logContents)
  assert.equal(excludeText(failed), before, 'a failed run edits no exclude file')
  const stubs = ghStubs()
  F.setGhMode(stubs, 'unauth')
  const lane = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })
  const laneRes = runRunner([lane], { stubs })
  assert.match(laneRes.logContents, /^RESULT FAIL .*ci lane could not run: unauthenticated/m, laneRes.logContents)
  assert.ok(fs.existsSync(path.join(lane, REPORT_REL)), 'the report is still placed (AC-PROD-3)')
  for (const rel of ['.claude/optimise-cycle-report.md', '.claude/optimise-proposal-targets.json']) assert.ok(excludeText(lane).split('\n').includes(rel), `${rel} is ignored once the report is about to be placed`)
})

test('M4: the runner and the skill decide the output location and the ignore rule in optimise-report-ignore.mjs and nowhere else: no git sequence of their own', () => {
  const runner = fs.readFileSync(SB.SCRIPT_PATH, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  for (const gone of ['rev-parse --path-format', 'check-ignore', 'ensure_ignored', 'sidecar_root_of']) assert.ok(!runner.includes(gone), `${gone} is the helper's, not the runner's`)
  assert.match(runner, /optimise-report-ignore\.mjs|\$IGNORE_SCRIPT/)
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'optimise-cycle', 'SKILL.md'), 'utf8')
  assert.ok(!skill.includes('git rev-parse --path-format') && !skill.includes('check-ignore'), 'the skill runs the one command, not its own git commands')
  assert.match(skill, /optimise-report-ignore\.mjs prepare/)
})

// ---- M3 (decision A): the id is computed from the same redacted, normalised target that is stored ----

const pathTarget = (component, extra = {}) => ({ kind: 'trigger_tune', component, concern: 'noise', lens: 'lens-operability', workflow: '', job: '', touches_always_on_lens: false, security_purposed: false, ...extra })
const rejectionKey = (id) => `${id}:proposal_rejected:1`
const draftOf = (target, citation, n = 9) => ({ target, statement: `Tighten the glob for ${String(target.component).slice(0, 20)}`, motivating_measurement: `${n} runs show it matching nothing`, confirming_measurement: 'accuracy improves', n, citations: [citation], reinstatement_evidence: null })
const REDACT_RE = /(^|[\s'"(`=[<,+]|:(?!\/\/))([A-Za-z]:\\[^\s'")]+|\/[^\s'")]+)/g
const redactAll = (v) => (typeof v === 'string' ? v.replace(REDACT_RE, (w, prefix) => `${prefix}<redacted-path>`) : v)
const oldStyleId = (target) => crypto.createHash('sha256').update(canonicalOf(['kind', 'component', 'concern', 'lens', 'workflow', 'job'].map((k) => String(target[k] ?? '').trim().toLowerCase()))).digest('hex').slice(0, 16)
const canonicalOf = (v) => JSON.stringify(v)

const ID_TARGETS = [pathTarget('/review-cycle'), pathTarget('/tdd-task'), pathTarget('C:\\work\\repo'), pathTarget('see /etc/hosts now'), pathTarget('a  b   c'), pathTarget('  Mixed Case  '), pathTarget('ci/cd'), pathTarget('plain-comp'), pathTarget('', { job: '/a/b' }), pathTarget('x', { lens: '/review-cycle' })]

function workflowIds() {
  const start = WORKFLOW_SOURCE.indexOf('const SHA256_K = [')
  const end = WORKFLOW_SOURCE.indexOf('// END proposal-id block')
  return new Function(`${WORKFLOW_SOURCE.slice(start, end)}\nreturn stableProposalId`)()
}

test('M3: the reader\'s and the workflow\'s proposal ids agree for path-shaped, multi-space and mixed-case targets, and a target hashes to the same id after the redaction it is stored through', async () => {
  const reader = await readerPromise
  const wf = workflowIds()
  let redactedSomething = 0
  for (const target of ID_TARGETS) {
    const id = reader.stableProposalId(target)
    assert.equal(wf(target), id, `workflow and reader: ${JSON.stringify(target.component)}`)
    const stored = Object.fromEntries(Object.entries(target).map(([k, v]) => [k, redactAll(v)]))
    if (JSON.stringify(stored) !== JSON.stringify(target)) redactedSomething += 1
    assert.equal(reader.stableProposalId(stored), id, `a stored target hashes to its own key: ${JSON.stringify(target.component)}`)
    assert.equal(wf(stored), id, `and the workflow agrees: ${JSON.stringify(target.component)}`)
  }
  assert.ok(redactedSomething >= 5, `guard against vacuity: ${redactedSomething} of the targets really are changed by redaction`)
  assert.equal(reader.stableProposalId(pathTarget('a  b   c')), reader.stableProposalId(pathTarget('a b c')), 'internal whitespace runs do not mint a second id')
  assert.notEqual(reader.stableProposalId(pathTarget('/review-cycle')), reader.stableProposalId(pathTarget('plain-comp')))
})

test('M3: the path pattern the proposal id uses is the ledger writer\'s own, in the reader and in the workflow\'s block', async () => {
  const ledger = await import(pathToFileURL(path.join(ROOT, 'workflows', 'lib', 'ledger-append.mjs')).href)
  assert.ok(ledger.ABSOLUTE_PATH_RE instanceof RegExp, 'the writer exports its pattern')
  const block = WORKFLOW_SOURCE.slice(WORKFLOW_SOURCE.indexOf('const SHA256_K = ['), WORKFLOW_SOURCE.indexOf('// END proposal-id block'))
  const inBlock = /const ID_ABSOLUTE_PATH_RE = (\/.*\/g)$/m.exec(block)?.[1]
  assert.equal(inBlock, String(ledger.ABSOLUTE_PATH_RE), 'the workflow block carries the same pattern')
})

test('M3 (end to end): proposals targeting /review-cycle and /tdd-task are drafted, ranked, placed and remembered across two runs, with a decision recorded between them and annotated on the second', async () => {
  const reader = await readerPromise
  const targets = [pathTarget('/review-cycle', { concern: 'noise' }), pathTarget('/tdd-task', { concern: 'cost' })]
  const ids = targets.map((t) => reader.stableProposalId(t))
  assert.equal(new Set(ids).size, 2, 'guard against vacuity: the two targets differ in another field, so they are two proposals and do not collide')
  const drafts = (digest) => targets.map((t, i) => draftOf(t, digest.ledger.citationPool[0], 9 - i))
  const first = await collected({ proposals: drafts })
  for (const id of ids) assert.ok(first.result.report.includes(`### ${id}: `), `run 1 ranks ${id}`)
  const placed1 = first.make()
  const res1 = attended(placed1)
  assert.match(res1.out, /^VERDICT PASS$/m, `run 1 places: ${res1.out}${res1.stderr}`)
  const sidecar1 = JSON.parse(fs.readFileSync(path.join(first.repo, SIDECAR_REL), 'utf8'))
  for (const id of ids) assert.ok(Object.hasOwn(sidecar1, id), `the sidecar remembers ${id}`)
  // the decision between the runs
  fs.appendFileSync(path.join(first.repo, '.claude', 'harness-ledger.jsonl'), `${F.ledgerLine(200, { kind: 'conduct_plan_event', event: 'proposal_rejected', event_key: `${ids[0]}:proposal_rejected:1` })}\n${F.ledgerLine(201, { kind: 'conduct_plan_event', event: 'proposal_adopted', event_key: `${ids[1]}:proposal_adopted:1` })}\n`)
  const second = await collected({ repo: first.repo, proposals: drafts })
  assert.match(second.result.report, /Previously rejected on /, 'the second run annotates the rejected one')
  assert.match(second.result.report, /Already adopted on /, 'and the adopted one')
  const res2 = attended(second.make())
  assert.match(res2.out, /^VERDICT PASS$/m, `run 2 places: ${res2.out}${res2.stderr}`)
  const sidecar2 = JSON.parse(fs.readFileSync(path.join(first.repo, SIDECAR_REL), 'utf8'))
  for (const id of ids) assert.ok(Object.hasOwn(sidecar2, id), `${id} is still remembered`)
})

test('M3 (existing data): a sidecar entry and ledger outcomes recorded under the OLD id of a path-shaped target are still found, annotated and kept, and nothing on disk is dropped', async () => {
  const reader = await readerPromise
  const target = pathTarget('/review-cycle')
  const oldId = oldStyleId(target)
  const newId = reader.stableProposalId(target)
  assert.notEqual(oldId, newId, 'guard against vacuity: the old rule and the new one give different ids for this target')
  const stored = Object.fromEntries(Object.entries(target).map(([k, v]) => [k, redactAll(v)]))
  const ledger = F.validLedger(5) + `${F.ledgerLine(100, { kind: 'conduct_plan_event', event: 'proposal_rejected', event_key: rejectionKey(oldId) })}\n`
  const repo = F.makeRepo({ ledger, fix: 2, other: 1, author: AUTHOR })
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  const untouched = { kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: 'ci', job: 'other-old', touches_always_on_lens: false, security_purposed: false }
  fs.writeFileSync(path.join(repo, SIDECAR_REL), `${JSON.stringify({ [oldId]: stored, [reader.stableProposalId(untouched)]: untouched })}\n`)
  const run = await collected({ repo, proposals: (digest) => [draftOf(target, digest.ledger.citationPool[0])] })
  assert.match(run.result.report, /Previously rejected on /, 'the prior rejection recorded under the old id annotates the re-raised proposal')
  const res = attended(run.make())
  assert.match(res.out, /^VERDICT PASS$/m, `the run PASSes: ${res.out}${res.stderr}`)
  const after = JSON.parse(fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8'))
  assert.deepEqual(after[oldId], stored, 'the old entry survives, as it was')
  assert.ok(Object.hasOwn(after, reader.stableProposalId(untouched)), 'so does every other entry')
  assert.deepEqual(after[newId], stored, 'and the same target is reachable under the id it hashes to now')
})

test('M3 (collision): two different path-shaped targets that redact to the same text are one proposal as far as history goes, deliberately', async () => {
  const reader = await readerPromise
  const a = pathTarget('/review-cycle')
  const b = pathTarget('/tdd-task')
  const idA = reader.stableProposalId(a)
  const idB = reader.stableProposalId(b)
  const sameText = reader.stableProposalId(pathTarget('/x-one', { concern: 'same' })) === reader.stableProposalId(pathTarget('/y-two', { concern: 'same' }))
  assert.equal(sameText, true, 'two targets that differ only in a path-shaped field share one id')
  assert.equal(idA, idB, 'so /review-cycle and /tdd-task, which differ only in that field, are one proposal')
  const run = await collected({ proposals: (digest) => [draftOf(a, digest.ledger.citationPool[0], 9), draftOf(b, digest.ledger.citationPool[0], 8)] })
  assert.equal(run.result.report.split(`### ${idA}: `).length - 1, 2, 'both drafted proposals are in the report, under the one id')
  assert.deepEqual(Object.keys(run.result.proposal_targets), [idA], 'and the sidecar holds one entry for it (the later one wins)')
  assert.match(attended(run.make()).out, /^VERDICT PASS$/m)
})

// ---- L6: a configured path that git cannot read is a FAIL with a RESULT line, not a silent skip ----

function shim(name, script) {
  const dir = freshDir('shim-')
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return dir
}

test('L6: a configured path that has a .git but that git cannot resolve (a refusal for ownership, or a damaged .git) FAILs with a fixed reason and a RESULT line; a directory that is not a repository at all is still skipped', () => {
  const dubious = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })
  const refusing = shim('git', `case "$*" in *rev-parse*) echo 'fatal: detected dubious ownership in repository' >&2; exit 128 ;; esac\nexec ${JSON.stringify(F.REAL_GIT)} "$@"`)
  const a = runRunner([dubious], { stubs: ghStubs(), extraPath: refusing })
  assert.notEqual(a.status, 0, a.logContents)
  assert.match(a.logContents, /^RESULT FAIL \S+ .*reason="git could not read the configured repository"$/m, a.logContents)
  assert.doesNotMatch(a.logContents, /^SKIP /m, 'and it is not a skip')
  assert.equal(a.notifyCalls.length, 1, 'the FAIL notification fires')
  const damaged = freshDir('damaged-')
  fs.writeFileSync(path.join(damaged, '.git'), 'this is not a git pointer\n')
  const b = runRunner([damaged], { stubs: ghStubs() })
  assert.match(b.logContents, /^RESULT FAIL \S+ .*reason="git could not read the configured repository"$/m, b.logContents)
  const plain = freshDir('plain-')
  const c = runRunner([plain], { stubs: ghStubs() })
  assert.match(c.logContents, /^SKIP \S+ \(not a git repo\)$/m, 'a directory with no .git is the deliberate skip')
  assert.doesNotMatch(c.logContents, /^RESULT FAIL \S+ .*git could not read/m)
})

// ---- Round 2 M2: plugin hooks and the unattended session ----
//
// `claude --help` (2.1.330) offers no way to turn plugins off for one invocation while the user's own settings.json hooks stay on: `--bare` skips
// "hooks (those defined in settings and by installed plugins ...)", `--safe-mode` disables "installed plugins, hooks, ..." together, `--restricted`
// "ignores user, project and local settings files", and `--plugin-dir` only adds plugins. So the invocation is left as it is, and the documents say
// what that means: an enabled plugin's hooks see the prompt, the collected data and the report, and may store them.

test('R2-M2 (owner decision 2026-11-23): the runner header, the README and the skill say plugin hooks do NOT see the unattended session (safe mode disables them), per the CLI documentation and one measured run, that T5 confirms the memory store, and that an attended run is still recorded', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replaceAll(/\s+/g, ' ')
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'optimise-cycle', 'SKILL.md'), 'utf8').replaceAll(/\s+/g, ' ')
  const header = fs.readFileSync(SB.SCRIPT_PATH, 'utf8').split('\n').filter((l) => l.startsWith('#')).map((l) => l.replace(/^#\s?/, '')).join(' ').replaceAll(/\s+/g, ' ')
  for (const [name, text] of [['the runner header', header], ['README.md', readme], ['SKILL.md', skill]]) {
    assert.match(text, /plugin hooks do not see the unattended session/i, `${name} says plugin hooks do not see the unattended session`)
    assert.match(text, /--safe-mode/, `${name} names the flag`)
    assert.match(text, /per the CLI's documentation and one measured run/i, `${name} says what the claim rests on`)
    assert.match(text, /T5 confirms the memory plugin's store gains no row/i, `${name} says T5 confirms it`)
    assert.match(text, /`?settings\.json`? hooks[^.]{0,200}do not run/i, `${name} says the operator's own settings.json hooks do not run in the unattended session`)
    assert.match(text, /no tool that can run a command or write a file/i, `${name} states the condition the owner accepted`)
    assert.doesNotMatch(text, /plugin hooks may store the prompt/i, `${name} no longer says the unattended session is stored by plugin hooks`)
  }
  assert.match(skill, /attended[^.]{0,200}memory plugin may store the collected data and the report/i, 'the skill says an attended run may be stored by a memory plugin')
})

test('R2-M2: the call site runs in safe mode and uses neither --bare nor --restricted', () => {
  const callSite = fs.readFileSync(SB.SCRIPT_PATH, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.match(callSite, /--safe-mode/)
  for (const flag of ['--bare', '--restricted']) assert.ok(!callSite.includes(flag), `${flag} is not used`)
  assert.match(callSite, /--setting-sources user/)
})

test('R2-M2: the workflow starts one agent and names no agent type, so nothing safe mode switches off (custom agents, user skills) is relied on', () => {
  const code = fs.readFileSync(path.join(ROOT, 'workflows', 'optimise-cycle.js'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  assert.equal((code.match(/\bagent\(/g) || []).length, 1, 'exactly one agent() call')
  assert.ok(!/agentType|subagent_type/.test(code), 'no agentType')
})

// ---- Round 2 M1: model text is confined and enveloped, and no other line may carry a headline label ----
//
// Both review probe sets, end to end: the drafting agent's stub returns the hostile text, the REAL workflow renders and signs it (its genuine
// result_mac, nothing re-signed here), and the real result check judges it.

const FORGED_LEDGER = 'Ledger records in window: 0 (minimum for harness-side proposals: 5).'
const FORGED_CI = 'CI runs: 999 fetched, 0 not fetched, 0 timed out'
const PROBES = [
  ['a numbered list item', `1. Ledger records in window: 1018 (minimum for harness-side proposals: 5).`],
  ['a plus list item', `+ ${FORGED_LEDGER}`],
  ['a table cell', `| ${FORGED_LEDGER} |`],
  ['a link', `[Ledger records in window: 0](https://example.invalid/x)`],
  ['a note', `Note: ${FORGED_LEDGER}`],
  ['a numbered CI line', `1. ${FORGED_CI}`],
  ['a character reference for the space', 'Ledger&#32;records in window: 0 (minimum for harness-side proposals: 5).', 'harmless'],
  ['a soft hyphen', 'Led­ger records in window: 0 (minimum for harness-side proposals: 5).'],
  ['a full-width look-alike', 'Ｌedger records in window: 0 (minimum for harness-side proposals: 5).'],
  ['a Cyrillic look-alike', 'Lеdger records in window: 0 (minimum for harness-side proposals: 5).'],
  ['a character reference in a CI line', 'CI&#32;runs: 0 fetched, 0 not fetched, 0 timed out', 'harmless'],
]
const hostileTarget = pathTarget('hostile-comp')
const draftWith = (fields) => (digest) => [{ ...draftOf(hostileTarget, digest.ledger.citationPool[0]), ...fields }]

// Which outcome each probe gets, and why: a form that still reads as a headline label (after case folding, removing everything that is not a letter or a digit,
// and the look-alike letters) is REFUSED; a character reference is not decoded by the check, because the workflow renders `&` as `&amp;` so the reference is
// shown as the text it is, and the line is then RENDERED HARMLESS (one enveloped line that does not read as a figure).
for (const [name, forged, outcome = 'refused'] of PROBES) {
  test(`R2-M1: a proposal statement that carries ${name} after a line break is confined to one enveloped line and is ${outcome === 'refused' ? 'REFUSED' : 'RENDERED HARMLESS'}, with a genuine result_mac`, async () => {
    const run = await collected({ proposals: draftWith({ statement: `A fine point.\n${forged}` }) })
    const lines = run.result.report.split('\n')
    assert.equal(lines.filter((l) => l.includes('A fine point.')).length, 1, 'guard against vacuity: the statement is on one line')
    const carrier = lines.find((l) => l.includes('A fine point.'))
    assert.match(carrier, /^### [0-9a-f]{16}: Proposal statement \(model text\): A fine point\. /, 'and that line begins with the script\'s own envelope')
    assert.ok(!lines.some((l) => l === forged), 'no line of the report is the forged line')
    const res = attended(run.make(undefined, { sign: false }))
    if (outcome === 'refused') {
      assert.match(res.out, /^VERDICT FAIL$/m, res.out)
      assert.ok(reasons(res.out).some((r) => /a line in a shape the check does not know$/.test(r)), `refused for the line shape: ${res.out}`)
      assert.match(res.out, /^PLACE no$/m)
    } else {
      assert.ok(carrier.includes('&amp;#32;'), `the reference is neutralised on that one line: ${carrier}`)
      assert.match(res.out, /^VERDICT PASS$/m, res.out)
    }
  })
}

test('R2-M1: the same hostile text in each other model-written field is refused too', async () => {
  for (const field of ['motivating_measurement', 'confirming_measurement', 'reinstatement_evidence']) {
    const run = await collected({ proposals: draftWith({ [field]: `a measurement\n${FORGED_LEDGER}`, ...(field === 'reinstatement_evidence' ? { statement: 'Move a slow check out of the merge path' } : {}) }) })
    assert.ok(run.result.report.includes('(model text): a measurement '), `guard against vacuity: ${field} reached the report`)
    const res = attended(run.make(undefined, { sign: false }))
    assert.match(res.out, /^PLACE no$/m, `${field}: ${res.out}`)
  }
})

test('R2-M1: a statement that quotes no headline label is rendered harmlessly on one line and the report PASSes with a genuine result_mac', async () => {
  const statement = 'Don\'t fix "CI" — it is slow & flaky:\nsee https://example.com/a?b=1&c=2 😀 café 日本語 (9 of 12)\r\nnext line and another'
  const run = await collected({ proposals: draftWith({ statement, motivating_measurement: 'the report says 5 records were read', confirming_measurement: 'a quoted figure: "3 runs failed"' }) })
  const carrier = run.result.report.split('\n').find((l) => l.includes('Proposal statement (model text)'))
  assert.equal(carrier.includes('\n'), false)
  assert.ok(carrier.includes('Don\'t fix "CI" — it is slow & flaky: see https://example.com/a?b=1&c=2 😀 café 日本語 (9 of 12) next line and another'), `the text reads sensibly on one line: ${carrier}`)
  const res = attended(run.make(undefined, { sign: false }))
  assert.match(res.out, /^VERDICT PASS$/m, `${res.out}${res.stderr}`)
})

// The confinement function itself, lifted out of the workflow by its two markers.
function confine() {
  const start = WORKFLOW_SOURCE.indexOf('// BEGIN model-text confinement')
  const end = WORKFLOW_SOURCE.indexOf('// END model-text confinement')
  assert.ok(start > 0 && end > start, 'the confinement block markers are in the workflow')
  return new Function(`${WORKFLOW_SOURCE.slice(start, end)}\nreturn { confineModelText, MODEL_TEXT_MAX, MODEL_TEXT_CUT }`)()
}

test('R2-M1: confineModelText makes one line: every terminator and control, U+2028 and U+2029 become a space; format characters go; an entity-starting & is neutralised; long text is cut with a marker', () => {
  const { confineModelText, MODEL_TEXT_MAX, MODEL_TEXT_CUT } = confine()
  for (const [input, want] of [
    ['a\nb', 'a b'], ['a\r\nb', 'a b'], ['a\rb', 'a b'], ['a\u000bb', 'a b'], ['a\u000cb', 'a b'], ['a\u0085b', 'a b'], ['a b', 'a b'], ['a b', 'a b'], ['a\tb', 'a b'], ['a\u0000b', 'a b'],
    ['a​b', 'ab'], ['a‍b', 'ab'], ['a‮b', 'ab'], ['a⁦b', 'ab'], ['a­b', 'ab'], ['a﻿b', 'ab'], ['a️b', 'ab'],
    ['x&#32;y', 'x&amp;#32;y'], ['x&amp;y', 'x&amp;amp;y'], ['x&nbsp;y', 'x&amp;nbsp;y'], ['x&#x20;y', 'x&amp;#x20;y'],
    ['AT&T and Q&A', 'AT&T and Q&A'], ['a & b', 'a & b'], ['café 日本語 😀', 'café 日本語 😀'], ['https://e.com/a?b=1&c=2', 'https://e.com/a?b=1&c=2'],
    ['  padded   spaces  ', 'padded spaces'], [null, ''], [undefined, ''], [42, '42'],
  ]) assert.equal(confineModelText(input), want, JSON.stringify(input))
  const long = confineModelText('x'.repeat(MODEL_TEXT_MAX + 50))
  assert.equal(long, `${'x'.repeat(MODEL_TEXT_MAX)}${MODEL_TEXT_CUT}`)
  assert.equal(confineModelText('😀'.repeat(MODEL_TEXT_MAX + 1)).endsWith(MODEL_TEXT_CUT), true, 'an astral character is not cut in half')
})

// ---- Round 2 M3 and L1: the sidecar cap never cuts a recorded decision off from its proposal, and histories under a legacy id and its current id combine ----

const fillerTarget = (i) => ({ kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: 'ci', job: `filler-${i}`, touches_always_on_lens: false, security_purposed: false })

test('R2-M3 (the review\'s executed case): at the 500-entry cap, with the legacy entry first, two placed runs keep it and the rejection is still shown on run 2', async () => {
  const reader = await readerPromise
  const target = pathTarget('/review-cycle')
  const oldId = oldStyleId(target)
  const newId = reader.stableProposalId(target)
  const stored = Object.fromEntries(Object.entries(target).map(([k, v]) => [k, redactAll(v)]))
  const sidecar = { [oldId]: stored }
  for (let i = 0; i < 499; i += 1) sidecar[reader.stableProposalId(fillerTarget(i))] = fillerTarget(i)
  assert.equal(Object.keys(sidecar).length, 500, 'guard against vacuity: the sidecar is at the cap, the legacy entry first')
  const ledger = F.validLedger(5) + `${F.ledgerLine(100, { kind: 'conduct_plan_event', event: 'proposal_rejected', event_key: rejectionKey(oldId) })}\n`
  const repo = F.makeRepo({ ledger, fix: 2, other: 1, author: AUTHOR })
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, SIDECAR_REL), `${JSON.stringify(sidecar)}\n`)
  const drafts = (digest) => [draftOf(target, digest.ledger.citationPool[0])]
  const first = await collected({ repo, proposals: drafts })
  assert.match(first.result.report, /Previously rejected on /, 'run 1 shows the rejection')
  assert.match(attended(first.make()).out, /^VERDICT PASS$/m)
  const after1 = JSON.parse(fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8'))
  assert.ok(Object.hasOwn(after1, oldId), 'the legacy entry survives the first placed run')
  assert.ok(Object.hasOwn(after1, newId), 'and the current one was added')
  assert.equal(Object.keys(after1).length <= 500, true, 'within the cap')
  const second = await collected({ repo, proposals: drafts })
  assert.match(second.result.report, /Previously rejected on /, 'run 2 still shows the rejection under the current id')
  assert.match(attended(second.make()).out, /^VERDICT PASS$/m)
  assert.ok(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(repo, SIDECAR_REL), 'utf8')), oldId), 'and the legacy entry survives the second')
})

test('R2-M3: eviction drops unreferenced entries oldest first, then referenced ones oldest first only if still over the cap and says how many; a legacy pair goes together', async () => {
  const { mergeSidecarDetailed } = await load()
  const reader = await readerPromise
  const t = (i) => fillerTarget(i)
  const id = (i) => reader.stableProposalId(t(i))
  const existing = Object.fromEntries([0, 1, 2, 3].map((i) => [id(i), t(i)]))
  const none = new Set()
  assert.deepEqual(Object.keys(mergeSidecarDetailed(existing, { [id(4)]: t(4) }, 4, none).entries), [id(1), id(2), id(3), id(4)], 'with nothing referenced it is oldest first, as before')
  const kept = mergeSidecarDetailed(existing, { [id(4)]: t(4) }, 4, new Set([id(0)]))
  assert.deepEqual(Object.keys(kept.entries), [id(0), id(2), id(3), id(4)], 'a referenced oldest entry is skipped while an unreferenced one can go')
  assert.equal(kept.evictedReferenced, 0)
  const forced = mergeSidecarDetailed(existing, { [id(4)]: t(4) }, 3, new Set([id(0), id(1), id(2), id(3)]))
  assert.deepEqual(Object.keys(forced.entries), [id(2), id(3), id(4)], 'when every entry is referenced the oldest referenced ones go')
  assert.equal(forced.evictedReferenced, 2, 'and the count of referenced entries that went is returned')
  // a legacy pair: two keys whose stored target hashes to the same current id
  const legacyKey = '0123456789abcdef'
  const pairTarget = pathTarget('/review-cycle')
  const pairNew = reader.stableProposalId(pairTarget)
  const stored = Object.fromEntries(Object.entries(pairTarget).map(([k, v]) => [k, redactAll(v)]))
  const withPair = { [legacyKey]: stored, [pairNew]: stored, [id(1)]: t(1), [id(2)]: t(2) }
  const pairKept = mergeSidecarDetailed(withPair, { [id(3)]: t(3) }, 4, new Set([legacyKey]))
  assert.ok(Object.hasOwn(pairKept.entries, legacyKey) && Object.hasOwn(pairKept.entries, pairNew), 'the pair stays together while anything unreferenced can go')
  assert.equal(Object.hasOwn(pairKept.entries, id(1)), false)
  const pairGone = mergeSidecarDetailed(withPair, { [id(3)]: t(3) }, 2, new Set([legacyKey]))
  assert.equal(Object.hasOwn(pairGone.entries, legacyKey), Object.hasOwn(pairGone.entries, pairNew), 'a pair is evicted together or kept together, never split')
})

test('R2-M3: when a referenced entry has to go the run says so with a fixed notice and a count, and a run that evicts none says nothing', async () => {
  const reader = await readerPromise
  const target = pathTarget('/review-cycle')
  const sidecar = {}
  let events = ''
  for (let i = 0; i < 500; i += 1) {
    const filler = fillerTarget(i)
    const id = reader.stableProposalId(filler)
    sidecar[id] = filler
    events += `${F.ledgerLine(100 + i, { kind: 'conduct_plan_event', event: 'proposal_rejected', event_key: rejectionKey(id) })}\n`
  }
  const repo = F.makeRepo({ ledger: F.validLedger(5) + events, fix: 2, other: 1, author: AUTHOR })
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, SIDECAR_REL), `${JSON.stringify(sidecar)}\n`)
  const run = await collected({ repo, proposals: (digest) => [draftOf(target, digest.ledger.citationPool[0])] })
  const res = attended(run.make())
  assert.match(res.out, /^VERDICT PASS$/m, res.out)
  assert.match(res.out, /^NOTICE sidecar-referenced-evicted=1$/m, `a full sidecar of referenced entries: ${res.out}`)
  const quiet = await collected({ proposals: (digest) => [draftOf(target, digest.ledger.citationPool[0])] })
  assert.doesNotMatch(attended(quiet.make()).out, /sidecar-referenced-evicted/, 'guard against vacuity: an ordinary run raises no such notice')
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /`notice=sidecar-referenced-evicted`/, 'and the runbook has its row')
})

test('R2-L1: histories recorded under a legacy id and under its current id are combined, so "reverted twice" is counted across both', async () => {
  const reader = await readerPromise
  const target = pathTarget('/review-cycle')
  const oldId = oldStyleId(target)
  const newId = reader.stableProposalId(target)
  const stored = Object.fromEntries(Object.entries(target).map(([k, v]) => [k, redactAll(v)]))
  const event = (i, id, name) => F.ledgerLine(100 + i, { kind: 'conduct_plan_event', event: name, event_key: `${id}:${name}:1` })
  const ledger = F.validLedger(5) + [event(0, oldId, 'proposal_adopted'), event(1, oldId, 'proposal_reverted'), event(2, newId, 'proposal_adopted'), event(3, newId, 'proposal_reverted')].join('\n') + '\n'
  const repo = F.makeRepo({ ledger, fix: 1, other: 1, author: AUTHOR })
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, SIDECAR_REL), `${JSON.stringify({ [oldId]: stored })}\n`)
  const { outDir } = F.collect(ghStubs(), repo)
  const outcomes = JSON.parse(fs.readFileSync(path.join(outDir, 'digest.json'), 'utf8')).ledger.proposalOutcomes
  assert.equal(outcomes[newId].revertedCount, 2, 'one revert under each id is two')
  assert.equal(outcomes[newId].revertedTwiceOrMore, true)
  assert.equal(outcomes[newId].adoptedCount, 2)
  assert.deepEqual(outcomes[oldId].revertedCount, 2, 'the legacy key shows the same combined history')
})

// ---- Round 2 M5: each failure of the output-ignore step has its own reason, on both entry points ----

const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0

function runnerWithIgnoreProgram(source, repo = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })) {
  const claudeHome = SB.provisionInstall(freshDir('claudehome-'))
  if (source !== null) fs.writeFileSync(path.join(claudeHome, 'workflows', 'lib', 'optimise-report-ignore.mjs'), source)
  const res = runRunner([repo], { claudeHome, stubs: ghStubs() })
  return { repo, res, line: res.logContents.match(/^RESULT FAIL .*$/m)?.[0] }
}
const reasonOfLine = (line) => /reason="(.*)"$/.exec(line ?? '')?.[1]

const IGNORE_REASONS = {
  notIgnored: 'report path is not gitignored',
  excludeUnwritable: 'the repository\'s exclude file could not be written',
  helperFailed: /^report-ignore helper failed \(exit 9, unknown\)$/,
  proofMissing: 'the ignore proof was missing or stale when the check placed',
  rootRefused: 'the main checkout could not be resolved for the output paths',
  proofUnwritable: 'the ignore proof could not be written',
  mainCheckout: 'main checkout does not match the repository',
}

test('R2-M5 (runner): an exclude file git cannot write is its own reason, not "report path is not gitignored", and nothing is placed', { skip: ROOT_USER }, () => {
  const repo = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })
  const exclude = path.join(repo, '.git', 'info', 'exclude')
  fs.mkdirSync(path.dirname(exclude), { recursive: true })
  fs.writeFileSync(exclude, '# read-only\n')
  fs.chmodSync(exclude, 0o444)
  const { res, line } = runnerWithIgnoreProgram(null, repo)
  assert.ok(line, res.logContents)
  assert.equal(reasonOfLine(line), IGNORE_REASONS.excludeUnwritable, line)
  assert.equal(fs.existsSync(path.join(repo, REPORT_REL)), false, 'nothing was placed')
})

test('R2-M5 (runner): a tracked rule that re-includes the path is "report path is not gitignored", and only that is', () => {
  const repo = F.makeRepo({ ledger: F.validLedger(5), fix: 2, other: 1, author: AUTHOR })
  fs.writeFileSync(path.join(repo, '.gitignore'), '!.claude/optimise-cycle-report.md\n!.claude/optimise-proposal-targets.json\n')
  const { line } = runnerWithIgnoreProgram(null, repo)
  assert.equal(reasonOfLine(line), IGNORE_REASONS.notIgnored, line)
})

for (const [name, source, want] of [
  ['a helper that crashes', 'process.exit(9)\n', IGNORE_REASONS.helperFailed],
  ['a helper that says it prepared but wrote no proof', "process.stdout.write('{\"ok\":true}\\n')\n", IGNORE_REASONS.proofMissing],
  ['a helper that cannot find the main checkout', "process.stdout.write('{\"ok\":false,\"reason\":\"main-checkout\"}\\n')\n", IGNORE_REASONS.rootRefused],
  ['a helper that cannot write its proof', "process.stdout.write('{\"ok\":false,\"reason\":\"proof-not-written\"}\\n')\n", IGNORE_REASONS.proofUnwritable],
]) {
  test(`R2-M5 (runner): ${name} gets its own fixed reason`, () => {
    const { res, line } = runnerWithIgnoreProgram(source)
    assert.ok(line, res.logContents)
    const got = reasonOfLine(line)
    if (want instanceof RegExp) assert.match(got, want, line)
    else assert.equal(got, want, line)
  })
}

test('R2-M5 (runner): a helper that names a main checkout that is not this repository\'s is refused with the check\'s own reason', () => {
  const other = F.makeRepo({ ledger: F.validLedger(2), fix: 1, other: 1, author: AUTHOR })
  const { res, line } = runnerWithIgnoreProgram(`const real = await import(${JSON.stringify(pathToFileURL(IGNORE).href)})\nif (process.argv[2] === 'root') process.stdout.write(${JSON.stringify(other)} + '\\n')\nelse process.stdout.write(JSON.stringify(real.prepareOutputs(process.argv[3], process.argv[4])) + '\\n')\n`)
  assert.ok(line, res.logContents)
  assert.equal(reasonOfLine(line), IGNORE_REASONS.mainCheckout, line)
  assert.equal(fs.existsSync(path.join(other, REPORT_REL)), false, 'nothing was placed in the other repository')
})

test('R2-M5 (attended): the ignore step names each cause with its own token, and the skill tells the operator what each means', () => {
  const dir = freshDir('proof-')
  const tokenOf = (repo, into = dir) => ignoreCli(['prepare', repo, into]).json?.reason
  const fresh = () => F.makeRepo({ ledger: F.validLedger(2), fix: 1, other: 1, author: AUTHOR })
  const reincluded = fresh()
  fs.writeFileSync(path.join(reincluded, '.gitignore'), '!.claude/optimise-cycle-report.md\n!.claude/optimise-proposal-targets.json\n')
  assert.equal(tokenOf(reincluded), 'not-ignored')
  assert.equal(tokenOf(freshDir('not-a-repository-')), 'main-checkout')
  if (!ROOT_USER) {
    const locked = fresh()
    const exclude = path.join(locked, '.git', 'info', 'exclude')
    fs.mkdirSync(path.dirname(exclude), { recursive: true })
    fs.writeFileSync(exclude, '# read-only\n')
    fs.chmodSync(exclude, 0o444)
    assert.equal(tokenOf(locked), 'exclude-unwritable')
    const readOnlyDir = freshDir('readonly-')
    fs.chmodSync(readOnlyDir, 0o555)
    assert.equal(tokenOf(fresh(), readOnlyDir), 'proof-not-written')
    fs.chmodSync(readOnlyDir, 0o755)
  }
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'optimise-cycle', 'SKILL.md'), 'utf8').replaceAll(/\s+/g, ' ')
  for (const token of ['not-ignored', 'main-checkout', 'exclude-unwritable', 'proof-not-written']) assert.ok(skill.includes(`\`${token}\``), `the skill names ${token}`)
})

// ---- Round 2 L3: the README's numbers for the weekly run are the runner's own constants ----

test('R2-L3: the weekly-run section of the README states the runner\'s stale-directory threshold, per-repository worst case and session ceiling as the runner has them', () => {
  const runner = fs.readFileSync(SB.SCRIPT_PATH, 'utf8')
  const num = (name) => Number(new RegExp(`^${name}=(\\d+)`, 'm').exec(runner)?.[1])
  const [stale, worst, ceilingMs] = [num('STALE_RUN_MINUTES'), num('COLLECT_WORST_CASE_S'), num('CEILING_MS')]
  assert.ok(stale > 0 && worst > 0 && ceilingMs > 0, 'guard against vacuity: the constants were read')
  const perRepo = worst + ceilingMs / 1000 + 60 + 60
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replaceAll(/\s+/g, ' ')
  assert.ok(readme.includes(`${stale.toLocaleString('en-US')} minutes`), `the README says the sweep threshold is ${stale.toLocaleString('en-US')} minutes`)
  assert.ok(readme.includes(`${perRepo.toLocaleString('en-US')} seconds`), `the README says one repository takes at worst ${perRepo.toLocaleString('en-US')} seconds`)
  assert.ok(readme.includes(`${ceilingMs.toLocaleString('en-US')}ms`) || readme.includes(`${ceilingMs.toLocaleString('en-US')} ms`), 'and the ceiling')
})

// ---- Round 2 M1, the other fields and the attended path ----

const ZW = '​‍⁠­‮﻿'
test('R2-M1: invisible and direction characters in any model-written field are stripped, so a legitimate proposal that has them PASSes and the report holds none', async () => {
  const run = await collected({ proposals: (digest) => [{ ...draftOf(pathTarget(`comp${ZW}onent`, { concern: `no${ZW}ise` }), digest.ledger.citationPool[0]), statement: `Tighten${ZW} the glob`, motivating_measurement: `9 runs${ZW}`, confirming_measurement: `better${ZW}`, reinstatement_evidence: `keep${ZW} it broad` }] })
  assert.ok(!/[​-‏‪-‮⁠-⁤﻿­]/.test(run.result.report), 'guard against vacuity: the workflow\'s report holds none of them')
  assert.ok(run.result.report.includes('Tighten the glob') && run.result.report.includes('keep it broad'), 'and the words are intact')
  assert.match(attended(run.make(undefined, { sign: false })).out, /^VERDICT PASS$/m)
})

test('R2-M1: a hostile citation is confined too, and a malformed target\'s key names are', async () => {
  const hostile = `x\n${FORGED_LEDGER}`
  const withCitation = await collected({ proposals: (digest) => [{ ...draftOf(hostileTarget, digest.ledger.citationPool[0]), citations: [digest.ledger.citationPool[0], hostile] }] })
  const citationLine = withCitation.result.report.split('\n').find((l) => l.includes('Citations (model text):'))
  assert.ok(citationLine && citationLine.includes('x Ledger records in window: 0'), `guard against vacuity: the citation reached the report, on the one line: ${citationLine}`)
  assert.match(attended(withCitation.make(undefined, { sign: false })).out, /^PLACE no$/m)
  // n is a number in the drafting schema, so a model cannot return text there (the runtime refuses it before the workflow sees it).
  const badKey = { ...hostileTarget, [`bad${ZW}key`]: 'x' }
  const malformed = await collected({ proposals: (digest) => [{ ...draftOf(badKey, digest.ledger.citationPool[0]) }] })
  const line = malformed.result.report.split('\n').find((l) => l.startsWith('Proposals rejected: malformed target:'))
  assert.ok(line && !/[​-‏‪-‮⁠﻿­]/.test(line), `the malformed-target line holds no invisible character: ${line}`)
  assert.match(attended(malformed.make(undefined, { sign: false })).out, /^VERDICT PASS$/m)
})

// The attended session has a shell and could sign what it likes, so the check must also hold up on a report the script did not write:
// each probe as a LINE OF ITS OWN, signed again here (the one place this file re-signs a forgery, and why).
for (const [name, forged] of PROBES) {
  test(`R2-M1 (a forged report that is signed again): ${name} as a line of its own is refused`, async () => {
    const run = await collected()
    const copy = run.make((r) => { r.report = `${r.report}\n${forged}\n` })
    assert.ok(JSON.parse(fs.readFileSync(copy.resultFile, 'utf8')).report.endsWith(`${forged}\n`), 'guard against vacuity: the forged line is in the saved report')
    const res = attended(copy)
    assert.match(res.out, /^VERDICT FAIL$/m, res.out)
    assert.ok(reasons(res.out).some((r) => /a line in a shape the check does not know$|^figure mismatch ledger: /.test(r)), res.out)
  })
}

test('R2-M1: a line that carries the model-text marker outside its envelope is refused', async () => {
  const run = await collected()
  const copy = run.make((r) => { r.report += '\nSome other line (model text): anything\n' })
  assert.deepEqual(reasons(attended(copy).out).filter((x) => /model text/.test(x)), ['figure mismatch model text: a line in a shape the check does not know'])
})
