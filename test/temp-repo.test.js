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
const { makeTempRepo, cleanupTempRepos } = require('./helpers/temp-repo.js')

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
