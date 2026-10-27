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
const CHECK_OK = { ok: true, problems: [], restored: false, spec_sha256: OTHER_SHA, snapshot_sha256: SHA }
const CHECK_BAD = {
  ok: false, problems: ['duplicate heading: ## Problem (2 times)', 'criterion line ends mid-sentence: AC-QA-1'],
  restored: true, spec_sha256_after_restore: SHA, snapshot_sha256: SHA,
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
