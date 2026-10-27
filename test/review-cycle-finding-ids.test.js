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
// AC-QA-8: the extracted block runs through test/helpers/fake-runtime.js, which refuses a script that mentions TextEncoder,
// TextDecoder, atob, btoa or a crypto global, so a rewrite that quietly reaches for one fails to load here as it would in
// the real runtime. The inputs go in through `args` and the results come back as the workflow's return value; the expected
// values are computed out here with node:crypto, which the extracted block never sees.
const SOURCE = fs.readFileSync(WF, 'utf8')
const START = SOURCE.indexOf('const SHA256_K = [')
const END = SOURCE.indexOf('// HARN-OPT-6 (AC-SEC-2, AC-SEC-4): a lens-authored label')
assert.ok(START > 0 && END > START, 'could not locate the sha256 and finding-id block in review-cycle.js')
const BLOCK_FILE = path.join(fs.mkdtempSync(path.join(SUITE_TMPDIR, 'sha-block-')), 'sha-block.js')
fs.writeFileSync(BLOCK_FILE, `${SOURCE.slice(START, END)}\nreturn { sha: (args.sha || []).map(sha256Hex), ids: (args.ids || []).map(t => findingId(t[0], t[1], t[2])), bytes: (args.bytes || []).map(utf8Bytes) }\n`)
async function inRuntime({ sha = [], ids = [], bytes = [] }) {
  return (await runWorkflow(BLOCK_FILE, { args: { sha, ids, bytes }, agent: {} })).result
}
const nodeSha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

test('AC-QA-1: sha256 returns the published digests for the empty string, abc, the 448-bit message and one million a', async () => {
  const inputs = ['', 'abc', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', 'a'.repeat(1000000)]
  const { sha } = await inRuntime({ sha: inputs })
  assert.deepEqual(sha, [
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  ])
})

test('AC-QA-1: sha256 matches node:crypto on the padding boundaries (55, 56, 63, 64, 65, 119, 120 bytes)', async () => {
  const lengths = [0, 1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 127, 128, 129, 1000]
  const inputs = lengths.map((n) => 'x'.repeat(n))
  const { sha } = await inRuntime({ sha: inputs })
  lengths.forEach((n, i) => assert.equal(sha[i], nodeSha(inputs[i]), `${n} bytes`))
})

test('AC-QA-2: utf8Bytes agrees with Buffer.from for every kind of input, and encodes a lone surrogate as EF BF BD (not the ED A0 80 toBase64 emits)', async () => {
  const inputs = ['', 'ascii', 'café', '€', '😀', '\ud800', '\udfff', 'x\ud800y', 'a\udc00', '\ud83d', '\ud83dx', '\ude00\ud83d', 'mixed é€😀\ud800 end']
  const { bytes } = await inRuntime({ bytes: inputs })
  inputs.forEach((s, i) => assert.deepEqual(Buffer.from(bytes[i]), Buffer.from(s, 'utf8'), JSON.stringify(s)))
  assert.deepEqual(bytes[inputs.indexOf('\ud800')], [0xef, 0xbf, 0xbd])
})

const LONE = ['x\ud800y', 'x\udfffy', '\ud800', 'tail\ud83d', '\ude00head']
const FALSY = [undefined, null, 0, false, '', 7, 'a']
test('AC-QA-2: the in-script id equals the node:crypto id for a hostile corpus (surrogates, multibyte, falsy, trim, case, long)', async () => {
  const claims = ['plain', 'café € 😀', 'line1\r\nline2\ttab', ...LONE, 'q'.repeat(100 * 1024), ...FALSY]
  const locations = ['foo.js:10', '  FOO.js:İ ', 'straße.js:1', 'ΣIGMA.js:2', 'a\ud800b.js:1', ...FALSY]
  const lenses = ['lens-security', 'lens-security + lens-architecture', 'lens-é', ...FALSY]
  const triples = []
  for (const lens of lenses) for (const location of locations) for (const claim of claims) {
    if (claim === 'q'.repeat(100 * 1024) && (lens !== 'lens-security' || location !== 'foo.js:10')) continue
    triples.push([lens, location, claim])
  }
  const { ids } = await inRuntime({ ids: triples })
  triples.forEach((t, i) => assert.equal(ids[i], oracleId(...t), JSON.stringify(t).slice(0, 80)))
  assert.ok(triples.length > 400, `only ${triples.length} corpus cases ran`)
})

test('AC-QA-2: message lengths of 55, 56, 63, 64, 65, 119 and 120 bytes hash to the same id as node:crypto', async () => {
  const triples = [55, 56, 63, 64, 65, 119, 120].map((total) => ['lens-qa', '', 'c'.repeat(total - 'lens-qa'.length - 2)])
  const { ids } = await inRuntime({ ids: triples })
  triples.forEach((t, i) => assert.equal(ids[i], oracleId(...t), `${[55, 56, 63, 64, 65, 119, 120][i]} bytes`))
})

test('AC-QA-2: a seeded random differential of 1,500 triples agrees with node:crypto', async () => {
  let seed = 0x2f6e2b1
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const alphabet = ['a', 'Z', ' ', '\t', '\n', 'é', 'İ', 'Σ', '€', '😀', '\ud800', '\udc00', '.', ':', '1']
  const word = (max) => Array.from({ length: next() % max }, () => alphabet[next() % alphabet.length]).join('')
  const triples = Array.from({ length: 1500 }, () => [word(20), word(30), word(200)])
  const { ids } = await inRuntime({ ids: triples })
  triples.forEach((t, i) => assert.equal(ids[i], oracleId(...t), JSON.stringify(t)))
})

test('AC-QA-3: the ids already pinned in the ledger are reproduced', async () => {
  const { ids } = await inRuntime({ ids: [['lens-security', 'foo.js:10', 'missing auth check'], ['lens-security + lens-architecture', 'a.js:1', 'c']] })
  assert.deepEqual(ids, ['e74fb146b7ddc6cb', '7c35753185a55bf1'])
})

test('AC-QA-2: two claims one character apart, and a location differing only in case and whitespace, behave as the data criterion requires (AC-DATA-3)', async () => {
  const { ids: [a, b, c, d, e, f] } = await inRuntime({ ids: [['lens-qa', 'a.js:1', 'claim a'], ['lens-qa', 'a.js:1', 'claim b'], ['lens-qa', ' A.js:1 ', 'c'], ['lens-qa', 'a.js:1', 'c'], ['lens-qa', 'a.js:1', 'c'], ['lens-security', 'a.js:1', 'c']] })
  assert.notEqual(a, b)
  assert.equal(c, d)
  assert.notEqual(e, f)
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
const START_UUID = '7b1e4c52-0a3d-4f6e-9c1b-2d8f5e6a7b90'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
test('AC-SEC-1/2/4: hostile lens, ac_id, severity and verdict labels reach the payload as roster names or null, are counted, and leave no *_raw sibling', async () => {
  const hostileLens = `lens-security; cat ${HOME}/canary-user/.ssh/id_rsa`
  const { terminal } = await review({ spec: 'specs/example.md' }, {
    'ledger:write': [{ ...LEDGER_OK, run_id: START_UUID }, LEDGER_OK],
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
  const closed = [/^[0-9a-f]{16}$/, /^(lens|reviewer)-[a-z]+$/, /^(Critical|High|Medium|Low)$/, /^(open|rejected|spec_bug|fixed|prior)$/, /^(PASS|FAIL|UNVERIFIABLE)$/, /^AC-[A-Z][A-Z0-9]{0,15}-[0-9]{1,6}$/, /^(CLEAN|FINDINGS|BLOCKED)$/, /^[0-9a-f]{7,64}$/, UUID_RE, /^(review_cycle|done|started|blocked|aborted|repo-tuned|harness defaults|path|config|default)$/]
  assert.equal(terminal.run_id, START_UUID, 'a UUID-shaped start id is reused to pair the terminal row with it')
  const { spec, ...rest } = terminal // spec is the caller's argument; run_id is checked against the closed sets like every other string
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
  const { finding_entries, invalid_ac_ids_dropped, invalid_finding_fields_dropped, invalid_record_values_dropped, invalid_fixed_ids_dropped, duplicate_fixed_ids_dropped, invalid_prior_ids_dropped, fixed_findings_supplied, ...telemetry } = terminal
  return { ...telemetry, ...descriptors }
}
function normalise(line, ignore = []) {
  const row = JSON.parse(line)
  for (const k of ignore) delete row[k]
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
// ======================================================================================================
// Fix round 1 of review round 1
// ======================================================================================================

// ---- M1: a null severity is data, not a gap to fill. The 06049e4 writer recorded null for a non-enum severity. ----
test('M1: the writer records a null severity as null on every disposition, and a severity left out as null, never as Low', () => {
  const repo = makeTempRepo()
  const ids = ['1111111111111111', '2222222222222222', '3333333333333333', '4444444444444444']
  const entry = (id, disposition, extra = {}) => ({ id, lens: 'lens-qa', severity: null, ac_id: null, disposition, ...extra })
  const { severity: _omitted, ...noSeverity } = entry(ids[3], 'spec_bug')
  const out = JSON.parse(runAppend(repo, {
    schema_version: 1, kind: 'review_cycle', outcome: 'done', invalid_fixed_ids_dropped: 0, duplicate_fixed_ids_dropped: 0,
    finding_entries: [entry(ids[0], 'open'), entry(ids[1], 'rejected'), noSeverity, entry(ids[2], 'prior'), entry(ids[2], 'fixed')],
  }).stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const row = JSON.parse(readLedgerLines(repo)[0])
  assert.deepEqual(row.findings.map((f) => [f.id, f.disposition, f.severity]).sort(), [
    [ids[0], 'open', null], [ids[1], 'rejected', null], [ids[2], 'fixed', null], [ids[3], 'spec_bug', null],
  ].sort())
})

test('M1: no other default on a finding entry replaces a real value: a conforming severity, ac_id and lens pass through untouched', () => {
  const repo = makeTempRepo()
  const out = JSON.parse(runAppend(repo, {
    schema_version: 1, kind: 'review_cycle', outcome: 'done',
    finding_entries: ['Critical', 'High', 'Medium', 'Low'].map((severity, i) => ({ id: `${i}`.repeat(16), lens: 'lens-security', severity, ac_id: `AC-SEC-${i + 1}`, disposition: 'open' })),
  }).stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const row = JSON.parse(readLedgerLines(repo)[0])
  assert.deepEqual(row.findings.map((f) => [f.severity, f.ac_id, f.lens]), ['Critical', 'High', 'Medium', 'Low'].map((s, i) => [s, `AC-SEC-${i + 1}`, 'lens-security']))
})

// The prior finding is confirmed fixed, so its severity decides the fixed row. The 06049e4 writer counted a prior's bad
// severity, ac_id and lens when the prior became a fixed row, so the script (which sees the same fixed claims and the same
// verified priors) counts them for the CONFIRMED priors only (fix round 3, item E); nothing is left out of the comparison.
GOLDEN['non-enum severity on a rejected, an open and a prior finding'] = (() => {
  const priorOdd = { lens: 'lens-qa', location: 'odd.js:9', claim: 'prior with an odd severity', severity: 'Catastrophic', ac_id: null }
  const synthesis = {
    report: '### VERDICT\nFINDINGS', spec_bugs: [],
    rejected_findings: [{ lens: 'lens-qa', location: 'b.js:2', claim: 'odd rejected', severity: 'Nope' }],
    fixed_findings: [confirm(priorOdd)],
  }
  return {
    args: { spec: 'specs/example.md', prior_findings: [withId(priorOdd)] },
    over: { 'lens-security': { ...withFindings([lensFinding('odd open', 'c.js:3', { severity: 'Urgent' })])['lens-security'], __bypassSchemaValidation: true }, synthesis },
    descriptors: () => ({
      spec_bugs: [], rejected_findings: synthesis.rejected_findings,
      open_findings: [{ lens: 'lens-security', location: 'c.js:3', claim: 'odd open', severity: 'Urgent', ac_id: null, recurrence: null }],
      prior_findings: [withId(priorOdd)], fixed_findings: synthesis.fixed_findings,
    }),
  }
})()
GOLDEN['non-enum severity on a rejected and an open finding, nothing ignored'] = (() => {
  const synthesis = { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: [{ lens: 'lens-qa', location: 'b.js:2', claim: 'odd rejected', severity: 'Nope' }] }
  return {
    args: { spec: 'specs/example.md' },
    over: { 'lens-security': { ...withFindings([lensFinding('odd open', 'c.js:3', { severity: 'Urgent' })])['lens-security'], __bypassSchemaValidation: true }, synthesis },
    descriptors: () => ({ spec_bugs: [], rejected_findings: synthesis.rejected_findings, open_findings: [{ lens: 'lens-security', location: 'c.js:3', claim: 'odd open', severity: 'Urgent', ac_id: null, recurrence: null }] }),
  }
})()
// M5: a golden row above the cap on several dispositions at once. Capping what the script sends must not change the row.
GOLDEN['spec bugs, rejected and open findings each above MAX_FINDINGS'] = (() => {
  const open = Array.from({ length: 70 }, (_, i) => lensFinding(`open ${i}`, `o${i}.js:${i + 1}`))
  const mk = (tag, n) => Array.from({ length: n }, (_, i) => ({ lens: 'lens-qa', location: `${tag}${i}.js:1`, claim: `${tag} claim ${i}`, severity: 'Medium' }))
  const synthesis = { report: '### VERDICT\nFINDINGS', spec_bugs: mk('s', 62), rejected_findings: mk('r', 65) }
  return {
    args: { spec: 'specs/example.md' },
    over: { ...withFindings(open), synthesis },
    descriptors: () => ({ spec_bugs: synthesis.spec_bugs, rejected_findings: synthesis.rejected_findings, open_findings: open.map((f) => ({ lens: 'lens-security', location: f.location, claim: f.claim, severity: 'High', ac_id: null, recurrence: null })) }),
  }
})()

// Fix round 3, item E: a prior with a non-enum severity, a free-text ac_id and an unknown lens. Confirmed fixed, the fixed row
// takes the prior's (nulled) values and the writer's counters count them; left unconfirmed, the prior is only reconciled
// against, and the counters match the 06049e4 writer's for that case too. Nothing is ignored in either comparison.
const priorEverythingOdd = { lens: 'orchestrator', location: 'odd.js:9', claim: 'prior with every closed-set field odd', severity: 'Catastrophic', ac_id: 'free text AC' }
GOLDEN['confirmed prior with a non-enum severity, a free-text ac_id and an unknown lens'] = (() => {
  const synthesis = { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(priorEverythingOdd)] }
  return {
    args: { spec: 'specs/example.md', prior_findings: [withId(priorEverythingOdd)] },
    over: { synthesis },
    descriptors: () => ({ spec_bugs: [], rejected_findings: [], open_findings: [], prior_findings: [withId(priorEverythingOdd)], fixed_findings: synthesis.fixed_findings }),
  }
})()
GOLDEN['unconfirmed prior with a non-enum severity, a free-text ac_id and an unknown lens'] = (() => {
  const other = { lens: 'lens-qa', location: 'ok.js:1', claim: 'a prior that is confirmed', severity: 'High', ac_id: 'AC-QA-1' }
  const synthesis = { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(other)] }
  return {
    args: { spec: 'specs/example.md', prior_findings: [withId(priorEverythingOdd), withId(other)] },
    over: { synthesis },
    descriptors: () => ({ spec_bugs: [], rejected_findings: [], open_findings: [], prior_findings: [withId(priorEverythingOdd), withId(other)], fixed_findings: synthesis.fixed_findings }),
  }
})()

test('E (round 3): a confirmed prior with a non-enum severity, a free-text ac_id and an unknown lens records a fixed row with null severity, ac_id and lens, and the same three counters as the 06049e4 writer', { skip: !oldWriterPath && `git object ${OLD_WRITER_COMMIT} is not available` }, async () => {
  const fixture = GOLDEN['confirmed prior with a non-enum severity, a free-text ac_id and an unknown lens']
  const { terminal } = await review(fixture.args, fixture.over)
  const oldRepo = makeTempRepo()
  const newRepo = makeTempRepo()
  assert.equal(runOldWriter(oldRepo, legacyPayload(terminal, fixture.descriptors())).write_ok, true)
  assert.equal(JSON.parse(runAppend(newRepo, terminal).stdout.trim().split('\n').pop()).write_ok, true)
  const before = normalise(readLedgerLines(oldRepo)[0])
  const after = normalise(readLedgerLines(newRepo)[0])
  const fixedRow = (row) => row.findings.filter((f) => f.disposition === 'fixed').map((f) => [f.lens, f.severity, f.ac_id])
  assert.deepEqual(fixedRow(after), fixedRow(before), 'the fixed row\'s lens, severity and ac_id')
  for (const k of ['invalid_finding_fields_dropped', 'invalid_ac_ids_dropped', 'invalid_record_values_dropped']) assert.equal(after[k], before[k], `${k} differs from the 06049e4 writer's`)
  assert.ok(after.invalid_finding_fields_dropped + after.invalid_ac_ids_dropped > 0, 'the fixture must provoke at least one counter, or the comparison is vacuous')
})

// ---- M2 (AC-SEC-1): prior_findings and the fixed echo carry text too, and none of it may reach the payload ----
// Every free-text slot of every prior carries a sentinel, the ids are the correct ones for those hostile values, the
// synthesis echoes each prior back as a fixed_findings entry, and one prior carries a 2 KB claim. The test also runs
// the same round with one-character values: ids are a fixed 16 characters, so the ledger:write prompt must come out
// the SAME LENGTH whatever the descriptor text, which catches text added to a prior entry even when it is short.
function hostilePriors(width) {
  const filler = 'q'.repeat(width)
  const mk = (tag, extra = {}) => {
    const p = {
      lens: `lens-security + PRIOR-LENS-MID-${tag} + lens-architecture`,
      location: `${HOME}/canary-user/PRIOR-LOC-${tag}.txt 'q' \`bt\` $(id) ${filler}`,
      claim: `PRIOR-CLAIM-${tag} '"\`$(id) ${filler}`,
      evidence: `PRIOR-EVIDENCE-${tag} ${filler}`,
      consequence: `PRIOR-CONSEQUENCE-${tag}`,
      fix: `PRIOR-FIX-${tag}`,
      severity: 'High',
      ac_id: 'AC-SEC-1',
      ...extra,
    }
    return { ...p, id: oracleId(p.lens, p.location, p.claim) }
  }
  return [mk('A'), mk('B', { severity: 'Catastrophic PRIOR-SEV', ac_id: `free text PRIOR-ACID ${HOME}/canary-user/x` }), mk('C', { claim: `TWO-KB-SENTINEL-${filler}` + 'k'.repeat(2048) })]
}
async function hostilePriorRun(width) {
  const priors = hostilePriors(width)
  const out = await review({ spec: 'specs/example.md', round: 2, prior_findings: priors }, {
    synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: priors.map((p) => ({ lens: p.lens, location: p.location, claim: p.claim, ac_id: p.ac_id })) },
  })
  return { ...out, priors, prompt: out.calls.filter((c) => c.opts.label === 'ledger:write').pop().prompt }
}
test('AC-SEC-1/2/4: hostile prior_findings and their fixed_findings echo reach neither the decoded payload nor the raw ledger:write prompt, and the prompt length does not depend on the text', async () => {
  const short = await hostilePriorRun(1)
  const long = await hostilePriorRun(2048)
  const canaries = ['canary-user', 'PRIOR-LENS-MID', 'PRIOR-LOC', 'PRIOR-CLAIM', 'PRIOR-EVIDENCE', 'PRIOR-CONSEQUENCE', 'PRIOR-FIX', 'PRIOR-SEV', 'PRIOR-ACID', 'TWO-KB-SENTINEL', 'kkkkkkkkkkkkkkkk', 'qqqqqqqq', '$(id)', '`bt`', 'Catastrophic', 'free text']
  for (const run of [short, long]) {
    const payloadText = JSON.stringify(run.terminal)
    for (const c of canaries) {
      assert.ok(!payloadText.includes(c), `decoded payload carries ${c}`)
      assert.ok(!run.prompt.includes(c), `ledger:write prompt carries ${c}`)
    }
    const entries = run.terminal.finding_entries
    assert.equal(entries.filter((e) => e.disposition === 'prior').length, 3, 'all three priors verify against their correct ids')
    assert.equal(entries.filter((e) => e.disposition === 'fixed').length, 3)
    // A verified prior also carries two integer label-drop counts the writer adds once per recorded fix (finishing pass, item 1).
    for (const e of entries) {
      const keys = e.disposition === 'prior' ? ['ac_id', 'ac_id_drops', 'disposition', 'field_drops', 'id', 'lens', 'severity'] : ['ac_id', 'disposition', 'id', 'lens', 'severity']
      assert.deepEqual(Object.keys(e).sort(), keys, 'an entry carries ids, closed-set labels and (on a prior) integer counts only')
      if (e.disposition === 'prior') for (const k of ['ac_id_drops', 'field_drops']) assert.ok(Number.isInteger(e[k]) && e[k] >= 0, `${k} is a non-negative integer`)
    }
    assert.deepEqual(entries.filter((e) => e.disposition === 'prior').map((e) => [e.lens, e.severity, e.ac_id]), [['lens-security', 'High', 'AC-SEC-1'], ['lens-security', null, null], ['lens-security', 'High', 'AC-SEC-1']])
    for (const s of allStrings({ ...run.terminal, spec: undefined, run_id: undefined })) assert.ok(/^[0-9a-f]{16}$|^(lens|reviewer)-[a-z]+$|^(Critical|High|Medium|Low)$|^(open|rejected|spec_bug|fixed|prior)$|^AC-[A-Z][A-Z0-9]{0,15}-[0-9]{1,6}$|^(CLEAN|FINDINGS|BLOCKED|PASS|FAIL|UNVERIFIABLE)$|^[0-9a-f]{7,64}$|^(review_cycle|done|started|blocked|aborted|repo-tuned|harness defaults|path|config|default)$/.test(s), `payload string outside the closed sets: ${JSON.stringify(s).slice(0, 80)}`)
  }
  assert.equal(short.prompt.length, long.prompt.length, 'the prompt length must not vary with the length of the descriptor text')
})

// ---- M3 (AC-SEC-2): payloadLens, extracted from the workflow file, holds the bounds the writer's parser used to hold ----
const LENS_START = SOURCE.indexOf('// HARN-OPT-6 (AC-SEC-2, AC-SEC-4): a lens-authored label')
const LENS_END = SOURCE.indexOf('function payloadSeverity(')
assert.ok(LENS_START > 0 && LENS_END > LENS_START, 'could not locate the payload label block in review-cycle.js')
const lensBlock = () => new Function(`${SOURCE.slice(LENS_START, LENS_END)}\nreturn { payloadLens, payloadDrops }`)()
const timed = (fn) => { const t0 = process.hrtime.bigint(); const value = fn(); return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 } }

test('M3: a 100,000-character label of repeated separators resolves to its leading roster lens quickly (the label is bounded before any regex runs)', () => {
  const { payloadLens } = lensBlock()
  const label = 'lens-security' + ' + '.repeat(20000) + ', '.repeat(20000)
  assert.ok(label.length >= 100000)
  const { value, ms } = timed(() => payloadLens(label))
  assert.equal(value, 'lens-security')
  assert.ok(ms < 500, `payloadLens took ${ms} ms`)
  const sep = timed(() => payloadLens(' + '.repeat(33000) + ', '.repeat(33000)))
  assert.equal(sep.value, null)
  assert.ok(sep.ms < 500, `separator-only input took ${sep.ms} ms`)
})

test('M3: a 100,001-character whitespace label is bounded too (the " and " split backtracks quadratically on unbounded whitespace)', () => {
  const { payloadLens, payloadDrops } = lensBlock()
  const { value, ms } = timed(() => payloadLens(' '.repeat(100001)))
  assert.equal(value, null)
  assert.equal(payloadDrops.finding_fields, 1)
  assert.ok(ms < 500, `payloadLens took ${ms} ms`)
})

test('M3: only the first 256 characters of a label are read: a roster name starting past character 256 is never resolved, one ending exactly at 256 is', () => {
  const { payloadLens } = lensBlock()
  assert.equal(payloadLens('x'.repeat(256) + ' + lens-qa'), null, 'a roster name past the bound is never read')
  assert.equal(payloadLens('lens-qa + ' + 'x'.repeat(256)), 'lens-qa', 'a roster name inside the bound resolves')
  const pad = 'x'.repeat(256 - ' + lens-qa'.length)
  assert.equal((pad + ' + lens-qa').length, 256)
  assert.equal(payloadLens(pad + ' + lens-qa'), 'lens-qa', 'a name ending exactly at character 256 resolves')
  assert.equal(payloadLens(`${'x'.repeat(255)}+lens-qa`), null, 'a name that would start at character 257 does not resolve')
})

for (const label of ['lens-security + lens-architecture', 'lens-security, lens-architecture', 'lens-security and lens-architecture']) {
  test(`M3: the compound label "${label}" is attributed to the first roster lens it names, uncounted`, () => {
    const { payloadLens, payloadDrops } = lensBlock()
    assert.equal(payloadLens(label), 'lens-security')
    assert.equal(payloadLens('lens-architecture, lens-security'), 'lens-architecture', 'the FIRST named, not the alphabetically first')
    assert.equal(payloadDrops.finding_fields, 0)
  })
}

test('M3: a label carrying a control character, backtick or pipe resolves to null and is counted once; a repeated roster name still resolves', () => {
  const { payloadLens, payloadDrops } = lensBlock()
  assert.equal(payloadLens('lens-qa + lens-qa'), 'lens-qa')
  const hostile = ['lens-security\n+ lens-qa', 'lens-qa + `lens-security`', 'lens-security + a|b', 'lens-security\u0000', 'lens-security\u007f + lens-qa', '', '+', 'orchestrator', 'lens-security-extra x']
  hostile.forEach((label, i) => {
    assert.equal(payloadLens(label), null, JSON.stringify(label))
    assert.equal(payloadDrops.finding_fields, i + 1, `${JSON.stringify(label)} must be counted exactly once`)
  })
  assert.equal(payloadLens(undefined), null)
  assert.equal(payloadLens(42), null)
})

test('M3 (moved from the writer): compound labels count once under their primary lens in the reader, a compound finding confirmed fixed keeps that lens and its id, and a path-shaped segment never reaches the row', async () => {
  const mod = await import(path.join('file://', ROOT, 'workflows', 'lib', 'optimise-read.mjs'))
  const labels = ['lens-security + lens-architecture', 'lens-security, lens-architecture', 'lens-qa and lens-security', 'lens-qa', 'orchestrator', 'lens-security + /Users/someone/private', 'lens-qa+/Users/x']
  const repo = makeTempRepo()
  const { terminal } = await review({ spec: 'specs/example.md' }, {
    synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: labels.map((lens, i) => ({ lens, location: `a${i}.js:1`, claim: `claim ${i}`, severity: 'Low' })) },
    'ledger:write': realWriter(repo),
  })
  assert.ok(terminal)
  const row = JSON.parse(readLedgerLines(repo).pop())
  assert.equal(row.findings.length, labels.length)
  assert.ok(!JSON.stringify(row).includes('/Users/'), 'a path-shaped segment reached the row')
  assert.ok(row.findings.every((f) => !Object.keys(f).some((k) => k.endsWith('_raw'))))
  const rework = mod.aggregateRework([{ ...row, repo: 'demo' }])
  assert.equal(rework.lensDispositionCounts['lens-security']?.rejected, 3, 'three labels lead with lens-security')
  assert.equal(rework.lensDispositionCounts['lens-qa']?.rejected, 3, 'lens-qa and lens-qa and lens-security, bare lens-qa, and the glued path')
  assert.equal(rework.lensDispositionCounts['lens-architecture'], undefined, 'the secondary lens is not double counted')
  assert.equal(rework.unattributedFindings, 1, 'only the label naming no roster lens is unattributed')

  const compound = { lens: 'lens-security + lens-architecture', location: 'a.js:1', claim: 'c', severity: 'Low' }
  const repo2 = makeTempRepo()
  await review({ spec: 'specs/example.md' }, { synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: [], rejected_findings: [compound] }, 'ledger:write': realWriter(repo2) })
  await review({ spec: 'specs/example.md', round: 2, prior_findings: [withId(compound)] }, { synthesis: { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [], fixed_findings: [confirm(compound)] }, 'ledger:write': realWriter(repo2) })
  const rows = readLedgerLines(repo2).map((l) => JSON.parse(l)).filter((r) => r.outcome !== 'started')
  const fixed = rows[1].findings.filter((f) => f.disposition === 'fixed')
  assert.deepEqual(fixed.map((f) => [f.id, f.lens]), [['7c35753185a55bf1', 'lens-security']])
  assert.equal(rows[1].invalid_prior_ids_dropped, 0)
  assert.equal(rows[1].invalid_fixed_ids_dropped, 0)
  assert.equal(mod.aggregateRework([{ ...rows[1], repo: 'demo' }]).lensDispositionCounts['lens-security']?.fixed, 1)
})

// ---- L1 (AC-SEC-2): verdicts and run_id are mapped or checked in the script ----
test('L1: a lens verdict outside CLEAN, FINDINGS and BLOCKED reaches the payload as null and is counted under invalid_record_values_dropped; the rest are kept', async () => {
  const hostile = `ALL-GOOD ${HOME}/canary-user/verdict $(id) \`x\``
  const { terminal, payloads, result } = await review({}, {
    'lens-qa': { ...CLEAN, __bypassSchemaValidation: true, verdict: hostile },
    ...withFindings([lensFinding('real finding', 'a.js:1')]),
  })
  assert.ok(result && terminal)
  assert.ok(!JSON.stringify(payloads).includes('canary-user'), 'the verdict text reached a payload')
  assert.equal(terminal.verdicts['lens-qa'], null)
  assert.equal(terminal.verdicts['lens-security'], 'FINDINGS')
  // No spec is passed, so only lens-security and lens-qa run; lens-product has no verdict to check.
  assert.equal(terminal.invalid_record_values_dropped, 1)
  for (const v of Object.values(terminal.verdicts)) assert.ok(v === null || ['CLEAN', 'FINDINGS', 'BLOCKED'].includes(v), `verdict outside the enum: ${JSON.stringify(v)}`)
})

test('L1: a start run_id is reused for the terminal row only when it is UUID-shaped; a hostile one is dropped and the row is still written', async () => {
  const hostileId = `${HOME}/canary-user/run $(id)`
  const hostile = await review({}, { 'ledger:write': [{ ...LEDGER_OK, run_id: hostileId }, LEDGER_OK] })
  assert.ok(!('run_id' in hostile.terminal), `a non-UUID run_id must not be sent: ${JSON.stringify(hostile.terminal.run_id)}`)
  assert.ok(!hostile.calls.filter((c) => c.opts.label === 'ledger:write').some((c) => c.prompt.includes('canary-user')))
  assert.ok(!JSON.stringify(hostile.payloads).includes('canary-user'))
  assert.equal(hostile.payloads.filter((p) => p.outcome !== 'started').length, 1)
  const good = await review({}, { 'ledger:write': [{ ...LEDGER_OK, run_id: START_UUID }, LEDGER_OK] })
  assert.equal(good.terminal.run_id, START_UUID)
  for (const odd of ['r1', START_UUID.toUpperCase().slice(0, -1), `${START_UUID}-x`, ` ${START_UUID}`, START_UUID.replace(/-/g, '')]) {
    const r = await review({}, { 'ledger:write': [{ ...LEDGER_OK, run_id: odd }, LEDGER_OK] })
    assert.ok(!('run_id' in r.terminal), `${JSON.stringify(odd)} is not UUID-shaped and must not be reused`)
  }
})

// ---- L2 (AC-QA-10): a non-null, non-array descriptor list is a counted drop ----
test('L2: a non-null, non-array spec_bugs, rejected_findings or fixed_findings each add one to invalid_record_values_dropped, and the run makes one terminal write', async () => {
  for (const bad of ['oops', 7, { a: 1 }, true]) {
    const { terminal, payloads, result } = await review({ spec: 'specs/example.md' }, {
      synthesis: { __bypassSchemaValidation: true, report: '### VERDICT\nCLEAN', spec_bugs: bad, rejected_findings: bad, fixed_findings: bad },
    })
    assert.equal(typeof result.report, 'string')
    assert.equal(payloads.filter((p) => p.outcome !== 'started').length, 1, `one terminal write for ${JSON.stringify(bad)}`)
    assert.equal(terminal.invalid_record_values_dropped, 3, `three malformed lists (${JSON.stringify(bad)}) must be counted`)
    assert.deepEqual(terminal.finding_entries, [])
  }
  const one = await review({ spec: 'specs/example.md' }, { synthesis: { __bypassSchemaValidation: true, report: '### VERDICT\nCLEAN', spec_bugs: 'oops', rejected_findings: [] } })
  assert.equal(one.terminal.invalid_record_values_dropped, 1, 'only the malformed list is counted')
})

test('L2: a null or absent list is not a malformed one and is not counted', async () => {
  const { terminal } = await review({ spec: 'specs/example.md' }, { synthesis: { __bypassSchemaValidation: true, report: '### VERDICT\nCLEAN', spec_bugs: null, rejected_findings: null, fixed_findings: null } })
  assert.equal(terminal.invalid_record_values_dropped, 0)
  const absent = await review({ spec: 'specs/example.md' }, { synthesis: { __bypassSchemaValidation: true, report: '### VERDICT\nCLEAN' } })
  assert.equal(absent.terminal.invalid_record_values_dropped, 0)
})

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
    assert.deepEqual(normalise(readLedgerLines(newRepo)[0], fixture.ignore), normalise(readLedgerLines(oldRepo)[0], fixture.ignore))
  })
}
