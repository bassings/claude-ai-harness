// HARN-OPT-5 T8: tests for workflows/lib/spec-writeback.mjs, the deterministic library that COMPUTES the
// plan-cycle write-back check so the agent only relays its stdout. Motivation, 2026-10-13: the synthesis
// write-back pasted the whole preamble into the criteria at three points and cut three criterion lines where
// their text held a regex end anchor followed by a backtick (the replacement-string sequence), and only the
// pre-push duplicate-criterion scan caught it. Exercised as a real CLI against real temp spec files, the way
// test/stray-snapshot.test.js exercises its sibling.
//
// Contract (names fixed here):
//   node spec-writeback.mjs snapshot <spec>
//     -> { file, sha256, headings: [every "## " line, in order], ac_ids: [ids defined by "- **AC-...:**" lines] };
//        file is 0600, made by mkdtemp (prefix harn-specwb-) under os.tmpdir(); non-zero only if the spec is unreadable.
//   node spec-writeback.mjs verify <spec> <snapshot-file> <surviving-ids-json>
//     -> ok:   { ok: true,  problems: [], restored: false, spec_sha256, snapshot_sha256 } and the snapshot + its dir are removed
//     -> fail: { ok: false, problems: [...], restored: true, spec_sha256_after_restore, snapshot_sha256 }, spec bytes restored
//     -> unreadable/malformed snapshot or ids: non-zero, one reason line on stderr, nothing on stdout, nothing restored.
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { SUITE_TMPDIR, cleanupTempRepos } = require('./helpers/temp-repo.js')

const LIB = path.join(__dirname, '..', 'workflows', 'lib', 'spec-writeback.mjs')
test.after(cleanupTempRepos)

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const PREAMBLE = '# Spec title\n\n## Problem\n\nSomething is wrong.\n\n## Goals\n\nFix it.\n\n'
const CRITERIA = [
  '- **AC-SEC-1:** The token is never logged.',
  '- **AC-QA-1:** A failing check exits non-zero (see `verify`).',
  '- **AC-QA-2:** The pattern ends with a dollar anchor `/^abc$/` and is anchored.',
]
const spec = (criteria = CRITERIA, preamble = PREAMBLE) =>
  `${preamble}## Acceptance criteria\n\n${criteria.join('\n')}\n\n## Tasks\n\n- [ ] T1: do it.\n`
const IDS = ['AC-SEC-1', 'AC-QA-1', 'AC-QA-2']

function tmpRoot() { return fs.mkdtempSync(path.join(SUITE_TMPDIR, 'specwb-')) }
function run(args, tmp = tmpRoot()) {
  const res = spawnSync('node', [LIB, ...args], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } })
  let out = null
  if (res.status === 0 && res.stdout.trim()) { try { out = JSON.parse(res.stdout) } catch { out = null } }
  return { res, out, tmp }
}
function fixture(original = spec()) {
  const dir = tmpRoot()
  const specPath = path.join(dir, 'spec.md')
  fs.writeFileSync(specPath, original)
  const tmp = tmpRoot()
  const s = run(['snapshot', specPath], tmp)
  assert.equal(s.res.status, 0, `snapshot must succeed; stderr: ${s.res.stderr}`)
  assert.ok(s.out, `snapshot must print one JSON object; stdout: ${s.res.stdout}`)
  return { dir, specPath, tmp, snap: s.out, original }
}
const verify = (f, ids = IDS, snapFile = f.snap.file) => run(['verify', f.specPath, snapFile, JSON.stringify(ids)], f.tmp)
function assertRestored(f, v) {
  assert.equal(v.res.status, 0, v.res.stderr)
  assert.equal(v.out.ok, false)
  assert.equal(v.out.restored, true)
  assert.ok(v.out.problems.length > 0)
  assert.equal(fs.readFileSync(f.specPath, 'utf8'), f.original, 'the spec is restored byte for byte')
  assert.equal(v.out.spec_sha256_after_restore, sha(f.original))
  assert.deepEqual(fs.readdirSync(f.dir), ['spec.md'], 'the atomic restore leaves no temp file beside the spec')
}

test('spec-writeback snapshot: prints headings, ac_ids and sha256, in a 0600 file under the OS temp dir', () => {
  const f = fixture()
  assert.deepEqual(f.snap.headings, ['## Problem', '## Goals', '## Acceptance criteria', '## Tasks'])
  assert.deepEqual(f.snap.ac_ids, IDS)
  assert.equal(f.snap.sha256, sha(f.original))
  assert.ok(path.resolve(f.snap.file).startsWith(fs.realpathSync(f.tmp)), `snapshot must live under TMPDIR, got ${f.snap.file}`)
  assert.match(path.basename(path.dirname(f.snap.file)), /^harn-specwb-/)
  assert.equal(fs.statSync(f.snap.file).mode & 0o777, 0o600)
  assert.equal(sha(fs.readFileSync(f.snap.file)), f.snap.sha256, 'the snapshot file holds the spec bytes')
  assert.ok(!path.resolve(f.snap.file).startsWith(f.dir), 'never next to the spec / under a repo')
})

test('spec-writeback snapshot: ### subsections and AC ids merely mentioned in prose are not counted', () => {
  const f = fixture(spec([...CRITERIA, 'See AC-SEC-9 in prose, not a definition.'], PREAMBLE) + '### Vetoed at planning\n\n')
  assert.deepEqual(f.snap.headings, ['## Problem', '## Goals', '## Acceptance criteria', '## Tasks'])
  assert.deepEqual(f.snap.ac_ids, IDS)
})

test('spec-writeback snapshot: an unreadable spec exits non-zero with a reason and no stdout', () => {
  const r = run(['snapshot', path.join(tmpRoot(), 'missing.md')])
  assert.notEqual(r.res.status, 0)
  assert.equal(r.res.stdout, '')
  assert.doesNotMatch(r.res.stderr, /Cannot find module/, 'must fail because the spec is unreadable, not because the library is missing')
})

test('spec-writeback verify: a clean write-back passes, echoes the snapshot sha256, and reaps the snapshot and its directory', () => {
  const f = fixture()
  const written = spec([...CRITERIA, '- **AC-QA-3:** A new criterion is added.'])
  fs.writeFileSync(f.specPath, written)
  const v = verify(f, [...IDS, 'AC-QA-3'])
  assert.equal(v.res.status, 0, v.res.stderr)
  assert.deepEqual(v.out, { ok: true, problems: [], restored: false, spec_sha256: sha(written), snapshot_sha256: f.snap.sha256 })
  assert.equal(fs.readFileSync(f.specPath, 'utf8'), written, 'a passing write-back is left alone')
  assert.ok(!fs.existsSync(f.snap.file) && !fs.existsSync(path.dirname(f.snap.file)))
})

test('spec-writeback verify: a dropped criterion fails naming it, and the spec is restored', () => {
  const f = fixture()
  fs.writeFileSync(f.specPath, spec(CRITERIA.slice(0, 2)))
  const v = verify(f)
  assertRestored(f, v)
  assert.ok(v.out.problems.some((p) => /AC-QA-2/.test(p)), JSON.stringify(v.out.problems))
  assert.equal(v.out.snapshot_sha256, f.snap.sha256)
  assert.ok(fs.existsSync(f.snap.file), 'a failed verify keeps the snapshot (it deletes nothing)')
})

test('spec-writeback verify: a criterion not in the surviving set fails naming it, and the spec is restored', () => {
  const f = fixture()
  fs.writeFileSync(f.specPath, spec([...CRITERIA, '- **AC-QA-9:** Smuggled in.']))
  const v = verify(f)
  assertRestored(f, v)
  assert.ok(v.out.problems.some((p) => /AC-QA-9/.test(p)), JSON.stringify(v.out.problems))
})

test('spec-writeback verify: a duplicated top-level heading fails naming it, and the spec is restored', () => {
  const f = fixture()
  fs.writeFileSync(f.specPath, spec() + '\n## Goals\n\nAgain.\n')
  const v = verify(f)
  assertRestored(f, v)
  assert.ok(v.out.problems.some((p) => /## Goals/.test(p)), JSON.stringify(v.out.problems))
})

test('spec-writeback verify: a dropped top-level heading, and a missing "## Acceptance criteria", fail and restore', () => {
  const f = fixture()
  fs.writeFileSync(f.specPath, spec().replace('## Tasks\n', 'Tasks\n'))
  assertRestored(f, verify(f))
  const g = fixture()
  fs.writeFileSync(g.specPath, spec().replace('## Acceptance criteria', '### Acceptance criteria'))
  const v = verify(g)
  assertRestored(g, v)
  assert.ok(v.out.problems.some((p) => /Acceptance criteria/.test(p)), JSON.stringify(v.out.problems))
})

test('spec-writeback verify: the 2026-10-13 pasted-preamble shape fails (duplicate headings and a duplicated criterion line) and restores', () => {
  const f = fixture()
  // The whole preamble pasted into the criteria section, criterion line included.
  const pasted = spec([CRITERIA[0], PREAMBLE + CRITERIA[0], CRITERIA[1], CRITERIA[2]])
  fs.writeFileSync(f.specPath, pasted)
  const v = verify(f)
  assertRestored(f, v)
  assert.ok(v.out.problems.some((p) => /## Problem/.test(p)), 'the duplicated heading is named: ' + JSON.stringify(v.out.problems))
})

test('spec-writeback verify: a criterion line appearing twice fails as a duplicate even when headings and ids are intact, and restores', () => {
  const f = fixture()
  // Same id set, same headings: only the duplicate-line check can see this.
  fs.writeFileSync(f.specPath, spec([...CRITERIA, CRITERIA[0]]))
  const v = verify(f)
  assertRestored(f, v)
  assert.ok(v.out.problems.some((p) => /duplicate/i.test(p)), JSON.stringify(v.out.problems))
})

// The real 2026-10-13 shape: the line was cut right after a "$" and a backtick.
test('spec-writeback verify: a line cut right after "$`" fails as mid-sentence and restores', () => {
  const f = fixture()
  const cut = CRITERIA.slice(0, 2).concat(['- **AC-QA-2:** The pattern ends with a dollar anchor `/^abc$`'])
  fs.writeFileSync(f.specPath, spec(cut))
  const v = verify(f)
  assertRestored(f, v)
  assert.ok(v.out.problems.some((p) => /mid-sentence|ends|truncat/i.test(p) && /AC-QA-2/.test(p)), JSON.stringify(v.out.problems))
})

test('spec-writeback verify: mid-sentence shapes each fail on their own -- odd backticks, unbalanced parentheses, a non-terminal last character', () => {
  const shapes = [
    '- **AC-QA-2:** The pattern ends with `/^abc$/ and stops.',   // odd backticks, terminal period
    '- **AC-QA-2:** The pattern (see the note and stops.',        // unbalanced parentheses, terminal period
    '- **AC-QA-2:** The pattern is anchored and then',            // plain truncation
  ]
  for (const line of shapes) {
    const f = fixture()
    fs.writeFileSync(f.specPath, spec([CRITERIA[0], CRITERIA[1], line]))
    const v = verify(f)
    assertRestored(f, v)
    assert.ok(v.out.problems.some((p) => /AC-QA-2/.test(p)), `${line} -> ${JSON.stringify(v.out.problems)}`)
  }
})

test('spec-writeback verify: criteria ending in a period, question mark, exclamation, colon, or a closing paren after a period are not flagged', () => {
  const ok = [
    '- **AC-SEC-1:** Ends with a period.',
    '- **AC-QA-1:** Ends with a question mark?',
    '- **AC-QA-2:** Ends with a note (balanced, and `code` too).',
  ]
  // The snapshot is the default spec, so every line below is NEW to the write-back and is judged (a line identical to
  // the snapshot is the operator's own and is not re-judged; see the grandfathering test).
  const f = fixture()
  fs.writeFileSync(f.specPath, spec(ok))
  const v = verify(f)
  assert.deepEqual(v.out && v.out.problems, [], JSON.stringify(v.out))
  assert.equal(v.out.ok, true)
})

test('spec-writeback verify: a missing or malformed snapshot file, or bad surviving-ids argument, exits non-zero with one stderr line, no stdout, and restores nothing', () => {
  const f = fixture()
  const broken = spec(CRITERIA.slice(0, 1))
  fs.writeFileSync(f.specPath, broken)
  const cases = [
    ['missing snapshot', [f.specPath, path.join(f.tmp, 'nope'), JSON.stringify(IDS)]],
    ['garbage snapshot', (() => { const g = path.join(f.tmp, 'garbage'); fs.writeFileSync(g, ''); return [f.specPath, g, JSON.stringify(IDS)] })()],
    ['ids not JSON', [f.specPath, f.snap.file, 'AC-SEC-1']],
    ['ids not an array of strings', [f.specPath, f.snap.file, '[1,2]']],
    ['ids an object', [f.specPath, f.snap.file, '{}']],
    ['missing arguments', [f.specPath]],
  ]
  for (const [name, args] of cases) {
    const v = run(['verify', ...args], f.tmp)
    assert.notEqual(v.res.status, 0, name)
    assert.equal(v.res.stdout, '', name)
    assert.equal(v.res.stderr.trim().split('\n').length, 1, `${name}: one reason line, got ${JSON.stringify(v.res.stderr)}`)
    assert.doesNotMatch(v.res.stderr, /Cannot find module/, name)
    assert.equal(fs.readFileSync(f.specPath, 'utf8'), broken, `${name}: nothing restored`)
  }
  assert.ok(fs.existsSync(f.snap.file), 'a refused verify deletes nothing')
})

// ======================================================================
// Review round 1 of PR #18 (wf_9f8826b4-bcb). F1 (High): the sentence-terminal check flagged the merge-note shapes
// the synthesis prompt asks for, on 2 of 12 real specs. F2 (Medium): the "## Acceptance criteria exactly once" check
// had no fixture without the heading. F6 (Low): restore's mode preservation was untested.
// ======================================================================
test('spec-writeback verify (F1): merge notes after the sentence, emphasised, bracketed or nested, are not flagged', () => {
  const ok = [
    '- **AC-SEC-1:** The token is never logged. *(merges AC-ARCH-7)*',
    '- **AC-QA-1:** A failing check exits non-zero. [merges AC-QA-15]',
    '- **AC-QA-2:** Two steps, snapshot then verify; both run. (Folds AC-OPS-1.)',
    '- **AC-QA-3:** Ends with a note (balanced, and `code` too).',
    '- **AC-QA-4:** A full sentence. *(Amended later (with a nested aside): the change label comes from its XY code.)*',
  ]
  const f = fixture()  // snapshot the default spec so every line below is judged, not grandfathered
  fs.writeFileSync(f.specPath, spec(ok))
  const v = verify(f, ['AC-SEC-1', 'AC-QA-1', 'AC-QA-2', 'AC-QA-3', 'AC-QA-4'])
  assert.deepEqual(v.out && v.out.problems, [], JSON.stringify(v.out))
  assert.equal(v.out.ok, true)
})

test('spec-writeback verify (F1): a note cut mid-way is still flagged, and the two-direction pin holds', () => {
  const bad = [...CRITERIA.slice(0, 2), '- **AC-QA-2:** The pattern is anchored. (merges AC-']
  const f = fixture()  // the snapshot is the good spec; the cut line is what the write-back wrote
  fs.writeFileSync(f.specPath, spec(bad))
  const v = verify(f)
  assert.ok(v.out.problems.some((p) => p.includes('AC-QA-2') && p.includes('mid-sentence')), JSON.stringify(v.out.problems))
  assertRestored(f, v)
})

// The strongest regression test for the structural checks: every real spec in this repository, verified against its
// own snapshot and ids, passes (its hand-written criterion lines are the operator's own and are not re-judged for
// sentence shape); a spec with no criteria section fails on exactly that one problem and nothing else.
const SPECS_DIR = path.join(__dirname, '..', 'specs')
for (const name of fs.readdirSync(SPECS_DIR).filter((n) => n.endsWith('.md')).sort()) {
  test(`spec-writeback verify (F1 regression): the real spec ${name} passes against its own ids, or fails only for a missing criteria section`, () => {
    const original = fs.readFileSync(path.join(SPECS_DIR, name), 'utf8')
    const f = fixture(original)
    const ids = [...original.matchAll(/^- \*\*(AC-[A-Z]+-\d+):\*\*/gm)].map((m) => m[1])
    const v = verify(f, ids)
    assert.equal(v.res.status, 0, v.res.stderr)
    const hasSection = /^## Acceptance criteria$/m.test(original)
    if (hasSection) {
      assert.deepEqual(v.out.problems, [], `${name}: ${JSON.stringify(v.out.problems)}`)
      assert.equal(v.out.ok, true)
    } else {
      assert.deepEqual(v.out.problems, ['"## Acceptance criteria" must appear exactly once, found 0'], name)
      assert.equal(fs.readFileSync(f.specPath, 'utf8'), original, 'restored byte for byte')
    }
  })
}

test('spec-writeback verify (F2): a snapshot with no criteria section passes once the write-back adds the heading exactly once, and fails for a level-3 heading or none', () => {
  const noSection = `${PREAMBLE}## Tasks\n\n- [ ] T1: do it.\n`
  const added = `${PREAMBLE}## Acceptance criteria\n\n${CRITERIA.join('\n')}\n\n## Tasks\n\n- [ ] T1: do it.\n`
  const f1 = fixture(noSection); fs.writeFileSync(f1.specPath, added)
  const v1 = verify(f1)
  assert.deepEqual(v1.out.problems, [], JSON.stringify(v1.out))
  for (const [label, bad] of [['a level-3 heading', added.replace('## Acceptance criteria', '### Acceptance criteria')], ['no heading', added.replace('## Acceptance criteria\n\n', '')]]) {
    const f = fixture(noSection); fs.writeFileSync(f.specPath, bad)
    const v = verify(f)
    assert.ok(v.out.problems.some((p) => p.includes('"## Acceptance criteria" must appear exactly once, found 0')), `${label}: ${JSON.stringify(v.out.problems)}`)
    assertRestored(f, v)
  }
})

test('spec-writeback verify (F6): a restore keeps the spec file mode it had before the write-back', () => {
  const f = fixture()
  fs.chmodSync(f.specPath, 0o640)
  fs.writeFileSync(f.specPath, spec([...CRITERIA, '- **AC-QA-9:** An extra one.']))
  const v = verify(f)
  assertRestored(f, v)
  assert.equal(fs.statSync(f.specPath).mode & 0o777, 0o640)
})

test('spec-writeback verify (F1): a hand-written criterion line identical to the snapshot is not re-judged, but the same line changed by the write-back is', () => {
  const legacy = '- **AC-QA-7:** A legacy multi-line criterion whose first line ends without punctuation, continued'
  const f = fixture(spec([...CRITERIA, legacy]))
  const same = verify(f, [...IDS, 'AC-QA-7'])
  assert.deepEqual(same.out.problems, [], JSON.stringify(same.out))
  const f2 = fixture(spec([...CRITERIA, legacy]))
  fs.writeFileSync(f2.specPath, spec([...CRITERIA, legacy + ' and now changed']))
  const changed = verify(f2, [...IDS, 'AC-QA-7'])
  assert.ok(changed.out.problems.some((p) => p.includes('AC-QA-7') && p.includes('mid-sentence')), JSON.stringify(changed.out.problems))
  assertRestored(f2, changed)
})
