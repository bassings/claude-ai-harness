const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
// This file invokes git (to build a fixture repo, and to read what the repo
// publishes). Without the scrub, a suite run under an exported GIT_DIR -- which
// CI does deliberately, a second time, to prove the scrub works -- would read
// or initialise the WRONG repository. Called, not merely required: the module
// defines the scrub and does not run it at load.
const { scrubGitEnv } = require('./helpers/git-env.js')
scrubGitEnv()

const ROOT = path.join(__dirname, '..')
const SCRIPT = path.join(ROOT, 'bin', 'install.sh')

// The harness RUNS from an installed mirror (~/.claude), not from this
// checkout. So a change can merge, pass every test, and change nothing on a
// real run -- the "correct in source, absent from the build" shape in the
// standards, applied to an install rather than a compiler. Measured
// 2026-09-14: after merging two PRs, the installed ledger-append.mjs still
// differed from the repo's, and the weekly job had been reporting that drift
// for three consecutive weeks into a log nobody reads.
//
// README's install is four hand-run `cp` commands. install-consistency.mjs
// already knows authoritatively WHICH files belong in an install. The
// installer therefore asks it, rather than carrying a second copy of that
// list: two copies of one rule is the defect this repo hit twice in one day
// (the AC-id pattern, and the AC-definition counter).

function run(args, env = {}) {
  return spawnSync('/bin/sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: ROOT,
  })
}

function tmpInstall() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-install-'))
  test.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('install.sh: --check reports drift without writing anything, and exits non-zero', () => {
  const dest = tmpInstall()
  const res = run(['--check'], { CLAUDE_HOME: dest })
  assert.notEqual(res.status, 0, 'an empty install is drifted; --check must say so by exit status')
  assert.equal(fs.readdirSync(dest).length, 0, '--check must never write: it is the half you can run from a hook')
  assert.match(res.stdout + res.stderr, /drift|missing/i)
})

test('install.sh: installs the consumer subset, and --check then passes', () => {
  const dest = tmpInstall()
  const install = run([], { CLAUDE_HOME: dest })
  assert.equal(install.status, 0, install.stdout + install.stderr)
  assert.ok(fs.existsSync(path.join(dest, 'AGENT-HARNESS.md')), 'the contract must be installed')
  assert.ok(fs.existsSync(path.join(dest, 'workflows', 'lib', 'ledger-append.mjs')), 'the libs must be installed')
  assert.ok(fs.existsSync(path.join(dest, 'skills', 'conduct-plan', 'SKILL.md')), 'conduct-plan drives every multi-PR plan')

  const check = run(['--check'], { CLAUDE_HOME: dest })
  assert.equal(check.status, 0, `--check must pass right after an install:\n${check.stdout}${check.stderr}`)
})

test('install.sh: what it installs is exactly what install-consistency.mjs calls the consumer subset -- one list, not two', async () => {
  // The anti-drift property. If the installer carried its own path list, the
  // detector and the installer could disagree and an operator following both
  // would still be stale.
  const dest = tmpInstall()
  assert.equal(run([], { CLAUDE_HOME: dest }).status, 0)

  // Computed from the TWO authoritative sources independently -- the module
  // that owns the subset, and git's own idea of what this repo publishes --
  // rather than from anything the installer does. If the installer grew its own
  // path list, or its own exclusion list, this would diverge.
  const mod = await import(require('node:url').pathToFileURL(
    path.join(ROOT, 'workflows', 'lib', 'install-consistency.mjs')).href)
  const tracked = new Set(spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\n').filter(Boolean))
  const wanted = mod.listConsumerSubsetFiles(ROOT).filter((f) => tracked.has(f))
  assert.ok(wanted.length > 10, `sanity: expected a real subset, got ${wanted.length}`)

  for (const rel of wanted) {
    assert.ok(fs.existsSync(path.join(dest, rel)),
      `${rel} is in the consumer subset and tracked, but the installer did not install it`)
  }
})

test('install.sh: a file the repo does NOT publish is not installed, so an install is not a copy of the whole repo', () => {
  const dest = tmpInstall()
  assert.equal(run([], { CLAUDE_HOME: dest }).status, 0)
  assert.equal(fs.existsSync(path.join(dest, 'test')), false, 'the test suite is not part of an install')
  assert.equal(fs.existsSync(path.join(dest, 'specs')), false, 'specs are not part of an install')
  assert.equal(fs.existsSync(path.join(dest, '.git')), false)
})

test('install.sh: refuses to install over a destination that is not a harness install, rather than scattering files into it', () => {
  const dest = tmpInstall()
  fs.writeFileSync(path.join(dest, 'something-else.txt'), 'a directory that is not ~/.claude\n')
  const res = run([], { CLAUDE_HOME: dest, HARNESS_INSTALL_REQUIRE_MARKER: '1' })
  assert.notEqual(res.status, 0, 'an unfamiliar destination must be refused unless explicitly allowed')
  assert.match(res.stdout + res.stderr, /does not look like/i)
})

test('install.sh: refuses when the consumer subset comes back EMPTY, rather than reporting a successful install of nothing', () => {
  // The vacuous-success shape: if the module that owns the file list ever
  // returns nothing (a bad refactor, a renamed directory), a naive installer
  // copies zero files, verifies zero files, and prints success. The operator
  // then believes they are current while running whatever was there before.
  // Proven necessary by mutation: with this guard removed, every other test in
  // this file stayed green.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-emptysubset-'))
  test.after(() => fs.rmSync(fake, { recursive: true, force: true }))
  fs.mkdirSync(path.join(fake, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(fake, 'workflows', 'lib'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(fake, 'bin', 'install.sh'))
  fs.writeFileSync(
    path.join(fake, 'workflows', 'lib', 'install-consistency.mjs'),
    'export function listConsumerSubsetFiles() { return [] }\n')
  // A real git repo, so this exercises "the module returned nothing" and not
  // the unrelated "this is not a checkout" path.
  spawnSync('git', ['init', '-q'], { cwd: fake })
  spawnSync('git', ['add', '-A'], { cwd: fake })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: fake })

  const dest = tmpInstall()
  const res = spawnSync('/bin/sh', [path.join(fake, 'bin', 'install.sh')], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_HOME: dest }, cwd: fake,
  })
  assert.notEqual(res.status, 0, 'an empty subset must be refused, never reported as a successful install')
  assert.match(res.stdout + res.stderr, /refusing to 'install' nothing/i)
  assert.equal(fs.readdirSync(dest).length, 0, 'and nothing may be written')
})

test('install.sh: installs only files the repo actually TRACKS -- generated artefacts are not part of a release', () => {
  // Caught on the first real run: `hooks/` walks everything under it, so the
  // installer copied hooks/__pycache__/test_plan_guard_stop.cpython-314.pyc
  // into the operator's harness. Compiled bytecode of a test file is not part
  // of anything, it is gitignored, and it goes stale against the .py beside it.
  // The same directory tripped the optimiser-reference scan earlier the same
  // day for the same reason: a walk that does not distinguish source from
  // build output.
  const dest = tmpInstall()
  assert.equal(run([], { CLAUDE_HOME: dest }).status, 0)
  const found = []
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p, r)
      else found.push(r)
    }
  }
  walk(dest)
  const generated = found.filter((f) => f.includes('__pycache__') || f.endsWith('.pyc'))
  assert.deepEqual(generated, [], `generated artefacts must never be installed, got: ${generated.join(', ')}`)
  assert.ok(found.length > 10, 'sanity: a real install happened, so the assertion above is not vacuous')
})
