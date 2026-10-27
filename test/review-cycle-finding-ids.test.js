// HARN-OPT-6 T1 (specs/harn-opt-6.md): review-cycle.js computes finding ids itself with a pure-JS sha256, and its
// ledger payloads carry ids only. test/harn-opt-6-t1.test.js pins the headline behaviour; this file holds the rest of
// the criteria: the sha256 and the id function run as extracted from the workflow file (AC-QA-1, AC-QA-2), the
// runtime double refusing the globals the real runtime lacks (AC-QA-8), label neutralisation and its counters
// (AC-SEC-1, AC-SEC-2, AC-SEC-4), the prior-id guard (AC-QA-6, AC-DATA-4, AC-OPS-6), malformed descriptors
// (AC-QA-10), mixed-version installs (AC-DATA-6a) and golden-row equivalence against the writer at 06049e4
// (AC-DATA-2). The id oracle is test/helpers/finding-entries.js findingId, a node:crypto copy of the pre-change hash.
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')
const { findingId: oracleId } = require('./helpers/finding-entries.js')
const { sanitizedGitEnv } = require('./helpers/git-env.js')
const { makeTempRepo, runAppend, readLedgerLines, cleanupTempRepos, SUITE_TMPDIR } = require('./helpers/temp-repo.js')

const ROOT = path.join(__dirname, '..')
const WF = path.join(ROOT, 'workflows', 'review-cycle.js')

test.after(cleanupTempRepos)

// ---- the functions under test, extracted from the workflow file itself, not copied ----
const SOURCE = fs.readFileSync(WF, 'utf8')
const START = SOURCE.indexOf('const SHA256_K = [')
const END = SOURCE.indexOf('// HARN-OPT-6 (AC-SEC-2, AC-SEC-4): a lens-authored label')
assert.ok(START > 0 && END > START, 'could not locate the sha256 and finding-id block in review-cycle.js')
const { sha256Hex, findingId, utf8Bytes } = new Function(`${SOURCE.slice(START, END)}\nreturn { sha256Hex, findingId, utf8Bytes }`)()
const nodeSha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

test('AC-QA-1: sha256 returns the published digests for the empty string, abc, the 448-bit message and one million a', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  assert.equal(sha256Hex('a'.repeat(1000000)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
})

test('AC-QA-1: sha256 matches node:crypto on the padding boundaries (55, 56, 63, 64, 65, 119, 120 bytes)', () => {
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 127, 128, 129, 1000]) {
    const input = 'x'.repeat(n)
    assert.equal(sha256Hex(input), nodeSha(input), `${n} bytes`)
  }
})

test('AC-QA-2: utf8Bytes agrees with Buffer.from for every kind of input, and encodes a lone surrogate as EF BF BD (not the ED A0 80 toBase64 emits)', () => {
  const inputs = ['', 'ascii', 'café', '€', '😀', '\ud800', '\udfff', 'x\ud800y', 'a\udc00', '\ud83d', '\ud83dx', '\ude00\ud83d', 'mixed é€😀\ud800 end']
  for (const s of inputs) assert.deepEqual(Buffer.from(utf8Bytes(s)), Buffer.from(s, 'utf8'), JSON.stringify(s))
  assert.deepEqual(utf8Bytes('\ud800'), [0xef, 0xbf, 0xbd])
})

const LONE = ['x\ud800y', 'x\udfffy', '\ud800', 'tail\ud83d', '\ude00head']
const FALSY = [undefined, null, 0, false, '', 7, 'a']
test('AC-QA-2: the in-script id equals the node:crypto id for a hostile corpus (surrogates, multibyte, falsy, trim, case, long)', () => {
  const claims = ['plain', 'café € 😀', 'line1\r\nline2\ttab', ...LONE, 'q'.repeat(100 * 1024), ...FALSY]
  const locations = ['foo.js:10', '  FOO.js:İ ', 'straße.js:1', 'ΣIGMA.js:2', 'a\ud800b.js:1', ...FALSY]
  const lenses = ['lens-security', 'lens-security + lens-architecture', 'lens-é', ...FALSY]
  let checked = 0
  for (const lens of lenses) for (const location of locations) for (const claim of claims) {
    if (claim === 'q'.repeat(100 * 1024) && (lens !== 'lens-security' || location !== 'foo.js:10')) continue
    assert.equal(findingId(lens, location, claim), oracleId(lens, location, claim), JSON.stringify([lens, location, claim]).slice(0, 80))
    checked++
  }
  assert.ok(checked > 400, `only ${checked} corpus cases ran`)
})

test('AC-QA-2: message lengths of 55, 56, 63, 64, 65, 119 and 120 bytes hash to the same id as node:crypto', () => {
  for (const total of [55, 56, 63, 64, 65, 119, 120]) {
    const claim = 'c'.repeat(total - 'lens-qa'.length - 2)
    assert.equal(findingId('lens-qa', '', claim), oracleId('lens-qa', '', claim), `${total} bytes`)
  }
})

test('AC-QA-2: a seeded random differential of 1,500 triples agrees with node:crypto', () => {
  let seed = 0x2f6e2b1
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const alphabet = ['a', 'Z', ' ', '\t', '\n', 'é', 'İ', 'Σ', '€', '😀', '\ud800', '\udc00', '.', ':', '1']
  const word = (max) => Array.from({ length: next() % max }, () => alphabet[next() % alphabet.length]).join('')
  for (let i = 0; i < 1500; i++) {
    const [lens, location, claim] = [word(20), word(30), word(200)]
    assert.equal(findingId(lens, location, claim), oracleId(lens, location, claim), JSON.stringify([lens, location, claim]))
  }
})

test('AC-QA-3: the ids already pinned in the ledger are reproduced', () => {
  assert.equal(findingId('lens-security', 'foo.js:10', 'missing auth check'), 'e74fb146b7ddc6cb')
  assert.equal(findingId('lens-security + lens-architecture', 'a.js:1', 'c'), '7c35753185a55bf1')
})

test('AC-QA-2: two claims one character apart, and a location differing only in case and whitespace, behave as the data criterion requires (AC-DATA-3)', () => {
  assert.notEqual(findingId('lens-qa', 'a.js:1', 'claim a'), findingId('lens-qa', 'a.js:1', 'claim b'))
  assert.equal(findingId('lens-qa', ' A.js:1 ', 'c'), findingId('lens-qa', 'a.js:1', 'c'))
  assert.notEqual(findingId('lens-qa', 'a.js:1', 'c'), findingId('lens-security', 'a.js:1', 'c'))
})

// ---- AC-QA-8: the runtime double refuses what the real runtime lacks ----
for (const [name, code] of [
  ['TextEncoder', 'const b = new TextEncoder().encode("x")'],
  ['TextDecoder', 'const b = new TextDecoder().decode(new Uint8Array(0))'],
  ['atob', 'const b = atob("eA==")'],
  ['btoa', 'const b = btoa("x")'],
  ['a bare crypto global', 'const b = crypto.subtle'],
  ['globalThis.crypto', 'const b = globalThis.crypto'],
]) {
  test(`AC-QA-8: the fake runtime refuses to load a script that uses ${name}`, async () => {
    const dir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'fake-global-'))
    const file = path.join(dir, 'uses-global.js')
    fs.writeFileSync(file, `${code}\nreturn { verdict: 'DONE' }\n`)
    await assert.rejects(runWorkflow(file, { args: {}, agent: {} }), /statically rejects/)
  })
}

// ---- fixtures for runs of the whole workflow ----
const LEDGER_OK = { run_id: 'r1', ts: '2026-08-10T00:00:00.000Z', write_ok: true, write_error: null }
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
async function review(args, overrides) {
  const out = await runWorkflow(WF, { args, agent: agents(overrides) })
  const payloads = out.calls.filter((c) => c.opts.label === 'ledger:write').map((c) => extractLedgerPayload(c.prompt))
  return { ...out, payloads, terminal: payloads.filter((p) => p.outcome !== 'started').pop() }
}
const lensFinding = (claim, location, extra = {}) => ({ severity: 'High', claim, location, evidence: 'e', consequence: 'c', fix: 'f', ...extra })
const withFindings = (findings) => ({ 'lens-security': { verdict: 'FINDINGS', coverage: COVERAGE, findings, ...TIP } })

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => allStrings(v, out))
  return out
}

// ---- AC-SEC-1, AC-SEC-2, AC-SEC-4: hostile labels never reach the payload, and each neutralisation is counted ----
const HOME = require('node:os').homedir()
test('AC-SEC-1/2/4: hostile lens, ac_id, severity and verdict labels reach the payload as roster names or null, are counted, and leave no *_raw sibling', async () => {
  const hostileLens = `lens-security; cat ${HOME}/canary-user/.ssh/id_rsa`
  const { terminal } = await review({ spec: 'specs/example.md' }, {
    ...withFindings([lensFinding('lens finding', 'a.js:1', { ac_id: `AC-SEC-1 ${HOME}/canary-user/secret.txt $(id)` })]),
    'lens-qa': { ...CLEAN, __bypassSchemaValidation: true, ac_verdicts: [{ id: `NOT-AN-AC '${HOME}/canary-user/x\``, verdict: 'MAYBE', evidence: 'EVIDENCE-CANARY' }, { id: 'AC-QA-1', verdict: 'PASS', evidence: 'e' }] },
    synthesis: {
      report: '### VERDICT\nFINDINGS',
      spec_bugs: [{ lens: hostileLens, location: `${HOME}/canary-user/secret.txt`, claim: 'CLAIM-CANARY `id` $(id)', ac_id: 'free text', severity: 'Catastrophic' }],
      rejected_findings: [{ lens: 'lens-security + CANARY-MIDDLE-SEGMENT + lens-architecture', location: 'b.js:2', claim: 'rejected claim', severity: 'Nope' }],
    },
  })
  const text = JSON.stringify(terminal)
  for (const canary of ['canary-user', 'CANARY', "'", '`', '$(id)', 'Catastrophic', 'MAYBE', 'NOT-AN-AC', 'free text']) assert.ok(!text.includes(canary), `payload carries ${canary}`)
  for (const key of ['lens_raw', 'ac_id_raw', 'severity_raw', 'verdict_raw']) assert.ok(!text.includes(`"${key}"`), `payload carries ${key}`)
  const byId = new Map(terminal.finding_entries.map((e) => [e.id, e]))
  const specBug = byId.get(oracleId(hostileLens, `${HOME}/canary-user/secret.txt`, 'CLAIM-CANARY `id` $(id)'))
  assert.ok(specBug, 'the spec bug lands under the id of its ORIGINAL descriptor')
  assert.equal(specBug.lens, null)
  assert.equal(specBug.ac_id, null)
  const rejected = byId.get(oracleId('lens-security + CANARY-MIDDLE-SEGMENT + lens-architecture', 'b.js:2', 'rejected claim'))
  assert.equal(rejected.lens, 'lens-security', 'a compound label resolves to the first roster lens it names')
  assert.equal(rejected.severity, null)
  const open = byId.get(oracleId('lens-security', 'a.js:1', 'lens finding'))
  assert.deepEqual([open.ac_id, open.severity], [null, 'High'])
  assert.deepEqual(terminal.ac_verdicts, [{ ac_id: null, verdict: null }, { ac_id: 'AC-QA-1', verdict: 'PASS' }])
  assert.equal(terminal.invalid_ac_ids_dropped, 3, 'the spec bug ac_id, the open finding ac_id and the ac_verdict ac_id')
  assert.equal(terminal.invalid_finding_fields_dropped, 3, 'one nulled lens and two nulled severities (the spec bug and the rejected finding)')
  assert.equal(terminal.invalid_record_values_dropped, 1, 'the nulled verdict')
  // AC-SEC-2: every string anywhere in the payload is a member of a closed set, apart from the caller's spec.
  const closed = [/^[0-9a-f]{16}$/, /^(lens|reviewer)-[a-z]+$/, /^(Critical|High|Medium|Low)$/, /^(open|rejected|spec_bug|fixed|prior)$/, /^(PASS|FAIL|UNVERIFIABLE)$/, /^AC-[A-Z][A-Z0-9]{0,15}-[0-9]{1,6}$/, /^(CLEAN|FINDINGS|BLOCKED)$/, /^[0-9a-f]{7,64}$/, /^(review_cycle|done|started|blocked|aborted|repo-tuned|harness defaults|path|config|default)$/]
  const { spec, run_id, ...rest } = terminal // run_id is the writer's own start id, reused for pairing
  for (const s of allStrings(rest)) assert.ok(closed.some((re) => re.test(s)), `payload string outside the closed sets: ${JSON.stringify(s)}`)
})

// ---- AC-QA-10: malformed descriptors are counted drops, never throws ----
test('AC-QA-10: a null, non-object or incomplete synthesis descriptor is dropped and counted, the run returns, and it makes one terminal write', async () => {
  const { terminal, payloads, result } = await review({ spec: 'specs/example.md' }, {
    synthesis: {
      __bypassSchemaValidation: true,
      report: '### VERDICT\nFINDINGS',
      spec_bugs: [null, 'text', { lens: 'lens-qa', location: 'a.js:1' }, { lens: 'lens-qa', location: 'a.js:2', claim: 'kept' }],
      rejected_findings: [{ claim: 'no lens or location' }],
    },
  })
  assert.equal(typeof result.report, 'string')
  assert.equal(payloads.filter((p) => p.outcome !== 'started').length, 1)
  assert.deepEqual(terminal.finding_entries.map((e) => e.id), [oracleId('lens-qa', 'a.js:2', 'kept')])
  assert.equal(terminal.invalid_record_values_dropped, 4)
})

test('AC-QA-10: a non-array spec_bugs is treated as empty and the run still returns', async () => {
  const { terminal, result } = await review({ spec: 'specs/example.md' }, { synthesis: { __bypassSchemaValidation: true, report: '### VERDICT\nCLEAN', spec_bugs: 'oops', rejected_findings: [] } })
  assert.equal(typeof result.report, 'string')
  assert.deepEqual(terminal.finding_entries, [])
  assert.equal(terminal.spec_bug_count, null)
})

// ---- AC-QA-6, AC-DATA-4, AC-OPS-6: the prior-id guard lives in the script ----
const PRIOR_A = { lens: 'lens-security', location: 'foo.js:10', claim: 'missing auth check', severity: 'High', ac_id: 'AC-SEC-1' }
const PRIOR_B = { lens: 'lens-qa', location: 'bar.js:2', claim: 'no test for the edge', severity: 'Low', ac_id: null }
const withId = (p) => ({ ...p, id: oracleId(p.lens, p.location, p.claim) })
const confirm = (p) => ({ lens: p.lens, location: p.location, claim: p.claim })

test('AC-QA-6/AC-DATA-4: a wrong, stale, missing or borrowed prior id is dropped and counted, and a correct sibling still records fixed', async () => {
  const wrongChar = { ...withId(PRIOR_A), id: `${withId(PRIOR_A).id.slice(0, 15)}${withId(PRIOR_A).id.endsWith('0') ? '1' : '0'}` }
  const stale = { ...PRIOR_A, claim: 'missing auth check (reworded)', id: withId(PRIOR_A).id }
  const noId = { ...PRIOR_B }
  const borrowed = { ...PRIOR_B, id: withId(PRIOR_A).id }
  const good = withId({ lens: 'lens-data', location: 'c.js:3', claim: 'good sibling' })
  const { terminal, logs } = await review({ prior_findings: [wrongChar, stale, noId, borrowed, good] }, {
    synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(good), confirm(PRIOR_A)] },
  })
  assert.equal(terminal.invalid_prior_ids_dropped, 4)
  assert.deepEqual(terminal.finding_entries.filter((e) => e.disposition === 'prior').map((e) => e.id), [good.id])
  assert.equal(terminal.finding_entries.filter((e) => e.disposition === 'fixed').length, 2, 'both claims travel as fixed candidates; the writer reconciles them against the prior ids')
  assert.ok(logs.some((l) => l.includes('invalid_prior_ids_dropped=4')), `expected the drop to be logged, got ${JSON.stringify(logs)}`)
})

test('AC-OPS-6: no drop line is logged when nothing was dropped', async () => {
  const { logs, terminal } = await review({ prior_findings: [withId(PRIOR_A)] }, {
    synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(PRIOR_A)] },
  })
  assert.equal(terminal.invalid_prior_ids_dropped, 0)
  assert.ok(!logs.some((l) => /_dropped=/.test(l)), `unexpected drop line: ${JSON.stringify(logs)}`)
})

test('AC-ARCH-8: with no prior_findings argument the payload carries no prior ids, no prior counter and no fixed baselines', async () => {
  const { terminal } = await review({})
  for (const key of ['invalid_prior_ids_dropped', 'invalid_fixed_ids_dropped', 'duplicate_fixed_ids_dropped']) assert.ok(!(key in terminal), key)
  assert.ok(!terminal.finding_entries.some((e) => e.disposition === 'prior' || e.disposition === 'fixed'))
})

// End to end against the real writer: the fixed flow, duplicates, and a fixed claim that is also open this round.
function realWriter(repo) {
  return (prompt) => JSON.parse(runAppend(repo, extractLedgerPayload(prompt)).stdout.trim().split('\n').pop())
}
test('AC-QA-6: through the real writer, a confirmed prior records one fixed entry, a repeat is a duplicate drop, an unmatched claim is an invalid drop, and a claim also open this round is dropped', async () => {
  const repo = makeTempRepo()
  const openNow = withId({ lens: 'lens-security', location: 'foo.js:10', claim: 'still broken' })
  const { terminal } = await review({ prior_findings: [withId(PRIOR_A), openNow] }, {
    ...withFindings([lensFinding('still broken', 'foo.js:10')]),
    synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(PRIOR_A), confirm(PRIOR_A), confirm(openNow), { lens: 'lens-qa', location: 'nowhere.js:1', claim: 'never open' }] },
    'ledger:write': realWriter(repo),
  })
  assert.ok(terminal)
  const row = JSON.parse(readLedgerLines(repo).pop())
  const fixed = row.findings.filter((f) => f.disposition === 'fixed')
  assert.deepEqual(fixed.map((f) => [f.id, f.lens, f.severity, f.ac_id]), [[withId(PRIOR_A).id, 'lens-security', 'High', 'AC-SEC-1']])
  assert.equal(row.duplicate_fixed_ids_dropped, 1)
  assert.equal(row.invalid_fixed_ids_dropped, 2, 'the unmatched claim and the claim that is also open')
  assert.equal(row.invalid_prior_ids_dropped, 0)
})

// ---- AC-DATA-6a and AC-DATA-2 need the writer as it stood before this change ----
const OLD_WRITER_COMMIT = '06049e4'
let oldWriterPath = null
try {
  const dir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'old-writer-'))
  oldWriterPath = path.join(dir, 'ledger-append.mjs')
  fs.writeFileSync(oldWriterPath, execFileSync('git', ['show', `${OLD_WRITER_COMMIT}:workflows/lib/ledger-append.mjs`], { cwd: ROOT, encoding: 'utf8', env: sanitizedGitEnv(), maxBuffer: 64 * 1024 * 1024 }))
} catch {
  oldWriterPath = null
}
const runOldWriter = (repo, payload) => JSON.parse(spawnSync('node', [oldWriterPath], { cwd: repo, input: JSON.stringify(payload), encoding: 'utf8', env: sanitizedGitEnv() }).stdout.trim().split('\n').pop())

test('AC-DATA-6a: the new payload fed to the writer at 06049e4 is refused by name and never lands a row with merged or missing findings', { skip: !oldWriterPath && `git object ${OLD_WRITER_COMMIT} is not available` }, async () => {
  const { terminal } = await review({}, withFindings([lensFinding('first claim', 'a.js:1'), lensFinding('second claim', 'a.js:2')]))
  assert.equal(terminal.finding_entries.filter((e) => e.disposition === 'open').length, 2)
  const repo = makeTempRepo()
  const out = runOldWriter(repo, terminal)
  assert.equal(out.write_ok, false)
  assert.match(out.write_error, /finding_entries: not an allowed property/)
  assert.equal(readLedgerLines(repo).length, 0, 'no row lands')
})

test('AC-OPS-4: through the 06049e4 writer the terminal write ends write_ok false, is logged, and never retries without the findings key', { skip: !oldWriterPath && `git object ${OLD_WRITER_COMMIT} is not available` }, async () => {
  const repo = makeTempRepo()
  const { result, logs, calls } = await review({}, {
    ...withFindings([lensFinding('first claim', 'a.js:1')]),
    'ledger:write': (prompt) => runOldWriter(repo, extractLedgerPayload(prompt)),
  })
  assert.equal(calls.filter((c) => c.opts.label === 'ledger:write').length, 2, 'a start and one terminal attempt, no retry')
  assert.equal(result.ledger_write_failed, true)
  assert.ok(logs.some((l) => l.includes('TELEMETRY NOT RECORDED')))
  assert.ok(readLedgerLines(repo).every((l) => JSON.parse(l).outcome === 'started'), 'only the started row landed')
})

// AC-DATA-2: the same round, described as descriptors to the writer at 06049e4 and as ids to the new writer, lands
// the same row apart from run_id, ts and the *_raw siblings.
function legacyPayload(terminal, descriptors) {
  const { finding_entries, invalid_ac_ids_dropped, invalid_finding_fields_dropped, invalid_record_values_dropped, invalid_fixed_ids_dropped, duplicate_fixed_ids_dropped, invalid_prior_ids_dropped, ...telemetry } = terminal
  return { ...telemetry, ...descriptors }
}
function normalise(line) {
  const row = JSON.parse(line)
  delete row.run_id
  delete row.ts
  delete row.repo
  for (const f of row.findings || []) for (const k of Object.keys(f)) if (k.endsWith('_raw')) delete f[k]
  return row
}
const GOLDEN = {
  'zero findings': { args: {}, over: {}, descriptors: () => ({ spec_bugs: null, rejected_findings: [], open_findings: [] }) },
  'one of each disposition with compound labels': (() => {
    const synthesis = {
      report: '### VERDICT\nFINDINGS',
      spec_bugs: [{ lens: 'lens-security + lens-architecture', location: 'a.js:1', claim: 'c', severity: 'Low' }],
      rejected_findings: [{ lens: 'lens-qa', location: 'b.js:2', claim: 'false alarm', ac_id: 'AC-QA-1' }],
      fixed_findings: [confirm(PRIOR_A)],
    }
    return {
      args: { spec: 'specs/example.md', prior_findings: [withId(PRIOR_A)] },
      over: { ...withFindings([lensFinding('open claim', 'c.js:3', { ac_id: 'AC-SEC-2' })]), synthesis },
      descriptors: () => ({
        spec_bugs: synthesis.spec_bugs,
        rejected_findings: synthesis.rejected_findings,
        open_findings: [{ lens: 'lens-security', location: 'c.js:3', claim: 'open claim', severity: 'High', ac_id: 'AC-SEC-2', recurrence: null }],
        prior_findings: [withId(PRIOR_A)],
        fixed_findings: synthesis.fixed_findings,
      }),
    }
  })(),
  '70 open findings (truncation)': (() => {
    const findings = Array.from({ length: 70 }, (_, i) => lensFinding(`claim ${i}`, `f${i}.js:${i + 1}`))
    return {
      args: {},
      over: withFindings(findings),
      descriptors: () => ({ spec_bugs: null, rejected_findings: [], open_findings: findings.map((f) => ({ lens: 'lens-security', location: f.location, claim: f.claim, severity: 'High', ac_id: null, recurrence: null })) }),
    }
  })(),
  'duplicate and contradictory fixed confirmations': (() => {
    const synthesis = { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(PRIOR_A), confirm(PRIOR_A), confirm(PRIOR_B), { lens: 'lens-qa', location: 'x.js:1', claim: 'never open' }] }
    return {
      args: { prior_findings: [withId(PRIOR_A), withId(PRIOR_B)] },
      over: { 'lens-qa': { verdict: 'FINDINGS', coverage: COVERAGE, findings: [lensFinding(PRIOR_B.claim, PRIOR_B.location)], ...TIP }, synthesis },
      descriptors: () => ({
        spec_bugs: null, rejected_findings: [],
        open_findings: [{ lens: 'lens-qa', location: PRIOR_B.location, claim: PRIOR_B.claim, severity: 'High', ac_id: null, recurrence: null }],
        prior_findings: [withId(PRIOR_A), withId(PRIOR_B)],
        fixed_findings: synthesis.fixed_findings,
      }),
    }
  })(),
}
for (const [name, fixture] of Object.entries(GOLDEN)) {
  test(`AC-DATA-2: golden row equivalence with the writer at 06049e4: ${name}`, { skip: !oldWriterPath && `git object ${OLD_WRITER_COMMIT} is not available` }, async () => {
    const { terminal } = await review(fixture.args, fixture.over)
    const descriptors = fixture.descriptors()
    // The script nulls spec_bugs on a no-spec run and moves them to open; the fixtures here keep to what the
    // descriptors above already say, so only the descriptors differ in shape between the two payloads.
    const oldRepo = makeTempRepo()
    const newRepo = makeTempRepo()
    const oldOut = runOldWriter(oldRepo, legacyPayload(terminal, descriptors))
    assert.equal(oldOut.write_ok, true, oldOut.write_error)
    assert.equal(JSON.parse(runAppend(newRepo, terminal).stdout.trim().split('\n').pop()).write_ok, true)
    assert.deepEqual(normalise(readLedgerLines(newRepo)[0]), normalise(readLedgerLines(oldRepo)[0]))
  })
}
