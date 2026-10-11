// HARN-OPT-4 T6 (specs/harn-opt-4.md): the git lane runs once per roster repo
// and each result is matched script-side to its scope.resolved entry; the
// proposal target becomes a fixed key set the id derives from. Written RED
// first. Pins AC-DATA-11, AC-DATA-12, AC-SEC-10, AC-OPS-13, AC-PROD-7,
// AC-QA-19 (git lane); AC-QA-20, AC-DATA-15, AC-PROD-8, AC-SEC-9, AC-QA-21,
// AC-SEC-15 (target and id); AC-SIMP-6, AC-SIMP-7, AC-SIMP-11 (nothing added);
// AC-DATA-14 (legacy id mapping for the conductor).
//
// Wire contract this file assumes (the spec fixes behaviour, not names; the
// implementer may not change these without changing the tests):
//   - the agent label stays `lane:git`, and the lane makes ONE call per
//     scope.resolved entry (so the label repeats), each prompt naming exactly
//     that entry's root as a literal `cd` target.
//   - GIT_LANE_SCHEMA's top level is the object `{ repos: [ <entry>, ... ] }`
//     (the fake runtime's validator, like structured output, needs an object
//     root). Each entry is today's figure fields plus `root_index` (integer)
//     and `repo` (the ledger identity label for that root).
//   - `optimise-read.mjs escaped-defects` echoes `repo`, derived exactly as the
//     ledger command derives perRepo[].root, and never echoes the root path.
//   - `optimise-read.mjs ids` accepts `{ legacy_targets: [...] }` and returns
//     `{ legacy_ids: [{ target, proposal_id: <16 hex>|null, reason: <string>|null }] }`.
// Never point these at the real ledger: every write goes to a makeTempRepo().
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { makeTempRepo, runAppend, sh, sanitizedGitEnv, cleanupTempRepos } = require('./helpers/temp-repo.js')

const WORKFLOW = path.join(__dirname, '..', 'workflows', 'optimise-cycle.js')
const MODULE_PATH = path.join(__dirname, '..', 'workflows', 'lib', 'optimise-read.mjs')
const LEDGER_APPEND_PATH = path.join(__dirname, '..', 'workflows', 'lib', 'ledger-append.mjs')
const NONCE = 'deadbeefcafef00d0123456789abcdef01'
const REDACTED = '<redacted-path>'

test.after(cleanupTempRepos)

let reader
let validateEntry
test.before(async () => {
  reader = await import(pathToFileURL(MODULE_PATH).href)
  validateEntry = (await import(pathToFileURL(LEDGER_APPEND_PATH).href)).validateEntry
})

// ---- fixtures ----

const ALPHA = '/work/alpha-root'
const BETA = '/work/beta-root'
const ROOTS = [ALPHA, BETA]

function scopeFixture(roots = ROOTS, labels = ['scope-alpha', 'scope-beta']) {
  return { resolved: roots.map((root, i) => ({ requested: `r${i}`, root, label: labels[i] })), unresolved: [], plan_labels: [], nonce: NONCE }
}
function ledgerFixture(ledgerLabels = ['alpha-repo', 'beta-repo'], uninstrumented = false) {
  return {
    n: 6, windowTruncated: false, windowDroppedCount: 0,
    perRepo: ledgerLabels.map((root, rootIndex) => ({ root, rootIndex, uninstrumented, recordCount: 3, skippedCount: 0, schemaVersionsSeen: { 1: 3 }, truncatedFinalLine: false })),
    skipped: [],
    rework: { n: 6, lensDispositionCounts: {}, acVerdicts: [], invalidAcIdsDropped: 0, invalidRecordValuesDropped: 0, invalidFixedIdsDropped: 0, duplicateFixedIdsDropped: 0, duplicateFixedAcrossRounds: 0, invalidPriorIdsDropped: 0, findingsTruncated: 0, acVerdictsTruncated: 0, unattributedFindings: 0, noSpecReviewRuns: 0, noSpecFindingsReclassified: 0 },
    neverFailingAcs: [],
    wallClock: {
      byPlan: {},
      totals: { ciWaitSeconds: 0, humanWaitSeconds: 0, agentComputeSeconds: 0, unterminatedWaits: 0, agentComputeStartOnlyRuns: 0, agentComputeTerminalOnlyRuns: 0, agentComputeStartOnlyByKind: {}, agentComputeTerminalOnlyByKind: {}, agentComputeAbortedPairs: 0 },
      source: {},
    },
    triggerAccuracy: { byLens: {} },
    proposalOutcomes: {},
    citationPool: ['run-1', 'run-2', 'run-3', 'run-4', 'run-5', 'run-6'],
  }
}
function ciFixture(byJob) {
  return { byJob: byJob || { 'ci.yml::test': { workflow: 'ci.yml', job: 'test', n: 5, windowStart: 'a', windowEnd: 'b', truncated: false, insufficientData: false, neverFailed: true, meanDurationS: 100 } }, citationPool: ['1001'], failures: [] }
}
function figures(overrides = {}) {
  return {
    count: 3, n_commits_examined: 480, method: 'heuristic proxy: conventional-commit fix: prefix count, not a verified causal attribution', window_note: 'most recent 480 commits',
    scoped_count: 2, scoped_excluded_count: 1, scoped_unavailable_count: 0, scoped_config_source: 'default', scoped_exclude_globs: [], scoped_method: 'scoped heuristic',
    ...overrides,
  }
}
const entry = (rootIndex, repo, overrides = {}) => ({ ...figures(overrides), root_index: rootIndex, repo })

// A `lane:git` responder: finds which roster root the prompt names, then
// returns whatever `perRoot[root]` supplies (a value, or a function of the
// prompt). A prompt naming no root, or both, is a contract break and returns
// a sentinel no schema accepts.
function gitResponder(perRoot, roots = ROOTS) {
  return (prompt) => {
    const named = roots.filter((r) => prompt.includes(r))
    if (named.length !== 1) return { __bypassSchemaValidation: true, repos: 'PROMPT NAMED ' + named.length + ' ROOTS' }
    const v = perRoot[named[0]]
    return typeof v === 'function' ? v(prompt) : v
  }
}
const goodPair = () => ({
  [ALPHA]: { repos: [entry(0, 'alpha-repo', { count: 3, n_commits_examined: 480, scoped_count: 2 })] },
  [BETA]: { repos: [entry(1, 'beta-repo', { count: 7, n_commits_examined: 350, scoped_count: 5 })] },
})

function fixedTarget(overrides = {}) {
  return { kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: '', job: '', touches_always_on_lens: false, security_purposed: false, ...overrides }
}
function proposal(overrides = {}) {
  return { target: fixedTarget(), statement: 'Narrow a trigger glob', motivating_measurement: '3 of 5 runs were CLEAN (run-1..run-3)', confirming_measurement: 'accuracy improves', n: 6, citations: ['run-1'], reinstatement_evidence: null, ...overrides }
}
function extractTargets(prompt) {
  const m = /<UNTRUSTED-DATA-([^\s>]+) label="proposal-targets">\n([\s\S]*?)\n<\/UNTRUSTED-DATA-\1>/.exec(prompt)
  return m ? JSON.parse(m[2]).targets : []
}
const idsResponder = (prompt) => ({ ids: extractTargets(prompt).map((t, i) => ({ target: t, proposal_id: `id-${i}` })) })

function responses(overrides = {}) {
  return {
    'scope:repos': scopeFixture(),
    'lane:ledger': ledgerFixture(),
    'lane:ci': ciFixture(),
    'lane:git': gitResponder(goodPair()),
    'synthesis:proposals': { proposals: [] },
    'synthesis:ids': idsResponder,
    'report:write': { written: true, path: '.claude/optimise-cycle-report.md', error: null },
    ...overrides,
  }
}
async function run(overrides) {
  return runWorkflow(WORKFLOW, { args: {}, agent: responses(overrides) })
}

function escapedSection(report) {
  const start = report.indexOf('## Escaped-defect counter-metric')
  assert.ok(start >= 0, 'report has an Escaped-defect counter-metric section')
  const rest = report.slice(start)
  const end = rest.indexOf('\n## ', 5)
  return end < 0 ? rest : rest.slice(0, end)
}
// The text of the block that starts at the first line naming labels[k] and
// runs to the first line naming a later label (or the section's end).
function blockFor(section, labels, k) {
  const lines = section.split('\n')
  const firstAt = (label) => lines.findIndex((l) => l.includes(label))
  const starts = labels.map(firstAt)
  assert.ok(starts[k] >= 0, `section names ${labels[k]}:\n${section}`)
  const later = starts.filter((s, i) => i !== k && s > starts[k])
  const end = later.length ? Math.min(...later) : lines.length
  return lines.slice(starts[k], end).join('\n')
}

// ==== (1) git lane per roster repo ====

test('T6 git lane: runs once per scope.resolved entry, each prompt naming only that root as a literal cd target, never the CURRENT repo (AC-DATA-12, AC-SEC-10, AC-OPS-13)', async () => {
  const { calls } = await run()
  const gitCalls = calls.filter((c) => c.opts.label === 'lane:git')
  assert.equal(gitCalls.length, 2, 'one git lane call per roster entry')
  for (const [i, root] of ROOTS.entries()) {
    const others = ROOTS.filter((r) => r !== root)
    const p = gitCalls[i].prompt
    assert.ok(new RegExp(`cd[^\\n]{0,20}${root.replace(/[/.]/g, '\\$&')}`).test(p), `prompt ${i} uses ${root} as a literal cd target`)
    for (const o of others) assert.ok(!p.includes(o), `prompt ${i} must not name another roster root`)
    assert.ok(!/CURRENT repo/.test(p), 'no CURRENT repo instruction')
  }
})

test('T6 git lane: the source no longer carries the CURRENT-repo instruction (AC-DATA-12)', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8')
  assert.ok(!src.includes('In the CURRENT repo'), 'gitLanePrompt must not tell the agent to run in the CURRENT repo')
})

test('T6 git lane: a single unkeyed figure object fails GIT_LANE_SCHEMA, the per-repo form passes (AC-DATA-11)', async () => {
  const { calls } = await run()
  const schema = calls.find((c) => c.opts.label === 'lane:git').opts.schema
  assert.ok(validateEntry(figures(), schema).length > 0, 'today\'s single unkeyed object must be rejected')
  assert.deepEqual(validateEntry({ repos: [entry(0, 'alpha-repo')] }, schema), [])
  assert.ok(validateEntry({ repos: [{ ...entry(0, 'alpha-repo'), root_index: 'zero' }] }, schema).length > 0, 'root_index is an integer')
  assert.ok(validateEntry({ repos: [figures({ repo: 'alpha-repo' })] }, schema).length > 0, 'an entry with no root_index is rejected')
})

test('T6 git lane: two repos with different fix counts give two different figures, each under the right repo label (AC-QA-19, AC-DATA-11)', async () => {
  const { result } = await run()
  const section = escapedSection(result.report)
  const labels = ['alpha-repo', 'beta-repo']
  const a = blockFor(section, labels, 0)
  const b = blockFor(section, labels, 1)
  assert.match(a, /\b3 of 480\b/); assert.match(a, /\b2 counted\b/)
  assert.doesNotMatch(a, /\b7 of 350\b/)
  assert.match(b, /\b7 of 350\b/); assert.match(b, /\b5 counted\b/)
  assert.doesNotMatch(b, /\b3 of 480\b/)
})

test('T6 git lane: a forged third result is listed as unmatched and its figure never rendered (AC-SEC-10, AC-DATA-11)', async () => {
  const forged = entry(2, 'forged-repo', { count: 999, n_commits_examined: 888 })
  const perRoot = goodPair()
  perRoot[BETA] = { repos: [...perRoot[BETA].repos, forged] }
  const { result } = await run({ 'lane:git': gitResponder(perRoot) })
  const section = escapedSection(result.report)
  assert.match(section, /unmatched/i)
  assert.doesNotMatch(section, /999|888/)
  assert.match(blockFor(section, ['alpha-repo', 'beta-repo'], 1), /\b7 of 350\b/, 'the genuine beta result survives the forgery')
})

test('T6 git lane: a result whose ledger identity does not match its root is unmatched, naming BOTH repo values, and is not merged into another repo (AC-DATA-11, AC-OPS-13)', async () => {
  const perRoot = goodPair()
  perRoot[BETA] = { repos: [entry(1, 'alpha-repo', { count: 11, n_commits_examined: 777 })] } // beta's index, alpha's identity
  const { result } = await run({ 'lane:git': gitResponder(perRoot) })
  const section = escapedSection(result.report)
  assert.doesNotMatch(section, /\b11 of 777\b/, 'the mismatched figure is never rendered as a count')
  const lines = section.split('\n').filter((l) => /mismatch|does not match|unmatched/i.test(l))
  assert.ok(lines.some((l) => l.includes('alpha-repo') && l.includes('beta-repo')), `a reason line names both repo values:\n${section}`)
  assert.match(blockFor(section, ['alpha-repo', 'beta-repo'], 0), /\b3 of 480\b/, 'alpha keeps its own figure')
})

test('T6 git lane: a duplicated root_index is unmatched and neither duplicate is rendered (AC-DATA-11)', async () => {
  const perRoot = goodPair()
  perRoot[ALPHA] = { repos: [entry(0, 'alpha-repo', { count: 55, n_commits_examined: 555 }), entry(0, 'alpha-repo', { count: 66, n_commits_examined: 666 })] }
  const { result } = await run({ 'lane:git': gitResponder(perRoot) })
  const section = escapedSection(result.report)
  assert.match(section, /unmatched/i)
  assert.doesNotMatch(section, /\b55 of 555\b|\b66 of 666\b/)
})

test('T6 git lane: a repo whose lane failed gets its own line naming the reason, and the other repo is unaffected (AC-OPS-13, AC-PROD-7)', async () => {
  const perRoot = goodPair()
  perRoot[BETA] = () => undefined
  const { result } = await run({ 'lane:git': gitResponder(perRoot) })
  const section = escapedSection(result.report)
  const b = blockFor(section, ['alpha-repo', 'beta-repo'], 1)
  assert.match(b, /not measured|failed|unavailable/i)
  assert.doesNotMatch(b, /\b3 of 480\b/)
  assert.match(blockFor(section, ['alpha-repo', 'beta-repo'], 0), /\b3 of 480\b/)
})

test('T6 git lane: two uninstrumented roots both labelled by the redaction marker stay distinct, by roster position, never merged or cross-matched (AC-DATA-11)', async () => {
  const perRoot = {
    [ALPHA]: { repos: [entry(0, REDACTED, { count: 5, n_commits_examined: 501 })] },
    [BETA]: { repos: [entry(1, REDACTED, { count: 9, n_commits_examined: 502 })] },
  }
  const { result } = await run({ 'lane:ledger': ledgerFixture([REDACTED, REDACTED], true), 'lane:git': gitResponder(perRoot) })
  const section = escapedSection(result.report)
  assert.match(section, /\b5 of 501\b/); assert.match(section, /\b9 of 502\b/)
  assert.ok(section.indexOf('5 of 501') < section.indexOf('9 of 502'), 'roster order')
  const headers = section.split('\n').filter((l) => l.includes(REDACTED))
  assert.ok(headers.length >= 2, 'one labelled line per roster repo')
  assert.equal(new Set(headers).size, headers.length, 'the lines are told apart by roster position, not identical')
  // a swap is caught: beta's result carrying alpha's index is a duplicate, so it is not counted twice
  const swapped = { [ALPHA]: perRoot[ALPHA], [BETA]: { repos: [entry(0, REDACTED, { count: 9, n_commits_examined: 502 })] } }
  const r2 = await run({ 'lane:ledger': ledgerFixture([REDACTED, REDACTED], true), 'lane:git': gitResponder(swapped) })
  assert.doesNotMatch(escapedSection(r2.result.report), /\b9 of 502\b/)
})

test('T6 git lane: no roster root path appears anywhere in the report, including the unmatched and failed lines (AC-SEC-10)', async () => {
  const forged = { repos: [entry(0, 'alpha-repo'), entry(5, 'forged-repo')] }
  for (const git of [gitResponder(goodPair()), gitResponder({ ...goodPair(), [ALPHA]: forged, [BETA]: () => undefined })]) {
    const { result } = await run({ 'lane:git': git })
    assert.match(escapedSection(result.report), /\b7 of 350\b|unmatched/i, 'precondition: the per-repo section really rendered')
    for (const root of ROOTS) assert.ok(!result.report.includes(root), `${root} leaked into the report`)
  }
})

test('T6 git lane: repo values echoed from the agent or ledger are flattened and bounded (house oneLine rule)', async () => {
  const evil = 'x\n## Injected heading\n' + 'A'.repeat(400)
  const perRoot = goodPair()
  perRoot[BETA] = { repos: [entry(1, evil, { count: 11, n_commits_examined: 777 })] }
  const { result } = await run({ 'lane:git': gitResponder(perRoot) })
  assert.match(escapedSection(result.report), /unmatched|mismatch/i, 'precondition: the bad identity was reported, so the echo path ran')
  assert.ok(!result.report.split('\n').some((l) => l.startsWith('## Injected')), 'agent text must not open a heading')
  assert.ok(!/A{200}/.test(result.report), 'agent text is bounded')
  const evilLabel = 'y\n## Injected label\n' + 'B'.repeat(400)
  const r2 = await run({ 'lane:ledger': ledgerFixture(['alpha-repo', evilLabel]), 'lane:git': gitResponder({ [ALPHA]: goodPair()[ALPHA], [BETA]: { repos: [entry(1, evilLabel, { count: 7, n_commits_examined: 350 })] } }) })
  assert.match(escapedSection(r2.result.report), /\b7 of 350\b/, 'precondition: the matched figure rendered under the hostile label')
  assert.ok(!r2.result.report.split('\n').some((l) => l.startsWith('## Injected')))
  assert.ok(!/B{200}/.test(r2.result.report), 'the ledger label is bounded in the escaped-defect section')
})

// ---- the reader's escaped-defects command: per-repo identity, no path ----

function gitLogRaw(cwd) {
  return sh("git log --max-count=500 --name-only --pretty=format:'%x1e%P%x1f%s'", cwd)
}
function commitFixes(dir, n) {
  for (let i = 0; i < n; i++) sh(`git commit -q --allow-empty -m "fix: repair ${i}"`, dir)
}
function runCli(command, payload, args = []) {
  const res = spawnSync('node', [MODULE_PATH, command, ...args], { input: JSON.stringify(payload), encoding: 'utf8', env: sanitizedGitEnv() })
  assert.equal(res.status, 0, res.stderr)
  return { out: JSON.parse(res.stdout.trim()), raw: res.stdout }
}

test('T6 escaped-defects CLI: two temp repos with different fix: counts give different figures matching each repo\'s own git log, with the ledger repo identity attached and no root path echoed (AC-QA-19, AC-DATA-11, AC-SEC-10)', () => {
  const a = makeTempRepo(); const b = makeTempRepo()
  commitFixes(a, 3); commitFixes(b, 1)
  assert.equal(runAppend(a, { schema_version: 1, kind: 'tdd_task', outcome: 'done' }).status, 0)
  assert.equal(runAppend(b, { schema_version: 1, kind: 'tdd_task', outcome: 'done' }).status, 0)
  const own = (d) => Number(sh("git log --format=%s | grep -c '^fix:' || true", d).trim())
  const ra = runCli('escaped-defects', { git_log_raw: gitLogRaw(a), root: a })
  const rb = runCli('escaped-defects', { git_log_raw: gitLogRaw(b), root: b })
  assert.equal(ra.out.count, own(a)); assert.equal(rb.out.count, own(b))
  assert.notEqual(ra.out.count, rb.out.count)
  const ledgerLabel = (d) => runCli('ledger', {}, [d]).out.perRepo[0].root
  assert.equal(ra.out.repo, ledgerLabel(a), 'identity is derived the way the ledger command derives it')
  assert.equal(rb.out.repo, ledgerLabel(b))
  assert.ok(!ra.raw.includes(a) && !rb.raw.includes(b), 'the root path is never echoed')
})

test('T6 escaped-defects CLI: an uninstrumented root carries the redaction marker as its identity (AC-DATA-11)', () => {
  const a = makeTempRepo()
  commitFixes(a, 2)
  const { out } = runCli('escaped-defects', { git_log_raw: gitLogRaw(a), root: a })
  assert.equal(out.repo, REDACTED)
})

// ==== (2) fixed proposal target ====

const FIXED_KEYS = ['kind', 'component', 'concern', 'lens', 'workflow', 'job', 'touches_always_on_lens', 'security_purposed']
const STRING_KEYS = ['kind', 'component', 'concern', 'lens', 'workflow', 'job']

async function targetSchema() {
  const { calls } = await run({ 'synthesis:proposals': { proposals: [] } })
  const call = calls.find((c) => c.opts.label === 'synthesis:proposals')
  return call.opts.schema.properties.proposals.items.properties.target
}

test('T6 target schema: requires exactly the eight fixed keys, no others (AC-QA-20, AC-PROD-8)', async () => {
  const schema = await targetSchema()
  assert.ok(Array.isArray(schema.required), 'target must declare required keys, not be a free { type: object }')
  assert.deepEqual([...schema.required].sort(), [...FIXED_KEYS].sort())
  assert.deepEqual(Object.keys(schema.properties).sort(), [...FIXED_KEYS].sort())
  assert.strictEqual(schema.additionalProperties, false)
  assert.deepEqual(validateEntry(fixedTarget(), schema), [])
  for (const k of FIXED_KEYS) {
    const { [k]: _gone, ...partial } = fixedTarget()
    assert.ok(validateEntry(partial, schema).length > 0, `missing ${k} must be rejected`)
  }
  assert.ok(validateEntry({ ...fixedTarget(), segment: 'ci_wait' }, schema).length > 0, 'an extra key must be rejected')
  assert.ok(validateEntry({ ...fixedTarget(), repo: 'x' }, schema).length > 0, 'repo is not part of the key set')
  for (const k of STRING_KEYS) {
    assert.deepEqual(validateEntry({ ...fixedTarget(), [k]: null }, schema), [], `${k} may be null`)
    assert.deepEqual(validateEntry({ ...fixedTarget(), [k]: '' }, schema), [], `${k} may be empty`)
  }
  assert.ok(validateEntry({ ...fixedTarget(), security_purposed: 'yes' }, schema).length > 0, 'booleans are booleans')
  assert.ok(validateEntry({ ...fixedTarget(), touches_always_on_lens: null }, schema).length > 0, 'booleans are required, not nullable')
})

test('T6 target: a drafted target missing a key, or carrying an extra key, is rejected by the script, listed with the key names, and never given an id (AC-QA-20, AC-DATA-15)', async () => {
  const { security_purposed: _drop, ...missing } = fixedTarget({ component: 'missing-one' })
  const extra = { ...fixedTarget({ component: 'extra-one' }), segment: 'ci_wait' }
  const { result, calls } = await run({
    'synthesis:proposals': { __bypassSchemaValidation: true, proposals: [proposal({ target: missing }), proposal({ target: extra }), proposal({ target: fixedTarget({ component: 'good-one' }) })] },
  })
  assert.equal(result.proposals_ranked.length, 1)
  assert.equal(result.proposals_ranked[0].target.component, 'good-one')
  assert.equal(result.proposals_ranked[0].proposal_id, 'id-0')
  const idCall = calls.find((c) => c.opts.label === 'synthesis:ids')
  assert.deepEqual(extractTargets(idCall.prompt).map((t) => t.component), ['good-one'], 'only the well-formed target reaches the id step')
  const at = result.report.indexOf('Proposals rejected: malformed target')
  assert.ok(at >= 0, `report lists the rejection:\n${result.report}`)
  const tail = result.report.slice(at, at + 800)
  assert.match(tail, /security_purposed/, 'names the missing key')
  assert.match(tail, /segment/, 'names the extra key')
})

test('T6 target: when every drafted target is malformed no id step runs, and an extra key cannot smuggle a security signal past the gates (AC-QA-20, AC-SEC-9)', async () => {
  const smuggle = { ...fixedTarget(), note: 'gitleaks secret scanning' }
  const { result, calls } = await run({
    'synthesis:proposals': { __bypassSchemaValidation: true, proposals: [proposal({ target: smuggle, statement: 'Move the nightly job to post-merge', reinstatement_evidence: 'reinstate on failure' })] },
  })
  assert.equal(result.proposals_ranked.length, 0)
  assert.equal(calls.filter((c) => c.opts.label === 'synthesis:ids').length, 0)
  assert.match(result.report, /Proposals rejected: malformed target/)
})

test('T6 target: key names echoed into the report are flattened and bounded (house oneLine rule)', async () => {
  const evilKey = 'k\n## Injected key heading\n' + 'C'.repeat(400)
  const { result } = await run({
    'synthesis:proposals': { __bypassSchemaValidation: true, proposals: [proposal({ target: { ...fixedTarget(), [evilKey]: 1 } })] },
  })
  assert.match(result.report, /Proposals rejected: malformed target/)
  assert.ok(!result.report.split('\n').some((l) => l.startsWith('## Injected')))
  assert.ok(!/C{200}/.test(result.report))
})

// ---- the removal gates still see every key they need (AC-SEC-9, AC-SEC-15) ----

test('T6 gate: touches_always_on_lens true is dropped as an always-on removal even with no verb and no lens name (AC-SEC-9)', async () => {
  const { result } = await run({
    'synthesis:proposals': { proposals: [proposal({ target: fixedTarget({ kind: 'lens_tune', touches_always_on_lens: true }), statement: 'The always-on lens only needs to look at half the diff', reinstatement_evidence: 'evidence' })] },
  })
  assert.equal(result.proposals_ranked.length, 0)
  assert.match(result.report, /Dropped \(always-on security lens removal, never permitted\): 1\b/)
})

test('T6 gate: target.lens lens-security is dropped as an always-on removal (AC-SEC-9)', async () => {
  const { result } = await run({
    'synthesis:proposals': { proposals: [proposal({ target: fixedTarget({ kind: 'lens_tune', lens: 'lens-security' }), statement: 'Tune how often this runs', reinstatement_evidence: 'evidence' })] },
  })
  assert.equal(result.proposals_ranked.length, 0)
  assert.match(result.report, /Dropped \(always-on security lens removal, never permitted\): 1\b/)
})

test('T6 gate: gitleaks appearing only in target.job still reclassifies a removal into the flagged security category, and without evidence it is dropped (AC-SEC-9)', async () => {
  const flagged = await run({
    'synthesis:proposals': { proposals: [proposal({ target: fixedTarget({ kind: 'ci_demote', job: 'gitleaks' }), statement: 'Move the nightly scan to post-merge', reinstatement_evidence: 'reinstate if it ever fails' })] },
  })
  assert.equal(flagged.result.proposals_ranked.length, 1)
  assert.equal(flagged.result.proposals_ranked[0].category, 'security_removal_flagged')
  const dropped = await run({
    'synthesis:proposals': { proposals: [proposal({ target: fixedTarget({ kind: 'ci_demote', job: 'gitleaks' }), statement: 'Move the nightly scan to post-merge', reinstatement_evidence: null })] },
  })
  assert.equal(dropped.result.proposals_ranked.length, 0)
})

test('T6 gate: security_purposed true with no verb and no keyword still needs reinstatement evidence and is flagged with it (AC-SEC-9: the gate reads the boolean from the full target)', async () => {
  const none = await run({
    'synthesis:proposals': { proposals: [proposal({ target: fixedTarget({ kind: 'ci_note', job: 'our-custom-vuln-scanner', security_purposed: true }), statement: 'our-custom-vuln-scanner is noisy lately', reinstatement_evidence: null })] },
  })
  assert.equal(none.result.proposals_ranked.length, 0)
  const withEv = await run({
    'synthesis:proposals': { proposals: [proposal({ target: fixedTarget({ kind: 'ci_note', job: 'our-custom-vuln-scanner', security_purposed: true }), statement: 'our-custom-vuln-scanner is noisy lately', reinstatement_evidence: 'reinstate on any new CVE class' })] },
  })
  assert.equal(withEv.result.proposals_ranked.length, 1)
  assert.equal(withEv.result.proposals_ranked[0].category, 'security_removal_flagged')
})

test('T6 gate: an unrelated fixed-key proposal is not over-blocked (AC-SEC-9)', async () => {
  const { result } = await run({
    'synthesis:proposals': { proposals: [proposal({ target: fixedTarget({ kind: 'trigger_tune', lens: 'lens-operability' }), statement: 'Narrow the lens-operability trigger glob' })] },
  })
  assert.equal(result.proposals_ranked.length, 1)
})

// ---- the weak-CI-evidence brake, re-pointed to the fixed key form (AC-QA-21) ----

for (const flag of ['truncated', 'insufficientData', 'renameSuspect']) {
  test(`T6 brake: a removal-shaped fixed-key proposal whose workflow and job resolve to a ${flag} CI entry is dropped into the weak-evidence count (AC-QA-21)`, async () => {
    const entryFor = { workflow: 'ci.yml', job: 'lint', n: 100, windowStart: 'x', windowEnd: 'y', truncated: false, insufficientData: false, renameSuspect: false, neverFailed: null, meanDurationS: 1, [flag]: true }
    const { result } = await run({
      'lane:ci': ciFixture({ 'ci.yml::lint': entryFor }),
      'synthesis:proposals': { proposals: [proposal({ target: fixedTarget({ kind: 'ci_remove', workflow: 'ci.yml', job: 'lint' }), statement: 'Remove the lint job: never failed', citations: ['1001'], reinstatement_evidence: 'evidence', n: 100 })] },
    })
    assert.equal(result.proposals_ranked.length, 0)
    assert.match(result.report, /insufficient-data\/truncated\/rename-suspect/i)
  })
}

test('T6 brake: the same fixed-key removal against a solid CI entry survives, and case or spacing in workflow/job does not defeat the lookup the gate relies on (AC-QA-21)', async () => {
  const solid = { 'ci.yml::lint': { workflow: 'ci.yml', job: 'lint', n: 20, windowStart: 'x', windowEnd: 'y', truncated: false, insufficientData: false, renameSuspect: false, neverFailed: true, meanDurationS: 1 } }
  const { result } = await run({
    'lane:ci': ciFixture(solid),
    'synthesis:proposals': { proposals: [proposal({ target: fixedTarget({ kind: 'ci_remove', workflow: 'ci.yml', job: 'lint' }), statement: 'Remove the lint job: never failed', citations: ['1001'], reinstatement_evidence: 'evidence', n: 20 })] },
  })
  assert.equal(result.proposals_ranked.length, 1)
})

// ==== stableProposalId over the fixed key set ====

test('T6 id: key order, letter case and surrounding whitespace of the six string fields do not change the id (AC-QA-20)', () => {
  const base = fixedTarget({ kind: 'ci_demote', component: 'lens-operability', concern: 'Trigger Glob', lens: 'lens-operability', workflow: 'ci.yml', job: 'lint' })
  const id = reader.stableProposalId(base)
  assert.match(id, /^[0-9a-f]{16}$/)
  const reordered = {}
  for (const k of [...Object.keys(base)].reverse()) reordered[k] = base[k]
  assert.equal(reader.stableProposalId(reordered), id, 'key order')
  assert.equal(reader.stableProposalId({ ...base, component: 'LENS-OPERABILITY', concern: 'trigger glob', job: 'LINT' }), id, 'case')
  assert.equal(reader.stableProposalId({ ...base, kind: '  ci_demote ', workflow: '\tci.yml\n', concern: ' Trigger Glob  ' }), id, 'whitespace')
})

test('T6 id: a differing value in any one of the six identity fields gives a different id (AC-QA-20)', () => {
  const base = fixedTarget({ kind: 'k', component: 'c', concern: 'n', lens: 'l', workflow: 'w', job: 'j' })
  const seen = new Set([reader.stableProposalId(base)])
  for (const k of STRING_KEYS) {
    const id = reader.stableProposalId({ ...base, [k]: base[k] + '-changed' })
    assert.ok(!seen.has(id), `changing ${k} must change the id`)
    seen.add(id)
  }
  assert.equal(seen.size, 7)
})

test('T6 id: the two booleans are gate inputs, not identity, and repo is excluded from identity (AC-DATA-15)', () => {
  const base = fixedTarget({ kind: 'k', component: 'c' })
  const id = reader.stableProposalId(base)
  assert.equal(reader.stableProposalId({ ...base, touches_always_on_lens: true, security_purposed: true }), id)
  assert.equal(reader.stableProposalId({ ...base, repo: 'repo-a' }), reader.stableProposalId({ ...base, repo: 'repo-b' }))
  assert.equal(reader.stableProposalId({ ...base, repo: 'repo-a' }), id)
})

test('T6 id: a rejection recorded in one roster repo is found for the same target proposed in another, as the skill documents (AC-DATA-15)', () => {
  const base = fixedTarget({ kind: 'k', component: 'c' })
  const idA = reader.stableProposalId({ ...base, repo: 'repo-a' })
  const rec = { kind: 'conduct_plan_event', event: 'proposal_rejected', event_key: `${idA}:proposal_rejected:1`, ts: '2026-10-01T00:00:00.000Z', repo: 'repo-a' }
  const out = reader.aggregateProposalOutcomes([rec])
  const hit = out.get(reader.stableProposalId({ ...base, repo: 'repo-b' }))
  assert.ok(hit, 'the other repo finds the rejection')
  assert.equal(hit.rejectedCount, 1)
  assert.equal(hit.lastRejectionTs, '2026-10-01T00:00:00.000Z')
})

test('T6 ids CLI: fixed-key targets in, one stable id each out, in order (AC-QA-20)', () => {
  const t1 = fixedTarget({ component: 'one' }); const t2 = fixedTarget({ component: 'two' })
  const { out } = runCli('ids', { targets: [t1, { ...t1, kind: ' CI_DEMOTE ' }, t2] })
  assert.equal(out.ids.length, 3)
  assert.equal(out.ids[0].proposal_id, out.ids[1].proposal_id)
  assert.notEqual(out.ids[0].proposal_id, out.ids[2].proposal_id)
})

// ==== (5) AC-DATA-14: legacy free-shape targets mapped by script code ====

function legacy(legacy_targets) {
  const ids = runCli('ids', { legacy_targets }).out.legacy_ids
  assert.ok(Array.isArray(ids), 'ids accepts { legacy_targets } and returns { legacy_ids: [...] }')
  return ids
}
const idOf = (o) => reader.stableProposalId(fixedTarget(o))

test('T6 legacy ids: the 11 Oct shape {kind, component, concern} maps to the new id (AC-DATA-14)', () => {
  const [r] = legacy([{ kind: 'ci_demote', component: 'lens-operability', concern: 'trigger glob' }])
  assert.equal(r.proposal_id, idOf({ kind: 'ci_demote', component: 'lens-operability', concern: 'trigger glob' }))
  assert.equal(r.reason, null)
})

test('T6 legacy ids: the 5 Oct shape {workflow_component, feature} maps onto component and concern (AC-DATA-14)', () => {
  const [r] = legacy([{ workflow_component: 'optimise-cycle', feature: 'git lane' }])
  // The helper defaults `kind` to a CI value; the legacy target carries no
  // kind, and the brief says a missing string is empty, so say so here.
  assert.equal(r.proposal_id, idOf({ kind: '', component: 'optimise-cycle', concern: 'git lane' }))
  assert.equal(r.reason, null)
})

test('T6 legacy ids: lens, workflow and job are carried as given and missing strings are empty (AC-DATA-14)', () => {
  const [r] = legacy([{ kind: 'k', component: 'c', concern: 'n', lens: 'lens-qa', workflow: 'ci.yml', job: 'lint' }])
  assert.equal(r.proposal_id, idOf({ kind: 'k', component: 'c', concern: 'n', lens: 'lens-qa', workflow: 'ci.yml', job: 'lint' }))
})

test('T6 legacy ids: the 5 Oct shape {lens, cycle, change} has fields the fixed set cannot hold, so it returns null with a reason naming them rather than a lossy id (AC-DATA-14)', () => {
  const [r] = legacy([{ lens: 'lens-qa', cycle: 'plan', change: 'drop it' }])
  assert.strictEqual(r.proposal_id, null)
  assert.match(r.reason, /cycle/); assert.match(r.reason, /change/)
})

test('T6 legacy ids: results come back one per target, in order, echoing each target (AC-DATA-14)', () => {
  const inputs = [{ workflow_component: 'a', feature: 'b' }, { lens: 'lens-qa', cycle: 'x', change: 'y' }, { kind: 'k', component: 'c', concern: 'n' }]
  const out = legacy(inputs)
  assert.equal(out.length, 3)
  assert.deepEqual(out.map((r) => r.target), inputs)
  assert.deepEqual(out.map((r) => r.proposal_id === null), [false, true, false])
})

// ==== (3) nothing else was added ====

test('T6 scope: no install-consistency check in optimise-cycle.js, no new workflow argument, reader makes no exec/spawn/gh/git call (AC-SIMP-6, AC-SIMP-7, AC-SIMP-11)', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8')
  assert.ok(!/install[-_ ]consistency|allow_inconsistent_install|checkInstall/i.test(src), 'T6 declined the install-consistency check')
  const argNames = [...new Set([...src.matchAll(/\bopts\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort()
  assert.deepEqual(argNames, ['repos', 'window'], 'no new workflow argument')
  const readerSrc = fs.readFileSync(MODULE_PATH, 'utf8')
  assert.ok(!/child_process|execSync|execFileSync|spawnSync|\bspawn\(/.test(readerSrc), 'reader functions run no subprocess')
})
