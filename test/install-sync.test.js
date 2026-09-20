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

// L1 (round 2 review): the guard above only ever ran with the env var
// explicitly set to 1 -- production never sets it, so the destination-safety
// guard was off for every real install. Measured (security lens): a
// CLAUDE_HOME pointing at a directory holding only Documents/taxes.pdf
// installed 29 files, including executable hooks, and exited 0. The comment
// said "opt in with ...=0", which was the reverse of what the code did.
test('install.sh (L1): refuses an unfamiliar destination by DEFAULT -- no environment variable set at all, matching production', () => {
  const dest = tmpInstall()
  fs.writeFileSync(path.join(dest, 'taxes.pdf'), 'not a harness install\n')
  const res = run([], { CLAUDE_HOME: dest })
  assert.notEqual(res.status, 0, 'the default path (no env var set) must refuse an unfamiliar destination, matching what a real operator actually runs')
  assert.match(res.stdout + res.stderr, /does not look like/i)
  assert.equal(fs.readdirSync(dest).length, 1, 'nothing may be written on refusal -- only the pre-existing taxes.pdf remains')
})

test('install.sh (L1): HARNESS_INSTALL_REQUIRE_MARKER=0 is the documented opt-out for a genuinely fresh install', () => {
  const dest = tmpInstall()
  fs.writeFileSync(path.join(dest, 'taxes.pdf'), 'not a harness install\n')
  const res = run([], { CLAUDE_HOME: dest, HARNESS_INSTALL_REQUIRE_MARKER: '0' })
  assert.equal(res.status, 0, `=0 must opt out of the guard for a fresh install:\n${res.stdout}${res.stderr}`)
  assert.ok(fs.existsSync(path.join(dest, 'AGENT-HARNESS.md')), 'the install must actually have happened')
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
    'export function listInstallFiles() { return { files: [], required: [], optional: [], blind: false } }\n')
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

// M4 (round 2 review): install.sh --check reimplemented drift detection with
// its own shell cmp -s loop instead of calling checkStaleness(), and the two
// disagreed about an OPTIONAL file (bin/optimise-cycle-weekly.sh,
// bin/redact-transcript.mjs, hooks/hooks.json -- CONSUMER_OPTIONAL_PATTERNS):
// checkStaleness exempts a missing optional file from drift (a manual
// install that skips the weekly job is a legitimate configuration);
// install.sh's own loop counted ANY missing destination file as drift.
test('install.sh (M4): --check does not report drift when an OPTIONAL consumer-subset file is absent from the destination -- a manual install that skips the weekly job is a legitimate configuration, matching checkStaleness', async () => {
  const dest = tmpInstall()
  assert.equal(run([], { CLAUDE_HOME: dest }).status, 0)

  const mod = await import(require('node:url').pathToFileURL(
    path.join(ROOT, 'workflows', 'lib', 'install-consistency.mjs')).href)
  const optionalPresent = mod.CONSUMER_OPTIONAL_PATTERNS.filter((p) => fs.existsSync(path.join(dest, p)))
  assert.ok(optionalPresent.length > 0, 'sanity: at least one optional file must actually have been installed')
  for (const rel of optionalPresent) fs.rmSync(path.join(dest, rel))

  const check = run(['--check'], { CLAUDE_HOME: dest })
  assert.equal(check.status, 0,
    `--check must still pass with an optional file missing, matching checkStaleness's own exemption:\n${check.stdout}${check.stderr}`)
})

test('install.sh (M4): --check calls the SAME checkStaleness() the weekly drift check uses, not a second drift detector', async () => {
  const dest = tmpInstall()
  assert.equal(run([], { CLAUDE_HOME: dest }).status, 0)
  // Corrupt one REQUIRED (non-optional) file's content at the destination.
  const target = path.join(dest, 'AGENT-HARNESS.md')
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8') + '\nhand-edited drift\n')

  const mod = await import(require('node:url').pathToFileURL(
    path.join(ROOT, 'workflows', 'lib', 'install-consistency.mjs')).href)
  const staleness = mod.checkStaleness(ROOT, dest)
  assert.equal(staleness.status, 'drift', 'sanity: checkStaleness itself must see this drift')

  const check = run(['--check'], { CLAUDE_HOME: dest })
  assert.notEqual(check.status, 0, 'install.sh --check must agree with checkStaleness and report drift')
  assert.match(check.stdout + check.stderr, /AGENT-HARNESS\.md/, 'must name the drifted file')
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

// --- round-4 review M2: the write path was reachable by any spelling ------
//
// The whole argument parse was `CHECK_ONLY=0` then
// `[ "${1:-}" = "--check" ] && CHECK_ONLY=1`; everything else fell through
// to the install branch. So `--dry-run`, `--verify`, `--checks`, `-n` and
// every typo of `--check` wrote 29 files into the operator's ~/.claude --
// the opposite of what each of those spellings asks for, from the only path
// in this change that writes outside the repo, and (per README) the
// workflows are re-read from disk on the very next run.
//
// The marker guard does not help: it refuses a destination that does not
// LOOK like a Claude install, and a real ~/.claude does.

for (const arg of ['--dry-run', '--verify', '--checks', '--check-only', '-n', '-check', 'check']) {
  test(`install.sh (M2): the unrecognised argument ${arg} is refused, writes nothing, and exits non-zero`, () => {
    const dest = tmpInstall()
    // Marker guard explicitly disabled, so nothing but the argument parse
    // itself can be what stops the write. With the guard left on, a passing
    // test would not distinguish "refused the argument" from "refused the
    // destination".
    const res = run([arg], { CLAUDE_HOME: dest, HARNESS_INSTALL_REQUIRE_MARKER: '0' })
    assert.notEqual(res.status, 0, `${arg} must not be treated as a request to install`)
    assert.equal(fs.readdirSync(dest).length, 0,
      `${arg} must write nothing: every one of these spellings means "tell me, do not change anything"`)
    assert.match(res.stderr, /unrecognised argument/i, 'and it must say which argument it did not understand')
    assert.match(res.stderr, /--check/, 'the usage message must name the spelling that does work')
  })
}

test('install.sh (M2): --help prints usage, writes nothing, and exits 0 -- asking is not an error', () => {
  const dest = tmpInstall()
  const res = run(['--help'], { CLAUDE_HOME: dest, HARNESS_INSTALL_REQUIRE_MARKER: '0' })
  assert.equal(res.status, 0, res.stdout + res.stderr)
  assert.equal(fs.readdirSync(dest).length, 0, '--help must never install')
  assert.match(res.stdout + res.stderr, /usage/i)
})

test('install.sh (M2): a second argument is refused rather than silently ignored', () => {
  // Asserted on the DIAGNOSTIC, not merely on a non-zero exit: `--check
  // extra` against an empty destination exits non-zero anyway (it is
  // drifted), so an exit-status-only assertion passes whether the extra
  // argument was refused or silently dropped. Measured -- deleting the arity
  // check left the exit-status version of this test green.
  const dest = tmpInstall()
  const res = run(['--check', 'extra'], { CLAUDE_HOME: dest, HARNESS_INSTALL_REQUIRE_MARKER: '0' })
  assert.notEqual(res.status, 0, 'an argument the script cannot act on must not be dropped on the floor')
  assert.match(res.stderr, /too many arguments/i,
    'the refusal must name the reason: an argument the script cannot act on is an error, not a no-op')
  assert.equal(fs.readdirSync(dest).length, 0)
})

test('install.sh (M2, not over-broad): no argument still installs, and --check still verifies', () => {
  const dest = tmpInstall()
  const install = run([], { CLAUDE_HOME: dest })
  assert.equal(install.status, 0, install.stdout + install.stderr)
  assert.ok(fs.existsSync(path.join(dest, 'AGENT-HARNESS.md')), 'the default path must still be a real install')
  assert.equal(run(['--check'], { CLAUDE_HOME: dest }).status, 0, 'and --check must still pass against it')
})

function makeFakeCheckout(dirName) {
  // A real checkout is not needed: what is under test is whether the script
  // can hand node its own library path at all. Copying the two files the seam
  // touches gets past "cannot find $LIB" and into the node invocation, which
  // is where every measured failure was.
  const checkout = path.join(tmpInstall(), dirName)
  fs.mkdirSync(path.join(checkout, 'workflows', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(checkout, 'bin'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(checkout, 'bin', 'install.sh'))
  fs.copyFileSync(
    path.join(ROOT, 'workflows', 'lib', 'install-consistency.mjs'),
    path.join(checkout, 'workflows', 'lib', 'install-consistency.mjs'))
  return checkout
}

// --- round-4 review M6: the shell-to-ESM seam ----------------------------
//
// `LIB_JS="$(printf '%s' "$LIB" | sed "s/'/\\\\'/g")"` escaped a single
// quote and nothing else, and the result was pasted inside a single-quoted
// JavaScript string literal at two `import ... from '<specifier>'` sites.
// Measured by two lenses: a checkout path containing a backslash and an
// apostrophe dies with `SyntaxError: Unexpected identifier`, and a
// backslash-only path is WORSE than a crash -- the backslash is consumed as
// a JS escape, so node resolves a DIFFERENT path and reports
// ERR_MODULE_NOT_FOUND, from the one tool whose job is telling an operator
// whether their install is current.
//
// Not code execution: a static import specifier resolves before any injected
// statement could run. The fix is to stop interpolating rather than to
// escape better -- $REPO and $DEST already cross the same seam as argv
// entries, and bin/optimise-cycle-weekly.sh:351 already uses that convention
// for this very module.

// Paths node CAN load: every shape the old sed either mangled or could not
// see at all. These are the cases the fix genuinely closes.
for (const [label, dirName] of [
  ['an apostrophe', "q'dir"],
  ['a double quote', 'dq"dir'],
  ['a dollar sign and a backtick', 'sh$`dir'],
  ['a space and a paren', 'sp ace(dir)'],
]) {
  test(`install.sh (M6): a checkout path containing ${label} loads the library and runs -- the path crosses the seam as an argument, not as source`, () => {
    const checkout = makeFakeCheckout(dirName)
    const dest = tmpInstall()
    const res = spawnSync('/bin/sh', [path.join(checkout, 'bin', 'install.sh'), '--check'], {
      encoding: 'utf8', env: { ...process.env, CLAUDE_HOME: dest }, cwd: checkout,
    })
    const output = res.stdout + res.stderr
    assert.ok(!/SyntaxError/.test(output), `the path must not be parsed as JavaScript; got:\n${output}`)
    assert.ok(!/ERR_MODULE_NOT_FOUND|ERR_INVALID_MODULE_SPECIFIER|Cannot find module/.test(output),
      `node must resolve the library at the path the script actually has; got:\n${output}`)
    // The copied tree is not a git checkout, so the honest outcome is the
    // script's own "could not verify" diagnostic: reached only if the
    // library loaded and ran.
    assert.ok(/could not verify|matches this checkout|drift|missing/i.test(output),
      `expected the installer's own diagnostic, got:\n${output}`)
  })
}

// Paths node CANNOT load, stated as a measured limit rather than claimed
// closed: the ESM resolver refuses any file URL holding an encoded backslash
// (ERR_INVALID_MODULE_SPECIFIER, "must not include encoded / or \\
// characters"), so a backslash in a checkout path is unloadable however it is
// passed -- argument, relative specifier or source. What the fix changes is
// that the path is no longer MANGLED (the old sed ate the backslash, so node
// reported a module missing from a path the operator does not have) and the
// failure is the installer's own diagnostic naming the real path.
for (const [label, dirName] of [
  ['a backslash and an apostrophe', "bs\\q'dir"],
  ['a backslash alone', 'bs\\dir'],
]) {
  test(`install.sh (M6): a checkout path containing ${label} fails with the installer's OWN diagnostic naming the REAL path, never a mangled one`, () => {
    const checkout = makeFakeCheckout(dirName)
    const dest = tmpInstall()
    const res = spawnSync('/bin/sh', [path.join(checkout, 'bin', 'install.sh'), '--check'], {
      encoding: 'utf8', env: { ...process.env, CLAUDE_HOME: dest }, cwd: checkout,
    })
    const output = res.stdout + res.stderr
    assert.notEqual(res.status, 0, 'an install that cannot verify itself must not report success')
    assert.ok(!/SyntaxError/.test(output), `the path must never be parsed as JavaScript; got:\n${output}`)
    assert.match(output, /install --check: cannot load /,
      `expected the installer's own diagnostic rather than an unhandled node stack trace; got:\n${output}`)
    // The mangling is the half that made the old failure a lie: node used to
    // report a path with the backslash eaten, which no operator could act on.
    assert.ok(output.includes(checkout),
      `the diagnostic must name the path the operator actually has (${checkout}); got:\n${output}`)
  })
}

test('install.sh (M6): no path is interpolated into JavaScript source -- the seam is argv, enforced rather than remembered', () => {
  // AC-ARCH-1's third clause, as a check rather than a sentence. A future
  // shell-to-node call site that pastes a path into the program text fails
  // here instead of at an operator's terminal. Comments are stripped first:
  // the guard is about what the script DOES, and the history of this defect
  // is written in the comments right above the code it describes.
  const code = fs.readFileSync(SCRIPT, 'utf8')
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.ok(!/\bsed\b/.test(code),
    'install.sh must not escape a path for JavaScript: pass it through process.argv instead')
  assert.ok(!/from\s+'\$/.test(code) && !/from\s+"\$/.test(code),
    'no import specifier may be built from a shell variable')
  assert.ok(/pathToFileURL/.test(code),
    'the library path must be resolved from an argv entry via pathToFileURL, the convention bin/optimise-cycle-weekly.sh already uses')
})
