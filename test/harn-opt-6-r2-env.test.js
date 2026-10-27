// HARN-OPT-6 T1 fix round 2, item I (specs/harn-opt-6.md): the HARN-OPT-6 test files must pass when the invoking shell
// has HARNESS_LEDGER_READONLY exported. The writer honours that variable and refuses every write, so any test that
// runs it with the inherited environment fails for a reason unrelated to what it checks. This file runs the three
// older HARN-OPT-6 files in a child process with the variable set and requires them to pass. It lists neither itself
// (which would recurse) nor test/harn-opt-6-r2.test.js, whose items fail for their own reasons until they are built;
// that file runs the writer through the same two helpers (runAppend and sanitizedGitEnv), so fixing them covers it.
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const FILES = ['harn-opt-6-t1.test.js', 'harn-opt-6-gap.test.js', 'review-cycle-finding-ids.test.js'].map((f) => path.join(__dirname, f))

test('I: the HARN-OPT-6 test files pass with HARNESS_LEDGER_READONLY=1 in the invoking environment', () => {
  // NODE_TEST_CONTEXT is how the outer runner marks its children; left in place, the inner `node --test` runs nothing.
  const { NODE_TEST_CONTEXT, ...inherited } = process.env
  const res = spawnSync(process.execPath, ['--test', ...FILES], {
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
