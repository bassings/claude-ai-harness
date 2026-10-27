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

test('T6 git lane: runs once per scope.resolved entry, each prompt naming only that root as a double-quoted git -C target, never the CURRENT repo (AC-DATA-12, AC-SEC-10, AC-OPS-13)', async () => {
  const { calls } = await run()
  const gitCalls = calls.filter((c) => c.opts.label === 'lane:git')
  assert.equal(gitCalls.length, 2, 'one git lane call per roster entry')
  for (const [i, root] of ROOTS.entries()) {
    const others = ROOTS.filter((r) => r !== root)
    const p = gitCalls[i].prompt
    // Full regex escape (CodeQL js/incomplete-sanitization on the first draft,
    // which escaped only dots and slashes): a root is a filesystem path and
    // may carry any metacharacter, backslash included.
    const literal = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Round 1 F5: ONE command with the root double-quoted, not a cd step whose
    // directory change a later step could silently lose.
    assert.ok(new RegExp(`git -C "${literal}" log`).test(p), `prompt ${i} runs git -C "${root}" log as one command`)
    assert.ok(!/\bcd\s/.test(p), `prompt ${i} must not use a separate cd step`)
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
  const ra = runCli('escaped-defects', { git_log_raw: gitLogRaw(a), root: a, toplevel: a })
  const rb = runCli('escaped-defects', { git_log_raw: gitLogRaw(b), root: b, toplevel: b })
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
  const { out } = runCli('escaped-defects', { git_log_raw: gitLogRaw(a), root: a, toplevel: a })
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
  // Round 2 F6 (AC-QA-20): `at` is the index of the very string searched for, so
  // the slice always starts with it and the old precondition could not fail.
  // The real one: the LINE starts with the count of the two malformed targets
  // drafted here (one missing a key, one carrying an extra), and the good one
  // is not counted.
  assert.ok(result.report.split('\n').some((l) => l.startsWith('Proposals rejected: malformed target: 2 (')), 'the rejection line starts with the count of two')
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
    assert.match(result.report, /Dropped \(cited CI job has no settled never-failed verdict; see the CI section qualifiers\): 1\b/)  // T7 review F1/F4
  })
}

const removal = (job, extra = {}) => proposal({ target: fixedTarget({ kind: 'ci_remove', workflow: 'ci.yml', job, ...extra }), statement: 'Remove the lint job: never failed', citations: ['1001'], reinstatement_evidence: 'evidence', n: 20 })
const ciEntry = (job, overrides = {}) => ({ workflow: 'ci.yml', job, n: 20, windowStart: 'x', windowEnd: 'y', truncated: false, insufficientData: false, renameSuspect: false, neverFailed: true, meanDurationS: 1, ...overrides })

// HARN-OPT-5 T7 (AC-QA-22): the weak entries below now carry neverFailed null,
// as the reader writes them (a weakening flag nulls the verdict); the brake
// reads the verdict, so a flag beside neverFailed true is no longer the weak shape.
test('T6 brake: the CI lookup folds case and surrounding whitespace on the proposal side, so a weak entry still drops a removal that spells the job differently, and a solid entry still lets it through (AC-QA-21, round 1 F2)', async () => {
  const weak = await run({
    'lane:ci': ciFixture({ 'ci.yml::Lint': ciEntry('Lint', { insufficientData: true, neverFailed: null }) }),
    'synthesis:proposals': { proposals: [removal(' LINT ')] },
  })
  assert.equal(weak.result.proposals_ranked.length, 0, 'the fold must find the weak entry; an exact-key lookup waves the removal through')
  assert.match(weak.result.report, /Dropped \(cited CI job has no settled never-failed verdict; see the CI section qualifiers\): 1\b/)
  const workflowCase = await run({
    'lane:ci': ciFixture({ 'CI.yml::Lint': ciEntry('Lint', { workflow: 'CI.yml', truncated: true, neverFailed: null }) }),
    'synthesis:proposals': { proposals: [removal(' lint\t')] },
  })
  assert.equal(workflowCase.result.proposals_ranked.length, 0, 'the entry side is folded too, workflow included')
  const solid = await run({
    'lane:ci': ciFixture({ 'ci.yml::Lint': ciEntry('Lint') }),
    'synthesis:proposals': { proposals: [removal(' LINT ')] },
  })
  assert.equal(solid.result.proposals_ranked.length, 1, 'a solid entry found through the fold lets the removal survive')
})

test('T6 brake: a removal-shaped proposal whose workflow/job names no CI aggregate entry fails closed into the weak-evidence count (AC-QA-21, round 1 F2)', async () => {
  const { result } = await run({
    'lane:ci': ciFixture({ 'ci.yml::lint': ciEntry('lint') }),
    'synthesis:proposals': { proposals: [removal('no-such-job')] },
  })
  assert.equal(result.proposals_ranked.length, 0, 'no evidence is weak evidence for a removal')
  assert.match(result.report, /Dropped \(cited CI job has no settled never-failed verdict; see the CI section qualifiers\): 1\b/)
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

// ==== review round 1 fixes (PR #9): F1 to F6 ====

const outcome = (overrides = {}) => ({ adoptedCount: 0, rejectedCount: 0, revertedCount: 0, lastRejectionTs: null, lastAdoptionTs: null, revertedTwiceOrMore: false, ...overrides })
// An ids step that returns the REAL derived id for each target, so a ledger
// fixture keyed by stableProposalId(target) is found by the annotation.
const realIdsResponder = (prompt) => ({ ids: extractTargets(prompt).map((t) => ({ target: t, proposal_id: reader.stableProposalId(t) })) })
function rankedSection(report) {
  const start = report.indexOf('## Proposals (ranked)')
  assert.ok(start >= 0, 'report has the ranked proposals section')
  const rest = report.slice(start)
  const end = rest.indexOf('\n## ', 5)
  return end < 0 ? rest : rest.slice(0, end)
}
function extractBlock(prompt, label) {
  const m = new RegExp(`<UNTRUSTED-DATA-([^\\s>]+) label="${label}">\\n([\\s\\S]*?)\\n</UNTRUSTED-DATA-\\1>`).exec(prompt)
  return m ? m[2] : null
}

// ---- F1 (AC-PROD-8 clause 2, AC-DATA-14): adoption is read, not just recorded ----

test('T6 round 1 F1: aggregateProposalOutcomes exports lastAdoptionTs, the last adoption in append order, null when none (AC-PROD-8)', () => {
  const ev = (event, n, ts) => ({ kind: 'conduct_plan_event', event, event_key: `pid1:${event}:${n}`, ts })
  const out = reader.aggregateProposalOutcomes([
    ev('proposal_adopted', 1, '2026-09-01T00:00:00.000Z'),
    ev('proposal_adopted', 2, '2026-08-01T00:00:00.000Z'), // appended later, so it is the last by ledger order
    { ...ev('proposal_rejected', 1, '2026-10-01T00:00:00.000Z'), event_key: 'pid2:proposal_rejected:1' },
  ])
  assert.equal(out.get('pid1').lastAdoptionTs, '2026-08-01T00:00:00.000Z')
  assert.equal(out.get('pid2').lastAdoptionTs, null, 'a rejection-only proposal has no adoption date')
})

test('T6 round 1 F1: a re-proposed target whose id already has a proposal_adopted event is reported "Already adopted on <ts>" under its own heading and is not ranked as new (AC-PROD-8, AC-DATA-14)', async () => {
  const adopted = fixedTarget({ kind: 'trigger_tune', component: 'lens-operability', concern: 'trigger glob', lens: 'lens-operability' })
  const fresh = fixedTarget({ kind: 'ci_note', component: 'fresh-thing', concern: 'noise' })
  const id = reader.stableProposalId(adopted)
  const { result } = await run({
    'lane:ledger': { ...ledgerFixture(), proposalOutcomes: { [id]: outcome({ adoptedCount: 1, lastAdoptionTs: '2026-09-01T00:00:00.000Z' }) } },
    'synthesis:proposals': { proposals: [proposal({ target: adopted, statement: 'Narrow the lens-operability trigger glob' }), proposal({ target: fresh, statement: 'Silence the noisy note' })] },
    'synthesis:ids': realIdsResponder,
  })
  assert.match(result.report, /Already adopted on 2026-09-01T00:00:00\.000Z/)
  assert.match(result.report, /^## Proposals previously adopted \(not ranked as new\)$/m)
  const ranked = rankedSection(result.report)
  assert.ok(!ranked.includes(id), 'the adopted proposal is not in the ranked list')
  assert.ok(ranked.includes('Silence the noisy note'), 'precondition: an unadopted proposal is still ranked')
  const afterHeading = result.report.slice(result.report.indexOf('## Proposals previously adopted (not ranked as new)'))
  assert.ok(afterHeading.split('\n## ')[0].includes(id), 'the adopted proposal is listed under the separate heading')
})

// ---- F3 (AC-PROD-8 clause 2): the drafter is shown prior targets so it can reuse one exactly ----

// Round 2 F2 (AC-PROD-8): the ledger holds only ids, so a target the drafter is
// to reuse has to come from the optimiser's own per-run sidecar. This test
// replaces one that injected `target` straight into the outcome fixture, which
// proved the prompt renders a target but never that the real reader can supply
// one. Here a real sidecar and a real ledger event go through the real reader.
const SIDECAR_REL = '.claude/optimise-proposal-targets.json'
function repoWithOutcomes(events, sidecar) {
  const repo = makeTempRepo()
  for (const [id, event] of events) assert.equal(runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', event, event_scope: `${id}:${event}` }).status, 0)
  if (sidecar !== undefined) {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(repo, SIDECAR_REL), typeof sidecar === 'string' ? sidecar : JSON.stringify(sidecar))
  }
  return repo
}

test('T6 round 1 F3 / round 2 F2: a real sidecar plus a real ledger event, read by the real reader, put the fixed-key target of every proposal with an outcome event inside the nonce-wrapped prior-proposal-targets block, with the reuse-exactly instruction (AC-PROD-8)', async () => {
  const adopted = fixedTarget({ kind: 'trigger_tune', component: 'zeta-prior', concern: 'glob', lens: 'lens-operability' })
  const rejected = fixedTarget({ kind: 'ci_note', component: 'eta-prior', concern: 'noise' })
  const unrelated = fixedTarget({ kind: 'ci_note', component: 'theta-never-decided', concern: 'noise' })
  const idA = reader.stableProposalId(adopted); const idR = reader.stableProposalId(rejected)
  const repo = repoWithOutcomes([[idA, 'proposal_adopted'], [idR, 'proposal_rejected']], { [idA]: adopted, [idR]: rejected, [reader.stableProposalId(unrelated)]: unrelated })
  const real = runCli('ledger', {}, [repo]).out
  const { calls } = await run({ 'lane:ledger': { ...ledgerFixture(), proposalOutcomes: real.proposalOutcomes } })
  const prompt = calls.find((c) => c.opts.label === 'synthesis:proposals').prompt
  const block = extractBlock(prompt, 'prior-proposal-targets')
  assert.ok(block, 'the prompt has a nonce-wrapped prior-proposal-targets block')
  for (const t of [adopted, rejected]) {
    assert.ok(block.includes(`"component":"${t.component}"`), `the block carries ${t.component}'s fixed-key target`)
    assert.ok(block.includes(`"concern":"${t.concern}"`))
  }
  assert.ok(!block.includes('theta-never-decided'), 'a sidecar entry with no outcome event is not offered as a prior target')
  assert.ok(!prompt.replace(block, '').includes('zeta-prior'), 'the prior target appears only inside the data block, never as bare instruction text')
  assert.match(prompt, /prior-proposal-targets[\s\S]*reuse[\s\S]*exactly|reuse[\s\S]*exactly[\s\S]*prior-proposal-targets/i, 'the prompt tells the drafter to reuse a prior target exactly so the id matches')
})

test('T6 round 2 F2: with the sidecar absent the same real ledger yields the id-only form in the prompt block, carrying the reader\'s reason, never a throw (AC-PROD-8)', async () => {
  const target = fixedTarget({ kind: 'trigger_tune', component: 'iota-prior', concern: 'glob' })
  const id = reader.stableProposalId(target)
  const repo = repoWithOutcomes([[id, 'proposal_adopted']]) // no sidecar written
  const real = runCli('ledger', {}, [repo]).out
  const reason = real.proposalOutcomes[id].targetUnavailableReason
  assert.equal(typeof reason, 'string'); assert.ok(reason.length > 0, 'the reader says why there is no target')
  const { calls } = await run({ 'lane:ledger': { ...ledgerFixture(), proposalOutcomes: real.proposalOutcomes } })
  const block = extractBlock(calls.find((c) => c.opts.label === 'synthesis:proposals').prompt, 'prior-proposal-targets')
  assert.ok(block && block.includes(id), 'the id is carried')
  assert.ok(!block.includes('iota-prior'))
  assert.ok(block.includes(reason), `the reader's reason reaches the drafter: ${block}`)
})

test('T6 round 1 F3: an outcome whose target is not known carries the id and says so, and no outcomes means no empty-claim block content (AC-PROD-8)', async () => {
  const { calls } = await run({
    'lane:ledger': { ...ledgerFixture(), proposalOutcomes: { abcdef0123456789: outcome({ adoptedCount: 1, lastAdoptionTs: '2026-09-01T00:00:00.000Z' }) } },
  })
  const block = extractBlock(calls.find((c) => c.opts.label === 'synthesis:proposals').prompt, 'prior-proposal-targets')
  assert.ok(block && block.includes('abcdef0123456789'), 'the id is carried')
  assert.match(block, /target[^"]*unknown|unknown[^"]*target|not recorded|not known/i, 'the block says the target is not known')
})

// ---- F4 (AC-SEC-10): agent text is redacted before it reaches the report or the synthesis block ----

test('T6 round 1 F4: a forged entry whose repo is another roster root, and a matched entry whose method text carries a root or an absolute path, leave no root string in the report or the synthesis prompt (AC-SEC-10)', async () => {
  const perRoot = goodPair()
  // Forged: lane alpha answers about index 1 and names beta's ROOT as its repo.
  perRoot[ALPHA] = { repos: [entry(1, BETA, { count: 999, n_commits_examined: 888 })] }
  // Matched: beta's genuine entry, but the agent-supplied prose names both roots and a home path.
  perRoot[BETA] = { repos: [entry(1, 'beta-repo', { count: 7, n_commits_examined: 350, method: `heuristic, see ${ALPHA} and /Users/someone/secret/dir`, scoped_method: `scoped in ${BETA}/sub` })] }
  const { result, calls } = await run({ 'lane:git': gitResponder(perRoot) })
  const section = escapedSection(result.report)
  assert.match(blockFor(section, ['alpha-repo', 'beta-repo'], 1), /\b7 of 350\b/, 'precondition: the matched entry rendered, so the method lines ran')
  assert.match(section, /unmatched/i, 'precondition: the forged entry was reported')
  assert.ok(section.includes(REDACTED), 'the redaction marker stands where the path was')
  for (const root of ROOTS) assert.ok(!result.report.includes(root), `${root} leaked into the report`)
  assert.ok(!result.report.includes('/Users/someone'), 'an arbitrary absolute path is redacted too')
  const prompt = calls.find((c) => c.opts.label === 'synthesis:proposals').prompt
  const block = extractBlock(prompt, 'escaped-defect-heuristic')
  assert.ok(block, 'precondition: the synthesis data block exists')
  for (const root of ROOTS) assert.ok(!block.includes(root), `${root} leaked into the synthesis data block`)
  assert.ok(!block.includes('/Users/someone'))
})

// ---- F5 (AC-SEC-10 integrity): one quoted command, and a toplevel check in the script ----

test('T6 round 1 F5: the git lane prompt is ONE git -C "<root>" command per step and asks for the toplevel to pass through (AC-SEC-10)', async () => {
  const { calls } = await run()
  const p = calls.find((c) => c.opts.label === 'lane:git').prompt
  assert.ok(p.includes(`git -C "${ALPHA}" rev-parse --show-toplevel`), 'the lane also reports the repo toplevel of that root')
  assert.ok(p.includes('"toplevel"'), 'the toplevel is passed to the script in the JSON payload')
  assert.ok(!/\bcd\s/.test(p), 'no separate cd step')
})

test('T6 round 1 F5: escaped-defects rejects a toplevel that is not the root (after realpath on both), as a rejected result with a reason and no figures; a matching or symlinked root still passes (AC-SEC-10)', () => {
  const a = makeTempRepo(); const b = makeTempRepo()
  commitFixes(a, 2)
  assert.equal(runAppend(a, { schema_version: 1, kind: 'tdd_task', outcome: 'done' }).status, 0)
  const raw = gitLogRaw(a)
  const topOf = (d) => sh('git rev-parse --show-toplevel', d).trim()
  // A different repo's toplevel: rejected.
  const wrong = runCli('escaped-defects', { git_log_raw: raw, root: a, toplevel: topOf(b) })
  assert.equal(wrong.out.rejected, true)
  assert.equal(typeof wrong.out.reason, 'string'); assert.ok(wrong.out.reason.length > 0)
  assert.ok(wrong.out.count == null && wrong.out.scoped_count == null, `no figures on a rejection: ${wrong.raw}`)
  assert.ok(!wrong.raw.includes(a) && !wrong.raw.includes(b), 'the reason echoes no path')
  // A root that is a subdirectory of the repo: git -C would have read the enclosing repo.
  const sub = path.join(a, 'sub'); fs.mkdirSync(sub)
  const nested = runCli('escaped-defects', { git_log_raw: raw, root: sub, toplevel: topOf(a) })
  assert.equal(nested.out.rejected, true)
  assert.ok(nested.out.count == null)
  // Matching toplevel: figures as before.
  const ok = runCli('escaped-defects', { git_log_raw: raw, root: a, toplevel: topOf(a) })
  assert.ok(!ok.out.rejected); assert.equal(ok.out.count, 2)
  // A symlinked root resolving to the same toplevel is equal after realpath.
  const link = path.join(path.dirname(a), path.basename(a) + '-link')
  fs.symlinkSync(a, link)
  const viaLink = runCli('escaped-defects', { git_log_raw: raw, root: link, toplevel: topOf(a) })
  assert.ok(!viaLink.out.rejected, `a symlinked root is the same directory: ${viaLink.raw}`); assert.equal(viaLink.out.count, 2)
  fs.unlinkSync(link)
})

// ---- F6: the malformed-target line used a dead regex ----

test('T6 round 1 F6: the malformed-target report line flattens through oneLine: one line, no injected heading, and a literal backslash-s in a key survives (the old /\\\\s+/ matched that, not whitespace)', async () => {
  const evilKey = 'x\n## Injected heading\n' + 'K'.repeat(300)
  const slashKey = 'a\\ssb'
  const bad = { ...fixedTarget(), [evilKey]: 'v', [slashKey]: 'v' }
  const { result } = await run({ 'synthesis:proposals': { proposals: [proposal({ target: bad })] } })
  const lines = result.report.split('\n')
  const line = lines.find((l) => l.startsWith('Proposals rejected: malformed target: 1'))
  assert.ok(line, 'precondition: the malformed-target line rendered')
  assert.ok(!lines.some((l) => l.startsWith('## Injected')), 'agent text must not open a heading')
  assert.ok(line.includes(slashKey), `a literal backslash-s is not whitespace and must survive: ${line}`)
})

// ==== review round 2 fixes (PR #9): F1 to F8 ====

function sectionOf(report, heading) {
  const start = report.indexOf(heading)
  assert.ok(start >= 0, `report has "${heading}":\n${report}`)
  const rest = report.slice(start)
  const end = rest.indexOf('\n## ', 5)
  return end < 0 ? rest : rest.slice(0, end)
}
const ADOPTED_HEADING = '## Proposals previously adopted (not ranked as new)'
const INSUFFICIENT_HEADING = '## Proposals (insufficient data, excluded from ranking)'
const ADOPTED_TS = '2026-09-01T00:00:00.000Z'
const REJECTED_TS = '2026-09-02T00:00:00.000Z'

// ---- F1 (AC-SEC-15, AC-PROD-8): one annotation renderer, and a flagged proposal is never moved ----

test('T6 round 2 F1: an adopted security-purposed removal stays in the ranked list, still carrying its security flag and reinstatement evidence, annotated as already adopted (AC-SEC-15)', async () => {
  const target = fixedTarget({ kind: 'ci_note', component: 'vuln-scan', concern: 'noise', job: 'our-custom-vuln-scanner', security_purposed: true })
  const id = reader.stableProposalId(target)
  const { result } = await run({
    'lane:ledger': { ...ledgerFixture(), proposalOutcomes: { [id]: outcome({ adoptedCount: 1, lastAdoptionTs: ADOPTED_TS }) } },
    'synthesis:proposals': { proposals: [proposal({ target, statement: 'our-custom-vuln-scanner is noisy lately', reinstatement_evidence: 'reinstate on any new CVE class' })] },
    'synthesis:ids': realIdsResponder,
  })
  assert.equal(result.proposals_ranked.length, 1, 'a security-flagged proposal is never moved out of the ranked list')
  assert.equal(result.proposals_ranked[0].category, 'security_removal_flagged')
  assert.equal(result.proposals_previously_adopted.length, 0)
  const ranked = rankedSection(result.report)
  assert.ok(ranked.includes(id))
  assert.ok(ranked.includes('**Flagged: security-purposed check removal/demotion.**'), 'the security flag survives')
  assert.ok(ranked.includes('Reinstatement evidence: reinstate on any new CVE class'), 'the reinstatement evidence survives')
  assert.ok(ranked.includes(`Already adopted on ${ADOPTED_TS}`), 'the adoption is annotated where the proposal stays')
  assert.match(sectionOf(result.report, ADOPTED_HEADING), /None\./)
})

test('T6 round 2 F1: a proposal adopted and reverted twice stays in the ranked list with both annotations (AC-SEC-15, section 12)', async () => {
  const target = fixedTarget({ kind: 'trigger_tune', component: 'twice-reverted', concern: 'glob', lens: 'lens-operability' })
  const id = reader.stableProposalId(target)
  const { result } = await run({
    'lane:ledger': { ...ledgerFixture(), proposalOutcomes: { [id]: outcome({ adoptedCount: 2, lastAdoptionTs: ADOPTED_TS, revertedCount: 2, revertedTwiceOrMore: true }) } },
    'synthesis:proposals': { proposals: [proposal({ target, statement: 'Narrow the lens-operability trigger glob' })] },
    'synthesis:ids': realIdsResponder,
  })
  assert.equal(result.proposals_ranked.length, 1, 'reverted twice is never moved out of the ranked list')
  assert.equal(result.proposals_previously_adopted.length, 0)
  const ranked = rankedSection(result.report)
  assert.match(ranked, /adopted and reverted at least twice/)
  assert.ok(ranked.includes(`Already adopted on ${ADOPTED_TS}`))
})

test('T6 round 2 F1: the previously-adopted section carries the same annotations as the ranked list: prior rejection and reinstatement evidence, not only the adoption date (AC-PROD-8)', async () => {
  const target = fixedTarget({ kind: 'trigger_tune', component: 'adopted-and-rejected', concern: 'glob', lens: 'lens-operability' })
  const id = reader.stableProposalId(target)
  const { result } = await run({
    'lane:ledger': { ...ledgerFixture(), proposalOutcomes: { [id]: outcome({ adoptedCount: 1, lastAdoptionTs: ADOPTED_TS, rejectedCount: 1, lastRejectionTs: REJECTED_TS }) } },
    'synthesis:proposals': { proposals: [proposal({ target, statement: 'Narrow the lens-operability trigger glob', reinstatement_evidence: 'keep the glob broad on revert' })] },
    'synthesis:ids': realIdsResponder,
  })
  assert.equal(result.proposals_previously_adopted.length, 1, 'precondition: an ordinary adopted proposal does move')
  const sec = sectionOf(result.report, ADOPTED_HEADING)
  assert.ok(sec.includes(`Already adopted on ${ADOPTED_TS}`))
  assert.ok(sec.includes(`Previously rejected on ${REJECTED_TS}`), `prior rejection dropped from the adopted section:\n${sec}`)
  assert.ok(sec.includes('Reinstatement evidence: keep the glob broad on revert'), `reinstatement evidence dropped from the adopted section:\n${sec}`)
})

test('T6 round 2 F1: an insufficient-data proposal with a prior adoption and a prior rejection shows both in its section (AC-PROD-8)', async () => {
  const target = fixedTarget({ kind: 'ci_note', component: 'thin-evidence', concern: 'noise' })
  const id = reader.stableProposalId(target)
  const { result } = await run({
    'lane:ledger': { ...ledgerFixture(), proposalOutcomes: { [id]: outcome({ adoptedCount: 1, lastAdoptionTs: ADOPTED_TS, rejectedCount: 1, lastRejectionTs: REJECTED_TS }) } },
    'synthesis:proposals': { proposals: [proposal({ target, statement: 'Silence the thin-evidence note', n: 2 })] },
    'synthesis:ids': realIdsResponder,
  })
  assert.equal(result.proposals_insufficient_data.length, 1, 'precondition: the proposal is in the insufficient-data list')
  const sec = sectionOf(result.report, INSUFFICIENT_HEADING)
  assert.ok(sec.includes(id) && sec.includes('Silence the thin-evidence note'), 'precondition: the proposal is listed')
  assert.ok(sec.includes(`Already adopted on ${ADOPTED_TS}`), `adoption dropped from the insufficient-data list:\n${sec}`)
  assert.ok(sec.includes(`Previously rejected on ${REJECTED_TS}`), `rejection dropped from the insufficient-data list:\n${sec}`)
})

// ---- F7 (AC-PROD-8): the target is shown, one flattened redacted line, in all three sections ----

test('T6 round 2 F7: every proposal shows its six identity fields on one exact "Target:" line, in the ranked, previously-adopted and insufficient-data sections (AC-PROD-8)', async () => {
  const fresh = fixedTarget({ kind: 'ci_note', component: 'fresh-thing', concern: 'noise' })
  const adopted = fixedTarget({ kind: 'trigger_tune', component: 'lens-operability', concern: 'trigger glob', lens: 'lens-operability' })
  const thin = fixedTarget({ kind: 'ci_demote', component: 'ci', concern: 'duration', workflow: 'ci.yml', job: 'test' })
  const { result } = await run({
    'lane:ledger': { ...ledgerFixture(), proposalOutcomes: { [reader.stableProposalId(adopted)]: outcome({ adoptedCount: 1, lastAdoptionTs: ADOPTED_TS }) } },
    'synthesis:proposals': { proposals: [
      proposal({ target: fresh, statement: 'Silence the noisy note' }),
      proposal({ target: adopted, statement: 'Narrow the lens-operability trigger glob' }),
      proposal({ target: thin, statement: 'Look at the test job duration', n: 2 }),
    ] },
    'synthesis:ids': realIdsResponder,
  })
  assert.ok(rankedSection(result.report).split('\n').includes('Target: kind=ci_note component=fresh-thing concern=noise lens= workflow= job='), `ranked:\n${rankedSection(result.report)}`)
  assert.ok(sectionOf(result.report, ADOPTED_HEADING).split('\n').includes('Target: kind=trigger_tune component=lens-operability concern=trigger glob lens=lens-operability workflow= job='))
  assert.ok(sectionOf(result.report, INSUFFICIENT_HEADING).split('\n').includes('Target: kind=ci_demote component=ci concern=duration lens= workflow=ci.yml job=test'))
})

test('T6 round 2 F7: the target line is flattened, bounded and redacted: a newline, a heading, a root path and a long value cannot escape it (AC-SEC-10)', async () => {
  const target = fixedTarget({ kind: 'ci_note', component: `a\n## Injected target heading\n${ALPHA}/sub ${'Z'.repeat(400)}`, concern: 'noise' })
  const { result } = await run({ 'synthesis:proposals': { proposals: [proposal({ target })] } })
  const lines = result.report.split('\n')
  assert.ok(lines.some((l) => l.startsWith('Target: kind=ci_note component=a ## Injected target heading ' + REDACTED)), `the target line is one flattened, redacted line:\n${rankedSection(result.report)}`)
  assert.ok(!lines.some((l) => l.startsWith('## Injected')))
  assert.ok(!result.report.includes(ALPHA))
  assert.ok(!/Z{200}/.test(result.report))
})

// ---- F2 (AC-PROD-8): the sidecar the optimiser writes beside its report ----

test('T6 round 2 F2: the report:write step is handed a sidecar mapping every proposal id computed this run (ranked, previously adopted, insufficient-data) to its fixed-key target, under the same ensure-ignored step (AC-PROD-8)', async () => {
  const fresh = fixedTarget({ kind: 'ci_note', component: 'fresh-thing', concern: 'noise' })
  const adopted = fixedTarget({ kind: 'trigger_tune', component: 'lens-operability', concern: 'trigger glob', lens: 'lens-operability' })
  const thin = fixedTarget({ kind: 'ci_note', component: 'thin-thing', concern: 'noise' })
  const { calls } = await run({
    'lane:ledger': { ...ledgerFixture(), proposalOutcomes: { [reader.stableProposalId(adopted)]: outcome({ adoptedCount: 1, lastAdoptionTs: ADOPTED_TS }) } },
    'synthesis:proposals': { proposals: [proposal({ target: fresh }), proposal({ target: adopted }), proposal({ target: thin, n: 2 })] },
    'synthesis:ids': realIdsResponder,
  })
  const prompt = calls.find((c) => c.opts.label === 'report:write').prompt
  assert.ok(prompt.includes('.claude/optimise-proposal-targets.json'), 'the step is told the sidecar path')
  assert.ok(prompt.includes('optimise-report-ignore.mjs'), 'the existing ensure-ignored script is the guard')
  const block = extractBlock(prompt, 'proposal-targets-sidecar-to-write-verbatim')
  assert.ok(block, 'the sidecar content is its own nonce-wrapped data block')
  assert.deepEqual(JSON.parse(block), {
    [reader.stableProposalId(fresh)]: fresh,
    [reader.stableProposalId(adopted)]: adopted,
    [reader.stableProposalId(thin)]: thin,
  })
})

test('T6 round 2 F2: the sidecar is redacted like everything else the optimiser writes: a roster root in a target value never reaches it (AC-SEC-10)', async () => {
  const target = fixedTarget({ kind: 'ci_note', component: `uses ${ALPHA}/sub`, concern: 'noise' })
  const { calls } = await run({ 'synthesis:proposals': { proposals: [proposal({ target })] }, 'synthesis:ids': realIdsResponder })
  const block = extractBlock(calls.find((c) => c.opts.label === 'report:write').prompt, 'proposal-targets-sidecar-to-write-verbatim')
  assert.ok(block, 'precondition: the sidecar block exists')
  assert.ok(!block.includes(ALPHA))
})

// ---- F3 (AC-QA-19, AC-SEC-10): the toplevel check fails closed, and a rejection is representable ----

test('T6 round 2 F3: escaped-defects rejects when toplevel is missing or empty, the same no-figures shape as a mismatch (AC-SEC-10)', () => {
  const a = makeTempRepo()
  commitFixes(a, 2)
  const raw = gitLogRaw(a)
  for (const payload of [{ git_log_raw: raw, root: a }, { git_log_raw: raw, root: a, toplevel: '' }]) {
    const { out, raw: text } = runCli('escaped-defects', payload)
    assert.equal(out.rejected, true, `fails open without a toplevel: ${text}`)
    assert.equal(typeof out.reason, 'string'); assert.ok(out.reason.length > 0)
    assert.ok(out.count == null && out.scoped_count == null, `no figures on a rejection: ${text}`)
    assert.ok(!text.includes(a), 'the reason echoes no path')
  }
})

const rejectedEntry = (rootIndex, repo, reason, overrides = {}) => ({
  ...entry(rootIndex, repo),
  count: null, n_commits_examined: null, scoped_count: null, scoped_excluded_count: null, scoped_unavailable_count: null,
  rejected: true, reason, ...overrides,
})

test('T6 round 2 F3: GIT_LANE_ENTRY_SCHEMA can represent a reader rejection (null figures, optional rejected boolean and reason) and still rejects a non-boolean rejected or a string count (AC-QA-19)', async () => {
  const { calls } = await run()
  const schema = calls.find((c) => c.opts.label === 'lane:git').opts.schema
  assert.deepEqual(validateEntry({ repos: [rejectedEntry(0, 'alpha-repo', 'git toplevel does not match the roster root')] }, schema), [])
  assert.ok(validateEntry({ repos: [rejectedEntry(0, 'alpha-repo', 'r', { rejected: 'yes' })] }, schema).length > 0, 'rejected is a boolean')
  assert.ok(validateEntry({ repos: [rejectedEntry(0, 'alpha-repo', 'r', { reason: 5 })] }, schema).length > 0, 'reason is a string')
  assert.ok(validateEntry({ repos: [rejectedEntry(0, 'alpha-repo', 'r', { count: 'many' })] }, schema).length > 0, 'count is an integer or null, nothing else')
  assert.deepEqual(validateEntry({ repos: [entry(0, 'alpha-repo')] }, schema), [], 'an ordinary entry without the new fields still validates')
})

test('T6 round 2 F3: a relayed rejected entry is rendered as "Not measured: <reason>", never as figures and never as "0 of 0" (AC-QA-19)', async () => {
  const perRoot = goodPair()
  perRoot[BETA] = { repos: [rejectedEntry(1, 'beta-repo', 'git toplevel does not match the roster root; the git log was not read from that repo')] }
  const { result } = await run({ 'lane:git': gitResponder(perRoot) })
  const section = escapedSection(result.report)
  const b = blockFor(section, ['alpha-repo', 'beta-repo'], 1)
  assert.match(b, /Not measured: git toplevel does not match the roster root/, `the reason is shown:\n${b}`)
  assert.doesNotMatch(b, /\bof 0\b|\b0 of\b|examined commits/, 'no figures line')
  assert.match(blockFor(section, ['alpha-repo', 'beta-repo'], 0), /\b3 of 480\b/, 'the other repo is unaffected')
})

test('T6 round 2 F3: rejected true wins over a stale integer count, and a null count without the flag is also "Not measured" (AC-QA-19)', async () => {
  const forged = goodPair()
  forged[BETA] = { repos: [rejectedEntry(1, 'beta-repo', 'rejected upstream', { count: 7, n_commits_examined: 350 })] }
  const r1 = await run({ 'lane:git': gitResponder(forged) })
  const b1 = blockFor(escapedSection(r1.result.report), ['alpha-repo', 'beta-repo'], 1)
  assert.match(b1, /Not measured: rejected upstream/)
  assert.doesNotMatch(b1, /\b7 of 350\b/)
  const nulled = goodPair()
  // An ordinary (accepted) entry OMITS the rejection keys; a key present with
  // an undefined value is not JSON and would need a non-standard schema type.
  const accepted = rejectedEntry(1, 'beta-repo', 'unused')
  delete accepted.rejected
  delete accepted.reason
  nulled[BETA] = { repos: [accepted] }
  const r2 = await run({ 'lane:git': gitResponder(nulled) })
  const b2 = blockFor(escapedSection(r2.result.report), ['alpha-repo', 'beta-repo'], 1)
  assert.match(b2, /Not measured: .+/, `a non-integer count is a failed lane, not zero:\n${b2}`)
  assert.doesNotMatch(b2, /\bof 0\b|\b0 of\b/)
})

test('T6 round 2 F3: a rejection reason is flattened, bounded and redacted before it is echoed (AC-SEC-10)', async () => {
  const perRoot = goodPair()
  perRoot[BETA] = { repos: [rejectedEntry(1, 'beta-repo', `bad ${BETA}/x\n## Injected reason heading\n${'R'.repeat(400)}`)] }
  const { result } = await run({ 'lane:git': gitResponder(perRoot) })
  const b = blockFor(escapedSection(result.report), ['alpha-repo', 'beta-repo'], 1)
  assert.match(b, /Not measured: bad /, 'precondition: the reason rendered')
  assert.ok(!result.report.split('\n').some((l) => l.startsWith('## Injected')))
  assert.ok(!result.report.includes(BETA))
  assert.ok(!/R{200}/.test(result.report))
})

// ---- F5 (AC-QA-21): each brake test needs a control proving the entry is otherwise found ----

for (const flag of ['truncated', 'insufficientData', 'renameSuspect']) {
  test(`T6 brake control: the same ${flag} CI entry with the flag false lets the removal through, so the drop above is for the flag and not for an unknown job (AC-QA-21, round 2 F5)`, async () => {
    // HARN-OPT-5 T7 (AC-QA-22): this control used to feed neverFailed null with
    // every flag false and require the removal to survive. The brake now reads
    // the verdict (neverFailed !== true), so a null verdict is weak evidence
    // whatever the flags say; the control carries neverFailed true instead.
    const entryFor = { workflow: 'ci.yml', job: 'lint', n: 100, windowStart: 'x', windowEnd: 'y', truncated: false, insufficientData: false, renameSuspect: false, neverFailed: true, meanDurationS: 1, [flag]: false }
    const { result } = await run({
      'lane:ci': ciFixture({ 'ci.yml::lint': entryFor }),
      'synthesis:proposals': { proposals: [proposal({ target: fixedTarget({ kind: 'ci_remove', workflow: 'ci.yml', job: 'lint' }), statement: 'Remove the lint job: never failed', citations: ['1001'], reinstatement_evidence: 'evidence', n: 100 })] },
    })
    assert.equal(result.proposals_ranked.length, 1, `the control must survive:\n${result.report}`)
  })
}

// ---- F8: SKILL.md describes the shipped shape ----

test('T6 round 2 F8: SKILL.md no longer describes the old target shape, and documents the fixed key set, the adoption annotation, the new section and the sidecar', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'optimise-cycle', 'SKILL.md'), 'utf8')
  assert.ok(!skill.includes('(workflow file, job name, lens, trigger glob)'), 'the old target description is gone')
  for (const key of ['kind', 'component', 'concern', 'lens', 'workflow', 'job', 'touches_always_on_lens', 'security_purposed']) assert.ok(skill.includes('`' + key + '`'), `the fixed key ${key} is named`)
  assert.ok(skill.includes('Already adopted'), 'the adoption annotation is documented')
  assert.ok(skill.includes('Proposals previously adopted'), 'the new report section is documented')
  const reading = skill.slice(skill.indexOf('## Reading the report'))
  assert.ok(reading.includes('.claude/optimise-proposal-targets.json'), 'the sidecar is documented under Reading the report')
  assert.ok(reading.includes('rm .claude/optimise-proposal-targets.json'), 'its retention and removal are stated')
})

// ==== (6) Review round 3, conductor fix pass (the owner chose option (a) on 2026-10-12) ====
//
// Round 3 found two Mediums that fix round 2 introduced and four cheap Lows.
// Each test here pins one of them. Guard-only tests pass against code that is
// already right, so each was proven by mutation (see the PR body) rather than
// by a RED run.

test('T6 round 3 M1: the prior-proposal-targets block carries only the six identity fields, and the instruction says the two gate booleans are set from the proposal itself, never copied (AC-SEC-9, AC-PROD-8)', async () => {
  const rejected = fixedTarget({ kind: 'lens_demote', component: 'gitleaks-step', concern: 'noise', security_purposed: true })
  const id = reader.stableProposalId(rejected)
  const repo = repoWithOutcomes([[id, 'proposal_rejected']], { [id]: rejected })
  const real = runCli('ledger', {}, [repo]).out
  const { calls } = await run({ 'lane:ledger': { ...ledgerFixture(), proposalOutcomes: real.proposalOutcomes } })
  const prompt = calls.find((c) => c.opts.label === 'synthesis:proposals').prompt
  const block = extractBlock(prompt, 'prior-proposal-targets')
  assert.ok(block && block.includes('"component":"gitleaks-step"'), 'the identity fields are still shown')
  assert.ok(!block.includes('security_purposed') && !block.includes('touches_always_on_lens'), `a prior target's gate booleans are not offered for reuse:\n${block}`)
  assert.match(prompt, /six identity fields/i, 'the instruction names the six identity fields as what to reuse')
  assert.match(prompt, /touches_always_on_lens[\s\S]{0,200}security_purposed[\s\S]{0,400}never copied/i, 'the instruction says the gate booleans are never copied from a prior target')
})

test('T6 round 3 M2: the sidecar the run writes is seeded with every prior outcome target the reader supplied, so a decided target survives a cycle in which the drafter does not re-raise it (AC-PROD-8, AC-QA-20)', async () => {
  const decided = fixedTarget({ kind: 'trigger_tune', component: 'kappa-decided', concern: 'glob' })
  const id = reader.stableProposalId(decided)
  const repo = repoWithOutcomes([[id, 'proposal_adopted']], { [id]: decided })
  const real = runCli('ledger', {}, [repo]).out
  const { calls } = await run({ 'lane:ledger': { ...ledgerFixture(), proposalOutcomes: real.proposalOutcomes }, 'synthesis:proposals': { proposals: [] } })
  const sidecar = JSON.parse(extractBlock(calls.find((c) => c.opts.label === 'report:write').prompt, 'proposal-targets-sidecar-to-write-verbatim'))
  assert.deepEqual(sidecar[id], decided, `the decided target is carried forward with the full fixed key set:\n${JSON.stringify(sidecar)}`)
})

test("T6 round 3 M2: the sidecar is written under the roster's first repo root, where the reader looks first, not under whichever repo the cycle was invoked from (AC-PROD-8)", async () => {
  const { calls } = await run()
  const prompt = calls.find((c) => c.opts.label === 'report:write').prompt
  assert.ok(prompt.includes(`"${ALPHA}" ".claude/optimise-proposal-targets.json"`), `the ensure-ignored check for the sidecar names roster root 1:\n${prompt.slice(0, 2500)}`)
  assert.ok(prompt.includes(`${ALPHA}/.claude/optimise-proposal-targets.json`), 'the write target is the sidecar path under roster root 1')
  assert.ok(prompt.includes('"$(git rev-parse --show-toplevel)" ".claude/optimise-cycle-report.md"'), 'the report still goes to the current repo')
})

test('T6 round 3 L1: a ledger label that is a roster root path is redacted in the escaped-defect header, not printed (AC-SEC-10)', async () => {
  const { result } = await run({ 'lane:ledger': ledgerFixture([ALPHA, 'beta-repo']) })
  const section = escapedSection(result.report)
  assert.ok(!section.includes(ALPHA), `the root path never reaches the report:\n${section}`)
  assert.ok(section.includes(`Repo 1 (${REDACTED})`), `the header shows the redaction marker:\n${section}`)
})

test('T6 round 3 L2: when the ledger lane fails, a measured git figure is reported as not measured because the ledger identity is unavailable, never as a "repo mismatch" against null (AC-QA-19)', async () => {
  const res = responses(); delete res['lane:ledger'] // fake-runtime convention: a missing response is a lane that failed
  const { result } = await runWorkflow(WORKFLOW, { args: {}, agent: res })
  const section = escapedSection(result.report)
  assert.doesNotMatch(section, /repo mismatch/, `no mismatch is claimed against a ledger that never answered:\n${section}`)
  assert.match(section, /ledger (lane |identity )?(unavailable|failed)/i, `the real reason is named:\n${section}`)
})

test('T6 round 3 L3: the escaped-defect-heuristic data block carries the flattened repo label, not the raw one (the flat() used to be overwritten by the spread)', async () => {
  const messy = 'alpha\n   repo'
  const perRoot = { [ALPHA]: { repos: [entry(0, messy, { count: 3, n_commits_examined: 480 })] }, [BETA]: goodPair()[BETA] }
  const { calls } = await run({ 'lane:ledger': ledgerFixture([messy, 'beta-repo']), 'lane:git': gitResponder(perRoot) })
  const block = JSON.parse(extractBlock(calls.find((c) => c.opts.label === 'synthesis:proposals').prompt, 'escaped-defect-heuristic'))
  assert.equal(block[0].count, 3, 'the figure matched its repo')
  assert.equal(block[0].repo, 'alpha repo', `the repo label is flattened:\n${JSON.stringify(block[0])}`)
})

test('T6 round 3 L4: `ids` with legacy_targets also returns a sidecar_entry in the fixed key set for every mappable target, null otherwise, and the real reader accepts it once written beside an outcome event (AC-PROD-8, AC-DATA-14)', () => {
  const [r, bad] = legacy([{ kind: 'ci_demote', component: 'lens-operability', concern: 'trigger glob', security_purposed: true }, { cycle: 5, change: 'x' }])
  assert.deepEqual(r.sidecar_entry, { kind: 'ci_demote', component: 'lens-operability', concern: 'trigger glob', lens: '', workflow: '', job: '', touches_always_on_lens: false, security_purposed: true })
  assert.equal(bad.proposal_id, null); assert.equal(bad.sidecar_entry, null)
  const repo = repoWithOutcomes([[r.proposal_id, 'proposal_adopted']], { [r.proposal_id]: r.sidecar_entry })
  const out = runCli('ledger', {}, [repo]).out
  assert.deepEqual(out.proposalOutcomes[r.proposal_id].target, r.sidecar_entry, 'the reader attaches the seeded target')
})

test("T6 round 3 L4: the skill tells the conductor to seed the sidecar under the roster's first repo root from sidecar_entry when it re-records outcome events, and says the sidecar carries prior targets forward (AC-PROD-8)", () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'optimise-cycle', 'SKILL.md'), 'utf8')
  assert.match(skill, /sidecar_entry/, 'names the field the ids command returns')
  assert.match(skill, /first (roster )?repo root|roster'?s first repo/i, 'names where the sidecar lives')
  assert.match(skill, /carried forward|carries forward|survives/i, 'states that prior targets are carried forward')
})
