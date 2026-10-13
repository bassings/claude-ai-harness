// HARN-OPT-5 T4 (specs/harn-opt-5.md): review-cycle gives each lens a private
// scratch root and compares the main checkout before and after the lens phase.
// Written RED first. Pins AC-SEC-11, AC-SEC-12, AC-QA-26, AC-QA-27, AC-SIMP-9,
// AC-SIMP-3, AC-SIMP-1, AC-OPS-17.
//
// Fix round 2 (re-frame, owner decision after the circuit-breaker): the snapshot is COMPUTED
// by workflows/lib/stray-snapshot.mjs (tested in test/stray-snapshot.test.js) and the agents
// only relay its stdout, so snapshot_before / snapshot_after are now JSON TEXT (type string)
// that the script parses. Round 1 tests that pinned the old agent-transcribed contract
// (a git status command with a pathspec, string status lines, a hashed-set wording in the
// prompt) are updated to that contract below, each saying why; none is deleted.
//
// Names this file fixes (the spec fixes behaviour, not field names):
//   scope:diff response   .scratch_root      absolute string from `mktemp -d`
//                         .snapshot_before   string: the library's stdout JSON,
//                           { status: [{path, xy}], files: [{path, sha256}], retained_worktrees: [path], dropped: [path] }
//                           (files under ~/.claude/ are written '~/.claude/...', repo files repo-relative)
//   synthesis response    .snapshot_after    same
//   workflow result       .stray_writes      array of { path, change, shadows_installed_workflow: boolean }, or null
// All three response fields are optional so an older agent response validates.
// Never touches the real ledger: the fake runtime stubs every agent().
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { runWorkflow } = require('./helpers/fake-runtime.js')

const ROOT = path.join(__dirname, '..')
const WF = path.join(ROOT, 'workflows', 'review-cycle.js')
const SPEC = path.join(ROOT, 'specs', 'harn-opt-5.md')
const SRC = fs.readFileSync(WF, 'utf8')

const LEDGER_OK = { run_id: 'r1', ts: '2026-10-13T00:00:00.000Z', write_ok: true, write_error: null }
const LEDGER_FAIL = { write_ok: false, write_error: 'disk full', run_id: null }
const SHA = 'abcdef1234567890'
const TREE = '1111111111111111111111111111111111111111'
const SCOPE_OK = {
  base: 'main', head_sha: SHA, head_tree: TREE,
  files: [{ path: 'src/foo.js', status: 'M' }],
  new_dependency_entries: false, new_modules: false, custom_rules: null, harness_triggers_file_exists: false,
  consistency: {
    ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9,
    doc_fields: ['recurrence'], agent_fields: ['recurrence'],
    missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null,
  },
}
const CLEAN = { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [], head_sha_measured: SHA, head_tree_measured: TREE }
const SYNTH = { report: '### VERDICT\nCLEAN', spec_bugs: [], rejected_findings: [] }
function agents(overrides = {}) {
  return {
    'scope:diff': SCOPE_OK,
    'lens-security': CLEAN, 'lens-qa': CLEAN, 'lens-design': CLEAN, 'lens-accessibility': CLEAN, 'lens-product': CLEAN,
    'lens-architecture': CLEAN, 'lens-data': CLEAN, 'lens-operability': CLEAN, 'reviewer-verification': CLEAN,
    synthesis: SYNTH,
    'ledger:write': LEDGER_OK,
    ...overrides,
  }
}
async function review(args, overrides) {
  const { result, calls } = await runWorkflow(WF, { args, agent: agents(overrides) })
  return { result, calls }
}
const promptOf = (calls, label) => {
  const c = calls.find((x) => x.opts.label === label)
  assert.ok(c, `no agent call labelled ${label}; got ${calls.map((x) => x.opts.label).join(', ')}`)
  return c.prompt
}

const SCRATCH = '/var/folders/zz/harn-run-Xk39aB'
const WFPATH = '.claude/workflows/optimise-cycle.js'
// mk: the library's stdout as the agent relays it (a JSON string). Status entries are written
// 'XY path' here for readability and become {path, xy}, exactly what the library computes.
const mk = (status = [], files = [], extra = {}) => JSON.stringify({
  status: status.map((e) => (typeof e === 'string' ? { xy: e.slice(0, 2), path: e.slice(3) } : e)),
  files, retained_worktrees: [], dropped: [], ...extra,
})
const BEFORE_STATUS = ['?? notes/preexisting.txt', ' M README.md']
const BEFORE_FILES = [{ path: '~/.claude/workflows/review-cycle.js', sha256: 'aa'.repeat(32) }]
const BEFORE = mk(BEFORE_STATUS, BEFORE_FILES)
const withScratch = (extra = {}) => ({ 'scope:diff': { ...SCOPE_OK, scratch_root: SCRATCH, snapshot_before: BEFORE, ...extra } })

// ---- (1) AC-SEC-11, AC-QA-26: per-lens scratch root in the lens prompt ----

test('T4 scratch: each lens prompt names <scratch_root>/<lens>, and two lenses name different roots', async () => {
  const { calls } = await review({}, withScratch())
  const sec = promptOf(calls, 'lens-security')
  const qa = promptOf(calls, 'lens-qa')
  // Conductor, after the build: the delete instruction also carries the path,
  // so a bare includes() passed with the lens segment dropped from the root
  // statement. Pin the statement itself.
  assert.ok(sec.includes(`Your private scratch root is ${SCRATCH}/lens-security`), 'lens-security prompt must state its own root')
  assert.ok(qa.includes(`Your private scratch root is ${SCRATCH}/lens-qa`), 'lens-qa prompt must state its own root')
  assert.ok(!sec.includes(`${SCRATCH}/lens-qa`), "lens-security must not be told lens-qa's root")
  assert.ok(!qa.includes(`${SCRATCH}/lens-security`), "lens-qa must not be told lens-security's root")
})

test('T4 scratch: the scope:diff prompt asks for a mktemp -d root outside every git working tree', async () => {
  const { calls } = await review({}, withScratch())
  const p = promptOf(calls, 'scope:diff')
  assert.match(p, /mktemp -d/)
  assert.match(p, /scratch_root/)
  assert.match(p, /snapshot_before/)
  // Round 2 re-frame: the agent no longer transcribes a git status listing or hashes; it runs the library.
  assert.match(p, /stray-snapshot\.mjs/)
  // Round 2 L1/L2 (AC-SEC-11): the primary root's template carries its random suffix, pinned whole.
  assert.ok(p.includes('mktemp -d "${TMPDIR:-/tmp}/harn-review-XXXXXX"'), 'primary mktemp template must be exactly harn-review-XXXXXX')
})

test('T4 scratch: the lens prompt forbids writes to all four named locations', async () => {
  const { calls } = await review({}, withScratch())
  const p = promptOf(calls, 'lens-qa')
  const prohibition = (loc) => new RegExp(`(never|must not|do not)[^\\n]{0,400}${loc}`, 'i').test(p)
  assert.ok(prohibition('main checkout'), 'main checkout not forbidden')
  assert.ok(prohibition('worktree other than your own|other worktree|any worktree'), 'other worktrees not forbidden')
  assert.ok(prohibition('\\.claude/'), 'repo .claude/ directories not forbidden')
  assert.ok(prohibition('~/\\.claude/'), '~/.claude/ not forbidden')
})

test('T4 scratch: mutation experiments in the lens\'s own isolated worktree stay licensed', async () => {
  const { calls } = await review({}, withScratch())
  assert.match(promptOf(calls, 'lens-qa'), /mutation experiments[^.]*\)?[^.]*safe[^.]*|isolated[^.]*mutation experiments/i)
})

test('T4 scratch: no fixed shared directory, no bare tip/', async () => {
  const { calls } = await review({}, withScratch())
  for (const l of ['lens-qa', 'lens-security']) {
    const p = promptOf(calls, l)
    assert.doesNotMatch(p, /\btip\//, `${l}: bare tip/`)
    assert.doesNotMatch(p, /[`'"]tip[`'"]/, `${l}: quoted tip directory`)
  }
})

test('T4 scratch: any rm instruction targets only the lens\'s own root', async () => {
  const { calls } = await review({}, withScratch())
  const p = promptOf(calls, 'lens-qa')
  assert.ok(p.includes(`${SCRATCH}/lens-qa`), 'own root must be named for a delete target to be checkable')
  for (const m of p.matchAll(/\brm\s+(?:-\w+\s+)*["']?([^\s"'`]+)/g)) {
    assert.equal(m[1].replace(/\/+$/, ''), `${SCRATCH}/lens-qa`, `rm target ${m[1]} is not the lens's own root`)
  }
})

test('T4 scratch: startRunId null (failed start write) puts neither null nor unknown in any root', async () => {
  const { calls } = await review({}, { ...withScratch(), 'ledger:write': LEDGER_FAIL })
  const p = promptOf(calls, 'lens-qa')
  assert.ok(p.includes(`${SCRATCH}/lens-qa`))
  for (const line of p.split('\n').filter((l) => l.includes(SCRATCH) || /mktemp/.test(l))) {
    assert.doesNotMatch(line, /\b(null|unknown|undefined)\b/i, `root line carries a placeholder: ${line}`)
  }
})

for (const [name, bad] of [
  ['missing', {}],
  ['relative', { scratch_root: 'tmp/scratch' }],
  ['under a repo .claude/ directory', { scratch_root: '/work/repo/.claude/worktrees/x/scratch' }],
]) {
  test(`T4 fallback (${name}): the lens is told to mktemp -d its own root with a template carrying its name`, async () => {
    const { calls } = await review({}, { 'scope:diff': { ...SCOPE_OK, snapshot_before: BEFORE, ...bad } })
    for (const l of ['lens-qa', 'lens-security']) {
      const p = promptOf(calls, l)
      assert.match(p, new RegExp(`mktemp -d[^\\n]*${l}[^\\n]*XXXXXX`), `${l}: mktemp template must carry the lens name and a random suffix`)
      assert.doesNotMatch(p, /tmp\/scratch\/lens-/, 'a relative root must not be used')
      assert.doesNotMatch(p, /\.claude\/worktrees\/x\/scratch/, 'a root under .claude/ must not be used')
      for (const line of p.split('\n').filter((x) => /mktemp/.test(x))) assert.doesNotMatch(line, /\b(null|unknown)\b/i)
    }
  })
}

// ---- (2) AC-SEC-12, AC-QA-27: deterministic before/after comparison ----

const strays = (r) => {
  assert.ok(Array.isArray(r.result.stray_writes), 'result.stray_writes must be an array')
  return r.result.stray_writes
}
const afterWith = (extraStatus, extraFiles = [], extra = {}) => ({
  synthesis: { ...SYNTH, snapshot_after: mk([...BEFORE_STATUS, ...extraStatus], [...BEFORE_FILES, ...extraFiles], extra) },
})

test('T4 stray: an after-snapshot that gains ?? .claude/workflows/optimise-cycle.js names the path with the shadow warning', async () => {
  const r = await review({}, { ...withScratch(), ...afterWith([`?? ${WFPATH}`]) })
  assert.ok(Array.isArray(strays(r)), 'stray_writes must be an array')
  assert.equal(strays(r).length, 1)
  assert.equal(strays(r)[0].path, WFPATH)
  assert.equal(strays(r)[0].shadows_installed_workflow, true)
  const line = r.result.report.split('\n').find((l) => l.includes(WFPATH))
  assert.ok(line, `report must have a line naming ${WFPATH}`)
  assert.match(line, /shadow/i)
  assert.equal(r.result.report.split(WFPATH).length - 1, 1, 'surfaced once per run')
})

test('T4 stray: an ordinary new path is reported without the shadow warning', async () => {
  const r = await review({}, { ...withScratch(), ...afterWith(['?? scratch/leftover.txt']) })
  assert.deepEqual(strays(r).map((s) => s.path), ['scratch/leftover.txt'])
  assert.equal(strays(r)[0].shadows_installed_workflow, false)
  assert.doesNotMatch(r.result.report.split('\n').find((l) => l.includes('scratch/leftover.txt')), /shadow/i)
})

test('T4 stray: a changed file under ~/.claude/workflows/ is reported by path', async () => {
  const changed = [{ path: '~/.claude/workflows/planted.js', sha256: 'bb'.repeat(32) }]
  const r = await review({}, { ...withScratch(), ...afterWith([], changed) })
  assert.deepEqual(strays(r).map((s) => s.path), ['~/.claude/workflows/planted.js'])
})

test('T4 stray: identical snapshots produce no stray_writes and no stray-write report line', async () => {
  const r = await review({}, { ...withScratch(), ...afterWith([]) })
  assert.deepEqual(strays(r), [])
  assert.doesNotMatch(r.result.report, /stray|could not be made/i)
})

test('T4 stray: a pre-existing untracked file present in both snapshots is not reported', async () => {
  const r = await review({}, { ...withScratch(), ...afterWith([`?? ${WFPATH}`]) })
  assert.ok(!strays(r).some((s) => s.path === 'notes/preexisting.txt'))
  assert.ok(!r.result.report.includes('notes/preexisting.txt'))
})

test('T4 stray: a snapshot missing from either step reports that the comparison could not be made, never a silent clean', async () => {
  for (const [name, o] of [
    ['no before', { 'scope:diff': { ...SCOPE_OK, scratch_root: SCRATCH }, ...afterWith([]) }],
    ['no after', withScratch()],
    ['neither', {}],
  ]) {
    const r = await review({}, o)
    assert.match(r.result.report, /could not be made/i, `${name}: report must say the comparison could not be made`)
  }
})

test('T4 stray: nothing is deleted, moved or overwritten (no new agent call, no mutation wording in the synthesis ask)', async () => {
  const { calls } = await review({}, { ...withScratch(), ...afterWith([`?? ${WFPATH}`]) })
  const p = promptOf(calls, 'synthesis')
  assert.match(p, /snapshot_after/)
  assert.match(p, /stray-snapshot\.mjs/)  // round 2: the library, not a transcribed git status
  assert.doesNotMatch(p, /\b(rm|mv)\s+[^\n]*\.claude\/workflows/)
})

// ---- (3) AC-SIMP-9, AC-SIMP-3, AC-SIMP-1, ledger payload, schemas ----

test('T4 simp: review-cycle.js keeps exactly four `await agent(` sites (AC-SIMP-9)', () => {
  assert.equal((SRC.match(/await agent\(/g) || []).length, 4)
})

test('T4 simp: meta.whenToUse is unchanged, so no new workflow argument (AC-SIMP-3)', () => {
  const m = /whenToUse:\s*'((?:[^'\\]|\\.)*)'/.exec(SRC)
  assert.ok(m, 'whenToUse literal not found')
  assert.equal(crypto.createHash('sha256').update(m[1]).digest('hex'), '8dfdf7b4ed2aa9e4412a206f02aff78f244560b953e3d3539a9e9e162a06dfb0')
})

test('T4 simp: no new import or dependency in review-cycle.js (AC-SIMP-1)', () => {
  assert.doesNotMatch(SRC, /^\s*(import\s.+from|.*\brequire\()/m)
})

test('T4 ledger: the ledger payloads gain no scratch or snapshot or stray field', async () => {
  const { calls } = await review({}, { ...withScratch(), ...afterWith([`?? ${WFPATH}`]) })
  for (const c of calls.filter((x) => x.opts.label === 'ledger:write')) {
    assert.doesNotMatch(c.prompt, /stray_writes|scratch_root|snapshot_before|snapshot_after/)
  }
})

test('T4 schema: scratch_root, snapshot_before and snapshot_after are declared and optional', async () => {
  const { calls } = await review({}, withScratch())
  const scope = calls.find((c) => c.opts.label === 'scope:diff').opts.schema
  const syn = calls.find((c) => c.opts.label === 'synthesis').opts.schema
  assert.ok(scope.properties.scratch_root, 'scope schema must declare scratch_root')
  assert.ok(scope.properties.snapshot_before, 'scope schema must declare snapshot_before')
  assert.ok(syn.properties.snapshot_after, 'synthesis schema must declare snapshot_after')
  // Round 2: the snapshot is the library's stdout relayed verbatim, so it is JSON TEXT the script parses.
  assert.equal(scope.properties.snapshot_before.type, 'string')
  assert.equal(syn.properties.snapshot_after.type, 'string')
  for (const k of ['scratch_root', 'snapshot_before']) assert.ok(!scope.required.includes(k), `${k} must be optional`)
  assert.ok(!syn.required.includes('snapshot_after'), 'snapshot_after must be optional')
})

// ---- (4) AC-OPS-17: the spec row says what is true ----

test('T4 spec: the "What this replaces" tip/ row says the name existed nowhere in source and removal is satisfied by the per-lens root', () => {
  const row = fs.readFileSync(SPEC, 'utf8').split('\n').find((l) => l.startsWith('|') && l.includes('`tip/`'))
  assert.ok(row, 'row naming `tip/` not found')
  assert.match(row, /nowhere in (the )?source/i)
  assert.match(row, /per-lens (scratch )?root/i)
})

// ======================================================================
// Fix round 1 (PR #14 review: security and qa). Names fixed here:
//   stray_writes entries gain  change: 'added' | 'removed' | 'changed'
//   stray_writes            null when either snapshot is missing (unchecked), [] when checked clean
//   scope:diff response     .tmpdir  optional string, the TMPDIR the scope step saw (L2)
//   repo-local workflow files ride in files[] with repo-relative paths (.claude/workflows/x.js)
// ======================================================================
const HOME = '~/.claude'
const LOCAL_WF = '.claude/workflows/review-cycle.js'
const afterOf = (status, files, extra) => ({ synthesis: { ...SYNTH, snapshot_after: mk(status, files, extra) } })
const beforeOf = (status, files, extra) => withScratch({ snapshot_before: mk(status, files, extra) })
const H = (c) => c.repeat(64)

// ---- M1 (AC-SEC-12, AC-QA-27): removals and content changes are visible ----

test('T4 r1 M1: a before-only status line is reported as removed', async () => {
  const r = await review({}, { ...beforeOf(['?? .claude/hooks/guard.sh', ' M README.md'], []), ...afterOf([' M README.md'], []) })
  const s = strays(r)
  assert.equal(s.length, 1)
  assert.equal(s[0].path, '.claude/hooks/guard.sh')
  assert.equal(s[0].change, 'removed')
  assert.match(r.result.report.split('\n').find((l) => l.includes('guard.sh')), /removed/i)
})

test('T4 r1 M1: a before-only hashed file is reported as removed', async () => {
  const f = { path: `${HOME}/workflows/review-cycle.js`, sha256: H('a') }
  const r = await review({}, { ...beforeOf([], [f]), ...afterOf([], []) })
  const s = strays(r)
  assert.deepEqual(s.map((x) => [x.path, x.change]), [[f.path, 'removed']])
})

test('T4 r1 M1: a repo-local workflow whose hash changed (pre-existing, same status line) is reported changed with the shadow warning', async () => {
  const st = [`?? ${LOCAL_WF}`]
  const r = await review({}, {
    ...beforeOf(st, [{ path: LOCAL_WF, sha256: H('a') }]),
    ...afterOf(st, [{ path: LOCAL_WF, sha256: H('b') }]),
  })
  const s = strays(r)
  assert.equal(s.length, 1)
  assert.equal(s[0].path, LOCAL_WF)
  assert.equal(s[0].change, 'changed')
  assert.equal(s[0].shadows_installed_workflow, true)
  assert.match(r.result.report.split('\n').find((l) => l.includes(LOCAL_WF)), /shadow/i)
})

test('T4 r1 M1: an unchanged repo-local workflow hash is not reported', async () => {
  const st = [`?? ${LOCAL_WF}`]
  const f = [{ path: LOCAL_WF, sha256: H('a') }]
  const r = await review({}, { ...beforeOf(st, f), ...afterOf(st, f) })
  assert.deepEqual(strays(r), [])
})

// Round 2 re-frame: the hashed set is computed by the library (test/stray-snapshot.test.js), so the
// round 1 test that pinned the prompt wording of the repo .claude/workflows/ hash ask is replaced by
// the library-command contract in the round 2 block at the end of this file.

// ---- L3 (folded into M1): the hashed set under ~/.claude/ ----

// (round 2: the prompt-wording test for the widened ~/.claude/ set moved to the library tests; see above.)

test('T4 r1 L3: a changed ~/.claude/settings.json and a new ~/.claude/agents file are reported by path', async () => {
  const s0 = { path: `${HOME}/settings.json`, sha256: H('a') }
  const r = await review({}, {
    ...beforeOf([], [s0]),
    ...afterOf([], [{ ...s0, sha256: H('b') }, { path: `${HOME}/agents/x.md`, sha256: H('c') }]),
  })
  assert.deepEqual(strays(r).map((x) => [x.path, x.change]).sort(), [[`${HOME}/agents/x.md`, 'added'], [s0.path, 'changed']].sort())
})

// ---- M2 (AC-QA-27): harness-owned and transient paths are not stray writes ----

test('T4 r1 M2 (round 2: library fields): a retained lens worktree is listed on its own line, never as a stray write', async () => {
  const r = await review({}, { ...beforeOf([], []), ...afterOf([], [], { retained_worktrees: ['.claude/worktrees/wf_x'] }) })
  assert.deepEqual(strays(r), [])
  const line = r.result.report.split('\n').find((l) => /lens worktree retained/i.test(l))
  assert.ok(line, 'report must carry a "lens worktree retained" line')
  assert.ok(line.includes('.claude/worktrees/wf_x'))
})

test('T4 r1 M2 (round 2: library fields): dropped paths (scheduled_tasks) are not stray writes and are not mentioned', async () => {
  const r = await review({}, { ...beforeOf([], []), ...afterOf([], [], { dropped: ['.claude/scheduled_tasks.lock', '.claude/scheduled_tasks.json'] }) })
  assert.deepEqual(strays(r), [])
  assert.doesNotMatch(r.result.report, /scheduled_tasks/)
})

test('T4 r1 M2: a real stray alongside retained and dropped paths is still reported', async () => {
  const r = await review({}, { ...beforeOf([], []), ...afterOf([`?? ${WFPATH}`], [], { retained_worktrees: ['.claude/worktrees/wf_x'], dropped: ['.claude/scheduled_tasks.lock'] }) })
  assert.deepEqual(strays(r).map((s) => s.path), [WFPATH])
})

// Round 2 L2 (AC-QA-27): the lens-worktree filter moved into the library and is anchored there; the script
// itself must not swallow a look-alike. src/worktrees/planted.js is a stray, not a retained worktree.
test('T4 r2 L2: ?? src/worktrees/planted.js stays a stray (the worktree filter is anchored)', async () => {
  const r = await review({}, { ...beforeOf([], []), ...afterOf(['?? src/worktrees/planted.js'], []) })
  assert.deepEqual(strays(r).map((s) => [s.path, s.change]), [['src/worktrees/planted.js', 'added']])
  assert.doesNotMatch(r.result.report, /lens worktree retained/i)
})

// (round 2: the round 1 test that pinned the narrowed git status pathspec in the prompt is replaced by the
// library-command contract in the round 2 block, because the narrowing is what blinded the snapshot, M1.)

// ---- L1 (AC-SEC-12): unchecked is distinguishable from checked-clean ----

test('T4 r1 L1: stray_writes is null when the before snapshot is missing', async () => {
  const r = await review({}, { 'scope:diff': { ...SCOPE_OK, scratch_root: SCRATCH }, ...afterWith([]) })
  assert.equal(r.result.stray_writes, null)
  assert.match(r.result.report, /could not be made/i)
})
test('T4 r1 L1: stray_writes is null when the after snapshot is missing', async () => {
  const r = await review({}, withScratch())
  assert.equal(r.result.stray_writes, null)
})
test('T4 r1 L1: stray_writes is null when neither snapshot exists', async () => {
  const r = await review({}, {})
  assert.equal(r.result.stray_writes, null)
})
test('T4 r1 L1: checked-clean is still an empty array, not null', async () => {
  const r = await review({}, { ...withScratch(), ...afterWith([]) })
  assert.deepEqual(r.result.stray_writes, [])
})
test('T4 r1 L1: the could-not-be-made sentence survives a failed synthesis (reportOk false)', async () => {
  const r = await review({}, { ...withScratch(), synthesis: { ...SYNTH, report: '' } })
  assert.equal(r.result.stray_writes, null)
  assert.match(r.result.report, /could not be made/i)
})

// ---- L2 (AC-SEC-11, AC-QA-26): the scratch base must be under a temp prefix ----

for (const bad of ['/tmp/a/../repo/x', '/Users/x/repos/proj/scratch', '/home/u/work/tree', '/tmpfoo/x', '/private/tmpx/y']) {
  test(`T4 r1 L2: scratch_root ${bad} falls back to the per-lens mktemp clause`, async () => {
    const { calls } = await review({}, { 'scope:diff': { ...SCOPE_OK, snapshot_before: BEFORE, scratch_root: bad } })
    const p = promptOf(calls, 'lens-qa')
    assert.match(p, /mktemp -d[^\n]*lens-qa[^\n]*XXXXXX/)
    assert.ok(!p.includes(`${bad}/lens-qa`), 'rejected base must not be used as a root')
  })
}
for (const ok of ['/tmp/harn-review-aB3', '/private/tmp/harn-review-aB3', '/var/folders/zz/T/harn-review-aB3', '/private/var/folders/zz/T/harn-review-aB3']) {
  test(`T4 r1 L2: scratch_root ${ok} under a known temp prefix is used`, async () => {
    const { calls } = await review({}, withScratch({ scratch_root: ok }))
    assert.ok(promptOf(calls, 'lens-qa').includes(`Your private scratch root is ${ok}/lens-qa`))
  })
}
test('T4 r1 L2: a scratch_root under the TMPDIR the scope step passed through is used; the same path without tmpdir is not', async () => {
  const root = '/data/scratchvol/harn-review-aB3'
  let r = await review({}, withScratch({ scratch_root: root, tmpdir: '/data/scratchvol' }))
  assert.ok(promptOf(r.calls, 'lens-qa').includes(`Your private scratch root is ${root}/lens-qa`))
  r = await review({}, withScratch({ scratch_root: root }))
  assert.match(promptOf(r.calls, 'lens-qa'), /mktemp -d[^\n]*lens-qa[^\n]*XXXXXX/)
})
test('T4 r1 L2: a tmpdir of / or a relative path does not widen the allowed prefixes', async () => {
  for (const tmpdir of ['/', 'relative/tmp']) {
    const { calls } = await review({}, withScratch({ scratch_root: '/Users/x/repos/proj/scratch', tmpdir }))
    assert.match(promptOf(calls, 'lens-qa'), /mktemp -d[^\n]*lens-qa[^\n]*XXXXXX/, `tmpdir ${tmpdir}`)
  }
})

// ---- L4 (AC-QA-27), round 2: renames and quoting are resolved by the library (-z, target path), so the
// script receives plain paths. The shadow test must still fire on them. ----

test('T4 r1 L4 (round 2): a renamed-in entry (xy R ) at .claude/workflows/ is reported at the target with the shadow warning', async () => {
  const r = await review({}, { ...beforeOf([], []), ...afterOf([{ path: WFPATH, xy: 'R ' }], []) })
  const s = strays(r)
  assert.equal(s.length, 1)
  assert.equal(s[0].path, WFPATH)
  assert.equal(s[0].change, 'added')
  assert.equal(s[0].shadows_installed_workflow, true)
})
test('T4 r1 L4 (round 2): a path with a quote and a space is carried verbatim and still shadows', async () => {
  const p = '.claude/workflows/a"b c.js'
  const r = await review({}, { ...beforeOf([], []), ...afterOf([{ path: p, xy: '??' }], []) })
  assert.deepEqual(strays(r).map((s) => [s.path, s.shadows_installed_workflow]), [[p, true]])
})

// ======================================================================
// Fix round 2 (PR #14 review round 2: M1 to M4, L1 to L3). Re-frame: stray-snapshot.mjs computes, agents relay.
// ======================================================================

const has = (r, path_) => strays(r).find((s) => s.path === path_)
const lineOf = (r, needle) => r.result.report.split('\n').find((l) => l.includes(needle))

// ---- M1/M3: change is derived from the XY code of a newly appearing entry ----
for (const [xy, want] of [[' D', 'removed'], ['D ', 'removed'], ['MD', 'removed'], [' M', 'changed'], ['M ', 'changed'], ['??', 'added'], ['!!', 'added'], ['A ', 'added'], ['R ', 'added']]) {
  test(`T4 r2 M3: a newly appearing entry with xy '${xy}' is '${want}'`, async () => {
    const r = await review({}, { ...beforeOf([], []), ...afterOf([{ path: 'src/x.js', xy }], []) })
    assert.deepEqual(strays(r).map((s) => [s.path, s.change]), [['src/x.js', want]])
    assert.match(lineOf(r, 'src/x.js'), new RegExp(`\\(${want}\\)`))
  })
}

test('T4 r2 M1: a tracked .githooks/pre-push modified by a lens (xy " M") is reported changed', async () => {
  const r = await review({}, { ...beforeOf([], []), ...afterOf([' M .githooks/pre-push'], []) })
  assert.deepEqual(strays(r).map((s) => [s.path, s.change]), [['.githooks/pre-push', 'changed']])
})

test('T4 r2 M3: a tracked file deleted by a lens reads removed, never added', async () => {
  const r = await review({}, { ...beforeOf([], []), ...afterOf([' D README.md'], []) })
  const line = lineOf(r, 'README.md')
  assert.match(line, /removed/)
  assert.doesNotMatch(line, /added/)
})

test('T4 r2 M3: the report header says what was hashed and that the review itself removed or restored nothing, and never claims "Nothing was removed"', async () => {
  const r = await review({}, { ...beforeOf([], []), ...afterOf([' D README.md'], []) })
  const rep = r.result.report
  assert.match(rep, /removed or restored nothing/i)
  assert.doesNotMatch(rep, /Nothing was removed/)
  assert.match(rep, /hash/i)
  assert.match(rep, /~\/\.claude\//)
  assert.match(rep, /\.githooks\//)
})

test('T4 r2 M1: a changed ~/.claude/CLAUDE.md and an added bin/ file and an added .claude/hooks/ file are reported from the hashed set', async () => {
  const r = await review({}, {
    ...beforeOf([], [{ path: '~/.claude/CLAUDE.md', sha256: H('a') }]),
    ...afterOf([], [{ path: '~/.claude/CLAUDE.md', sha256: H('b') }, { path: 'bin/tool', sha256: H('c') }, { path: '.claude/hooks/guard.sh', sha256: H('d') }]),
  })
  assert.deepEqual(strays(r).map((x) => [x.path, x.change]).sort(), [['.claude/hooks/guard.sh', 'added'], ['bin/tool', 'added'], ['~/.claude/CLAUDE.md', 'changed']])
})

test('T4 r2: only the repo .claude/workflows/ carries the shadow warning, not ~/.claude/workflows/ and not .claude/hooks/', async () => {
  const r = await review({}, {
    ...beforeOf([], []),
    ...afterOf([], [{ path: '~/.claude/workflows/x.js', sha256: H('a') }, { path: '.claude/hooks/y.sh', sha256: H('b') }, { path: WFPATH, sha256: H('c') }]),
  })
  assert.deepEqual(strays(r).map((x) => [x.path, x.shadows_installed_workflow]).sort(), [[WFPATH, true], ['.claude/hooks/y.sh', false], ['~/.claude/workflows/x.js', false]].sort())
})

test('T4 r2: a pre-existing entry present in both snapshots is not reported, and a before-only entry is removed', async () => {
  const r = await review({}, { ...beforeOf(['?? a.txt', ' M b.txt'], []), ...afterOf(['?? a.txt'], []) })
  assert.deepEqual(strays(r).map((s) => [s.path, s.change]), [['b.txt', 'removed']])
})

// ---- could-not-be-made: missing, non-JSON, wrong shape ----
for (const [name, bad] of [
  ['not JSON', 'git: not a repository'],
  ['JSON but not a snapshot', '[1,2]'],
  ['JSON object without status or files', '{"ok":true}'],
]) {
  for (const side of ['before', 'after']) {
    test(`T4 r2: a ${side} snapshot that is ${name} reads 'could not be made' and stray_writes null`, async () => {
      const o = side === 'before'
        ? { ...withScratch({ snapshot_before: bad }), ...afterWith([]) }
        : { ...withScratch(), synthesis: { ...SYNTH, snapshot_after: bad } }
      const r = await review({}, o)
      assert.equal(r.result.stray_writes, null)
      assert.match(r.result.report, /could not be made/i)
    })
  }
}

// ---- static: both prompts run the library and never ask the agent to list files itself ----
test('T4 r2 static: scope:diff and synthesis run stray-snapshot.mjs exactly, found the way the ledger step finds ledger-append.mjs, and relay stdout verbatim', async () => {
  const { calls } = await review({}, withScratch())
  for (const l of ['scope:diff', 'synthesis']) {
    const p = promptOf(calls, l)
    assert.match(p, /node <path[^>\n]*>\s+"\$\(git rev-parse --show-toplevel\)"/, `${l}: must tell the agent to run node <path> "$(git rev-parse --show-toplevel)"`)
    assert.match(p, /verbatim/i, `${l}: stdout must be relayed verbatim`)
    const a = p.indexOf('~/.claude/workflows/lib/stray-snapshot.mjs')
    assert.ok(a >= 0, `${l}: installed mirror path missing`)
    const b = p.indexOf('plugin', a)
    assert.ok(b > a, `${l}: installed plugin must come after the mirror`)
    assert.ok(p.indexOf('claude-ai-harness', b) > b, `${l}: repo copy only for claude-ai-harness itself, after the plugin`)
    assert.match(p, /NEVER use a repo-local copy in any OTHER repo/, `${l}: repo-local copies in other repos must be forbidden`)
    // the agent must not list or hash anything itself
    assert.doesNotMatch(p, /git status/, `${l}: must not ask the agent to run git status`)
    assert.doesNotMatch(p, /NUL-separated|every file|sha256 of the contents/i, `${l}: must not ask the agent to transcribe a listing`)
  }
})

// ---- AC-SEC-11, AC-QA-26 round 2 L1: the .claude path-component guard must be load-bearing ----
// Each of these passes every other check (known temp prefix, plain characters, no ..), so only the
// .claude segment guard can reject it.
test('T4 r2 L1: /tmp/repo/.claude/scratch is rejected (only the .claude guard can)', async () => {
  const { calls } = await review({}, { 'scope:diff': { ...SCOPE_OK, snapshot_before: BEFORE, scratch_root: '/tmp/repo/.claude/scratch' } })
  const p = promptOf(calls, 'lens-qa')
  assert.match(p, /mktemp -d[^\n]*lens-qa[^\n]*XXXXXX/)
  assert.ok(!p.includes('/tmp/repo/.claude/scratch/lens-qa'))
})
test('T4 r2 L1: a tmpdir of /Users/x/repo/.claude/tmp does not widen the prefixes (only the .claude guard can reject it)', async () => {
  const root = '/Users/x/repo/.claude/tmp/harn-review-aB3'
  const { calls } = await review({}, withScratch({ scratch_root: root, tmpdir: '/Users/x/repo/.claude/tmp' }))
  const p = promptOf(calls, 'lens-qa')
  assert.match(p, /mktemp -d[^\n]*lens-qa[^\n]*XXXXXX/)
  assert.ok(!p.includes(`${root}/lens-qa`))
})
