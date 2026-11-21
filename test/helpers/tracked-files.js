// The file set the HARN-RULES-1 static guards scan (AC-QA-18, AC-ARCH-2,
// AC-SEC-8): every file git tracks, plus any new file that is not ignored (so
// a reference planted in a file not yet committed is seen), minus a short named
// list of files that are meant to name the generator, its table or its API.
// A guard takes its files from here and never from a hand-written list of
// directories, so a hook, an installer or a file added later is covered
// without anyone editing the test.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { scrubGitEnv, sanitizedGitEnv } = require('./git-env.js')
scrubGitEnv()

const ROOT = path.join(__dirname, '..', '..')

// The generator, the tests and helpers that drive it, and its fixtures.
const GENERATOR_AND_ITS_TESTS = [
  'bin/sonar-rules-table.mjs',
  'test/sonar-rules-table.test.js',
  'test/sonar-rules-docs.test.js',
  'test/helpers/write-hook.cjs',
  'test/helpers/tracked-files.js',
]
const GENERATOR_FIXTURE_DIR = 'test/fixtures/sonar-rules/'
// Documents that describe the change.
const RECORDS = ['README.md', 'specs/harn-rules-1.md', 'docs/harn-rules-1-mutation-proofs.md']
// The one install pattern literal (workflows/lib/install-consistency.mjs, whose
// single mention is asserted on its own) and the tests that pin it.
const INSTALL_PATTERN_FILES = ['workflows/lib/install-consistency.mjs', 'test/install-consistency.test.js', 'test/weekly-runner.test.js']

function allFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, env: sanitizedGitEnv(), maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
  return [...new Set(out.split('\0').filter(Boolean))]
    .filter((f) => {
      try {
        return fs.statSync(path.join(ROOT, f)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

// Tracked files minus the named exclusions, and any extra exclusions a guard adds.
function scannedFiles(extraExcluded = []) {
  const excluded = new Set([...GENERATOR_AND_ITS_TESTS, ...RECORDS, ...extraExcluded])
  return allFiles().filter((f) => !excluded.has(f) && !f.startsWith(GENERATOR_FIXTURE_DIR))
}

const readRel = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

module.exports = { allFiles, scannedFiles, readRel, GENERATOR_AND_ITS_TESTS, RECORDS, INSTALL_PATTERN_FILES, ROOT }
