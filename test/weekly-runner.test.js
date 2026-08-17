// Integration tests for bin/optimise-cycle-weekly.sh -- the weekly
// launchd-driven runner that fires /optimise-cycle against the delivery
// repos (HARN-OPT-2 T3, following the AC-PROD-11 gate closing: the
// launchd schedule fired correctly on 2026-08-17, so the only real defects
// left are (D1) the runner's only evidence of success was a model's free
// text reply, appended to the log whether or not anything was actually
// produced, and (D2) the script was untracked and untested.
//
// This file proves D1 is fixed: PASS/FAIL is decided per repo from facts
// the script observes itself -- the report file exists, was written (or
// refreshed) DURING this run (not left over from a previous week), and is
// non-empty and structurally plausible -- never from what `claude -p` said.
// Every test drives the real script against a real temp git repo with a
// stub `claude` on PATH, so no real model call ever happens.
//
// The stale-report case (below) is the one the old script could not see at
// all: a leftover report from a previous run looks identical to a fresh
// one to any check that only asks "does the file exist". Per the standing
// rule on this plan, that fixture is built so ONLY the mtime comparison can
// fail it -- the report content is otherwise well-formed, present and
// non-empty -- so a passing assertion there cannot be explained by any
// other branch of the verdict logic.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { SUITE_TMPDIR, makeTempRepo, trackTempDir, cleanupTempRepos } = require('./helpers/temp-repo.js')

const SCRIPT_PATH = path.join(__dirname, '..', 'bin', 'optimise-cycle-weekly.sh')
const REPORT_REL = path.join('.claude', 'optimise-cycle-report.md')

test.after(cleanupTempRepos)

// One tracked root for everything this file creates that isn't a
// makeTempRepo() repo (the claude stub, and the per-test log files),
// mirroring temp-repo.js's own isolation discipline (M4).
const RUN_TMPDIR = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'weekly-run-'))
trackTempDir(RUN_TMPDIR)

// A single stub `claude` reused by every test in this file. It never talks
// to a real model: its entire behaviour is driven by a marker file
// (.optimise-weekly-test-marker) each test drops into the repo it is
// about to run against, so one static stub script can stand in for every
// scenario below (healthy, silent-but-real, missing, empty, non-zero exit).
const STUB_DIR = path.join(RUN_TMPDIR, 'stub')
fs.mkdirSync(STUB_DIR)
const VALID_REPORT = '# Delivery optimiser report\n\nRepos: fixture\n\n## Sample completeness\nn=3, clean.\n'
const STUB_CLAUDE = `#!/bin/sh
marker=""
if [ -f .optimise-weekly-test-marker ]; then
  marker=$(cat .optimise-weekly-test-marker)
fi
case "$marker" in
  pass)
    mkdir -p .claude
    cat > ${JSON.stringify(REPORT_REL)} <<'REPORTEOF'
${VALID_REPORT}REPORTEOF
    echo "stub: some chatter the verdict must not depend on"
    exit 0
    ;;
  silent-pass)
    mkdir -p .claude
    cat > ${JSON.stringify(REPORT_REL)} <<'REPORTEOF'
${VALID_REPORT}REPORTEOF
    exit 0
    ;;
  empty)
    mkdir -p .claude
    : > ${JSON.stringify(REPORT_REL)}
    exit 0
    ;;
  fail-with-report)
    mkdir -p .claude
    cat > ${JSON.stringify(REPORT_REL)} <<'REPORTEOF'
${VALID_REPORT}REPORTEOF
    exit 3
    ;;
  noop)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`
fs.writeFileSync(path.join(STUB_DIR, 'claude'), STUB_CLAUDE, { mode: 0o755 })

function setMarker(repo, marker) {
  fs.writeFileSync(path.join(repo, '.optimise-weekly-test-marker'), `${marker}\n`)
}

let logCounter = 0
function freshLogPath() {
  logCounter += 1
  return path.join(RUN_TMPDIR, `weekly-${logCounter}.log`)
}

// Drives the real script against real repos with the stub claude first on
// PATH. Deliberately does NOT touch the script's default (unset
// OPTIMISE_WEEKLY_REPOS) repo list -- that path is read-only production
// config and this suite never invokes it, since every call here supplies
// its own repos.
function runWeeklyScript(repos) {
  const log = freshLogPath()
  const res = spawnSync(SCRIPT_PATH, [], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${STUB_DIR}:${process.env.PATH}`,
      OPTIMISE_WEEKLY_REPOS: repos.join('\n'),
      OPTIMISE_WEEKLY_LOG: log,
    },
  })
  const logContents = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  return { ...res, log, logContents }
}

test('weekly runner: healthy run -- report written fresh during the run -- PASS, exit 0', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo])
  assert.equal(status, 0, logContents)
  assert.ok(logContents.includes(`RESULT PASS ${repo}`), logContents)
})

test('weekly runner: a report that already exists with an OLD mtime and is NOT rewritten this run -- FAIL (the shape a status-only check cannot see at all)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  const reportPath = path.join(repo, REPORT_REL)
  const staleContent = '# Delivery optimiser report\n\nRepos: fixture\n\n## Sample completeness\nold but otherwise well-formed\n'
  fs.writeFileSync(reportPath, staleContent)
  const oldTime = new Date('2020-01-01T00:00:00Z')
  fs.utimesSync(reportPath, oldTime, oldTime)
  // The stub does nothing this run -- the report is left byte-for-byte as
  // a previous week would have left it. Non-empty, present, well-formed:
  // the ONLY thing wrong with it is that it predates this run.
  setMarker(repo, 'noop')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.ok(logContents.includes(`RESULT FAIL ${repo}`), logContents)
  assert.match(logContents, /stale/i, 'the FAIL reason must name staleness, not some other cause')
  assert.equal(fs.readFileSync(reportPath, 'utf8'), staleContent, 'sanity: the stub really left the report untouched')
})

test('weekly runner: stub produces no report at all -- FAIL', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'noop')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.ok(logContents.includes(`RESULT FAIL ${repo}`), logContents)
  assert.match(logContents, /missing/i)
  assert.ok(!fs.existsSync(path.join(repo, REPORT_REL)))
})

test('weekly runner: report file created but zero-length -- FAIL', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'empty')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.ok(logContents.includes(`RESULT FAIL ${repo}`), logContents)
  assert.match(logContents, /empty/i)
})

test('weekly runner: stub exits non-zero -- FAIL, even though it left a report that looks otherwise fine', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'fail-with-report')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.ok(logContents.includes(`RESULT FAIL ${repo}`), logContents)
  assert.match(logContents, /exited 3/, 'the FAIL reason must name the non-zero exit, not the report shape')
  const reportPath = path.join(repo, REPORT_REL)
  assert.ok(fs.existsSync(reportPath) && fs.statSync(reportPath).size > 0, 'sanity: the report itself is fine -- exit code alone must be what fails this')
})

test('weekly runner: stub exits 0 and prints nothing on stdout (the exact CouchPotato shape), while a fresh valid report IS written -- PASS, because the verdict comes from the artefact, not the reply', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'silent-pass')
  const { status, logContents } = runWeeklyScript([repo])
  assert.equal(status, 0, logContents)
  assert.ok(logContents.includes(`RESULT PASS ${repo}`), logContents)
})

test('weekly runner: one repo passing and one failing -- overall exit non-zero, BOTH verdicts present in the log', () => {
  const repoPass = makeTempRepo()
  const repoFail = makeTempRepo()
  setMarker(repoPass, 'pass')
  setMarker(repoFail, 'noop')
  const { status, logContents } = runWeeklyScript([repoPass, repoFail])
  assert.notEqual(status, 0, logContents)
  assert.ok(logContents.includes(`RESULT PASS ${repoPass}`), logContents)
  assert.ok(logContents.includes(`RESULT FAIL ${repoFail}`), logContents)
})

test('weekly runner: a directory that is not a git repo is skipped, not failed, and the stub is never invoked for it', () => {
  const notARepo = fs.mkdtempSync(path.join(RUN_TMPDIR, 'not-a-repo-'))
  const { status, logContents } = runWeeklyScript([notARepo])
  assert.equal(status, 0, logContents)
  assert.ok(logContents.includes(`SKIP ${notARepo}`), logContents)
  assert.ok(!logContents.includes('RESULT'), 'a skipped, non-git directory must never produce a PASS/FAIL verdict line')
})
