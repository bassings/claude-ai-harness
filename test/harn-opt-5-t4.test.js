// HARN-OPT-5 T4 (specs/harn-opt-5.md): review-cycle gives each lens a private
// scratch root and compares the main checkout before and after the lens phase.
// Written RED first. Pins AC-SEC-11, AC-SEC-12, AC-QA-26, AC-QA-27, AC-SIMP-9,
// AC-SIMP-3, AC-SIMP-1, AC-OPS-17.
//
// Names this file fixes (the spec fixes behaviour, not field names):
//   scope:diff response   .scratch_root      absolute string from `mktemp -d`
//                         .snapshot_before   { status: string[], workflow_files: [{path, sha256}] }
//                         (status = lines of `git status --porcelain --untracked-files=all --ignored`;
//                          workflow_files = files under ~/.claude/workflows/ with sha256)
//   synthesis response    .snapshot_after    same shape as snapshot_before
//   workflow result       .stray_writes      array of { path, shadows_installed_workflow: boolean }
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
const BEFORE = {
  status: ['?? notes/preexisting.txt', ' M README.md'],
  workflow_files: [{ path: '/home/u/.claude/workflows/review-cycle.js', sha256: 'aa'.repeat(32) }],
}
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
  assert.match(p, /git status --porcelain --untracked-files=all --ignored/)
  assert.match(p, /sha256/)
  assert.match(p, /~\/\.claude\/workflows/)
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
const afterWith = (extraStatus, extraFiles = []) => ({
  synthesis: { ...SYNTH, snapshot_after: { status: [...BEFORE.status, ...extraStatus], workflow_files: [...BEFORE.workflow_files, ...extraFiles] } },
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
  const changed = [{ path: '/home/u/.claude/workflows/planted.js', sha256: 'bb'.repeat(32) }]
  const r = await review({}, { ...withScratch(), ...afterWith([], changed) })
  assert.deepEqual(strays(r).map((s) => s.path), ['/home/u/.claude/workflows/planted.js'])
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
  assert.match(p, /git status --porcelain --untracked-files=all --ignored/)
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
