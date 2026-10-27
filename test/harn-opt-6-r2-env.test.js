// HARN-OPT-6 T1 fix round 2, item I; extended in fix round 3, item H (specs/harn-opt-6.md): the test files that run the
// ledger writer must pass when the invoking shell has HARNESS_LEDGER_READONLY exported. The writer honours that variable and
// refuses every write, so any test that runs it with the inherited environment fails for a reason unrelated to what it checks.
// This file runs those files in a child process with the variable set and requires them to pass.
//
// The list is the three older HARN-OPT-6 files plus test/ledger-append.test.js and test/sigkill-orphan.test.js, the two
// files that spawn the writer with their own environment instead of through the shared runAppend and sanitizedGitEnv
// helpers. A one-off run on 2026-10-28 of every test file that mentions the writer (34 files, 1,761 tests, the variable
// exported) failed 12 tests, all in those two files; every other file already passed. test/harn-opt-6-r2.test.js is left
// out because it runs the writer only through the shared helpers, which the listed HARN-OPT-6 files exercise identically,
// and this file does not list itself (it would recurse).
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const FILES = ['harn-opt-6-t1.test.js', 'harn-opt-6-gap.test.js', 'review-cycle-finding-ids.test.js', 'ledger-append.test.js', 'sigkill-orphan.test.js'].map((f) => path.join(__dirname, f))

test('I: the HARN-OPT-6 test files and the writer\'s own test files pass with HARNESS_LEDGER_READONLY=1 in the invoking environment', () => {
  // NODE_TEST_CONTEXT is how the outer runner marks its children; left in place, the inner `node --test` runs nothing.
  const { NODE_TEST_CONTEXT, ...inherited } = process.env
  // The reporter is pinned: Node 22 defaults to TAP when stdout is not a terminal, and the parsing below reads the
  // spec reporter's ✖ and ℹ lines, so without the flag this check reads nothing on Node 22.
  const res = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...FILES], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...inherited, HARNESS_LEDGER_READONLY: '1' },
  })
  const failed = [...res.stdout.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1])
  assert.deepEqual([...new Set(failed)], [], `tests failed with HARNESS_LEDGER_READONLY=1 exported (a test is running the writer with the inherited environment)`)
  assert.match(res.stdout, /ℹ tests [1-9]/, 'the inner run executed no tests')
  assert.equal(res.status, 0, res.stdout.split('\n').slice(-25).join('\n'))
})
