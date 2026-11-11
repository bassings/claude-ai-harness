// HARN-OPT-6 T1 fix round 2, item I; extended in fix round 3, item H (specs/harn-opt-6.md); reworked by HARN-AUDIT-1 T1
// (AC-QA-1, AC-QA-3): the test files that run the ledger writer must pass when the invoking shell has
// HARNESS_LEDGER_READONLY exported. The writer honours that variable and refuses every write, so any test that runs it with
// the inherited environment fails for a reason unrelated to what it checks.
//
// This file used to prove that by spawning `node --test` on those files from inside a test. That nested run took 28
// seconds on a two-core runner, inherited every timing flake in the files it ran (CI run 41381367776 failed here only
// because the wall-clock test in test/ledger-append.test.js failed inside it), and made one test's result depend on five
// other files. It is now two checks that spawn no test runner:
//   1. in this process, the property that makes the files pass: the shared helpers drop the inherited variable before the
//      writer runs, and an explicit one still gets through (the read-only tests themselves rely on that);
//   2. the run itself is a step of its own in CI and in the pre-push hook, and this file pins that both carry it, over
//      exactly the files listed below.
//
// The list is the three older HARN-OPT-6 files plus test/ledger-append.test.js and test/sigkill-orphan.test.js, the two
// files that spawn the writer with their own environment instead of through the shared runAppend and sanitizedGitEnv
// helpers. A one-off run on 2026-10-28 of every test file that mentions the writer (34 files, 1,761 tests, the variable
// exported) failed 12 tests, all in those two files; every other file already passed. test/harn-opt-6-r2.test.js is left
// out because it runs the writer only through the shared helpers, which the listed HARN-OPT-6 files exercise identically.
require('./helpers/git-env.js').scrubGitEnv()
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { sanitizedGitEnv } = require('./helpers/git-env.js')
const { spawnSync } = require('node:child_process')
const { APPEND_SCRIPT, makeTempRepo, runAppend, readLedgerLines, cleanupTempRepos } = require('./helpers/temp-repo.js')

const ROOT = path.join(__dirname, '..')
const FILES = ['harn-opt-6-t1.test.js', 'harn-opt-6-gap.test.js', 'review-cycle-finding-ids.test.js', 'ledger-append.test.js', 'sigkill-orphan.test.js'].map((f) => `test/${f}`)

test.after(() => cleanupTempRepos())

// Runs `fn` with HARNESS_LEDGER_READONLY set in this process, as a shell that exports it would leave it, and puts the
// previous state back whatever happens. Synchronous, and node:test runs one test of a file at a time.
function withInheritedReadonly(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'HARNESS_LEDGER_READONLY')
  const previous = process.env.HARNESS_LEDGER_READONLY
  process.env.HARNESS_LEDGER_READONLY = value
  try {
    return fn()
  } finally {
    if (had) process.env.HARNESS_LEDGER_READONLY = previous
    else delete process.env.HARNESS_LEDGER_READONLY
  }
}

test('I: with HARNESS_LEDGER_READONLY=1 exported, the shared helpers still let the writer write, and an explicit one still reaches it', () => {
  withInheritedReadonly('1', () => {
    assert.equal(Object.hasOwn(sanitizedGitEnv(), 'HARNESS_LEDGER_READONLY'), false, 'the inherited variable must be dropped from the environment the helpers hand a child')
    assert.equal(sanitizedGitEnv({ HARNESS_LEDGER_READONLY: '1' }).HARNESS_LEDGER_READONLY, '1', 'a test of the read-only behaviour passes it explicitly, and that must be kept')

    // End to end through the real writer, the way every helper-based test runs it.
    const repo = makeTempRepo()
    const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', run_id: 'readonly-exported' })
    const out = JSON.parse(res.stdout.trim().split('\n').pop())
    assert.equal(out.write_ok, true, `the writer refused although the helper should have dropped the inherited variable: ${out.write_error}`)
    assert.equal(readLedgerLines(repo).length, 1, 'exactly one line must have been appended')
  })
})

test('I: the writer really does refuse when the variable reaches it, so the check above is not vacuous', () => {
  const repo = makeTempRepo()
  const res = spawnSync('node', [APPEND_SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    input: JSON.stringify({ schema_version: 1, kind: 'tdd_task', outcome: 'done' }),
    env: sanitizedGitEnv({ HARNESS_LEDGER_READONLY: '1' }),
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false)
  assert.match(out.write_error, /read-only/)
  assert.equal(readLedgerLines(repo).length, 0)
})

// One executable line in each gate: the variable, the runner and every file, so the line can be read and compared whole.
// Anchored to the start of the line (after an optional `run: ` in ci.yml), so a commented-out copy, which would leave the
// gate unrun, cannot satisfy it.
const READONLY_RUN = /^[ \t]*(?:run: )?HARNESS_LEDGER_READONLY=1 node --test ((?:test\/[\w.-]+\.test\.js ?)+)[ \t]*$/m

test('I: the READONLY_RUN pattern rejects a commented-out line and accepts a real one (self-check)', () => {
  const files = 'test/a.test.js test/b.test.js'
  assert.equal(READONLY_RUN.exec(`# HARNESS_LEDGER_READONLY=1 node --test ${files}\n`), null, 'a "# " line must not count')
  assert.equal(READONLY_RUN.exec(`  #HARNESS_LEDGER_READONLY=1 node --test ${files}\n`), null, 'an indented comment must not count')
  assert.equal(READONLY_RUN.exec(`# run: HARNESS_LEDGER_READONLY=1 node --test ${files}\n`), null, 'a commented run: line must not count')
  assert.equal(READONLY_RUN.exec(`HARNESS_LEDGER_READONLY=1 node --test ${files} || true\n`), null, 'a line that swallows failure must not count')
  assert.ok(READONLY_RUN.exec(`HARNESS_LEDGER_READONLY=1 node --test ${files}\n`), 'a bare executable line counts')
  assert.ok(READONLY_RUN.exec(`        run: HARNESS_LEDGER_READONLY=1 node --test ${files}\n`), 'a ci.yml run: line counts')
})

for (const rel of ['.github/workflows/ci.yml', '.githooks/pre-push']) {
  test(`I: ${rel} runs exactly the writer's test files with HARNESS_LEDGER_READONLY=1 exported`, () => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const match = READONLY_RUN.exec(text)
    assert.ok(match, `${rel} has no executable line of the form "HARNESS_LEDGER_READONLY=1 node --test <files>"`)
    assert.deepEqual(match[1].trim().split(' ').sort(), [...FILES].sort())
    for (const file of FILES) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is listed but does not exist`)
  })
}

// A CI step that cannot fail the job is a gate that does not gate: the step holding the run line must carry neither an
// `if:` (it could be skipped) nor `continue-on-error` (its failure would be swallowed).
test('I: the ci.yml step that runs the READONLY line has no if: and no continue-on-error', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8').split('\n')
  const at = lines.findIndex((l) => READONLY_RUN.test(l))
  assert.ok(at >= 0, 'ci.yml has no executable READONLY line')
  let start = at
  while (start > 0 && !/^\s*- /.test(lines[start])) start--
  const indent = lines[start].match(/^\s*/)[0].length
  let end = at + 1
  while (end < lines.length && !(lines[end].trim() !== '' && lines[end].match(/^\s*/)[0].length <= indent)) end++
  const step = lines.slice(start, end).filter((l) => !/^\s*#/.test(l))
  assert.ok(step.length >= 2 && step.some((l) => READONLY_RUN.test(l)), 'the step block was not located')
  for (const l of step) assert.doesNotMatch(l, /^\s*(?:- )?(?:if|continue-on-error)\s*:/, `the READONLY step must not be skippable or failure-swallowing: ${l.trim()}`)
})
