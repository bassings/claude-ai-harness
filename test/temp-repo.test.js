// M4: test/helpers/temp-repo.js used to scatter one directory per
// makeTempRepo() call directly across the developer's shared TMPDIR, with
// cleanup only running via test.after(cleanupTempRepos) -- a mechanism that
// depends on every test file remembering to register it, and on the process
// reaching that hook at all. Measured: 2 failures in 71 runs on a shared
// TMPDIR (getcwd errors after a directory vanished mid-setup), and 8
// leftover repos after one deliberately failing test. This file tests the
// helper module ITSELF (following the precedent of fake-runtime.test.js),
// not workflows/lib/ledger-append.mjs.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { makeTempRepo, cleanupTempRepos, assertGitContextWithin, SUITE_TMPDIR, trackTempDir } = require('./helpers/temp-repo.js')
const gitEnv = require('./helpers/git-env.js')

test.after(cleanupTempRepos)

test('temp-repo.js: two repos created in this process share one isolated parent directory, not the bare shared TMPDIR', () => {
  const a = makeTempRepo()
  const b = makeTempRepo()
  assert.equal(path.dirname(a), path.dirname(b), 'both repos must be children of the same suite-isolated root')
  assert.notEqual(path.dirname(a), require('node:os').tmpdir(), 'repos must not sit directly in the bare shared TMPDIR')
})

// A real child process, not an in-process simulation: this is the only way
// to actually exercise a process 'exit' handler firing, and to prove
// unconditional cleanup does not depend on test.after ever running.
test('temp-repo.js: the suite temp root is removed automatically when the process exits, even after a simulated test failure that never calls cleanupTempRepos itself', () => {
  const script = `
    const { makeTempRepo } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'temp-repo.js'))});
    const dir = makeTempRepo();
    process.stdout.write(require('node:path').dirname(dir));
    // Simulate a failed test run (an assertion the test runner caught, or an
    // explicit non-zero exit) -- NOT calling cleanupTempRepos, and NOT
    // throwing an uncaught exception (which would skip the 'exit' event
    // entirely on some Node versions/signals; this proves the ordinary
    // failure path, which is the one M4 measured).
    process.exitCode = 1;
  `
  const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  const suiteRoot = res.stdout.trim()
  assert.ok(suiteRoot, `child process printed no suite root path: stderr=${res.stderr}`)
  assert.ok(fs.existsSync(suiteRoot) === false, `the suite temp root (${suiteRoot}) must not survive the child process's exit, even on a simulated failure path`)
})

test('temp-repo.js: makeTempRepo throws a specific, actionable error (not a generic ENOENT from a later git command) if its directory vanishes immediately after creation', () => {
  // Not exercised via a real race (that would be genuinely flaky to
  // construct); this pins the CONTRACT -- makeTempRepo checks existence
  // itself right after mkdtempSync and after git init, per M4's explicit
  // fix instruction ("assert existence ... so a disappearance names its
  // real cause") -- by reading the source rather than the runtime, since
  // simulating the race itself would reintroduce the exact flakiness M4
  // exists to remove.
  const src = fs.readFileSync(path.join(__dirname, 'helpers', 'temp-repo.js'), 'utf8')
  assert.match(src, /vanished immediately after mkdtempSync/, 'expected an existence check right after mkdtempSync')
  assert.match(src, /vanished during git init/, 'expected an existence check after git init, distinguishing the two possible disappearance points')
})

// ---- GIT_DIR leak immunity ----
//
// git exports GIT_DIR into hook subprocesses, and only when the push comes
// from a LINKED WORKTREE (measured in a sibling repo: main checkout
// GIT_DIR=[unset], worktree GIT_DIR=[.../.git/worktrees/<name>]). Any test
// that shells out to git with `cwd:` and an inherited environment is exposed,
// because cwd does NOT win against GIT_DIR: `git init` in a fresh directory
// then does not create a repo there at all -- it silently re-initialises the
// repo GIT_DIR already names ("warning: re-init"), and every subsequent
// fixture command (config, add, commit, checkout) lands in the REAL
// repository. Reproduced here directly before writing this test:
//
//   cd /tmp/empty && GIT_DIR=/path/to/victim/.git git init -q -b fixture
//   -> warning: re-init: ignored --initial-branch=fixture
//   -> no .git created in /tmp/empty
//
// Reported by the CouchPotatoServer session on 2026-08-18, where it landed
// twice hours apart and left a real checkout sitting on a fixture branch,
// fixture commits on a real feature branch, and core.bare flipped to true so
// the main checkout stopped being a work tree. It is NOT specific to that
// repo: this suite has the same shape at every git-invoking call site.
//
// This repo has no hooks today (.git/hooks holds only samples, no
// .githooks/, core.hooksPath unset), so nothing currently exports GIT_DIR
// into this suite. That is a missing trigger, not a fix: adding one pre-push
// hook -- which the project standard calls for -- converts every call site at
// once, and it is cheap now and expensive after it eats uncommitted work.
//
// A CHILD process carries the hostile environment, so this test cannot leak
// GIT_DIR into the rest of the suite even if it fails midway.

function runWithLeakedGitDir(victimRepo, body) {
  const script = `
    const path = require('node:path');
    const fs = require('node:fs');
    const helper = require(${JSON.stringify(path.join(__dirname, 'helpers', 'temp-repo.js'))});
    const { makeTempRepo, runAppend } = helper;
    ${body}
  `
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, GIT_DIR: path.join(victimRepo, '.git') },
  })
}

function snapshotRepo(repo) {
  const g = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim()
  const excludePath = path.join(repo, '.git', 'info', 'exclude')
  return {
    head: g(['rev-parse', 'HEAD']),
    branch: g(['rev-parse', '--abbrev-ref', 'HEAD']),
    bare: g(['config', '--get', 'core.bare']),
    commits: g(['rev-list', '--count', 'HEAD']),
    exclude: fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : null,
    status: g(['status', '--porcelain']),
  }
}

test('temp-repo.js: makeTempRepo() creates a real repo in its own directory even when GIT_DIR is leaked into the environment, and leaves the repo GIT_DIR names completely untouched', () => {
  const victim = makeTempRepo()
  const before = snapshotRepo(victim)
  assert.equal(before.bare, 'false', 'sanity: the victim must start as a normal work tree')
  assert.equal(before.commits, '1', 'sanity: the victim starts with exactly its seed commit')

  const res = runWithLeakedGitDir(victim, `
    const dir = makeTempRepo();
    process.stdout.write(JSON.stringify({
      dir,
      hasOwnGitDir: fs.existsSync(path.join(dir, '.git')),
    }));
  `)
  assert.equal(res.status, 0, `child failed: ${res.stderr}`)
  const out = JSON.parse(res.stdout.trim())

  assert.ok(
    out.hasOwnGitDir,
    'makeTempRepo() must create a real .git inside its own directory; with GIT_DIR leaking, git silently re-inits the repo GIT_DIR names instead and creates nothing here'
  )

  const after = snapshotRepo(victim)
  assert.deepEqual(after, before, 'the repo named by the leaked GIT_DIR must be byte-for-byte unchanged -- no new commits, no branch move, no core.bare flip, no working-tree change')
})

test('temp-repo.js: runAppend() writes the ledger into its own repo when GIT_DIR is leaked, and never mutates the .git/info/exclude of the repo GIT_DIR names (ledger-append.mjs shells out to git and WRITES via ensureGitignored)', () => {
  const victim = makeTempRepo()
  const before = snapshotRepo(victim)

  const res = runWithLeakedGitDir(victim, `
    const dir = makeTempRepo();
    const r = runAppend(dir, { schema_version: 2, kind: 'tdd_task', outcome: 'done' });
    process.stdout.write(JSON.stringify({
      dir,
      status: r.status,
      ledgerWrittenHere: fs.existsSync(path.join(dir, '.claude', 'harness-ledger.jsonl')),
    }));
  `)
  assert.equal(res.status, 0, `child failed: ${res.stderr}`)
  const out = JSON.parse(res.stdout.trim())

  assert.ok(
    out.ledgerWrittenHere,
    'the ledger must be written into the temp repo, not into whatever repo GIT_DIR names'
  )

  const after = snapshotRepo(victim)
  assert.deepEqual(after, before, "the victim's .git/info/exclude and git state must be untouched -- ensureGitignored() writes through git and would otherwise land there")
})

// The two tests above pass if EITHER defence works -- the module-load scrub
// OR the per-call sanitising in sh()/runAppend() -- so neither is proven by
// them alone. Verified by mutation: deleting the scrubGitEnv() call left all
// of them green. The next two isolate one layer each, so each can fail on
// its own.

test('temp-repo.js: the module-load scrub protects call sites that never use sh() -- a DIRECT git invocation with an inherited environment still resolves to its own repo (this is the layer that covers test files which do not import this helper)', () => {
  const victim = makeTempRepo()
  const before = snapshotRepo(victim)

  // The child requires the helper (which scrubs), then calls git the way an
  // unrelated test file would: execFileSync with cwd and NO env option, so
  // it inherits process.env. Only the scrub can save this call site --
  // sh()'s sanitising is not in the path at all.
  const res = runWithLeakedGitDir(victim, `
    const { execFileSync } = require('node:child_process');
    // Under the suite's isolated root and registered for cleanup, not
    // scattered in the bare shared TMPDIR -- the exact leak M4 fixed, which
    // a new fixture must not quietly reintroduce.
    const dir = fs.mkdtempSync(path.join(helper.SUITE_TMPDIR, 'direct-git-'));
    helper.trackTempDir(dir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const resolved = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: dir, encoding: 'utf8' }).trim();
    process.stdout.write(JSON.stringify({
      resolved: fs.realpathSync(resolved),
      expected: fs.realpathSync(path.join(dir, '.git')),
    }));
  `)
  assert.equal(res.status, 0, `child failed: ${res.stderr}`)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(
    out.resolved,
    out.expected,
    'a direct git call with an inherited environment must resolve to its own new repo; if it resolves elsewhere the module-load scrub is not running'
  )
  assert.deepEqual(snapshotRepo(victim), before, 'the repo named by the leaked GIT_DIR must be untouched')
})

test('temp-repo.js: sh() and runAppend() sanitise per call, so a GIT_DIR set AFTER this module was loaded (defeating the one-time scrub) still cannot redirect a fixture into another repo', () => {
  const victim = makeTempRepo()
  const before = snapshotRepo(victim)

  // No GIT_DIR in the child's starting environment, so the module-load
  // scrub has nothing to remove and cannot be what saves this. The variable
  // is introduced afterwards, which is what any later code -- another
  // helper, a test setting up its own fixture -- would do.
  const script = `
    const path = require('node:path');
    const fs = require('node:fs');
    const { makeTempRepo, runAppend } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'temp-repo.js'))});
    process.env.GIT_DIR = ${JSON.stringify(path.join(victim, '.git'))};
    const dir = makeTempRepo();
    const r = runAppend(dir, { schema_version: 2, kind: 'tdd_task', outcome: 'done' });
    process.stdout.write(JSON.stringify({
      hasOwnGitDir: fs.existsSync(path.join(dir, '.git')),
      ledgerWrittenHere: fs.existsSync(path.join(dir, '.claude', 'harness-ledger.jsonl')),
    }));
  `
  const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  assert.equal(res.status, 0, `child failed: ${res.stderr}`)
  const out = JSON.parse(res.stdout.trim())
  assert.ok(out.hasOwnGitDir, 'sh() must sanitise per call, not rely on the load-time scrub having already run')
  assert.ok(out.ledgerWrittenHere, 'runAppend() must sanitise per call -- ledger-append.mjs shells out to git and writes .git/info/exclude')
  assert.deepEqual(snapshotRepo(victim), before, 'the repo named by the late-set GIT_DIR must be untouched')
})

// The assertion inside makeTempRepo() cannot fire while the sanitising
// layers work, so no end-to-end test can prove it. Measured: deleting it
// entirely left the suite at 684/684 green -- indistinguishable from real
// defence in depth. Driven directly here instead, in both directions, so it
// can neither be silently removed nor tightened into rejecting correct
// fixtures.
test('temp-repo.js: assertGitContextWithin() rejects a git dir outside the fixture directory, names where git actually pointed, and does not depend on that path existing', () => {
  const dir = makeTempRepo()
  const elsewhere = makeTempRepo()

  // The escape it exists to catch: git resolved a real repo somewhere else.
  assert.throws(
    () => assertGitContextWithin(dir, path.join(elsewhere, '.git')),
    (err) => {
      assert.match(err.message, /escaped its own directory/)
      assert.ok(err.message.includes(path.join(elsewhere, '.git')), 'the message must name where git actually pointed, not merely that something was wrong')
      assert.match(err.message, /GIT_DIR/, 'the message must name the cause')
      assert.match(err.message, /git-env\.js/, 'the message must name the fix')
      return true
    }
  )

  // The ENOENT trap: in the real escape, dir/.git was never created and the
  // resolved path may itself be gone. It must still produce the named error
  // rather than dying inside realpathSync.
  assert.throws(
    () => assertGitContextWithin(dir, '/definitely/not/a/real/path/.git'),
    /escaped its own directory/,
    'a non-existent resolved path must still yield the named diagnosis, not an ENOENT from realpathSync'
  )
})

test('temp-repo.js: assertGitContextWithin() accepts a correct fixture, including through a symlinked directory, so it cannot pass by rejecting everything', () => {
  const dir = makeTempRepo()

  // The ordinary correct case.
  assert.doesNotThrow(() => assertGitContextWithin(dir, path.join(dir, '.git')))

  // The same repo reached through a symlink, which is what macOS gives for
  // TMPDIR (/var -> /private/var) and what hostile-repo.js builds
  // deliberately. A containment check that compared raw strings rather than
  // realpaths would false-positive here, and a guard that cries wolf on
  // correct code gets deleted by the next person in a hurry.
  const linkParent = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'symlink-parent-'))
  trackTempDir(linkParent)
  const linked = path.join(linkParent, 'via-symlink')
  fs.symlinkSync(dir, linked)
  assert.doesNotThrow(
    () => assertGitContextWithin(linked, path.join(dir, '.git')),
    'a fixture reached through a symlink must not be reported as an escape'
  )
})

// ---- the denylist was incomplete, and the gap is not theoretical ----
//
// GIT_ENV_VARS listed six variables. Review of the previous change raised
// that it had never been enumerated against git's real export set, as an
// absence of evidence rather than a finding. Measured afterwards, two
// escapes are real and one is severe:
//
//   GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n inject
//   arbitrary config into EVERY git command. Proven directly:
//     env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.email \
//         GIT_CONFIG_VALUE_0=injected@evil.test git config --get user.email
//     -> injected@evil.test
//
//   GIT_TEMPLATE_DIR makes `git init` copy that directory's hooks into every
//   new repository, and they RUN. Proven directly: a pre-commit hook planted
//   in a template dir printed from a fixture's own commit. That is arbitrary
//   code execution in every throwaway repo this suite creates, triggered by
//   an environment variable, which is a different class from "the list is
//   missing a name".
//
// A denylist cannot be finished: the next git release may add another.
//
// The two tests immediately below do NOT establish that. They name
// GIT_TEMPLATE_DIR and GIT_CONFIG_COUNT, so they pin those two escapes and
// nothing more -- this comment originally claimed they pinned the property,
// and review disproved it with three mutations that all stayed green. They
// are kept as regression anchors for the two measured escapes. The property
// itself is guarded further down, by a variable git has never defined, which
// no list of real names can satisfy.

function runWithGitEnv(extraEnv, body) {
  const script = `
    const path = require('node:path');
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const { makeTempRepo } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'temp-repo.js'))});
    ${body}
  `
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
}

test('temp-repo.js: GIT_TEMPLATE_DIR in the environment cannot install hooks into a fixture repo -- git init copies a template\'s hooks and they execute, so this is code execution, not just a config leak', () => {
  const templateDir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'evil-template-'))
  trackTempDir(templateDir)
  fs.mkdirSync(path.join(templateDir, 'hooks'), { recursive: true })
  const hook = path.join(templateDir, 'hooks', 'pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\necho INJECTED_HOOK_RAN >&2\n')
  fs.chmodSync(hook, 0o755)

  const res = runWithGitEnv({ GIT_TEMPLATE_DIR: templateDir }, `
    const dir = makeTempRepo();
    process.stdout.write(JSON.stringify({
      hookInstalled: fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')),
    }));
  `)
  assert.equal(res.status, 0, `child failed: ${res.stderr}`)
  assert.equal(
    JSON.parse(res.stdout.trim()).hookInstalled,
    false,
    'GIT_TEMPLATE_DIR must not reach git init: an installed pre-commit hook runs on the fixture\'s own seed commit'
  )
  assert.ok(!res.stderr.includes('INJECTED_HOOK_RAN'), 'the planted hook must never have executed')
})

test('temp-repo.js: GIT_CONFIG_COUNT/KEY/VALUE in the environment cannot inject config into a fixture repo\'s git commands', () => {
  const res = runWithGitEnv(
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: 'injected@evil.test' },
    `
    const dir = makeTempRepo();
    const email = execFileSync('git', ['config', '--get', 'user.email'], { cwd: dir, encoding: 'utf8' }).trim();
    process.stdout.write(JSON.stringify({ email }));
  `
  )
  assert.equal(res.status, 0, `child failed: ${res.stderr}`)
  assert.equal(
    JSON.parse(res.stdout.trim()).email,
    'test@example.com',
    'the fixture\'s own configured identity must win; an env-injected value means GIT_CONFIG_* reached the command'
  )
})

// The two tests above name GIT_TEMPLATE_DIR and GIT_CONFIG_COUNT, so they
// pin those two variables and NOT the namespace property the change exists
// to establish. Review proved that by mutation: replacing the namespace
// filter with a denylist of exactly the names these tests exercise left the
// suite 689/689 green, as did adding GIT_CONFIG_PARAMETERS to the allowlist
// (after which a fixture's user.email came back as the injected value), as
// did emptying the allowlist entirely. Three mutations, three directions,
// nothing failed. The comment above claimed these tests pin the property;
// measured, they did not.
//
// A property test cannot use a real variable name, because any name list can
// be extended to cover it. It has to use a name git has never defined, so
// only a rule over the whole GIT_* namespace can pass.

test('git-env: the rule is the GIT_* NAMESPACE, not a list of names -- a variable git has never defined is stripped, which no allowlist or denylist of real names can satisfy', () => {
  const invented = 'GIT_NOT_A_REAL_VARIABLE_47B3F9'
  assert.ok(
    gitEnv.gitEnvKeysToStrip({ [invented]: 'x' }).includes(invented),
    'an unknown GIT_* variable must be stripped on the strength of its namespace alone; if this fails the implementation has regressed to matching names'
  )
  // Whatever git adds next is covered the day it ships. These are real
  // variables absent from the original six-name denylist, kept as regression
  // anchors for the specific escapes that were measured.
  for (const real of ['GIT_TEMPLATE_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']) {
    assert.ok(gitEnv.gitEnvKeysToStrip({ [real]: 'x' }).includes(real), `${real} must be stripped`)
  }
})

test('git-env: the allowlist is real -- commit identity survives, so the rule is not "strip everything beginning with GIT_"', () => {
  const identity = {
    GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'c', GIT_COMMITTER_EMAIL: 'c@d', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  }
  assert.deepEqual(
    gitEnv.gitEnvKeysToStrip(identity),
    [],
    'author and committer identity change what a commit RECORDS, not where it LANDS, and must survive; emptying the allowlist would break this'
  )
  assert.deepEqual(
    gitEnv.gitEnvKeysToStrip({ PATH: '/bin', HOME: '/home/x', GITHUB_TOKEN: 't' }),
    [],
    'variables outside git\'s namespace must be left alone -- GITHUB_TOKEN in particular does not begin with GIT_ plus an underscore boundary by accident'
  )
})

test('git-env: GIT_CONFIG_PARAMETERS cannot inject config into a fixture -- git itself exports this one into subprocesses whenever the invoking command used -c, so it is reachable through exactly the hook path this defence is for', () => {
  const res = runWithGitEnv({ GIT_CONFIG_PARAMETERS: "'user.email=pwned@evil.test'" }, `
    const dir = makeTempRepo();
    const email = execFileSync('git', ['config', '--get', 'user.email'], { cwd: dir, encoding: 'utf8' }).trim();
    process.stdout.write(JSON.stringify({ email }));
  `)
  assert.equal(res.status, 0, `child failed: ${res.stderr}`)
  assert.equal(JSON.parse(res.stdout.trim()).email, 'test@example.com', 'the fixture\'s own identity must win')
})
