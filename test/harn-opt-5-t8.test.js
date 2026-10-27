// HARN-OPT-5 T8 (conductor-added, no lens criteria): plan-cycle's synthesis write-back is verified by script after
// the agent edits the spec, and a bad write-back is undone and reported, never recorded as done. Motivation,
// 2026-10-13: the write-back pasted the whole preamble into the criteria at three points and cut three criterion
// lines at a regex end anchor followed by a backtick; only the pre-push duplicate-criterion scan caught it.
// The library tests are in test/spec-writeback.test.js; this file pins the workflow side with the fake runtime.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')

const WF_DIR = path.join(__dirname, '..', 'workflows')
const WF = path.join(WF_DIR, 'plan-cycle.js')
const SPEC = 'specs/foo.md'
const SHA = 'a'.repeat(64)
const OTHER_SHA = 'b'.repeat(64)
const SNAP_FILE = '/tmp/harn-specwb-AbC123/spec.snapshot'
const BEFORE = { file: SNAP_FILE, sha256: SHA, headings: ['## Problem', '## Acceptance criteria'], ac_ids: ['AC-SEC-1'] }
const IDS = ['AC-SEC-1', 'AC-QA-1']
const CHECK_OK = { ok: true, problems: [], restored: false, spec_sha256: OTHER_SHA, snapshot_sha256: SHA, surviving_ids_checked: IDS }
const CHECK_BAD = {
  ok: false, problems: ['duplicate heading: ## Problem (2 times)', 'criterion line ends mid-sentence: AC-QA-1'],
  restored: true, spec_sha256_after_restore: SHA, snapshot_sha256: SHA, surviving_ids_checked: IDS,
}

const CONSISTENCY_OK = {
  ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9,
  doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: [], missing_in_plan_schema: [],
  review_only_props: [], plan_only_props: [], error: null,
}
const SCOPE = (snapshot) => ({
  head_sha: 'abc1234567890def', summary: 'adds a widget', ui: false, data: false, architecture: false, operability: false,
  user_facing: true, likely_paths: ['src/widget.js'], consistency: CONSISTENCY_OK,
  ...(snapshot === undefined ? {} : { spec_snapshot: snapshot }),
})
const LENS_CLEAN = { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, acceptance_criteria: [{ id: 'AC-SEC-1', statement: 'x' }] }
const LEDGER_OK = { run_id: 'r1', ts: '2026-10-27T00:00:00.000Z', write_ok: true, write_error: null }
const json = (o) => JSON.stringify(o)

// Conductor fix (T8 test defect): a destructuring default also fires for an explicit `undefined`, so the two "missing"
// cases below were silently fed a VALID snapshot or check and no correct build could return aborted for them. Presence
// is now decided by `in`, so `agents({ check: undefined })` really omits writeback_check and
// `agents({ snapshot: undefined })` really omits spec_snapshot.
function agents(opts = {}) {
  const snapshot = 'snapshot' in opts ? opts.snapshot : json(BEFORE)
  const check = 'check' in opts ? opts.check : json(CHECK_OK)
  const surviving = 'surviving' in opts ? opts.surviving : IDS
  const synthesis = opts.synthesis
  const wb = { summary: '### Summary\n2 criteria', head_sha_at_synthesis: 'abc1234567890def', surviving_ids: surviving }
  if (check !== undefined) wb.writeback_check = check
  return {
    'scope:spec': SCOPE(snapshot),
    'lens-security': LENS_CLEAN,
    'lens-qa': LENS_CLEAN,
    'lens-simplicity': { ...LENS_CLEAN, acceptance_criteria: [] },
    'lens-product': LENS_CLEAN,
    'synthesis:write-back': synthesis || wb,
    'ledger:write': LEDGER_OK,
  }
}
const go = (a) => runWorkflow(WF, { args: { spec: SPEC }, agent: a })
const terminalOutcome = (calls) => extractLedgerPayload(calls.filter((c) => c.opts.label === 'ledger:write').pop().prompt).outcome

test('plan-cycle T8: a clean write-back check gives done, with writeback {ok true, problems [], restored false}', async () => {
  const { result, calls } = await go(agents())
  assert.equal(result.telemetry.outcome, 'done')
  assert.deepEqual(result.writeback, { ok: true, problems: [], restored: false })
  assert.equal(terminalOutcome(calls), 'done')
})

test('plan-cycle T8: ok:false gives aborted, the problems are named in the report, writeback says restored, and the ledger terminal outcome is aborted', async () => {
  const { result, calls } = await go(agents({ check: json(CHECK_BAD) }))
  assert.equal(result.telemetry.outcome, 'aborted')
  assert.deepEqual(result.writeback, { ok: false, problems: CHECK_BAD.problems, restored: true })
  for (const p of CHECK_BAD.problems) assert.ok(result.report.includes(p), `the report names: ${p}`)
  assert.equal(terminalOutcome(calls), 'aborted')
})

test('plan-cycle T8: ok:false is aborted even when a lens is BLOCKED (a bad write-back is never reported as blocked or done)', async () => {
  const a = agents({ check: json(CHECK_BAD) })
  a['lens-qa'] = { ...LENS_CLEAN, verdict: 'BLOCKED' }
  const { result } = await go(a)
  assert.equal(result.telemetry.outcome, 'aborted')
})

test('plan-cycle T8: a missing writeback_check gives aborted, with writeback null', async () => {
  const { result, calls } = await go(agents({ check: undefined }))
  assert.equal(result.telemetry.outcome, 'aborted')
  assert.equal(result.writeback, null)
  assert.equal(terminalOutcome(calls), 'aborted')
})

test('plan-cycle T8: a malformed check (not JSON, ok not boolean, problems not an array) gives aborted, with writeback null', async () => {
  const bad = ['not json at all', json({ ...CHECK_OK, ok: 'true' }), json({ ...CHECK_OK, problems: 'none' }), json({ ok: true, snapshot_sha256: SHA }), '']
  for (const check of bad) {
    const { result } = await go(agents({ check }))
    assert.equal(result.telemetry.outcome, 'aborted', check)
    assert.equal(result.writeback, null, check)
  }
})

test('plan-cycle T8: a snapshot_sha256 that differs from the before object gives aborted (the check is about a different snapshot)', async () => {
  const { result } = await go(agents({ check: json({ ...CHECK_OK, snapshot_sha256: OTHER_SHA }) }))
  assert.equal(result.telemetry.outcome, 'aborted')
  assert.equal(result.writeback, null)
})

test('plan-cycle T8: a missing or malformed before object (spec_snapshot) gives aborted even if the check says ok', async () => {
  const cases = [
    undefined,
    '',
    'not json',
    json({ ...BEFORE, sha256: 'xyz' }),
    json({ ...BEFORE, sha256: 'A'.repeat(64) }),
    json({ ...BEFORE, file: '/etc/passwd' }),
    json({ ...BEFORE, file: '/tmp/other-dir/spec.snapshot' }),
    json({ headings: [], ac_ids: [] }),
  ]
  for (const snapshot of cases) {
    const { result } = await go(agents({ snapshot }))
    assert.equal(result.telemetry.outcome, 'aborted', String(snapshot))
    assert.equal(result.writeback, null, String(snapshot))
  }
})

test('plan-cycle T8: the result carries exactly the documented keys plus writeback and telemetry; the ledger payload gains no field', async () => {
  const { result } = await go(agents())
  assert.deepEqual(Object.keys(result).sort(), ['lenses', 'report', 'skipped', 'spec', 'telemetry', 'verdicts', 'writeback'])
  const { calls } = await go(agents())
  const terminal = extractLedgerPayload(calls.filter((c) => c.opts.label === 'ledger:write').pop().prompt)
  assert.ok(!('writeback' in terminal) && !('spec_snapshot' in terminal) && !('surviving_ids' in terminal), Object.keys(terminal).join(','))
})

test('plan-cycle T8: the scope prompt names the snapshot command and the library lookup order, never a repo-local copy in another repo', async () => {
  const { calls } = await go(agents())
  const p = calls.find((c) => c.opts.label === 'scope:spec').prompt
  assert.match(p, /spec-writeback\.mjs/)
  assert.match(p, /spec-writeback\.mjs> snapshot\b/)
  assert.ok(p.includes(SPEC), 'the snapshot command is given the spec path')
  assert.match(p, /~\/\.claude\/workflows\/lib\/spec-writeback\.mjs/)
  assert.match(p, /ONLY if the current repo is claude-ai-harness itself/)
  assert.match(p, /NEVER use a repo-local copy in any OTHER repo/)
  assert.ok(p.indexOf('~/.claude/workflows/lib/spec-writeback.mjs') < p.indexOf('"claude-ai-harness"'), 'installed mirror before the repo copy')
  assert.match(p, /spec_snapshot/)
  const schema = calls.find((c) => c.opts.label === 'scope:spec').opts.schema
  assert.equal(schema.properties.spec_snapshot.type, 'string')
})

test('plan-cycle T8: the synthesis prompt runs verify AFTER the edit instruction, with the spec path, the snapshot file path and the surviving ids as a JSON array, and returns stdout verbatim', async () => {
  const { calls } = await go(agents())
  const c = calls.find((x) => x.opts.label === 'synthesis:write-back')
  const p = c.prompt
  const edit = p.indexOf('Edit the spec file')
  const ver = p.search(/spec-writeback\.mjs> verify\b/)
  assert.ok(edit >= 0 && ver > edit, 'verify is instructed after the edit')
  assert.ok(p.includes(SPEC) && p.includes(SNAP_FILE), 'the spec path and the snapshot file path from the scope step are in the prompt')
  assert.match(p, /JSON array/)
  assert.match(p, /writeback_check/)
  assert.match(p, /verbatim/)
  assert.match(p, /surviving_ids/)
  assert.match(p, /changing nothing else|change nothing else/)
  const props = c.opts.schema.properties
  assert.deepEqual(props.surviving_ids, { type: 'array', items: { type: 'string' } })
  assert.equal(props.writeback_check.type, 'string')
})

test('plan-cycle T8 static: the await agent( count stays 3, no new workflow argument, and the L5 block is byte-identical across the three workflows', () => {
  const src = fs.readFileSync(WF, 'utf8')
  assert.equal((src.match(/await agent\(/g) || []).length, 3)
  assert.doesNotMatch(src, /opts\.writeback|opts\.snapshot|args\.writeback/)
  const l5 = (file) => {
    const lines = fs.readFileSync(path.join(WF_DIR, file), 'utf8').split('\n')
    const s = lines.findIndex((l) => l.startsWith('// Reads budget.spent() defensively'))
    const e = lines.findIndex((l, i) => i > s && l.startsWith('// The entire pre-existing workflow body'))
    assert.ok(s >= 0 && e > s, `${file}: L5 markers`)
    return lines.slice(s, e).join('\n')
  }
  assert.equal(l5('plan-cycle.js'), l5('tdd-task.js'))
  assert.equal(l5('plan-cycle.js'), l5('review-cycle.js'))
})

test('plan-cycle T8 static: the workflow cites T8 and the 2026-10-13 incident, and the README lists the new lib', () => {
  const src = fs.readFileSync(WF, 'utf8')
  assert.match(src, /T8/)
  assert.match(src, /2026-10-13/)
  assert.ok(fs.existsSync(path.join(WF_DIR, 'lib', 'spec-writeback.mjs')), 'the library exists')
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8'), /spec-writeback\.mjs/)
})

// ======================================================================
// Review round 1 of PR #18 (wf_9f8826b4-bcb). F3 (Medium): the `..` and `.claude` rejections were untested. F4 (Low,
// security): the spec path and the surviving ids reached shell commands unvalidated. F5 (Low): branches without pins.
// ======================================================================
test('plan-cycle T8 (F3): a snapshot file path with a .. segment or a .claude segment under a temp prefix is rejected', async () => {
  for (const file of ['/tmp/../tmp/harn-specwb-x/spec.snapshot', '/tmp/.claude/harn-specwb-x/spec.snapshot']) {
    const { result } = await go(agents({ snapshot: json({ ...BEFORE, file }) }))
    assert.equal(result.telemetry.outcome, 'aborted', file)
    assert.equal(result.writeback, null, file)
  }
})

test('plan-cycle T8 (F4): a spec path with a space, a quote or a command substitution is refused before any agent runs', async () => {
  for (const spec of ['specs/a b.md', "specs/a'b.md", 'specs/a$(touch PWNED).md', 'specs/../x.md']) {
    await assert.rejects(runWorkflow(WF, { args: { spec }, agent: agents() }), /refuses args\.spec/, spec)
  }
})

test('plan-cycle T8 (F4): a surviving id outside the AC pattern aborts the run with writeback null, even when the check says ok', async () => {
  // Round 3 F5: the check echoes the hostile list itself, so only the pattern guard can abort the run.
  for (const surviving of [['AC-SEC-1', "x'; touch PWNED; '"], ['AC-SEC-1', 'AC-sec-1'], ['AC-SEC-1', 'AC-QA-1 && touch PWNED']]) {
    const { result } = await go(agents({ surviving, check: json({ ...CHECK_OK, surviving_ids_checked: surviving }) }))
    assert.equal(result.telemetry.outcome, 'aborted', JSON.stringify(surviving))
    assert.equal(result.writeback, null)
  }
})

test('plan-cycle T8 (F5): ok true with a non-empty problems list is malformed, so the run is aborted with writeback null', async () => {
  const { result } = await go(agents({ check: json({ ...CHECK_OK, problems: ['x'] }) }))
  assert.equal(result.telemetry.outcome, 'aborted')
  assert.equal(result.writeback, null)
})

test('plan-cycle T8 (F5): ok false with restored false says NOT confirmed restored in the report', async () => {
  const { result } = await go(agents({ check: json({ ...CHECK_BAD, restored: false }) }))
  assert.equal(result.telemetry.outcome, 'aborted')
  assert.match(result.report, /NOT confirmed restored/)
  assert.equal(result.writeback.restored, false)
})

test('plan-cycle T8 (F5): a missing writeback_check puts WRITE-BACK UNCHECKED in the report', async () => {
  const { result } = await go(agents({ check: undefined }))
  assert.match(result.report, /WRITE-BACK UNCHECKED/)
  assert.doesNotMatch(result.report, /WRITE-BACK SKIPPED/)
})

// Round 3 F6: a run with no restorable snapshot never edited the spec; it says so, distinctly, and names the allowlist.
test('plan-cycle T8 (round 3 F6): a missing or rejected spec_snapshot puts WRITE-BACK SKIPPED, naming the temp allowlist, never UNCHECKED', async () => {
  for (const snapshot of [undefined, json({ ...BEFORE, file: '/run/user/1000/harn-specwb-x/spec.snapshot' })]) {
    const { result } = await go(agents({ snapshot }))
    assert.equal(result.telemetry.outcome, 'aborted')
    assert.match(result.report, /WRITE-BACK SKIPPED/)
    assert.match(result.report, /temp allowlist: \/tmp, \/private\/tmp, \/var\/folders/)
    assert.doesNotMatch(result.report, /WRITE-BACK UNCHECKED/)
  }
})

// Round 3 F4: the verify instruction reads cleanly; the stray "Then run exactly" before "first write" is gone.
test('plan-cycle T8 (round 3 F4): the synthesis verify instruction is not garbled and asks for a full stop on each criterion', async () => {
  const { calls } = await go(agents())
  const p = calls.find((c) => c.opts.label === 'synthesis:write-back').prompt
  assert.doesNotMatch(p, /run exactly first write/i)
  assert.match(p, /First write the AC ids you kept/)
  assert.match(p, /each on one line and ending in a full stop/)
})

test('plan-cycle T8 (F5): without a restorable snapshot the synthesis prompt forbids the edit and names no verify command', async () => {
  const { calls } = await go(agents({ snapshot: undefined }))
  const p = calls.find((c) => c.opts.label === 'synthesis:write-back').prompt
  assert.match(p, /do NOT edit the spec/)
  assert.doesNotMatch(p, /spec-writeback\.mjs> verify/)
})

// ======================================================================
// Review round 2 of PR #18 (wf_f89fed92-3b7). M1: the ids travel in a file the script names, and the check is tied
// to the ids the agent returned.
// ======================================================================
test('plan-cycle T8 (M1): the verify command carries no agent-typed ids; the ids file sits beside the snapshot and is written with the file tool', async () => {
  const { calls } = await go(agents())
  const p = calls.find((c) => c.opts.label === 'synthesis:write-back').prompt
  assert.doesNotMatch(p, /<surviving_ids as a JSON array>/)
  // CodeQL js/useless-regexp-character-escape on the first form (a `\.` inside a template literal is a bare `.`):
  // the expected command is pinned as an exact substring instead of a regex.
  assert.ok(p.includes(`verify ${SPEC} ${SNAP_FILE} /tmp/harn-specwb-AbC123/surviving.json`), 'the verify command names the spec, the snapshot file and the script-composed ids file')
  assert.match(p, /write the AC ids you kept[^.]*into the file \/tmp\/harn-specwb-AbC123\/surviving\.json with your file-writing tool/)
  assert.match(p, /never via a shell command/)
})

test('plan-cycle T8 (M1): a check whose echoed ids differ from the returned surviving_ids is aborted with writeback null', async () => {
  for (const checked of [['AC-SEC-1'], ['AC-SEC-1', 'AC-QA-1', 'AC-QA-2'], undefined, 'AC-SEC-1']) {
    const { result } = await go(agents({ check: json({ ...CHECK_OK, surviving_ids_checked: checked }) }))
    assert.equal(result.telemetry.outcome, 'aborted', JSON.stringify(checked))
    assert.equal(result.writeback, null, JSON.stringify(checked))
  }
  const same = await go(agents({ check: json({ ...CHECK_OK, surviving_ids_checked: ['AC-QA-1', 'AC-SEC-1', 'AC-SEC-1'] }) }))
  assert.equal(same.result.telemetry.outcome, 'done', 'order and duplicates do not matter; the set does')
})
